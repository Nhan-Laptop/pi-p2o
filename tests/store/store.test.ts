import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DurableStore, StoreError, STORE_SCHEMA_VERSION, migrations, type AttemptLease } from '../../src/store/index.js';
import { ValidationError, type RequestedRuntime } from '../../src/contracts/index.js';
import { NOW, HASH, runFixture, taskFixture, evidenceFixture, h2Fixture, staticH2Fixture, coverageFixture, findingFixture } from '../contracts/fixtures.js';

const stores: DurableStore[] = []; const dirs: string[] = [];
let now = NOW;
function setup() {
  now = NOW;
  const dir = mkdtempSync(join(tmpdir(), 'p2o-store-')); dirs.push(dir);
  const path = join(dir, 'run.sqlite');
  const store = new DurableStore({ path, clock: () => now }); stores.push(store);
  return { dir, path, store };
}
function reopen(path: string) { const store = new DurableStore({ path, clock: () => now }); stores.push(store); return store; }
function start(store: DurableStore, dir: string): AttemptLease {
  store.createRun(runFixture()); store.createTask(taskFixture('task-1', join(dir, 'work', 'task-1')));
  return store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-1', attemptId: 'attempt-1', leaseMs: 60_000 });
}
function staticAdmission(store: DurableStore, lease: AttemptLease) {
  store.putEvidence(evidenceFixture());
  return store.admitResult({ packet: staticH2Fixture(), idempotencyKey: 'result-key-1', leaseToken: lease.lease.token, reviewerId: 'reviewer-1' });
}
function code(fn: () => unknown, expected: string) {
  try { fn(); throw new Error(`Expected ${expected}`); } catch (e) { expect(e).toBeInstanceOf(StoreError); expect((e as StoreError).code).toBe(expected); }
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('SQLite durability and migrations', () => {
  it('uses real SQLite, secure new DB permissions and reopens all durable state', () => {
    const { dir, path, store } = setup(); const lease = start(store, dir); staticAdmission(store, lease);
    store.putCoverage(coverageFixture()); store.putFinding(findingFixture());
    const events = store.listEvents(); const outbox = store.listOutbox(); store.close();
    const restored = reopen(path);
    expect(restored.schemaVersion).toBe(STORE_SCHEMA_VERSION); expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(restored.getRun('run-1')!.state).toBe('active'); expect(restored.getTask('task-1')!.packetState).toBe('accepted');
    expect(restored.getAttempt('attempt-1')!.lifecycleState).toBe('starting'); expect(restored.getLease('task-1')!.token).toBe(lease.lease.token);
    expect(restored.listResults('run-1')).toHaveLength(1); expect(restored.listEvidence('run-1')).toHaveLength(1); expect(restored.listFindings('run-1')).toHaveLength(1); expect(restored.listCoverage('run-1')).toHaveLength(1);
    expect(restored.listEvents()).toEqual(events); expect(restored.listOutbox()).toEqual(outbox);
  });
  it('migrates a version-1 DB in place and refuses future/inconsistent histories', () => {
    const { dir } = setup(); const path = join(dir, 'legacy.sqlite'); const db = new DatabaseSync(path);
    db.exec(migrations[0].sql); db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(1, migrations[0].name, NOW); db.exec('PRAGMA user_version = 1');
    db.prepare('INSERT INTO runs VALUES (?, ?, ?)').run('run-1', 'active', JSON.stringify(runFixture())); db.close();
    const upgraded = reopen(path); expect(upgraded.getRun('run-1')).toEqual(runFixture()); expect(upgraded.getTargetUsage('run-1', 'fixture')).toBe(0); upgraded.close();
    const corrupt = new DatabaseSync(path); corrupt.exec('PRAGMA user_version = 999'); corrupt.close(); code(() => reopen(path), 'schema-too-new');
    const damaged = new DatabaseSync(path); damaged.exec('PRAGMA user_version = 2'); damaged.exec("UPDATE schema_migrations SET name = 'wrong' WHERE version = 1"); damaged.close(); code(() => reopen(path), 'migration-history');
  });
  it('rolls back run/task/event/outbox together, including nested savepoints and async misuse', () => {
    const { dir, store } = setup();
    expect(() => store.transaction(s => { s.createRun(runFixture()); s.createTask(taskFixture('task-1', join(dir, 'work'))); throw new Error('rollback'); })).toThrow('rollback');
    expect(store.listRuns()).toEqual([]); expect(store.listEvents()).toEqual([]); expect(store.listOutbox()).toEqual([]);
    store.transaction(s => {
      s.createRun(runFixture());
      expect(() => s.transaction(inner => { inner.createTask(taskFixture('task-1', join(dir, 'work'))); throw new Error('savepoint'); })).toThrow('savepoint');
      s.createTask(taskFixture('task-2', join(dir, 'work-2')));
    });
    expect(store.getTask('task-1')).toBeUndefined(); expect(store.getTask('task-2')).toBeDefined(); expect(store.listEvents()).toHaveLength(2); expect(store.listOutbox()).toHaveLength(2);
    code(() => store.transaction(async s => { s.createTask(taskFixture('async-task', join(dir, 'async'))); }), 'async-transaction');
    code(() => store.transaction(s => { s.createTask(taskFixture('promise-task', join(dir, 'promise'))); return Promise.resolve(); }), 'async-transaction');
    expect(store.getTask('promise-task')).toBeUndefined(); expect(store.getTask('async-task')).toBeUndefined();
  });
  it('rolls back the domain write if durable outbox publication fails', () => {
    const { dir, path, store } = setup(); store.createRun(runFixture());
    const fault = new DatabaseSync(path); fault.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected-outbox-failure'); END;");
    expect(() => store.createTask(taskFixture('task-1', join(dir, 'work')))).toThrow('injected-outbox-failure');
    expect(store.getTask('task-1')).toBeUndefined(); expect(store.listEvents()).toHaveLength(1); expect(store.listOutbox()).toHaveLength(1);
    fault.exec('DROP TRIGGER fail_outbox'); fault.close(); expect(store.createTask(taskFixture('task-1', join(dir, 'work')))).toBeDefined();
  });
});

describe('scope, graph, workspace leases and fences', () => {
  it('rejects invalid scope and grants without partial writes', () => {
    const { dir, store } = setup(); store.createRun(runFixture()); const task = taskFixture('task-1', join(dir, 'work')); task.scope.targetIds = ['outside'];
    code(() => store.createTask(task), 'scope-rejected'); expect(store.listTasks('run-1')).toEqual([]); expect(store.listEvents()).toHaveLength(1);
    task.scope.targetIds = ['fixture']; task.requiredCapabilities = ['host.bash']; code(() => store.createTask(task), 'scope-rejected');
  });
  it('prevents duplicate writers across DB handles and canonical symlink workspace aliases', () => {
    const { dir, path, store } = setup(); mkdirSync(join(dir, 'real')); symlinkSync(join(dir, 'real'), join(dir, 'alias'));
    store.createRun(runFixture()); store.createTask(taskFixture('task-1', join(dir, 'real', 'work'))); store.createTask(taskFixture('task-2', join(dir, 'alias', 'work')));
    const a = store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-1', leaseMs: 1_000 }); const other = reopen(path);
    code(() => other.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', leaseMs: 1_000 }), 'task-active');
    code(() => other.beginAttempt({ taskId: 'task-2', ownerId: 'worker-2', leaseMs: 1_000 }), 'workspace-leased');
    now = '2026-10-02T10:00:02.000Z'; code(() => other.beginAttempt({ taskId: 'task-2', ownerId: 'worker-2', leaseMs: 1_000 }), 'workspace-leased');
    code(() => other.heartbeat({ attemptId: a.attempt.attemptId, leaseToken: a.lease.token, leaseMs: 1_000 }), 'lease-expired');
    expect(other.listAttempts('run-1')).toHaveLength(1); expect(other.getLease('task-1')!.token).toBe(a.lease.token);
  });
  it('does not satisfy dependency readiness with process exit, only accepted packets', () => {
    const { dir, store } = setup(); const a = start(store, dir);
    const child = taskFixture('task-2', join(dir, 'task-2')); child.parentTaskId = 'task-1'; child.depth = 1; child.dependencyTaskIds = ['task-1']; store.createTask(child);
    store.updateAttempt('attempt-1', { lifecycleState: 'exited', exit: { code: 0, observedAt: NOW } }, { leaseToken: a.lease.token });
    expect(store.getTask('task-1')!.packetState).toBe('draft'); code(() => store.beginAttempt({ taskId: 'task-2', ownerId: 'worker-2', leaseMs: 1_000 }), 'dependency-not-accepted');
    staticAdmission(store, a); expect(store.beginAttempt({ taskId: 'task-2', ownerId: 'worker-2', leaseMs: 1_000 }).attempt.lifecycleState).toBe('starting');
  });
  it('uses requested runtime unchanged and requires terminal confirmation to release', () => {
    const { dir, store } = setup(); const a = start(store, dir);
    expect(a.attempt.requestedRuntime).toEqual(runFixture().requestedRuntime);
    code(() => store.releaseLease({ attemptId: 'attempt-1', leaseToken: a.lease.token, terminationConfirmed: true }), 'termination-unconfirmed');
    code(() => store.updateAttempt('attempt-1', { lifecycleState: 'running' }, { leaseToken: 'wrong-fence' }), 'stale-lease');
    store.updateAttempt('attempt-1', { lifecycleState: 'cancelled' }, { leaseToken: a.lease.token });
    expect(store.releaseLease({ attemptId: 'attempt-1', leaseToken: a.lease.token, terminationConfirmed: true })).toBe(true);
    expect(store.releaseLease({ attemptId: 'attempt-1', leaseToken: a.lease.token, terminationConfirmed: true })).toBe(false);
    const retry = store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', leaseMs: 1_000 }); expect(retry.lease.generation).toBe(2); expect(retry.lease.token).not.toBe(a.lease.token);
    code(() => store.heartbeat({ attemptId: 'attempt-1', leaseToken: a.lease.token, leaseMs: 1_000 }), 'stale-lease');
  });
});

describe('idempotent result admission and separate completion', () => {
  it('admits once, replays after release/reopen, binds alias keys and rejects conflicts', () => {
    const { dir, path, store } = setup(); const a = start(store, dir); const admitted = staticAdmission(store, a);
    expect(admitted.duplicate).toBe(false); expect(admitted.decision.status).toBe('accepted'); expect(store.getTask('task-1')!.lifecycleState).toBe('starting'); expect(store.getLease('task-1')).toBeDefined(); expect(store.listFindings('run-1')).toEqual([]);
    const input = { packet: staticH2Fixture(), idempotencyKey: 'result-key-1', leaseToken: a.lease.token, reviewerId: 'reviewer-1' };
    const before = store.listEvents().length; expect(store.admitResult(input).duplicate).toBe(true); expect(store.listEvents()).toHaveLength(before);
    expect(store.admitResult({ ...input, idempotencyKey: 'alias-key' }).duplicate).toBe(true);
    const modified = staticH2Fixture(); modified.nextAction.action = 'Different review'; code(() => store.admitResult({ ...input, packet: modified }), 'result-conflict'); code(() => store.admitResult({ ...input, idempotencyKey: 'alias-key', packet: modified }), 'result-conflict');
    const second = staticH2Fixture(); second.packetId = 'packet-2'; code(() => store.admitResult({ ...input, idempotencyKey: 'key-2', packet: second }), 'result-already-accepted');
    code(() => store.setRunState('run-1', 'completed'), 'active-leases');
    store.updateAttempt('attempt-1', { lifecycleState: 'exited', exit: { code: 0, observedAt: NOW } }, { leaseToken: a.lease.token }); store.releaseLease({ attemptId: 'attempt-1', leaseToken: a.lease.token, terminationConfirmed: true }); store.setRunState('run-1', 'completed'); store.close();
    now = '2026-10-02T13:00:00.000Z'; const restored = reopen(path); expect(restored.admitResult(input)).toEqual({ ...admitted, duplicate: true }); expect(restored.listResults('run-1')).toHaveLength(1);
  });
  it('returns insufficient evidence and accepts a corrected packet, without rewriting the first', () => {
    const { dir, store } = setup(); const a = start(store, dir); store.putEvidence(evidenceFixture());
    const returned = store.admitResult({ packet: h2Fixture(), idempotencyKey: 'first', leaseToken: a.lease.token, reviewerId: 'reviewer-1' }); expect(returned.decision.status).toBe('returned-for-evidence'); expect(returned.decision.reasons.map(r => r.code)).toContain('H2-baseline');
    expect(store.getTask('task-1')!.packetState).toBe('returned-for-evidence'); expect(store.getAttempt('attempt-1')!.lifecycleState).toBe('starting');
    store.putEvidence(evidenceFixture('baseline-1', 'baseline')); const corrected = h2Fixture(); corrected.packetId = 'packet-2';
    expect(store.admitResult({ packet: corrected, idempotencyKey: 'corrected', leaseToken: a.lease.token, reviewerId: 'reviewer-1' }).decision.status).toBe('accepted');
    expect(store.getResult('packet-1')!.decision.status).toBe('returned-for-evidence'); expect(store.listResults('run-1')).toHaveLength(2);
  });
  it('rejects stale attempts and changed input/runtime selection; receipts are immutable', () => {
    const { dir, store } = setup(); const a = start(store, dir); store.putEvidence(evidenceFixture());
    const altered = evidenceFixture(); altered.digest = 'd'.repeat(64); code(() => store.putEvidence(altered), 'evidence-conflict');
    const p = staticH2Fixture(); p.inputRevision = 'r2'; p.observedRuntime.selection = { ...p.observedRuntime.selection!, thinking: 'off' };
    expect(store.admitResult({ packet: p, idempotencyKey: 'bad', leaseToken: a.lease.token, reviewerId: 'reviewer-1' }).decision.reasons.map(r => r.code)).toEqual(expect.arrayContaining(['task-identity', 'runtime-mismatch']));
    store.updateAttempt('attempt-1', { lifecycleState: 'failed' }, { leaseToken: a.lease.token }); store.releaseLease({ attemptId: 'attempt-1', leaseToken: a.lease.token, terminationConfirmed: true }); store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', leaseMs: 1_000 });
    const late = staticH2Fixture(); late.packetId = 'late-packet';
    code(() => store.admitResult({ packet: late, idempotencyKey: 'late-result', leaseToken: a.lease.token, reviewerId: 'reviewer-1' }), 'stale-lease');
  });
});

describe('restart reconciliation', () => {
  it('keeps unknown/expired workers locked; confirmed termination enables one fenced retry', () => {
    const { dir, path, store } = setup(); const a = start(store, dir); store.close(); now = '2026-10-02T10:02:00.000Z'; const restored = reopen(path);
    expect(restored.reconcileRun('run-1').unknown).toEqual(['attempt-1']); expect(restored.getAttempt('attempt-1')!.lifecycleState).toBe('reconciling'); expect(restored.getLease('task-1')!.token).toBe(a.lease.token);
    code(() => restored.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', leaseMs: 1_000 }), 'task-active');
    code(() => restored.reconcileRun('run-1', [{ attemptId: 'attempt-1', status: 'terminated', terminationConfirmed: true, observedAt: now, receiptEvidenceIds: [] }]), 'reconciliation-receipt');
    restored.putEvidence(evidenceFixture('stopped-receipt', 'runtime', 'attempt-1', 'task-1', now));
    const report = restored.reconcileRun('run-1', [{ attemptId: 'attempt-1', status: 'terminated', lifecycleState: 'failed', terminationConfirmed: true, observedAt: now, receiptEvidenceIds: ['stopped-receipt'] }]);
    expect(report.released).toEqual(['attempt-1']); expect(report.retryableTaskIds).toEqual(['task-1']); expect(restored.getLease('task-1')).toBeUndefined();
    const retry = restored.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', leaseMs: 1_000 }); expect(retry.attempt.sequence).toBe(2); expect(retry.lease.token).not.toBe(a.lease.token);
  });
  it('renews only a receipt-backed matching live process, not a reused PID', () => {
    const { dir, path, store } = setup(); const a = start(store, dir); const runtime = h2Fixture().observedRuntime;
    runtime.processIdentity = { pid: 42, hostId: 'inert-host', startToken: 'process-birth-1' };
    store.updateAttempt('attempt-1', { lifecycleState: 'running', observedRuntime: runtime }, { leaseToken: a.lease.token }); store.close(); now = '2026-10-02T10:02:00.000Z'; const restored = reopen(path);
    restored.putEvidence(evidenceFixture('live-receipt', 'runtime', 'attempt-1', 'task-1', now)); const live = { ...runtime, observedAt: now, receiptEvidenceIds: ['live-receipt'] };
    expect(restored.reconcileRun('run-1', [{ attemptId: 'attempt-1', status: 'running', observedAt: now, receiptEvidenceIds: ['live-receipt'], runtime: live }]).resumed).toEqual(['attempt-1']); expect(restored.getLease('task-1')!.token).toBe(a.lease.token);
    now = '2026-10-02T10:02:01.000Z'; restored.putEvidence(evidenceFixture('pid-reuse-receipt', 'runtime', 'attempt-1', 'task-1', now));
    const reused = { ...live, observedAt: now, receiptEvidenceIds: ['pid-reuse-receipt'], processIdentity: { ...runtime.processIdentity, startToken: 'process-birth-2' } };
    expect(restored.reconcileRun('run-1', [{ attemptId: 'attempt-1', status: 'running', observedAt: now, receiptEvidenceIds: ['pid-reuse-receipt'], runtime: reused }]).unknown).toEqual(['attempt-1']); expect(restored.getLease('task-1')).toBeDefined();
  });
  it('does not convert accepted unresolved packets into lifecycle success on restart', () => {
    const { dir, path, store } = setup(); const a = start(store, dir); const p = staticH2Fixture(); p.outcome = 'unresolved'; p.classification = 'unresolved'; p.limits.failedAssumptions = ['no runtime baseline']; store.putEvidence(evidenceFixture()); store.admitResult({ packet: p, idempotencyKey: 'unresolved', leaseToken: a.lease.token, reviewerId: 'reviewer-1' }); store.close();
    const restored = reopen(path); expect(restored.reconcileRun('run-1').unknown).toEqual(['attempt-1']); expect(restored.getTask('task-1')!.packetState).toBe('accepted'); expect(restored.listResults('run-1')[0].decision.outcome).toBe('unresolved'); expect(restored.getTask('task-1')!.lifecycleState).toBe('reconciling');
  });
});

describe('budgets, outbox and conservative redacted export', () => {
  it('accounts atomically across retries and shares target limits across independent tasks', () => {
    const { dir, store } = setup(); const a = start(store, dir);
    expect(store.consumeBudget({ attemptId: 'attempt-1', leaseToken: a.lease.token, targetId: 'fixture', requests: 3, toolCalls: 1 }).requests).toBe(3);
    code(() => store.consumeBudget({ attemptId: 'attempt-1', leaseToken: a.lease.token, targetId: 'fixture', requests: 3 }), 'task-budget-exhausted'); expect(store.getTargetUsage('run-1', 'fixture')).toBe(3);
    store.updateAttempt('attempt-1', { lifecycleState: 'failed' }, { leaseToken: a.lease.token }); store.releaseLease({ attemptId: 'attempt-1', leaseToken: a.lease.token, terminationConfirmed: true }); const retry = store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', leaseMs: 60_000 });
    code(() => store.consumeBudget({ attemptId: retry.attempt.attemptId, leaseToken: retry.lease.token, targetId: 'fixture', requests: 3 }), 'task-budget-exhausted');
    store.createTask(taskFixture('task-2', join(dir, 'task-2'))); const b = store.beginAttempt({ taskId: 'task-2', ownerId: 'worker-3', leaseMs: 60_000 });
    code(() => store.consumeBudget({ attemptId: b.attempt.attemptId, leaseToken: b.lease.token, requests: 1 }), 'target-required');
    store.consumeBudget({ attemptId: b.attempt.attemptId, leaseToken: b.lease.token, targetId: 'fixture', requests: 2 }); code(() => store.consumeBudget({ attemptId: b.attempt.attemptId, leaseToken: b.lease.token, targetId: 'fixture', requests: 1 }), 'target-budget-exhausted'); expect(store.getAttempt(b.attempt.attemptId)!.usage.requests).toBe(2); expect(store.getTargetUsage('run-1', 'fixture')).toBe(5);
  });
  it('uses at-least-once outbox claims with fencing, durable acknowledgements and retry delay', () => {
    const { path, store } = setup(); store.createRun(runFixture()); const other = reopen(path);
    const claim = store.claimOutbox({ ownerId: 'publisher-1', leaseMs: 1_000 })[0]; expect(other.claimOutbox({ ownerId: 'publisher-2', leaseMs: 1_000 })).toEqual([]);
    now = '2026-10-02T10:00:02.000Z'; const replacement = other.claimOutbox({ ownerId: 'publisher-2', leaseMs: 10_000 })[0]; expect(replacement.event.eventId).toBe(claim.event.eventId); expect(replacement.deliveryAttempts).toBe(2);
    code(() => store.ackOutbox({ sequence: claim.event.sequence, claimToken: claim.claimToken }), 'stale-outbox-claim');
    other.retryOutbox({ sequence: replacement.event.sequence, claimToken: replacement.claimToken, delayMs: 1_000, error: 'inert delivery failed' }); expect(store.claimOutbox({ ownerId: 'publisher-1', leaseMs: 1_000 })).toEqual([]);
    now = '2026-10-02T10:00:04.000Z'; const ready = store.claimOutbox({ ownerId: 'publisher-1', leaseMs: 1_000 })[0]; store.ackOutbox({ sequence: ready.event.sequence, claimToken: ready.claimToken }); expect(other.listOutbox()).toEqual([]); expect(other.listOutbox({ includeDelivered: true })[0].deliveredAt).toBe(now);
  });
  it('exports paged JSONL receipts without secrets, raw tool text, URLs or host paths', () => {
    const { dir, store } = setup(); const a = start(store, dir);
    const raw = store.appendEvent({ runId: 'run-1', type: 'fixture.diagnostic', payload: { password: 'do-not-export', headers: { authorization: 'Bearer private-value' }, notes: 'plain secret in unknown prose', locator: 'https://name:private@example.invalid/?token=private', workspace: '/home/private', nested: { api_key: 'nested-secret' }, state: 'running', digest: HASH } });
    const exported = store.exportJsonl({ runId: 'run-1' }); const lines = exported.trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(store.listEvents().length); expect(lines.at(-1).payload).toMatchObject({ password: '[REDACTED]', headers: '[REDACTED]', locator: '[REDACTED]', workspace: '[REDACTED]', state: 'running', digest: HASH });
    for (const secret of ['do-not-export', 'private-value', 'plain secret', 'nested-secret', 'example.invalid', '/home/private', a.lease.token]) expect(exported).not.toContain(secret);
    expect(store.listEvents().at(-1)!.payload.password).toBe('do-not-export'); expect(store.exportJsonl({ afterSequence: raw.sequence })).toBe('');
  });
});

describe('additional admission and recovery boundaries', () => {
  it('records ready/schema-valid gates separately and blocks overlapping workspaces and concurrency', () => {
    const { dir, store } = setup(); const run = runFixture(); run.budgets.maxConcurrency = 1; store.createRun(run);
    store.createTask(taskFixture('task-1', join(dir, 'parent')));
    store.createTask(taskFixture('nested', join(dir, 'parent', 'child')));
    store.createTask(taskFixture('sibling', join(dir, 'sibling')));
    const a = store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-1', attemptId: 'attempt-1', leaseMs: 60_000 });
    code(() => store.beginAttempt({ taskId: 'nested', ownerId: 'worker-2', leaseMs: 1_000 }), 'workspace-overlap');
    code(() => store.beginAttempt({ taskId: 'sibling', ownerId: 'worker-2', leaseMs: 1_000 }), 'concurrency-limit');
    expect(store.markPacketReady({ attemptId: 'attempt-1', leaseToken: a.lease.token }).packetState).toBe('ready');
    staticAdmission(store, a);
    expect(store.listEvents().map(e => e.type)).toEqual(expect.arrayContaining(['packet.ready', 'packet.schema-valid', 'result.accepted']));
    expect(store.getAttempt('attempt-1')!.lifecycleState).toBe('starting');
  });
  it('cannot clear restart uncertainty through ordinary worker updates', () => {
    const { dir, store } = setup(); const a = start(store, dir); store.reconcileRun('run-1');
    code(() => store.updateAttempt('attempt-1', { lifecycleState: 'running' }, { leaseToken: a.lease.token }), 'reconciliation-required');
    expect(store.getLease('task-1')).toBeDefined();
  });
  it('detects persisted result content/digest corruption on reopen reads', () => {
    const { dir, path, store } = setup(); const a = start(store, dir); staticAdmission(store, a);
    const changed = staticH2Fixture(); changed.nextAction.action = 'Altered after admission';
    const tamper = new DatabaseSync(path); tamper.prepare('UPDATE results SET packet_json = ? WHERE result_id = ?').run(JSON.stringify(changed), 'packet-1'); tamper.close();
    code(() => store.getResult('packet-1'), 'result-integrity');
  });
  it('exports beyond one page without losing events or returning raw payload strings', () => {
    const { store } = setup(); store.createRun(runFixture());
    store.transaction(s => { for (let i = 0; i < 1_005; i++) s.appendEvent({ runId: 'run-1', type: 'fixture.receipt', payload: { sequence: i, notes: 'not exportable' } }); });
    const lines = store.exportJsonl().trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(1_006); expect(lines.at(-1).sequence).toBe(1_006); expect(lines.at(-1).payload.notes).toBeUndefined();
    expect(store.exportJsonl({ afterSequence: 1_000 }).trim().split('\n')).toHaveLength(6);
  });
  it('recovers committed WAL receipts after SIGKILL and discards an uncommitted event/outbox pair', () => {
    const { path, store } = setup(); store.createRun(runFixture());
    const crash = (commit: boolean, eventId: string) => spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(path)});
      db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
      const row = db.prepare('INSERT INTO events(event_id,run_id,type,occurred_at,payload_json) VALUES (?,?,?,?,?)').run(${JSON.stringify(eventId)}, 'run-1', 'fixture.crash', ${JSON.stringify(NOW)}, '{}');
      db.prepare('INSERT INTO outbox(event_sequence,available_at) VALUES (?,?)').run(row.lastInsertRowid, ${JSON.stringify(NOW)});
      ${commit ? "db.exec('COMMIT');" : ''}
      process.kill(process.pid, 'SIGKILL');
    `], { encoding: 'utf8', timeout: 10_000 });
    expect(crash(true, 'committed-event').signal).toBe('SIGKILL');
    expect(crash(false, 'uncommitted-event').signal).toBe('SIGKILL');
    store.close(); const restored = reopen(path);
    expect(restored.listEvents().map(e => e.eventId)).toContain('committed-event');
    expect(restored.listEvents().map(e => e.eventId)).not.toContain('uncommitted-event');
    expect(restored.listEvents()).toHaveLength(2); expect(restored.listOutbox()).toHaveLength(2);
  });
});

describe('selection-only runtime overrides for managed handoff', () => {
  const replacementSelection = { provider: 'replacement-provider', model: 'replacement-model', thinking: 'high' } as const;
  const selectionOnly = (): RequestedRuntime => ({ ...runFixture().requestedRuntime, selection: { ...replacementSelection } });
  const terminate = (store: DurableStore, lease: AttemptLease) => {
    store.updateAttempt(lease.attempt.attemptId, { lifecycleState: 'failed' }, { leaseToken: lease.lease.token });
    store.releaseLease({ attemptId: lease.attempt.attemptId, leaseToken: lease.lease.token, terminationConfirmed: true });
  };
  const rawCounts = (path: string) => {
    const db = new DatabaseSync(path);
    const counts = { attempts: Number(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()!.n), leases: Number(db.prepare('SELECT COUNT(*) AS n FROM workspace_leases').get()!.n), generation: Number(db.prepare('SELECT generation FROM workspace_fences').get()!.generation) };
    db.close();
    return counts;
  };

  it('admits a replacement attempt with a different selection and accepts its matching packet', () => {
    const { dir, store } = setup(); const first = start(store, dir); terminate(store, first);
    const override = selectionOnly();
    const retry = store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', attemptId: 'attempt-2', requestedRuntime: override, leaseMs: 60_000 });
    expect(retry.attempt.requestedRuntime).toEqual(override); expect(retry.attempt.requestedRuntime).not.toEqual(runFixture().requestedRuntime);
    const packet = staticH2Fixture(); packet.packetId = 'packet-replacement'; packet.attemptId = 'attempt-2'; packet.producer.id = 'worker-2'; packet.requestedRuntime = override; packet.observedRuntime.selection = { ...replacementSelection };
    store.putEvidence(evidenceFixture());
    const admitted = store.admitResult({ packet, idempotencyKey: 'replacement-key', leaseToken: retry.lease.token, reviewerId: 'reviewer-1' });
    expect(admitted.decision.status).toBe('accepted'); expect(admitted.decision.reasons.map(r => r.code)).not.toContain('runtime-request');
    expect(store.getTask('task-1')!.packetState).toBe('accepted'); expect(store.getTask('task-1')!.requestedRuntime).toEqual(runFixture().requestedRuntime);
  });

  it('rejects adapter and capability changes without creating attempt, lease or fence rows', () => {
    const { dir, path, store } = setup(); const first = start(store, dir); terminate(store, first);
    const before = rawCounts(path); expect(before).toEqual({ attempts: 1, leases: 0, generation: 1 });
    const taskRuntime = runFixture().requestedRuntime;
    code(() => store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', requestedRuntime: { ...taskRuntime, adapter: 'different-adapter' }, leaseMs: 1_000 }), 'runtime-override-adapter');
    code(() => store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', requestedRuntime: { ...taskRuntime, requiredCapabilities: ['canHardStop'] }, leaseMs: 1_000 }), 'runtime-override-capabilities');
    code(() => store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', requestedRuntime: { ...taskRuntime, requiredCapabilities: [] }, leaseMs: 1_000 }), 'runtime-override-capabilities');
    const invalid = { adapter: 'inert-fixture', selection: { provider: 'fixture-provider', model: 'fixture-model', thinking: 'impossible' }, requiredCapabilities: ['ownsLifecycle'] };
    expect(() => store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', requestedRuntime: invalid as unknown as RequestedRuntime, leaseMs: 1_000 })).toThrow(ValidationError);
    expect(rawCounts(path)).toEqual(before); expect(store.getLease('task-1')).toBeUndefined(); expect(store.listAttempts('run-1')).toHaveLength(1);
    const retry = store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', leaseMs: 1_000 });
    expect(retry.attempt.sequence).toBe(2); expect(retry.lease.generation).toBe(2);
  });

  it('compares required capabilities as an order-insensitive set and preserves the override order', () => {
    const { dir, store } = setup(); store.createRun(runFixture());
    const task = taskFixture('task-1', join(dir, 'work', 'task-1')); task.requestedRuntime = { ...task.requestedRuntime, requiredCapabilities: ['ownsLifecycle', 'streamsEvents'] };
    store.createTask(task);
    const override: RequestedRuntime = { adapter: 'inert-fixture', selection: { provider: 'replacement-provider', model: 'replacement-model', thinking: 'max' }, requiredCapabilities: ['streamsEvents', 'ownsLifecycle'] };
    const attempt = store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', requestedRuntime: override, leaseMs: 60_000 });
    expect(attempt.attempt.requestedRuntime.requiredCapabilities).toEqual(['streamsEvents', 'ownsLifecycle']); terminate(store, attempt);
    code(() => store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-3', requestedRuntime: { ...override, requiredCapabilities: ['streamsEvents'] }, leaseMs: 1_000 }), 'runtime-override-capabilities');
    expect(store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-3', requestedRuntime: { ...override, requiredCapabilities: ['ownsLifecycle', 'streamsEvents'] }, leaseMs: 1_000 }).attempt.sequence).toBe(2);
  });

  it('persists the replacement selection without rewriting the task audit request or leaking fencing tokens', () => {
    const { dir, path, store } = setup(); const first = start(store, dir); terminate(store, first);
    const override = selectionOnly();
    const retry = store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-2', attemptId: 'attempt-2', requestedRuntime: override, leaseMs: 60_000 });
    const observed = { adapter: override.adapter, selection: { ...replacementSelection }, capabilities: { ownsLifecycle: true, canHardStop: true, canResume: false, streamsEvents: true, attestsRuntime: false }, attestation: 'reported' as const, observedAt: now, receiptEvidenceIds: [] };
    store.updateAttempt('attempt-2', { lifecycleState: 'running', observedRuntime: observed }, { leaseToken: retry.lease.token });
    expect(store.getAttempt('attempt-2')!.requestedRuntime).toEqual(override);
    expect(store.listAttempts('run-1', 'task-1').map(a => a.requestedRuntime)).toEqual([runFixture().requestedRuntime, override]);
    expect(store.getTask('task-1')!.requestedRuntime).toEqual(runFixture().requestedRuntime);
    const exported = store.exportJsonl({ runId: 'run-1' });
    expect(exported).toContain('replacement-provider'); expect(exported).toContain('replacement-model');
    expect(exported).not.toContain(retry.lease.token);
    store.close(); const restored = reopen(path);
    expect(restored.getAttempt('attempt-2')!.requestedRuntime).toEqual(override);
    expect(restored.listAttempts('run-1', 'task-1')[1].requestedRuntime).toEqual(override);
  });
});
