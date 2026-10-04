import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import {
  createControllerModelGateway, createHeadlessRuntime, createHerdrRuntime, createPlanRuntime, filesystemHooks,
  LinuxProcessProbe, ProcessFamily, RuntimeCapabilityError,
  type RuntimeAdapter, type RuntimeHandle, type RuntimeRequest, type ManagedRuntimeOptions,
  type ProcessRow, type ProcessProbe, type CommandRunner, type WorkerConfig, type GuardianJournal,
} from "../../src/runtime/index.js";
import { ModelSpendBudget, pinnedModelPrices, type ModelSpendJournal, type ModelSpendState } from "../../src/policy/index.js";
import { RpcPeer } from "../../src/runtime/rpc.js";
import { atomicJson, Deadline, digest, readJson, tail } from "../../src/runtime/io.js";
import guard from "../../src/runtime/pi-receipts.js";
import { attemptKey } from "../../src/runtime/filesystem-hooks.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const terminal = new Set(["completed", "failed", "cancelled", "timed-out", "stopped", "quarantined"]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor<T>(work: () => Promise<T | undefined>, ms: number, label: string): Promise<T> {
  const started = Date.now();
  const end = started + ms;
  do { const value = await work(); if (value !== undefined) return value; await sleep(25); } while (Date.now() < end);
  throw new Error(`Inert fixture condition timed out after ${Date.now() - started}ms (${label})`);
}
async function json<T = Record<string, unknown>>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }
async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }

// ---------------------------------------------------------------------------------------------
// Timing model: measured, never guessed.
//
// `RuntimeRequest.deadlineAt` is one absolute budget shared by preflight, the durable claim, the
// controller lease, the guardian spawn, Pi readiness, prompting and stop. Every one of those phases
// performs `/proc` inventories and fsyncs, so the cost of merely reaching "worker is executing" is
// host dependent: on a loaded 400-process workstation one inventory takes 0.24-0.68 s and one cold
// dispatch 2.4-3.1 s, against roughly 0.01 s and 0.7 s on an idle host. Hand-picked deadlines (for
// example `Date.now() + 2400`) therefore expire *before* the worker can execute, and the suite
// observes a correct fail-closed refusal instead of the behaviour it means to verify.
//
// So the suite spends one real dispatch per run to *measure* that cold start, and expresses every
// deadline, wait and verification bound below as an explicit, clamped multiple of it. A wait never
// outlives the attempt's own absolute deadline, and nothing here renews, extends or replaces it.
// ---------------------------------------------------------------------------------------------
const VERIFY_WINDOW_MS = 100;                               // documented single late-cancellation verification window
const STOP_GRACE_MS = 120;                                  // option value used by every runtime below
const STOP_RESERVE_MS = Math.max(500, STOP_GRACE_MS + 500); // documented escalation reserve before the deadline
const HEARTBEAT_MS = 250;                                   // fixture cadence for still-executing evidence
const INVENTORY_PASSES_AFTER_DEADLINE = 4;                  // lease reclaim + ownership + revalidation + scheduling
const DISPATCH_FLOOR_MS = 2_500;                            // never schedule an enforcement deadline below the idle cost
const DISPATCH_CEILING_MS = 30_000;                         // bound waits instead of hanging on a pathological host
const HANG_BOUND_FLOOR_MS = 15_000;                         // phase pipeline of a non-enforcement test

interface RunCosts { dispatchMs: number; inventoryMs: number; stopMs: number }
let costs: Promise<RunCosts> | undefined;
/** At most one real dispatch per run, and only when a test needs a derived budget. */
const measuredCosts = (): Promise<RunCosts> => (costs ??= measureCosts());

/** Shared fixture configuration: the only place the requested inert provider/model/thinking is declared. */
function runtimeOptions(controlRoot: string, overrides: Partial<ManagedRuntimeOptions> = {}): ManagedRuntimeOptions {
  return { controlRoot, piBinary: fixture, nodeBinary: process.execPath, pollMs: 25, startupTimeoutMs: 3000, stopGraceMs: STOP_GRACE_MS,
    // This inert worker suite explicitly owns no pack resources; production runtime has no default wiring.
    sessions: { releasers: [{ name: 'inert-worker-no-pack-resources', ownsNoResources: true, release: async () => 0, outstanding: () => 0 }] },
    gateway: { approval: "test-only local inert fixture", baseUrl: "http://127.0.0.1:1/never-contacted", api: "openai-completions",
      models: [{ id: "inert", reasoning: true, contextWindow: 32000, maxTokens: 1024, thinkingLevelMap: { max: "max", high: "high" } }] },
    ...overrides };
}

/** Inert request: the exact provider/model/thinking asserted throughout, and no reachable target. */
async function inertRequest(root: string, name: string, mode: Record<string, unknown>, deadlineAt: number): Promise<RuntimeRequest> {
  const workspace = path.join(root, name); await mkdir(workspace);
  await writeFile(path.join(workspace, "fixture.json"), JSON.stringify(mode));
  return { runId: "inert-run", taskId: name, attemptId: "one", workspace, scopeDigest: "inert-scope", inputDigest: "inert-input", deadlineAt,
    requested: { provider: "p2o-inert", model: "inert", thinking: "max" }, prompt: "Local inert fixture only; do not contact any target",
    toolPolicy: { mode: "trusted-fixture", allowUnsandboxedHostTools: true, tools: [] } };
}

/** Measures the host: one real cold dispatch to "provably executing", one inventory pass, one verified
 *  stop. Every timing assertion below is derived from these three numbers. */
