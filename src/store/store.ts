import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  SCHEMA_VERSION, runSchema, taskSchema, attemptSchema, evidenceSchema, handoffSchema,
  coverageSchema, findingSchema, gateDecisionSchema, budgetUsageSchema, observedRuntimeSchema, requestedRuntimeSchema, ID_PATTERN,
  canonicalJson, digestJson, isTimestamp, validateTaskScope, compareRuntime,
  evaluateHandoff, handoffEvidenceIds, validateCoverageEvidence, validateFindingEvidence,
  assertLifecycleTransition, assertPacketTransition, assertFindingTransition, assertRunTransition, isTerminalLifecycle,
  type RunManifest, type TaskManifest, type AttemptRecord, type EvidenceReceipt,
  type CoverageRecord, type FindingRecord, type RunState, type BudgetUsage, type JsonObject, type RequestedRuntime,
  type RuntimeSchema,
} from '../contracts/index.js';
import { migrate, STORE_SCHEMA_VERSION } from './migrations.js';
import { redactForExport } from './redaction.js';
import {
  StoreError, type StoreOptions, type WorkspaceLease, type BeginAttemptInput, type AttemptUpdate,
  type BudgetConsumption, type BudgetReservation, type BudgetRelease, type StoredResult, type ResultInput, type ResultAdmission,
  type EventInput, type DurableEvent, type OutboxEntry, type ClaimedOutboxEntry,
  type ReconciliationObservation, type ReconciliationReport, type AttemptLease,
} from './types.js';
import type { ModelSpendJournal, ModelSpendState } from '../policy/index.js';

type Row = Record<string, unknown>;
const zeroUsage = (): BudgetUsage => ({ requests: 0, bytes: 0, toolCalls: 0, tokens: 0, costUsd: 0 });
const usageKeys = ['requests', 'bytes', 'toolCalls', 'tokens', 'costUsd'] as const;
const budgetKeys = { requests: 'maxRequests', bytes: 'maxBytes', toolCalls: 'maxToolCalls', tokens: 'maxTokens', costUsd: 'maxCostUsd' } as const;
function ensure(condition: unknown, code: string, message: string): asserts condition { if (!condition) throw new StoreError(code, message); }
const validId = (v: string) => ensure(typeof v === 'string' && ID_PATTERN.test(v), 'invalid-id', 'Invalid identifier');
const duration = (ms: number) => ensure(Number.isSafeInteger(ms) && ms >= 1 && ms <= 86_400_000, 'invalid-duration', 'Lease/backoff duration must be 1..86400000 milliseconds');
const plus = (now: string, ms: number) => new Date(Date.parse(now) + ms).toISOString();
function canonicalWorkspace(path: string): string {
  let parent = resolve(path);
  const missing: string[] = [];
  while (!existsSync(parent)) {
    const up = dirname(parent);
    ensure(up !== parent, 'workspace', 'Workspace has no existing ancestor');
    missing.unshift(basename(parent)); parent = up;
  }
  return join(realpathSync(parent), ...missing);
}

