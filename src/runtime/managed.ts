import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { attemptKey, filesystemHooks } from "./filesystem-hooks.js";
import { dependencies } from "./dependencies.js";
import { cleanEnvironment, controllerGatewayRuntime, paths, validateConfiguration, workerConfig } from "./config.js";
import type { GatewaySpendGate, GatewayTurnCharge, GatewayTurnPermit, GatewayTurnUsage } from "./config.js";
import { atomicJson, atomicWrite, clone, Deadline, digest, errorText, MAX_TIMER_MS, privateDirectory, readBounded, readJson, sessionData, tail, until, within } from "./io.js";
import { alive, ProcessFamily, processIdentity } from "./processes.js";
import { ControllerLease } from "./controller-lease.js";
import { SessionReleaseRegistry } from "./sessions.js";
import { assertModelSpendPrice, dispatchModelRequest, MODEL_SPEND_BASIS, ModelSpendBudget, type ModelSpendDispatch, type ModelSpendTurnCharge, type ModelSpendUsage, type ModelSpendUsageInput } from "../policy/budget.js";
import { PolicyError } from "../policy/errors.js";
import type {
  CheckpointOptions, GuardianJournal, ManagedRuntimeOptions, ModelSpendRuntimeOptions, ObserveOptions, PiReceiptFile, PreflightReceipt,
  ProcessRow, ReconciliationReceipt, RuntimeAdapter, RuntimeCapabilities, RuntimeCheckpoint, RuntimeCollection, RuntimeDependencies,
  RuntimeEvent, RuntimeHandle, RuntimeHooks, RuntimeObservation, RuntimeReceipt, RuntimeRequest, RuntimeSelection,
  ProcessIdentity, RuntimeStatus, SessionReleaseReason, SessionReleaseReceipt, SessionReleaser, SessionScope, SessionSweepReceipt, StopOptions, StopReceipt, WorkerConfig,
} from "./types.js";

export interface Entry {
  h: RuntimeHandle;
  family: ProcessFamily;
  abort: AbortController;
  child?: ChildProcess;
  launch?: Promise<void>;
  stopping?: Promise<StopReceipt>;
  closing: boolean;
  dispatched: boolean;
  recovered: boolean;
  dirty: boolean;
  controlOwned: boolean;
  releasingOwnership?: Promise<void>;
  workspaceReleased?: boolean;
  reconciling?: boolean;
  saving?: Promise<void>;
  persistenceError?: string;
  pollTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  receiptSeq: number;
  refreshing?: Promise<void>;
  assistant?: { stopReason: string; errorMessage?: string };
  settled: boolean;
  rpc?: { request(type: string, fields?: Record<string, unknown>): Promise<Record<string, unknown>>; close(): void };
  /** This attempt's absolute epoch deadline tracked on a monotonic timeline. */
  deadline: Deadline;
  /** Set when the wall clock is behind the durable attempt creation time. */
  clockUnreliable: boolean;
  /** [T3/T8] Supervisor-owned model spend hold for this attempt (identity from supervisor state only). */
  /** [T3/T8/T9] Supervisor-owned model spend hold for this attempt (identity from supervisor state only). */
  spend?: {
    dispatch: ModelSpendDispatch;
    reservationId: string;
    selection: RuntimeSelection;
    /** [T9] Supervisor-declared completion bound for one provider turn; never a worker-supplied number. */
    maxOutputTokens: number;
    /** [T9] Observed-usage catch-up has already been applied once mid-attempt. */
    caughtUp: boolean;
    /** The attempt hold was settled/released; no further charge or release may be attempted. */
    settled: boolean;
  };
  /** [T8/S2] Cumulative legacy receipt usage; only used when Pi's own assistant record is unavailable. */
  /** [T9] Set when the controller gateway refused a provider turn: this attempt is failed, never `completed`. */
  spendRefused?: { at: number; bytes: number; reason: string };
  /**
   * [T10] Set when an admitted turn's charge could not be made durable (R3 §9.3). The worker may have been
   * served, so the attempt is failed and the durable hold is left for restart reconciliation instead of
   * being released as though the turn were free.
   */
  spendChargeFailed?: { at: number; turnId: string; reason: string };
  receiptUsage?: ModelSpendUsage;
}

/** [T9] Supervisor-owned inputs for one attempt's per-turn gateway gate. */
export interface TurnSpendGateOptions {
  ledger: ModelSpendBudget;
  reservationId: string;
  attemptId: string;
  selection: RuntimeSelection;
  maxOutputTokens: number;
  /** Called when the ledger refuses a turn, so the attempt can be recorded as failed for budget reasons. */
  onDenied?: (input: { bytes: number; path: string; reason: string }) => void;
  /** [T10] Called when an admitted turn's charge could not be persisted (fail closed, never attested charged). */
  onChargeFailed?: (input: { turnId: string; reason: string }) => void;
}

/**
 * Supervisor-owned per-turn gate. UTF-8 JSON bytes are a conservative estimation policy, not an exact
 * tokenizer count or universal mathematical token bound. Measured provider usage is authoritative.
 * Admission is synchronous and durable before any upstream bytes are transmitted.
 */
export function createTurnSpendGate(options: TurnSpendGateOptions): GatewaySpendGate {
  return Object.freeze({
    attemptId: options.attemptId,
    maxOutputTokens: options.maxOutputTokens,
    admit(request: { bytes: number; path: string }): GatewayTurnPermit {
      const bytes = Number.isSafeInteger(request.bytes) && request.bytes > 0 ? request.bytes : 1;
      const turn = options.ledger.admitTurn({
        reservationId: options.reservationId,
        attemptId: options.attemptId,
        selection: { ...options.selection },
        inputTokensUpperBound: bytes,
        maxOutputTokens: options.maxOutputTokens,
      });
      let done = false;
      const charge = (result: Readonly<ModelSpendTurnCharge>): GatewayTurnCharge => ({
        turnId: result.turnId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicros: result.costMicros,
        assumed: result.assumed,
        duplicate: result.duplicate,
        exceeded: result.overshoot.tokens > 0 || result.overshoot.costUsd > 0,
      });
      return Object.freeze({
        turnId: turn.turnId,
        settle(usage: GatewayTurnUsage): GatewayTurnCharge {
          if (done) throw new Error("provider turn was already settled");
          // [T10] Only a *returned* charge marks the turn settled; a throwing attempt stays open for `failed`.
          const result = charge(turn.charge({ input: usage.inputTokens, output: usage.outputTokens }));
          done = true;
          if (usage.outputTokens > options.maxOutputTokens || result.inputTokens + result.outputTokens > turn.reservedTokens) {
            options.onDenied?.({ bytes, path: request.path, reason: "Provider measured usage exceeded the admitted wire/token ceiling; extension and reconciliation required" });
          }
          return result;
        },
        unobserved(reason: string): GatewayTurnCharge {
          if (done) throw new Error("provider turn was already settled");
          const result = charge(turn.chargeUnobserved(reason));
          done = true;
          return result;
        },
        abandon(): void { done = true; },
        failed(reason: string): void {
          // The charge threw: the turn is uncharged. Report it once and close the permit.
          // Receipt persistence can fail after a charge succeeded; still report the attempt failure.
          done = true;
          options.onChargeFailed?.({ turnId: turn.turnId, reason });
        },
      });
    },
    ...(options.onDenied ? { denied: (input: { bytes: number; path: string; reason: string }) => options.onDenied!(input) } : {}),
  });
}
const terminal = (s: RuntimeStatus) => ["completed", "failed", "cancelled", "timed-out", "stopped", "quarantined"].includes(s);
/** [B4] Bounded one-line session-release verdict for the attempt's durable event ring. */
function sessionReleaseText(receipt: SessionReleaseReceipt): string {
  const released = receipt.releasers.reduce((sum, result) => sum + (result.released ?? 0), 0);
  const packs = receipt.releasers.map((result) => `${result.name}=${result.outcome}${result.released === undefined ? "" : `:${result.released}`}${result.outstanding === undefined ? "" : ` outstanding=${result.outstanding}`}`).join(" ");
  if (receipt.verified) return `${receipt.reason}: ${packs || "no pack registered"}; ${released} session(s) released within ${receipt.ms}ms${receipt.duplicate ? " (idempotent replay of the durable verdict)" : ""}${receipt.evidenceNote ? `; ${receipt.evidenceNote}` : ""}`;
  const failures = receipt.releasers.filter((result) => result.outcome === "failed").map((result) => `${result.name}: ${result.error ?? "failed"}`).join("; ");
  return `${receipt.reason}: session release NOT verified (state=${receipt.state} outstanding=${receipt.outstanding})${failures ? `: ${failures}` : ""}${receipt.evidenceNote ? `: ${receipt.evidenceNote}` : ""}`;
}
/** [T8/S2] Cumulative legacy receipt usage: every observed turn is charged, never only the first. */
function addSpendUsage(total: ModelSpendUsage | undefined, usage: ModelSpendUsage): ModelSpendUsage {
  const reportedCostUsd = (total?.reportedCostUsd === undefined && usage.reportedCostUsd === undefined)
    ? {} : { reportedCostUsd: (total?.reportedCostUsd ?? 0) + (usage.reportedCostUsd ?? 0) };
  return { inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens, outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens, ...reportedCostUsd };
}

