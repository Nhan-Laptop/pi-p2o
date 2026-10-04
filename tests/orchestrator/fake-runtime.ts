import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  ProcessIdentity, RuntimeAdapter, RuntimeCapabilities, RuntimeCheckpoint, RuntimeCollection,
  RuntimeEvent, RuntimeHandle, RuntimeHooks, RuntimeObservation, RuntimeReceipt, RuntimeRequest,
  RuntimeStatus, StopReceipt,
} from '../../src/runtime/types.js';
import type { ResultCandidate } from '../../src/orchestrator/index.js';

export interface FakeAttempt {
  attemptId: string;
  taskId: string;
  handle: RuntimeHandle;
  startedAt: number;
  step: number;
  status: RuntimeStatus;
  stopReceipt?: StopReceipt;
  exit?: { code: number | null; signal?: string };
  resumedFrom?: string;
  checkpoint?: RuntimeCheckpoint;
  cursor: number;
}

export interface FakeStep {
  at: number;
  status: RuntimeStatus;
  exit?: { code: number | null; signal?: string };
  /** [T10] Extra runtime event emitted when this step fires (e.g. a spend refusal recorded by the runtime). */
  event?: string;
  eventText?: string;
  /** [T10] Startup/failure text the handle carries from this step on (e.g. a model-spend refusal). */
  startupError?: string;
}

export interface FakeRuntimeOptions {
  now: () => number;
  controlRoot?: string;
  steps?: FakeStep[];
  preflight?: { ok: boolean; errors?: string[]; warnings?: string[] };
  capabilities?: Partial<RuntimeCapabilities>;
  /** Emits a runtime receipt that does NOT match the request (substitution probe). */
  substitute?: { provider?: string; model?: string; thinking?: RuntimeReceipt['thinking'] };
  /** When false, stop() reports unverified termination and keeps ownership. */
  stopVerified?: boolean;
  reconcileState?: (attempt: FakeAttempt) => 'live' | 'terminated' | 'quarantined';
  collect?: (handle: RuntimeHandle) => ResultCandidate[];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const identityFor = (attemptId: string): ProcessIdentity => {
  const hash = parseInt(digest(attemptId).slice(0, 6), 16);
  return { pid: 4000 + (hash % 9000), ppid: 1, pgid: 4000 + (hash % 9000), startTicks: String(100_000 + (hash % 900)), bootId: 'boot-1', state: 'S' };
};

/** Deterministic inert runtime: no processes, no timers, no target traffic. */
export class FakeRuntime implements RuntimeAdapter {
  readonly kind = 'headless' as const;
  readonly capabilities: RuntimeCapabilities;
  hooks?: RuntimeHooks;
  readonly attempts = new Map<string, FakeAttempt>();
  readonly starts: string[] = [];
  readonly stops: Array<{ attemptId: string; reason: StopReceipt['reason']; verified: boolean }> = [];
  readonly checkpoints: string[] = [];
  readonly resumes: string[] = [];
  readonly reconciles: string[] = [];
  maxConcurrent = 0;
  collectCalls = 0;
  /** Mutable so tests can simulate a runtime that later stops terminating cleanly. */
  constructor(readonly options: FakeRuntimeOptions) {
    this.capabilities = Object.freeze({
      ownsLifecycle: true, canHardStop: true, canResume: true, streamsEvents: true, attestsRuntime: true,
      checkpoints: true, sandboxBoundTools: false, ...options.capabilities,
    });
  }