/** Synchronous SQLite control-plane writes. No filesystem artifacts or processes are executed. */
export class DurableStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => string;
  private depth = 0;
  private savepoint = 0;
  private closed = false;
  readonly schemaVersion = STORE_SCHEMA_VERSION;

  constructor(options: StoreOptions) {
    ensure(typeof options.path === 'string' && options.path.length > 0, 'database-path', 'A database path is required');
    const timeout = options.busyTimeoutMs ?? 5_000;
    ensure(Number.isSafeInteger(timeout) && timeout >= 0 && timeout <= 60_000, 'busy-timeout', 'Busy timeout must be 0..60000 milliseconds');
    this.clock = options.clock ?? (() => new Date().toISOString());
    const now = this.now();
    const existed = options.path !== ':memory:' && existsSync(options.path);
    this.db = new DatabaseSync(options.path);
    try {
      if (!existed && options.path !== ':memory:') chmodSync(options.path, 0o600);
      this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${timeout}; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;`);
      migrate(this.db, now);
    } catch (error) { this.db.close(); throw error; }
  }
  private now(): string { const value = this.clock(); ensure(isTimestamp(value), 'clock', 'Clock must return a real UTC ISO timestamp'); return new Date(value).toISOString(); }
  private live(): void { ensure(!this.closed, 'store-closed', 'Store is closed'); }
  private row(sql: string, ...params: SQLInputValue[]): Row | undefined { this.live(); return this.db.prepare(sql).get(...params) as Row | undefined; }
  private rows(sql: string, ...params: SQLInputValue[]): Row[] { this.live(); return this.db.prepare(sql).all(...params) as Row[]; }
  private exec(sql: string, ...params: SQLInputValue[]): void { this.live(); this.db.prepare(sql).run(...params); }
  private readJson<T>(row: Row | undefined, schema: RuntimeSchema<T>): T | undefined { return row ? schema.parse(JSON.parse(String(row.json))) : undefined; }
  private needRun(id: string): RunManifest { const v = this.getRun(id); ensure(v, 'run-not-found', 'Run does not exist'); return v; }
  private needTask(id: string): TaskManifest { const v = this.getTask(id); ensure(v, 'task-not-found', 'Task does not exist'); return v; }
  private needAttempt(id: string): AttemptRecord { const v = this.getAttempt(id); ensure(v, 'attempt-not-found', 'Attempt does not exist'); return v; }
  private assertScope(task: TaskManifest, run: RunManifest, now: string): void {
    const issues = validateTaskScope(task, run, now);
    ensure(!issues.length, 'scope-rejected', issues.map(i => i.code).join(', '));
  }
  transaction<T>(callback: (store: DurableStore) => T): T {
    this.live();
    ensure(callback.constructor.name !== 'AsyncFunction', 'async-transaction', 'Transactions must use synchronous callbacks');
    const nested = this.depth > 0;
    const name = `p2o_${++this.savepoint}`;
    this.db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = callback(this);
      ensure(!(result && typeof result === 'object' && 'then' in result), 'async-transaction', 'Transactions cannot return promises/thenables');
      this.db.exec(nested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
      return result;
    } catch (error) {
      this.db.exec(nested ? `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};` : 'ROLLBACK');
      throw error;
    } finally { this.depth--; }
  }
  close(): void { if (this.closed) return; ensure(this.depth === 0, 'transaction-open', 'Cannot close inside a transaction'); this.db.close(); this.closed = true; }

  createRun(input: unknown): RunManifest {
    const run = runSchema.parse(input);
    return this.transaction(() => {
      ensure(!this.getRun(run.runId), 'duplicate-run', 'Run identity already exists');
      ensure(run.state === 'created' || run.state === 'active', 'run-state', 'New run must be created or active');
      const now = this.now();
      ensure(Date.parse(run.createdAt) <= Date.parse(now), 'future-run', 'Run creation is future-dated');
      ensure(Date.parse(now) >= Date.parse(run.authorization.validFrom) && Date.parse(now) < Date.parse(run.authorization.expiresAt) && Date.parse(now) < Date.parse(run.budgets.deadlineAt), 'authorization-expired', 'Run authorization/deadline is not current');
      this.exec('INSERT INTO runs(run_id, state, json) VALUES (?, ?, ?)', run.runId, run.state, canonicalJson(run));
      this.append({ runId: run.runId, type: 'run.created', payload: { state: run.state, schemaVersion: run.schemaVersion } }, now);
      return run;
    });
  }
  getRun(runId: string): RunManifest | undefined { return this.readJson(this.row('SELECT json FROM runs WHERE run_id = ?', runId), runSchema); }
  listRuns(): RunManifest[] { return this.rows('SELECT json FROM runs ORDER BY run_id').map(r => this.readJson(r, runSchema)!); }
  setRunState(runId: string, state: RunState): RunManifest {
    return this.transaction(() => {
      const run = this.needRun(runId); assertRunTransition(run.state, state);
      if (run.state === state) return run;
      const now = this.now();
      if (state === 'active') ensure(Date.parse(now) < Date.parse(run.authorization.expiresAt) && Date.parse(now) < Date.parse(run.budgets.deadlineAt) && Date.parse(now) >= Date.parse(run.authorization.validFrom), 'authorization-expired', 'Cannot resume expired authorization/deadline');
      if (['completed', 'cancelled', 'failed'].includes(state)) {
        ensure(!this.row('SELECT 1 FROM workspace_leases WHERE run_id = ?', runId), 'active-leases', 'Stop/reconcile all workers and release leases before terminal run state');
        ensure(this.listTasks(runId).every(t => isTerminalLifecycle(t.lifecycleState)), 'unfinished-tasks', 'Explicitly terminate/cancel every task; do not imply complete coverage');
      }
      const next = runSchema.parse({ ...run, state });
      this.exec('UPDATE runs SET state = ?, json = ? WHERE run_id = ?', state, canonicalJson(next), runId);
      this.append({ runId, type: 'run.state-changed', payload: { from: run.state, to: state } }, now);
      return next;
    });
  }
  createTask(input: unknown): TaskManifest {
    const task = taskSchema.parse(input);
    return this.transaction(() => {
      const run = this.needRun(task.runId); const now = this.now();
      ensure(['created', 'active', 'paused'].includes(run.state), 'run-terminal', 'Cannot add a task to a terminal run');
      this.assertScope(task, run, now);
      ensure(task.lifecycleState === 'queued' && task.packetState === 'draft', 'task-state', 'New tasks must be queued with draft packet state');
      ensure(Date.parse(task.createdAt) <= Date.parse(now) && Date.parse(task.createdAt) >= Date.parse(run.createdAt), 'task-time', 'Task creation must be within the run history');
      ensure(!this.getTask(task.taskId), 'duplicate-task', 'Task identity already exists');
      ensure(this.listTasks(task.runId).length < run.budgets.maxTasks, 'task-limit', 'Run task limit exhausted');
      if (task.parentTaskId) {
        const parent = this.needTask(task.parentTaskId);
        ensure(parent.runId === task.runId && task.depth === parent.depth + 1, 'parent-task', 'Parent run/depth does not match');
      } else ensure(task.depth === 0, 'task-depth', 'Root task depth must be zero');
      for (const dependency of task.dependencyTaskIds) ensure(this.needTask(dependency).runId === task.runId, 'dependency-run', 'Dependencies must belong to this run');
      // Existing-only dependencies make cycles impossible without mutable graph rewrites.
      const normalized = taskSchema.parse({ ...task, workspace: canonicalWorkspace(task.workspace) });
      this.exec('INSERT INTO tasks(task_id, run_id, parent_task_id, lifecycle_state, packet_state, input_revision, workspace, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', normalized.taskId, normalized.runId, normalized.parentTaskId ?? null, normalized.lifecycleState, normalized.packetState, normalized.inputRevision, normalized.workspace, canonicalJson(normalized));
      for (const dep of task.dependencyTaskIds) this.exec('INSERT INTO task_dependencies(task_id, dependency_task_id) VALUES (?, ?)', task.taskId, dep);
      this.append({ runId: task.runId, taskId: task.taskId, type: 'task.created', payload: { lifecycleState: task.lifecycleState, packetState: task.packetState, inputRevision: task.inputRevision } }, now);
      return normalized;
    });
  }
  getTask(taskId: string): TaskManifest | undefined { return this.readJson(this.row('SELECT json FROM tasks WHERE task_id = ?', taskId), taskSchema); }
  listTasks(runId: string): TaskManifest[] { return this.rows('SELECT json FROM tasks WHERE run_id = ? ORDER BY task_id', runId).map(r => this.readJson(r, taskSchema)!); }
  /** Cancel an unstarted task without fabricating an execution attempt. */
  cancelQueuedTask(taskId: string): TaskManifest {
    return this.transaction(() => {
      const task = this.needTask(taskId); ensure(task.lifecycleState === 'queued' && !this.getLease(taskId), 'task-active', 'Only an unstarted task may be cancelled directly');
      const next = { ...task, lifecycleState: 'cancelled' as const }; this.saveTask(next);
      this.append({ runId: task.runId, taskId, type: 'task.cancelled', payload: { lifecycleState: 'cancelled' } }, this.now());
      return next;
    });
  }
  private saveTask(task: TaskManifest, currentAttemptId?: string): void {
    taskSchema.parse(task);
    this.exec('UPDATE tasks SET lifecycle_state = ?, packet_state = ?, json = ? WHERE task_id = ?', task.lifecycleState, task.packetState, canonicalJson(task), task.taskId);
    if (currentAttemptId) this.exec('UPDATE tasks SET current_attempt_id = ? WHERE task_id = ?', currentAttemptId, task.taskId);
  }
  private saveAttempt(attempt: AttemptRecord): void {
    const parsed = attemptSchema.parse(attempt);
    this.exec('UPDATE attempts SET lifecycle_state = ?, json = ? WHERE attempt_id = ?', parsed.lifecycleState, canonicalJson(parsed), parsed.attemptId);
  }

  /** Managed handoff may change provider/model/thinking selection only; the adapter and required capability set stay pinned to the task's initial request. */
  private resolveRequestedRuntime(task: TaskManifest, override: RequestedRuntime | undefined): RequestedRuntime {
    if (override === undefined) return task.requestedRuntime;
    const requested = requestedRuntimeSchema.parse(override);
    ensure(requested.adapter === task.requestedRuntime.adapter, 'runtime-override-adapter', `Replacement attempt must keep runtime adapter '${task.requestedRuntime.adapter}'`);
    const capabilities = (values: readonly string[]) => canonicalJson([...new Set(values)].sort());
    ensure(capabilities(requested.requiredCapabilities) === capabilities(task.requestedRuntime.requiredCapabilities), 'runtime-override-capabilities', 'Replacement attempt must keep the task required runtime capabilities');
    return requested;
  }

  beginAttempt(input: BeginAttemptInput): AttemptLease {
    validId(input.taskId); validId(input.ownerId); duration(input.leaseMs);
    const attemptId = input.attemptId ?? randomUUID(); validId(attemptId);
    return this.transaction(() => {
      const task = this.needTask(input.taskId); const run = this.needRun(task.runId); const now = this.now();
      ensure(run.state === 'active', 'run-not-active', 'Run must be active before launching');
      this.assertScope(task, run, now);
      ensure(task.packetState !== 'accepted', 'task-result-accepted', 'Task already has an accepted packet');
      ensure(task.lifecycleState === 'queued' || isTerminalLifecycle(task.lifecycleState), 'task-active', 'Task has a live/unknown attempt');
      ensure(!this.getAttempt(attemptId), 'duplicate-attempt', 'Attempt identity already exists');
      const workspace = canonicalWorkspace(task.workspace);
      ensure(workspace === task.workspace, 'workspace-changed', 'Workspace ancestry changed since task admission');
      ensure(!this.row('SELECT 1 FROM workspace_leases WHERE workspace = ? OR task_id = ?', workspace, task.taskId), 'workspace-leased', 'Workspace/task already leased; expiry requires reconciliation, not takeover');
      ensure(!this.rows('SELECT workspace FROM workspace_leases').some(r => workspace.startsWith(`${String(r.workspace)}${sep}`) || String(r.workspace).startsWith(`${workspace}${sep}`)), 'workspace-overlap', 'A parent/descendant workspace is already leased');
      ensure(Number(this.row('SELECT COUNT(*) AS n FROM workspace_leases WHERE run_id = ?', task.runId)!.n) < run.budgets.maxConcurrency, 'concurrency-limit', 'Run concurrency limit exhausted (unknown leases count)');
      for (const dep of task.dependencyTaskIds) ensure(this.needTask(dep).packetState === 'accepted', 'dependency-not-accepted', 'Dependency has no accepted packet');
      const sequence = this.listAttempts(task.runId, task.taskId).length + 1;
      ensure(sequence <= task.budgets.maxAttempts, 'attempt-limit', 'Task attempt budget exhausted');
      const token = randomUUID();
      const requestedRuntime = this.resolveRequestedRuntime(task, input.requestedRuntime);
      const attempt = attemptSchema.parse({ schemaVersion: SCHEMA_VERSION, runId: task.runId, taskId: task.taskId, attemptId, sequence, ownerId: input.ownerId, leaseToken: token, createdAt: now, updatedAt: now, lifecycleState: 'starting', requestedRuntime, heartbeatAt: now, deadlineAt: task.budgets.deadlineAt, usage: zeroUsage() });
      this.exec('INSERT INTO attempts(attempt_id, task_id, run_id, sequence, lifecycle_state, json) VALUES (?, ?, ?, ?, ?, ?)', attemptId, task.taskId, task.runId, sequence, attempt.lifecycleState, canonicalJson(attempt));
      this.exec('INSERT INTO workspace_fences(workspace, generation) VALUES (?, 1) ON CONFLICT(workspace) DO UPDATE SET generation = generation + 1', workspace);
      const generation = Number(this.row('SELECT generation FROM workspace_fences WHERE workspace = ?', workspace)!.generation);
      const expiresAt = new Date(Math.min(Date.parse(plus(now, input.leaseMs)), Date.parse(attempt.deadlineAt), Date.parse(run.authorization.expiresAt))).toISOString();
      this.exec('INSERT INTO workspace_leases(workspace, run_id, task_id, attempt_id, owner_id, token, generation, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', workspace, task.runId, task.taskId, attemptId, input.ownerId, token, generation, now, now, expiresAt);
      this.saveTask({ ...task, lifecycleState: 'starting', packetState: 'draft' }, attemptId);
      this.append({ runId: task.runId, taskId: task.taskId, attemptId, type: 'attempt.started', payload: { sequence, lifecycleState: 'starting', generation, leaseToken: token } }, now);
      return { attempt, lease: this.getLease(task.taskId)! };
    });
  }
  getAttempt(attemptId: string): AttemptRecord | undefined { return this.readJson(this.row('SELECT json FROM attempts WHERE attempt_id = ?', attemptId), attemptSchema); }
  listAttempts(runId: string, taskId?: string): AttemptRecord[] {
    const rows = taskId ? this.rows('SELECT json FROM attempts WHERE run_id = ? AND task_id = ? ORDER BY sequence', runId, taskId) : this.rows('SELECT json FROM attempts WHERE run_id = ? ORDER BY task_id, sequence', runId);
    return rows.map(r => this.readJson(r, attemptSchema)!);
  }
  private leaseRow(r: Row): WorkspaceLease { return { workspace: String(r.workspace), runId: String(r.run_id), taskId: String(r.task_id), attemptId: String(r.attempt_id), ownerId: String(r.owner_id), token: String(r.token), generation: Number(r.generation), acquiredAt: String(r.acquired_at), heartbeatAt: String(r.heartbeat_at), expiresAt: String(r.expires_at) }; }
  getLease(taskId: string): WorkspaceLease | undefined { const r = this.row('SELECT * FROM workspace_leases WHERE task_id = ?', taskId); return r ? this.leaseRow(r) : undefined; }
  private fence(attempt: AttemptRecord, token: string, now: string, allowExpired = false): WorkspaceLease {
    const lease = this.getLease(attempt.taskId);
    ensure(lease && lease.attemptId === attempt.attemptId && lease.token === token && attempt.leaseToken === token, 'stale-lease', 'Attempt does not hold the current fencing token');
    ensure(this.row('SELECT current_attempt_id FROM tasks WHERE task_id = ?', attempt.taskId)?.current_attempt_id === attempt.attemptId, 'stale-attempt', 'Attempt is not current');
    ensure(allowExpired || Date.parse(lease.expiresAt) > Date.parse(now), 'lease-expired', 'Lease expired; reconcile the worker before proceeding');
    return lease;
  }
  updateAttempt(attemptId: string, update: AttemptUpdate, fence: { leaseToken: string }): AttemptRecord {
    return this.transaction(() => {
      const attempt = this.needAttempt(attemptId); const now = this.now(); this.fence(attempt, fence.leaseToken, now);
      ensure(attempt.lifecycleState !== 'reconciling', 'reconciliation-required', 'Use receipt-backed reconciliation before updating unknown execution');
      ensure(Object.keys(update).every(k => ['lifecycleState', 'observedRuntime', 'checkpoint', 'exit'].includes(k)), 'attempt-update', 'Unknown attempt update field');
      const state = update.lifecycleState ?? attempt.lifecycleState;
      assertLifecycleTransition(attempt.lifecycleState, state);
      const next = attemptSchema.parse({ ...attempt, ...update, lifecycleState: state, updatedAt: now });
      if (next.observedRuntime?.attestation === 'attested') this.runtimeReceipts(next, next.observedRuntime.receiptEvidenceIds, next.observedRuntime.observedAt, now);
      this.saveAttempt(next);
      this.saveTask({ ...this.needTask(attempt.taskId), lifecycleState: state });
      this.append({ runId: attempt.runId, taskId: attempt.taskId, attemptId, type: 'attempt.observed', payload: { from: attempt.lifecycleState, to: state, ...(next.observedRuntime ? { requestedRuntime: next.requestedRuntime as unknown as JsonObject, observedRuntime: next.observedRuntime as unknown as JsonObject } : {}) } }, now);
      return next;
    });
  }
  heartbeat(input: { attemptId: string; leaseToken: string; leaseMs: number }): WorkspaceLease {
    duration(input.leaseMs);
    return this.transaction(() => {
      const a = this.needAttempt(input.attemptId); const now = this.now(); this.fence(a, input.leaseToken, now);
      ensure(!isTerminalLifecycle(a.lifecycleState) && a.lifecycleState !== 'reconciling', 'attempt-not-live', 'Cannot heartbeat terminal or unreconciled execution');
      const run = this.needRun(a.runId); this.assertScope(this.needTask(a.taskId), run, now);
      const expiresAt = new Date(Math.min(Date.parse(plus(now, input.leaseMs)), Date.parse(a.deadlineAt), Date.parse(run.authorization.expiresAt))).toISOString();
      this.exec('UPDATE workspace_leases SET heartbeat_at = ?, expires_at = ? WHERE attempt_id = ?', now, expiresAt, a.attemptId);
      this.saveAttempt({ ...a, heartbeatAt: now, updatedAt: now });
      this.append({ runId: a.runId, taskId: a.taskId, attemptId: a.attemptId, type: 'attempt.heartbeat', payload: { expiresAt } }, now);
      return this.getLease(a.taskId)!;
    });
  }
  releaseLease(input: { attemptId: string; leaseToken: string; terminationConfirmed: boolean }): boolean {
    return this.transaction(() => {
      const a = this.needAttempt(input.attemptId);
      ensure(a.leaseToken === input.leaseToken, 'stale-lease', 'Fencing token does not match');
      ensure(input.terminationConfirmed === true && isTerminalLifecycle(a.lifecycleState), 'termination-unconfirmed', 'Process termination and terminal lifecycle must be confirmed');
      if (!this.getLease(a.taskId)) return false;
      this.fence(a, input.leaseToken, this.now(), true);
      this.exec('DELETE FROM workspace_leases WHERE attempt_id = ? AND token = ?', a.attemptId, input.leaseToken);
      this.append({ runId: a.runId, taskId: a.taskId, attemptId: a.attemptId, type: 'lease.released', payload: { terminationConfirmed: true } }, this.now());
      return true;
    });
  }
  consumeBudget(input: BudgetConsumption): BudgetUsage { return this.chargeBudget(input); }
  /**
   * Mint a durable pre-dispatch reservation and charge it. The returned id is recorded in the
   * `budget.consumed` event and is the only handle that can release exactly this charge (once).
   */
  reserveBudget(input: BudgetReservation): { reservationId: string; usage: BudgetUsage } {
    ensure(Object.keys(input).every(k => ['attemptId', 'leaseToken', 'targetId', 'toolCalls', 'requests'].includes(k)), 'budget-input', 'Unknown budget reservation field');
    const delta = budgetUsageSchema.parse({ requests: input.requests ?? 0, bytes: 0, toolCalls: input.toolCalls ?? 0, tokens: 0, costUsd: 0 });
    ensure(delta.toolCalls === 1 && delta.requests <= 1, 'reservation-shape', 'A reservation is exactly one tool call and at most one target request');
    const reservationId = randomUUID();
    const usage = this.chargeBudget({ attemptId: input.attemptId, leaseToken: input.leaseToken, ...(input.targetId ? { targetId: input.targetId } : {}), toolCalls: delta.toolCalls, requests: delta.requests }, reservationId);
    return { reservationId, usage };
  }
  private chargeBudget(input: BudgetConsumption, reservationId?: string): BudgetUsage {
    ensure(Object.keys(input).every(k => ['attemptId', 'leaseToken', 'targetId', ...usageKeys].includes(k)), 'budget-input', 'Unknown budget consumption field');
    const delta = budgetUsageSchema.parse(Object.fromEntries(usageKeys.map(k => [k, input[k] === undefined ? 0 : input[k]])));
    return this.transaction(() => {
      const a = this.needAttempt(input.attemptId); const task = this.needTask(a.taskId); const run = this.needRun(a.runId); const now = this.now();
      this.fence(a, input.leaseToken, now); this.assertScope(task, run, now);
      ensure(run.state === 'active' && !isTerminalLifecycle(a.lifecycleState) && a.lifecycleState !== 'reconciling', 'execution-not-active', 'Budget consumption requires live, authorized execution');
      if (delta.requests > 0) ensure(input.targetId && task.scope.targetIds.includes(input.targetId), 'target-required', 'Target requests require an explicitly scoped target');
      if (input.targetId) ensure(task.scope.targetIds.includes(input.targetId), 'target-budget', 'Target is not in task scope');
      const attempts = this.listAttempts(a.runId);
      const total = (subset: AttemptRecord[]) => subset.reduce((sum, item) => Object.fromEntries(usageKeys.map(k => [k, sum[k] + item.usage[k]])) as unknown as BudgetUsage, zeroUsage());
      const taskTotal = total(attempts.filter(x => x.taskId === a.taskId)); const runTotal = total(attempts);
      for (const k of usageKeys) {
        const taskCap = task.budgets[budgetKeys[k]], runCap = run.budgets[budgetKeys[k]];
        // Null is schema-qualified informational model accounting, not a large numeric allowance. Request,
        // byte and tool controls always remain numerical, and bounded legacy caps are unchanged.
        ensure(taskCap === null || taskTotal[k] + delta[k] <= taskCap + (k === 'costUsd' ? 1e-9 : 0), 'task-budget-exhausted', `Task ${k} budget exhausted`);
        ensure(runCap === null || runTotal[k] + delta[k] <= runCap + (k === 'costUsd' ? 1e-9 : 0), 'run-budget-exhausted', `Run ${k} budget exhausted`);
      }
      if (input.targetId) {
        const used = Number(this.row('SELECT requests FROM target_usage WHERE run_id = ? AND target_id = ?', a.runId, input.targetId)?.requests ?? 0);
        ensure(used + delta.requests <= run.budgets.targetRequestLimits[input.targetId], 'target-budget-exhausted', 'Target-wide request budget exhausted');
        this.exec('INSERT INTO target_usage(run_id, target_id, requests) VALUES (?, ?, ?) ON CONFLICT(run_id, target_id) DO UPDATE SET requests = excluded.requests', a.runId, input.targetId, used + delta.requests);
      }
      const usage = budgetUsageSchema.parse(Object.fromEntries(usageKeys.map(k => [k, a.usage[k] + delta[k]])));
      this.saveAttempt({ ...a, usage, updatedAt: now });
      this.append({ runId: a.runId, taskId: a.taskId, attemptId: a.attemptId, type: 'budget.consumed', payload: { ...(input.targetId ? { targetId: input.targetId } : {}), delta: delta as unknown as JsonObject, ...(reservationId ? { reservationId } : {}), usage: usage as unknown as JsonObject } }, now);
      return usage;
    });
  }
  /**
   * Release a reservation by identity, exactly once. The released counters come from the RECORDED
   * reservation (`budget.consumed` event carrying `reservationId`), never from the caller, and a replay of
   * the same id is refused — so a release can never be replayed to refund another call's charge. Fail-closed
   * reservation-before-dispatch is unchanged: an exhausted budget refuses before any traffic.
   */
  releaseReservation(input: BudgetRelease): BudgetUsage {
    ensure(Object.keys(input).every(k => ['attemptId', 'leaseToken', 'reservationId', 'reason', 'code', 'toolPlane'].includes(k)), 'budget-input', 'Unknown budget release field');
    ensure(typeof input.reason === 'string' && input.reason.trim().length > 0 && input.reason.length <= 256, 'budget-input', 'Budget release requires a bounded reason');
    ensure(typeof input.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(input.code), 'budget-input', 'Budget release requires a structured refusal code');
    ensure(typeof input.toolPlane === 'boolean', 'budget-input', 'Budget release requires the refusal class');
    ensure(ID_PATTERN.test(input.reservationId), 'budget-input', 'Budget release requires a reservation id');
    return this.transaction(() => {
      const a = this.needAttempt(input.attemptId); const now = this.now();
      this.fence(a, input.leaseToken, now);
      const rows = this.rows("SELECT type, payload_json FROM events WHERE run_id = ? AND attempt_id = ? AND type IN ('budget.consumed', 'budget.released') ORDER BY sequence", a.runId, a.attemptId);
      let recorded: { toolCalls: number; requests: number; targetId?: string } | undefined, alreadyReleased = false;
      for (const row of rows) {
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>; } catch { continue; }
        if (payload.reservationId !== input.reservationId) continue;
        if (row.type === 'budget.released') { alreadyReleased = true; continue; }
        const delta = (payload.delta ?? {}) as Record<string, unknown>;
        recorded = { toolCalls: Number(delta.toolCalls ?? 0), requests: Number(delta.requests ?? 0), ...(typeof payload.targetId === 'string' ? { targetId: payload.targetId } : {}) };
      }
      ensure(recorded || alreadyReleased, 'reservation-unknown', 'No reservation with this identity exists for the attempt');
      ensure(!alreadyReleased, 'reservation-already-released', 'This reservation was already released; exactly-once release is enforced');
      const reservation = recorded!;
      ensure(reservation.toolCalls === 1 && reservation.requests <= 1, 'reservation-shape', 'Recorded reservation is not a single pre-dispatch call');
      for (const k of usageKeys) ensure(a.usage[k] - (k === 'toolCalls' ? reservation.toolCalls : k === 'requests' ? reservation.requests : 0) >= 0, 'budget-release-underflow', `Released ${k} exceeds the attempt's charged usage`);
      if (reservation.targetId) ensure(this.needTask(a.taskId).scope.targetIds.includes(reservation.targetId), 'target-budget', 'Reservation target is not in task scope');
      if (reservation.requests > 0) {
        ensure(reservation.targetId, 'target-required', 'Releasing target requests requires the recorded scoped target');
        const used = this.getTargetUsage(a.runId, reservation.targetId);
        ensure(used - reservation.requests >= 0, 'budget-release-underflow', 'Released requests exceed the target usage');
        this.exec('UPDATE target_usage SET requests = requests - ? WHERE run_id = ? AND target_id = ?', reservation.requests, a.runId, reservation.targetId);
      }
      const usage = budgetUsageSchema.parse({ ...a.usage, toolCalls: a.usage.toolCalls - reservation.toolCalls, requests: a.usage.requests - reservation.requests });
      this.saveAttempt({ ...a, usage, updatedAt: now });
      this.append({ runId: a.runId, taskId: a.taskId, attemptId: a.attemptId, type: 'budget.released', payload: { reservationId: input.reservationId, ...(reservation.targetId ? { targetId: reservation.targetId } : {}), delta: { requests: reservation.requests, bytes: 0, toolCalls: reservation.toolCalls, tokens: 0, costUsd: 0 } as unknown as JsonObject, reason: input.reason, code: input.code, toolPlane: input.toolPlane, usage: usage as unknown as JsonObject } }, now);
      return usage;
    });
  }
  /**
   * [R-5] Complete per-attempt refusal accounting for the supervisor's no-progress breaker: the number of
   * CONSECUTIVE tool-plane `budget.released` events after this attempt's last non-tool-plane release, and the
   * latest tool-plane code. One indexed query over this attempt's own release rows — no run-wide page cap, so
   * a long run can never drop late releases on a controller restart.
   */
  /**
   * [L1] Durable consecutive-failure streak for one task: how many attempts at the tail of the sequence
   * ended in a renewable terminal failure (`failed`/`timed-out`). Derived from the durable attempts table, so
   * a restarted controller sees exactly the same streak; it is never an in-memory counter.
   */
  attemptFailureStreak(runId: string, taskId: string): { failures: number; lastState: string; lastAttemptId?: string } {
    const attempts = this.listAttempts(runId, taskId);
    let failures = 0, lastState = 'none', lastAttemptId: string | undefined;
    for (let index = attempts.length - 1; index >= 0; index--) {
      const state = String(attempts[index]!.lifecycleState);
      if (state === 'failed' || state === 'timed-out') { failures += 1; lastState = state; lastAttemptId ??= attempts[index]!.attemptId; continue; }
      break;
    }
    return { failures, lastState, ...(lastAttemptId ? { lastAttemptId } : {}) };
  }
  attemptReleaseStreak(runId: string, attemptId: string): { refusals: number; code: string } {
    const rows = this.rows("SELECT payload_json FROM events WHERE run_id = ? AND attempt_id = ? AND type = 'budget.released' ORDER BY sequence", runId, attemptId);
    let refusals = 0, code = 'none';
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>; } catch { continue; }
      if (payload.toolPlane === true) { refusals += 1; code = typeof payload.code === 'string' ? payload.code : 'none'; }
      else { refusals = 0; code = 'none'; }
    }
    return { refusals, code };
  }
  getTargetUsage(runId: string, targetId: string): number { return Number(this.row('SELECT requests FROM target_usage WHERE run_id = ? AND target_id = ?', runId, targetId)?.requests ?? 0); }

  /**
   * Durable, synchronous JSON journal for the run's model spend ledger. One row per run behind the
   * writer fence; a reservation can only be persisted for an attempt that belongs to this run, so a
   * foreign-run counter can never be written. Unknown in-flight reservations survive restart until
   * reconciliation explicitly settles or releases them.
   */
  modelSpendJournal(runId: string): ModelSpendJournal {
    validId(runId);
    const load = (id: string): unknown => {
      validId(id);
      const row = this.row('SELECT json FROM model_spend_journal WHERE run_id = ?', id);
      return row ? JSON.parse(String(row.json)) : undefined;
    };
    const save = (state: Readonly<ModelSpendState>): void => {
      const raw = (state as { runId?: unknown } | null)?.runId;
      ensure(typeof raw === 'string', 'journal-identity', 'Model spend journal state has no run identity');
      validId(raw);
      ensure(raw === runId, 'journal-identity', 'Model spend journal state belongs to a different run');
      const json = canonicalJson(state);
      ensure(Buffer.byteLength(json) <= 1024 * 1024, 'journal-size', 'Model spend journal state exceeds its bound');
      this.transaction(() => {
        this.needRun(raw);
        for (const reservation of Object.values(state.reservations)) {
          const attempt = this.getAttempt(reservation.attemptId);
          ensure(attempt && attempt.runId === raw, 'journal-attempt', 'Model spend reservation references an attempt outside this run');
        }
        this.exec('INSERT INTO model_spend_journal(run_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at', raw, json, this.now());
      });
    };
    const ownsAttempt = (id: string, attemptId: string): boolean => {
      validId(id); validId(attemptId);
      const attempt = this.getAttempt(attemptId);
      return !!attempt && attempt.runId === id;
    };
    return Object.freeze({ load, save, ownsAttempt });
  }

  /** Pre-planning controller authority; immutable and separate from approved assessment admission. */
  bindAutonomousBudget(runId: string, plan: import('../policy/budget.js').AutonomousModelBudgetPlan): boolean {
    validId(runId); ensure(plan.outcome !== 'partial', 'budget-partial', 'Partial budget cannot dispatch');
    const json = canonicalJson(plan);
    return this.transaction(() => {
      const prior = this.row('SELECT plan_json FROM autonomous_budget_runs WHERE run_id = ?', runId);
      ensure(!prior || prior.plan_json === json, 'budget-policy-changed', 'Original phase allocation is immutable; extension requires separate approval');
      if (!prior) this.exec('INSERT INTO autonomous_budget_runs VALUES (?, ?)', runId, json);
      return !prior;
    });
  }
  registerControllerPhaseAttempt(runId: string, phase: 'planner' | 'report', attemptId: string): void {
    validId(runId); validId(attemptId);
    ensure(phase === 'planner' || phase === 'report', 'journal-phase', 'Not a controller phase');
    this.transaction(() => { this.exec('INSERT INTO autonomous_phase_attempts VALUES (?, ?, ?)', runId, phase, attemptId); });
  }
  autonomousPhaseJournal(runId: string, phase: import('../policy/budget.js').AutonomousBudgetPhase): ModelSpendJournal {
    validId(runId);
    ensure(['planner', 'workers', 'verifier', 'report'].includes(phase), 'journal-phase', 'Unknown phase');
    const ownsAttempt = (id: string, attemptId: string): boolean => {
      if (id !== runId) return false;
      const attempt = this.getAttempt(attemptId);
      if (phase === 'workers' || phase === 'verifier') {
        if (attempt && attempt.runId === runId) return true;
        const policy = this.row('SELECT plan_json FROM autonomous_budget_runs WHERE run_id = ?', runId);
        return !!policy && JSON.parse(String(policy.plan_json)).outcome === 'accounting-only' && !!this.row('SELECT 1 FROM autonomous_phase_attempts WHERE run_id = ? AND attempt_id = ?', runId, attemptId);
      }
      return !!this.row('SELECT 1 FROM autonomous_phase_attempts WHERE run_id = ? AND phase = ? AND attempt_id = ?', runId, phase, attemptId);
    };
    let expected: string | undefined;
    let loaded = false;
    return Object.freeze({
      load: (id: string) => {
        ensure(id === runId, 'journal-identity', 'Foreign phase run');
        const row = this.row('SELECT json FROM autonomous_phase_journals WHERE run_id = ? AND phase = ?', runId, phase);
        expected = row ? String(row.json) : undefined; loaded = true;
        return expected === undefined ? undefined : JSON.parse(expected);
      },
      ownsAttempt,
      save: (state: Readonly<ModelSpendState>) => {
        const json = canonicalJson(state);
        this.transaction(() => {
        ensure(loaded, "journal-fence", "Phase journal must be loaded before writing");
        const prior = this.row("SELECT json FROM autonomous_phase_journals WHERE run_id = ? AND phase = ?", runId, phase);
        ensure((prior ? String(prior.json) : undefined) === expected, "journal-fence", "Stale phase writer; reconciliation required");
        ensure(state.runId === runId, 'journal-identity', 'Foreign phase state');
        ensure(this.row('SELECT 1 FROM autonomous_budget_runs WHERE run_id = ?', runId), 'journal-identity', 'No controller budget authority');
        for (const r of Object.values(state.reservations)) ensure(ownsAttempt(runId, r.attemptId), 'journal-attempt', 'Attempt not owned by this phase');
        ensure(Buffer.byteLength(json) <= 1024 * 1024, 'journal-size', 'Phase journal too large');
        this.exec('INSERT INTO autonomous_phase_journals VALUES (?, ?, ?, ?) ON CONFLICT(run_id, phase) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at', runId, phase, json, this.now());
        });
        expected = json;
      },
    });
  }
  /** Offline pack doctor counters only; never shared with assessment target traffic. */
  autonomousPreflightJournal(runId: string): import("../policy/budget.js").BudgetJournal {
    return { load: id => {
      ensure(id === runId, "journal-identity", "Foreign preflight run");
      const row = this.row("SELECT json FROM autonomous_preflight_budget WHERE run_id = ?", runId); return row ? JSON.parse(String(row.json)) : undefined;
    }, save: state => this.transaction(() => {
      ensure(state.runId === runId && Object.keys(state.targets).length === 0, "journal-identity", "Preflight is offline only");
      this.exec("INSERT INTO autonomous_preflight_budget VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET json = excluded.json", runId, canonicalJson(state));
    }) };
  }

  putEvidence(input: unknown): EvidenceReceipt {
    const e = evidenceSchema.parse(input);
    return this.transaction(() => {
      const a = this.needAttempt(e.attemptId);
      ensure(a.runId === e.runId && a.taskId === e.taskId, 'evidence-identity', 'Evidence producer identity does not match');
      const existing = this.getEvidence(e.evidenceId);
      if (existing) { ensure(canonicalJson(existing) === canonicalJson(e), 'evidence-conflict', 'Immutable evidence ID has conflicting content'); return existing; }
      ensure(Date.parse(e.provenance.collectedAt) <= Date.parse(this.now()), 'future-evidence', 'Evidence collection is future-dated');
      this.exec('INSERT INTO evidence(evidence_id, run_id, task_id, attempt_id, digest, json) VALUES (?, ?, ?, ?, ?, ?)', e.evidenceId, e.runId, e.taskId, e.attemptId, e.digest, canonicalJson(e));
      this.append({ runId: e.runId, taskId: e.taskId, attemptId: e.attemptId, type: 'evidence.admitted', payload: { evidenceId: e.evidenceId, digest: e.digest, kind: e.kind, classification: e.classification, byteLength: e.byteLength } }, this.now());
      return e;
    });
  }
  getEvidence(evidenceId: string): EvidenceReceipt | undefined { return this.readJson(this.row('SELECT json FROM evidence WHERE evidence_id = ?', evidenceId), evidenceSchema); }
  listEvidence(runId: string): EvidenceReceipt[] { return this.rows('SELECT json FROM evidence WHERE run_id = ? ORDER BY evidence_id', runId).map(r => this.readJson(r, evidenceSchema)!); }
  putCoverage(input: unknown): CoverageRecord {
    const c = coverageSchema.parse(input);
    return this.transaction(() => {
      this.needRun(c.runId); if (c.taskId) ensure(this.needTask(c.taskId).runId === c.runId, 'coverage-identity', 'Coverage task belongs to another run');
      const issues = validateCoverageEvidence(c, this.listEvidence(c.runId)); ensure(!issues.length, 'coverage-evidence', issues.map(i => i.code).join(', '));
      const existing = this.readJson(this.row('SELECT json FROM coverage WHERE coverage_id = ?', c.coverageId), coverageSchema);
      if (existing) ensure(existing.runId === c.runId && existing.taskId === c.taskId && existing.surfaceId === c.surfaceId && existing.actorId === c.actorId && existing.question === c.question, 'coverage-identity', 'Coverage key cannot change question/surface/actor identity');
      if (existing && canonicalJson(existing) === canonicalJson(c)) return existing;
      this.exec('INSERT INTO coverage(coverage_id, run_id, task_id, json) VALUES (?, ?, ?, ?) ON CONFLICT(coverage_id) DO UPDATE SET json = excluded.json', c.coverageId, c.runId, c.taskId ?? null, canonicalJson(c));
      this.append({ runId: c.runId, ...(c.taskId ? { taskId: c.taskId } : {}), type: 'coverage.updated', payload: { coverageId: c.coverageId, state: c.state, basis: c.basis, evidenceIds: c.evidenceIds } }, this.now());
      return c;
    });
  }
  listCoverage(runId: string): CoverageRecord[] { return this.rows('SELECT json FROM coverage WHERE run_id = ? ORDER BY coverage_id', runId).map(r => this.readJson(r, coverageSchema)!); }
  putFinding(input: unknown): FindingRecord {
    const f = findingSchema.parse(input);
    return this.transaction(() => {
      ensure(this.needTask(f.taskId).runId === f.runId, 'finding-identity', 'Finding belongs to another run/task');
      const existing = this.getFinding(f.findingId);
      if (existing) {
        ensure(existing.runId === f.runId && existing.taskId === f.taskId && existing.producerId === f.producerId && existing.claim === f.claim, 'finding-identity', 'Finding cannot change producer/claim identity');
        assertFindingTransition(existing.state, f.state);
      } else ensure(f.state !== 'independently-validated', 'finding-transition', 'Create a reproduced finding before independent validation');
      const issues = validateFindingEvidence(f, this.listEvidence(f.runId)); ensure(!issues.length, 'finding-evidence', issues.map(i => i.code).join(', '));
      if (existing && canonicalJson(existing) === canonicalJson(f)) return existing;
      this.exec('INSERT INTO findings(finding_id, run_id, task_id, state, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(finding_id) DO UPDATE SET state = excluded.state, json = excluded.json', f.findingId, f.runId, f.taskId, f.state, canonicalJson(f));
      this.append({ runId: f.runId, taskId: f.taskId, type: 'finding.updated', payload: { findingId: f.findingId, state: f.state, classification: f.classification, evidenceIds: f.evidenceIds } }, this.now());
      return f;
    });
  }
  getFinding(findingId: string): FindingRecord | undefined { return this.readJson(this.row('SELECT json FROM findings WHERE finding_id = ?', findingId), findingSchema); }
  listFindings(runId: string): FindingRecord[] { return this.rows('SELECT json FROM findings WHERE run_id = ? ORDER BY finding_id', runId).map(r => this.readJson(r, findingSchema)!); }

  markPacketReady(input: { attemptId: string; leaseToken: string }): TaskManifest {
    return this.transaction(() => {
      const a = this.needAttempt(input.attemptId); const now = this.now(); this.fence(a, input.leaseToken, now);
      ensure(!['reconciling', 'failed', 'timed-out', 'cancelled'].includes(a.lifecycleState), 'stale-result', 'Stopped/unknown execution cannot publish a ready packet');
      const task = this.needTask(a.taskId); assertPacketTransition(task.packetState, 'ready');
      if (task.packetState === 'ready') return task;
      const next = { ...task, packetState: 'ready' as const }; this.saveTask(next);
      this.append({ runId: a.runId, taskId: a.taskId, attemptId: a.attemptId, type: 'packet.ready', payload: { packetState: 'ready' } }, now);
      return next;
    });
  }

  admitResult(input: ResultInput): ResultAdmission {
    const packet = handoffSchema.parse(input.packet); validId(input.idempotencyKey); validId(input.reviewerId);
    const digest = digestJson(packet);
    return this.transaction(() => {
      const key = this.row('SELECT result_id FROM result_keys WHERE run_id = ? AND idempotency_key = ?', packet.runId, input.idempotencyKey);
      const existing = key ? this.getResult(String(key.result_id)) : this.getResult(packet.packetId);
      if (existing) {
        ensure(existing.runId === packet.runId && existing.attemptId === packet.attemptId && existing.digest === digest, 'result-conflict', 'Idempotency/packet identity is bound to different content');
        if (!key) this.exec('INSERT INTO result_keys(run_id, idempotency_key, result_id) VALUES (?, ?, ?)', packet.runId, input.idempotencyKey, existing.resultId);
        return { ...existing, duplicate: true };
      }
      const a = this.needAttempt(packet.attemptId); const task = this.needTask(packet.taskId); const run = this.needRun(packet.runId); const now = this.now();
      this.fence(a, input.leaseToken, now);
      ensure(a.runId === packet.runId && a.taskId === packet.taskId, 'result-identity', 'Result attempt belongs to another task/run');
      ensure(['active', 'paused'].includes(run.state) && !['reconciling', 'failed', 'timed-out', 'cancelled'].includes(a.lifecycleState), 'stale-result', 'Cannot admit results from stopped/unknown/terminal-run execution');
      ensure(task.packetState !== 'accepted', 'result-already-accepted', 'Task already has an accepted result');
      const evidence = handoffEvidenceIds(packet).map(id => this.getEvidence(id)).filter((e): e is EvidenceReceipt => !!e);
      assertPacketTransition(task.packetState, 'schema-valid');
      this.saveTask({ ...task, packetState: 'schema-valid' });
      this.append({ runId: packet.runId, taskId: packet.taskId, attemptId: packet.attemptId, type: 'packet.schema-valid', payload: { packetId: packet.packetId, packetState: 'schema-valid', digest } }, now);
      const decision = evaluateHandoff(packet, { authorization: run.authorization, evidence, reviewerId: input.reviewerId, now, task, attempt: a });
      const result: StoredResult = { resultId: packet.packetId, runId: packet.runId, taskId: packet.taskId, attemptId: packet.attemptId, digest, packet, decision, admittedAt: now };
      this.exec('INSERT INTO results(result_id, run_id, task_id, attempt_id, digest, decision_state, packet_json, decision_json, admitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', result.resultId, result.runId, result.taskId, result.attemptId, digest, decision.status, canonicalJson(packet), canonicalJson(decision), now);
      this.exec('INSERT INTO result_keys(run_id, idempotency_key, result_id) VALUES (?, ?, ?)', packet.runId, input.idempotencyKey, result.resultId);
      this.saveTask({ ...task, packetState: decision.status });
      this.append({ runId: packet.runId, taskId: packet.taskId, attemptId: packet.attemptId, type: `result.${decision.status}`, payload: { resultId: result.resultId, packetId: packet.packetId, digest, packetState: decision.status, outcome: packet.outcome, contract: packet.contract, reasons: decision.reasons.map(i => ({ code: i.code, path: i.path, message: i.message })) } }, now);
      return { ...result, duplicate: false };
    });
  }
  private resultRow(row: Row): StoredResult {
    const packet = handoffSchema.parse(JSON.parse(String(row.packet_json)));
    const decision = gateDecisionSchema.parse(JSON.parse(String(row.decision_json)));
    const digest = String(row.digest);
    ensure(digestJson(packet) === digest && packet.packetId === row.result_id && packet.runId === row.run_id && packet.taskId === row.task_id && packet.attemptId === row.attempt_id && decision.status === row.decision_state && (decision.status !== 'accepted' || decision.acceptedDigest === digest), 'result-integrity', 'Stored result identity/digest/decision is inconsistent');
    return { resultId: String(row.result_id), runId: String(row.run_id), taskId: String(row.task_id), attemptId: String(row.attempt_id), digest, packet, decision, admittedAt: String(row.admitted_at) };
  }
  getResult(resultId: string): StoredResult | undefined { const row = this.row('SELECT * FROM results WHERE result_id = ?', resultId); return row ? this.resultRow(row) : undefined; }
  listResults(runId: string, taskId?: string): StoredResult[] { return (taskId ? this.rows('SELECT * FROM results WHERE run_id = ? AND task_id = ? ORDER BY admitted_at, result_id', runId, taskId) : this.rows('SELECT * FROM results WHERE run_id = ? ORDER BY admitted_at, result_id', runId)).map(r => this.resultRow(r)); }

  private append(input: EventInput, now: string): DurableEvent {
    const eventId = randomUUID();
    const result = this.db.prepare('INSERT INTO events(event_id, run_id, task_id, attempt_id, type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(eventId, input.runId, input.taskId ?? null, input.attemptId ?? null, input.type, now, canonicalJson(input.payload));
    const sequence = Number(result.lastInsertRowid);
    this.exec('INSERT INTO outbox(event_sequence, available_at) VALUES (?, ?)', sequence, now);
    return { ...input, payload: JSON.parse(canonicalJson(input.payload)), eventId, sequence, occurredAt: now };
  }
  appendEvent(input: EventInput): DurableEvent {
    validId(input.runId); ensure(/^[a-z][a-z0-9.-]{0,127}$/.test(input.type), 'event-type', 'Event type must be a bounded machine identifier');
    ensure(input.payload !== null && typeof input.payload === 'object' && !Array.isArray(input.payload), 'event-payload', 'Event payload must be a JSON object'); canonicalJson(input.payload);
    return this.transaction(() => {
      this.needRun(input.runId);
      if (input.taskId) ensure(this.needTask(input.taskId).runId === input.runId, 'event-identity', 'Event task belongs to another run');
      if (input.attemptId) { const a = this.needAttempt(input.attemptId); ensure(a.runId === input.runId && (!input.taskId || a.taskId === input.taskId), 'event-identity', 'Event attempt belongs to another task/run'); }
      return this.append(input, this.now());
    });
  }
  private eventRow(r: Row): DurableEvent { return { sequence: Number(r.sequence), eventId: String(r.event_id), runId: String(r.run_id), ...(r.task_id ? { taskId: String(r.task_id) } : {}), ...(r.attempt_id ? { attemptId: String(r.attempt_id) } : {}), type: String(r.type), occurredAt: String(r.occurred_at), payload: JSON.parse(String(r.payload_json)) }; }
  listEvents(options: { runId?: string; afterSequence?: number; limit?: number } = {}): DurableEvent[] {
    const after = options.afterSequence ?? 0; const limit = options.limit ?? 1_000;
    ensure(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100_000, 'event-page', 'Invalid event pagination');
    return this.rows('SELECT * FROM events WHERE sequence > ? AND (? IS NULL OR run_id = ?) ORDER BY sequence LIMIT ?', after, options.runId ?? null, options.runId ?? null, limit).map(r => this.eventRow(r));
  }
  private outboxRow(r: Row): OutboxEntry { return { event: this.eventRow(r), deliveryAttempts: Number(r.delivery_attempts), availableAt: String(r.available_at), ...(r.delivered_at ? { deliveredAt: String(r.delivered_at) } : {}), ...(r.claim_owner ? { claimOwner: String(r.claim_owner), claimToken: String(r.claim_token), claimUntil: String(r.claim_until) } : {}), ...(r.last_error ? { lastError: String(r.last_error) } : {}) }; }
  listOutbox(options: { runId?: string; includeDelivered?: boolean; limit?: number } = {}): OutboxEntry[] {
    const limit = options.limit ?? 1_000; ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= 100_000, 'outbox-page', 'Invalid outbox limit');
    return this.rows('SELECT e.*, o.* FROM outbox o JOIN events e ON e.sequence = o.event_sequence WHERE (? IS NULL OR e.run_id = ?) AND (? = 1 OR o.delivered_at IS NULL) ORDER BY e.sequence LIMIT ?', options.runId ?? null, options.runId ?? null, options.includeDelivered ? 1 : 0, limit).map(r => this.outboxRow(r));
  }
  claimOutbox(input: { ownerId: string; limit?: number; leaseMs: number }): ClaimedOutboxEntry[] {
    validId(input.ownerId); duration(input.leaseMs); const limit = input.limit ?? 100; ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= 1_000, 'outbox-limit', 'Claim limit must be 1..1000');
    return this.transaction(() => {
      const now = this.now(); const until = plus(now, input.leaseMs);
      const ready = this.rows('SELECT event_sequence FROM outbox WHERE delivered_at IS NULL AND available_at <= ? AND (claim_until IS NULL OR claim_until <= ?) ORDER BY event_sequence LIMIT ?', now, now, limit);
      return ready.map(r => {
        const token = randomUUID(); const sequence = Number(r.event_sequence);
        this.exec('UPDATE outbox SET claim_owner = ?, claim_token = ?, claim_until = ?, delivery_attempts = delivery_attempts + 1 WHERE event_sequence = ?', input.ownerId, token, until, sequence);
        return this.outboxRow(this.row('SELECT e.*, o.* FROM outbox o JOIN events e ON e.sequence = o.event_sequence WHERE o.event_sequence = ?', sequence)!) as ClaimedOutboxEntry;
      });
    });
  }
  private claim(sequence: number, token: string, now: string): Row {
    const r = this.row('SELECT * FROM outbox WHERE event_sequence = ?', sequence);
    ensure(r && !r.delivered_at && r.claim_token === token && Date.parse(String(r.claim_until)) > Date.parse(now), 'stale-outbox-claim', 'Outbox claim is missing, expired or fenced'); return r;
  }
  ackOutbox(input: { sequence: number; claimToken: string }): void {
    this.transaction(() => { const now = this.now(); this.claim(input.sequence, input.claimToken, now); this.exec('UPDATE outbox SET delivered_at = ?, claim_owner = NULL, claim_token = NULL, claim_until = NULL, last_error = NULL WHERE event_sequence = ?', now, input.sequence); });
  }
  retryOutbox(input: { sequence: number; claimToken: string; delayMs: number; error: string }): void {
    duration(input.delayMs); ensure(typeof input.error === 'string' && input.error.length <= 4_096, 'outbox-error', 'Delivery error exceeds its bound');
    this.transaction(() => { const now = this.now(); this.claim(input.sequence, input.claimToken, now); this.exec('UPDATE outbox SET available_at = ?, last_error = ?, claim_owner = NULL, claim_token = NULL, claim_until = NULL WHERE event_sequence = ?', plus(now, input.delayMs), input.error, input.sequence); });
  }

  private runtimeReceipts(a: AttemptRecord, ids: string[], observedAt: string, now: string): void {
    ensure(isTimestamp(observedAt) && Date.parse(observedAt) <= Date.parse(now) && ids.length > 0 && new Set(ids).size === ids.length, 'reconciliation-receipt', 'Observation requires current, distinct runtime receipts');
    for (const id of ids) {
      const e = this.getEvidence(id);
      ensure(e && e.attemptId === a.attemptId && e.runId === a.runId && e.kind === 'runtime' && e.provenance.trust === 'collector' && Date.parse(e.provenance.collectedAt) >= Date.parse(observedAt) && Date.parse(e.provenance.collectedAt) <= Date.parse(now), 'reconciliation-receipt', 'Observation is not backed by this attempt\'s collector runtime receipt');
    }
  }
  reconcileRun(runId: string, observations: readonly ReconciliationObservation[] = [], options: { leaseMs?: number } = {}): ReconciliationReport {
    const leaseMs = options.leaseMs ?? 30_000; duration(leaseMs);
    return this.transaction(() => {
      const run = this.needRun(runId); const now = this.now();
      const report: ReconciliationReport = { runId, resumed: [], released: [], unknown: [], retryableTaskIds: [] };
      const byAttempt = new Map<string, ReconciliationObservation>();
      for (const o of observations) { ensure(!byAttempt.has(o.attemptId) && this.needAttempt(o.attemptId).runId === runId && isTimestamp(o.observedAt) && Date.parse(o.observedAt) <= Date.parse(now), 'reconciliation-observation', 'Duplicate, foreign or future observation'); byAttempt.set(o.attemptId, o); }
      for (const lease of this.rows('SELECT * FROM workspace_leases WHERE run_id = ? ORDER BY task_id', runId).map(r => this.leaseRow(r))) {
        const a = this.needAttempt(lease.attemptId); const task = this.needTask(a.taskId); const o = byAttempt.get(a.attemptId);
        let unknown = !o || o.status === 'unknown';
        if (o && o.status !== 'unknown') {
          this.runtimeReceipts(a, o.receiptEvidenceIds, o.observedAt, now);
          ensure(Date.parse(o.observedAt) >= Date.parse(a.heartbeatAt), 'stale-observation', 'Observation predates the last known live heartbeat');
          if (o.status === 'running') {
            const runtime = observedRuntimeSchema.parse(o.runtime);
            const oldIdentity = a.observedRuntime?.processIdentity;
            const matching = oldIdentity && runtime.processIdentity && canonicalJson(oldIdentity) === canonicalJson(runtime.processIdentity) && runtime.capabilities.ownsLifecycle && compareRuntime(a.requestedRuntime, runtime).matches;
            const currentAuthorization = !validateTaskScope(task, run, now).length && run.state === 'active';
            if (matching && currentAuthorization && !isTerminalLifecycle(a.lifecycleState)) {
              this.runtimeReceipts(a, runtime.receiptEvidenceIds, runtime.observedAt, now);
              const expiry = new Date(Math.min(Date.parse(plus(now, leaseMs)), Date.parse(a.deadlineAt), Date.parse(run.authorization.expiresAt))).toISOString();
              this.exec('UPDATE workspace_leases SET heartbeat_at = ?, expires_at = ? WHERE attempt_id = ? AND token = ?', now, expiry, a.attemptId, lease.token);
              this.saveAttempt({ ...a, lifecycleState: 'running', observedRuntime: runtime, heartbeatAt: now, updatedAt: now });
              this.saveTask({ ...task, lifecycleState: 'running' });
              this.append({ runId, taskId: a.taskId, attemptId: a.attemptId, type: 'attempt.reconciled-live', payload: { lifecycleState: 'running', expiresAt: expiry } }, now);
              report.resumed.push(a.attemptId);
            } else unknown = true;
          } else {
            ensure(o.terminationConfirmed === true && (o.status !== 'not-started' || !a.observedRuntime?.processIdentity), 'termination-unconfirmed', 'Cannot claim non-launch for a previously observed process');
            const state = o.lifecycleState ?? (o.status === 'not-started' ? 'failed' : 'exited');
            ensure(isTerminalLifecycle(state), 'reconciliation-state', 'Termination must produce a terminal lifecycle');
            const next = attemptSchema.parse({ ...a, lifecycleState: state, updatedAt: now, ...(o.exit ? { exit: o.exit } : {}) });
            this.saveAttempt(next); this.saveTask({ ...task, lifecycleState: state });
            this.exec('DELETE FROM workspace_leases WHERE attempt_id = ? AND token = ?', a.attemptId, lease.token);
            this.append({ runId, taskId: a.taskId, attemptId: a.attemptId, type: 'attempt.reconciled-terminal', payload: { lifecycleState: state, terminationConfirmed: true } }, now);
            report.released.push(a.attemptId);
            if (task.packetState !== 'accepted' && run.state === 'active' && a.sequence < task.budgets.maxAttempts && !validateTaskScope(task, run, now).length) report.retryableTaskIds.push(task.taskId);
          }
        }
        if (unknown) {
          if (!isTerminalLifecycle(a.lifecycleState) && a.lifecycleState !== 'reconciling') {
            this.saveAttempt({ ...a, lifecycleState: 'reconciling', updatedAt: now }); this.saveTask({ ...task, lifecycleState: 'reconciling' });
            this.append({ runId, taskId: a.taskId, attemptId: a.attemptId, type: 'attempt.reconciliation-required', payload: { lifecycleState: 'reconciling' } }, now);
          }
          report.unknown.push(a.attemptId);
        }
      }
      return report;
    });
  }
  exportJsonl(options: { runId?: string; afterSequence?: number } = {}): string {
    const lines: string[] = [];
    let after = options.afterSequence ?? 0;
    // One read snapshot: events appended concurrently cannot cause an inconsistent export.
    return this.transaction(() => {
      for (;;) {
        const page = this.listEvents({ ...options, afterSequence: after, limit: 1_000 });
        if (!page.length) break;
        for (const e of page) lines.push(canonicalJson(redactForExport(e as unknown as JsonObject)));
        after = page[page.length - 1].sequence;
      }
      return lines.length ? `${lines.join('\n')}\n` : '';
    });
  }
}
export function openStore(options: StoreOptions): DurableStore { return new DurableStore(options); }
