import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openStore, type DurableStore } from '../../src/store/index.js';
import { digestJson } from '../../src/contracts/index.js';
import { registerP2O } from '../../extensions/p2o/index.js';
import { createSupervisorBackend, type SupervisorPort } from '../../src/interface/supervisor-backend.js';
import { fakePi } from './helpers.js';

const NOW = '2026-10-02T10:00:00.000Z';
const HASH = 'a'.repeat(64);
const CONFIG = 'b'.repeat(64);

function runManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, runId: 'run-1', createdAt: '2026-10-02T09:59:00.000Z', state: 'active',
    authorization: { reference: 'owner-approved-local-fixture', authorizedBy: 'fixture-owner',
      validFrom: '2026-10-02T09:00:00.000Z', expiresAt: '2026-10-02T12:00:00.000Z',
      targets: [{ id: 'fixture', kind: 'lab', locator: 'fixtures/local-lab' }], exclusions: [], allowedActions: ['review', 'local-test'] },
    budgets: { deadlineAt: '2026-10-02T11:30:00.000Z', maxRequests: 10, maxBytes: 1_000_000, maxToolCalls: 100, maxTokens: 10_000, maxCostUsd: 10,
      maxAttempts: 3, maxTasks: 10, maxDepth: 3, maxConcurrency: 3, reportReserveMs: 60_000, targetRequestLimits: { fixture: 5 } },
    requestedRuntime: { adapter: 'headless', selection: { provider: 'fixture-provider', model: 'fixture-model', thinking: 'max' }, requiredCapabilities: ['ownsLifecycle'] },
    allowedCapabilities: ['source.read', 'local.test'],
    ...overrides,
  };
}
function sourceFixtureManifest() {
  const run = runManifest();
  return runManifest({
    authorization: { ...run.authorization, targets: [...run.authorization.targets,
      { id: 'source', kind: 'artifact', locator: 'fixtures/input.ts', digest: HASH, revision: 'r1' }] },
    budgets: { ...run.budgets, targetRequestLimits: { ...run.budgets.targetRequestLimits, source: 0 } },
  });
}
function taskManifest(workspace: string) {
  const run = runManifest();
  return { schemaVersion: 1, runId: 'run-1', taskId: 'task-1', dependencyTaskIds: [], depth: 0, createdAt: '2026-10-02T09:59:30.000Z', inputRevision: 'r1',
    question: { text: 'Is the local fixture invariant enforced?', ifTrue: 'comparison differs', ifFalse: 'comparison does not differ' },
    scope: { authorizationRef: 'owner-approved-local-fixture', targetIds: ['fixture'], actor: { id: 'local-reader', privileges: ['read-only'] },
      boundary: 'local fixture only', isolation: 'inert local lab', recovery: 'discard generated outputs', environmentId: 'lab-1', configurationDigest: CONFIG,
      inputs: [{ id: 'fixture', digest: HASH, locator: 'fixtures/input.ts', revision: 'r1' }] },
    skills: [], allowedActions: ['review'], requiredCapabilities: ['source.read'],
    budgets: { deadlineAt: '2026-10-02T11:00:00.000Z', maxRequests: 5, maxBytes: 100_000, maxToolCalls: 20, maxTokens: 2_000, maxCostUsd: 2, maxAttempts: 3 },
    requestedRuntime: run.requestedRuntime, workspace, lifecycleState: 'queued', packetState: 'draft' };
}
function evidence(runId: string) {
  return { schemaVersion: 1, evidenceId: 'receipt-1', runId, taskId: 'task-1', attemptId: 'attempt-1', kind: 'source', classification: 'static-inference',
    digest: HASH, locator: 'receipts/receipt-1.json', mediaType: 'application/json', byteLength: 120, summary: 'api_key=DO_NOT_EXPOSE redacted local observation', redacted: true,
    provenance: { collectorId: 'collector-1', trust: 'collector', method: 'bounded-read', collectedAt: '2026-10-02T09:59:45.000Z',
      tool: { name: 'source.analyze', version: '1.0.0', options: ['token=DO_NOT_EXPOSE'] }, environmentId: 'lab-1', configurationDigest: CONFIG,
      inputDigests: [HASH], originalEnvironment: true, modifications: [] }, metadata: { ownerToken: 'DO_NOT_EXPOSE' } };
}
class FakeSupervisor implements SupervisorPort {
  calls: string[] = [];
  admissions: Parameters<SupervisorPort['admitRun']>[0][] = [];
  stopResult: unknown = { schedulingStopped: true, terminationVerified: true, failures: [] };
  preflightResult?: { issues: { code: string; message: string }[]; warnings: string[] };
  constructor(private readonly store: DurableStore) {}
  admitRun(request: Parameters<SupervisorPort['admitRun']>[0]) {
    this.calls.push('admitRun'); this.admissions.push(request); this.store.createRun(request.manifest); return { admitted: true };
  }
  start(runId: string) { this.calls.push(`start:${runId}`); return { runId }; }
  cancel(runId: string) { this.calls.push(`cancel:${runId}`); return this.stopResult; }
  recover(runId: string) { this.calls.push(`recover:${runId}`); return { unknown: [] }; }
  snapshot(runId: string) { this.calls.push(`snapshot:${runId}`); return { runId }; }
  preflight() { this.calls.push('preflight'); return this.preflightResult ?? { issues: [], warnings: ['fixture boundary is not a process sandbox'] }; }
}
async function harness(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-interface-store-'));
  await mkdir(join(root, 'workspace', 'task-1'), { recursive: true, mode: 0o700 });
  const store = openStore({ path: join(root, 'store.sqlite'), clock: () => NOW });
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  const supervisor = new FakeSupervisor(store);
  // Readiness requires a reporting path; tests that probe the unwired path build their own backend.
  const backend = createSupervisorBackend({ store, supervisor, now: () => Date.parse(NOW), closeStore: false,
    render: (runId, format) => ({ runId, format, acceptedOnly: true }) });
  const manifestPath = join(root, 'manifest.json');
  const write = (value: unknown) => writeFile(manifestPath, typeof value === 'string' ? value : JSON.stringify(value));
  await write(runManifest());
  return { root, store, supervisor, backend, manifestPath, write, workspace: join(root, 'workspace', 'task-1'),
    start: { manifestPath, mode: 'fixture' as const } };
}

