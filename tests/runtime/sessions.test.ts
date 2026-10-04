// ---------------------------------------------------------------------------------------------
// B4: RUNTIME PACK-LIFETIME INTEGRATION
//
// Pack sessions must die with their attempt on EVERY termination path. This file drives the real
// managed runtimes (inert local fixture worker, no provider and no target) with a pack that exposes
// exactly what the browser pack exposes to a runtime owner (`releaseAttempt` / `close`, plus the
// optional attributable `outstanding` and crash-recovery `sweep` hooks) and whose "sessions" are real
// OS processes recorded in a pid file next to a private profile directory. The sweep re-validates the
// recorded pid against /proc/<pid>/cmdline, i.e. the same identity-before-signal rule the browser
// pack's profile sweep and the runtime's owned-process fence use. No browser, model, or target is
// contacted. Timing thresholds are derived from a measured cold start, never guessed.
// ---------------------------------------------------------------------------------------------
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  createHeadlessRuntime, createPlanRuntime, filesystemHooks, LinuxProcessProbe,
  type ManagedRuntimeOptions, type ProcessIdentity, type RuntimeAdapter, type RuntimeHandle, type RuntimeRequest, type SessionReleaser, type SessionScope,
} from "../../src/runtime/index.js";
import { SessionReleaseRegistry, type AttemptSessionPack } from "../../src/runtime/sessions.js";
import type { BrowserPack } from "../../src/tools/browser-session.js";
import { processIdentity } from "../../src/runtime/processes.js";
import { attemptKey } from "../../src/runtime/filesystem-hooks.js";
import { readJson } from "../../src/runtime/io.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const terminal = new Set(["completed", "failed", "cancelled", "timed-out", "stopped", "quarantined"]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A generous bound for a test that verifies something other than deadline enforcement. */
const HANG_BOUND_MS = 60_000;

// The runtime-side adapter must accept the REAL browser pack unchanged: only its `releaseAttempt` /
// `close` callbacks are driven (the pack closes its egress proxy inside the same kill), and nothing
// about the pack's internals is re-designed. This is a compile-time proof, not a runtime mock.
type BrowserPackSatisfiesAttemptSessionPack = BrowserPack extends AttemptSessionPack ? true : never;
const browserPackIsAcceptedByTheRuntime: BrowserPackSatisfiesAttemptSessionPack = true;

async function waitFor<T>(work: () => Promise<T | undefined>, ms: number, label: string): Promise<T> {
  // Monotonic bound: an NTP step or a laptop suspend can move the wall clock by minutes while a test is
  // running. The runtime enforces deadlines monotonically, so the fixture bound must not flake on it.
  const started = performance.now(); const end = started + ms;
  do { const value = await work(); if (value !== undefined) return value; await sleep(25); } while (performance.now() < end);
  throw new Error(`Inert fixture condition timed out after ${Math.round(performance.now() - started)}ms (${label})`);
}
async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
const scopeOf = (h: Pick<RuntimeHandle, "runId" | "taskId" | "attemptId">): SessionScope => ({ runId: h.runId, taskId: h.taskId, attemptId: h.attemptId });
const sameScope = (a: SessionScope, b: SessionScope): boolean => a.runId === b.runId && a.taskId === b.taskId && a.attemptId === b.attemptId;
/** The durable handle snapshot (never the caller's clone, which is not updated in place). */
async function durable(runtime: RuntimeAdapter, handle: RuntimeHandle): Promise<RuntimeHandle> { return (await runtime.collect(handle)).handle; }

function runtimeOptions(controlRoot: string, overrides: Partial<ManagedRuntimeOptions> = {}): ManagedRuntimeOptions {
  return { controlRoot, piBinary: fixture, nodeBinary: process.execPath, pollMs: 25, startupTimeoutMs: 3000, stopGraceMs: 120,
    gateway: { approval: "test-only local inert fixture", baseUrl: "http://127.0.0.1:1/never-contacted", api: "openai-completions",
      models: [{ id: "inert", reasoning: true, contextWindow: 32000, maxTokens: 1024, thinkingLevelMap: { max: "max", high: "high" } }] },
    ...overrides };
}

async function inertRequest(root: string, name: string, mode: Record<string, unknown>, deadlineAt: number): Promise<RuntimeRequest> {
  const workspace = path.join(root, name); await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(path.join(workspace, "fixture.json"), JSON.stringify(mode));
  return { runId: "session-run", taskId: name, attemptId: "one", workspace, scopeDigest: "inert-scope", inputDigest: "inert-input", deadlineAt,
    requested: { provider: "p2o-inert", model: "inert", thinking: "max" }, prompt: "Local inert fixture only; do not contact any target",
    toolPolicy: { mode: "trusted-fixture", allowUnsandboxedHostTools: true, tools: [] } };
}