/** [T8/S2] Aggregate every usage-bearing receipt event; a malformed event fails the settlement explicitly. */
function aggregateReceiptUsage(events: readonly { usage?: ModelSpendUsage }[]): ModelSpendUsage | undefined {
  let total: ModelSpendUsage | undefined;
  for (const event of events) if (event.usage) total = addSpendUsage(total, event.usage);
  return total;
}
export abstract class ManagedRuntime implements RuntimeAdapter {
  abstract readonly kind: "headless" | "herdr";
  readonly capabilities: RuntimeCapabilities;
  protected readonly dep: RuntimeDependencies;
  protected readonly hooks: RuntimeHooks;
  protected readonly entries = new Map<string, Entry>();
  private readonly controlLease: ControllerLease;
  /**
   * [B4] Pack-agnostic session ledger: packs register a releaser here and the runtime calls it on every
   * attempt termination path. `sweepStaleSessions` is a restart sweep over leases whose controller died.
   */
  readonly sessions: SessionReleaseRegistry;
  private sessionSweep?: Promise<SessionSweepReceipt>;
  /** This process's own kernel identity for the session sweep, resolved at most once. */
  private ownProcess?: Promise<ProcessIdentity>;
  private spendLedger?: ModelSpendBudget;
  private spendLedgerError?: string;
  /** [T3] Task-specific protected phase ledgers (for example the verifier pool). Absent means `spend`. */
  private readonly taskSpendLedgers = new Map<string, ModelSpendBudget>();
  private readonly taskSpendLedgerErrors = new Map<string, string>();
  readonly limits: Required<NonNullable<ManagedRuntimeOptions["limits"]>>;
  constructor(protected readonly options: ManagedRuntimeOptions) {
    this.dep = dependencies(options.dependencies);
    this.hooks = options.hooks ?? filesystemHooks(options.controlRoot);
    this.controlLease = new ControllerLease(options.controlRoot, this.dep.processes);
    // Session leases live beside the attempt records and are the durable fence for a pack session: a
    // session may only be created, driven or released under an open lease owned by this attempt.
    this.sessions = new SessionReleaseRegistry({ root: path.join(options.controlRoot, "sessions"), probe: this.dep.processes,
      now: this.dep.now, monoNow: this.dep.monoNow ?? (() => performance.now()), ...(options.sessions ? { config: options.sessions } : {}) });
    for (const [name, value] of Object.entries({ startupTimeoutMs: options.startupTimeoutMs ?? 10_000, pollMs: options.pollMs ?? 50, stopGraceMs: options.stopGraceMs ?? 100 })) {
      if (!Number.isSafeInteger(value) || value < (name === "stopGraceMs" ? 0 : 1) || value > 300_000) throw new Error(`Invalid ${name}`);
    }
    this.capabilities = Object.freeze({ ownsLifecycle: true, canHardStop: process.platform === "linux", canResume: true,
      streamsEvents: true, attestsRuntime: true, checkpoints: true, sandboxBoundTools: Boolean(options.verifySandbox) });
    this.limits = { logBytes: 64 * 1024, events: 128, eventBytes: 2048, frameBytes: 256 * 1024, sessionBytes: 16 * 1024 * 1024, ...options.limits };
    for (const [name, limit] of Object.entries(this.limits)) if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1024 * 1024) throw new Error(`Invalid runtime limit ${name}`);
  }
  protected async extraPreflight(_r: RuntimeRequest): Promise<Partial<NonNullable<PreflightReceipt["versions"]>>> { return {}; }
  async preflight(r: RuntimeRequest): Promise<PreflightReceipt> {
    const receipt: PreflightReceipt = { ok: false, kind: this.kind, checkedAt: this.dep.now(), capabilities: this.capabilities, errors: [], warnings: [] };
    // Preflight is preparation too: it must fit inside the same absolute deadline, on the same
    // monotonic timeline as every later phase.
    const clock = new Deadline(r.deadlineAt, this.dep.now, this.dep.monoNow ?? (() => performance.now()));
    try {
      if (r.signal?.aborted || clock.exhausted()) throw new Error("Cancelled or absolute deadline exhausted before preflight");
      // One absolute request deadline bounds preflight; startupTimeoutMs only bounds post-dispatch readiness.
      const end = r.deadlineAt;
      // [T2/T7] The controller-owned gateway is started before any preflight/dispatch work; readiness for
      // the requested selection is part of the preflight receipt. No model is contacted here.
      const boundGateway = controllerGatewayRuntime(this.options.gateway);
      if (boundGateway && !boundGateway.listening) await boundGateway.listen();
      const gatewayReady = boundGateway?.readiness(r.requested);
      if (gatewayReady && !gatewayReady.ok) receipt.errors.push(`Credential-owning gateway is not ready: ${gatewayReady.code}: ${gatewayReady.message}`);
      await until(validateConfiguration(this.options, r), end, () => clock.now(), r.signal);
      await until(privateDirectory(this.options.controlRoot), end, () => clock.now(), r.signal);
      await until(this.dep.processes.snapshot(), end, () => clock.now(), r.signal);
      const env = cleanEnvironment(path.join(this.options.controlRoot, "probe-home"), paths(this.options).node, "", "");
      const result = await until(this.dep.command(this.options.piBinary, ["--version"], { env, deadlineAt: end, signal: r.signal, maxBytes: 4096 }), end, () => clock.now(), r.signal);
      const version = result.stdout.trim().replace(/^pi\s+/, "");
      if (result.code !== 0 || version !== (this.options.piVersion ?? "1.0.0")) throw new Error(`Unsupported Pi version: ${version || result.stderr}`);
      receipt.versions = { pi: version, ...await this.extraPreflight(r) };
      if (r.toolPolicy.mode === "sandbox-extension") {
        const checked = this.options.verifySandbox?.(r.toolPolicy, r);
        if (!checked) throw new Error("Sandbox boundary verifier required");
        receipt.boundaryReceipt = await until(checked, end, () => clock.now(), r.signal);
        if (!receipt.boundaryReceipt) throw new Error("Sandbox boundary not verified");
      } else receipt.warnings.push("Trusted fixture: ordinary host tools (including Bash) are NOT sandboxed");
      // [T8/S1] Fail-closed spend readiness, reported without contacting a model: a plan must exist, cover
      // this selection with a pinned price and be backed by a readable journal. A missing plan is loud (the
      // composition always supplies one for a managed run; a direct runtime caller is told enforcement is off).
      {
        const spend = this.spendOptionsFor(r.taskId);
        if (!spend) {
          receipt.warnings.push("spend enforcement=off: no plan was supplied by the runtime caller (a managed composition always supplies one)");
        } else {
          const key = `${r.requested.provider}/${r.requested.model}`;
          try { assertModelSpendPrice(r.requested, spend.prices); }
          catch (error) { receipt.errors.push(`Model spend plan cannot price ${key}: ${errorText(error)}`); }
          try { spend.journal?.load(r.runId); }
          catch (error) { receipt.errors.push(`Model spend journal is unavailable for run ${r.runId}: ${errorText(error)}`); }
          if (spend.ledger) {
            try { spend.ledger.bindRun(r.runId, spend.limits); spend.ledger.snapshot(); }
            catch (error) { receipt.errors.push(`Shared phase ledger is unavailable: ${errorText(error)}`); }
          }
          receipt.warnings.push(`spend enforcement=on price=${key} limits=maxTokens:${spend.limits.maxTokens} maxCostUsd:${spend.limits.maxCostUsd} inputTokensUpperBound=${spend.inputTokensUpperBound ?? "prompt-bytes"} maxOutputTokens=${spend.maxOutputTokens ?? "min(4096,remaining)"}`);
        }
      }
      receipt.ok = receipt.errors.length === 0;
    } catch (e) { receipt.errors.push(errorText(e)); }
    return receipt;
  }
  protected entry(h: RuntimeHandle, recovered = false): Entry {
    return { h, family: new ProcessFamily(this.dep.processes, [...h.native.processes, ...(h.native.guardian ? [h.native.guardian] : [])]),
      deadline: new Deadline(h.deadlineAt, this.dep.now, this.dep.monoNow ?? (() => performance.now())), clockUnreliable: false,
      abort: new AbortController(), closing: false, dispatched: h.launchIntent, recovered, dirty: false, controlOwned: false, receiptSeq: 0, settled: h.status === "settled" || h.status === "completed" };
  }
  protected assertOpen(e: Entry): void {
    if (e.closing || e.abort.signal.aborted || e.signal?.aborted) throw new Error("Launch cancelled");
    if (e.deadline.exhausted()) throw new Error("Absolute deadline exhausted");
    if (e.clockUnreliable) throw new Error("System clock is behind the durable attempt creation time; refusing to continue under an untrustworthy deadline");
    if (e.persistenceError) throw new Error(e.persistenceError);
  }
  private async control(e: Entry): Promise<void> {
    await e.releasingOwnership;
    if (!e.controlOwned) {
      if (!await this.controlLease.acquire(e.h)) throw new Error("Attempt is fenced by another live supervisor");
      e.controlOwned = true;
    }
  }
  /**
   * Idempotent per-entry ownership release. `stop` and `reconcile` can race on the same entry; releasing
   * the controller/workspace fences twice would make the second `unlink` fail with ENOENT and report a
   * verified termination as unverified, so the first caller claims the release and every later caller is a no-op.
   */
  private async releaseOwnership(e: Entry): Promise<void> {
    if (e.releasingOwnership) return e.releasingOwnership;
    const owned = e.controlOwned; e.controlOwned = false;
    e.releasingOwnership = (async () => {
      if (!e.workspaceReleased) { await this.hooks.release(e.h); e.workspaceReleased = true; }
      if (owned) await this.controlLease.release(e.h);
    })().finally(() => { e.releasingOwnership = undefined; });
    return e.releasingOwnership;
  }
  protected async save(e: Entry): Promise<void> {
    e.dirty = true;
    if (!e.saving) {
      e.saving = (async () => {
        while (e.dirty) {
          e.dirty = false;
          await this.hooks.persistHandle(clone(e.h));
        }
      })().catch((error) => { e.persistenceError = `Runtime persistence failed: ${errorText(error)}`; throw error; }).finally(() => { e.saving = undefined; });
    }
    await e.saving;
  }
  protected event(e: Entry, type: string, text = ""): RuntimeEvent {
    const event = { cursor: e.h.nextCursor++, at: this.dep.now(), type, text: tail(text, this.limits.eventBytes) };
    e.h.events.push(event); e.h.events = e.h.events.slice(-this.limits.events); e.dirty = true;
    return event;
  }

  /**
   * [T3/T8/S1] One supervisor-owned model spend ledger per run, created lazily from the owner-approved
   * limits and bound to the run before its first reservation. A failed creation poisons the runtime so no
   * dispatch can proceed without an enforceable spend bound; a missing plan is a refusal, never a silent
   * unbounded launch.
   */
  private spendOptionsFor(taskId: string | undefined): ModelSpendRuntimeOptions | undefined {
    if (taskId !== undefined) {
      const specific = this.options.spendByTask?.(taskId);
      if (specific) return specific;
    }
    return this.options.spend;
  }

  private createSpendLedger(spend: ModelSpendRuntimeOptions, runId: string): ModelSpendBudget {
    try {
      const ledger = new ModelSpendBudget(
        { maxTokens: spend.limits.maxTokens, maxCostUsd: spend.limits.maxCostUsd },
        {
          runId,
          ...(spend.journal ? { journal: spend.journal } : {}),
          ...(spend.prices ? { prices: spend.prices } : {}),
          ...(spend.maxTurns === undefined ? {} : { maxTurns: spend.maxTurns }),
          ...(spend.selection === undefined ? {} : { selection: spend.selection }),
          ...(spend.freshRun === true ? { freshRun: true } : {}),
        },
      );
      ledger.bindRun(runId, { maxTokens: spend.limits.maxTokens, maxCostUsd: spend.limits.maxCostUsd });
      return ledger;
    } catch (error) {
      throw new Error(`Model spend ledger unavailable: ${errorText(error)}`);
    }
  }

  private ledger(runId: string, taskId?: string): ModelSpendBudget {
    // A composition that runs more than one protected phase on this adapter resolves the attempt's own phase
    // here; a task without a specific plan keeps the single default ledger and the existing failure semantics.
    if (taskId !== undefined) {
      const specific = this.options.spendByTask?.(taskId);
      if (specific) {
        const cached = this.taskSpendLedgers.get(taskId);
        if (cached) { cached.bindRun(runId, specific.limits); return cached; }
        if (specific.ledger) { specific.ledger.bindRun(runId, specific.limits); this.taskSpendLedgers.set(taskId, specific.ledger); return specific.ledger; }
        const priorError = this.taskSpendLedgerErrors.get(taskId);
        if (priorError) throw new Error(priorError);
        try {
          const ledger = this.createSpendLedger(specific, runId);
          this.taskSpendLedgers.set(taskId, ledger);
          return ledger;
        } catch (error) {
          const detail = error instanceof Error ? error.message : errorText(error);
          this.taskSpendLedgerErrors.set(taskId, detail);
          throw new Error(detail);
        }
      }
    }
    const spend = this.options.spend;
    if (!spend) throw new PolicyError('UNAVAILABLE', 'Model spend enforcement is disabled for this runtime; refusing to construct an unbounded ledger');
    if (this.spendLedger) { this.spendLedger.bindRun(runId, spend.limits); return this.spendLedger; }
    if (spend.ledger) { spend.ledger.bindRun(runId, spend.limits); this.spendLedger = spend.ledger; return spend.ledger; }
    if (this.spendLedgerError) throw new Error(this.spendLedgerError);
    try {
      this.spendLedger = this.createSpendLedger(spend, runId);
      return this.spendLedger;
    } catch (error) {
      this.spendLedgerError = error instanceof Error ? error.message : errorText(error);
      throw new Error(this.spendLedgerError);
    }
  }

  /** Pre-request enforcement: reserve the worst case before the worker can issue any provider request. */
  private admitSpend(e: Entry, r: RuntimeRequest): void {
    const spend = this.spendOptionsFor(r.taskId);
    if (!spend) {
      // [T8/S1] Managed compositions always supply a plan. A direct runtime caller that supplies none gets
      // a durable, loud record rather than a silent unbounded run.
      this.event(e, 'spend-enforcement-disabled', 'No model spend plan was supplied; this attempt is not spend-bounded');
      return;
    }
    if (spend.selection && (spend.selection.provider !== r.requested.provider || spend.selection.model !== r.requested.model || spend.selection.thinking !== r.requested.thinking)) throw new PolicyError('IDENTITY_DENIED', 'Requested selection differs from the owner phase allocation');
    const ledger = this.ledger(r.runId, r.taskId);
    const inputTokensUpperBound = spend.inputTokensUpperBound ?? Math.max(1, Buffer.byteLength(r.prompt));
    const modelMaximum = this.options.gateway.models.find(model => model.id === r.requested.model)?.maxTokens;
    const maxOutputTokens = Math.min(spend.maxOutputTokens ?? Math.min(4096, Math.max(1, spend.limits.maxTokens - inputTokensUpperBound)), modelMaximum ?? Number.MAX_SAFE_INTEGER);
    // [T8/S2/T9] One reservation per attempt is the launch envelope: it refuses an unaffordable attempt
    // before dispatch and supplies the durable attempt identity every per-turn admission is charged
    // against. The worker issues the provider traffic, so the per-turn enforcement point is the
    // controller-owned gateway (bound below), which consults this ledger before each request.
    const reservationId = `model-spend-${r.attemptId}`;
    let dispatch: ModelSpendDispatch;
    try {
      dispatch = dispatchModelRequest(ledger, { attemptId: r.attemptId, selection: { ...r.requested }, inputTokensUpperBound, maxOutputTokens, reservationId }, { deferred: true });
    } catch (error) {
      const reason = errorText(error);
      e.h.budgetOutcome = { outcome: error instanceof PolicyError && error.code === 'BUDGET_EXCEEDED' ? 'partial' : 'failed', reason, at: this.dep.now(), extensionRequired: error instanceof PolicyError && error.code === 'BUDGET_EXCEEDED' };
      this.event(e, 'spend-refused', `Launch model reservation refused: ${reason}`);
      throw error;
    }
    const selection = { ...r.requested };
    e.spend = { dispatch, reservationId, selection, maxOutputTokens, caughtUp: false, settled: false };
    // [T9] Bind the per-turn gate at the single egress. From here on every provider request this attempt
    // makes is admitted against the durable ledger (and refused with a stable code) before it is
    // forwarded. The bounds are supervisor-owned; the gate never reads a worker-supplied number.
    const bound = controllerGatewayRuntime(this.options.gateway);
    if (bound) {
      bound.bindSpendGate({ attemptId: r.attemptId, gate: createTurnSpendGate({ ledger, reservationId, attemptId: r.attemptId, selection, maxOutputTokens,
        onDenied: input => {
          // [T9] A refused provider turn means this attempt did not complete under its approved budget: it is
          // recorded durably and classified as failed, never as a successful completion.
          e.spendRefused ??= { at: this.dep.now(), bytes: input.bytes, reason: input.reason };
          e.h.budgetOutcome ??= { outcome: 'partial', reason: input.reason, at: this.dep.now(), extensionRequired: true };
          void this.save(e).catch(error => { e.persistenceError ??= errorText(error); });
          this.event(e, 'spend-refused', `Provider turn refused by the model spend ledger after ${input.bytes} payload bytes: ${input.reason}`);
        },
        // [T10] R3 §9.3: a charge that could not be persisted is never silently treated as charged. The
        // uncharged turn is recorded durably on the attempt, the attempt is failed, and the durable hold
        // stays in place for reconciliation instead of being released as unspent.
        onChargeFailed: input => {
          e.spendChargeFailed ??= { at: this.dep.now(), turnId: input.turnId, reason: input.reason };
          e.h.budgetOutcome = { outcome: 'failed', reason: input.reason, at: this.dep.now(), extensionRequired: false };
          void this.save(e).catch(error => { e.persistenceError ??= errorText(error); });
          this.event(e, 'spend-charge-unpersisted', `Admitted provider turn ${input.turnId} could not be durably charged: ${input.reason}`);
        },
      }) });
    } else {
      e.h.budgetOutcome = { outcome: 'failed', reason: 'Controller-owned gateway is required for wire-bound spend enforcement', at: this.dep.now(), extensionRequired: false };
      dispatch.release('wire-gateway-absent-before-launch');
      e.spend.settled = true;
      throw new PolicyError('UNAVAILABLE', e.h.budgetOutcome.reason);
    }
  }

  /**
   * [T9] Charge the observed usage this attempt has not paid for yet. The gateway already charges each
   * provider turn as it completes; this monotonic catch-up covers a run with no controller gateway and any
   * turn whose provider usage could not be read at the egress. Deltas are taken by the ledger, so no turn
   * can be charged twice.
   */
  private async catchUpSpend(e: Entry, reason: string): Promise<void> {
    const spend = e.spend;
    if (!spend || spend.settled) return;
    let ledger: ModelSpendBudget;
    try { ledger = this.ledger(e.h.runId, e.h.taskId); } catch { return; }
    const receipt = await readJson<PiReceiptFile>(path.join(e.h.controlDir, 'pi-receipt.json'), 128 * 1024);
    const usage = (await this.sessionUsage(e)) ?? aggregateReceiptUsage(receipt?.events ?? []);
    if (!usage) return;
    try {
      ledger.catchUp({ reservationId: spend.reservationId, attemptId: e.h.attemptId, selection: spend.selection, usage, basis: reason });
      const snapshot = ledger.snapshot();
      if (snapshot.overshoot.tokens > 0 || snapshot.overshoot.costUsd > 0 || snapshot.breach.tokens > 0 || snapshot.breach.costUsd > 0) {
        const detail = 'Measured session usage exceeded the admitted run/turn budget; owner extension and reconciliation required';
        e.spendRefused ??= { at: this.dep.now(), bytes: 0, reason: detail };
        e.h.budgetOutcome ??= { outcome: 'partial', reason: detail, at: this.dep.now(), extensionRequired: true };
        if (e.h.status === 'completed') e.h.status = 'failed';
        this.event(e, 'spend-refused', detail);
        await this.save(e);
      }
    } catch (error) {
      e.persistenceError ??= `Model spend catch-up failed: ${errorText(error)}`;
    }
  }

  /**
   * [T9] Terminal spend finalization: charge every observed turn that has not been charged yet (a failed or
   * cancelled attempt is charged for the tokens it really consumed, never released uncharged), then release
   * the remaining hold with the outcome and the number of charged turns as durable evidence. Idempotent.
   */
  private async finalizeSpend(e: Entry, outcome: string): Promise<void> {
    const spend = e.spend;
    if (!spend || spend.settled) return;
    let ledger: ModelSpendBudget;
    try { ledger = this.ledger(e.h.runId, e.h.taskId); } catch { return; }
    try {
      if (e.h.stopReceipt?.verified && e.h.sessionRelease?.verified) {
        const complete = { turns: 0 };
        const usage = await this.sessionUsage(e, complete);
        const active = ledger.exportState().reservations[spend.reservationId];
        if (active) ledger.reconcileTerminal(spend.reservationId, { terminationVerified: true, reference: `runtime-stop:${e.h.attemptId}:${e.h.stopReceipt.at}`, ...(usage ? { usage } : {}), ...(usage && complete.turns === active.admittedTurns ? { completeUsageVerified: true as const } : {}) });
      }
      await this.catchUpSpend(e, MODEL_SPEND_BASIS.sessionCatchUp);
      const charged = ledger.attemptUsage(spend.reservationId, e.h.attemptId);
      const reason = `${outcome}:charged-turns=${charged.turns}${charged.assumedTurns ? `:assumed=${charged.assumedTurns}` : ''}`;
      spend.dispatch.release(reason.slice(0, 128));
      spend.settled = true;
    } catch (error) {
      // A refused release leaves the hold in place for restart reconciliation; it is never silently dropped.
      // [T10] When an admitted turn's charge failed to persist, that is exactly the intended fail-closed end
      // state: the durable hold (persisted at admission) still covers the paid turn, and the restart's
      // reconciliation charges the observed usage before releasing it.
      // [T12] Every refusal is recorded durably, not only the uncharged-turn case: an operator must be able to
      // see why a hold outlived its attempt, and the supervisor consumes this event as a spend truncation.
      const remaining = e.spendChargeFailed
        ? `Uncharged provider turn ${e.spendChargeFailed.turnId} remains on the durable attempt hold for restart reconciliation: ${e.spendChargeFailed.reason}`
        : `The durable attempt hold could not be released with its observed usage charged: ${errorText(error)}`;
      this.event(e, 'spend-reconciliation-required', remaining);
      e.persistenceError ??= `Model spend release failed: ${errorText(error)}`;
      e.h.budgetOutcome = { outcome: 'failed', reason: remaining, at: this.dep.now(), extensionRequired: false };
      if (e.h.status === 'completed') e.h.status = 'failed';
      try { await this.save(e); } catch { /* the entry-level persistence failure is already recorded */ }
    }
  }

  /**
   * [T8] Aggregate the provider-reported usage Pi recorded for this attempt's own assistant turns.
   * Real Pi 1.0.0 persists the `pi-ai` usage shape (`input`/`output`/`cost.total`) on every assistant
   * message of its session; the runtime receipt rings only a legacy spelling. The settlement call site
   * therefore reads Pi's authoritative assistant record. A still-appending final line is skipped and the
   * next poll retries; a present-but-unparseable usage is passed through so the ledger fails explicitly
   * instead of charging zero. A resumed attempt may only be charged for the turns after its checkpoint
   * marker, so inherited history is never double-charged.
   */
  private async sessionUsage(e: Entry, completeness?: { turns: number }): Promise<ModelSpendUsageInput | undefined> {
    let text: string;
    try { text = (await readBounded(e.h.sessionFile, this.limits.sessionBytes)).toString("utf8"); }
    catch { return undefined; }
    if (completeness) completeness.turns = 0;
    const total = { input: 0, output: 0, cost: 0 };
    let costReported = false, found = false;
    const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number.NaN);
    for (const line of text.split("\n")) {
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const entry = parsed as Record<string, unknown>;
      if (entry.type === "custom" && entry.customType === "p2o-runtime-checkpoint") {
        total.input = 0; total.output = 0; total.cost = 0; costReported = false; found = false;
        if (completeness) completeness.turns = 0;
        continue;
      }
      const message = entry.message;
      if (!message || typeof message !== "object" || Array.isArray(message) || (message as { role?: unknown }).role !== "assistant") continue;
      const usage = (message as { usage?: unknown }).usage;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
      const u = usage as Record<string, unknown>;
      const m = message as Record<string, unknown>;
      if (completeness && m.provider === e.h.requested.provider && m.model === e.h.requested.model && !['error', 'aborted'].includes(String(m.stopReason)) && [u.input, u.output, u.cacheRead ?? 0, u.cacheWrite ?? 0].every(v => Number.isSafeInteger(v) && (v as number) >= 0) && number(u.input) + number(u.output) + number(u.cacheRead ?? 0) + number(u.cacheWrite ?? 0) > 0) completeness.turns += 1;
      total.input += number(u.input) + number(u.cacheRead ?? 0) + number(u.cacheWrite ?? 0);
      total.output += number(u.output);
      found = true;
      if (u.cost !== undefined) {
        costReported = true;
        const cost = u.cost && typeof u.cost === "object" && !Array.isArray(u.cost) ? (u.cost as Record<string, unknown>).total : undefined;
        total.cost += number(cost);
      }
    }
    if (!found) return undefined;
    return { input: total.input, output: total.output, ...(costReported ? { cost: { total: total.cost } } : {}) };
  }

  /**
   * [T3/T8/T9] Restart reconciliation: charge the recovered observed usage the attempt has not already
   * paid for, then release the remaining hold with an explicit reason that names what was charged (a hold
   * with no readable usage is released only with that reason recorded, never silently). Per-turn charges
   * the gateway already applied before the restart are durable and are never charged twice.
   */
  private async reconcileSpend(e: Entry): Promise<void> {
    if (!this.spendOptionsFor(e.h.taskId)) return;
    let ledger: ModelSpendBudget;
    try { ledger = this.ledger(e.h.runId, e.h.taskId); } catch { return; }
    const active = ledger.activeReservations().find(reservation => reservation.attemptId === e.h.attemptId);
    if (!active) { if (e.spend) e.spend.settled = true; return; }
    const receipt = await readJson<PiReceiptFile>(path.join(e.h.controlDir, "pi-receipt.json"), 128 * 1024);
    const complete = { turns: 0 };
    const usage = (await this.sessionUsage(e, complete)) ?? aggregateReceiptUsage(receipt?.events ?? []);
    try {
      if (!e.h.sessionRelease?.verified) throw new Error('Terminal spend reconciliation requires verified resource cleanup');
      const state = ledger.exportState().reservations[active.reservationId];
      ledger.reconcileTerminal(active.reservationId, { terminationVerified: true, reference: `runtime-reconcile:${e.h.attemptId}`, ...(usage ? { usage } : {}), ...(usage && state && complete.turns === state.admittedTurns ? { completeUsageVerified: true as const } : {}) });
      const charged = ledger.attemptUsage(active.reservationId, e.h.attemptId);
      const reason = `${usage ? 'reconciled' : 'reconciled-without-usage'}:charged-turns=${charged.turns}`;
      ledger.release(active.reservationId, reason.slice(0, 128));
      if (e.spend) e.spend.settled = true;
    } catch (error) {
      // [T12] R5 case L: this catch used to be empty, so a restart that could not apply the recovered
      // observation looked exactly like a clean reconciliation. Record the failure durably (the supervisor
      // reads `spend-reconciliation-required` as a spend truncation) and leave the hold for the next
      // reconciliation instead of silently dropping provider-paid usage.
      this.event(e, 'spend-reconciliation-required', `Recovered usage for attempt ${e.h.attemptId} could not be charged to the durable model spend hold: ${errorText(error)}`);
      e.persistenceError ??= `Model spend reconciliation failed: ${errorText(error)}`;
      try { await this.save(e); } catch { /* the entry-level persistence failure is already recorded */ }
    }
  }

  /**
   * Run shutdown: stop the controller-owned gateway this runtime is bound to, then close every registered
   * session pack (a graceful controller exit kills the sessions it still holds). Idempotent.
   */
  private shuttingDown?: Promise<void>;
  shutdown(): Promise<void> {
    // A failed shutdown is retryable cleanup, never a cached clean verdict: the registry resets its own
    // hook promise on failure, so a second call must actually re-run the pack close/teardown hooks.
    this.shuttingDown ??= (async () => {
      const gateway = controllerGatewayRuntime(this.options.gateway);
      const results = await Promise.allSettled([...(gateway ? [gateway.close()] : []), this.sessions.shutdown()]);
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new Error(`Runtime shutdown unverified: ${failures.map(result => String(result.reason)).join('; ')}`);
    })().catch((error) => { this.shuttingDown = undefined; throw error; });
    return this.shuttingDown;
  }

  /** Register one pack's session release hook. Refuses a second pack under an already-registered name. */
  registerSessionReleaser(releaser: SessionReleaser): void { this.sessions.register(releaser); }

  /**
   * [B4] Restart sweep of stale session leases, run once per controller instance on the restart path
   * (and available directly to a composition that owns the packs). A lease is stale only when no live
   * process carries its recorded owner identity; a live owner's lease is never touched.
   */
  async sweepStaleSessions(): Promise<SessionSweepReceipt> {
    if (!this.sessionSweep) this.sessionSweep = this.sessions.sweepStale(await this.ownIdentity()).then(receipt => {
      if (!receipt.verified) this.sessionSweep = undefined; // failed recovery is retryable, never cached as clean
      return receipt;
    }).catch((error) => { this.sessionSweep = undefined; throw error; });
    return this.sessionSweep;
  }
  protected async phase(e: Entry, status: RuntimeStatus, text = ""): Promise<void> {
    e.h.status = status;
    const event = this.event(e, status, text);
    await this.save(e);
    await this.hooks.emit(clone(e.h), event);
  }
  protected log(e: Entry, text: string): void {
    const total = Buffer.byteLength(e.h.logTail) + Buffer.byteLength(text);
    const bounded = tail(e.h.logTail + tail(text, this.limits.logBytes), this.limits.logBytes);
    e.h.droppedLogBytes += Math.max(0, total - Buffer.byteLength(bounded));
    e.h.logTail = bounded; e.dirty = true;
  }
  protected selection(e: Entry, source: RuntimeReceipt["source"], event: string, selected: RuntimeSelection | { provider: string; model: string }, at = this.dep.now()): boolean {
    const matches = selected.provider === e.h.requested.provider && selected.model === e.h.requested.model &&
      (!("thinking" in selected) || selected.thinking === e.h.requested.thinking);
    const receipt: RuntimeReceipt = { source, event, at, ...selected, matchesRequest: matches };
    if (!e.h.observed.some((r) => r.source === source && r.event === event && r.at === at && r.provider === receipt.provider && r.model === receipt.model && r.thinking === receipt.thinking)) {
      e.h.observed.push(receipt); e.h.observed = e.h.observed.slice(-64); e.dirty = true;
    }
    return matches;
  }
  protected async launchIntent(e: Entry): Promise<void> {
    this.assertOpen(e);
    e.h.launchIntent = true;
    await this.save(e); // strict durable boundary BEFORE any execution/topology command
    this.assertOpen(e);
  }
  /** [B4] The pack-facing identity of one attempt. Nothing else may own or release its sessions. */
  private scopeOf(e: Entry): SessionScope { return { runId: e.h.runId, taskId: e.h.taskId, attemptId: e.h.attemptId }; }

  /**
   * This controller's own kernel identity (never a bare pid), resolved at most once per process: the
   * control fence has already resolved it for every attempt start, so a session lease costs no extra
   * `/proc` inventory on the dispatch path.
   */
  private ownIdentity(): Promise<ProcessIdentity> {
    const known = this.controlLease.identity();
    if (known) return Promise.resolve(known);
    this.ownProcess ??= (async () => {
      const rows = await this.dep.processes.snapshot();
      const own = rows.find((row) => row.pid === process.pid && alive(row));
      if (!own) throw new Error("Cannot identify the supervisor process for session ownership");
      return processIdentity(own);
    })().catch((error) => { this.ownProcess = undefined; throw error; });
    return this.ownProcess;
  }

  /**
   * [B4] Open the attempt's durable session lease before dispatch. Failure is fail-closed: an attempt
   * that cannot produce a durable lease does not dispatch, because a pack session created without one
   * could neither be fenced against a second attempt nor swept after a controller crash.
   */
  private async leaseSession(h: RuntimeHandle): Promise<void> {
    await this.sessions.open({ runId: h.runId, taskId: h.taskId, attemptId: h.attemptId }, h.ownerToken, await this.ownIdentity());
  }

  /**
   * [B4] Session lifetime is part of attempt lifetime: every pack session of this attempt dies on every
   * termination path (completion, verified stop, deadline expiry, cancellation, quarantine, crash
   * reconciliation). This is bounded, idempotent controller cleanup that is deliberately NOT charged to
   * the attempt's absolute deadline: the worker's execution budget may be over, but its browser/proxy/
   * container session still has to be killed and the release proved. The verdict is durable on the
   * handle and in the event ring, and a release that could not be proved never reads as a clean
   * termination.
   */
  private async releaseSessions(e: Entry, reason: SessionReleaseReason): Promise<SessionReleaseReceipt> {
    let receipt: SessionReleaseReceipt;
    try { receipt = await this.sessions.release(this.scopeOf(e), e.h.ownerToken, reason); }
    catch (error) {
      receipt = { version: 1, scope: this.scopeOf(e), attemptKey: attemptKey(e.h), reason, at: this.dep.now(), state: "failed",
        verified: false, outstanding: 0, duplicate: false, releasers: [], ms: 0,
        evidenceNote: `Session release threw instead of returning a verdict: ${errorText(error)}` };
    }
    e.h.sessionRelease = receipt;
    this.event(e, receipt.verified ? "session-release" : "session-release-failed", sessionReleaseText(receipt));
    return receipt;
  }

  async start(r: RuntimeRequest): Promise<RuntimeHandle> { return this.begin(r); }
  private async begin(r: RuntimeRequest, checkpoint?: RuntimeCheckpoint): Promise<RuntimeHandle> {
    const checked = await this.preflight(r);
    if (!checked.ok) throw new Error(`Runtime preflight failed: ${checked.errors.join("; ")}`);
    // Restart admission is fenced by real registered recovery, not by an empty new pack map.
    // Missing/legacy/unverified resource ownership must be resolved before a new writer can be admitted.
    const clock = new Deadline(r.deadlineAt, this.dep.now, this.dep.monoNow ?? (() => performance.now()));
    const swept = await until(this.sessions.sweepStale(await this.ownIdentity()), r.deadlineAt, () => clock.now(), r.signal);
    if (!swept.verified) throw new Error(`Pack session recovery is unverified; refusing a new attempt: ${swept.entries.filter(entry => entry.state === 'unverifiable').map(entry => entry.error).join('; ')}`);
    const token = randomUUID();
    const controlDir = path.join(this.options.controlRoot, `${attemptKey(r)}-${token}`);
    const h: RuntimeHandle = { version: 1, kind: this.kind, runId: r.runId, taskId: r.taskId, attemptId: r.attemptId,
      ownerToken: token, workspace: r.workspace, scopeDigest: r.scopeDigest, inputDigest: r.inputDigest, deadlineAt: r.deadlineAt,
      requested: clone(r.requested), toolPolicy: clone(r.toolPolicy), createdAt: this.dep.now(), status: "starting", controlDir,
      sessionFile: path.join(controlDir, "session.jsonl"), sessionId: randomUUID(), launchIntent: false,
      native: { processes: [] }, observed: [], events: [], nextCursor: 1, logTail: "", droppedLogBytes: 0,
      ...(checkpoint ? { provenance: { checkpointId: checkpoint.id, parentAttemptId: checkpoint.handle.attemptId,
        parentSessionId: checkpoint.session.id, sessionDigest: checkpoint.session.sha256 } } : {}),
    };
    if (!await this.hooks.claim(clone(h))) throw new Error("Workspace fenced or attempt already exists; reconcile rather than duplicate");
    const e = this.entry(h); e.dispatched = false; e.signal = r.signal;
    const starting = this.event(e, "starting", "Worker preparation queued; execution not yet dispatched");
    try {
      await this.control(e);
      // [B4] The durable session lease is opened before any dispatch: from here on this attempt may own
      // pack sessions, and a controller that dies leaves the record the restart sweep needs.
      await this.leaseSession(h);
      await this.save(e); this.admitSpend(e, r);
    }
    catch (err) {
      // The attempt never dispatched, so no pack session can exist; the seal still happens so the
      // lease cannot be claimed later and a restart sweep does not have to guess.
      await this.releaseSessions(e, "failed").catch(() => {});
      await this.releaseOwnership(e);
      throw err;
    }
    this.entries.set(h.ownerToken, e);
    e.onAbort = () => { void this.stop(h, { reason: "cancelled" }).catch(() => {}); };
    r.signal?.addEventListener("abort", e.onAbort, { once: true });
    this.arm(e);
    const result = clone(h);
    // Only preparation/readiness is in this launch pipeline. No research-completion wait.
    e.launch = (async () => {
      this.assertOpen(e);
      await this.hooks.emit(clone(e.h), starting);
      this.assertOpen(e);
      await mkdir(controlDir, { mode: 0o700 });
      this.assertOpen(e);
      if (checkpoint) {
        const original = await readBounded(checkpoint.session.path, this.limits.sessionBytes);
        if (digest(original) !== checkpoint.session.sha256) throw new Error("Checkpoint changed during replacement");
        const session = sessionData(original);
        session.lines[0] = JSON.stringify({ ...session.header, id: h.sessionId, timestamp: new Date(this.dep.now()).toISOString(),
          cwd: h.workspace, parentSession: checkpoint.session.path, p2oProvenance: h.provenance });
        session.lines.push(JSON.stringify({ type: "custom", id: randomUUID(), parentId: session.leafId, timestamp: new Date(this.dep.now()).toISOString(),
          customType: "p2o-runtime-checkpoint", data: { version: 1, runId: h.runId, taskId: h.taskId, attemptId: h.attemptId,
            scopeDigest: h.scopeDigest, inputDigest: h.inputDigest, deadlineAt: h.deadlineAt, requested: h.requested,
            provenance: h.provenance, restoredToolProcesses: false } }));
        await atomicWrite(h.sessionFile, `${session.lines.join("\n")}\n`);
      } else await atomicJson(h.sessionFile, { type: "session", version: 3, id: h.sessionId, timestamp: new Date(h.createdAt).toISOString(), cwd: h.workspace });
      this.assertOpen(e);
      const config = await workerConfig(h, this.options, this.kind === "headless");
      this.assertOpen(e);
      await this.launch(e, config, r.prompt);
    })();
    void e.launch.catch((error) => { if (!e.closing) void this.fail(e, error); });
    if (r.signal?.aborted) e.onAbort();
    return result;
  }
  protected abstract launch(e: Entry, config: WorkerConfig, prompt: string): Promise<void>;
  protected async closePane(_e: Entry): Promise<void> {}
  protected async fail(e: Entry, error: unknown): Promise<void> {
    if (e.closing || terminal(e.h.status)) return;
    e.h.startupError = errorText(error); this.event(e, "runtime-error", e.h.startupError);
    try { await this.save(e); } catch { /* still terminate; retain fence if persistence is unavailable */ }
    try { await this.stop(e.h, { reason: e.deadline.exhausted() ? "timed-out" : "failed" }); } catch { this.cleanup(e); }
  }
  protected arm(e: Entry): void {
    if (terminal(e.h.status)) return;
    const reserve = Math.max(500, (this.options.stopGraceMs ?? 100) + 500);
    // The reserve is where reporting begins (termination + receipt flush); it must be taken out of
    // the single absolute deadline, never added after it. A deadline beyond the 32-bit timer range
    // is re-armed in chunks: an immediate fire would cancel a long attempt that is still in budget.
    const schedule = (): void => {
      const delay = e.deadline.remaining() - reserve;
      if (delay <= 0) { e.deadlineTimer = setTimeout(() => { void this.stop(e.h, { reason: "timed-out" }).catch(() => {}); }, 0); return; }
      e.deadlineTimer = setTimeout(schedule, Math.min(delay, MAX_TIMER_MS));
    };
    schedule();
    const poll = async () => {
      if (e.closing || terminal(e.h.status)) return;
      try { await this.refresh(e); if (e.dirty) await this.save(e); }
      catch (error) { void this.fail(e, error); return; }
      if (!e.closing && !terminal(e.h.status)) e.pollTimer = setTimeout(() => { void poll(); }, this.options.pollMs ?? 50);
    };
    e.pollTimer = setTimeout(() => { void poll(); }, this.options.pollMs ?? 50);
  }
  protected cleanup(e: Entry): void {
    if (e.pollTimer) clearTimeout(e.pollTimer);
    if (e.deadlineTimer) clearTimeout(e.deadlineTimer);
    if (e.onAbort) e.signal?.removeEventListener("abort", e.onAbort);
    e.rpc?.close();
  }
  protected async refresh(e: Entry): Promise<void> {
    if (e.refreshing) return e.refreshing;
    e.refreshing = this.readReceipts(e).finally(() => { e.refreshing = undefined; });
    await e.refreshing;
  }
  private async readReceipts(e: Entry): Promise<void> {
    const journal = await readJson<GuardianJournal>(path.join(e.h.controlDir, "guardian.json"), 1024 * 1024);
    if (journal) {
      if (journal.token !== e.h.ownerToken) throw new Error("Guardian journal owner mismatch");
      e.h.native.guardian = journal.guardian;
      e.family.add([journal.guardian, ...journal.processes]);
      e.h.native.processes = e.family.identities();
      if (journal.exit) e.h.exit = journal.exit;
      if (journal.error) e.h.startupError = journal.error;
      e.dirty = true;
    }
    const receipt = await readJson<PiReceiptFile>(path.join(e.h.controlDir, "pi-receipt.json"), 128 * 1024);
    if (receipt) {
      if (receipt.token !== e.h.ownerToken || !Array.isArray(receipt.events) || receipt.events.length > 64) throw new Error("Pi receipt owner/shape mismatch");
      if (receipt.error) throw new Error(`Pi startup/tool-policy error: ${receipt.error}`);
      if (receipt.events[0] && receipt.events[0].seq > e.receiptSeq + 1) this.event(e, "pi-event-gap", "Pi receipt ring advanced; earlier events unavailable");
      for (const event of receipt.events) {
        if (event.seq <= e.receiptSeq) continue;
        e.receiptSeq = event.seq;
        if (!event.selection || typeof event.selection.thinking !== "string") throw new Error("Pi event omitted effective thinking/model receipt");
        if (!this.selection(e, "pi-event", event.type, event.selection, event.at)) throw new Error("Observed Pi selection differs from requested runtime");
        this.event(e, `pi:${event.type}`);
        if (event.assistant) {
          if (!this.selection(e, "pi-event", "assistant-response", { provider: event.assistant.provider, model: event.assistant.model }, event.at)) throw new Error("Observed assistant provider/model differs from request");
          e.assistant = event.assistant;
        }
        if (event.type === "agent_start" && !e.closing && !terminal(e.h.status)) e.h.status = "running";
        if (event.type === "agent_settled" && event.idle === true) { e.settled = true; if (!e.closing && !terminal(e.h.status)) e.h.status = "settled"; }
        // [T8/S2] Accumulate every receipt usage event; the attempt settles once, cumulatively, after the
        // agent genuinely settles (see below). A per-event settle would charge only the first turn.
        if (event.usage) e.receiptUsage = addSpendUsage(e.receiptUsage, event.usage);
      }
    }
    // [T9] The gateway charges every provider turn as its response completes. Once Pi reports the agent
    // settled, any observed usage the egress could not charge (no gateway, or an unreadable response) is
    // applied once as a monotonic catch-up; the terminal hold release happens in `stop`/`reconcile`.
    if (e.spend && !e.spend.settled && e.settled && !e.spend.caughtUp) {
      e.spend.caughtUp = true;
      await this.catchUpSpend(e, MODEL_SPEND_BASIS.sessionCatchUp);
    }
    if (journal?.finished && e.controlOwned && !e.reconciling && !e.closing && !terminal(e.h.status)) {
      const live = await e.family.inspect();
      // Guardian may still be flushing its final journal; wait for its actual exit too.
      if (!live.length) {
        // [T9/T10] A provider turn refused by the spend ledger, or an admitted turn whose charge could not be
        // persisted, makes this attempt failed — never completed: the worker could not finish its work under
        // the approved budget, and the paid-but-uncharged turn must not be reported as a clean success.
        const reason = journal.termination?.reason === "timed-out" ? "timed-out" :
          e.h.budgetOutcome || e.spendRefused || e.spendChargeFailed ? "failed" :
          e.settled && e.assistant && !["error", "aborted"].includes(e.assistant.stopReason) && journal.exit?.code === 0 && !journal.error ? "completed" : "failed";
        if (reason === "failed") e.h.startupError ??= e.spendRefused
          ? `Model spend admission refused a provider turn: ${e.spendRefused.reason}`
          : e.spendChargeFailed
            ? `Model spend charge could not be persisted for provider turn ${e.spendChargeFailed.turnId}; the attempt is failed and the durable hold is left for reconciliation: ${e.spendChargeFailed.reason}`
            : e.assistant?.errorMessage ?? "Worker exited without successful settled Pi response";
        void this.stop(e.h, { reason }).catch(() => {});
      }
    }
  }
  protected async owned(h: RuntimeHandle): Promise<Entry> {
    const stored = this.entries.get(h.ownerToken)?.h ?? await this.hooks.loadHandle(h);
    if (!stored || stored.version !== 1 || stored.kind !== this.kind || stored.ownerToken !== h.ownerToken ||
      ["runId", "taskId", "attemptId", "workspace", "scopeDigest", "inputDigest", "deadlineAt", "controlDir", "sessionFile", "sessionId"].some((k) => stored[k as keyof RuntimeHandle] !== h[k as keyof RuntimeHandle])) throw new Error("Unknown or stale runtime handle");
    const expected = path.join(this.options.controlRoot, `${attemptKey(stored)}-${stored.ownerToken}`);
    if (stored.controlDir !== expected || stored.sessionFile !== path.join(expected, "session.jsonl")) throw new Error("Handle paths escaped controller ownership");
    let e = this.entries.get(h.ownerToken);
    if (!e) { e = this.entry(clone(stored), true); this.entries.set(h.ownerToken, e); }
    return e;
  }
  async observe(h: RuntimeHandle, options: ObserveOptions = {}): Promise<RuntimeObservation> {
    const e = await this.owned(h);
    const cursor = options.cursor ?? 0;
    const limit = Math.min(this.limits.events, options.limit ?? this.limits.events);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(options.waitMs ?? 0) || (options.waitMs ?? 0) < 0) throw new Error("Invalid observation page");
    const end = Math.min(e.h.deadlineAt, e.deadline.now() + Math.min(options.waitMs ?? 0, 30_000));
    do {
      try { await this.refresh(e); }
      catch (err) { e.h.startupError ??= errorText(err); if (e.controlOwned && !e.closing) void this.fail(e, err); }
      if (e.h.events.some((v) => v.cursor > cursor) || terminal(e.h.status) || e.deadline.now() >= end) break;
      await this.dep.sleep(Math.min(25, Math.max(0, end - e.deadline.now())));
    } while (e.deadline.now() < end);
    const events = e.h.events.filter((v) => v.cursor > cursor).slice(0, limit);
    return clone({ status: e.h.status, events, cursor: events.at(-1)?.cursor ?? cursor,
      gap: cursor < (e.h.events[0]?.cursor ?? e.h.nextCursor) - 1, requested: e.h.requested, observed: e.h.observed, startupError: e.h.startupError });
  }
  async collect(h: RuntimeHandle): Promise<RuntimeCollection> {
    const e = await this.owned(h);
    try { await this.refresh(e); }
    catch (err) { e.h.startupError ??= errorText(err); if (e.controlOwned && !e.closing) void this.fail(e, err); }
    if (e.dirty && e.controlOwned) {
      try { await this.save(e); } catch (err) { e.h.startupError ??= errorText(err); if (!e.closing) void this.fail(e, err); }
    }
    return clone({ handle: e.h, outcome: e.h.status, logTail: e.h.logTail, droppedLogBytes: e.h.droppedLogBytes,
      requested: e.h.requested, observed: e.h.observed, resultAcceptance: "not-evaluated" });
  }
  async stop(h: RuntimeHandle, options: StopOptions = {}): Promise<StopReceipt> {
    const e = await this.owned(h);
    // A stop in flight owns the attempt until it resolves: the verified receipt is published just
    // before the writer fence is released, so a concurrent caller must await the in-flight stop
    // instead of observing a terminal receipt while the fence is still held.
    if (e.stopping) return e.stopping;
    if (e.h.stopReceipt?.verified && e.h.sessionRelease?.verified) return clone(e.h.stopReceipt);
    const reason = options.reason === "completed" && e.h.budgetOutcome ? "failed" : options.reason ?? "stopped";
    const end = Math.min(e.h.deadlineAt, options.deadlineAt ?? e.h.deadlineAt);
    e.stopping = (async () => {
      // Claim the shared promise BEFORE awaiting controller ownership; two simultaneous stops cannot both enter teardown.
      await this.control(e);
      e.closing = true; e.abort.abort();
      let launchUncertain = false;
      if (e.launch && e.dispatched) {
        try { await until(e.launch, end, () => e.deadline.now()); }
        // A settled (rejected) pipeline is a definite outcome; only a wait that gave up after an
        // actual dispatch leaves native ownership uncertain. `closing` is set before this wait and
        // every dispatch path re-checks `assertOpen`, so a timed-out pipeline that never set
        // `dispatched` cannot dispatch afterwards: that is a verified no-writer termination.
        catch { launchUncertain = e.dispatched && e.deadline.now() >= end; }
      }
      try { await this.refresh(e); } catch (err) { e.h.startupError ??= errorText(err); }
      let paneError: string | undefined;
      try { await this.closePane(e); } catch (err) { paneError = errorText(err); }
      let receipt: StopReceipt;
      if (!e.dispatched && !e.recovered && !launchUncertain) receipt = { reason, at: this.dep.now(), verified: true, survivors: [] };
      else if (e.family.identities().length) receipt = await e.family.terminate({ deadlineAt: end, graceMs: this.options.stopGraceMs ?? 100, reason, now: () => e.deadline.now(), sleep: this.dep.sleep });
      else receipt = { reason, at: this.dep.now(), verified: false, survivors: [], error: "Launch intent exists but native ownership is unaccounted for" };
      if (launchUncertain || paneError) { receipt.verified = false; receipt.error = paneError ?? "Launch pipeline still uncertain"; }
      const status: RuntimeStatus = receipt.verified ? (reason === "checkpoint" ? "stopped" : reason) : "quarantined";
      this.cleanup(e);
      // [B4] Sessions die with the attempt on EVERY termination path, including an unverified stop and a
      // quarantine, and they die BEFORE the terminal verdict is published: no observer can see a terminal
      // attempt whose pack session is still unaccounted for. The release is bounded and idempotent; its
      // verdict (and any failure or surviving session) is durable on the handle and in the event ring,
      // while the process-termination verdict below stays exactly as verified as the family inventory
      // proved it.
      await this.releaseSessions(e, status === "quarantined" ? "quarantined" : reason);
      e.h.stopReceipt = receipt;
      e.h.status = status;
      this.event(e, status, receipt.error ?? "Owned execution termination verified");
      // Flush receipts after the family is verified dead: the worker or watchdog may have written its
      // final durable record between the last poll and termination. Bounded reads; a read failure is
      // recorded instead of replacing the verified termination verdict.
      try { await this.refresh(e); } catch (err) { e.h.startupError ??= errorText(err); }
      // Persist verified termination BEFORE freeing the workspace writer fence.
      await this.save(e);
      await this.hooks.emit(clone(e.h), e.h.events.at(-1)!);
      if (receipt.verified && e.h.sessionRelease?.verified && !e.persistenceError) {
        await this.releaseOwnership(e);
      }
      // [T9] Terminal spend finalization is part of verified termination: consumed tokens are charged (never
      // released uncharged) and the remaining hold is released with the outcome as durable evidence.
      if (terminal(e.h.status)) await this.finalizeSpend(e, `${e.h.status}${receipt.verified ? '' : ':termination-unverified'}`);
      return clone(receipt);
    })().finally(() => { e.stopping = undefined; });
    return e.stopping;
  }
  async checkpoint(h: RuntimeHandle, options: CheckpointOptions = {}): Promise<RuntimeCheckpoint> {
    const stopped = await this.stop(h, { reason: "checkpoint" });
    if (!stopped.verified) throw new Error("Checkpoint blocked: previous writer termination is unverified");
    const e = await this.owned(h);
    if (e.deadline.exhausted()) throw new Error("Checkpoint absolute deadline exhausted");
    if (!e.h.sessionRelease?.verified) throw new Error('Checkpoint blocked: pack session release is unverified');
    const content = await readBounded(e.h.sessionFile, this.limits.sessionBytes);
    const parsed = sessionData(content);
    if (parsed.header.id !== e.h.sessionId || parsed.header.cwd !== e.h.workspace) throw new Error("Session provenance mismatch");
    const sha = digest(content);
    const snapshot = path.join(e.h.controlDir, `checkpoint-${sha}.jsonl`);
    await atomicWrite(snapshot, content);
    const cp: RuntimeCheckpoint = { version: 1, id: randomUUID(), createdAt: this.dep.now(), handle: clone(e.h),
      session: { path: snapshot, sha256: sha, id: e.h.sessionId, bytes: content.length }, termination: stopped, restoredToolProcesses: false };
    await atomicJson(path.join(e.h.controlDir, `checkpoint-${cp.id}.json`), { checkpoint: cp, controllerNote: options.note ? tail(options.note, 4096) : undefined });
    return cp;
  }
  async resume(cp: RuntimeCheckpoint, r: RuntimeRequest): Promise<RuntimeHandle> {
    const e = await this.owned(cp.handle);
    if (!/^[a-f0-9-]{36}$/.test(cp.id)) throw new Error("Invalid checkpoint identity");
    const saved = await readJson<{ checkpoint: RuntimeCheckpoint }>(path.join(e.h.controlDir, `checkpoint-${cp.id}.json`));
    if (!saved || JSON.stringify(saved.checkpoint) !== JSON.stringify(cp) || !cp.termination.verified || !e.h.stopReceipt?.verified) throw new Error("Unknown, altered, or unquiesced checkpoint");
    const reconciled = await this.reconcile(e.h);
    if (reconciled.state !== "terminated") throw new Error("Resume blocked until previous writer is verified terminated");
    if (!reconciled.handle.sessionRelease?.verified) throw new Error('Resume blocked: previous attempt pack session release is unverified');
    if (r.attemptId === e.h.attemptId || r.runId !== e.h.runId || r.taskId !== e.h.taskId || r.workspace !== e.h.workspace ||
      r.scopeDigest !== e.h.scopeDigest || r.inputDigest !== e.h.inputDigest || r.deadlineAt !== e.h.deadlineAt || JSON.stringify(r.toolPolicy) !== JSON.stringify(e.h.toolPolicy)) throw new Error("Replacement must preserve scope/input/tool identity, original deadline, and use a new attempt ID");
    if (e.deadline.exhausted() || r.signal?.aborted) throw new Error("Resume cancelled/deadline exhausted");
    if (e.deadline.behind(e.h.createdAt)) throw new Error("System clock is behind the durable attempt creation time; refusing to resume under an untrustworthy deadline");
    if (!await until(this.hooks.validateResume(cp, r), r.deadlineAt, () => e.deadline.now(), r.signal)) throw new Error("Current authorization/input validation rejected resume");
    if (!within(e.h.controlDir, cp.session.path) || digest(await readBounded(cp.session.path, this.limits.sessionBytes)) !== cp.session.sha256) throw new Error("Checkpoint session digest/path mismatch");
    return this.begin(r, cp);
  }
  /** Adopt processes carrying this attempt's own durable control markers. The watchdog is started with
   *  this attempt's worker.json path and the worker with its session file, so a crashed controller can
   *  re-find exactly the execution it owns - never a bare PID and never another attempt's process. */
  private adoptUnaccounted(e: Entry, rows: ProcessRow[]): void {
    const configPath = path.join(e.h.controlDir, "worker.json");
    const guardians = rows.filter((p) => p.argv.includes(configPath) && p.argv.includes(paths(this.options).guardian));
    if (guardians.length > 1) throw new Error("Duplicate native guardians for one launch intent");
    const workers = rows.filter((p) => p.argv.includes(e.h.sessionFile));
    const adopted = [...guardians, ...workers].filter((p, index, all) => all.findIndex((q) => q.pid === p.pid) === index);
    if (!adopted.length) return;
    e.family.add(adopted);
    if (!e.h.native.guardian && guardians[0]) e.h.native.guardian = processIdentity(guardians[0]);
    e.h.native.processes = e.family.identities();
    this.event(e, "ownership-recovered", `Adopted ${adopted.length} unaccounted process(es) carrying this attempt's durable control markers`);
    e.dirty = true;
  }
  async reconcile(h: RuntimeHandle): Promise<ReconciliationReceipt> {
    const e = await this.owned(h);
    try {
      await this.control(e);
      e.reconciling = true;
      // [B4] Restart sweep: a controller that died holding pack sessions leaves their leases behind. Once
      // per controller instance, before this attempt is reconciled, every lease whose recorded owner
      // identity is no longer alive is released through the registered packs (or durably reported as
      // unsweepable). A live owner's lease is never touched.
      await this.sweepStaleSessions().catch((error) => { this.event(e, "session-sweep-failed", `Stale session sweep could not run: ${errorText(error)}`); });
      await this.refresh(e);
      // The previous controller may have died between durable intent and capturing native identity, or
      // after the watchdog died without journaling its child. Adopt exactly the processes that carry
      // this attempt's own durable control markers; absence of a known PID is never treated as absence
      // of a writer while such a process is still alive.
      const rows = await this.dep.processes.snapshot();
      this.adoptUnaccounted(e, rows);
      const live = await e.family.inspect(rows);
      if (e.deadline.behind(e.h.createdAt)) {
        // The wall clock is behind the durable creation time: the remaining budget is unknowable.
        // Terminate what this attempt owns instead of letting it run on a possibly expired deadline.
        e.clockUnreliable = true;
        if (live.length) {
          const stopped = await this.stop(e.h, { reason: "stopped" });
          return { state: stopped.verified ? "terminated" : "quarantined", handle: clone(e.h),
            explanation: "System clock is behind the attempt creation time; owned execution terminated without trusting the original deadline" };
        }
      }
      if (live.length) {
        if (e.deadline.exhausted() || e.h.stopReceipt || e.h.status === "quarantined") {
          const stopped = await this.stop(e.h, { reason: e.deadline.exhausted() ? "timed-out" : "stopped" });
          return { state: stopped.verified ? "terminated" : "quarantined", handle: clone(e.h), explanation: "Reconciled owned processes under original deadline" };
        }
        if (e.recovered && !e.deadlineTimer) this.arm(e);
        await this.save(e);
        return { state: "live", handle: clone(e.h), explanation: "Native PID/start-time/boot identity reconciled; no prompt was replayed" };
      }
      if (!e.h.launchIntent || e.family.identities().length || e.h.stopReceipt?.verified) {
        if (!e.h.stopReceipt?.verified) {
          const journal = await readJson<GuardianJournal>(path.join(e.h.controlDir, "guardian.json"));
          const reason = e.deadline.exhausted() || journal?.termination?.reason === "timed-out" ? "timed-out" :
            e.settled && e.assistant && !["error", "aborted"].includes(e.assistant.stopReason) && journal?.exit?.code === 0 && !journal.error ? "completed" : "failed";
          e.h.stopReceipt = { reason, at: this.dep.now(), verified: true, survivors: [] };
          e.h.status = reason;
          if (reason === "failed") e.h.startupError ??= "Controller restarted; no successful settled outcome established";
        }
        this.cleanup(e);
        // [B4] Crash reconciliation is a termination path: a restarted controller releases this attempt's
        // sessions under the crash-recovery reason (an already released lease replays its own durable
        // verdict instead of relabelling it). A previously verified release kills nothing again.
        await this.releaseSessions(e, "crash-recovery");
        await this.save(e);
        await this.reconcileSpend(e);
        if (!e.h.sessionRelease?.verified) return { state: 'quarantined', handle: clone(e.h), explanation: 'Owned execution is absent, but pack resource release is unverified; workspace fence retained' };
        await this.releaseOwnership(e);
        return { state: "terminated", handle: clone(e.h), explanation: "All identified owned execution and pack resources are absent; workspace fence released" };
      }
      throw new Error("Persisted launch intent has no verifiable native identity; refusing duplicate writer");
    } catch (err) {
      if (e.controlOwned) {
        e.h.status = "quarantined"; this.event(e, "quarantined", errorText(err)); this.cleanup(e);
        // A quarantined attempt is over for session purposes: nothing may keep using its pack sessions, and
        // the release verdict (including a failure) is durable before the receipt is returned.
        await this.releaseSessions(e, "quarantined");
        await this.save(e);
      }
      return { state: "quarantined", handle: clone(e.h), explanation: errorText(err) };
    } finally { e.reconciling = false; }
  }
}