async function measureCosts(): Promise<RunCosts> {
  const probe = new LinuxProcessProbe(); const inventory: number[] = [];
  for (let i = 0; i < 3; i++) { const at = Date.now(); await probe.snapshot(); inventory.push(Date.now() - at); }
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-p2o-inert-cost-"));
  try {
    const request = await inertRequest(root, "cost", { hold: true, ignoreTerm: true }, Date.now() + DISPATCH_CEILING_MS * 2);
    const runtime = createHeadlessRuntime(runtimeOptions(path.join(root, "controller"), { startupTimeoutMs: DISPATCH_CEILING_MS }));
    const started = Date.now();
    const handle = await runtime.start(request);
    const executing = await waitFor(async () => await exists(path.join(request.workspace, "working.json")) ? Date.now() : undefined,
      DISPATCH_CEILING_MS * 2, "cost calibration: worker execution handshake");
    const stopping = Date.now();
    const receipt = await runtime.stop(handle, { reason: "cancelled" });
    if (!receipt.verified) throw new Error(`Cost calibration could not verify termination: ${JSON.stringify(receipt)}`);
    return { dispatchMs: executing - started, inventoryMs: Math.max(...inventory), stopMs: Date.now() - stopping };
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** Absolute deadline for `units` measured cold starts. Used only where a test *asserts* enforcement. */
async function deadlineIn(units: number): Promise<number> {
  return Date.now() + Math.min(DISPATCH_CEILING_MS, Math.max(DISPATCH_FLOOR_MS, Math.ceil(units * (await measuredCosts()).dispatchMs)));
}

/** Per-attempt deadline for tests that verify something other than deadline enforcement: a hang bound
 *  that must outlast the whole phase pipeline of a loaded host, and can never be mistaken for the
 *  property under test. */
async function hangBound(): Promise<number> {
  return Date.now() + Math.min(DISPATCH_CEILING_MS, Math.max(HANG_BOUND_FLOOR_MS, Math.ceil(10 * (await measuredCosts()).dispatchMs)));
}

/** Bounded late-termination verification: the documented window plus the measured cost of proving a
 *  real stop here. The stop path can charge the controller-lease reclaim, the authoritative ownership
 *  pass and the post-kill revalidation after the deadline, so the allowance is that many measured
 *  inventory passes (or one measured stop, whichever is larger). */
async function verifyBudgetMs(): Promise<number> {
  const { inventoryMs, stopMs } = await measuredCosts();
  return Math.min(10_000, Math.max(150, VERIFY_WINDOW_MS + Math.max(INVENTORY_PASSES_AFTER_DEADLINE * inventoryMs, stopMs)));
}

/** Every fixture wait is bounded by the attempt's own absolute deadline: nothing a worker produces can
 *  legitimately arrive after it, so a stalled phase is reported by name instead of by wall clock. */
async function waitForDeadline<T>(work: () => Promise<T | undefined>, deadlineAt: number, label: string): Promise<T> {
  return waitFor(work, Math.max(0, deadlineAt - Date.now()) + await verifyBudgetMs(), label);
}

async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-p2o-inert-"));
  const controlRoot = path.join(root, "controller");
  const handles: Array<{ runtime: RuntimeAdapter; handle: RuntimeHandle }> = [];
  const options = runtimeOptions(controlRoot);
  const request = async (name: string, mode: Record<string, unknown> = {}, deadlineAt?: number): Promise<RuntimeRequest> =>
    inertRequest(root, name, mode, deadlineAt ?? await hangBound());
  const start = async (runtime: RuntimeAdapter, r: RuntimeRequest) => { const handle = await runtime.start(r); handles.push({ runtime, handle }); return handle; };
  t.after(async () => {
    for (const { runtime, handle } of handles) { try { await runtime.stop(handle); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  return { root, options, request, start, handles };
}
async function final(runtime: RuntimeAdapter, handle: RuntimeHandle) {
  return waitForDeadline(async () => { const c = await runtime.collect(handle); return terminal.has(c.outcome) && c.handle.stopReceipt ? c : undefined; },
    handle.deadlineAt, "terminal outcome with verified stop receipt");
}

/** Waits for the fixture controller's durable "worker is executing" handshake. A controller that could
 *  not dispatch reports its own reason as a failed handshake instead of an opaque timeout. */
async function dispatchHandshake(readyFile: string, r: RuntimeRequest, stderr: () => string): Promise<RuntimeHandle> {
  return waitForDeadline(async () => {
    if (await exists(`${readyFile}.error`)) throw new Error(`Controller fixture failed: ${(await readFile(`${readyFile}.error`, "utf8")).trim()}; stderr=${stderr() || "<empty>"}`);
    return await exists(readyFile) ? json<RuntimeHandle>(readyFile) : undefined;
  }, r.deadlineAt, "controller dispatch handshake");
}

/** [T12] The launch pipeline's last RPC request is `prompt`; `prompt-delivered` is published only after Pi
 *  accepted it, so a test that waits for it can never tear the runtime down while `launch` is still between
 *  a readiness check and its next request. Without this wait the teardown `stop()` closes the RPC peer under
 *  the pipeline; the next request is refused by the peer guard and, because `until()` returns before it
 *  attaches handlers when the abort is already visible, the refused promise surfaces as an unhandled
 *  rejection. That is the T12 `RPC closed/deadline exhausted` flake: the handshake file this test reads is
 *  written by the worker at spawn time, i.e. before the controller has issued `get_state`/`prompt`. */
async function awaitLaunchDelivered(runtime: RuntimeAdapter, handle: RuntimeHandle): Promise<void> {
  await waitForDeadline(async () => (await runtime.observe(handle, { cursor: 0, limit: 128 })).events.some((event) => event.type === "prompt-delivered") ? true : undefined,
    handle.deadlineAt, "launch pipeline delivered its prompt (no startup RPC left in flight)");
  assert.equal((await runtime.collect(handle)).handle.startupError, undefined);
}

/** A held fixture rewrites `alive.json` every HEARTBEAT_MS: the worker's own evidence that it was still
 *  executing immediately before its enforced deadline (the reserve is where termination begins). The fixture
 *  replaces the file atomically, but a reader can still arrive while the swap is in flight, so an unreadable
 *  sample is retried until the deadline instead of failing the suite on one transient read (R4 §11's flake). */
async function assertExecutedUntilDeadline(workspace: string, deadlineAt: number): Promise<void> {
  const alive = await waitForDeadline(async () => {
    try { return await json<{ at: number }>(path.join(workspace, "alive.json")); }
    catch { return undefined; }
  }, deadlineAt, "worker heartbeat evidence (alive.json)");
  const allowance = STOP_RESERVE_MS + 2 * HEARTBEAT_MS + await verifyBudgetMs();
  assert.ok(alive.at >= deadlineAt - allowance, `worker stopped executing ${deadlineAt - alive.at}ms before its deadline (measured allowance ${allowance}ms)`);
}

/** Window in which a cancelled preparation pipeline would have reached its spawn call. */
async function settleMs(): Promise<number> {
  return Math.min(10_000, Math.max(250, Math.ceil((await measuredCosts()).dispatchMs / 2)));
}

// Actual OS processes, guardian and filesystem fences; no provider or network activity.
test("headless starts nonblocking and worker execution truly overlaps", async (t) => {
  const s = await setup(t); const runtime = createHeadlessRuntime(s.options);
  const a = await s.request("overlap-a", { delayMs: 1000, fragment: true }); const b = await s.request("overlap-b", { delayMs: 1000 });
  const [ha, hb] = await Promise.all([s.start(runtime, a), s.start(runtime, b)]);
  assert.equal(ha.status, "starting"); assert.equal(hb.status, "starting");
  assert.ok(!await exists(path.join(a.workspace, "settled.json")));
  await waitForDeadline(async () => await exists(path.join(a.workspace, "working.json")) && await exists(path.join(b.workspace, "working.json")) ? true : undefined, ha.deadlineAt, "both inert workers executing");
  assert.ok(!await exists(path.join(a.workspace, "settled.json")) && !await exists(path.join(b.workspace, "settled.json")));
  const [ca, cb] = await Promise.all([final(runtime, ha), final(runtime, hb)]);
  assert.equal(ca.outcome, "completed"); assert.equal(cb.outcome, "completed");
  assert.equal(ca.handle.stopReceipt!.verified, true); assert.equal(ca.resultAcceptance, "not-evaluated");
  assert.ok(ca.observed.some((r) => r.source === "rpc-state" && r.thinking === "max" && r.matchesRequest));
  assert.ok(ca.observed.some((r) => r.event === "assistant-response" && r.thinking === undefined));
  assert.match(ca.logTail, /é\u2028漢字/);
  const cursored = await runtime.observe(ha, { cursor: ca.handle.nextCursor - 1 }); assert.equal(cursored.events.length, 0);
});

test("worker environment is allowlisted and host auth/config cannot leak", async (t) => {
  const s = await setup(t); const keys = ["CTFCTL_PASSWORD", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS", "HTTPS_PROXY"];
  const previous = keys.map((k) => process.env[k]);
  keys.forEach((k) => { process.env[k] = "must-never-inherit-inert-secret"; });
  const runtime = createHeadlessRuntime(s.options);
  try {
    const r = await s.request("environment", { hold: true }); const h = await s.start(runtime, r);
    await awaitLaunchDelivered(runtime, h);
    const captured = await waitForDeadline(async () => await exists(path.join(r.workspace, "environment.json")) ? json<{ env: Record<string, string>; config: WorkerConfig; argv: string[] }>(path.join(r.workspace, "environment.json")) : undefined, r.deadlineAt, "worker environment handshake");
    keys.forEach((k) => assert.equal(captured.env[k], undefined));
    assert.equal(captured.env.HOME, path.join(h.controlDir, "home"));
    assert.deepEqual(await json(path.join(captured.env.PI_CODING_AGENT_DIR!, "auth.json")), {});
    assert.ok(!JSON.stringify(captured).includes("must-never-inherit-inert-secret"));
    for (const flag of ["--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve"]) assert.ok(captured.argv.includes(flag));
  } finally { keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; }); }
});

test("TERM-resistant detached descendants are observed and killed; unrelated process survives", async (t) => {
  const s = await setup(t); const runtime = createHeadlessRuntime(s.options);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: {} });
  t.after(() => { unrelated.kill("SIGKILL"); });
  const r = await s.request("descendants", { hold: true, ignoreTerm: true, descendants: true }); const h = await s.start(runtime, r);
  const pid = await waitForDeadline(async () => await exists(path.join(r.workspace, "descendant.json")) ? (await json<{ pid: number }>(path.join(r.workspace, "descendant.json"))).pid : undefined, r.deadlineAt, "fixture detached descendant handshake");
  await waitForDeadline(async () => (await runtime.collect(h)).handle.native.processes.some((p) => p.pid === pid) ? true : undefined, h.deadlineAt, "runtime observed the detached descendant");
  const stopped = await runtime.stop(h, { reason: "cancelled" }); assert.ok(stopped.verified, JSON.stringify(stopped));
  const rows = await new LinuxProcessProbe().snapshot();
  assert.ok(!rows.some((p) => p.pid === pid && p.state !== "Z"));
  assert.ok(rows.some((p) => p.pid === unrelated.pid && p.state !== "Z"));
  assert.equal((await runtime.collect(h)).outcome, "cancelled");
});

test("absolute deadline covers startup and execution; no renewed cancellation budget", async (t) => {
  const s = await setup(t); const runtime = createHeadlessRuntime(s.options);
  // Two measured cold starts: the single absolute deadline must cover startup *and* the beginning of
  // execution, and nothing after it may become a renewed cancellation or execution budget.
  const end = await deadlineIn(2); const r = await s.request("deadline", { hold: true, ignoreTerm: true, descendants: true }, end);
  const h = await s.start(runtime, r); const c = await final(runtime, h);
  assert.equal(c.outcome, "timed-out", JSON.stringify({ error: c.handle.startupError, stop: c.handle.stopReceipt })); assert.equal(c.handle.deadlineAt, end);
  assert.ok(c.handle.stopReceipt!.verified, JSON.stringify(c.handle.stopReceipt));
  await assertExecutedUntilDeadline(r.workspace, end);
  const overdue = Date.now() - end;
  assert.ok(overdue < await verifyBudgetMs(), `stop ran ${overdue}ms past the original deadline`);
});

test("selection mismatch, provider errors, nonzero exit and oversized RPC frames are observable failures", async (t) => {
  for (const [name, mode, pattern] of [
    ["rpc-mismatch", { stateMismatch: true }, /effective|match/i],
    ["event-mismatch", { receiptMismatch: true }, /selection|requested/i],
    ["assistant-error", { assistantError: true, delayMs: 25 }, /inert provider|successful/i],
    ["assistant-mismatch", { assistantMismatch: true, delayMs: 25 }, /runtime mismatch|provider\/model/i],
    ["nonzero", { nonzero: true, delayMs: 25 }, /exited|successful/i],
    ["oversized", { hugeFrame: true }, /frame limit/i],
    ["startup-timeout", { noReady: true, hold: true }, /readiness|timeout/i],
  ] as const) await t.test(name, async (st) => {
    const s = await setup(st); const runtime = createHeadlessRuntime({ ...s.options, startupTimeoutMs: name === "startup-timeout" ? 200 : 3000 });
    const r = await s.request(name, mode); const h = await s.start(runtime, r); const c = await final(runtime, h);
    assert.equal(c.outcome, "failed", JSON.stringify(c)); assert.match(c.handle.startupError ?? "", pattern);
    assert.ok(c.handle.stopReceipt!.verified, JSON.stringify(c.handle.stopReceipt));
    if (name.includes("mismatch")) assert.ok(c.observed.some((r) => !r.matchesRequest));
  });
});

test("agent_end during retry does not mean completion; log/event growth is bounded", async (t) => {
  const s = await setup(t); const runtime = createHeadlessRuntime({ ...s.options, limits: { logBytes: 1024, events: 12, eventBytes: 128 } });
  const r = await s.request("bounded", { noisy: true, retry: true, delayMs: 600 }); const h = await s.start(runtime, r);
  await waitForDeadline(async () => (await runtime.collect(h)).handle.events.some((e) => e.type === "rpc:agent_end") ? true : undefined, h.deadlineAt, "fixture agent_end during retry");
  const duringRetry = await runtime.collect(h); assert.ok(!terminal.has(duringRetry.outcome));
  const c = await final(runtime, h); assert.equal(c.outcome, "completed");
  assert.ok(Buffer.byteLength(c.logTail) <= 1024); assert.ok(c.handle.events.length <= 12);
  assert.ok(c.handle.events.every((e) => Buffer.byteLength(e.text) <= 128)); assert.ok(c.droppedLogBytes > 500_000);
  assert.ok((await runtime.observe(h, { cursor: 0, limit: 4 })).gap);
  assert.ok(JSON.stringify(c.handle).length < 16_000);
  assert.equal(tail("é漢字".repeat(100), 101).includes("�"), false);
});

test("claims, attempt tombstones, stale handles and controller leases prevent duplicate writers", async (t) => {
  const s = await setup(t); const runtime = createHeadlessRuntime(s.options);
  const r = await s.request("fencing", { hold: true }); const h = await s.start(runtime, r);
  await assert.rejects(runtime.start({ ...r, attemptId: "two" }), /fenced|exists/i);
  await assert.rejects(runtime.collect({ ...h, deadlineAt: h.deadlineAt + 1 }), /stale/i);
  await assert.rejects(runtime.collect({ ...h, ownerToken: "unknown" }), /stale/i);
  const competing = createHeadlessRuntime(s.options);
  assert.equal((await competing.reconcile(h)).state, "quarantined");
  await assert.rejects(competing.stop(h), /another live supervisor/i);
  await runtime.stop(h);
  await assert.rejects(runtime.start(r), /fenced|exists/i);
  const replacement = await s.start(runtime, { ...r, attemptId: "two" }); assert.notEqual(h.ownerToken, replacement.ownerToken);
});

test("checkpoint/resume quiesces the old writer, preserves provenance/deadline and rejects tampering", async (t) => {
  const s = await setup(t); const hooks = filesystemHooks(s.options.controlRoot); let allow = true;
  const runtime = createHeadlessRuntime({ ...s.options, hooks: { ...hooks, validateResume: async () => allow } });
  const r = await s.request("checkpoint", { hold: true }); const h = await s.start(runtime, r);
  await waitForDeadline(async () => await exists(path.join(r.workspace, "working.json")) ? true : undefined, h.deadlineAt, "fixture worker execution handshake");
  const cp = await runtime.checkpoint(h, { note: "Controller-authored inert checkpoint" });
  assert.ok(cp.termination.verified); assert.equal(cp.restoredToolProcesses, false);
  assert.equal(cp.session.sha256, digest(await readFile(cp.session.path)));
  for (const bad of [{ deadlineAt: r.deadlineAt + 1 }, { inputDigest: "changed" }, { scopeDigest: "changed" }, { attemptId: r.attemptId }]) {
    await assert.rejects(runtime.resume(cp, { ...r, attemptId: "two", ...bad }), /deadline|identity|attempt/i);
  }
  allow = false; await assert.rejects(runtime.resume(cp, { ...r, attemptId: "two" }), /authorization/i); allow = true;
  await assert.rejects(runtime.resume({ ...cp, session: { ...cp.session, sha256: "tampered" } }, { ...r, attemptId: "two" }), /altered|checkpoint/i);
  await writeFile(path.join(r.workspace, "fixture.json"), JSON.stringify({ delayMs: 150 }));
  const next = await runtime.resume(cp, { ...r, attemptId: "two", requested: { ...r.requested, thinking: "high" } }); s.handles.push({ runtime, handle: next });
  assert.equal(next.deadlineAt, h.deadlineAt); assert.notEqual(next.sessionId, h.sessionId);
  assert.equal(next.provenance!.parentAttemptId, "one"); assert.equal(next.provenance!.sessionDigest, cp.session.sha256);
  const result = await final(runtime, next); assert.equal(result.outcome, "completed");
  const replay = (await readFile(next.sessionFile, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal((replay[0]!.id), next.sessionId); assert.equal(replay[0]!.parentSession, cp.session.path);
  assert.ok(replay.some((e) => e.type === "custom" && e.customType === "p2o-runtime-checkpoint"));
});

test("controller crash is recovered without re-prompting; independent guardian enforces original deadline", async (t) => {
  const s = await setup(t);
  // Four measured cold starts: the dispatch the worker must complete before its deadline, plus the
  // kill/adopt/reconcile that this test performs while that worker is still live.
  const r = await s.request("crash", { hold: true, ignoreTerm: true }, await deadlineIn(4));
  const readyFile = path.join(s.root, "handle.json"); const settings = path.join(s.root, "controller-fixture.json");
  await atomicJson(settings, { options: s.options, request: r, readyFile });
  const controller = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/controller.mjs", import.meta.url)), settings], { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  let errors = ""; controller.stderr!.on("data", (c: Buffer) => { errors += c.toString(); });
  t.after(() => { controller.kill("SIGKILL"); });
  const h = await dispatchHandshake(readyFile, r, () => errors);
  const closed = new Promise<void>((r) => controller.once("close", () => r())); controller.kill("SIGKILL"); await closed;
  assert.equal(errors, "");
  const runtime = createHeadlessRuntime(s.options); s.handles.push({ runtime, handle: h });
  const recovered = await runtime.reconcile(h); assert.equal(recovered.state, "live", JSON.stringify(recovered));
  const before = (await readFile(h.sessionFile, "utf8")).split("\n").filter((l) => l.includes('"role":"user"')).length;
  const c = await final(runtime, h); assert.equal(c.outcome, "timed-out", JSON.stringify({ error: c.handle.startupError, stop: c.handle.stopReceipt })); assert.ok(c.handle.stopReceipt!.verified);
  const after = (await readFile(h.sessionFile, "utf8")).split("\n").filter((l) => l.includes('"role":"user"')).length;
  assert.equal(after, before); assert.equal(c.handle.deadlineAt, r.deadlineAt);
});

test("guardian enforces deadline with NO replacement controller alive", async (t) => {
  const s = await setup(t);
  // Four measured cold starts, so the watchdog is still holding a live, executing worker when the
  // controller is killed and when its own deadline lands.
  const r = await s.request("guardian-alone", { hold: true, ignoreTerm: true, descendants: true }, await deadlineIn(4));
  const readyFile = path.join(s.root, "solo-handle.json"); const settings = path.join(s.root, "solo-controller.json");
  await atomicJson(settings, { options: s.options, request: r, readyFile });
  const controller = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/controller.mjs", import.meta.url)), settings], { stdio: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  t.after(() => { controller.kill("SIGKILL"); });
  const h = await dispatchHandshake(readyFile, r, () => "");
  // Handshakes, not sleeps: the detached descendant must exist and the watchdog must have recorded it
  // before the controller dies, or "the whole family was killed" would not be testable.
  const descendant = await waitForDeadline(async () => await exists(path.join(r.workspace, "descendant.json")) ? json<{ pid: number }>(path.join(r.workspace, "descendant.json")) : undefined, r.deadlineAt, "fixture detached descendant handshake");
  await waitForDeadline(async () => { const value = await readJson<GuardianJournal>(path.join(h.controlDir, "guardian.json")); return value?.processes.some((p) => p.pid === descendant.pid) ? true : undefined; }, r.deadlineAt, "watchdog observed the detached descendant");
  const closed = new Promise<void>((resolve) => controller.once("close", () => resolve())); controller.kill("SIGKILL"); await closed;
  const journal = await waitForDeadline(async () => { const value = await readJson<GuardianJournal>(path.join(h.controlDir, "guardian.json")); return value?.finished ? value : undefined; }, h.deadlineAt, "guardian journal finished");
  assert.ok(journal.termination!.verified, JSON.stringify(journal.termination)); assert.equal(journal.termination!.reason, "timed-out");
  // The watchdog terminated the family against the original deadline rather than extending it, and the
  // worker's own heartbeat shows it was still executing immediately before that deadline.
  const overdue = journal.termination!.at - h.deadlineAt;
  assert.ok(overdue <= await verifyBudgetMs(), `guardian termination ran ${overdue}ms beyond the original deadline`);
  await assertExecutedUntilDeadline(r.workspace, h.deadlineAt);
  const runtime = createHeadlessRuntime(s.options); s.handles.push({ runtime, handle: h });
  // The journal is durable before the watchdog exits: wait for its identity to disappear so that
  // reconciliation observes a terminated family instead of a watchdog mid-exit.
  await waitFor(async () => (await new LinuxProcessProbe().snapshot()).some((p) => p.pid === journal.guardian.pid && p.state !== "Z") ? undefined : true, 2 * await verifyBudgetMs(), "watchdog exit after the durable journal");
  const recovered = await runtime.reconcile(h); assert.equal(recovered.state, "terminated", JSON.stringify(recovered));
  assert.equal(recovered.handle.status, "timed-out"); assert.equal(recovered.handle.deadlineAt, r.deadlineAt);
});
// ---------------------------------------------------------------------------------------------
// T6 reliability regressions. Each one encodes a failure mode reproduced on a loaded host.
// ---------------------------------------------------------------------------------------------

/** A probe with no measured sample whose first inventory passes outlive the old fixed floor. */
class SlowProbe implements ProcessProbe {
  readonly signals: Array<{ pid: number; signal: string }> = [];
  private live = true;
  private slowest = 0;
  constructor(private readonly delayMs: number) {}
  async snapshot(): Promise<ProcessRow[]> {
    const started = Date.now();
    await sleep(this.delayMs);
    this.slowest = Math.max(this.slowest, Date.now() - started);
    return this.live ? [row(9100)] : [];
  }
  lastSnapshotMs(): number { return this.slowest; }
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    this.signals.push({ pid, signal });
    // The reproduced defect: the first measured pass outlives a bound guessed from no sample at all.
    if (signal === "SIGKILL") this.live = false;
  }
}

test("a slow first inventory is re-measured rather than reported as an unverified termination", async () => {
  // Fixed defect: with `lastSnapshotMs()` at zero the old bound was a fixed 100 ms. A /proc pass that
  // outlived it aborted termination with verified:false even though SIGKILL had been delivered and
  // hundreds of ms of absolute deadline remained (crash recovery, checkpoint and deadline flakes).
  const probe = new SlowProbe(130);
  const family = new ProcessFamily(probe, [row(9100)]);
  const started = Date.now();
  const receipt = await family.terminate({ deadlineAt: started + 4_000, graceMs: 0, reason: "timed-out" });
  assert.equal(probe.signals[0]!.pid, -9100);
  assert.equal(probe.signals[0]!.signal, "SIGKILL");
  assert.ok(receipt.verified, JSON.stringify(receipt));
  assert.deepEqual(receipt.survivors, []);
  assert.ok(Date.now() - started < 4_000, "verification must stay inside the absolute deadline");
});

test("deadline math is monotonic: a backwards wall-clock step cannot extend the budget", () => {
  let wall = 1_000_000; let mono = 0;
  const clock = new Deadline(wall + 5_000, () => wall, () => mono);
  assert.equal(clock.remaining(), 5_000);
  mono = 4_000; wall -= 60_000;
  assert.equal(clock.now(), 1_004_000);
  assert.equal(clock.remaining(), 1_000, "the wall-clock step back must not re-grant budget");
  assert.equal(clock.behind(1_100_000), true);
  assert.equal(clock.exhausted(), false);
  mono = 5_000;
  assert.equal(clock.exhausted(), true);
});

test("controller crash during the retry window is reconciled live without replaying the prompt", async (t) => {
  const s = await setup(t);
  // `retry` records agent_end immediately, then settles after delayMs. Killing the controller inside
  // that window must recover the still-live guardian/worker without re-prompting or dispatching a
  // second writer; agent_end alone is never read as completion.
  const r = await s.request("crash-retry", { retry: true, delayMs: 5000 }, await hangBound());
  const readyFile = path.join(s.root, "retry-handle.json"); const settings = path.join(s.root, "retry-controller.json");
  await atomicJson(settings, { options: s.options, request: r, readyFile });
  const controller = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/controller.mjs", import.meta.url)), settings], { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  t.after(() => { controller.kill("SIGKILL"); });
  const h = await dispatchHandshake(readyFile, r, () => "");
  const userLines = async () => (await readFile(h.sessionFile, "utf8")).split("\n").filter((line) => line.includes('"role":"user"')).length;
  const before = await userLines();
  const closed = new Promise<void>((resolve) => controller.once("close", () => resolve())); controller.kill("SIGKILL"); await closed;
  const runtime = createHeadlessRuntime(s.options); s.handles.push({ runtime, handle: h });
  const recovered = await runtime.reconcile(h); assert.equal(recovered.state, "live", JSON.stringify(recovered));
  const c = await final(runtime, h);
  assert.equal(c.outcome, "completed", JSON.stringify({ error: c.handle.startupError, stop: c.handle.stopReceipt }));
  assert.equal(await userLines(), before);
});

test("an absolute deadline during preparation proves no writer and releases the fence", async (t) => {
  const s = await setup(t); const hooks = filesystemHooks(s.options.controlRoot);
  let release!: () => void; let entered = false; let dispatched = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = createHeadlessRuntime({ ...s.options, hooks: { ...hooks, emit: async (_h, e) => { if (e.type === "starting") { entered = true; await gate; } } },
    dependencies: { spawn: () => { dispatched++; throw new Error("must not dispatch after the preparation deadline"); } } });
  const r = await s.request("expired-preparation", {}, await deadlineIn(2));
  const h = await s.start(runtime, r);
  await waitForDeadline(async () => entered ? true : undefined, r.deadlineAt, "preparation handshake (starting receipt)");
  const c = await final(runtime, h);
  assert.equal(c.outcome, "timed-out", JSON.stringify({ error: c.handle.startupError, stop: c.handle.stopReceipt }));
  assert.ok(c.handle.stopReceipt!.verified, JSON.stringify(c.handle.stopReceipt));
  assert.equal(c.handle.launchIntent, false);
  assert.equal(dispatched, 0);
  // A pre-dispatch expiry has positive evidence of no writer, so the workspace fence is freed.
  // `collect` can observe the terminal status before the stop finishes releasing the fence, so
  // await the in-flight stop (idempotent) before asserting on durable ownership.
  await runtime.stop(h);
  assert.equal(await exists(path.join(s.options.controlRoot, `workspace-${digest(r.workspace)}.lock`)), false);
  release();
  await sleep(await settleMs());
  assert.equal(dispatched, 0);
});

test("a backwards wall-clock step cannot extend the absolute deadline", async (t) => {
  const s = await setup(t);
  let offset = 0;
  const runtime = createHeadlessRuntime({ ...s.options, dependencies: { now: () => Date.now() + offset } });
  const r = await s.request("clock-skew", { hold: true, ignoreTerm: true }, await deadlineIn(2));
  const h = await s.start(runtime, r);
  await waitForDeadline(async () => await exists(path.join(r.workspace, "working.json")) ? true : undefined, r.deadlineAt, "fixture execution handshake");
  offset = -600_000;
  const c = await final(runtime, h);
  assert.equal(c.outcome, "timed-out", JSON.stringify({ error: c.handle.startupError, stop: c.handle.stopReceipt }));
  assert.ok(c.handle.stopReceipt!.verified, JSON.stringify(c.handle.stopReceipt));
  assert.ok(Date.now() - h.deadlineAt < await verifyBudgetMs(), `stop ran ${Date.now() - h.deadlineAt}ms past the original deadline`);
});
test("reconcile adopts a worker that only its durable control markers identify", async (t) => {
  const s = await setup(t); const hooks = filesystemHooks(s.options.controlRoot);
  const r = await s.request("adopt-markers", { hold: true });
  // Simulate a controller that died after persisting durable launch intent but before capturing
  // any native PID. A live process carrying this attempt's session file is the only ownership
  // evidence left; absence of a recorded PID must not be read as absence of a writer.
  const h = await createPlanRuntime().start(r); h.kind = "headless"; h.status = "starting"; h.launchIntent = true; delete h.plan;
  h.controlDir = path.join(s.options.controlRoot, `${attemptKey(h)}-${h.ownerToken}`); h.sessionFile = path.join(h.controlDir, "session.jsonl"); h.sessionId = "inert-session";
  assert.ok(await hooks.claim(h));
  const marker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", "--session", h.sessionFile], { detached: true, stdio: "ignore" });
  t.after(() => { marker.kill("SIGKILL"); });
  const runtime = createHeadlessRuntime(s.options); s.handles.push({ runtime, handle: h });
  const recovered = await runtime.reconcile(h);
  assert.equal(recovered.state, "live", JSON.stringify(recovered));
  assert.ok(recovered.handle.native.processes.some((p) => p.pid === marker.pid), JSON.stringify(recovered.handle.native));
  const stopped = await runtime.stop(h); assert.ok(stopped.verified, JSON.stringify(stopped));
  assert.equal((await runtime.collect(h)).outcome, "stopped");
});
test("a deadline beyond the 32-bit timer range is not mistaken for an expired one", async (t) => {
  const s = await setup(t); const runtime = createHeadlessRuntime(s.options);
  // Node fires a timeout above 2^31-1 ms after roughly 1 ms. A 40-day absolute deadline must stay
  // inside its budget: the enforcement timer is re-armed in chunks instead of cancelling immediately.
  const r = await s.request("long-deadline", { hold: true }, Date.now() + 40 * 24 * 60 * 60 * 1000);
  const h = await s.start(runtime, r);
  await waitFor(async () => await exists(path.join(r.workspace, "working.json")) ? true : undefined, 5_000, "worker executing under a far deadline");
  await sleep(300);
  const snapshot = await runtime.collect(h);
  assert.equal(terminal.has(snapshot.outcome), false, JSON.stringify({ outcome: snapshot.outcome, stop: snapshot.handle.stopReceipt }));
  const stopped = await runtime.stop(h, { reason: "cancelled" }); assert.ok(stopped.verified, JSON.stringify(stopped));
});
test("plan adapter is explicitly unmanaged and refuses lifecycle guarantees", async () => {
  const plan = createPlanRuntime();
  const r: RuntimeRequest = { runId: "run", taskId: "task", attemptId: "one", workspace: "/tmp/inert-plan-not-launched", scopeDigest: "scope", inputDigest: "input", deadlineAt: Date.now() + 500,
    prompt: "Inert plan only", requested: { provider: "fixture", model: "inert", thinking: "max" }, toolPolicy: { mode: "trusted-fixture", allowUnsandboxedHostTools: true, tools: [] } };
  const h = await plan.start(r); assert.equal(h.status, "unmanaged"); assert.equal(h.launchIntent, false);
  assert.ok(Object.values(plan.capabilities).every((c) => c === false)); assert.equal(h.plan!.arguments.model, "fixture/inert:max");
  assert.equal((await plan.collect(h)).resultAcceptance, "not-evaluated"); assert.equal((await plan.reconcile(h)).state, "unmanaged");
  await assert.rejects(plan.stop(h), RuntimeCapabilityError); await assert.rejects(plan.checkpoint(h), RuntimeCapabilityError);
});

class FakeProbe implements ProcessProbe {
  readonly signals: Array<{ pid: number; signal: string }> = [];
  constructor(readonly rows: ProcessRow[], readonly ignore = false) {}
  async snapshot(): Promise<ProcessRow[]> { return [...this.rows]; }
  signal(pid: number, signal: "SIGTERM" | "SIGKILL") { this.signals.push({ pid, signal }); if (!this.ignore) for (let i = this.rows.length - 1; i >= 0; i--) if (pid === this.rows[i]!.pid || -pid === this.rows[i]!.pgid) this.rows.splice(i, 1); }
}
const row = (pid: number, ppid = 1, pgid = pid, startTicks = "one"): ProcessRow => ({ pid, ppid, pgid, startTicks, bootId: "inert-boot", state: "S", argv: [] });

test("native termination revalidates PIDs, retains reparented descendants, and fails closed", async () => {
  const probe = new FakeProbe([row(9000), row(9001, 9000, 9000), row(9010)]); const family = new ProcessFamily(probe, [row(9000)]);
  await family.inspect(); probe.rows.find((p) => p.pid === 9001)!.ppid = 1;
  probe.rows.splice(probe.rows.findIndex((p) => p.pid === 9000), 1, row(9000, 1, 9000, "recycled"));
  const receipt = await family.terminate({ deadlineAt: Date.now() + 200, graceMs: 0, reason: "stopped" }); assert.ok(receipt.verified);
  assert.ok(!probe.signals.some((s) => Math.abs(s.pid) === 9000 || s.pid === 9010)); assert.ok(probe.signals.some((s) => s.pid === 9001));
  const stubborn = new FakeProbe([row(9020)], true); const held = await new ProcessFamily(stubborn, [row(9020)]).terminate({ deadlineAt: Date.now() - 1, graceMs: 1000, reason: "timed-out" });
  assert.equal(held.verified, false); assert.equal(held.survivors.length, 1); assert.equal(stubborn.signals[0]!.signal, "SIGKILL");
  const hanging: ProcessProbe = { snapshot: () => new Promise(() => {}), signal: () => {} };
  const failed = await new ProcessFamily(hanging, [row(9020)]).terminate({ deadlineAt: Date.now() - 1, graceMs: 0, reason: "stopped" }); assert.equal(failed.verified, false);
});

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  return child;
}
test("strict RPC LF framing, command IDs, UTF-8 and bounded pending requests", async () => {
  const child = fakeChild(); const events: Record<string, unknown>[] = []; const errors: string[] = [];
  const peer = new RpcPeer(child, Date.now() + 1000, 1024, (e) => events.push(e), (e) => errors.push(e.message));
  const pending = peer.request("get_state");
  const frame = Buffer.from(`${JSON.stringify({ type: "text", text: "漢\u2028字" })}\n${JSON.stringify({ type: "response", id: "p2o-1", success: true, data: { ok: true } })}\n`);
  for (const byte of frame) child.stdout!.emit("data", Buffer.from([byte]));
  assert.deepEqual(await pending, { ok: true }); assert.equal(events[0]!.text, "漢\u2028字");
  const waits = Array.from({ length: 8 }, () => peer.request("get_state").catch(() => {})); await assert.rejects(peer.request("get_state"), /limit/);
  child.stdout!.emit("data", Buffer.from("x".repeat(1025))); assert.match(errors[0]!, /frame limit/); await Promise.all(waits);
});

test("preflight refuses implicit host tools, unverified sandbox and unsafe configuration", async (t) => {
  const s = await setup(t); const runtime = createHeadlessRuntime(s.options); const r = await s.request("preflight");
  const refused = await runtime.preflight({ ...r, toolPolicy: { mode: "trusted-fixture", allowUnsandboxedHostTools: false, tools: ["bash"] } as unknown as RuntimeRequest["toolPolicy"] }); assert.equal(refused.ok, false);
  const wrongModel = await runtime.preflight({ ...r, requested: { ...r.requested, model: "unprovisioned" } }); assert.equal(wrongModel.ok, false);
  const ac = new AbortController(); ac.abort(); await assert.rejects(runtime.start({ ...r, signal: ac.signal }), /cancelled/i);
  const unsafe = createHeadlessRuntime({ ...s.options, gateway: { ...s.options.gateway, baseUrl: "https://user:secret@example.invalid/" } }); assert.equal((await unsafe.preflight(r)).ok, false);
  const policy: RuntimeRequest["toolPolicy"] = { mode: "sandbox-extension", extension: { path: fixture, sha256: digest(await readFile(fixture)), approval: "inert fixture only, not a sandbox" }, boundaryId: "inert", tools: ["fixture_tool"] };
  assert.equal((await runtime.preflight({ ...r, toolPolicy: policy })).ok, false);
  const checked = createHeadlessRuntime({ ...s.options, verifySandbox: async () => "test-only-boundary-receipt" }); assert.equal((await checked.preflight({ ...r, toolPolicy: policy })).boundaryReceipt, "test-only-boundary-receipt");
  assert.equal((await checked.preflight({ ...r, toolPolicy: { ...policy, tools: ["bash"] } })).ok, false);
});

test("uncertain native launch is quarantined and persistence failure retains workspace fencing", async (t) => {
  const s = await setup(t); const r = await s.request("uncertain"); const hooks = filesystemHooks(s.options.controlRoot);
  const h = await createPlanRuntime().start(r); h.kind = "headless"; h.status = "starting"; h.launchIntent = true; delete h.plan;
  h.controlDir = path.join(s.options.controlRoot, `${attemptKey(h)}-${h.ownerToken}`); h.sessionFile = path.join(h.controlDir, "session.jsonl"); h.sessionId = "inert-session";
  assert.ok(await hooks.claim(h));
  const runtime = createHeadlessRuntime(s.options); s.handles.push({ runtime, handle: h });
  const reconciliation = await runtime.reconcile(h); assert.equal(reconciliation.state, "quarantined");
  assert.match(reconciliation.explanation, /no verifiable native identity/);
  assert.equal((await runtime.stop(h)).verified, false);
  await assert.rejects(runtime.start({ ...r, attemptId: "two" }), /fenced|exists/);
  const badRequest = await s.request("persistence"); let dispatched = 0;
  const broken = createHeadlessRuntime({ ...s.options, hooks: { ...hooks, persistHandle: async (handle) => { if (handle.launchIntent) throw new Error("inert persistence failure"); await hooks.persistHandle(handle); } },
    dependencies: { spawn: () => { dispatched++; throw new Error("must not dispatch without persisted intent"); } } });
  const bad = await s.start(broken, badRequest);
  const c = await final(broken, bad); assert.match(c.handle.startupError!, /persistence/); assert.equal(dispatched, 0);
  await assert.rejects(broken.start({ ...badRequest, attemptId: "two" }), /fenced|exists/);
});

test("spawn failure is positively accounted for; intent persisted before any dispatch", async (t) => {
  const s = await setup(t); const hooks = filesystemHooks(s.options.controlRoot); let launchReceipt = false;
  const runtime = createHeadlessRuntime({ ...s.options, hooks: { ...hooks, persistHandle: async (h) => { await hooks.persistHandle(h); if (h.launchIntent) launchReceipt = true; } },
    dependencies: { spawn: () => { assert.ok(launchReceipt); throw new Error("inert spawn failure"); } } });
  const r = await s.request("spawn-failure"); const h = await s.start(runtime, r); const c = await final(runtime, h);
  assert.equal(c.outcome, "failed"); assert.match(c.handle.startupError!, /inert spawn failure/); assert.ok(c.handle.stopReceipt!.verified);
});

test("cancellation before late preparation cannot dispatch a worker", async (t) => {
  const s = await setup(t); const hooks = filesystemHooks(s.options.controlRoot); let release!: () => void; let entered = false; let dispatched = 0;
  const gate = new Promise<void>((r) => { release = r; });
  const runtime = createHeadlessRuntime({ ...s.options, hooks: { ...hooks, emit: async (_h, e) => { if (e.type === "starting") { entered = true; await gate; } } }, dependencies: { spawn: () => { dispatched++; throw new Error("must not dispatch"); } } });
  // Three measured cold starts: preparation (preflight, claim, lease, first durable receipt) must reach
  // the handshake with headroom. The attempt is cancelled before dispatch, so no execution window is
  // owed here - and none may be granted.
  const r = await s.request("late-preparation", {}, await deadlineIn(3)); const h = await s.start(runtime, r);
  await waitForDeadline(async () => entered ? true : undefined, r.deadlineAt, "preparation handshake (starting receipt)");
  const stop = runtime.stop(h, { reason: "cancelled" });
  assert.ok((await stop).verified); release();
  // Releasing the gate lets the cancelled pipeline run on; give it the window in which it would
  // otherwise reach its spawn call, then require that nothing was dispatched and that no controller
  // state (control directory, session, worker config) was ever created for the cancelled attempt.
  await sleep(await settleMs());
  assert.equal(dispatched, 0);
  assert.equal(await exists(h.controlDir), false);
});

test("receipt extension enforces actual state/tool provenance and settlement, not agent_end", async (t) => {
  const s = await setup(t); const r = await s.request("receipt-unit"); const controlDir = path.join(s.root, "extension"); await mkdir(controlDir);
  const config: WorkerConfig = { version: 1, token: "inert-token", controlDir, workspace: r.workspace, deadlineAt: r.deadlineAt, stopGraceMs: 0, piBinary: fixture, args: [], env: {}, sessionFile: path.join(controlDir, "session.jsonl"), requested: r.requested, toolPolicy: r.toolPolicy, receiptFile: path.join(controlDir, "receipt.json"), journalFile: path.join(controlDir, "journal.json") };
  const env = { ...process.env }; const handlers = new Map<string, (e: Record<string, unknown>, ctx: Parameters<Parameters<typeof guard>[0]["on"]>[1] extends (e: infer _E, c: infer C) => unknown ? C : never) => unknown>();
  let shutdowns = 0;
  const ctx = { cwd: r.workspace, model: { provider: r.requested.provider, id: r.requested.model }, thinkingLevel: "max" as const, sessionManager: { getSessionFile: () => config.sessionFile }, isIdle: () => true, shutdown: () => { shutdowns++; } };
  try {
    for (const k of Object.keys(process.env)) delete process.env[k]; process.env.P2O_CONFIG = path.join(controlDir, "worker.json"); process.env.P2O_ISOLATED = config.token;
    config.env = { ...process.env } as Record<string, string>; await atomicJson(process.env.P2O_CONFIG, config);
    guard({ on: (name, callback) => { handlers.set(name, callback); }, getActiveTools: () => [], getAllTools: () => [] });
    handlers.get("session_start")!({}, ctx); assert.equal((await readJson<{ ready: boolean }>(config.receiptFile, 10000))!.ready, true);
    handlers.get("agent_end")!({}, ctx); assert.equal(shutdowns, 0);
    handlers.get("agent_settled")!({}, ctx); assert.equal(shutdowns, 1);
    assert.deepEqual(handlers.get("tool_call")!({ toolName: "bash" }, ctx), { block: true, terminate: true, reason: "Tool not granted" });
  } finally { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, env); }
});

class InertHerdr {
  private seq = 0;
  readonly panes = new Map<string, ChildProcess>();
  readonly commands: string[][] = [];
  topologyActive = 0; topologyMax = 0;
  readonly command: CommandRunner = async (_binary, args) => {
    this.commands.push([...args]);
    const envelope = (result: unknown) => ({ stdout: JSON.stringify({ id: "inert-cli", result }), stderr: "", code: 0 });
    const error = (code: string) => ({ stdout: JSON.stringify({ id: "inert-cli", error: { code, message: code } }), stderr: "", code: 1 });
    if (args[0] === "--version") return { stdout: "herdr 0.9.0\n", stderr: "", code: 0 };
    if (args[0] === "api") return { stdout: JSON.stringify({ protocol: 22, schema_version: 1, schemas: {} }), stderr: "", code: 0 };
    if (args[1] === "split") {
      this.topologyActive++; this.topologyMax = Math.max(this.topologyMax, this.topologyActive); await sleep(30);
      const id = `owned-pane-${++this.seq}`;
      const child = spawn("/bin/bash", ["--noprofile", "--norc"], { detached: true, stdio: ["pipe", "ignore", "ignore"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_SERVER_SECRET: "never-inherit" } });
      this.panes.set(id, child); this.topologyActive--;
      return envelope({ type: "pane_created", pane: { pane_id: id, terminal_id: `terminal-${id}` } });
    }
    const id = args[1] === "process-info" ? args[3]! : args[2]!; const child = this.panes.get(id);
    if (!child) return error("pane_not_found");
    if (args[1] === "process-info") return envelope({ type: "pane_process_info", process_info: { pane_id: id, shell_pid: child.pid, foreground_processes: [{ pid: child.pid }] } });
    if (args[1] === "run") { assert.match(args[3]!, /exec '\/usr\/bin\/env' '-i'/); child.stdin!.write(`${args[3]}\n`); return envelope({ type: "pane_command_sent", pane_id: id }); }
    if (args[1] === "get") return envelope({ type: "agent_info", agent: { pane_id: id, terminal_id: `terminal-${id}`, agent: "pi", interactive_ready: true, agent_status: "idle" } });
    if (args[1] === "rename") return envelope({ type: "agent_renamed" });
    if (args[1] === "prompt") { assert.ok(!args.includes("--wait")); child.stdin!.write(`${JSON.stringify({ type: "prompt", id: "inert-herdr", message: args[3] })}\n`); return envelope({ type: "agent_prompt_sent" }); }
    if (args[1] === "close") { this.panes.delete(id); child.kill("SIGTERM"); return envelope({ type: "plugin_pane_closed", pane_id: id }); }
    throw new Error(`Unexpected inert Herdr command: ${args.join(" ")}`);
  };
}
test("owned Herdr serializes topology only, runs concurrently, erases server env and verifies stop", async (t) => {
  const s = await setup(t); const herdr = new InertHerdr(); t.after(() => { for (const child of herdr.panes.values()) child.kill("SIGKILL"); });
  const runtime = createHerdrRuntime({ ...s.options, herdrBinary: "/inert/herdr", parentPaneId: "caller-pane", context: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/inert-no-socket", HERDR_PANE_ID: "caller-pane" }, dependencies: { command: async (binary, args, opts) => binary === fixture ? { stdout: "0.85.1", stderr: "", code: 0 } : herdr.command(binary, args, opts) } });
  const ra = await s.request("herdr-a", { hold: true }); const rb = await s.request("herdr-b", { hold: true });
  const [ha, hb] = await Promise.all([s.start(runtime, ra), s.start(runtime, rb)]);
  await waitForDeadline(async () => (await runtime.collect(ha)).outcome === "running" && (await runtime.collect(hb)).outcome === "running" ? true : undefined, ha.deadlineAt, "both owned Herdr panes running");
  assert.equal(herdr.topologyMax, 1); assert.notEqual((await runtime.collect(ha)).handle.native.paneId, (await runtime.collect(hb)).handle.native.paneId);
  const aenv = await json<{ env: Record<string, string> }>(path.join(ra.workspace, "environment.json")); assert.equal(aenv.env.FAKE_SERVER_SECRET, undefined);
  assert.ok((await runtime.collect(ha)).observed.some((r) => r.source === "pi-event" && r.thinking === "max"));
  const [sa, sb] = await Promise.all([runtime.stop(ha), runtime.stop(hb)]); assert.ok(sa.verified, JSON.stringify(sa)); assert.ok(sb.verified, JSON.stringify(sb));
  assert.equal(herdr.panes.size, 0); assert.equal(herdr.commands.filter((a) => a[1] === "prompt").length, 2);
});

test("real Pi public RPC/extension compatibility with an in-process inert provider", { skip: !process.env.P2O_TEST_PI_BINARY }, async (t) => {
  const s = await setup(t); const hooks = filesystemHooks(s.options.controlRoot);
  const runtime = createHeadlessRuntime({ ...s.options, piBinary: process.env.P2O_TEST_PI_BINARY!, startupTimeoutMs: 5000,
    hooks: { ...hooks, validateResume: async () => true },
    receiptExtensionPath: fileURLToPath(new URL("./fixtures/inert-provider.mjs", import.meta.url)) });
  const r = await s.request("real-public-pi", {}, Date.now() + 12000); const h = await s.start(runtime, r); const c = await final(runtime, h);
  assert.equal(c.outcome, "completed", JSON.stringify(c)); assert.match(c.logTail, /Inert public Pi integration result/);
  assert.ok(c.observed.some((r) => r.source === "rpc-state" && r.thinking === "max" && r.matchesRequest)); assert.ok(c.handle.stopReceipt!.verified);
  const checkpoint = await runtime.checkpoint(h);
  const replacement = await runtime.resume(checkpoint, { ...r, attemptId: "two", requested: { ...r.requested, thinking: "high" } });
  s.handles.push({ runtime, handle: replacement });
  const next = await final(runtime, replacement); assert.equal(next.outcome, "completed", JSON.stringify(next));
  assert.ok(next.observed.some((receipt) => receipt.source === "rpc-state" && receipt.thinking === "high" && receipt.matchesRequest));
  assert.equal(next.handle.provenance!.parentSessionId, h.sessionId);
});

// ---------------------------------------------------------------------------------------------
// T11: the gateway's HTTP refusal keeps the stable `GATEWAY_*` code and now also carries the policy reason.
// ---------------------------------------------------------------------------------------------
test("gateway refusals keep the stable denial code and carry the policy reason in the HTTP body", async (t) => {
  // No turn may be forwarded by either refusal below: the upstream is deliberately unreachable.
  const gateway = createControllerModelGateway({
    approval: "test-only local inert gateway", provider: "p2o-inert", upstreamBaseUrl: "http://127.0.0.1:1/never-contacted",
    api: "openai-completions", models: [{ id: "inert", reasoning: true, contextWindow: 32000, maxTokens: 1024, thinkingLevelMap: { max: "max", high: "high" } }],
    credential: { accountId: "provider-main", version: "inert-v1", secret: "inert-fixture-secret" }, requireSpendGate: true,
  });
  await gateway.listen();
  t.after(async () => { await gateway.close(); });
  const requested = { provider: "p2o-inert", model: "inert", thinking: "off" as const };
  const placeholder = gateway.bindAttempt({ attemptId: "gateway-refusal", requested });
  const post = async () => {
    const response = await fetch(`${gateway.url}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${placeholder}`, "content-type": "application/json" }, body: JSON.stringify({ model: "inert", messages: [] }) });
    return { status: response.status, body: await response.json() as { error: { code: string; message: string; reasonCode?: string } } };
  };
  // 1. Declared spend-enforcing with no gate bound (R3 §9.2): the placeholder cannot be forwarded uncharged.
  const absent = await post();
  assert.equal(absent.status, 403);
  assert.equal(absent.body.error.code, "GATEWAY_BUDGET_DENIED", "the outer machine code is unchanged");
  assert.equal(absent.body.error.reasonCode, "SPEND_GATE_ABSENT", "the policy cause is in the body, not only the attestation");
  assert.match(absent.body.error.message, /\[SPEND_GATE_ABSENT\]/);
  // 2. A bound gate that refuses: the ledger's own policy code travels with the refusal (R4 §6).
  const refusal = Object.assign(new Error("Model token budget cannot cover the next provider turn's worst case"), { code: "BUDGET_EXCEEDED" });
  gateway.bindSpendGate({ attemptId: "gateway-refusal", gate: { attemptId: "gateway-refusal", admit: () => { throw refusal; } } });
  const denied = await post();
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "GATEWAY_BUDGET_DENIED");
  assert.equal(denied.body.error.reasonCode, "BUDGET_EXCEEDED");
  assert.match(denied.body.error.message, /\[BUDGET_EXCEEDED\]/);
  assert.equal(gateway.attestations().filter((entry) => entry.outcome === "denied").length, 2, "both refusals are attested");
});