async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-p2o-session-"));
  const controlRoot = path.join(root, "controller");
  const handles: Array<{ runtime: RuntimeAdapter; handle: RuntimeHandle }> = [];
  const packs: InertSessionPack[] = [];
  const request = async (name: string, mode: Record<string, unknown> = {}, deadlineAt?: number): Promise<RuntimeRequest> =>
    inertRequest(root, name, mode, deadlineAt ?? Date.now() + HANG_BOUND_MS);
  const start = async (runtime: RuntimeAdapter, r: RuntimeRequest) => { const handle = await runtime.start(r); handles.push({ runtime, handle }); return handle; };
  const profiles = path.join(root, "profiles"); await mkdir(profiles, { recursive: true, mode: 0o700 });
  t.after(async () => {
    for (const { runtime, handle } of handles) { try { await runtime.stop(handle); } catch {} }
    for (const pack of packs) { try { await pack.close(); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  return { root, profiles, controlRoot, request, start, handles, packs };
}

/** One real cold dispatch, so the deadline test can express its budget in measured units. */
let coldStart: Promise<number> | undefined;
function measuredColdStartMs(): Promise<number> {
  coldStart ??= (async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-p2o-session-cost-"));
    try {
      const request = await inertRequest(root, "cost", { hold: true, ignoreTerm: true }, Date.now() + HANG_BOUND_MS);
      const runtime = createHeadlessRuntime(runtimeOptions(path.join(root, "controller"), { startupTimeoutMs: 30_000 }));
      const started = Date.now();
      const handle = await runtime.start(request);
      await waitFor(async () => await exists(path.join(request.workspace, "working.json")) ? true : undefined, 45_000, "cold start handshake");
      const dispatchMs = Date.now() - started;
      const receipt = await runtime.stop(handle, { reason: "cancelled" });
      if (!receipt.verified) throw new Error(`Cold start calibration could not verify termination: ${JSON.stringify(receipt)}`);
      return Math.min(20_000, Math.max(2_500, dispatchMs));
    } finally { await rm(root, { recursive: true, force: true }); }
  })();
  return coldStart;
}

async function final(runtime: RuntimeAdapter, handle: RuntimeHandle): Promise<RuntimeHandle> {
  return await waitFor(async () => {
    const collected = await runtime.collect(handle);
    return terminal.has(collected.outcome) && collected.handle.stopReceipt ? collected.handle : undefined;
  }, Math.max(0, handle.deadlineAt - Date.now()) + 30_000, "terminal outcome with a verified stop receipt");
}

const alivePid = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Kernel identity of a process this test started and already reaped: a crashed controller is never
 *  mistaken for a recycled pid because start-time/boot identity is checked, not the bare pid. */
async function deadProcessIdentity(): Promise<ProcessIdentity> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  const rows = await new LinuxProcessProbe().snapshot();
  const row = rows.find((candidate) => candidate.pid === child.pid);
  assert.ok(row, "the fixture controller process must be visible in /proc");
  child.kill("SIGKILL");
  // The child may have exited while the /proc inventory was running, in which case its `exit` event has
  // already fired: awaiting it then would wait forever (the event loop has nothing left to run).
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  return processIdentity(row);
}

/** This test process's own identity, used where a *live* controller owner must be respected. */
async function ownIdentity(): Promise<ProcessIdentity> {
  const rows = await new LinuxProcessProbe().snapshot();
  const own = rows.find((row) => row.pid === process.pid);
  assert.ok(own, "the test process must be visible in /proc");
  return processIdentity(own);
}

interface OwnerFile { pid: number; profile: string; scope: SessionScope; token: string }

/**
 * An inert attempt-scoped session pack. Sessions are real child processes whose argv names their
 * private profile directory; `releaseAttempt` kills them and returns the number killed (the browser
 * pack's contract), `outstanding` reports the sessions one attempt still owns, and `sweep` is the
 * crash-recovery path that re-validates a pid file from /proc before signalling anything. The switches
 * (`leak`, `failure`, `hang`) model a pack whose release does not fully succeed.
 */
class InertSessionPack implements AttemptSessionPack {
  readonly releaseCalls: SessionScope[] = [];
  readonly sweepCalls: Array<{ scope: SessionScope; ownerPid: number }> = [];
  leak = false;
  failure?: string;
  hang = false;
  /** One-shot close failure: models a pack whose shutdown hook fails once and whose retry must run again. */
  closeFailure?: string;
  constructor(private readonly profileRoot: string, private readonly fence?: { assertOpen(scope: SessionScope, token: string): Promise<void> }) {}

  private async records(): Promise<Array<{ profile: string; owner: OwnerFile }>> {
    let names: string[];
    try { names = await readdir(this.profileRoot); } catch { return []; }
    const found: Array<{ profile: string; owner: OwnerFile }> = [];
    for (const name of names.filter((entry) => entry.startsWith("p2o-inert-session-")).slice(0, 64)) {
      const profile = path.join(this.profileRoot, name);
      try { found.push({ profile, owner: JSON.parse(await readFile(path.join(profile, "p2o-owner.json"), "utf8")) as OwnerFile }); } catch { /* removed concurrently */ }
    }
    return found;
  }

  /** Identity before signal: a recorded pid is only killed when /proc still names its own profile. */
  private owned(owner: OwnerFile): boolean {
    try { return readFileSync(`/proc/${owner.pid}/cmdline`, "utf8").includes(owner.profile); }
    catch { return false; }
  }

  private async destroy(record: { profile: string; owner: OwnerFile }): Promise<boolean> {
    const owned = this.owned(record.owner);
    if (owned) { try { process.kill(record.owner.pid, "SIGKILL"); } catch { /* already gone */ } }
    await sleep(25);
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await rm(record.profile, { recursive: true, force: true }); break; } catch { await sleep(50); }
    }
    return owned;
  }

  private liveRecords(): Array<{ profile: string; owner: OwnerFile }> {
    const found: Array<{ profile: string; owner: OwnerFile }> = [];
    let names: string[];
    try { names = readdirSync(this.profileRoot); } catch { return found; }
    for (const name of names.filter((entry) => entry.startsWith("p2o-inert-session-"))) {
      const profile = path.join(this.profileRoot, name);
      try {
        const owner = JSON.parse(readFileSync(path.join(profile, "p2o-owner.json"), "utf8")) as OwnerFile;
        if (this.owned(owner)) found.push({ profile, owner });
      } catch { /* removed concurrently */ }
    }
    return found;
  }

  /** The whole live count, like the browser pack's `sessions`; deliberately not attempt-attributable. */
  get sessions(): number { return this.liveRecords().length; }

  async open(scope: SessionScope, token: string): Promise<{ profile: string; pid: number }> {
    // A pack that wants to be attempt-fenced asks the runtime's session lease first.
    await this.fence?.assertOpen(scope, token);
    const profile = await mkdtemp(path.join(this.profileRoot, "p2o-inert-session-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", profile], { stdio: "ignore", detached: true, env: { PATH: "/usr/bin:/bin" } });
    assert.ok(child.pid, "inert session process must start");
    await writeFile(path.join(profile, "p2o-owner.json"), JSON.stringify({ pid: child.pid, profile, scope, token }), { mode: 0o600 });
    child.unref();
    return { profile, pid: child.pid };
  }

  async releaseAttempt(scope: SessionScope): Promise<number> {
    this.releaseCalls.push(scope);
    if (this.hang) return await new Promise<number>(() => {});
    if (this.failure) throw new Error(this.failure);
    if (this.leak) return 0; // a leaky pack: the session stays live and is reported through `outstanding`
    let killed = 0;
    for (const record of (await this.records()).filter((entry) => sameScope(entry.owner.scope, scope))) if (await this.destroy(record)) killed += 1;
    return killed;
  }

  outstanding(scope: SessionScope): number { return this.liveRecords().filter((entry) => sameScope(entry.owner.scope, scope)).length; }

  async sweep(scope: SessionScope, owner: { process: ProcessIdentity }): Promise<number> {
    this.sweepCalls.push({ scope, ownerPid: owner.process.pid });
    let killed = 0;
    for (const record of (await this.records()).filter((entry) => sameScope(entry.owner.scope, scope))) if (await this.destroy(record)) killed += 1;
    return killed;
  }

  async close(): Promise<void> {
    if (this.closeFailure) { const message = this.closeFailure; this.closeFailure = undefined; throw new Error(message); }
    for (const record of await this.records()) await this.destroy(record);
  }
}

