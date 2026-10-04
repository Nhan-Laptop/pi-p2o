import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openStore } from '../../src/store/index.js';
import { registerP2O } from '../../extensions/p2o/index.js';
import { createOrchestratorPort } from '../../src/interface/orchestrator-port.js';
import { createSupervisorBackend } from '../../src/interface/supervisor-backend.js';
import { fakePi } from './helpers.js';

const NOW = '2026-10-02T10:00:00.000Z';

function manifest() {
  return {
    schemaVersion: 1, runId: 'run-1', createdAt: '2026-10-02T09:59:00.000Z', state: 'active',
    authorization: { reference: 'owner-approved-local-fixture', authorizedBy: 'fixture-owner',
      validFrom: '2026-10-02T09:00:00.000Z', expiresAt: '2026-10-02T12:00:00.000Z',
      targets: [{ id: 'fixture-a', kind: 'lab', locator: 'fixtures/a' }, { id: 'fixture-b', kind: 'lab', locator: 'fixtures/b' }],
      exclusions: [], allowedActions: ['review'] },
    budgets: { deadlineAt: '2026-10-02T11:30:00.000Z', maxRequests: 10, maxBytes: 1_000_000, maxToolCalls: 100, maxTokens: 10_000, maxCostUsd: 10,
      maxAttempts: 3, maxTasks: 10, maxDepth: 3, maxConcurrency: 3, reportReserveMs: 60_000, targetRequestLimits: { 'fixture-a': 5, 'fixture-b': 5 } },
    requestedRuntime: { adapter: 'headless', selection: { provider: 'fixture-provider', model: 'fixture-model', thinking: 'max' }, requiredCapabilities: ['ownsLifecycle'] },
    allowedCapabilities: ['source.read'],
  };
}
function fakeApi(store: { createRun(v: unknown): unknown }) {
  const calls: string[] = [];
  let admission: unknown;
  let state: unknown = { run: manifest(), mode: 'managed', tasks: [], attempts: [], results: [], coverage: [], outstandingLeases: [], draining: false };
  return {
    calls, get admission() { return admission; }, setSnapshot(value: unknown) { state = value; },
    admitRun(proposal: unknown) { calls.push('admitRun'); admission = proposal; store.createRun((proposal as { manifest: unknown }).manifest); return manifest(); },
    start(runId: string) { calls.push(`start:${runId}`); return { runId, mode: 'managed', wait: () => new Promise(() => {}), cancel: async () => state }; },
    async cancel(runId: string) { calls.push(`cancel:${runId}`); return state; },
    async recover(runId: string) { calls.push(`recover:${runId}`); return { runId }; },
    snapshot(runId: string) { calls.push(`snapshot:${runId}`); return state; },
    dispose() { calls.push('dispose'); },
    async tick() { return state; }, async wait() { return state; }, replace: async () => ({}), preview: () => ({}), worker: () => ({}),
    runtimeHooks: () => ({}), budgetJournal: () => ({}), consumeBudget: () => ({}), admitTask: () => ({}),
    async flushOutbox() { return { delivered: 0, retried: 0 }; },
  };
}
async function harness(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-orchestrator-port-'));
  await mkdir(join(root, 'workspace'), { recursive: true, mode: 0o700 });
  const store = openStore({ path: join(root, 'store.sqlite'), clock: () => NOW });
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const api = fakeApi(store);
  // The structural SupervisorApi type is enforced by the interface; the fixture supplies the used subset plus stubs.
  const port = createOrchestratorPort(api as never, { runtimes: { headless: { kind: 'headless', capabilities: { ownsLifecycle: true } } } });
  const backend = createSupervisorBackend({ store, supervisor: port, now: () => Date.parse(NOW),
    render: (runId, format) => ({ runId, format }) });
  const manifestPath = join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest()));
  return { root, store, api, port, backend, start: { manifestPath, mode: 'fixture' as const } };
}

test('admission always requests managed mode with exact per-target concurrency for every approved target', async t => {
  const s = await harness(t);
  await s.backend.start(s.start);
  const admission = s.api.admission as { mode: string; perTargetConcurrency: Record<string, number> };
  assert.equal(admission.mode, 'managed');
  assert.deepEqual(Object.keys(admission.perTargetConcurrency).sort(), ['fixture-a', 'fixture-b']);
  assert.deepEqual(Object.values(admission.perTargetConcurrency), [1, 1]);
  const other = fakeApi({ createRun: () => undefined });
  const raised = createOrchestratorPort(other as never, { perTargetConcurrency: 9 });
  await raised.admitRun({ manifest: manifest() as never, mode: 'fixture' });
  // Requested concurrency is clamped to the run's own global concurrency budget, never widened.
  assert.deepEqual(Object.values((other.admission as { perTargetConcurrency: Record<string, number> }).perTargetConcurrency), [3, 3]);
  // A non-integer grant fails closed instead of being rounded or silently widened.
  assert.throws(() => createOrchestratorPort(other as never, { perTargetConcurrency: 0 }), /INTEGRATION_INVALID/);
  assert.throws(() => createOrchestratorPort(other as never, { perTargetConcurrency: 1.5 }), /INTEGRATION_INVALID/);
  assert.throws(() => createOrchestratorPort(other as never, { perTargetConcurrency: Number.NaN }), /INTEGRATION_INVALID/);
});