  private now(): number { return this.options.now(); }
  private steps(): FakeStep[] { return this.options.steps ?? [{ at: 0, status: 'running' }]; }
  /** Adopts a persisted controller handle after a controller restart (recovery path). */
  private adopt(handle: RuntimeHandle): FakeAttempt {
    const existing = this.attempts.get(handle.attemptId);
    if (existing) return existing;
    const status: RuntimeStatus = handle.status === 'starting' || handle.status === 'ready' ? 'running' : handle.status;
    const attempt: FakeAttempt = {
      attemptId: handle.attemptId, taskId: handle.taskId, handle: clone(handle), startedAt: this.now(),
      step: this.steps().length, status, cursor: handle.nextCursor ?? 1,
    };
    attempt.handle.status = status;
    this.attempts.set(handle.attemptId, attempt);
    this.maxConcurrent = Math.max(this.maxConcurrent, this.runningCount());
    return attempt;
  }
  private runningCount(): number {
    return [...this.attempts.values()].filter(attempt => ['starting', 'ready', 'prompt-delivered', 'running', 'settled'].includes(attempt.status)).length;
  }
  private receipt(attempt: FakeAttempt, source: RuntimeReceipt['source'] = 'rpc-state'): RuntimeReceipt {
    const requested = attempt.handle.requested;
    const substituted = this.options.substitute;
    const selected = substituted
      ? { provider: substituted.provider ?? requested.provider, model: substituted.model ?? requested.model, thinking: substituted.thinking ?? requested.thinking }
      : { ...requested };
    return {
      source, event: 'fixture-state', at: this.now(), provider: selected.provider, model: selected.model,
      thinking: selected.thinking, matchesRequest: selected.provider === requested.provider && selected.model === requested.model && selected.thinking === requested.thinking,
    };
  }
  private async persist(attempt: FakeAttempt): Promise<void> {
    if (attempt.handle.status !== attempt.status) attempt.handle.status = attempt.status;
    if (!attempt.handle.observed.length) attempt.handle.observed.push(this.receipt(attempt));
    await this.hooks?.persistHandle(clone(attempt.handle));
  }
  private event(attempt: FakeAttempt, type: string, text = ''): RuntimeEvent {
    const event: RuntimeEvent = { cursor: attempt.cursor++, at: this.now(), type, text };
    // [T10] The real runtime keeps its events on the handle and returns them from observe(), so the fake does too.
    attempt.handle.events.push(event);
    if (attempt.handle.events.length > 64) attempt.handle.events = attempt.handle.events.slice(-64);
    return event;
  }
  private async advance(attempt: FakeAttempt): Promise<void> {
    const elapsed = this.now() - attempt.startedAt;
    const steps = this.steps();
    let changed = false;
    while (attempt.step < steps.length && steps[attempt.step].at <= elapsed) {
      const step = steps[attempt.step];
      attempt.status = step.status;
      if (step.exit) attempt.exit = step.exit;
      if (step.startupError) attempt.handle.startupError = step.startupError;
      attempt.step += 1;
      changed = true;
      // A step may carry an extra durable event (e.g. a spend refusal) emitted before its status event.
      if (step.event) await this.hooks?.emit(clone(attempt.handle), this.event(attempt, step.event, step.eventText ?? ''));
      await this.hooks?.emit(clone(attempt.handle), this.event(attempt, step.status));
    }
    if (changed) {
      await this.persist(attempt);
      this.maxConcurrent = Math.max(this.maxConcurrent, this.runningCount());
    }
  }
  private async makeHandle(request: RuntimeRequest, launchIntent: boolean): Promise<RuntimeHandle> {
    const controlDir = join(this.options.controlRoot ?? '/tmp/p2o-fake', `${request.attemptId}-${randomUUID()}`);
    return {
      version: 1, kind: this.kind, runId: request.runId, taskId: request.taskId, attemptId: request.attemptId,
      ownerToken: randomUUID(), workspace: request.workspace, scopeDigest: request.scopeDigest,
      inputDigest: request.inputDigest, deadlineAt: request.deadlineAt, requested: clone(request.requested),
      toolPolicy: clone(request.toolPolicy), createdAt: this.now(), status: 'starting', controlDir,
      sessionFile: join(controlDir, 'session.jsonl'), sessionId: randomUUID(), launchIntent,
      native: { processes: [identityFor(request.attemptId)] }, observed: [this.receipt({ handle: { requested: request.requested } } as FakeAttempt)],
      events: [], nextCursor: 1, logTail: '', droppedLogBytes: 0,
    };
  }

  async preflight(_request: RuntimeRequest): Promise<import('../../src/runtime/types.js').PreflightReceipt> {
    const outcome = this.options.preflight ?? { ok: true };
    return {
      ok: outcome.ok, kind: this.kind, checkedAt: this.now(), capabilities: this.capabilities,
      errors: [...(outcome.errors ?? [])], warnings: [...(outcome.warnings ?? []), 'inert fixture runtime: not a sandbox'],
      versions: { pi: '0.85.1', protocol: 1 },
    };
  }

  async start(request: RuntimeRequest): Promise<RuntimeHandle> {
    this.starts.push(request.attemptId);
    const handle = await this.makeHandle(request, false);
    if (this.hooks && !await this.hooks.claim(clone(handle))) throw new Error('workspace fence rejected the runtime handle');
    handle.launchIntent = true;
    const attempt: FakeAttempt = { attemptId: request.attemptId, taskId: request.taskId, handle, startedAt: this.now(), step: 0, status: 'starting', cursor: 1 };
    this.attempts.set(request.attemptId, attempt);
    await this.persist(attempt);
    await this.advance(attempt);
    this.maxConcurrent = Math.max(this.maxConcurrent, this.runningCount());
    return clone(attempt.handle);
  }