test('preflight performs no durable mutation and reports hook warnings; start admits then launches in order', async t => {
  const s = await harness(t);
  const preflight = await s.backend.preflight(s.start);
  assert.equal(preflight.ok, true);
  assert.equal(preflight.runId, 'run-1');
  assert.deepEqual(preflight.requested, { adapter: 'headless', selection: { provider: 'fixture-provider', model: 'fixture-model', thinking: 'max' } });
  assert.match(preflight.warnings.join(' '), /not a process sandbox/);
  assert.equal(s.store.listRuns().length, 0);
  assert.deepEqual(s.supervisor.calls, ['preflight']);
  const handle = await s.backend.start(s.start);
  assert.deepEqual(handle, { runId: 'run-1', mode: 'fixture' });
  assert.deepEqual(s.supervisor.calls.slice(1), ['admitRun', 'start:run-1']);
  assert.equal(s.store.listRuns()[0].runId, 'run-1');
  await assert.rejects(s.backend.start(s.start), /RUN_EXISTS/);
  const snapshot = await s.backend.status('run-1');
  assert.equal(snapshot.mode, 'fixture');
});

test('Pi fixture path admits lab plus approved source artifacts, keeps the fixture receipt and resumes unchanged', async t => {
  const s = await harness(t);
  const approved = sourceFixtureManifest();
  await s.write(approved);
  const pi = fakePi();
  registerP2O(pi.api, { backendFactory: () => s.backend });
  try {
    const preflight = await pi.call('p2o_preflight', s.start);
    assert.equal((preflight.details as { ok: boolean }).ok, true);
    assert.equal((preflight.details as { mode: string }).mode, 'fixture');
    assert.equal(s.store.listRuns().length, 0, 'source eligibility never admits a run at preflight');
    const started = await pi.call('p2o_start', s.start);
    assert.equal((started.details as { mode: string }).mode, 'fixture');
    assert.equal((started.details as { resultAcceptance: string }).resultAcceptance, 'not-evaluated');
    assert.deepEqual(s.supervisor.admissions, [{ manifest: approved, mode: 'fixture' }],
      'the exact lab/source manifest still goes to trusted supervisor admission');
    assert.deepEqual(s.store.getRun('run-1')!.authorization, approved.authorization);
    assert.deepEqual(s.store.getRun('run-1')!.budgets.targetRequestLimits, { fixture: 5, source: 0 });
    const admitted = s.store.listEvents({ runId: 'run-1' }).find(event => event.type === 'run.admitted')!;
    assert.deepEqual(admitted.payload, { mode: 'fixture', manifestDigest: digestJson(approved) });
    const resumed = await pi.call('p2o_resume', { ...s.start, runId: 'run-1' });
    assert.equal((resumed.details as { mode: string }).mode, 'fixture');
    assert.deepEqual(s.supervisor.calls.slice(-2), ['recover:run-1', 'start:run-1']);
    assert.equal(s.supervisor.admissions.length, 1, 'resume does not re-admit or relabel source-assisted fixtures');
    assert.equal((await s.backend.status('run-1')).mode, 'fixture');
  } finally { await pi.event('session_shutdown'); }
});

