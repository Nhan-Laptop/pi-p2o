import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateHandoff } from '../../src/contracts/index.js';
import { packetAuthoringFor } from '../../src/application/packet-authoring.js';
import { createSupervisor } from '../../src/orchestrator/index.js';
import { openStore } from '../../src/store/index.js';
import { join } from 'node:path';
import { admitAuthenticatedPacket } from '../../src/application/packet-admission.js';
import { admitRunAndTasks, admitTaskEvidence, createHarness, latestAttempt, packetFor, supervisorOptionsFor, taskBudget, fixtureRun } from './fixtures.js';

test('controller authoring clock preserves future-packet gate and supplies source-only H1 guidance without forging facts', async () => {
  const harness = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-clock')]);
    await harness.supervisor.tick(harness.run.runId);
    admitTaskEvidence(harness, 'task-clock');
    const attempt = latestAttempt(harness, 'task-clock');
    const task = harness.store.getTask('task-clock')!;
    const guidance = packetAuthoringFor(task, attempt, harness.clock.iso());
    assert.equal(guidance.envelope.createdAt, harness.clock.iso());
    assert.equal(guidance.envelope.observedRuntime, attempt.observedRuntime ?? null);
    assert.equal('details' in guidance.envelope, false);
    assert.equal('evidenceIds' in guidance.envelope, false);
    assert.match(guidance.requirements.H1.inferred, /proposedCheck.*source evidenceIds/);
    const packet = packetFor(harness, task.taskId);
    const context = { authorization: harness.run.authorization, evidence: harness.store.listEvidence(harness.run.runId), reviewerId: 'reviewer-1', now: harness.clock.iso(), task, attempt };
    const future = { ...packet, createdAt: new Date(harness.clock.now() + 60_000).toISOString() };
    const rejected = evaluateHandoff(future, context);
    assert.equal(rejected.status, 'returned-for-evidence');
    assert.ok(rejected.reasons.some(reason => reason.code === 'future-packet' && reason.path === '$/createdAt'));
    assert.equal(evaluateHandoff({ ...future, createdAt: guidance.envelope.createdAt }, context).status, 'accepted');
    const sourceH1 = { ...packet, contract: 'H1', outcome: 'static-only', classification: 'static-inference',
      details: { interfaces: [{ surfaceId: 'actual-route', registration: 'GET /owned', handler: 'source-defined handler', actorId: task.scope.actor.id, gate: 'source-defined gate', processIdentity: 'not dynamically observed', formats: ['http'], benignOperations: ['read'], priority: 1, priorityReason: 'source-backed boundary', evidenceIds: [packet.evidenceIds[0]], reachability: 'inferred', proposedCheck: 'Owner must approve a dynamic handler check separately' }], unresolvedRoutes: ['runtime reachability untested'] } };
    assert.equal(evaluateHandoff(sourceH1, context).status, 'accepted');
    const fakeObserved = structuredClone(sourceH1); fakeObserved.details.interfaces[0]!.reachability = 'observed';
    assert.ok(evaluateHandoff(fakeObserved, context).reasons.some(reason => reason.code === 'H1-prioritized-entry'));
  } finally { harness.store.close(); }
});