// ---------------------------------------------------------------------------------------------
// T11: the heartbeat reader is bounded and tolerant, so one transient read cannot fail the suite (R4 §11).
// ---------------------------------------------------------------------------------------------
test("the heartbeat reader retries a transient unreadable file until its deadline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-p2o-heartbeat-retry-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const alive = path.join(root, "alive.json");
  // The exact file R4 §11 caught: a zero-length replacement in flight (`Unexpected end of JSON input`).
  await writeFile(alive, "");
  const deadlineAt = Date.now() + 1_000;
  const repaired = sleep(50).then(() => writeFile(alive, JSON.stringify({ at: Date.now(), pid: process.pid })));
  await assertExecutedUntilDeadline(root, deadlineAt);
  await repaired;
});

// ---------------------------------------------------------------------------------------------
// T12: restart spend reconciliation must apply the recovered observation and never swallow a failure.
// R5 case L: the pre-T12 `catch {}` left provider-paid usage uncharged with no durable evidence at all.
// ---------------------------------------------------------------------------------------------
/** Minimal synchronous spend journal for the runtime's plan, with an injectable settlement-save fault. */
function spendJournal() {
  let saved: ModelSpendState | undefined;
  let settlementFaults = 0;
  const journal: ModelSpendJournal = {
    load: () => (saved === undefined ? undefined : structuredClone(saved)),
    save: (state) => {
      const next = structuredClone(state);
      if (settlementFaults > 0 && Object.keys(state.settlements).length > 0) { settlementFaults -= 1; throw new Error("inert spend journal fault"); }
      saved = next;
    },
  };
  return Object.freeze({ journal, state: () => (saved === undefined ? undefined : structuredClone(saved)), faultOnSettlement: (count: number) => { settlementFaults = count; } });
}