test('fixture denies every approved web/service target, alone or alongside lab/source inputs, without dispatch', async t => {
  const s = await harness(t);
  const fixture = sourceFixtureManifest();
  await s.write(fixture);
  assert.equal((await s.backend.preflight(s.start)).ok, true);
  const calls = [...s.supervisor.calls];
  const pi = fakePi();
  registerP2O(pi.api, { backendFactory: () => s.backend });
  // URL identities only: no DNS lookup, connection, target request or scan is performed.
  const liveTargets = [
    { id: 'live', kind: 'web', locator: 'https://assessment.invalid/' },
    { id: 'live', kind: 'web', locator: 'http://127.0.0.1:8080/' },
    { id: 'live', kind: 'service', locator: 'tcp://assessment.invalid:443' },
    { id: 'live', kind: 'service', locator: 'udp://127.0.0.1:53' },
  ];
  try {
    for (const target of liveTargets) for (const mixed of [false, true]) {
      await s.write(runManifest({
        authorization: { ...fixture.authorization, targets: mixed ? [...fixture.authorization.targets, target] : [target] },
        budgets: { ...fixture.budgets, targetRequestLimits: mixed ? { ...fixture.budgets.targetRequestLimits, live: 0 } : { live: 0 } },
      }));
      await assert.rejects(s.backend.preflight(s.start), /FIXTURE_SCOPE_INVALID/);
      await assert.rejects(s.backend.start(s.start), /FIXTURE_SCOPE_INVALID/, 'a prior valid preflight cannot authorize changed network scope');
      await assert.rejects(s.backend.resume({ ...s.start, runId: 'run-1' }), /FIXTURE_SCOPE_INVALID/);
      for (const name of ['p2o_preflight', 'p2o_doctor', 'p2o_start', 'p2o_resume']) {
        await assert.rejects(pi.call(name, name === 'p2o_resume' ? { ...s.start, runId: 'run-1' } : s.start), /FIXTURE_SCOPE_INVALID/);
      }
      assert.deepEqual(s.supervisor.calls, calls, 'no approval hook, admission, recovery or launch is reached for fixture network scope');
      assert.equal(s.store.listRuns().length, 0);
      assert.equal(s.store.listEvents({ runId: 'run-1' }).length, 0, 'denied network scope produces no admission/mode receipt');
    }
  } finally { await pi.event('session_shutdown'); }
});

test('source-assisted fixture eligibility preserves artifact digest/revision and exclusion validation', async t => {
  const s = await harness(t);
  const fixture = sourceFixtureManifest();
  const cases = [
    { ...fixture.authorization, targets: [...runManifest().authorization.targets,
      { id: 'source', kind: 'artifact', locator: 'fixtures/input.ts', revision: 'r1' }] },
    { ...fixture.authorization, targets: [...runManifest().authorization.targets,
      { id: 'source', kind: 'artifact', locator: 'fixtures/input.ts', digest: HASH }] },
    { ...fixture.authorization, exclusions: ['source'] },
  ];
  for (const authorization of cases) {
    await s.write(runManifest({ authorization, budgets: fixture.budgets }));
    await assert.rejects(s.backend.preflight(s.start), /digest and revision|explicit exclusion/);
    await assert.rejects(s.backend.start(s.start), /digest and revision|explicit exclusion/);
  }
  assert.deepEqual(s.supervisor.calls, []);
  assert.equal(s.store.listRuns().length, 0);
});

