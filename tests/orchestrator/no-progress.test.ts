// Regression tests for the F4 supervisor fixes: the no-progress circuit breaker terminates an attempt that
// burns tool calls and provider turns without ever collecting an observation, and a dependency that fails
// without an accepted packet terminalizes its dependents so the run reaches a verdict (failed/partial)
// instead of staying `active` until the deadline. Inert fake runtime only: no provider, no target traffic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitRunAndTasks, admitTaskEvidence, createHarness, latestAttempt, taskBudget } from './fixtures.js';

test('a never-progressing attempt is terminated with an explicit no-progress reason and its runtime stopped', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    noProgress: { windowMs: 60_000, minToolCalls: 2 },
    runtimeOptions: { steps: [{ at: 0, status: 'running' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', { budgets: taskBudget({ maxAttempts: 1 }) })]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    assert.equal(attempt.lifecycleState, 'running');
    // Two tool calls charged, zero collected observations: the dead-loop shape the live run hit.
    harness.supervisor.consumeBudget(attempt.attemptId, { toolCalls: 2 });
    harness.clock.advance(30_000);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'running', 'the breaker waits for the window');

    harness.clock.advance(31_000);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'failed');
    assert.deepEqual(harness.runtime.stops.map(stop => stop.reason), ['failed'], 'provider turns stop with the runtime');

    const events = harness.store.listEvents({ runId: harness.run.runId });
    const halt = events.find(event => event.type === 'orchestrator.no-progress-halt');
    assert.ok(halt, 'the halt is durably recorded with the observed numbers');
    assert.equal(halt?.payload.toolCalls, 2);
    assert.equal(halt?.payload.windowMs, 60_000);
    const terminated = events.find(event => event.type === 'orchestrator.attempt-terminated');
    assert.match(String(terminated?.payload.detail), /no-progress/);
    assert.equal(terminated?.payload.reason, 'failed');
  } finally { harness.store.close(); }
});

test('an attempt that has collected an observation is never halted by the no-progress breaker', async () => {
  const harness = createHarness({
    noProgress: { windowMs: 60_000, minToolCalls: 1 },
    runtimeOptions: { steps: [{ at: 0, status: 'running' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    admitTaskEvidence(harness, 'task-1');
    harness.supervisor.consumeBudget(attempt.attemptId, { toolCalls: 4 });
    harness.clock.advance(600_000);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'running');
    assert.equal(harness.store.listEvents({ runId: harness.run.runId }).some(event => event.type === 'orchestrator.no-progress-halt'), false);
  } finally { harness.store.close(); }
});

test('the breaker is disabled by windowMs 0 and by defaulting below its minToolCalls threshold', async () => {
  const disabled = createHarness({
    noProgress: { windowMs: 0, minToolCalls: 1 },
    runtimeOptions: { steps: [{ at: 0, status: 'running' }] },
  });
  try {
    await admitRunAndTasks(disabled, [disabled.task('task-1')]);
    await disabled.supervisor.tick(disabled.run.runId);
    const attempt = latestAttempt(disabled, 'task-1');
    disabled.supervisor.consumeBudget(attempt.attemptId, { toolCalls: 5 });
    disabled.clock.advance(600_000);
    await disabled.supervisor.tick(disabled.run.runId);
    assert.equal(disabled.store.getAttempt(attempt.attemptId)?.lifecycleState, 'running');
  } finally { disabled.store.close(); }

  const belowThreshold = createHarness({
    noProgress: { windowMs: 60_000, minToolCalls: 3 },
    runtimeOptions: { steps: [{ at: 0, status: 'running' }] },
  });
  try {
    await admitRunAndTasks(belowThreshold, [belowThreshold.task('task-1')]);
    await belowThreshold.supervisor.tick(belowThreshold.run.runId);
    const attempt = latestAttempt(belowThreshold, 'task-1');
    belowThreshold.supervisor.consumeBudget(attempt.attemptId, { toolCalls: 2 });
    belowThreshold.clock.advance(600_000);
    await belowThreshold.supervisor.tick(belowThreshold.run.runId);
    assert.equal(belowThreshold.store.getAttempt(attempt.attemptId)?.lifecycleState, 'running', 'one more call is required before the breaker applies');
  } finally { belowThreshold.store.close(); }
});

test('a dependency that fails without an accepted packet terminalizes its dependents and fails the run', async () => {
  const harness = createHarness({
    perTargetConcurrency: 2,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 5_000, status: 'failed' }] },
  });
  try {
    const producer = harness.task('task-a', { budgets: taskBudget({ maxAttempts: 1 }) });
    const consumer = harness.task('task-b', { dependencyTaskIds: ['task-a'], budgets: taskBudget({ maxAttempts: 1 }) });
    await admitRunAndTasks(harness, [producer, consumer]);
    await harness.supervisor.tick(harness.run.runId);
    harness.clock.advance(10_000);
    await harness.supervisor.tick(harness.run.runId);

    const tasks = harness.store.listTasks(harness.run.runId);
    assert.equal(tasks.find(task => task.taskId === 'task-a')?.lifecycleState, 'failed');
    const dependent = tasks.find(task => task.taskId === 'task-b');
    assert.equal(dependent?.lifecycleState, 'cancelled', 'an unreachable dependent is terminalized explicitly');
    assert.equal(dependent?.packetState, 'draft', 'no coverage or packet is fabricated for a blocked task');
    assert.equal(harness.store.getRun(harness.run.runId)?.state, 'failed', 'the run never stays active until the deadline');

    const events = harness.store.listEvents({ runId: harness.run.runId });
    const blocked = events.find(event => event.type === 'orchestrator.task-blocked');
    assert.deepEqual(blocked?.payload.blockers, ['task-a']);
    const finished = events.find(event => event.type === 'orchestrator.run-finished');
    assert.equal(finished?.payload.state, 'failed');
    assert.equal(finished?.payload.truncation, 'dependency-failed');
    assert.deepEqual(finished?.payload.blockedTaskIds, ['task-b']);
  } finally { harness.store.close(); }
});

