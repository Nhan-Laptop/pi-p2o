import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { rejects } from 'node:assert';
import test from 'node:test';
import {
  createOwnerAuthority, createApplication, createWorkerBridge, validateApplicationConfig, ownerGrantFor, callBridge,
  createP2OBackend, enforceInterfaceMode, interfaceModeFor, parseObservationSelection, ApplicationError,
  type ApplicationConfig, type WorkerBridgeOperations,
} from '../../src/application/index.js';
import type { ControlBackend, Preflight, ResumeInput, RunHandle, Snapshot, StartInput } from '../../src/interface/index.js';
import { digestJson, type AttemptRecord } from '../../src/contracts/index.js';
import type { Scope } from '../../src/policy/index.js';
import { type DurableStore, type WorkspaceLease } from '../../src/store/index.js';
import { prepareLocalAssessment, runLocalAssessment, type PreparedAssessment } from '../../examples/local-assessment/main.js';
import { FINDING_EXPORT, RUN_ID, TASK_HYP_CASE, TASK_HYP_EXPORT, TASK_VERIFY_EXPORT } from '../../examples/local-assessment/scenario.js';
import { bindControllerVerificationPolicy } from '../../src/application/composition.js';

test('local assessment chain: mapping -> parallel hypotheses -> verifier -> honest report', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'p2o-e2e-run-'));
  const result = await runLocalAssessment({ runRoot: runDir, log: () => {} });
  assert.equal(result.terminal, true);
  assert.equal(result.runState, 'completed');
  assert.equal(result.accepted, 4, 'mapping, two hypotheses and the verifier packet must be accepted');
  assert.equal(result.returned, 0);
  assert.deepEqual(result.packets.map(packet => packet.taskId).sort(), ['task-hyp-case', 'task-hyp-export', 'task-surface-map', 'task-verify-export']);
  assert.ok(result.packets.every(packet => packet.outcome === 'supported'));

  // The confirmed finding is promoted only by the evidence module's independent replay.
  assert.deepEqual(result.findings, [{ findingId: 'finding-export-bypass', state: 'independently-validated', taskId: TASK_HYP_EXPORT }]);
  const confirmed = result.report.findings.find(finding => finding.findingId === 'finding-export-bypass');
  assert.notEqual(confirmed?.verifier?.identity, confirmed?.producerId, 'verifier identity differs from the producing identity');
  const producer = result.acceptedResults.find(record => record.taskId === TASK_HYP_EXPORT);
  const verifierRecord = result.acceptedResults.find(record => record.taskId === 'task-verify-export');
  assert.ok(producer && verifierRecord, 'the producing and the verifying packets are both durably accepted');
  // The comparison is attempt-vs-attempt (the attempt that produced the accepted evidence versus the fresh
  // verifier attempt), never attempt-vs-task: a task id is not an attempt identity.
  assert.notEqual(confirmed?.verifier?.attemptId, producer?.attemptId, 'verifier attempt differs from the producing evidence attempt');
  assert.notEqual(verifierRecord?.attemptId, producer?.attemptId);
  const verifierEvidence = result.evidence.filter(record => confirmed?.verifier?.evidenceIds.includes(record.evidenceId));
  assert.ok(verifierEvidence.length > 0, 'the independent replay preserved its own receipts');
  for (const record of verifierEvidence) {
    assert.equal(record.attemptId, confirmed?.verifier?.attemptId, 'verifier receipts belong to the verifier attempt');
    assert.equal(record.collectorId, confirmed?.verifier?.identity, 'verifier receipts were collected by the verifier capability');
    assert.equal(record.collectorRole, 'verifier');
    assert.notEqual(record.attemptId, producer?.attemptId);
  }
  const producingEvidence = result.evidence.filter(record => confirmed?.evidenceIds.includes(record.evidenceId));
  assert.ok(producingEvidence.length > 0);
  assert.ok(producingEvidence.every(record => record.attemptId === producer?.attemptId), 'producing proof belongs to the producing attempt');
  // The worker never writes a result directly: the evidence module's preserved ResultCollector admitted every packet.
  for (const record of result.acceptedResults) {
    const preserved = result.evidence.filter(entry => entry.attemptId === record.attemptId && entry.toolName === 'p2o-result-bridge');
    assert.equal(preserved.length, 1, `attempt ${record.attemptId} must have exactly one preserved collector packet receipt`);
    assert.equal(preserved[0]?.collectorRole, 'collector');
  }
  assert.equal(confirmed?.verifier?.environmentId, 'lab-fixture-b');

  // Coverage is explicit, and the untested actor gap is retained instead of being asserted as tested.
  const counts = Object.fromEntries(result.coverage.map(entry => [entry.state, entry.count]));
  assert.equal(counts.tested, 1);
  assert.equal(counts['ruled-out'], 1);
  assert.equal(counts.untested, 1);
  assert.equal(result.report.assessmentStatus, 'incomplete', 'a completed run is not comprehensive coverage');
  assert.ok(result.report.coverage.records.some(record => record.state === 'untested' && record.actorId === 'anonymous'));
  assert.match(result.markdown, /untested/);
  assert.ok(result.evidenceReceipts >= 20, 'observation, replay and controller receipts are preserved');

  // Every attempt is settled with a receipt-backed runtime observation, and no runtime substitution is reported.
  for (const attempt of result.report.processes) {
    assert.equal(attempt.state, 'exited');
    assert.equal(attempt.runtimeEvidenceVerified, true, `attempt ${attempt.attemptId} must have a verifier-attested runtime receipt`);
    assert.deepEqual(attempt.runtimeDiscrepancies, []);
  }

  // Real overlap: two owned headless attempts were durably running with verified live processes at one instant,
  // the verified live-process windows intersect, and the fixture itself saw two simultaneous in-flight requests.
  assert.deepEqual([...result.overlap.tasks].sort(), [TASK_HYP_CASE, TASK_HYP_EXPORT].sort());
  assert.equal(result.overlap.windows.length, 2, 'both hypothesis attempts must expose verified live-process windows');
  assert.equal(result.overlap.sharedAliveInstant, true, JSON.stringify(result.overlap.windows));
  assert.equal(result.overlap.sharedRunningInstant, true, `both attempts must be durably running with live processes at one instant: ${JSON.stringify(result.overlap.windows)}`);
  assert.ok(result.overlap.bothAliveMs >= 50, `verified live-process windows must intersect, measured ${result.overlap.bothAliveMs}ms`);
  const [firstWindow, secondWindow] = result.overlap.windows;
  assert.ok(firstWindow && secondWindow && firstWindow.pids.length > 0 && secondWindow.pids.length > 0);
  assert.ok(firstWindow.pids.every(pid => !secondWindow.pids.includes(pid)), 'the two attempts must own distinct OS processes');
  const fixtureA = result.fixtureRequests.find(entry => entry.environment === 'lab-fixture-a');
  assert.ok((fixtureA?.maxConcurrent ?? 0) >= 2, `the fixture must observe two concurrent in-flight approved requests, saw ${fixtureA?.maxConcurrent}`);
  assert.ok(result.overlap.samples.some(sample => sample.alive.length > 0), 'owned pids must be re-verified against /proc');

  // Classifications come from the controller evaluating the collected bytes, never from the worker plan.
  const observations = new Map(result.observations.map(record => [record.checkId, record]));
  const baseline = observations.get('hyp-export-baseline');
  assert.ok(baseline, 'the baseline observation must be recorded');
  assert.equal(baseline?.receiptOutcome, 'passed', 'the fixture returned the expected bytes, so the controller classified the check as passed');
  assert.equal(baseline?.workerReported, 'passed', 'the worker received the controller classification');
  assert.equal(baseline?.hint, 'failed', 'the plan hint disagrees with the actual classification');
  assert.notEqual(baseline?.hint, baseline?.receiptOutcome, 'a worker-side hint cannot decide the classification');
  const inconclusive = observations.get('hyp-case-inconclusive');
  assert.ok(inconclusive, 'the inconclusive observation must be recorded');
  assert.equal(inconclusive?.receiptOutcome, 'inconclusive', 'an HTTP body cannot be evaluated against a source expectation');
  assert.equal(inconclusive?.workerReported, 'inconclusive');
  assert.equal(inconclusive?.successes, 0);
  assert.equal(inconclusive?.attempts, 1);
  assert.equal(inconclusive?.hint, 'passed');
  assert.notEqual(inconclusive?.hint, inconclusive?.receiptOutcome);
  for (const record of result.observations) {
    if (record.receiptOutcome && record.workerReported) assert.equal(record.workerReported, record.receiptOutcome, `${record.checkId}: the worker must receive the controller outcome`);
  }

  // The JSON view round-trips and never claims completeness.
  const parsed = JSON.parse(result.json) as { assessmentStatus: string; findings: Array<{ findingId: string }> };
  assert.equal(parsed.assessmentStatus, 'incomplete');
  assert.ok(parsed.findings.some(finding => finding.findingId === 'finding-export-bypass'));

  // The persisted run directory contains the owner document and the rendered report.
  const document = JSON.parse(readFileSync(join(runDir, 'assessment.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(document.mode, 'inert-local-fixture');
  assert.ok(readFileSync(join(runDir, 'report.md'), 'utf8').includes('Assessment run-loopback-1'));
});

test('owner authority approves only the exact owner document', async () => {
  const prepared = await buildIdleApplication();
  try {
    const grant = ownerGrantFor(prepared.config);
    const authority = createOwnerAuthority(grant);
    const run = grant.runs[0]!;
    const approved = await authority.verifyRun(run);
    assert.equal(approved.allowed, true);
    assert.equal(approved.digest, digestJson(run));

    // A widened task proposal (extra capability) is not in the document and must be denied.
    const widened = {
      ...grant.tasks[0]!,
      proposal: { ...grant.tasks[0]!.proposal, manifest: { ...grant.tasks[0]!.proposal.manifest, requiredCapabilities: [...grant.tasks[0]!.proposal.manifest.requiredCapabilities, 'native.inspect'] } },
    };
    await rejects(authority.approveTask(widened.proposal, run.manifest), (error: unknown) => (error as { code?: string }).code === 'permission-denied');
    // A replacement is denied unless explicitly listed, and control transfer is denied entirely.
    await rejects(authority.approveReplacement({
      runId: run.manifest.runId, taskId: TASK_HYP_EXPORT, attemptId: 'attempt-x', requested: run.manifest.requestedRuntime,
      scopeDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64), deadlineAt: Date.now() + 60_000, originalApproval: approved.reference,
    }, run.manifest), (error: unknown) => (error as { code?: string }).code === 'permission-denied');
    await rejects(authority.transferControl!({ runId: run.manifest.runId, previousOwner: 'x', previousToken: 'y', nextOwner: 'z' }), (error: unknown) => (error as { code?: string }).code === 'permission-denied');
  } finally {
    await prepared.app.close();
  }
});