test('lab/source fixture eligibility is not approval: trusted preflight and dispatch denial stay authoritative', async t => {
  const s = await harness(t);
  await s.write(sourceFixtureManifest());
  const pi = fakePi();
  registerP2O(pi.api, { backendFactory: () => s.backend });
  s.supervisor.preflightResult = { issues: [{ code: 'OWNER_APPROVAL_REQUIRED', message: 'the exact lab/source proposal is not approved' }], warnings: [] };
  try {
    const preflight = await pi.call('p2o_preflight', s.start);
    assert.equal((preflight.details as { ok: boolean }).ok, false);
    await assert.rejects(pi.call('p2o_start', s.start), /PREFLIGHT_BLOCKED.*OWNER_APPROVAL_REQUIRED/);
    assert.deepEqual(s.supervisor.calls, ['preflight', 'preflight']);
    s.supervisor.preflightResult = { issues: [], warnings: [] };
    assert.equal((await s.backend.preflight(s.start)).ok, true);
    s.supervisor.admitRun = () => { s.supervisor.calls.push('admitRun:denied'); throw new Error('OWNER_APPROVAL_REQUIRED'); };
    await assert.rejects(s.backend.start(s.start), /OWNER_APPROVAL_REQUIRED/);
    assert.ok(!s.supervisor.calls.includes('start:run-1'));
    assert.equal(s.store.listRuns().length, 0);
    assert.equal(s.store.listEvents({ runId: 'run-1' }).length, 0);
  } finally { await pi.event('session_shutdown'); }
});

test('lab/source fixtures retain absolute deadline and authorization checks at dispatch and after recovery', async t => {
  for (const [code, expiredAt] of [
    ['DEADLINE_PASSED', '2026-10-02T11:30:00.000Z'],
    ['AUTHORIZATION_EXPIRED', '2026-10-02T12:00:00.000Z'],
  ]) {
    const s = await harness(t);
    await s.write(sourceFixtureManifest());
    let at = Date.parse(NOW);
    const backend = createSupervisorBackend({ store: s.store, supervisor: s.supervisor, now: () => at,
      render: (runId, format) => ({ runId, format }) });
    assert.equal((await backend.preflight(s.start)).ok, true);
    at = Date.parse(expiredAt);
    await assert.rejects(backend.start(s.start), new RegExp(code));
    assert.equal(s.store.listRuns().length, 0, 'passing preflight does not extend the absolute window');
    at = Date.parse(NOW);
    await backend.start(s.start);
    s.supervisor.recover = runId => { s.supervisor.calls.push(`recover:${runId}`); at = Date.parse(expiredAt); return { unknown: [] }; };
    const launches = s.supervisor.calls.filter(call => call.startsWith('start:')).length;
    await assert.rejects(backend.resume({ ...s.start, runId: 'run-1' }), new RegExp(code));
    assert.ok(s.supervisor.calls.includes('recover:run-1'));
    assert.equal(s.supervisor.calls.filter(call => call.startsWith('start:')).length, launches, 'recovery may not launch past the window');
    assert.ok(!s.store.listEvents({ runId: 'run-1' }).some(event => event.type === 'run.resumed'));
  }
});

test('manifest and scope gates fail closed: malformed JSON, missing fields, expiry, deadline, fixture-as-fallback', async t => {
  const s = await harness(t);
  await s.write('{not json');
  await assert.rejects(s.backend.preflight(s.start), /MANIFEST_INVALID/);
  await s.write({ ...runManifest(), runId: '../escape' });
  await assert.rejects(s.backend.preflight(s.start), /run/i);
  await s.write(runManifest({ createdAt: '2026-10-02T08:30:00.000Z',
    authorization: { ...runManifest().authorization, validFrom: '2026-10-02T08:00:00.000Z', expiresAt: '2026-10-02T09:30:00.000Z' },
    budgets: { ...runManifest().budgets, deadlineAt: '2026-10-02T09:20:00.000Z' } }));
  const expired = await s.backend.preflight(s.start);
  assert.equal(expired.ok, false);
  assert.deepEqual(expired.issues.map(i => i.code), ['AUTHORIZATION_EXPIRED']);
  await assert.rejects(s.backend.start(s.start), /AUTHORIZATION_EXPIRED/);
  await s.write(runManifest({ budgets: { ...runManifest().budgets, deadlineAt: '2026-10-02T09:59:30.000Z', reportReserveMs: 1000 } }));
  assert.deepEqual((await s.backend.preflight(s.start)).issues.map(i => i.code), ['DEADLINE_PASSED']);
  await s.write(runManifest({ authorization: { ...runManifest().authorization, targets: [{ id: 'fixture', kind: 'web', locator: 'https://assessment.invalid/' }] } }));
  await assert.rejects(s.backend.start(s.start), /FIXTURE_SCOPE_INVALID/);
  assert.equal(s.store.listRuns().length, 0);
});

