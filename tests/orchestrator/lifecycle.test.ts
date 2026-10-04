import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTerminalLifecycle } from '../../src/contracts/index.js';
import {
  admitRunAndTasks, admitTaskEvidence, codeIs, createHarness, eventTypes, latestAttempt, packetFor,
  submitAccepted, submitPacket, taskBudget,
} from './fixtures.js';

test('independent bounded questions overlap under the run concurrency limit', async () => {
  const harness = createHarness({
    perTargetConcurrency: 2,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 10_000, status: 'settled' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1'), harness.task('task-2')]);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.runtime.starts.length, 2);
    assert.equal(harness.runtime.maxConcurrent, 2);
    const tasks = harness.store.listTasks(harness.run.runId);
    assert.ok(tasks.every(task => task.lifecycleState === 'running'));
  } finally { harness.store.close(); }
});

test('per-target concurrency serializes attempts on one target', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 100, status: 'settled' }] },
  });
  try {
    const first = harness.task('task-1', { budgets: taskBudget({ maxAttempts: 1 }) });
    await admitRunAndTasks(harness, [first, harness.task('task-2')]);
    await harness.supervisor.tick(harness.run.runId);
    assert.deepEqual(harness.runtime.starts, [latestAttempt(harness, 'task-1').attemptId]);
    assert.equal(harness.runtime.maxConcurrent, 1);
    harness.clock.advance(200);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.runtime.starts.length, 2);
    assert.equal(harness.runtime.maxConcurrent, 1);
    assert.equal(harness.store.listTasks(harness.run.runId)[0].lifecycleState, 'failed');
  } finally { harness.store.close(); }
});

test('dependencies wait for an accepted handoff packet and are summarized for the consumer', async () => {
  const harness = createHarness({
    perTargetConcurrency: 3,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 30_000, status: 'settled' }] },
  });
  try {
    const producer = harness.task('task-a');
    const consumer = harness.task('task-b', { dependencyTaskIds: ['task-a'] });
    await admitRunAndTasks(harness, [producer, consumer]);
    await harness.supervisor.tick(harness.run.runId);
    assert.deepEqual(harness.runtime.starts, [latestAttempt(harness, 'task-a').attemptId]);

    admitTaskEvidence(harness, 'task-a');
    const admitted = await submitAccepted(harness, 'task-a');
    assert.equal(admitted.decision.status, 'accepted');
    await harness.supervisor.tick(harness.run.runId);
    const consumerAttempt = latestAttempt(harness, 'task-b');
    assert.equal(harness.runtime.starts[1], consumerAttempt.attemptId);
    const port = harness.supervisor.worker(consumerAttempt.attemptId);
    assert.deepEqual(port.acceptedInputs().map(packet => packet.packetId), [admitted.packet.packetId]);
    assert.equal(harness.store.listTasks(harness.run.runId)[0].packetState, 'accepted');
  } finally { harness.store.close(); }
});

test('cancel stops scheduling and reports verified termination for every owned attempt', async () => {
  const harness = createHarness({
    perTargetConcurrency: 3,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1'), harness.task('task-2')]);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.runtime.starts.length, 2);
    const snapshot = await harness.supervisor.cancel(harness.run.runId);
    assert.equal(snapshot.run.state, 'cancelled');
    assert.deepEqual(snapshot.outstandingLeases, []);
    assert.equal(snapshot.draining, false);
    assert.ok(snapshot.attempts.every(attempt => attempt.lifecycleState === 'cancelled'));
    assert.ok(harness.runtime.stops.length >= 2 && harness.runtime.stops.every(stop => stop.verified));
    assert.throws(() => harness.supervisor.worker(snapshot.attempts[0].attemptId), codeIs('stale-attempt'));
  } finally { harness.store.close(); }
});

test('unverified termination retains the workspace fence and never resumes cancelled work', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }], stopVerified: false },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attemptId = latestAttempt(harness, 'task-1').attemptId;
    const snapshot = await harness.supervisor.cancel(harness.run.runId);
    assert.equal(snapshot.run.state, 'active');
    assert.deepEqual(snapshot.outstandingLeases, ['task-1']);
    assert.equal(snapshot.draining, true);
    assert.equal(harness.store.getAttempt(attemptId)?.lifecycleState, 'reconciling');
    assert.ok(eventTypes(harness).includes('orchestrator.reconcile-required'));
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getAttempt(attemptId)?.lifecycleState, 'reconciling');
    assert.equal(harness.store.listAttempts(harness.run.runId).length, 1);

    harness.runtime.options.stopVerified = true;
    await harness.supervisor.recover(harness.run.runId);
    await harness.supervisor.tick(harness.run.runId);
    const after = harness.supervisor.snapshot(harness.run.runId);
    assert.equal(after.run.state, 'cancelled');
    assert.deepEqual(after.outstandingLeases, []);
    assert.equal(harness.store.getAttempt(attemptId)?.lifecycleState, 'cancelled');
  } finally { harness.store.close(); }
});