test('config validation refuses fixture fallbacks and unapproved shapes', async () => {
  const base = await buildIdleApplication();
  const document = JSON.parse(readFileSync(base.assessmentPath, 'utf8')) as Record<string, unknown>;
  await base.app.close();
  assert.equal(validateApplicationConfig(document).mode, 'inert-local-fixture');

  const mutate = (update: (copy: Record<string, unknown>) => void): Record<string, unknown> => {
    const copy = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
    update(copy);
    return copy;
  };
  // 1. local-fixture sandbox outside inert mode is never an assessment fallback.
  assert.throws(() => validateApplicationConfig(mutate(copy => { copy.mode = 'authorized-assessment'; delete copy.acknowledgement; })),
    /local-fixture sandbox is only valid in inert-local-fixture mode/);
  // 2. the inert acknowledgement is exact and never implicit.
  assert.throws(() => validateApplicationConfig(mutate(copy => { copy.acknowledgement = 'inert'; })), /exact inert acknowledgement/);
  // 3. unknown fields are rejected instead of ignored.
  assert.throws(() => validateApplicationConfig(mutate(copy => { copy.extra = true; })), /unknown application config field/);
  // 4. worker plans are fixture-only.
  assert.throws(() => validateApplicationConfig(mutate(copy => {
    copy.mode = 'authorized-assessment'; delete copy.acknowledgement;
    (copy.sandbox as Record<string, unknown>).mode = 'container';
    (copy.sandbox as Record<string, unknown>).options = { acknowledgement: 'containers-share-host-kernel-not-hostile-code-isolation' };
    delete (copy.bridge as Record<string, unknown>).inertLocalOnly;
    copy.bridge = { ...(copy.bridge as Record<string, unknown>), inertLocalOnly: false };
  })), /worker plans are only valid in inert-local-fixture mode/);
  // 5. a mismatched sandbox identity digest fails closed at composition time (before durable state is opened).
  const mismatched = mutate(copy => { ((copy.sandbox as Record<string, unknown>)).identityDigest = 'f'.repeat(64); });
  const parsed = validateApplicationConfig(mismatched) as ApplicationConfig;
  await assert.rejects(createApplication(parsed), /sandbox-identity|does not match/);
});