  async resume(checkpoint: RuntimeCheckpoint, request: RuntimeRequest): Promise<RuntimeHandle> {
    if (this.hooks && !await this.hooks.validateResume(checkpoint, request)) throw new Error('controller rejected the checkpoint resume');
    const parent = this.attempts.get(checkpoint.handle.attemptId);
    if (!parent) throw new Error('fixture runtime has no checkpointed attempt');
    this.resumes.push(request.attemptId);
    const handle = await this.makeHandle(request, false);
    handle.provenance = {
      checkpointId: checkpoint.id, parentAttemptId: parent.attemptId,
      parentSessionId: checkpoint.session.id, sessionDigest: checkpoint.session.sha256,
    };
    if (this.hooks && !await this.hooks.claim(clone(handle))) throw new Error('workspace fence rejected the resumed handle');
    handle.launchIntent = true;
    const attempt: FakeAttempt = {
      attemptId: request.attemptId, taskId: request.taskId, handle, startedAt: this.now(),
      step: 0, status: 'starting', resumedFrom: parent.attemptId, cursor: 1,
    };
    this.attempts.set(request.attemptId, attempt);
    await this.persist(attempt);
    await this.advance(attempt);
    return clone(attempt.handle);
  }

  async observe(handle: RuntimeHandle, options?: { cursor?: number; limit?: number; waitMs?: number }): Promise<RuntimeObservation> {
    const attempt = this.adopt(handle);
    await this.advance(attempt);
    // [T10] Faithful to the real runtime: the events this attempt already emitted are returned for the caller's
    // cursor, so a supervisor can observe durable markers such as a spend refusal.
    const events = attempt.handle.events.filter(event => event.cursor > (options?.cursor ?? 0)).slice(0, options?.limit ?? 64);
    return {
      status: attempt.status, events, cursor: events.at(-1)?.cursor ?? attempt.cursor, gap: false,
      requested: clone(attempt.handle.requested), observed: clone(attempt.handle.observed),
      ...(attempt.handle.startupError ? { startupError: attempt.handle.startupError } : {}),
    };
  }

  async collect(handle: RuntimeHandle): Promise<RuntimeCollection> {
    const attempt = this.adopt(handle);
    this.collectCalls += 1;
    return {
      handle: clone(attempt.handle), outcome: attempt.status, logTail: '', droppedLogBytes: 0,
      requested: clone(attempt.handle.requested), observed: clone(attempt.handle.observed), resultAcceptance: 'not-evaluated',
    };
  }

  async stop(handle: RuntimeHandle, options?: { reason?: StopReceipt['reason']; deadlineAt?: number }): Promise<StopReceipt> {
    const attempt = this.adopt(handle);
    const reason = options?.reason ?? 'stopped';
    const survivors = this.options.stopVerified === false ? [identityFor(attempt.attemptId)] : [];
    const receipt: StopReceipt = {
      reason, at: this.now(), verified: this.options.stopVerified !== false, survivors,
      ...(this.options.stopVerified === false ? { error: 'fixture refuses verified termination' } : {}),
    };
    this.stops.push({ attemptId: attempt.attemptId, reason, verified: receipt.verified });
    if (!receipt.verified) return receipt;
    attempt.status = reason === 'checkpoint' ? 'stopped' : reason === 'completed' ? 'completed' : reason;
    attempt.handle.status = attempt.status;
    attempt.stopReceipt = receipt;
    if (attempt.exit === undefined && ['completed', 'failed', 'cancelled', 'timed-out'].includes(attempt.status)) {
      attempt.exit = { code: attempt.status === 'completed' ? 0 : null, signal: 'SIGTERM' };
    }
    if (attempt.exit) attempt.handle.exit = { code: attempt.exit.code, signal: attempt.exit.signal ?? null };
    await this.persist(attempt);
    return receipt;
  }

  async checkpoint(handle: RuntimeHandle, options?: { note?: string }): Promise<RuntimeCheckpoint> {
    const attempt = this.adopt(handle);
    const termination = await this.stop(handle, { reason: 'checkpoint' });
    if (!termination.verified) throw new Error('fixture checkpoint blocked: termination unverified');
    const control = attempt.handle.controlDir;
    void options;
    const checkpoint: RuntimeCheckpoint = {
      version: 1, id: randomUUID(), createdAt: this.now(), handle: clone(attempt.handle),
      session: { path: join(control, 'session.jsonl'), sha256: digest(`${attempt.attemptId}-session`), id: `session-${attempt.attemptId}`, bytes: 42 },
      termination, restoredToolProcesses: false,
    };
    attempt.checkpoint = checkpoint;
    this.checkpoints.push(attempt.attemptId);
    return clone(checkpoint);
  }

  async reconcile(handle: RuntimeHandle): Promise<import('../../src/runtime/types.js').ReconciliationReceipt> {
    const attempt = this.adopt(handle);
    this.reconciles.push(attempt.attemptId);
    if (this.options.reconcileState) {
      const state = this.options.reconcileState(attempt);
      return { state, handle: clone(attempt.handle), explanation: `fixture reconcile: ${state}` };
    }
    const state = attempt.stopReceipt?.verified ? 'terminated' : 'live';
    return { state, handle: clone(attempt.handle), explanation: `fixture reconcile: ${state}` };
  }
}

export function candidate(packet: unknown, idempotencyKey: string): ResultCandidate {
  return { packet, idempotencyKey };
}