/** A crashed controller's durable spend hold plus the assistant usage its session file still records. */
async function spendReconcileFixture(s: Awaited<ReturnType<typeof setup>>, name: string) {
  const limits = { maxTokens: 10_000, maxCostUsd: 1 };
  const prices = pinnedModelPrices({ "p2o-inert/inert": { input: 3, output: 15 } });
  const journal = spendJournal();
  const r = await s.request(name);
  const seeded = new ModelSpendBudget(limits, { runId: r.runId, freshRun: true, journal: journal.journal, prices });
  seeded.bindRun(r.runId, limits);
  const held = seeded.reserve({ attemptId: r.attemptId, selection: { ...r.requested }, inputTokensUpperBound: 600, maxOutputTokens: 100 });
  const handle = await createPlanRuntime().start(r);
  delete handle.plan;
  handle.kind = "headless"; handle.status = "starting";
  handle.controlDir = path.join(s.options.controlRoot, `${attemptKey(handle)}-${handle.ownerToken}`);
  handle.sessionFile = path.join(handle.controlDir, "session.jsonl"); handle.sessionId = "inert-session";
  await mkdir(handle.controlDir, { recursive: true, mode: 0o700 });
  await writeFile(handle.sessionFile, `${JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", usage: { input: 600, output: 100, cost: { total: 0.0033 } } } })}\n`);
  assert.ok(await filesystemHooks(s.options.controlRoot).claim(handle));
  const runtime = createHeadlessRuntime({ ...s.options, spend: { limits, journal: journal.journal, prices } });
  s.handles.push({ runtime, handle });
  return { limits, prices, journal, held, handle, runtime };
}