function releaserFor(pack: InertSessionPack, name = "inert-session-pack"): SessionReleaser {
  return { name, release: (scope) => pack.releaseAttempt(scope), outstanding: (scope) => pack.outstanding(scope),
    sweep: (scope, owner) => pack.sweep(scope, owner), shutdown: () => pack.close() };
}

/** Open one pack session under the attempt's own lease (fail-closed when the lease is not open). */
async function openSession(pack: InertSessionPack, handle: RuntimeHandle): Promise<{ profile: string; pid: number }> {
  return await pack.open(scopeOf(handle), handle.ownerToken);
}

// ---------------------------------------------------------------------------------------------
// Completion: the session is released, the release is idempotent, and no later attempt can reuse it.
// ---------------------------------------------------------------------------------------------
test("a completed attempt releases its pack session; release is idempotent and the sealed lease refuses a second attempt", async (t) => {
  // The real browser pack satisfies the runtime's structural releaser contract (see the type assertion above).
  assert.equal(browserPackIsAcceptedByTheRuntime, true);
  const s = await setup(t);
  const runtime = createHeadlessRuntime(runtimeOptions(s.controlRoot, { sessions: {} }));
  const pack = new InertSessionPack(s.profiles, runtime.sessions); s.packs.push(pack);
  runtime.registerSessionReleaser(releaserFor(pack));
  const handle = await s.start(runtime, await s.request("session-completion", { delayMs: 2500 }));
  const session = await openSession(pack, handle);
  assert.ok(alivePid(session.pid), "the pack session must be live while the attempt runs");
  assert.equal(pack.sessions, 1);
  const settled = await final(runtime, handle);
  assert.equal(settled.status, "completed", JSON.stringify(settled.events.slice(-4)));
  assert.ok(settled.stopReceipt!.verified);
  assert.equal(settled.sessionRelease?.verified, true, JSON.stringify(settled.sessionRelease));
  assert.equal(settled.sessionRelease?.reason, "completed");
  assert.equal(settled.sessionRelease?.releasers[0]?.released, 1);
  assert.equal(alivePid(session.pid), false, "the pack session must be dead once the attempt completed");
  assert.equal(await exists(session.profile), false, "the pack profile must be removed");
  assert.equal(pack.sessions, 0);
  assert.ok(settled.events.some((event) => event.type === "session-release"), JSON.stringify(settled.events.map((event) => event.type)));

  // Idempotent: a second termination path replays the durable verdict and kills nothing again.
  const calls = pack.releaseCalls.length;
  const replay = await runtime.sessions.release(scopeOf(handle), handle.ownerToken, "stopped");
  assert.equal(replay.state, "already-released"); assert.equal(replay.duplicate, true); assert.equal(replay.reason, "completed");
  assert.equal(pack.releaseCalls.length, calls, "an idempotent replay must not call the pack again");

  // A second attempt can neither adopt the sealed lease nor release a foreign one.
  const other = createHeadlessRuntime(runtimeOptions(s.controlRoot));
  await assert.rejects(other.sessions.assertOpen(scopeOf(handle), handle.ownerToken), /sealed/);
  await assert.rejects(pack.open(scopeOf(handle), handle.ownerToken), /sealed/);
  const foreign = await other.sessions.release(scopeOf(handle), "another-attempt-owner-token", "stopped");
  assert.equal(foreign.verified, false); assert.equal(foreign.state, "failed");
  assert.match(foreign.evidenceNote!, /another attempt owner/);
});