test('an expired attempt deadline drains by receipt-backed reconciliation', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', { budgets: taskBudget({ maxAttempts: 1 }) })]);
    await harness.supervisor.tick(harness.run.runId);
    const attemptId = latestAttempt(harness, 'task-1').attemptId;
    harness.clock.advance(Date.parse('2026-10-02T11:00:01.000Z') - harness.clock.now());
    const snapshot = await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getAttempt(attemptId)?.lifecycleState, 'timed-out');
    assert.deepEqual(snapshot.outstandingLeases, []);
    assert.equal(snapshot.run.state, 'completed');
    assert.ok(eventTypes(harness).includes('orchestrator.fence-rejected'));
  } finally { harness.store.close(); }
});

test('invalid evidence is returned for evidence, then a corrected attempt is accepted', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 30_000, status: 'settled' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    admitTaskEvidence(harness, 'task-1');
    const missing = await submitPacket(harness, 'task-1', packetFor(harness, 'task-1', { packetId: 'packet-invalid-1', evidenceIds: ['ghost-evidence'] }));
    assert.equal(missing.decision.status, 'returned-for-evidence');
    assert.ok(missing.decision.reasons.some(reason => reason.code === 'missing-reference'));
    assert.equal(harness.store.listTasks(harness.run.runId)[0].packetState, 'returned-for-evidence');

    const accepted = await submitPacket(harness, 'task-1', packetFor(harness, 'task-1'), 'corrected-key');
    assert.equal(accepted.decision.status, 'accepted');
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.listTasks(harness.run.runId)[0].packetState, 'accepted');
    const last = latestAttempt(harness, 'task-1');
    assert.equal(last.lifecycleState, 'exited');
    assert.equal(harness.store.getRun(harness.run.runId)?.state, 'completed');
  } finally { harness.store.close(); }
});

test('a worker cannot substitute the runtime it was given', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 30_000, status: 'settled' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    admitTaskEvidence(harness, 'task-1');
    const attempt = latestAttempt(harness, 'task-1');
    const forged = packetFor(harness, 'task-1', {
      requestedRuntime: { ...attempt.requestedRuntime, selection: { ...attempt.requestedRuntime.selection, model: 'forged-model' } },
    });
    const admission = await submitPacket(harness, 'task-1', forged);
    assert.equal(admission.decision.status, 'returned-for-evidence');
    assert.ok(admission.decision.reasons.some(reason => reason.code === 'runtime-mismatch' || reason.code === 'runtime-request'));
    assert.notEqual(admission.decision.status, 'accepted');
  } finally { harness.store.close(); }
});

test('admitted results replay idempotently while a stale lease cannot publish new content', async () => {
  const harness = createHarness({ perTargetConcurrency: 1 });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    admitTaskEvidence(harness, 'task-1');
    const attempt = latestAttempt(harness, 'task-1');
    const first = await submitAccepted(harness, 'task-1');
    assert.equal(first.decision.status, 'accepted');
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getLease('task-1'), undefined);

    const replay = await harness.supervisor.submitResult(attempt.attemptId, { packet: first.packet, idempotencyKey: 'replay-key' });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.decision.status, 'accepted');
    assert.equal(harness.store.listResults(harness.run.runId).length, 1);

    const late = packetFor(harness, 'task-1', { packetId: 'packet-late-1' });
    await assert.rejects(
      () => submitPacket(harness, 'task-1', late, 'late-key'),
      codeIs('stale-lease'),
    );
    assert.equal(harness.store.listResults(harness.run.runId).length, 1);
  } finally { harness.store.close(); }
});

test('restart reconciles a live worker without duplicating it and without a fresh approval', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attemptId = latestAttempt(harness, 'task-1').attemptId;

    const second = createHarness({ root: harness.root, store: harness.store, clock: harness.clock, ownerId: 'supervisor-b' });
    try {
      const report = await second.supervisor.recover(harness.run.runId);
      assert.deepEqual(report.resumed, [attemptId]);
      assert.equal(second.runtime.starts.length, 0);
      assert.equal(second.runtime.stops.length, 0);
      assert.equal(harness.store.listAttempts(harness.run.runId).length, 1);
      assert.equal(harness.store.getLease('task-1')?.attemptId, attemptId);

      const cancelled = await second.supervisor.cancel(harness.run.runId);
      assert.equal(cancelled.run.state, 'cancelled');
      assert.equal(second.runtime.starts.length, 0);
      assert.deepEqual(second.runtime.stops.map(stop => stop.attemptId), [attemptId]);
      assert.equal(harness.store.listAttempts(harness.run.runId).length, 1);
      assert.deepEqual(second.supervisor.snapshot(harness.run.runId).outstandingLeases, []);
    } finally { second.supervisor.dispose(); }

    const third = createHarness({ root: harness.root, store: harness.store, clock: harness.clock, ownerId: 'supervisor-c' });
    try {
      third.authority.denyTransfer = true;
      await assert.rejects(() => third.supervisor.tick(harness.run.runId), codeIs('control-conflict'));
      third.authority.denyTransfer = false;
      assert.equal(harness.store.listAttempts(harness.run.runId).length, 1);
    } finally { third.supervisor.dispose(); }
  } finally { harness.store.close(); }
});