test('port preflight reports adapter readiness instead of deferring every check to dispatch', async t => {
  const s = await harness(t);
  const registered = await s.port.preflight!({ manifest: manifest() as never, mode: 'fixture' });
  assert.deepEqual(registered.issues ?? [], []);
  assert.deepEqual(registered.warnings ?? [], []);
  const unregistered = createOrchestratorPort(s.api as never, { runtimes: { herdr: { kind: 'herdr', capabilities: { ownsLifecycle: true } } } });
  assert.deepEqual(((await unregistered.preflight!({ manifest: manifest() as never, mode: 'fixture' })).issues ?? []).map(i => i.code), ['RUNTIME_NOT_REGISTERED']);
  const nonOwning = createOrchestratorPort(s.api as never, { runtimes: { headless: { kind: 'headless', capabilities: { ownsLifecycle: false } } } });
  assert.deepEqual(((await nonOwning.preflight!({ manifest: manifest() as never, mode: 'fixture' })).issues ?? []).map(i => i.code), ['UNMANAGED_RUNTIME_REJECTED']);
  const unknown = createOrchestratorPort(s.api as never);
  const readiness = await unknown.preflight!({ manifest: manifest() as never, mode: 'fixture' });
  assert.deepEqual(readiness.issues ?? [], []);
  assert.match((readiness.warnings ?? []).join(' '), /not supplied to the interface port/);
  // Preflight is read-only: no admission or launch happened for the probed manifests.
  assert.equal(s.store.listRuns().length, 0);
});

test('start returns before settlement: a never-settling ManagedRun cannot block the control plane', async t => {
  const s = await harness(t);
  const started = await Promise.race([s.backend.start(s.start).then(() => 'launched'), new Promise(resolve => setTimeout(() => resolve('blocked'), 250))]);
  assert.equal(started, 'launched');
  assert.ok(s.api.calls.includes('start:run-1'));
});

test('cancel derives verified termination only from supervisor ownership state', async t => {
  const s = await harness(t);
  await s.backend.start(s.start);
  assert.equal((await s.backend.stop('run-1', 'test')).terminationVerified, true);
  s.api.setSnapshot({ outstandingLeases: ['task-1'], draining: false, attempts: [] });
  const leased = await s.backend.stop('run-1', 'test');
  assert.equal(leased.terminationVerified, false);
  assert.deepEqual(leased.failures.map(f => f.code).sort(), ['OUTSTANDING_OWNERSHIP', 'TERMINATION_UNVERIFIED']);
  s.api.setSnapshot({ outstandingLeases: [], draining: true, attempts: [{ lifecycleState: 'running' }] });
  const draining = await s.backend.stop('run-1', 'test');
  assert.equal(draining.schedulingStopped, false);
  assert.deepEqual(draining.failures.map(f => f.code).sort(), ['ATTEMPT_NOT_TERMINAL', 'DRAINING', 'TERMINATION_UNVERIFIED']);
  s.api.setSnapshot({ opaque: true });
  const opaque = await s.backend.stop('run-1', 'test');
  assert.equal(opaque.terminationVerified, false);
  assert.deepEqual(opaque.failures.map(f => f.code), ['TERMINATION_UNVERIFIED']);
});

test('owner-side cancellation attestation hook is authoritative when supplied', async t => {
  const s = await harness(t);
  const port = createOrchestratorPort(s.api as never, { verifyCancellation: () => ({ terminationVerified: true, failures: [{ code: 'RESIDUAL_FILE', message: 'orphan artifact retained' }] }) });
  const result = await port.cancel('run-1') as { terminationVerified: boolean; failures: { code: string }[] };
  assert.equal(result.terminationVerified, true);
  assert.deepEqual(result.failures.map(f => f.code), ['RESIDUAL_FILE']);
});

test('status surfaces supervisor draining and outstanding leases; dispose runs on close', async t => {
  const s = await harness(t);
  await s.backend.start(s.start);
  s.api.setSnapshot({ outstandingLeases: ['task-1'], draining: true, attempts: [] });
  const snapshot = await s.backend.status('run-1');
  assert.deepEqual(snapshot.failures.map(f => (f as { code: string }).code).sort(), ['DRAINING', 'OUTSTANDING_OWNERSHIP']);
  await s.backend.close();
  assert.ok(s.api.calls.includes('dispose'));
});

test('end-to-end Pi path over the supervisor port keeps requested/observed and acceptance separate', async t => {
  const s = await harness(t);
  const pi = fakePi();
  registerP2O(pi.api, { backendFactory: () => s.backend });
  await pi.call('p2o_start', s.start);
  s.api.setSnapshot({ run: manifest(), mode: 'managed', tasks: [], attempts: [], results: [], coverage: [], outstandingLeases: [], draining: false });
  const status = await pi.call('p2o_status', { runId: 'run-1' });
  assert.equal((status.details as { mode: string }).mode, 'fixture');
  assert.equal((status.details as { failures: unknown[] }).failures.length, 0);
  const stopped = await pi.call('p2o_stop', { runId: 'run-1' });
  assert.equal((stopped.details as { terminationVerified: boolean }).terminationVerified, true);
  s.store.setRunState('run-1', 'cancelled');
  await assert.rejects(pi.call('p2o_resume', { ...s.start, runId: 'run-1' }), /RUN_TERMINAL/);
});