// ---------------------------------------------------------------------------------------------
// Verified stop, cancellation and graceful controller exit: three more paths that must release.
// ---------------------------------------------------------------------------------------------
test("a verified stop, a cancellation and a controller shutdown each release the attempt's session", async (t) => {
  const s = await setup(t);
  const runtime = createHeadlessRuntime(runtimeOptions(s.controlRoot));
  const pack = new InertSessionPack(s.profiles, runtime.sessions); s.packs.push(pack);
  runtime.registerSessionReleaser(releaserFor(pack));

  const stopped = await s.start(runtime, await s.request("session-stopped", { hold: true, ignoreTerm: true }));
  const stoppedSession = await openSession(pack, stopped);
  assert.ok(alivePid(stoppedSession.pid));
  const receipt = await runtime.stop(stopped, { reason: "stopped" });
  assert.ok(receipt.verified);
  const stoppedDurable = await durable(runtime, stopped);
  assert.equal(stoppedDurable.sessionRelease?.verified, true, JSON.stringify(stoppedDurable.sessionRelease));
  assert.equal(stoppedDurable.sessionRelease?.reason, "stopped");
  assert.equal(alivePid(stoppedSession.pid), false);

  const cancelled = new AbortController();
  const cancelledHandle = await s.start(runtime, { ...(await s.request("session-cancelled", { hold: true, ignoreTerm: true })), signal: cancelled.signal });
  const cancelledSession = await openSession(pack, cancelledHandle);
  assert.ok(alivePid(cancelledSession.pid));
  cancelled.abort();
  const cancelledTerminal = await final(runtime, cancelledHandle);
  assert.equal(cancelledTerminal.status, "cancelled");
  assert.equal(cancelledTerminal.sessionRelease?.verified, true, JSON.stringify(cancelledTerminal.sessionRelease));
  assert.equal(cancelledTerminal.sessionRelease?.reason, "cancelled");
  assert.equal(alivePid(cancelledSession.pid), false);

  // Graceful controller exit: the pack itself closes every session it still holds.
  const shutdownHandle = await s.start(runtime, await s.request("session-shutdown", { hold: true, ignoreTerm: true }));
  const shutdownSession = await openSession(pack, shutdownHandle);
  assert.ok(alivePid(shutdownSession.pid));
  await runtime.shutdown();
  assert.equal(alivePid(shutdownSession.pid), false, "a graceful controller exit must kill the sessions it still holds");
  assert.equal(await runtime.stop(shutdownHandle, { reason: "stopped" }).then((value) => value.verified), true);
});