test("restart reconciliation applies a recovered spend hold to the ledger", async (t) => {
  const s = await setup(t);
  const { journal, held, handle, runtime } = await spendReconcileFixture(s, "spend-reconcile");
  const receipt = await runtime.reconcile(handle);
  assert.equal(receipt.state, "terminated", JSON.stringify(receipt));
  const durable = journal.state()!;
  assert.deepEqual(durable.committed, { tokens: 700, costMicros: 3_300 }, "the recovered 600+100 usage is charged once");
  assert.deepEqual(Object.keys(durable.settlements), [`${held.reservationId}:observed-1`]);
  assert.equal(durable.released[held.reservationId]!.reason, "reconciled:charged-turns=1");
  assert.deepEqual(durable.reservations, {});
  const events = (await runtime.collect(handle)).handle.events;
  assert.ok(!events.some((event) => event.type === "spend-reconciliation-required"), JSON.stringify(events.map((event) => event.type)));
});

test("a reconciliation whose spend write fails is recorded durably and leaves the hold intact", async (t) => {
  const s = await setup(t);
  const { limits, prices, journal, held, handle, runtime } = await spendReconcileFixture(s, "spend-reconcile-fault");
  journal.faultOnSettlement(1);
  const receipt = await runtime.reconcile(handle);
  assert.equal(receipt.state, "terminated", JSON.stringify(receipt));
  const collected = await runtime.collect(handle);
  const failure = collected.handle.events.find((event) => event.type === "spend-reconciliation-required");
  assert.ok(failure, `expected a durable spend-reconciliation-required event, saw ${JSON.stringify(collected.handle.events.map((event) => event.type))}`);
  assert.match(failure.text, /could not be charged to the durable model spend hold/);
  assert.match(failure.text, /persistence failed/);
  const durable = journal.state()!;
  assert.deepEqual(durable.committed, { tokens: 0, costMicros: 0 }, "no partial charge may be durable");
  assert.deepEqual(Object.keys(durable.settlements), []);
  assert.ok(durable.reservations[held.reservationId], "the paid-for hold is retained for the next reconciliation");
  // Not wedged: the same journal still applies the recovered usage and releases the hold afterwards.
  const recovery = new ModelSpendBudget(limits, { runId: handle.runId, journal: journal.journal, prices });
  recovery.bindRun(handle.runId, limits);
  recovery.catchUp({ reservationId: held.reservationId, attemptId: handle.attemptId, selection: held.selection, usage: { inputTokens: 600, outputTokens: 100 } });
  recovery.release(held.reservationId, "reconciled:charged-turns=1");
  assert.deepEqual(journal.state()!.committed, { tokens: 700, costMicros: 3_300 });
});
