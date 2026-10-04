import path from "node:path";
import { ManagedRuntime, type Entry } from "./managed.js";
import { cleanEnvironment, paths, shellQuote, taskPrompt } from "./config.js";
import { Deadline, readJson, until } from "./io.js";
import { alive, sameProcess } from "./processes.js";
import type { HerdrRuntimeOptions, PiReceiptFile, RuntimeRequest, WorkerConfig } from "./types.js";

class HerdrError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const topology = new Map<string, Promise<void>>();
async function topologyOperation<T>(key: string, work: () => Promise<T>): Promise<T> {
  const old = topology.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const queued = old.catch(() => {}).then(() => next);
  topology.set(key, queued);
  await old.catch(() => {});
  try { return await work(); }
  finally { release(); if (topology.get(key) === queued) topology.delete(key); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Herdr response object");
  return value as Record<string, unknown>;
}
export class HerdrRuntimeAdapter extends ManagedRuntime {
  readonly kind = "herdr" as const;
  constructor(protected readonly herdr: HerdrRuntimeOptions) { super(herdr); }
  private env(): Record<string, string> {
    return { ...cleanEnvironment(path.join(this.options.controlRoot, "herdr-cli-home"), paths(this.options).node, "", ""), ...this.herdr.context };
  }
  private async cli(args: string[], deadlineAt: number, signal?: AbortSignal, now: () => number = this.dep.now): Promise<Record<string, unknown>> {
    const result = await until(this.dep.command(this.herdr.herdrBinary, args, { env: this.env(), deadlineAt, signal, maxBytes: 1024 * 1024 }), deadlineAt, now, signal);
    let parsed: Record<string, unknown>;
    try { parsed = object(JSON.parse(result.stdout || result.stderr)); }
    catch { throw new Error(`Invalid Herdr JSON envelope (exit ${result.code})`); }
    if (parsed.error) { const error = object(parsed.error); throw new HerdrError(String(error.code), String(error.message)); }
    if (result.code !== 0 || typeof parsed.id !== "string") throw new Error("Herdr command failed or missing envelope ID");
    return object(parsed.result);
  }
  protected override async extraPreflight(r: RuntimeRequest): Promise<{ herdr: string; protocol: number }> {
    if (!path.isAbsolute(this.herdr.herdrBinary) || !this.herdr.parentPaneId || this.herdr.context.HERDR_ENV !== "1" ||
      !path.isAbsolute(this.herdr.context.HERDR_SOCKET_PATH) || this.herdr.context.HERDR_PANE_ID !== this.herdr.parentPaneId ||
      Object.keys(this.herdr.context).some((k) => !["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"].includes(k))) throw new Error("Explicit local Herdr caller/socket context required; no focused-session fallback or ambient environment");
    const clock = new Deadline(r.deadlineAt, this.dep.now, this.dep.monoNow ?? (() => performance.now()));
    const end = Math.min(r.deadlineAt, clock.now() + (this.options.startupTimeoutMs ?? 10_000));
    const version = await this.dep.command(this.herdr.herdrBinary, ["--version"], { env: this.env(), deadlineAt: end, signal: r.signal, maxBytes: 4096 });
    const installed = version.stdout.trim().replace(/^herdr\s+/, "");
    if (version.code !== 0 || installed !== (this.herdr.herdrVersion ?? "0.9.0")) throw new Error(`Unsupported Herdr version: ${installed}`);
    const schemaResult = await this.dep.command(this.herdr.herdrBinary, ["api", "schema", "--json"], { env: this.env(), deadlineAt: end, signal: r.signal, maxBytes: 1024 * 1024 });
    const schema = object(JSON.parse(schemaResult.stdout));
    if (schemaResult.code !== 0 || schema.protocol !== 22 || schema.schema_version !== 1 || !schema.schemas) throw new Error("Unsupported Herdr API schema/protocol");
    return { herdr: installed, protocol: 22 };
  }
  protected async launch(e: Entry, config: WorkerConfig, prompt: string): Promise<void> {
    await this.launchIntent(e);
    // Only topology creation and durable ownership publication are serialized.
    await topologyOperation(this.herdr.context.HERDR_SOCKET_PATH, async () => {
      this.assertOpen(e); e.dispatched = true;
      const split = await this.cli(["pane", "split", "--pane", this.herdr.parentPaneId, "--direction", "right", "--no-focus", "--cwd", e.h.workspace], e.h.deadlineAt, e.abort.signal);
      const pane = object(split.pane);
      if (typeof pane.pane_id !== "string" || typeof pane.terminal_id !== "string") throw new Error("Herdr split returned no native pane/terminal identity");
      e.h.native.paneId = pane.pane_id; e.h.native.paneTerminalId = pane.terminal_id;
      e.h.native.agentName = `p2o-${e.h.ownerToken.replaceAll("-", "").slice(0, 24)}`;
      await this.save(e);
    });
    this.assertOpen(e);
    const paneId = e.h.native.paneId!;
    const info = object((await this.cli(["pane", "process-info", "--pane", paneId], e.h.deadlineAt, e.abort.signal)).process_info);
    if (info.pane_id !== paneId || typeof info.shell_pid !== "number") throw new Error("Cannot identify owned Herdr shell");
    const shell = (await this.dep.processes.snapshot()).find((p) => p.pid === info.shell_pid);
    if (!shell) throw new Error("Herdr shell kernel identity unavailable");
    e.family.add([shell]); e.h.native.processes = e.family.identities(); await this.save(e);
    this.assertOpen(e);
    // agent start's canonical executable cannot enforce env erasure. Public pane run executes an
    // explicit absolute launcher; Pi is subsequently identified/renamed through the public agent API.
    const command = ["exec", "/usr/bin/env", "-i", ...Object.entries(config.env).map(([k, v]) => `${k}=${v}`),
      paths(this.options).node, paths(this.options).guardian, path.join(e.h.controlDir, "worker.json")]
      .map((v, i) => i === 0 ? v : shellQuote(v)).join(" ");
    await this.cli(["pane", "run", paneId, command], e.h.deadlineAt, e.abort.signal);
    const end = Math.min(e.h.deadlineAt, e.deadline.now() + (this.options.startupTimeoutMs ?? 10_000));
    let ready = false;
    while (e.deadline.now() < end) {
      this.assertOpen(e); await this.refresh(e);
      const receipt = await readJson<PiReceiptFile>(config.receiptFile, 128 * 1024);
      if (receipt?.ready && receipt.token === e.h.ownerToken) { ready = true; break; }
      await this.dep.sleep(Math.min(25, Math.max(1, end - e.deadline.now())));
    }
    if (!ready || !e.h.native.guardian) throw new Error("Herdr Pi startup/ownership receipt timeout");
    this.assertOpen(e);
    // TUI state is only readiness/status evidence, never model attestation.
    let agent: Record<string, unknown> | undefined;
    while (e.deadline.now() < end) {
      this.assertOpen(e);
      try { agent = object((await this.cli(["agent", "get", paneId], end, e.abort.signal, () => e.deadline.now())).agent); }
      catch (err) { if (!(err instanceof HerdrError) || err.code !== "agent_not_found") throw err; }
      if (agent?.pane_id === paneId && agent.agent === "pi" && agent.interactive_ready === true && ["idle", "done"].includes(String(agent.agent_status))) break;
      agent = undefined; await this.dep.sleep(25);
    }
    if (!agent || agent.terminal_id !== e.h.native.paneTerminalId) throw new Error("Herdr detected agent/native pane readiness mismatch");
    await this.cli(["agent", "rename", paneId, e.h.native.agentName!], end, e.abort.signal);
    await this.phase(e, "ready", "Pi event selection/tool-policy verified; owned Herdr agent ready");
    this.assertOpen(e);
    // NEVER --wait: independent tasks must actually overlap.
    await this.cli(["agent", "prompt", paneId, taskPrompt(prompt)], e.h.deadlineAt, e.abort.signal);
    this.event(e, "prompt-delivered", "Herdr wrote prompt and Enter; working requires a Pi agent_start event");
    if (e.h.status === "ready") e.h.status = "prompt-delivered";
    await this.save(e);
  }
  protected override async closePane(e: Entry): Promise<void> {
    if (!e.h.native.paneId) return;
    const id = e.h.native.paneId;
    let info: Record<string, unknown>;
    try { info = object((await this.cli(["pane", "process-info", "--pane", id], e.h.deadlineAt)).process_info); }
    catch (err) { if (err instanceof HerdrError && err.code === "pane_not_found") return; throw err; }
    const pids = [info.shell_pid, ...(Array.isArray(info.foreground_processes) ? info.foreground_processes.map((p) => object(p).pid) : [])];
    const rows = await this.dep.processes.snapshot();
    const known = e.family.identities();
    if (!rows.some((p) => alive(p) && pids.includes(p.pid) && known.some((q) => sameProcess(p, q)))) throw new Error("Owned Herdr pane now has an unrecognized occupant; refusing to close it");
    await topologyOperation(this.herdr.context.HERDR_SOCKET_PATH, async () => {
      await this.cli(["pane", "close", id], e.h.deadlineAt);
    });
    // Success of pane close alone is NEVER sufficient: ManagedRuntime independently kills/verifies
    // process groups and known detached/reparented descendants before releasing the writer fence.
  }
}
export function createHerdrRuntime(options: HerdrRuntimeOptions): HerdrRuntimeAdapter { return new HerdrRuntimeAdapter(options); }