// A failed graceful shutdown is retryable cleanup: the second call must actually re-run the pack hooks
// instead of replaying the first failure as if it were a durable clean verdict.
test("a failed controller shutdown is retryable, and the retry closes the exact sessions it left behind", async (t) => {
  const s = await setup(t);
  const runtime = createHeadlessRuntime(runtimeOptions(s.controlRoot));
  const pack = new InertSessionPack(s.profiles, runtime.sessions); s.packs.push(pack);
  runtime.registerSessionReleaser(releaserFor(pack));
  const handle = await s.start(runtime, await s.request("session-shutdown-retry", { hold: true, ignoreTerm: true }));
  const session = await openSession(pack, handle);
  assert.ok(alivePid(session.pid));
  pack.closeFailure = "inert session pack shutdown failure";
  await assert.rejects(runtime.shutdown(), /Runtime shutdown unverified/);
  assert.ok(alivePid(session.pid), "a failed shutdown must not report a vacuous success over a live session");
  await runtime.shutdown();
  assert.equal(alivePid(session.pid), false, "the retry must close the sessions the failed shutdown left behind");
  assert.equal(await exists(session.profile), false);
});

// ---------------------------------------------------------------------------------------------
// Deadline expiry: the runtime's own enforced deadline releases the session too.
// ---------------------------------------------------------------------------------------------
test("deadline expiry releases the attempt's session under the enforced deadline", async (t) => {
  const s = await setup(t);
  const runtime = createHeadlessRuntime(runtimeOptions(s.controlRoot, { startupTimeoutMs: 20_000 }));
  const pack = new InertSessionPack(s.profiles, runtime.sessions); s.packs.push(pack);
  runtime.registerSessionReleaser(releaserFor(pack));
  // Measured, never guessed: three cold starts put dispatch comfortably inside the attempt's budget
  // while still leaving the worker executing when the enforced deadline fires.
  const handle = await s.start(runtime, await s.request("session-deadline", { hold: true, ignoreTerm: true }, Date.now() + 3 * await measuredColdStartMs()));
  const session = await openSession(pack, handle);
  assert.ok(alivePid(session.pid), "the pack session must be live while the attempt runs");
  const settled = await final(runtime, handle);
  assert.equal(settled.status, "timed-out", JSON.stringify(settled.events.map((event) => event.type)));
  assert.equal(settled.sessionRelease?.verified, true, JSON.stringify(settled.sessionRelease));
  assert.equal(settled.sessionRelease?.reason, "timed-out");
  assert.equal(alivePid(session.pid), false, "a deadline-expired attempt must not leave a live pack session");
});

// ---------------------------------------------------------------------------------------------
// Quarantine and crash reconciliation: the two paths where no verified termination was observed.
// ---------------------------------------------------------------------------------------------
test("a quarantined attempt and a restarted controller both release the attempt's session", async (t) => {
  const s = await setup(t);
  const hooks = filesystemHooks(s.controlRoot);

  // Quarantine: a persisted launch intent with no verifiable native identity cannot be terminated,
  // yet the session of the quarantined attempt must still die.
  const quarantineRuntime = createHeadlessRuntime(runtimeOptions(s.controlRoot));
  const quarantinePack = new InertSessionPack(s.profiles, quarantineRuntime.sessions); s.packs.push(quarantinePack);
  quarantineRuntime.registerSessionReleaser(releaserFor(quarantinePack));
  const quarantineHandle = await createPlanRuntime().start(await s.request("session-quarantine"));
  quarantineHandle.kind = "headless"; quarantineHandle.status = "starting"; quarantineHandle.launchIntent = true; delete quarantineHandle.plan;
  quarantineHandle.controlDir = path.join(s.controlRoot, `${attemptKey(quarantineHandle)}-${quarantineHandle.ownerToken}`);
  quarantineHandle.sessionFile = path.join(quarantineHandle.controlDir, "session.jsonl"); quarantineHandle.sessionId = "inert-session";
  assert.ok(await hooks.claim(quarantineHandle));
  await quarantineRuntime.sessions.open(scopeOf(quarantineHandle), quarantineHandle.ownerToken, await ownIdentity());
  const quarantinedSession = await openSession(quarantinePack, quarantineHandle);
  const reconciliation = await quarantineRuntime.reconcile(quarantineHandle);
  assert.equal(reconciliation.state, "quarantined", JSON.stringify(reconciliation.explanation));
  assert.equal(reconciliation.handle.sessionRelease?.verified, true, JSON.stringify(reconciliation.handle.sessionRelease));
  assert.equal(reconciliation.handle.sessionRelease?.reason, "quarantined");
  assert.equal(alivePid(quarantinedSession.pid), false, "a quarantined attempt must not leave a live pack session");

  // Crash recovery: the recovered attempt's lease records a controller identity that is no longer
  // alive, its worker processes are gone, and the pack session is still running.
  const restarted = createHeadlessRuntime(runtimeOptions(s.controlRoot));
  const crashPack = new InertSessionPack(s.profiles, restarted.sessions); s.packs.push(crashPack);
  restarted.registerSessionReleaser(releaserFor(crashPack));
  const crashedHandle = await createPlanRuntime().start(await s.request("session-crash"));
  crashedHandle.kind = "headless"; crashedHandle.status = "running"; crashedHandle.launchIntent = true; delete crashedHandle.plan;
  crashedHandle.controlDir = path.join(s.controlRoot, `${attemptKey(crashedHandle)}-${crashedHandle.ownerToken}`);
  crashedHandle.sessionFile = path.join(crashedHandle.controlDir, "session.jsonl"); crashedHandle.sessionId = "inert-session";
  crashedHandle.native.processes = [await deadProcessIdentity()];
  assert.ok(await hooks.claim(crashedHandle));
  await restarted.sessions.open(scopeOf(crashedHandle), crashedHandle.ownerToken, await deadProcessIdentity());
  const crashedSession = await openSession(crashPack, crashedHandle);
  assert.ok(alivePid(crashedSession.pid));
  const recovered = await restarted.reconcile(crashedHandle);
  assert.equal(recovered.state, "terminated", JSON.stringify(recovered.explanation));
  assert.equal(recovered.handle.sessionRelease?.verified, true, JSON.stringify(recovered.handle.sessionRelease));
  assert.equal(recovered.handle.sessionRelease?.reason, "crash-recovery");
  assert.equal(alivePid(crashedSession.pid), false, "crash recovery must kill the orphaned pack session");
  assert.ok(crashPack.sweepCalls.some((call) => sameScope(call.scope, scopeOf(crashedHandle))), "the restart sweep must drive the pack's crash-recovery hook");
});

