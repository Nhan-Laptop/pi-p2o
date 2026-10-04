import { randomUUID } from "node:crypto";
import { clone } from "./io.js";
import { validateRequest } from "./config.js";
import type { RuntimeAdapter, RuntimeCapabilities, RuntimeHandle, RuntimeRequest, ObserveOptions, PreflightReceipt, RuntimeObservation, RuntimeCollection, ReconciliationReceipt, RuntimeCheckpoint, StopReceipt } from "./types.js";

export class RuntimeCapabilityError extends Error {}
export interface PlanRuntimeOptions {
  role?: string;
  persistHandle?: (handle: RuntimeHandle) => Promise<void>;
  loadHandle?: (handle: RuntimeHandle) => Promise<RuntimeHandle | undefined>;
  now?: () => number;
}
/** A dispatch suggestion, never a lifecycle owner or a security boundary. */
export class PlanRuntimeAdapter implements RuntimeAdapter {
  readonly kind = "plan" as const;
  readonly capabilities: RuntimeCapabilities = Object.freeze({ ownsLifecycle: false, canHardStop: false, canResume: false,
    streamsEvents: false, attestsRuntime: false, checkpoints: false, sandboxBoundTools: false });
  private readonly handles = new Map<string, RuntimeHandle>();
  constructor(private readonly options: PlanRuntimeOptions = {}) {}
  async preflight(r: RuntimeRequest): Promise<PreflightReceipt> {
    const receipt: PreflightReceipt = { ok: true, kind: this.kind, checkedAt: (this.options.now ?? Date.now)(), capabilities: this.capabilities,
      errors: [], warnings: ["UNMANAGED: no ownership, fencing, deadlines, environment/tool isolation, observation, stop, resume, or runtime attestation; parent must supply these independently"] };
    try { validateRequest(r); if (r.signal?.aborted || r.deadlineAt <= receipt.checkedAt) throw new Error("Plan cancelled/deadline exhausted"); }
    catch (e) { receipt.ok = false; receipt.errors.push(String(e)); }
    return receipt;
  }
  async start(r: RuntimeRequest): Promise<RuntimeHandle> {
    const receipt = await this.preflight(r);
    if (!receipt.ok) throw new Error(receipt.errors.join("; "));
    const now = (this.options.now ?? Date.now)();
    const handle: RuntimeHandle = { version: 1, kind: "plan", runId: r.runId, taskId: r.taskId, attemptId: r.attemptId,
      ownerToken: randomUUID(), workspace: r.workspace, scopeDigest: r.scopeDigest, inputDigest: r.inputDigest,
      deadlineAt: r.deadlineAt, requested: clone(r.requested), toolPolicy: clone(r.toolPolicy), createdAt: now,
      status: "unmanaged", controlDir: "", sessionFile: "", sessionId: "", launchIntent: false,
      native: { processes: [] }, observed: [], events: [{ cursor: 1, at: now, type: "unmanaged-plan", text: receipt.warnings[0]! }], nextCursor: 2, logTail: "", droppedLogBytes: 0,
      plan: { tool: "herd_spawn", arguments: { role: this.options.role ?? "worker",
        model: `${r.requested.provider}/${r.requested.model}:${r.requested.thinking}`,
        task: `UNMANAGED dispatch proposal. This call supplies NO security or lifecycle guarantees. The parent must independently authorize and constrain execution.\nWorkspace: ${r.workspace}\nRun/task/attempt: ${r.runId}/${r.taskId}/${r.attemptId}\nAbsolute deadline (not enforced here): ${r.deadlineAt}\n\n${r.prompt}` }, guarantees: "unmanaged" },
    };
    await this.options.persistHandle?.(clone(handle));
    this.handles.set(handle.ownerToken, handle);
    return clone(handle);
  }
  private async owned(h: RuntimeHandle): Promise<RuntimeHandle> {
    const stored = this.handles.get(h.ownerToken) ?? await this.options.loadHandle?.(h);
    if (!stored || stored.ownerToken !== h.ownerToken || stored.kind !== "plan" || stored.runId !== h.runId || stored.taskId !== h.taskId || stored.attemptId !== h.attemptId) throw new Error("Unknown unmanaged plan handle");
    return stored;
  }
  async observe(h: RuntimeHandle, options: ObserveOptions = {}): Promise<RuntimeObservation> {
    const stored = await this.owned(h);
    const events = stored.events.filter((e) => e.cursor > (options.cursor ?? 0)).slice(0, options.limit ?? 1);
    return clone({ status: "unmanaged", events, cursor: events.at(-1)?.cursor ?? options.cursor ?? 0, gap: false, requested: stored.requested, observed: [] });
  }
  async collect(h: RuntimeHandle): Promise<RuntimeCollection> {
    const stored = await this.owned(h);
    return clone({ handle: stored, outcome: "unmanaged", logTail: "", droppedLogBytes: 0, requested: stored.requested, observed: [], resultAcceptance: "not-evaluated" });
  }
  async reconcile(h: RuntimeHandle): Promise<ReconciliationReceipt> {
    return { state: "unmanaged", handle: clone(await this.owned(h)), explanation: "Runtime did not launch or own a worker; no reconciliation/termination claim is possible" };
  }
  async stop(_h: RuntimeHandle): Promise<StopReceipt> { throw new RuntimeCapabilityError("Plan adapter cannot stop unmanaged workers"); }
  async checkpoint(_h: RuntimeHandle): Promise<RuntimeCheckpoint> { throw new RuntimeCapabilityError("Plan adapter has no owned checkpoint capability"); }
  async resume(_cp: RuntimeCheckpoint, _r: RuntimeRequest): Promise<RuntimeHandle> { throw new RuntimeCapabilityError("Plan adapter cannot resume or replace unmanaged workers"); }
}
export function createPlanRuntime(options: PlanRuntimeOptions = {}): PlanRuntimeAdapter { return new PlanRuntimeAdapter(options); }