test('owner cancellation and the absolute deadline keep their existing terminal semantics', async () => {
  const harness = createHarness({
    noProgress: { windowMs: 60_000, minToolCalls: 1 },
    runtimeOptions: { steps: [{ at: 0, status: 'running' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    harness.supervisor.consumeBudget(attempt.attemptId, { toolCalls: 2 });
    const snapshot = await harness.supervisor.cancel(harness.run.runId);
    assert.equal(snapshot.run.state, 'cancelled');
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'cancelled');
    const events = harness.store.listEvents({ runId: harness.run.runId });
    assert.equal(events.some(event => event.type === 'orchestrator.no-progress-halt'), false, 'cancellation is never reclassified as a no-progress halt');
  } finally { harness.store.close(); }
});

test('[F-3] refunded pre-dispatch refusals still halt the attempt (budget counters cannot hide a dead plane)', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    noProgress: { windowMs: 60_000, minToolCalls: 3, consecutiveRefusals: 3 },
    runtimeOptions: { steps: [{ at: 0, status: 'running' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', { budgets: taskBudget({ maxAttempts: 1 }) })]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    // The R2 shape: every refusal is reserved and then refunded, so usage stays at zero.
    for (let call = 0; call < 6; call++) {
      // The R2 shape: reserve before dispatch, then release by identity when the call never dispatched.
      const reservation = harness.supervisor.reserveBudget(attempt.attemptId, { toolCalls: 1, requests: 1, targetId: 'fixture' });
      harness.supervisor.releaseBudget(attempt.attemptId, { reservationId: reservation.reservationId, reason: 'pre-dispatch refusal (UNAVAILABLE)', refusal: { code: 'UNAVAILABLE' } });
    }
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.toolCalls, 0, 'refunds leave the budget counters at zero');
    harness.clock.advance(600_000);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'failed');
    assert.deepEqual(harness.runtime.stops.map(stop => stop.reason), ['failed'], 'provider turns stop with the runtime');
    const events = harness.store.listEvents({ runId: harness.run.runId });
    const halt = events.find(event => event.type === 'orchestrator.no-progress-halt');
    assert.equal(halt?.payload.refusals, 6, 'the refusal streak is non-refundable');
    assert.equal(halt?.payload.lastCode, 'UNAVAILABLE', 'the structured tool-plane code is recorded, not the free-form reason');
    const terminated = events.find(event => event.type === 'orchestrator.attempt-terminated');
    assert.match(String(terminated?.payload.detail), /consecutive pre-dispatch tool refusals/);
  } finally { harness.store.close(); }
});

test('[F-1] an attempt that collected an observation is never halted as no-progress', async () => {
  const harness = createHarness({
    noProgress: { windowMs: 60_000, minToolCalls: 3, consecutiveRefusals: 3 },
    runtimeOptions: { steps: [{ at: 0, status: 'running' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    admitTaskEvidence(harness, 'task-1');
    harness.supervisor.consumeBudget(attempt.attemptId, { toolCalls: 3, targetId: 'fixture' });
    await harness.supervisor.tick(harness.run.runId);
    harness.clock.advance(301_000);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'running', 'collected evidence must not be reported as zero collected observations');
    assert.equal(harness.store.listEvents({ runId: harness.run.runId }).some(event => event.type === 'orchestrator.no-progress-halt'), false);
    assert.equal(harness.runtime.stops.length, 0);
  } finally { harness.store.close(); }
});

test('[F-2] dependents wait until the dependency can no longer be renewed', async () => {
  const harness = createHarness({
    perTargetConcurrency: 2,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 5_000, status: 'failed' }] },
  });
  try {
    const producer = harness.task('task-a', { budgets: taskBudget({ maxAttempts: 2 }) });
    const consumer = harness.task('task-b', { dependencyTaskIds: ['task-a'], budgets: taskBudget({ maxAttempts: 1 }) });
    await admitRunAndTasks(harness, [producer, consumer]);
    await harness.supervisor.tick(harness.run.runId);
    harness.clock.advance(10_000);
    await harness.supervisor.tick(harness.run.runId);
    const afterFirst = harness.store.listTasks(harness.run.runId);
    assert.equal(afterFirst.find(task => task.taskId === 'task-a')?.lifecycleState, 'running', 'the producer is renewed for its second attempt');
    assert.equal(afterFirst.find(task => task.taskId === 'task-b')?.lifecycleState, 'queued', 'a dependency with attempts left must not terminalize its dependents');
    harness.clock.advance(10_000);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.listAttempts(harness.run.runId, 'task-a').length, 2, 'the producer used both attempts');
    assert.equal(harness.store.listTasks(harness.run.runId).find(task => task.taskId === 'task-b')?.lifecycleState, 'cancelled');
    assert.equal(harness.store.getRun(harness.run.runId)?.state, 'failed');
  } finally { harness.store.close(); }
});

test('[R-3/F] a cancelled dependency permanently blocks its transitive dependents', async () => {
  const harness = createHarness({
    perTargetConcurrency: 3,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 5_000, status: 'failed' }] },
  });
  try {
    const first = harness.task('task-a', { budgets: taskBudget({ maxAttempts: 1 }) });
    const second = harness.task('task-b', { dependencyTaskIds: ['task-a'], budgets: taskBudget({ maxAttempts: 1 }) });
    const third = harness.task('task-c', { dependencyTaskIds: ['task-b'], budgets: taskBudget({ maxAttempts: 1 }) });
    await admitRunAndTasks(harness, [first, second, third]);
    await harness.supervisor.tick(harness.run.runId);
    harness.clock.advance(10_000);
    await harness.supervisor.tick(harness.run.runId);
    const tasks = harness.store.listTasks(harness.run.runId);
    assert.equal(tasks.find(task => task.taskId === 'task-a')?.lifecycleState, 'failed');
    assert.equal(tasks.find(task => task.taskId === 'task-b')?.lifecycleState, 'cancelled');
    assert.equal(tasks.find(task => task.taskId === 'task-c')?.lifecycleState, 'cancelled', 'the transitive dependent must not stay queued behind a cancelled dependency');
    assert.equal(harness.store.getRun(harness.run.runId)?.state, 'failed');
  } finally { harness.store.close(); }
});