test('worker bridge authenticates token and attempt identity', async () => {
  const prepared = await buildIdleApplication();
  try {
    const socket = prepared.app.bridge.socketPath;
    const taskId = TASK_HYP_EXPORT;
    const before = prepared.app.store.listEvents().filter(event => event.type.startsWith('packet.submission-')).length;
    await assert.rejects(callBridge(socket, 'not-the-owner-token', { taskId }, 'packet.admit', {}), /bridge-denied/);
    await assert.rejects(callBridge(socket, 'a'.repeat(40), { attemptId: 'unknown-attempt' }, 'packet.admit', {}), /bridge-denied/);
    assert.equal(prepared.app.store.listEvents().filter(event => event.type.startsWith('packet.submission-')).length, before, 'unauthenticated callers cannot consume victim submission slots');
    await assert.rejects(callBridge(socket, 'not-the-owner-token', { taskId }, 'attempt.state', {}), /bridge-denied/);
    await assert.rejects(callBridge(socket, 'a'.repeat(40), { attemptId: 'unknown-attempt' }, 'attempt.state', {}), /bridge-denied/);
    // An unresolved identity (no lease yet) is denied rather than defaulting to anything.
    await assert.rejects(callBridge(socket, 'a'.repeat(40), { taskId: 'task-unknown' }, 'attempt.state', {}), /bridge-denied/);
  } finally {
    await prepared.app.close();
  }
});