test('managed runs reject plan/dry-run adapters and leave no durable run', async t => {
  const s = await harness(t);
  const fixture = sourceFixtureManifest();
  for (const adapter of ['plan', 'plan-only', 'dry-run', 'unmanaged-preview']) {
    await s.write({ ...fixture, requestedRuntime: { ...fixture.requestedRuntime, adapter } });
    await assert.rejects(s.backend.preflight(s.start), /UNMANAGED_RUNTIME_REJECTED/);
    await assert.rejects(s.backend.start(s.start), /UNMANAGED_RUNTIME_REJECTED/);
  }
  await s.write(fixture);
  const preflight = await s.backend.preflight(s.start);
  assert.equal(preflight.ok, true);
  assert.deepEqual(preflight.issues, []);
  assert.equal(s.store.listRuns().length, 0);
});

test('preflight readiness fails closed when the trusted reporting port is missing', async t => {
  const s = await harness(t);
  const unwired = createSupervisorBackend({ store: s.store, supervisor: s.supervisor, now: () => Date.parse(NOW) });
  const preflight = await unwired.preflight(s.start);
  assert.equal(preflight.ok, false);
  assert.deepEqual(preflight.issues.map(i => i.code), ['INTEGRATION_REQUIRED']);
  assert.ok(!preflight.warnings.some(w => /vault-backed report renderer/.test(w)), 'readiness blockers are issues, not warnings');
  assert.equal(s.store.listRuns().length, 0);
});

test('caller runtime selection is a request recorded on the run; supervisor admission still revalidates', async t => {
  const s = await harness(t);
  await s.backend.start({ ...s.start, runtime: 'herdr', selection: { provider: 'requested-only', model: 'requested-model', thinking: 'low' } });
  const run = s.store.getRun('run-1')!;
  assert.equal(run.requestedRuntime.adapter, 'herdr');
  assert.deepEqual(run.requestedRuntime.selection, { provider: 'requested-only', model: 'requested-model', thinking: 'low' });
  assert.equal(run.requestedRuntime.requiredCapabilities[0], 'ownsLifecycle');
});

test('resume gates identity and terminal state, reconciles before launching and records the resume', async t => {
  const s = await harness(t);
  await s.backend.start(s.start);
  await s.backend.resume({ ...s.start, runId: 'run-1' });
  assert.deepEqual(s.supervisor.calls.slice(-2), ['recover:run-1', 'start:run-1']);
  assert.ok(s.store.listEvents({ runId: 'run-1' }).some(e => e.type === 'run.resumed'));
  s.store.setRunState('run-1', 'cancelled');
  await assert.rejects(s.backend.resume({ ...s.start, runId: 'run-1' }), /RUN_TERMINAL/);
  await s.write(runManifest({ runId: 'run-9' }));
  await assert.rejects(s.backend.resume({ ...s.start, runId: 'run-9' }), /RUN_NOT_FOUND/);
});

test('resume identity mismatch is caught by preflight and by dispatch', async t => {
  const s = await harness(t);
  await s.backend.start(s.start);
  const mismatch = await s.backend.preflight({ ...s.start, runId: 'run-2' });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.issues.some(i => i.code === 'RUN_IDENTITY_MISMATCH' || i.code === 'RUN_EXISTS'));
  await assert.rejects(s.backend.resume({ ...s.start, runId: 'run-2' }), /RUN_IDENTITY_MISMATCH/);
});

