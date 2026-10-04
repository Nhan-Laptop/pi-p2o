/**
 * Seam smoke test for the interface ↔ real `src/orchestrator` supervisor (required; no SKIP path).
 * It admits ZERO tasks by design and is not an end-to-end assessment: it proves admission,
 * launch, status/event projection, resume guards, the wired report port and verified stop over
 * the real DurableStore. The authority and runtime adapter here are inert test doubles: no
 * process is spawned, no network/target traffic occurs, and the fixture boundary is never
 * described as isolation. The full fixture workflow is owned by the application slice.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestJson } from '../../src/contracts/index.js';
import { openStore } from '../../src/store/index.js';
import { createOrchestratorPort } from '../../src/interface/orchestrator-port.js';
import { createSupervisorBackend } from '../../src/interface/supervisor-backend.js';
import { registerP2O } from '../../extensions/p2o/index.js';
import { createSupervisor } from '../../src/orchestrator/index.js';
import { fakePi } from './helpers.js';
import type { RuntimeAdapter, RuntimeHandle, RuntimeRequest, RuntimeCheckpoint, PreflightReceipt, RuntimeCollection, RuntimeObservation, StopReceipt, ReconciliationReceipt } from '../../src/runtime/types.js';

const NOW = Date.parse('2026-10-02T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const HASH = 'a'.repeat(64);

function runManifest() {
  return {
    schemaVersion: 1, runId: 'run-inert-1', createdAt: iso(NOW - 60_000), state: 'active',
    authorization: { reference: 'owner-approved-inert-fixture', authorizedBy: 'integration-owner',
      validFrom: iso(NOW - 3_600_000), expiresAt: iso(NOW + 2 * 3_600_000),
      targets: [{ id: 'fixture', kind: 'lab', locator: 'fixtures/inert-local' },
        { id: 'source', kind: 'artifact', locator: 'fixtures/inert-source.ts', digest: HASH, revision: 'r1' }],
      exclusions: [], allowedActions: ['review'] },
    budgets: { deadlineAt: iso(NOW + 3_600_000), maxRequests: 10, maxBytes: 1_000_000, maxToolCalls: 100, maxTokens: 10_000, maxCostUsd: 10,
      maxAttempts: 3, maxTasks: 10, maxDepth: 3, maxConcurrency: 3, reportReserveMs: 60_000, targetRequestLimits: { fixture: 5, source: 0 } },
    requestedRuntime: { adapter: 'inert-fixture', selection: { provider: 'requested-only', model: 'requested-only', thinking: 'low' }, requiredCapabilities: ['ownsLifecycle'] },
    allowedCapabilities: ['source.analyze'],
  };
}
/** Test-only authority: approves exactly the canonical proposal it is handed. Never production. */
function inertAuthority() {
  const admissions: Array<{ mode: string; perTargetConcurrency: Record<string, number> }> = [];
  const approve = (proposal: unknown, run: { authorization: { reference: string; authorizedBy: string; expiresAt: string } }, deadlineAt: number) => ({
    allowed: true, digest: digestJson(proposal), authorizationRef: run.authorization.reference, approvedBy: run.authorization.authorizedBy,
    reference: `inert-test-approval-${run.authorization.reference}`, expiresAt: iso(Math.max(deadlineAt, NOW + 1_800_000)),
  });
  return {
    admissions,
    async verifyRun(proposal: never) {
      const admission = proposal as unknown as { mode: string; perTargetConcurrency: Record<string, number>; manifest: never };
      admissions.push({ mode: admission.mode, perTargetConcurrency: admission.perTargetConcurrency });
      return approve(proposal, admission.manifest as never, NOW + 2 * 3_600_000);
    },
    async approveTask() { throw new Error('inert integration scenario does not admit tasks'); },
    async approveReplacement() { throw new Error('inert integration scenario does not replace attempts'); },
  };
}
/** Inert adapter: capacity accounting is honest and no process exists. */
function inertRuntime(): RuntimeAdapter {
  const capability = { ownsLifecycle: true, canHardStop: true, canResume: false, streamsEvents: true, attestsRuntime: false, checkpoints: false, sandboxBoundTools: false };
  const handle = (request: RuntimeRequest): RuntimeHandle => ({ version: 1, kind: 'headless', runId: request.runId, taskId: request.taskId, attemptId: request.attemptId,
    ownerToken: 'inert-owner-token', workspace: request.workspace, scopeDigest: request.scopeDigest, inputDigest: request.inputDigest, deadlineAt: request.deadlineAt,
    requested: request.requested, toolPolicy: request.toolPolicy, createdAt: NOW, status: 'ready', controlDir: request.workspace, sessionFile: '', sessionId: 'inert-session',
    launchIntent: false, native: { processes: [] }, observed: [], events: [], nextCursor: 0, logTail: '', droppedLogBytes: 0 });
  return {
    kind: 'headless', capabilities: capability,
    async preflight(): Promise<PreflightReceipt> { return { ok: true, kind: 'headless', checkedAt: NOW, capabilities: capability, errors: [], warnings: ['inert test adapter: no process, no isolation claim'] }; },
    async start(request: RuntimeRequest): Promise<RuntimeHandle> { return handle(request); },
    async observe(current: RuntimeHandle): Promise<RuntimeObservation> { return { status: 'ready', events: [], cursor: current.nextCursor, gap: false, requested: current.requested, observed: [] }; },
    async checkpoint(current: RuntimeHandle, options?: { note?: string }): Promise<RuntimeCheckpoint> {
      void options;
      return { version: 1, id: 'inert-checkpoint-1', createdAt: NOW, handle: current, session: { path: '', sha256: HASH, id: 'inert-session', bytes: 0 },
        termination: { reason: 'checkpoint', at: NOW, verified: false, survivors: [] }, restoredToolProcesses: false };
    },
    async stop(): Promise<StopReceipt> { return { reason: 'cancelled', at: NOW, verified: true, survivors: [] }; },
    async resume(_checkpoint: RuntimeCheckpoint, request: RuntimeRequest): Promise<RuntimeHandle> { return handle(request); },
    async collect(current: RuntimeHandle): Promise<RuntimeCollection> { return { handle: current, outcome: 'ready', logTail: '', droppedLogBytes: 0, requested: current.requested, observed: [], resultAcceptance: 'not-evaluated' }; },
    async reconcile(current: RuntimeHandle): Promise<ReconciliationReceipt> { return { state: 'live', handle: current, explanation: 'inert adapter holds no process' }; },
  };
}