test('worker bridge close is bounded and aborts in-flight work', async (t) => {
  const harness = await bridgeHarness({
    async execute(_attempt, _payload, signal) {
      harness.signalSeen = signal;
      harness.started = true;
      return await new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  const call = callBridge(harness.bridge.socketPath, harness.token, { attemptId: harness.attemptId }, 'broker.execute', { observationId: 'obs-1' }, 30_000);
  // Attach the rejection handler immediately so the expected abort is never an unhandled rejection.
  const settled = call.then(() => undefined, (error: unknown) => error);
  await waitFor(() => harness.started);
  const began = Date.now();
  await harness.bridge.close();
  const elapsed = Date.now() - began;
  assert.ok(elapsed < 1_500, `bridge.close must not wait for the worker socket (took ${elapsed}ms)`);
  assert.equal(harness.signalSeen?.aborted, true, 'in-flight work receives an abort signal on close');
  const failure = await settled;
  assert.ok(failure instanceof Error && /aborted|bridge-closed|bridge-timeout/.test(failure.message), `in-flight call must fail closed, saw ${String(failure)}`);
  void t;
});

test('stale, released or expired attempts are denied on every dispatch', async (t) => {
  const harness = await bridgeHarness({});
  t.after(async () => { await harness.bridge.close(); });
  const call = (): Promise<unknown> => callBridge(harness.bridge.socketPath, harness.token, { attemptId: harness.attemptId }, 'attempt.state', {});
  assert.ok(await call(), 'a live attempt is served');
  const expectStale = async (pattern: string): Promise<void> => {
    try {
      await rejects(call(), (error: unknown) => (error as { code?: string }).code === 'bridge-stale-attempt');
    } catch (error) {
      throw new Error(`expected a stale-attempt denial for ${pattern}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  harness.state.lifecycle = 'cancelled';
  await expectStale('cancelled');
  harness.state.lifecycle = 'running';
  harness.state.runState = 'completed';
  await expectStale('completed run');
  harness.state.runState = 'active';
  harness.state.deadlineAt = new Date(Date.now() - 1).toISOString();
  await expectStale('expired deadline');
  harness.state.deadlineAt = new Date(Date.now() + 60_000).toISOString();
  harness.state.lease = undefined;
  await expectStale('released lease');
  harness.state.lease = { ...harness.activeLease, token: 'another-token' };
  await expectStale('foreign lease token');
  // A lease held by another attempt is denied even when its token happens to match.
  harness.state.lease = { ...harness.activeLease, attemptId: 'attempt-2' };
  await expectStale('foreign lease attempt');
});

test('worker payloads cannot inject check content or test outcomes', () => {
  assert.deepEqual(parseObservationSelection({ observationId: 'obs-1' }), { observationId: 'obs-1' });
  for (const injected of [
    { observationId: 'obs-1', evidence: { test: { outcome: 'passed' } } },
    { observationId: 'obs-1', tool: 'http.request' },
    { observationId: 'obs-1', input: { url: 'http://127.0.0.1/' } },
    { observationId: 'obs-1', metadata: { claimDigest: 'a'.repeat(64) } },
    { observationId: 'obs-1', test: { outcome: 'passed' } },
    { observationId: 'obs-1', outcome: 'passed' },
    { observationId: 'obs-1', kind: 'reproduction' },
    { observationId: 'obs-1', classification: 'independently-observed' },
    { observationId: 'obs-1', summary: 'worker-authored summary' },
    { observationId: 'obs-1', claim: 'worker-authored claim' },
  ]) {
    assert.throws(() => parseObservationSelection(injected), /unknown bridge call field/);
  }
});

test('a safe fixture variant cannot be reported as a confirmed finding', async () => {
  // The controller evaluates the owner-approved expectation over the collected bytes: when the fixture does not
  // exhibit the seeded defect, the reproduction check fails and the finding proof is returned, never accepted.
  const result = await runLocalAssessment({ log: () => {}, enforceExportTenant: true });
  assert.equal(result.terminal, true);
  assert.equal(result.findings.length, 0, 'no finding may be accepted when the controller check failed');
  assert.ok(result.accepted >= 3, 'contract-valid packets may still be accepted; the finding itself is not');
  assert.ok(result.report.returned.some(record => record.category === 'finding' && record.codes.includes('reproduction-denominator')),
    `expected a returned finding with a reproduction failure, saw ${JSON.stringify(result.report.returned)}`);
  const reproduction = result.report.evidence.find(entry => entry.kind === 'reproduction');
  assert.equal(reproduction?.test?.outcome, 'failed', 'the reproduction outcome is controller-evaluated, not worker prose');
  // The negative observation is classified from the safe fixture's real bytes (403), with a contradicting hint.
  const reproductionObservation = result.observations.find(record => record.checkId === 'hyp-export-reproduction');
  assert.ok(reproductionObservation, 'the reproduction observation must be recorded');
  assert.equal(reproductionObservation?.receiptOutcome, 'failed', 'the safe fixture rejects the request, so the controller classifies the reproduction as failed');
  assert.equal(reproductionObservation?.workerReported, 'failed', 'the worker received the controller classification');
  assert.equal(reproductionObservation?.hint, 'passed', 'the plan hint predicted a violation');
  assert.notEqual(reproductionObservation?.hint, reproductionObservation?.receiptOutcome, 'a worker-side hint cannot decide the classification');
  // Overlap is a property of the composition, not of the seeded defect, so the safe variant must show it too.
  assert.equal(result.overlap.sharedRunningInstant, true, JSON.stringify(result.overlap.windows));
  assert.ok((result.fixtureRequests.find(entry => entry.environment === 'lab-fixture-a')?.maxConcurrent ?? 0) >= 2);
  assert.equal(result.report.assessmentStatus, 'incomplete');
});

test('absolute request limits are enforced before any target traffic', async () => {
  // One approved request for the whole run: the first network observation dispatches, every later one is refused
  // by the store pre-charge before the broker can reach the fixture.
  const prepared = await prepareLocalAssessment({ log: () => {}, maxRequests: 1 });
  try {
    await prepared.app.admitApprovedRun();
    await prepared.app.admitApprovedTasks();
    prepared.app.supervisor.start(RUN_ID);
    await waitFor(() => {
      const task = prepared.app.store.getTask('task-surface-map');
      return task?.lifecycleState === 'failed' || task?.packetState === 'accepted';
    }, 30_000);
    const requests = prepared.fixtureRequests().find(entry => entry.environment === 'lab-fixture-a')?.requests ?? 0;
    assert.equal(requests, 1, `exactly one approved request may reach the fixture, saw ${requests}`);
    assert.equal(prepared.app.store.listResults(RUN_ID).filter(entry => entry.decision.status === 'accepted').length, 0);
    assert.equal(prepared.app.store.getTask('task-surface-map')?.lifecycleState, 'failed');
  } finally {
    await prepared.app.close();
    await prepared.closeFixtures();
  }
});

test('interface backend fails closed for unmanaged runtimes and unapproved runs', async () => {
  const prepared = await buildIdleApplication();
  try {
    const manifestPath = prepared.manifestPath;
    assert.ok(readFileSync(manifestPath, 'utf8').length > 0);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown> & { requestedRuntime: { adapter: string } };

    // A plan/dry-run adapter may never own a managed run.
    const planManifest = join(prepared.runDir, 'plan-manifest.json');
    writeFileSync(planManifest, `${JSON.stringify({ ...manifest, requestedRuntime: { ...manifest.requestedRuntime, adapter: 'plan' } })}\n`);
    await assert.rejects(prepared.app.interfaceBackend.start({ manifestPath: planManifest, mode: 'fixture' }), /UNMANAGED_RUNTIME_REJECTED/);

    // The configured inert-local-fixture mode accepts the declared lab fixture plus the read-only source artifact.
    const fixturePreflight = await prepared.app.interfaceBackend.preflight({ manifestPath, mode: 'fixture' });
    assert.equal(fixturePreflight.ok, true, JSON.stringify(fixturePreflight.issues));
    assert.equal(fixturePreflight.mode, 'fixture');

    // A web/service target declaration can never use the fixture path, whatever else it declares.
    const authorization = manifest.authorization as { targets: unknown[] } & Record<string, unknown>;
    const budgets = manifest.budgets as Record<string, unknown> & { targetRequestLimits: Record<string, number> };
    const webManifest = join(prepared.runDir, 'web-manifest.json');
    // The added web target must be a schema-valid declared identity (canonical exact URL, one request limit):
    // the fixture-scope refusal is the assertion under test, not schema validation.
    writeFileSync(webManifest, `${JSON.stringify({
      ...manifest,
      authorization: { ...authorization, targets: [...authorization.targets, { id: 'web-target', kind: 'web', locator: 'https://example.invalid/', digest: 'a'.repeat(64), revision: '1' }] },
      budgets: { ...budgets, targetRequestLimits: { ...budgets.targetRequestLimits, 'web-target': 1 } },
    })}\n`);
    await assert.rejects(prepared.app.interfaceBackend.preflight({ manifestPath: webManifest, mode: 'fixture' }), /FIXTURE_SCOPE_INVALID/);
    assert.equal(prepared.app.store.getRun('web-target-run'), undefined);

    // The mismatched interface mode is refused before any admission, recovery or launch, and the correct mode
    // reaches the real backend methods.
    await rejects(prepared.app.interfaceBackend.start({ manifestPath, mode: 'assessment' }), (error: unknown) => (error as { code?: string }).code === 'MODE_MISMATCH');
    await rejects(prepared.app.interfaceBackend.preflight({ manifestPath, mode: 'assessment' }), (error: unknown) => (error as { code?: string }).code === 'MODE_MISMATCH');
    await rejects(prepared.app.interfaceBackend.resume({ manifestPath, runId: RUN_ID, mode: 'assessment' }), (error: unknown) => (error as { code?: string }).code === 'MODE_MISMATCH');
    assert.equal(prepared.app.store.getRun(RUN_ID), undefined, 'a mode mismatch must not admit a durable run');

    await assert.rejects(prepared.app.interfaceBackend.start({ manifestPath: join(prepared.runDir, 'missing.json'), mode: 'fixture' }), /ENOENT|MANIFEST/);
    // A structurally valid manifest with an unapproved run identity is refused by the owner authority at dispatch.
    const unapproved = join(prepared.runDir, 'unapproved-manifest.json');
    writeFileSync(unapproved, `${JSON.stringify({ ...manifest, runId: 'run-not-approved' })}\n`);
    await rejects(prepared.app.interfaceBackend.start({ manifestPath: unapproved, mode: 'fixture' }), (error: unknown) => (error as { code?: string }).code === 'permission-denied' || /permission-denied/.test(String(error)));
    assert.equal(prepared.app.store.getRun('run-not-approved'), undefined);
    assert.equal(prepared.app.store.getRun(RUN_ID), undefined, 'the approved run is only admitted by the example, not by this refusal test');
  } finally {
    await prepared.app.close();
  }
});

/** Stub port used to prove mode enforcement wraps (and delegates to) the actual backend methods. */
function stubBackend(calls: string[]): ControlBackend {
  const selection = { provider: 'stub-provider', model: 'stub-model', thinking: 'max' as const };
  const preflight = async (input: StartInput | ResumeInput): Promise<Preflight> => {
    calls.push(`preflight:${input.mode}`);
    return { ok: true, mode: input.mode, runId: 'run-stub', requested: { adapter: 'headless', selection }, issues: [], warnings: [] };
  };
  return {
    async preflight(input) { return await preflight(input); },
    async doctor(input) {
      calls.push(`doctor:${input.mode}`);
      return { ok: true, mode: input.mode, runId: 'run-stub', requested: { adapter: 'headless', selection }, issues: [], warnings: [] };
    },
    async start(input): Promise<RunHandle> {
      calls.push(`start:${input.mode}`);
      return { runId: 'run-stub', mode: input.mode };
    },
    async resume(input): Promise<RunHandle> {
      calls.push(`resume:${input.mode}`);
      return { runId: input.runId, mode: input.mode };
    },
    async stop(runId: string) {
      calls.push(`stop:${runId}`);
      return { runId, schedulingStopped: true, terminationVerified: true, failures: [] };
    },
    async status(runId: string): Promise<Snapshot> {
      calls.push(`status:${runId}`);
      return { mode: 'fixture', run: {}, tasks: [], attempts: [], packets: [], findings: [], coverage: [], failures: [] };
    },
    async tasks(runId, page) {
      calls.push(`tasks:${runId}`);
      return { items: [], total: 0, offset: page.offset };
    },
    async evidence(runId, page) {
      calls.push(`evidence:${runId}`);
      return { items: [], total: 0, offset: page.offset };
    },
    async report(runId, format) {
      calls.push(`report:${runId}`);
      return { format, content: {} };
    },
    async events(runId, page) {
      calls.push(`events:${runId}`);
      return { items: [], nextSequence: page.afterSequence, gap: false };
    },
    async close() {
      calls.push('close');
    },
  };
}

test('the configured application mode is enforced on preflight, doctor, start and resume', async () => {
  assert.equal(interfaceModeFor('inert-local-fixture'), 'fixture');
  assert.equal(interfaceModeFor('authorized-assessment'), 'assessment');
  const manifestPath = join(mkdtempSync(join(tmpdir(), 'p2o-mode-')), 'manifest.json');
  writeFileSync(manifestPath, '{}\n');
  for (const [configured, allowed, refused] of [['inert-local-fixture', 'fixture', 'assessment'], ['authorized-assessment', 'assessment', 'fixture']] as const) {
    const calls: string[] = [];
    const backend = enforceInterfaceMode(stubBackend(calls), configured);
    const wrong = { manifestPath, mode: refused } as const;
    // Every mode-bearing entry point refuses before the wrapped method can admit, recover or launch.
    await rejects(backend.preflight(wrong), (error: unknown) => (error as { code?: string }).code === 'MODE_MISMATCH');
    await rejects(backend.doctor!(wrong), (error: unknown) => (error as { code?: string }).code === 'MODE_MISMATCH');
    await rejects(backend.start(wrong), (error: unknown) => (error as { code?: string }).code === 'MODE_MISMATCH');
    await rejects(backend.resume({ ...wrong, runId: 'run-stub' }), (error: unknown) => (error as { code?: string }).code === 'MODE_MISMATCH');
    assert.deepEqual(calls, [], `a mode mismatch must never reach the wrapped ${configured} backend`);
    // The matching mode is delegated to the actual methods, in order, with no re-implementation.
    const right = { manifestPath, mode: allowed } as const;
    assert.equal((await backend.preflight(right)).ok, true);
    assert.equal((await backend.start(right)).mode, allowed);
    assert.equal((await backend.resume({ ...right, runId: 'run-stub' })).runId, 'run-stub');
    assert.equal((await backend.doctor!(right)).ok, true);
    assert.deepEqual(calls, [`preflight:${allowed}`, `start:${allowed}`, `resume:${allowed}`, `doctor:${allowed}`]);
    // Owned teardown and read-only inspection are not gated by the mode label.
    await backend.stop('run-stub', 'mode regression teardown');
    await backend.status('run-stub');
    await backend.close();
    assert.deepEqual(calls.slice(-3), ['stop:run-stub', 'status:run-stub', 'close']);
  }
  const { doctor: _absentDoctor, ...withoutDoctor } = stubBackend([]);
  assert.equal(enforceInterfaceMode(withoutDoctor as ControlBackend, 'inert-local-fixture').doctor, undefined, 'the wrapper never invents a doctor port');
});

test('the Pi entry point enforces the exact configured mode and never admits, recovers or launches on a mismatch', async () => {
  const prepared = await prepareLocalAssessment({ log: () => {} });
  const previous = process.env.P2O_APP_CONFIG;
  let backend: ControlBackend | undefined;
  try {
    await prepared.app.close();
    process.env.P2O_APP_CONFIG = prepared.assessmentPath;
    backend = await createP2OBackend({ cwd: prepared.runDir });
    const manifestPath = prepared.manifestPath;
    const mismatched = (error: unknown): boolean => (error as { code?: string }).code === 'MODE_MISMATCH';
    // A mismatch cannot admit, recover or launch: the durable store holds no run afterwards.
    await rejects(backend.preflight({ manifestPath, mode: 'assessment' }), mismatched);
    await rejects(backend.start({ manifestPath, mode: 'assessment' }), mismatched);
    await rejects(backend.resume({ manifestPath, runId: RUN_ID, mode: 'assessment' }), mismatched);
    if (backend.doctor) await rejects(backend.doctor({ manifestPath, mode: 'assessment' }), mismatched);
    await rejects(backend.status(RUN_ID), (error: unknown) => (error as { code?: string }).code === 'RUN_NOT_FOUND');
    // The configured mode is admitted and launched through the same entry point.
    assert.deepEqual(await backend.start({ manifestPath, mode: 'fixture' }), { runId: RUN_ID, mode: 'fixture' });
    // Even on a live run, a mismatched resume must not recover or restart anything.
    await rejects(backend.resume({ manifestPath, runId: RUN_ID, mode: 'assessment' }), mismatched);
    const events = await backend.events(RUN_ID, { afterSequence: 0, limit: 200 });
    assert.deepEqual(events.items.filter(event => event.type === 'run.resumed'), [], 'a mismatched resume must not record a resume');
    const receipt = await backend.stop(RUN_ID, 'mode enforcement regression complete');
    assert.equal(receipt.terminationVerified, true, JSON.stringify(receipt.failures));
  } finally {
    if (backend) await backend.close();
    if (previous === undefined) delete process.env.P2O_APP_CONFIG;
    else process.env.P2O_APP_CONFIG = previous;
    await prepared.closeFixtures();
  }
});

test('cancelling the owned attempt aborts in-flight bridge work through the liveness watchdog', async () => {
  const harness = await bridgeHarness({
    async execute(_attempt, _payload, signal) {
      harness.started = true;
      return await new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  try {
    const settled = callBridge(harness.bridge.socketPath, harness.token, { attemptId: harness.attemptId }, 'broker.execute', { observationId: 'denied-probe' }, 30_000)
      .then(() => undefined, (error: unknown) => error);
    await waitFor(() => harness.started);
    // The durable lifecycle changes while the call is in flight; the watchdog re-authorizes and aborts the work.
    harness.state.lifecycle = 'cancelled';
    const failure = await Promise.race([
      settled,
      new Promise<Error>(resolve => { const timer = setTimeout(() => resolve(new Error('watchdog did not abort in time')), 3_000); if (typeof timer.unref === 'function') timer.unref(); }),
    ]);
    assert.ok(failure instanceof Error && /abort|bridge-stale|cancelled/i.test(failure.message), `in-flight work must fail closed on cancellation, saw ${String(failure)}`);
  } finally {
    await harness.bridge.close();
  }
});

test('an owner-approved probe outside scope is denied before dispatch and its reservation is refunded exactly once', async () => {
  const prepared = await prepareLocalAssessment({ log: () => {}, probeHoldMs: 20_000 });
  try {
    await prepared.app.admitApprovedRun();
    await prepared.app.admitApprovedTasks();
    prepared.app.supervisor.start(RUN_ID);
    // The inert worker writes this marker after its observations and then idles, so the probe is measured against
    // an owned attempt that is still durably running and no longer consuming any budget.
    const workspace = join(prepared.config.roots.workspace, TASK_HYP_CASE);
    await waitFor(() => existsSync(join(workspace, 'worker-observations.json')), 60_000);
    await waitFor(() => prepared.app.store.listTasks(RUN_ID).every(task => task.taskId === TASK_HYP_CASE || task.lifecycleState === 'exited'), 60_000);
    const attempt = prepared.app.store.listAttempts(RUN_ID).filter(candidate => candidate.taskId === TASK_HYP_CASE).at(-1);
    assert.ok(attempt, 'the hypothesis attempt must exist');
    assert.ok(['running', 'waiting'].includes(attempt.lifecycleState), `the attempt must hold a live lease during the probe, saw ${attempt.lifecycleState}`);
    const handle = JSON.parse(readFileSync(join(prepared.config.roots.control, 'handles', `${attempt.attemptId}.json`), 'utf8')) as { ownerToken: string };
    const fixturesBefore = prepared.fixtureRequests();
    const usageBefore = prepared.app.store.getAttempt(attempt.attemptId)!.usage;
    const targetUsageBefore = new Map(prepared.config.policy.targets.map(target => [target.id, prepared.app.store.getTargetUsage(RUN_ID, target.id)]));
    // Reservations already refunded before this probe (normally none): the probe must add exactly one.
    const releasesBefore = new Set(readAttemptEvents(prepared, attempt.attemptId)
      .filter(event => event.type === 'budget.released')
      .map(event => event.payload.reservationId));
    await rejects(
      callBridge(prepared.app.bridge.socketPath, handle.ownerToken, { attemptId: attempt.attemptId }, 'broker.execute', { observationId: 'denied-probe' }),
      (error: unknown) => (error as { code?: string }).code === 'TARGET_DENIED',
    );
    const usageAfter = prepared.app.store.getAttempt(attempt.attemptId)!.usage;

    // Denied before dispatch: no traffic and no evidence, exactly as before.
    assert.deepEqual(prepared.fixtureRequests(), fixturesBefore, 'a denied destination produces no fixture traffic');
    assert.equal(prepared.app.store.getEvidence(`denied-probe-${attempt.attemptId}`), undefined, 'a denied dispatch mints no evidence receipt');

    // New contract (R2/R4): a refusal that provably never dispatched refunds its own reservation exactly once.
    const events = readAttemptEvents(prepared, attempt.attemptId);
    const probeReleases = events.filter(event => event.type === 'budget.released' && !releasesBefore.has(event.payload.reservationId));
    assert.equal(probeReleases.length, 1, 'the denied probe refunds exactly one reservation');
    const refund = probeReleases[0]!;
    assert.equal(refund.payload.code, 'TARGET_DENIED', 'the refund records the denial code it was refused with');
    assert.equal(refund.payload.toolPlane, false, 'a policy denial is not a tool-plane refusal');
    assert.deepEqual(refund.payload.delta, { requests: 1, bytes: 0, toolCalls: 1, tokens: 0, costUsd: 0 }, 'the refund reverts exactly the pre-dispatch reservation');
    const reservationId = refund.payload.reservationId as string;
    const charges = events.filter(event => event.type === 'budget.consumed' && event.payload.reservationId === reservationId);
    assert.equal(charges.length, 1, 'the refund names the one charge it was reserved from');
    assert.equal(charges[0]?.payload.delta && (charges[0]!.payload.delta as { toolCalls?: number }).toolCalls, 1);
    assert.equal(refund.payload.targetId, charges[0]?.payload.targetId, 'the refund reverts the same scoped target reservation');

    // Net-zero for the refused call (nothing is "still charged"), and the reservation is spent.
    assert.equal(usageAfter.requests, usageBefore.requests, 'the refused request is not charged after its refund');
    assert.equal(usageAfter.toolCalls, usageBefore.toolCalls, 'the refused tool call is not charged after its refund');
    const targetId = refund.payload.targetId as string;
    assert.equal(prepared.app.store.getTargetUsage(RUN_ID, targetId), targetUsageBefore.get(targetId), 'the target-wide reservation is released too');
    assert.throws(
      () => prepared.app.supervisor.releaseBudget(attempt.attemptId, { reservationId, reason: 'replayed refund', refusal: { code: 'TARGET_DENIED' } }),
      (error: unknown) => (error as { code?: string }).code === 'reservation-already-released',
      'a refund cannot be replayed',
    );
    assert.deepEqual(prepared.app.store.getAttempt(attempt.attemptId)!.usage, usageAfter, 'the replay refunded nothing');
    const releasesAfterReplay = readAttemptEvents(prepared, attempt.attemptId).filter(event => event.type === 'budget.released');
    assert.equal(releasesAfterReplay.length, releasesBefore.size + 1, 'the replay left no second release record');

    // Dispatched work stays charged: the worker's own observations still own consumed reservations with no refund.
    const refundedIds = new Set(releasesAfterReplay.map(event => event.payload.reservationId));
    const stillCharged = events.filter(event => event.type === 'budget.consumed' && typeof event.payload.reservationId === 'string' && !refundedIds.has(event.payload.reservationId));
    assert.ok(stillCharged.length > 0, 'dispatched observations stay charged');
    assert.ok(usageAfter.toolCalls >= stillCharged.length, 'the attempt usage still counts every dispatched call');
  } finally {
    await prepared.app.supervisor.cancel(RUN_ID).catch(() => {});
    await prepared.app.close();
    await prepared.closeFixtures();
  }
});

/** Durable events for one attempt, paged so a long run never hides the probe's own records. */
function readAttemptEvents(prepared: PreparedAssessment, attemptId: string): Array<{ type: string; payload: Record<string, unknown> }> {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let after = 0;
  for (;;) {
    const page = prepared.app.store.listEvents({ runId: RUN_ID, afterSequence: after, limit: 1_000 });
    if (!page.length) break;
    after = page.at(-1)!.sequence;
    for (const event of page) if (event.attemptId === attemptId) events.push({ type: event.type, payload: event.payload as Record<string, unknown> });
    if (page.length < 1_000) break;
  }
  return events;
}


test('[verification] a replay override that omits the verification policy gets the controller policy for the verifier attempt', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'p2o-e2e-replay-policy-'));
  const result = await runLocalAssessment({
    runRoot: runDir,
    log: () => {},
    // The override hands back a session with NO policy at all; the controller must inject its own, bound to
    // the actual verifier attempt's broker scope, or no bounded question could ever reach validation.
    replaySessionDecorator: session => ({ ...session, verificationPolicy: undefined }),
  });
  assert.equal(result.terminal, true);
  assert.equal(result.accepted, 4, 'the chain still accepts the mapping, both hypotheses and the verifier packet');
  assert.deepEqual(result.findings, [{ findingId: FINDING_EXPORT, state: 'independently-validated', taskId: TASK_HYP_EXPORT }],
    'the controller-injected policy admits the independent replay');
});

test('[verification] a replay override that supplies a conflicting policy is refused by name', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'p2o-e2e-replay-conflict-'));
  const result = await runLocalAssessment({
    runRoot: runDir,
    log: () => {},
    replaySessionDecorator: session => ({
      ...session,
      verificationPolicy: { ...session.verificationPolicy!, scopeDigest: 'f'.repeat(64) },
    }),
  });
  assert.equal(result.terminal, true);
  const finding = result.report.findings.find(candidate => candidate.findingId === FINDING_EXPORT);
  assert.ok(finding, 'the export finding is present in the report');
  assert.notEqual(finding.state, 'independently-validated', 'a conflicting policy can never promote the finding');
  assert.ok(finding.limitations.some(text => text.includes('replay-policy-conflict')),
    `the refusal must be named in the finding limitations: ${JSON.stringify(finding.limitations)}`);
  assert.equal(result.findings.some(entry => entry.state === 'independently-validated'), false, 'no finding is validated under a conflicting policy');
});

test('[verification] the policy seam preserves an environment\'s own plan refusal (no bypass, no injection)', async () => {
  const prepared = await prepareLocalAssessment({ log: () => {} });
  try {
    const template = prepared.config.policy.grantTemplates.find(candidate => candidate.taskId === TASK_VERIFY_EXPORT);
    assert.ok(template, 'the owner document approves a verifier grant');
    const scopeFor = (attemptId: string): Scope => ({
      version: 1,
      runId: prepared.config.policy.runId,
      authorization: prepared.config.policy.authorization,
      targets: prepared.config.policy.targets,
      exclusions: prepared.config.policy.exclusions,
      accounts: prepared.config.policy.accounts,
      grants: [{ ...template!, attemptId }],
    });
    const bound = bindControllerVerificationPolicy({ run: prepared.config.run, scopeFor, now: () => Date.now() })({
      // The controller's built-in factory refuses an unregistered plan; the seam must propagate that refusal
      // unchanged instead of injecting a policy and continuing.
      async prepare() { throw Object.assign(new Error('No controller-registered replay plan exists for this task'), { code: 'unapproved-verification' }); },
    });
    await rejects(
      bound.prepare({ attempt: { attemptId: 'attempt-verifier-1' } } as never),
      (error: unknown) => (error as { code?: string }).code === 'unapproved-verification',
    );
  } finally {
    await prepared.app.close();
    await prepared.closeFixtures();
  }
});

/** The verifier attempt's owner-approved scope, built the same way the composition's `brokerScope` does. */
function verifierScopeFor(prepared: PreparedAssessment) {
  return (attemptId: string): Scope => {
    const template = prepared.config.policy.grantTemplates.find(candidate => candidate.taskId === TASK_VERIFY_EXPORT);
    assert.ok(template, 'the owner document approves a verifier grant');
    return {
      version: 1,
      runId: prepared.config.policy.runId,
      authorization: prepared.config.policy.authorization,
      targets: prepared.config.policy.targets,
      exclusions: prepared.config.policy.exclusions,
      accounts: prepared.config.policy.accounts,
      grants: [{ ...template!, attemptId }],
    };
  };
}

test('[verification] a scope defect refuses BEFORE any environment is created (no leaked session)', async () => {
  const prepared = await prepareLocalAssessment({ log: () => {} });
  try {
    let prepareCalls = 0;
    const bound = bindControllerVerificationPolicy({
      run: prepared.config.run,
      // The real `brokerScope` throws exactly this way for an attempt the durable store does not own.
      scopeFor: () => { throw new ApplicationError('attempt-missing', 'No durable attempt attempt-verifier-1'); },
      now: () => Date.now(),
    })({
      async prepare() { prepareCalls += 1; throw new Error('the environment must never be created for a defective scope'); },
    } as never);
    await rejects(
      bound.prepare({ attempt: { attemptId: 'attempt-verifier-1' } } as never),
      (error: unknown) => (error as { code?: string }).code === 'attempt-missing',
    );
    assert.equal(prepareCalls, 0, 'policy validation must happen before the environment side effect');
  } finally {
    await prepared.app.close();
    await prepared.closeFixtures();
  }
});

test('[verification] an uncooperative close cannot stall the refusal beyond the bounded release', async () => {
  const prepared = await prepareLocalAssessment({ log: () => {} });
  try {
    let closeCalls = 0;
    const bound = bindControllerVerificationPolicy({
      run: prepared.config.run,
      scopeFor: verifierScopeFor(prepared),
      now: () => Date.now(),
    })({
      async prepare() {
        return {
          // A hostile/buggy environment: it ignores the AbortSignal and its close never settles.
          close() { closeCalls += 1; return new Promise<void>(() => {}); },
          verificationPolicy: { runId: 'foreign-run', scopeDigest: 'f'.repeat(64) },
        } as never;
      },
    } as never);
    const started = Date.now();
    const failure = await bound.prepare({ attempt: { attemptId: 'attempt-verifier-1' } } as never).then(() => undefined, (error: unknown) => error);
    const elapsed = Date.now() - started;
    assert.equal((failure as { code?: string } | undefined)?.code, 'replay-policy-conflict');
    assert.match(String((failure as Error).message), /prepared environment release: timeout/, 'the bounded release outcome must be recorded, not assumed');
    assert.equal(closeCalls, 1, 'the refusal must still attempt to release the prepared environment');
    assert.ok(elapsed < 1_500, `the refusal must not wait for an uncooperative close (waited ${elapsed}ms)`);
  } finally {
    await prepared.app.close();
    await prepared.closeFixtures();
  }
});

interface BridgeHarnessState {
  lifecycle: AttemptRecord['lifecycleState'];
  deadlineAt: string;
  runState: 'created' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
  lease: WorkspaceLease | undefined;
}

interface BridgeHarness {
  bridge: ReturnType<typeof createWorkerBridge>;
  attemptId: string;
  token: string;
  state: BridgeHarnessState;
  activeLease: WorkspaceLease;
  signalSeen?: AbortSignal;
  started: boolean;
}

/** Minimal bridge harness: a controller-owned handle file plus a mutable durable-state stub. */
async function bridgeHarness(operations: Partial<WorkerBridgeOperations>): Promise<BridgeHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'p2o-bridge-'));
  const controlRoot = join(dir, 'control');
  mkdirSync(join(controlRoot, 'handles'), { recursive: true, mode: 0o700 });
  const attemptId = 'attempt-1';
  const taskId = 'task-1';
  const token = 't'.repeat(32);
  writeFileSync(join(controlRoot, 'handles', `${attemptId}.json`), JSON.stringify({ version: 1, runId: 'run-1', taskId, attemptId, ownerToken: token, deadlineAt: Date.now() + 60_000 }), { mode: 0o600 });
  const activeLease: WorkspaceLease = {
    workspace: join(dir, 'workspace'), runId: 'run-1', taskId, attemptId, ownerId: 'owner',
    token: 'lease-token', generation: 1, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const state: BridgeHarnessState = { lifecycle: 'running', deadlineAt: new Date(Date.now() + 60_000).toISOString(), runState: 'active', lease: activeLease };
  const attempt = {
    schemaVersion: 1, runId: 'run-1', taskId, attemptId, sequence: 1, ownerId: 'owner', leaseToken: 'lease-token',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lifecycleState: 'running',
    requestedRuntime: { adapter: 'headless', selection: { provider: 'p', model: 'm', thinking: 'max' }, requiredCapabilities: ['ownsLifecycle'] },
    heartbeatAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(), usage: { requests: 0, bytes: 0, toolCalls: 0, tokens: 0, costUsd: 0 },
  } as unknown as AttemptRecord;
  const store = {
    getAttempt: (id: string) => id === attemptId ? { ...attempt, lifecycleState: state.lifecycle, deadlineAt: state.deadlineAt } : undefined,
    getLease: (id: string) => id === taskId ? state.lease : undefined,
    getRun: () => ({ runId: 'run-1', state: state.runState }),
  } as unknown as DurableStore;
  const harness = { attemptId, token, state, activeLease, started: false } as BridgeHarness;
  harness.bridge = createWorkerBridge({
    socketPath: join(dir, 'bridge.sock'),
    controlRoot,
    runId: 'run-1',
    store,
    requestTimeoutMs: 2_000,
    closeTimeoutMs: 300,
    operations: {
      serialize: (_attemptId, work) => work(),
      log: () => {},
      execute: operations.execute ?? (async () => ({ ok: true })),
      acceptedInputs: async () => [],
      attemptState: async () => {
        harness.started = true;
        return { attemptId, taskId };
      },
      verify: async () => ({ status: 'returned-for-evidence' }),
      ...operations,
    } as WorkerBridgeOperations,
  });
  await harness.bridge.listen();
  return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

/** Build an application that owns a private run directory but has not started any work. */
async function buildIdleApplication(): Promise<PreparedAssessment> {
  const prepared = await prepareLocalAssessment({ log: () => {} });
  await prepared.closeFixtures();
  return prepared;
}