test('a recovered retryable task is not relaunched without a fresh owner approval', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attemptId = latestAttempt(harness, 'task-1').attemptId;
    harness.supervisor.dispose();

    const second = createHarness({
      root: harness.root, store: harness.store, clock: harness.clock, ownerId: 'supervisor-b',
      runtimeOptions: { reconcileState: () => 'terminated' },
    });
    try {
      const report = await second.supervisor.recover(harness.run.runId);
      assert.deepEqual(report.released, [attemptId]);
      assert.deepEqual(report.retryableTaskIds, ['task-1']);
      const snapshot = await second.supervisor.tick(harness.run.runId);
      assert.equal(second.runtime.starts.length, 0);
      assert.equal(harness.store.listAttempts(harness.run.runId).length, 1);
      assert.ok(harness.store.listEvents({ runId: harness.run.runId }).some(event =>
        event.type === 'orchestrator.scheduling-blocked' && (event.payload as { taskId?: string }).taskId === 'task-1'));
      assert.equal(snapshot.tasks[0].lifecycleState, 'failed');
      assert.equal(snapshot.run.state, 'completed');
      // A finished run is not resurrected: even owner re-approval cannot extend a terminal run.
      await assert.rejects(
        () => second.supervisor.admitTask({ manifest: harness.task('task-1'), role: 'worker' }),
        codeIs('run-not-active'),
      );
      await second.supervisor.tick(harness.run.runId);
      assert.equal(second.runtime.starts.length, 0);
      assert.equal(harness.store.getRun(harness.run.runId)?.state, 'completed');
    } finally { second.supervisor.dispose(); }
  } finally { harness.store.close(); }
});

test('a completed run is not duplicated by a later controller', async () => {
  const harness = createHarness({ perTargetConcurrency: 1 });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    admitTaskEvidence(harness, 'task-1');
    assert.equal((await submitAccepted(harness, 'task-1')).decision.status, 'accepted');
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getRun(harness.run.runId)?.state, 'completed');
    const attemptsBefore = harness.store.listAttempts(harness.run.runId).length;

    const second = createHarness({ root: harness.root, store: harness.store, clock: harness.clock, ownerId: 'supervisor-b' });
    try {
      harness.clock.advance(5_000);
      await second.supervisor.tick(harness.run.runId);
      assert.equal(second.runtime.starts.length, 0);
      assert.equal(harness.store.listAttempts(harness.run.runId).length, attemptsBefore);
      assert.equal(harness.store.getRun(harness.run.runId)?.state, 'completed');
    } finally { second.supervisor.dispose(); }
  } finally { harness.store.close(); }
});

test('the collector path accepts a preserved packet and stops the worker', async () => {
  const queue: import('../../src/orchestrator/index.js').ResultCandidate[] = [];
  let collectCalls = 0;
  const harness = createHarness({
    perTargetConcurrency: 1,
    results: { collect: async () => { collectCalls += 1; return queue.splice(0, queue.length); } },
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 50, status: 'settled' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    admitTaskEvidence(harness, 'task-1');
    queue.push({ packet: packetFor(harness, 'task-1'), idempotencyKey: 'collector-key-1' });
    harness.clock.advance(100);
    const snapshot = await harness.supervisor.tick(harness.run.runId);
    assert.equal(collectCalls, 1);
    assert.equal(snapshot.results.length, 1);
    assert.equal(snapshot.results[0].decision.status, 'accepted');
    assert.equal(snapshot.run.state, 'completed');
    assert.equal(snapshot.outstandingLeases.length, 0);
    assert.ok(isTerminalLifecycle(snapshot.attempts[0].lifecycleState));
    assert.ok(snapshot.attempts[0].exit);
  } finally { harness.store.close(); }
});

test('durable events are delivered through the outbox without free-text leakage', async () => {
  const delivered: string[] = [];
  const harness = createHarness({
    perTargetConcurrency: 1,
    events: { deliver: async event => { delivered.push(event.type); } },
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 30_000, status: 'settled' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    admitTaskEvidence(harness, 'task-1');
    assert.equal((await submitAccepted(harness, 'task-1')).decision.status, 'accepted');
    await harness.supervisor.tick(harness.run.runId);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const flushed = await harness.supervisor.flushOutbox();
      if (flushed.delivered === 0) break;
    }
    assert.ok(delivered.includes('orchestrator.attempt-launched'));
    assert.ok(delivered.includes('orchestrator.result-admitted'));
    assert.ok(delivered.includes('orchestrator.run-finished'));
    assert.equal(harness.store.listOutbox({ includeDelivered: false }).length, 0);
    const exported = harness.store.exportJsonl({ runId: harness.run.runId });
    assert.ok(exported.includes('orchestrator.attempt-launched'));
    assert.ok(exported.includes('orchestrator.run-finished'));
    assert.ok(!exported.includes('nextAction'));
  } finally { harness.store.close(); }
});