test('authenticated malformed collection and identity failures consume durable slots across restart with safe feedback', async () => {
  const harness = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-malformed', { budgets: taskBudget({ maxAttempts: 1 }) })]);
    await harness.supervisor.tick(harness.run.runId);
    admitTaskEvidence(harness, 'task-malformed');
    const attempt = latestAttempt(harness, 'task-malformed');
    const submit = (candidate: Parameters<typeof harness.supervisor.submitResult>[1]) => harness.supervisor.submitResult(attempt.attemptId, candidate);
    const first = await admitAuthenticatedPacket({ attempt, store: harness.store, now: () => harness.clock.iso(), collect: async () => { throw new Error('malformed JSON with sk-sensitive-value-never-echo'); }, submit });
    assert.equal(first.accepted, false);
    assert.equal(first.remainingCorrections, 1);
    assert.equal(first.rejectedSubmissions, 1);
    assert.doesNotMatch(JSON.stringify(first), /sk-sensitive/);
    const fresh = openStore({ path: join(harness.root, 'run.sqlite'), clock: () => harness.clock.iso() });
    try {
      const foreign = { ...packetFor(harness, attempt.taskId), attemptId: 'foreign-attempt' };
      const second = await admitAuthenticatedPacket({ attempt, store: fresh, now: () => harness.clock.iso(), collect: async () => [{ packet: foreign, idempotencyKey: 'foreign-packet' }], submit });
      assert.equal(second.accepted, false);
      assert.ok(second.reasons.includes('result-identity'));
      assert.equal(second.rejectedSubmissions, 2);
      assert.equal(second.remainingCorrections, 0);
      const denied = await admitAuthenticatedPacket({ attempt, store: fresh, now: () => harness.clock.iso(), collect: async () => { throw new Error('must not collect again'); }, submit });
      assert.deepEqual(denied.reasons, ['packet-rejection-limit']);
      assert.equal(fresh.packetSubmissionSlots(attempt.runId, attempt.attemptId), 2);
    } finally { fresh.close(); }
    const restarted = createSupervisor(supervisorOptionsFor(harness));
    try {
      await restarted.tick(attempt.runId);
      assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'failed');
      assert.equal(harness.runtime.stops.length, 1);
    } finally { restarted.dispose(); }
  } finally { harness.store.close(); }
});

test('valid gate acceptance clears only its producing attempt verdict, never its slot consumption or another attempt', async () => {
  const run = fixtureRun();
  const harness = createHarness({ perTargetConcurrency: 2, runOverrides: { budgets: { ...run.budgets, maxConcurrency: 2 } }, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-A'), harness.task('task-B')]); await harness.supervisor.tick(harness.run.runId);
    admitTaskEvidence(harness, 'task-A'); admitTaskEvidence(harness, 'task-B');
    const A = latestAttempt(harness, 'task-A'), B = latestAttempt(harness, 'task-B');
    const submit = (attemptId: string) => (candidate: Parameters<typeof harness.supervisor.submitResult>[1]) => harness.supervisor.submitResult(attemptId, candidate);
    await admitAuthenticatedPacket({ attempt: A, store: harness.store, now: () => harness.clock.iso(), collect: async () => [{ packet: { ...packetFor(harness, A.taskId), createdAt: new Date(harness.clock.now() + 60_000).toISOString() }, idempotencyKey: 'A-future' }], submit: submit(A.attemptId) });
    await admitAuthenticatedPacket({ attempt: B, store: harness.store, now: () => harness.clock.iso(), collect: async () => [{ packet: {}, idempotencyKey: 'B-invalid' }], submit: submit(B.attemptId) });
    const accepted = await admitAuthenticatedPacket({ attempt: A, store: harness.store, now: () => harness.clock.iso(), collect: async () => [{ packet: { ...packetFor(harness, A.taskId), packetId: 'accepted-A' }, idempotencyKey: 'A-corrected' }], submit: submit(A.attemptId) });
    assert.equal(accepted.accepted, true); assert.equal(accepted.rejectedSubmissions, 0);
    assert.equal(harness.store.packetRejectionCount(A.runId, A.attemptId), 0);
    assert.equal(harness.store.packetRejectionCount(B.runId, B.attemptId), 1);
    assert.equal(harness.store.packetSubmissionSlots(A.runId, A.attemptId), 2, 'success must not replenish the two-slot allowance');
    const fresh = openStore({ path: join(harness.root, 'run.sqlite'), clock: () => harness.clock.iso() });
    try {
      assert.equal(fresh.packetRejectionCount(A.runId, A.attemptId), 0);
      assert.equal(fresh.packetRejectionCount(B.runId, B.attemptId), 1);
      assert.equal(fresh.reservePacketSubmission(A.runId, A.attemptId).allowed, false);
      assert.equal(fresh.packetSubmissionLimitReached(A.runId, A.attemptId), false, 'accepted A must not become a rejection halt');
    } finally { fresh.close(); }
  } finally { harness.store.close(); }
});

test('identical retries count as two submissions even when result admission is idempotent', async () => {
  const harness = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-identical')]);
    await harness.supervisor.tick(harness.run.runId); admitTaskEvidence(harness, 'task-identical');
    const attempt = latestAttempt(harness, 'task-identical');
    const packet = { ...packetFor(harness, attempt.taskId), createdAt: new Date(harness.clock.now() + 60_000).toISOString() };
    const input = { attempt, store: harness.store, now: () => harness.clock.iso(), collect: async () => [{ packet, idempotencyKey: 'identical' }], submit: (candidate: Parameters<typeof harness.supervisor.submitResult>[1]) => harness.supervisor.submitResult(attempt.attemptId, candidate) };
    const first = await admitAuthenticatedPacket(input);
    const second = await admitAuthenticatedPacket(input);
    assert.equal(first.remainingCorrections, 1); assert.equal(second.remainingCorrections, 0);
    assert.equal(harness.store.listResults(attempt.runId).length, 1);
    assert.equal(harness.store.packetRejectionCount(attempt.runId, attempt.attemptId), 2);
    assert.ok(first.issues.some(issue => issue.code === 'future-packet' && issue.path === '$/createdAt' && issue.message.includes(first.evaluatedAt!)));
  } finally { harness.store.close(); }
});