// ---------------------------------------------------------------------------------------------
// Restart sweep over durable leases: stale owners are swept, live owners are never touched.
// ---------------------------------------------------------------------------------------------
test("the restart sweep kills a dead owner's session, respects a live owner, and reports an unsweepable lease", async (t) => {
  const s = await setup(t);
  const stale = createHeadlessRuntime(runtimeOptions(s.controlRoot));
  const pack = new InertSessionPack(s.profiles, stale.sessions); s.packs.push(pack);
  stale.registerSessionReleaser(releaserFor(pack));

  // (a) A dead owner's lease is stale: the session dies and the lease is durably sealed as swept.
  const deadScope: SessionScope = { runId: "session-run", taskId: "sweep-dead", attemptId: "one" };
  await stale.sessions.open(deadScope, "dead-owner-token", await deadProcessIdentity());
  const deadSession = await pack.open(deadScope, "dead-owner-token");
  assert.ok(alivePid(deadSession.pid));
  const first = await stale.sweepStaleSessions();
  assert.equal(first.verified, true, JSON.stringify(first));
  assert.equal(first.swept, 1, JSON.stringify(first.entries));
  assert.equal(alivePid(deadSession.pid), false);
  const sealed = await readJson<{ state: string; sweep?: { state: string } }>(path.join(s.controlRoot, "sessions", `lease-${attemptKey(deadScope)}.json`));
  assert.equal(sealed?.state, "swept", JSON.stringify(sealed));

  // (b) A live owner's lease is never touched, even by a controller sweeping the same directory.
  const liveScope: SessionScope = { runId: "session-run", taskId: "sweep-live", attemptId: "one" };
  const liveOwner = await ownIdentity();
  const livePack = new InertSessionPack(s.profiles, stale.sessions); s.packs.push(livePack);
  await stale.sessions.open(liveScope, "live-owner-token", liveOwner);
  const liveSession = await livePack.open(liveScope, "live-owner-token");
  const second = await stale.sessions.sweepStale(await ownIdentity());
  assert.ok(second.entries.some((entry) => entry.state === "skipped-live-owner" && sameScope(entry.scope, liveScope)), JSON.stringify(second.entries));
  assert.ok(alivePid(liveSession.pid), "a live controller's session must survive another controller's sweep");
  assert.equal(await livePack.releaseAttempt(liveScope), 1);

  // (c) A recycled pid is not an identity: the same live pid with a different start time is stale.
  const recycledScope: SessionScope = { runId: "session-run", taskId: "sweep-recycled", attemptId: "one" };
  await stale.sessions.open(recycledScope, "recycled-token", { ...liveOwner, startTicks: "0" });
  const third = await stale.sessions.sweepStale(await ownIdentity());
  const entry = third.entries.find((candidate) => sameScope(candidate.scope, recycledScope));
  assert.ok(entry, JSON.stringify(third.entries));
  assert.equal(entry.state, "swept", JSON.stringify(entry));
  assert.ok(alivePid(liveOwner.pid), "the sweep must never signal the live process behind a recycled pid");

  // (d) A stale lease no pack can sweep is reported, and left unsealed for a later retry.
  const unsweepableScope: SessionScope = { runId: "session-run", taskId: "sweep-unverifiable", attemptId: "one" };
  const bare = createHeadlessRuntime(runtimeOptions(s.controlRoot));
  await bare.sessions.open(unsweepableScope, "bare-token", await deadProcessIdentity());
  const fourth = await bare.sweepStaleSessions();
  const unsweepable = fourth.entries.find((candidate) => sameScope(candidate.scope, unsweepableScope));
  assert.ok(unsweepable, JSON.stringify(fourth.entries));
  assert.equal(unsweepable.state, "unverifiable");
  assert.match(unsweepable.error!, /No session pack is registered/);
  assert.equal(fourth.verified, false);
  const retryable = await readJson<{ state: string }>(path.join(s.controlRoot, "sessions", `lease-${attemptKey(unsweepableScope)}.json`));
  assert.equal(retryable?.state, "open", "an unsweepable lease stays open so a later sweep retries it");
});