const root = await mkdtemp(join(tmpdir(), 'p2o-real-supervisor-'));
const workspace = join(root, 'workspace');
await mkdir(workspace, { recursive: true, mode: 0o700 });
const store = openStore({ path: join(root, 'store.sqlite'), clock: () => iso(NOW) });
const controlRoot = join(root, 'controller');
await mkdir(controlRoot, { recursive: true, mode: 0o700 });
const authority = inertAuthority();
const adapter = inertRuntime();
const supervisor = createSupervisor({ controlRoot, workspaceRoot: workspace, store, authority,
  runtimes: { 'inert-fixture': adapter },
  clock: { now: () => NOW, setTimeout: () => 0, clearTimeout: () => {} }, automatic: false });
// Runtime readiness is declared to the port; the reporting path is wired so preflight is a real readiness gate.
const backend = createSupervisorBackend({
  store, supervisor: createOrchestratorPort(supervisor, { runtimes: { 'inert-fixture': adapter } }), now: () => NOW,
  render: (runId, format) => ({ runId, format, acceptedOnly: true }) });
const pi = fakePi();
registerP2O(pi.api, { backendFactory: () => backend });
const manifestPath = join(root, 'manifest.json');
await writeFile(manifestPath, JSON.stringify(runManifest()));
const start = { manifestPath, mode: 'fixture' as const };
const summary: Record<string, unknown> = { scope: 'seam smoke test: interface ↔ real supervisor wiring with inert fixtures and ZERO admitted tasks (not E2E; the full fixture is owned by the application slice)' };