test('concurrent schema-invalid submissions reserve only two slots before asynchronous collection', async () => {
  const harness = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-concurrent')]); await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-concurrent');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let collected = 0;
    const input = { attempt, store: harness.store, now: () => harness.clock.iso(), collect: async () => { collected++; await gate; return [{ packet: {}, idempotencyKey: `bad-${collected}` }]; }, submit: async () => { throw new Error('invalid schema must not reach submit'); } };
    const first = admitAuthenticatedPacket(input); const second = admitAuthenticatedPacket(input);
    const third = await admitAuthenticatedPacket(input);
    assert.equal(collected, 2); assert.deepEqual(third.reasons, ['packet-rejection-limit']);
    release(); const returned = await Promise.all([first, second]);
    assert.ok(returned.every(result => result.reasons.some(code => code.startsWith('schema:'))));
    assert.equal(harness.store.packetSubmissionSlots(attempt.runId, attempt.attemptId), 2);
    assert.equal(harness.store.packetRejectionCount(attempt.runId, attempt.attemptId), 2);
  } finally { harness.store.close(); }
});

test('two durable rejected submissions stop an owned attempt after controller restart even with observation progress', async t => {
  const noProgress = { windowMs: 0, consecutiveRefusals: 0 };
  const harness = createHarness({ noProgress, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-returns', { budgets: taskBudget({ maxAttempts: 1 }) })]);
    await harness.supervisor.tick(harness.run.runId);
    admitTaskEvidence(harness, 'task-returns');
    const attempt = latestAttempt(harness, 'task-returns');
    for (let index = 1; index <= 2; index++) {
      const packet = { ...packetFor(harness, attempt.taskId), packetId: `future-${index}`, createdAt: new Date(harness.clock.now() + index * 60_000).toISOString() };
      const admission = await harness.supervisor.submitResult(attempt.attemptId, { packet, idempotencyKey: `submission-${index}` });
      assert.equal(admission.decision.status, 'returned-for-evidence');
      assert.ok(admission.decision.reasons.some(reason => reason.code === 'future-packet'));
    }
    assert.equal(harness.store.packetRejectionCount(harness.run.runId, attempt.attemptId), 2);
    const restarted = createSupervisor(supervisorOptionsFor(harness, { noProgress }));
    try {
      await restarted.tick(harness.run.runId);
      assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'failed');
      assert.equal(harness.runtime.stops.length, 1);
      assert.equal(harness.store.getTask(attempt.taskId)?.packetState, 'returned-for-evidence');
      assert.equal(harness.store.listResults(harness.run.runId).filter(result => result.decision.status === 'accepted').length, 0);
      assert.ok(harness.store.listEvents({ runId: harness.run.runId }).some(event => event.type === 'orchestrator.packet-rejection-halt'));
      t.diagnostic('returns=2 clock-gate=preserved fresh-controller=failed owned-stop=1 accepted=0');
    } finally { restarted.dispose(); }
  } finally { harness.store.close(); }
});