// A sweep that cannot prove which owners are dead must not sweep blind: liveness has to be established,
// never assumed, so an unavailable process inventory reports every unsealed lease as unsweepable.
test("the restart sweep fails closed when owner liveness cannot be determined", async (t) => {
  const s = await setup(t);
  const pack = new InertSessionPack(s.profiles, undefined); s.packs.push(pack);
  const blind = new SessionReleaseRegistry({ root: path.join(s.controlRoot, "sessions"),
    probe: { snapshot: async () => { throw new Error("inert inventory failure"); }, signal: () => {} },
    now: Date.now, monoNow: () => performance.now(), config: { releasers: [releaserFor(pack)] } });
  const scope: SessionScope = { runId: "session-run", taskId: "sweep-blind", attemptId: "one" };
  await blind.open(scope, "blind-token", await ownIdentity());
  const receipt = await blind.sweepStale(await ownIdentity());
  assert.equal(receipt.verified, false, JSON.stringify(receipt));
  assert.equal(receipt.swept, 0); assert.equal(receipt.unverifiable, 1, JSON.stringify(receipt.entries));
  assert.match(receipt.entries[0]!.error!, /liveness could not be determined/i);
  assert.equal(pack.sweepCalls.length, 0, "no pack may be asked to kill a session whose owner liveness is unknown");
  const lease = await readJson<{ state: string }>(path.join(s.controlRoot, "sessions", `lease-${attemptKey(scope)}.json`));
  assert.equal(lease?.state, "open", "an unsweepable lease is left open for a later sweep");
});