test('resume refuses a supplied manifest that renegotiates scope, budget, runtime identity or mode', async t => {
  const s = await harness(t);
  const base = sourceFixtureManifest();
  await s.write(base);
  await s.backend.start(s.start);
  const dispatches = s.supervisor.calls.filter(call => /^(?:recover|start):/.test(call));
  const cases: Array<[string, Record<string, unknown>]> = [
    ['authorization', { ...base, authorization: { ...base.authorization, expiresAt: '2026-10-02T13:00:00.000Z' } }],
    ['authorization', { ...base, authorization: { ...base.authorization, targets: base.authorization.targets.map(target =>
      target.id === 'source' ? { ...target, digest: 'c'.repeat(64) } : target) } }],
    ['authorization', { ...base, authorization: { ...base.authorization, targets: base.authorization.targets.map(target =>
      target.id === 'source' ? { ...target, revision: 'r2' } : target) } }],
    ['budgets', { ...base, budgets: { ...base.budgets, maxRequests: base.budgets.maxRequests + 1 } }],
    ['requestedRuntime', { ...base, requestedRuntime: { ...base.requestedRuntime, adapter: 'other-runtime' } }],
    ['allowedCapabilities', { ...base, allowedCapabilities: [...base.allowedCapabilities, 'source.write'] }],
  ];
  for (const [label, supplied] of cases) {
    await s.write(supplied);
    const preflight = await s.backend.preflight({ ...s.start, runId: 'run-1' });
    assert.equal(preflight.ok, false, `${label} widening must not pass preflight`);
    assert.deepEqual(preflight.issues.map(i => i.code), ['RUN_IDENTITY_MISMATCH'], `${label} mismatch is named`);
    assert.match(preflight.issues[0].message, new RegExp(label), `${label} mismatch reports the field`);
    await assert.rejects(s.backend.resume({ ...s.start, runId: 'run-1' }), /RUN_IDENTITY_MISMATCH/);
  }
  await s.write(base);
  for (const override of [{ runtime: 'herdr' as const }, { selection: { ...base.requestedRuntime.selection, thinking: 'low' as const } }]) {
    const request = { ...s.start, runId: 'run-1', ...override };
    const preflight = await s.backend.preflight(request);
    assert.deepEqual(preflight.issues.map(i => i.code), ['RUN_IDENTITY_MISMATCH']);
    assert.match(preflight.issues[0].message, /requestedRuntime/);
    await assert.rejects(s.backend.resume(request), /RUN_IDENTITY_MISMATCH/);
  }
  const mode = await s.backend.preflight({ ...s.start, runId: 'run-1', mode: 'assessment' });
  assert.equal(mode.ok, false);
  assert.deepEqual(mode.issues.map(i => i.code), ['MODE_MISMATCH']);
  await assert.rejects(s.backend.resume({ ...s.start, runId: 'run-1', mode: 'assessment' }), /MODE_MISMATCH/);
  assert.deepEqual(s.supervisor.calls.filter(call => /^(?:recover|start):/.test(call)), dispatches, 'refused identity/mode changes never recover or launch');
  assert.equal(s.store.listRuns().length, 1, 'refused resumes admitted no duplicate run');
});

test('stop surfaces only attested termination; unverified cancellation keeps failures visible', async t => {
  const s = await harness(t);
  await s.backend.start(s.start);
  const verified = await s.backend.stop('run-1', 'test cancellation');
  assert.deepEqual(verified, { runId: 'run-1', schedulingStopped: true, terminationVerified: true, failures: [] });
  s.supervisor.stopResult = { schedulingStopped: true, terminationVerified: false, failures: [{ code: 'PROCESS_ALIVE', message: 'descendant still running' }] };
  const unverified = await s.backend.stop('run-1', 'test cancellation');
  assert.equal(unverified.terminationVerified, false);
  assert.deepEqual([...unverified.failures.map(f => f.code)].sort(), ['PROCESS_ALIVE', 'TERMINATION_UNVERIFIED']);
  s.supervisor.stopResult = {};
  assert.equal((await s.backend.stop('run-1', 'test cancellation')).terminationVerified, false);
  await assert.rejects(s.backend.stop('absent', 'test cancellation'), /RUN_NOT_FOUND/);
});

test('status derives failures and returned packets from durable state without claiming acceptance', async t => {
  const s = await harness(t);
  await s.backend.start(s.start);
  s.store.createTask(taskManifest(s.workspace));
  const attempt = s.store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-1', leaseMs: 60_000 });
  s.store.updateAttempt(attempt.attempt.attemptId, { lifecycleState: 'failed', exit: { code: 1, observedAt: NOW } }, { leaseToken: attempt.lease.token });
  const snapshot = await s.backend.status('run-1');
  assert.equal(snapshot.mode, 'fixture');
  assert.equal(snapshot.attempts.length, 1);
  assert.equal((snapshot.failures[0] as { code: string }).code, 'FAILED');
  assert.ok(snapshot.packets.length === 0);
});