try {
  // Declared approval and source inputs never let network targets take the fixture path.
  for (const kind of ['web', 'service'] as const) {
    const approved = runManifest();
    const deniedPath = join(root, `denied-${kind}.json`);
    await writeFile(deniedPath, JSON.stringify({ ...approved,
      authorization: { ...approved.authorization, targets: [...approved.authorization.targets,
        { id: 'network', kind, locator: kind === 'web' ? 'https://assessment.invalid/' : 'tcp://assessment.invalid:443' }] },
      budgets: { ...approved.budgets, targetRequestLimits: { ...approved.budgets.targetRequestLimits, network: 0 } },
    }));
    const denied = { manifestPath: deniedPath, mode: 'fixture' as const };
    await assert.rejects(pi.call('p2o_preflight', denied), /FIXTURE_SCOPE_INVALID/);
    await assert.rejects(pi.call('p2o_start', denied), /FIXTURE_SCOPE_INVALID/);
    await assert.rejects(backend.start(denied), /FIXTURE_SCOPE_INVALID/);
    assert.deepEqual(authority.admissions, [], 'fixture denial precedes even inert owner approval');
    assert.equal(store.listRuns().length, 0, 'fixture network denial never admits or launches');
  }
  summary.fixtureScope = 'lab + approved source artifact admitted; web/service denied without target traffic';
  const preflight = await pi.call('p2o_preflight', start);
  assert.equal((preflight.details as { ok: boolean }).ok, true, 'preflight must pass for a current authorized inert fixture');
  summary.preflight = preflight.details;

  const started = await pi.call('p2o_start', start);
  assert.equal((started.details as { launched: boolean }).launched, true);
  assert.equal(store.getRun('run-inert-1')?.runId, 'run-inert-1', 'supervisor admission must be durable');
  summary.started = started.details;

  const status = await pi.call('p2o_status', { runId: 'run-inert-1' });
  const snapshot = status.details as { mode: string; run: { state: string; requestedRuntime: { adapter: string; selection: { provider: string } } }; process: { attempts: unknown[] }; packets: unknown[] };
  assert.equal(snapshot.mode, 'fixture');
  assert.equal(snapshot.run.requestedRuntime.adapter, 'inert-fixture');
  assert.equal(snapshot.run.requestedRuntime.selection.provider, 'requested-only');
  assert.equal(snapshot.packets.length, 0, 'no packet exists until an accepted result is admitted');
  assert.equal(snapshot.process.attempts.length, 0, 'this seam smoke test admits zero tasks by design; task admission belongs to the application layer');
  summary.status = { mode: snapshot.mode, runState: snapshot.run.state, attempts: snapshot.process.attempts.length, packets: snapshot.packets.length };

  const events = await pi.call('p2o_events', { runId: 'run-inert-1' });
  const eventTypes = (events.details as { items: { type: string }[] }).items.map(i => i.type);
  assert.ok(eventTypes.includes('run.admitted'), `expected a durable run.admitted receipt, saw ${eventTypes.join(',')}`);
  summary.events = eventTypes;

  // The interface keeps fixture/assessment; the supervisor records ownership mode and safetyMode.
  const raw = store.listEvents({ runId: 'run-inert-1' });
  assert.equal((raw.find(e => e.type === 'run.admitted')!.payload as { mode: string }).mode, 'fixture');
  const admitted = raw.find(e => e.type === 'orchestrator.run-admitted')!.payload as { mode: string; safetyMode: string };
  assert.equal(admitted.mode, 'managed');
  assert.equal(admitted.safetyMode, 'fixture');
  assert.deepEqual(authority.admissions, [{ mode: 'managed', perTargetConcurrency: { fixture: 1, source: 1 } }],
    'the port clamps the default grant to min(option, budgets.maxConcurrency) and admits managed ownership only');
  summary.admission = authority.admissions[0];

  // Resume must re-present the original scope/budget/runtime identity, not merely the runId.
  const widenedPath = join(root, 'widened.json');
  await writeFile(widenedPath, JSON.stringify({ ...runManifest(), budgets: { ...runManifest().budgets, maxRequests: 99 } }));
  await assert.rejects(pi.call('p2o_resume', { manifestPath: widenedPath, mode: 'fixture', runId: 'run-inert-1' }), /RUN_IDENTITY_MISMATCH/);
  await assert.rejects(pi.call('p2o_resume', { ...start, mode: 'assessment', runId: 'run-inert-1' }), /MODE_MISMATCH/);
  await assert.rejects(pi.call('p2o_resume', { ...start, runId: 'run-inert-1' }), /RUN_TERMINAL/);
  summary.resumeGuards = ['identity-widening', 'mode-change', 'terminal-run'];

  const report = await pi.call('p2o_report', { runId: 'run-inert-1' });
  assert.deepEqual((report.details as { content: unknown }).content, { runId: 'run-inert-1', format: 'json', acceptedOnly: true });
  summary.report = 'wired-vault-port-only';
  const stopped = await pi.call('p2o_stop', { runId: 'run-inert-1' });
  assert.equal((stopped.details as { terminationVerified: boolean }).terminationVerified, true, 'inert adapter owns no process, so cancellation is verified');
  summary.stop = stopped.details;

  const after = await pi.call('p2o_status', { runId: 'run-inert-1' });
  const finalState = (after.details as { run: { state: string } }).run.state;
  // Terminal state naming belongs to the supervisor; the interface must not invent a canonical value.
  assert.ok(['completed', 'cancelled'].includes(finalState), `expected a terminal run state, saw ${finalState}`);
  assert.equal((after.details as { failures: unknown[] }).failures.length, 0, 'no unverified ownership may remain after a verified stop');
  summary.afterStop = finalState;
} finally {
  // Real lifecycle check: Pi fires session_shutdown on exit; cleanup must reach owned runtimes and settle.
  await pi.event('session_shutdown');
  summary.shutdown = 'clean';
  store.close();
}
console.log('INTEGRATION: PASS', JSON.stringify(summary, null, 2));