// ---------------------------------------------------------------------------------------------
// Failure visibility: an unreleased session, a failing release and a hanging release are durable
// evidence, never a silent success, and process termination stays verified.
// ---------------------------------------------------------------------------------------------
test("an unreleased, failing or hanging release is reported durably without hiding verified termination", async (t) => {
  const s = await setup(t);
  const leakyRuntime = createHeadlessRuntime(runtimeOptions(s.controlRoot));
  const leakyPack = new InertSessionPack(s.profiles, leakyRuntime.sessions); s.packs.push(leakyPack);
  leakyPack.leak = true;
  leakyRuntime.registerSessionReleaser(releaserFor(leakyPack));
  const leakyHandle = await s.start(leakyRuntime, await s.request("session-leak", { hold: true, ignoreTerm: true }));
  const leakedSession = await openSession(leakyPack, leakyHandle);
  const leakyReceipt = await leakyRuntime.stop(leakyHandle, { reason: "stopped" });
  assert.ok(leakyReceipt.verified, "process termination is verified independently of the session release");
  const leakyDurable = await durable(leakyRuntime, leakyHandle);
  assert.equal(leakyDurable.sessionRelease?.verified, false);
  assert.equal(leakyDurable.sessionRelease?.state, "orphaned");
  assert.equal(leakyDurable.sessionRelease?.outstanding, 1);
  assert.ok(alivePid(leakedSession.pid), "the report is true: the pack session really is still live");

  assert.ok(leakyDurable.events.some((event) => event.type === "session-release-failed"), JSON.stringify(leakyDurable.events.map((event) => event.type)));
  await assert.rejects(leakyRuntime.checkpoint(leakyHandle), /pack session release is unverified/);
  await assert.rejects(leakyRuntime.start({ runId: leakyHandle.runId, taskId: leakyHandle.taskId, attemptId: 'replacement', workspace: leakyHandle.workspace,
    scopeDigest: leakyHandle.scopeDigest, inputDigest: leakyHandle.inputDigest, deadlineAt: leakyHandle.deadlineAt, requested: leakyHandle.requested,
    toolPolicy: leakyHandle.toolPolicy, prompt: 'inert replacement must not launch while pack resources survive' }), /Workspace fenced/);
  leakyPack.leak = false;
  assert.equal((await leakyRuntime.stop(leakyHandle, { reason: 'stopped' })).verified, true, 'native proof remains separate while session cleanup retries');
  assert.equal((await durable(leakyRuntime, leakyHandle)).sessionRelease?.verified, true, 'cleanup retry must now have actual pack absence proof');
  assert.equal(alivePid(leakedSession.pid), false);
  await leakyPack.close();

  // A throwing release is recorded with its reason, not converted into a clean termination.
  const failingRuntime = createHeadlessRuntime(runtimeOptions(s.controlRoot));
  const failingPack = new InertSessionPack(s.profiles, failingRuntime.sessions); s.packs.push(failingPack);
  failingPack.failure = "inert session release failure";
  failingRuntime.registerSessionReleaser(releaserFor(failingPack));
  const failingHandle = await s.start(failingRuntime, await s.request("session-failure", { hold: true, ignoreTerm: true }));
  const failingReceipt = await failingRuntime.stop(failingHandle, { reason: "cancelled" });
  assert.ok(failingReceipt.verified);
  const failingDurable = await durable(failingRuntime, failingHandle);
  assert.equal(failingDurable.sessionRelease?.state, "failed");
  assert.equal(failingDurable.sessionRelease?.verified, false);
  assert.match(failingDurable.sessionRelease!.releasers[0]!.error!, /inert session release failure/);

  // A release that never returns is bounded: stop() still returns, with the missed bound recorded.
  const hangingRuntime = createHeadlessRuntime(runtimeOptions(s.controlRoot, { sessions: { timeoutMs: 200, totalTimeoutMs: 400 } }));
  const hangingPack = new InertSessionPack(s.profiles, hangingRuntime.sessions); s.packs.push(hangingPack);
  hangingPack.hang = true;
  hangingRuntime.registerSessionReleaser(releaserFor(hangingPack));
  const hangingHandle = await s.start(hangingRuntime, await s.request("session-hang", { hold: true, ignoreTerm: true }));
  const started = Date.now();
  const hangingReceipt = await hangingRuntime.stop(hangingHandle, { reason: "stopped" });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `stop() must not await a hanging release unbounded (took ${elapsed}ms)`);
  assert.ok(hangingReceipt.verified, "a bounded session release never rewrites the termination verdict");
  const hangingDurable = await durable(hangingRuntime, hangingHandle);
  assert.equal(hangingDurable.sessionRelease?.verified, false);
  assert.equal(hangingDurable.sessionRelease?.state, "failed");
  assert.match(hangingDurable.sessionRelease!.releasers[0]!.error!, /deadline exhausted/);
});

// ---------------------------------------------------------------------------------------------
// Fencing: a terminated attempt's session can never be reused by the next attempt of the same task.
// ---------------------------------------------------------------------------------------------
test("a stale session is refused by a second attempt while the second attempt keeps its own lease", async (t) => {
  const s = await setup(t);
  const runtime = createHeadlessRuntime(runtimeOptions(s.controlRoot));
  const pack = new InertSessionPack(s.profiles, runtime.sessions); s.packs.push(pack);
  runtime.registerSessionReleaser(releaserFor(pack));
  const first = await s.start(runtime, await s.request("session-fence-a", { hold: true, ignoreTerm: true }));
  const firstSession = await openSession(pack, first);
  const firstScope = scopeOf(first);
  assert.ok((await runtime.stop(first, { reason: "stopped" })).verified);
  const firstDurable = await durable(runtime, first);
  assert.equal(firstDurable.sessionRelease?.verified, true);
  assert.equal(alivePid(firstSession.pid), false);

  // The next attempt of the same run gets its own attempt id, lease and session.
  const secondRequest = { ...(await s.request("session-fence-b", { hold: true, ignoreTerm: true })), attemptId: "two" };
  const second = await s.start(runtime, secondRequest);
  assert.notEqual(second.attemptId, first.attemptId);
  const secondSession = await openSession(pack, second);
  assert.ok(alivePid(secondSession.pid));

  // Nothing may reach back into the terminated attempt's session: neither its sealed lease nor the pack.
  await assert.rejects(runtime.sessions.assertOpen(firstScope, first.ownerToken), /sealed/);
  await assert.rejects(pack.open(firstScope, second.ownerToken), /another attempt owner/);
  assert.equal(pack.outstanding(firstScope), 0, "no session of the terminated attempt may be resurrected");
  assert.equal((await runtime.sessions.release(firstScope, first.ownerToken, "stopped")).duplicate, true);
  // The second attempt's own session is untouched by all of that.
  assert.ok(alivePid(secondSession.pid));
  assert.equal((await runtime.stop(second, { reason: "stopped" })).verified, true);
  assert.equal(alivePid(secondSession.pid), false);
});