test('attempt-started events never surface fencing tokens; only collector-redacted display text is exposed', async t => {
  const s = await harness(t);
  await s.backend.start(s.start);
  s.store.createTask(taskManifest(s.workspace));
  const attempt = s.store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-1', leaseMs: 60_000 });
  s.store.appendEvent({ runId: 'run-1', type: 'collector.log', payload: { redacted: true, redactedKind: 'log', redactedText: '<img src=x onerror=alert(1)> token=DO_NOT_EXPOSE' } });
  const page = await s.backend.events('run-1', { afterSequence: 0, limit: 50 });
  const serialized = JSON.stringify(page);
  assert.ok(!serialized.includes(attempt.lease.token));
  assert.ok(!serialized.includes('generation'));
  const started = page.items.find(i => i.type === 'attempt.started')!;
  assert.equal(started.display, undefined);
  assert.deepEqual(Object.keys(started).sort(), ['attemptId', 'eventId', 'occurredAt', 'sequence', 'taskId', 'type']);
  const display = page.items.find(i => i.type === 'collector.log')!.display!;
  assert.equal(display.kind, 'log');
  assert.match(display.text, /DO_NOT_EXPOSE/, 'collector-redacted display text is surfaced only because a trusted collector opted in');
  const raw = s.store.listEvents({ runId: 'run-1' }).find(e => e.type === 'attempt.started')!;
  assert.equal((raw.payload as Record<string, unknown>).leaseToken, attempt.lease.token);
  const gaps = await s.backend.events('run-1', { afterSequence: 0, limit: 1 });
  assert.equal(gaps.gap, true);
  assert.equal(gaps.items.length, 1);
});

test('evidence and report ports are metadata-only and report fails closed without vault-backed rendering', async t => {
  const s = await harness(t);
  await s.backend.start(s.start);
  s.store.createTask(taskManifest(s.workspace));
  const attempt = s.store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-1', attemptId: 'attempt-1', leaseMs: 60_000 });
  s.store.putEvidence(evidence('run-1'));
  assert.equal(attempt.attempt.attemptId, 'attempt-1');
  const listed = await s.backend.evidence('run-1', { offset: 0, limit: 10 });
  assert.equal(listed.total, 1);
  assert.equal((listed.items[0] as { evidenceId: string }).evidenceId, 'receipt-1');
  assert.equal((await s.backend.evidence('run-1', { offset: 0, limit: 10 }, 'absent')).total, 0);
  const unwired = createSupervisorBackend({ store: s.store, supervisor: s.supervisor, now: () => Date.parse(NOW) });
  await assert.rejects(unwired.report('run-1', 'json'), /INTEGRATION_REQUIRED/);
  assert.deepEqual((await s.backend.report('run-1', 'markdown')).content, { runId: 'run-1', format: 'markdown', acceptedOnly: true });
  assert.equal(s.store.getRun('run-1')!.runId, 'run-1');
});

test('end-to-end Pi registration against the real durable store keeps states separate and leaks nothing', async t => {
  const s = await harness(t);
  const pi = fakePi();
  registerP2O(pi.api, { backendFactory: () => s.backend });
  const startResult = await pi.call('p2o_start', s.start);
  assert.equal((startResult.details as { launched: boolean }).launched, true);
  assert.equal((startResult.details as { resultAcceptance: string }).resultAcceptance, 'not-evaluated');
  const status = await pi.call('p2o_status', { runId: 'run-1' });
  assert.equal((status.details as { mode: string }).mode, 'fixture');
  assert.match((status.details as { qualification: string }).qualification, /independent/);
  const tasks = await pi.call('p2o_tasks', { runId: 'run-1' });
  assert.equal((tasks.details as { total: number }).total, 0);
  const stopped = await pi.call('p2o_stop', { runId: 'run-1' });
  assert.equal((stopped.details as { terminationVerified: boolean }).terminationVerified, true);
  assert.ok(s.supervisor.calls.includes('cancel:run-1'));
  assert.ok(!JSON.stringify(pi.messages).includes('DO_NOT_EXPOSE'));
});

test('store-backed backend never treats a foreign run or closed store as success', async t => {
  const s = await harness(t);
  await assert.rejects(s.backend.status('run-404'), /RUN_NOT_FOUND/);
  await assert.rejects(s.backend.events('run-404', { afterSequence: 0, limit: 5 }), /RUN_NOT_FOUND/);
  await assert.rejects(s.backend.report('run-404', 'json'), /RUN_NOT_FOUND/);
  await assert.rejects(s.backend.tasks('run-404', { offset: 0, limit: 5 }), /RUN_NOT_FOUND/);
  s.store.close();
  assert.throws(() => s.store.getRun('run-1'));
});

