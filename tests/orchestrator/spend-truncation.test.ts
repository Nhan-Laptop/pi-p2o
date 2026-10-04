// [T10] Run-level honesty for a spend-truncated run (T9 residual 3, R3 §6.1 consequence 2).
//
// A run whose attempt was cut short by the model spend ledger — a provider turn refused at the gateway, or an
// admitted turn whose charge could not be persisted — must not be reported `completed` at run level just
// because every task is terminal. These tests drive the real supervisor with the inert fixture runtime, which
// now emits the same durable `spend-refused` marker the production runtime writes on its handle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSupervisor } from '../../src/orchestrator/index.js';
import {
  admitRunAndTasks, createHarness, eventTypes, latestAttempt, supervisorOptionsFor, taskBudget,
} from './fixtures.js';

/** One attempt only: this suite is about the run's terminal classification, not about retries. */
const oneAttempt = () => ({ budgets: taskBudget({ maxAttempts: 1 }) });

const SPEND_REFUSAL = "Model spend admission refused a provider turn: Model token budget cannot cover the next provider turn's worst case";

/** The production runtime's shape: the refusal is a durable handle event, then the worker exits failed. */
const refusalSteps = () => ([
  { at: 0, status: 'running' as const },
  // A refused provider turn while the worker is still alive: the durable marker is written first.
  { at: 1_000, status: 'running' as const, event: 'spend-refused', eventText: SPEND_REFUSAL },
  { at: 2_000, status: 'failed' as const, startupError: SPEND_REFUSAL },
]);

test('a run cut short by a spend refusal is failed at run level, not completed', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: { steps: refusalSteps() } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', oneAttempt())]);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(latestAttempt(harness, 'task-1').lifecycleState, 'running');

    // The refusal is observed while the attempt is still running: it is recorded durably, not as a completion.
    harness.clock.advance(1_500);
    await harness.supervisor.tick(harness.run.runId);
    assert.ok(eventTypes(harness).includes('orchestrator.spend-truncated'), 'the refusal must be recorded as a durable marker');
    assert.equal(harness.supervisor.snapshot(harness.run.runId).run.state, 'active', 'the run is not finished while the attempt is live');

    harness.clock.advance(1_000);
    await harness.supervisor.tick(harness.run.runId);
    const snapshot = harness.supervisor.snapshot(harness.run.runId);
    assert.equal(snapshot.run.state, 'failed', 'a spend-truncated run must never be labelled completed');
    assert.equal(harness.store.listTasks(harness.run.runId)[0]!.lifecycleState, 'failed');
    assert.deepEqual(harness.store.listResults(harness.run.runId), [], 'a truncated run admits no result');

    const finished = harness.store.listEvents({ runId: harness.run.runId, limit: 1_000 })
      .find(event => event.type === 'orchestrator.run-finished');
    assert.ok(finished, 'the run must record its terminal summary');
    assert.equal(finished.payload.state, 'failed');
    assert.equal(finished.payload.accepted, 0);
    assert.equal(finished.payload.truncation, 'model-spend-refusal', 'the terminal report must name the truncation');
    assert.deepEqual(finished.payload.truncatedTaskIds, ['task-1']);
  } finally { harness.store.close(); }
});

test('an ordinary worker failure is still a completed run: the truncation rule is spend-specific', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runtimeOptions: { steps: [{ at: 0, status: 'running' }, { at: 1_000, status: 'failed' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', oneAttempt())]);
    await harness.supervisor.tick(harness.run.runId);
    harness.clock.advance(2_000);
    await harness.supervisor.tick(harness.run.runId);
    const snapshot = harness.supervisor.snapshot(harness.run.runId);
    assert.equal(snapshot.run.state, 'completed', 'the pre-existing run classification is unchanged without a spend marker');
    assert.equal(harness.store.listTasks(harness.run.runId)[0]!.lifecycleState, 'failed');
    const finished = harness.store.listEvents({ runId: harness.run.runId, limit: 1_000 })
      .find(event => event.type === 'orchestrator.run-finished');
    assert.equal(finished?.payload.state, 'completed');
    assert.equal(finished?.payload.truncation, undefined, 'an ordinary failure must not claim a spend truncation');
  } finally { harness.store.close(); }
});

test('a restarted supervisor re-derives the truncation from the durable marker', async () => {
  const harness = createHarness({ perTargetConcurrency: 1, runtimeOptions: { steps: refusalSteps() } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', oneAttempt())]);
    await harness.supervisor.tick(harness.run.runId);
    harness.clock.advance(1_500);
    await harness.supervisor.tick(harness.run.runId);
    assert.ok(eventTypes(harness).includes('orchestrator.spend-truncated'));

    // A different controller takes over before the attempt terminates: its in-memory state holds no marker, so
    // the classification must come from the durable event ledger.
    const restarted = createSupervisor(supervisorOptionsFor(harness));
    try {
      harness.clock.advance(1_000);
      await restarted.tick(harness.run.runId);
      assert.equal(restarted.snapshot(harness.run.runId).run.state, 'failed');
      const finished = harness.store.listEvents({ runId: harness.run.runId, limit: 1_000 })
        .find(event => event.type === 'orchestrator.run-finished');
      assert.equal(finished?.payload.state, 'failed');
      assert.equal(finished?.payload.truncation, 'model-spend-refusal');
    } finally { restarted.dispose(); }
  } finally { harness.store.close(); }
});

/**
 * [T10 residual] The refusal can land after the supervisor's last observation and before reconciliation: the
 * worker is observed live, then the spend ledger refuses the next turn and the runtime turns terminal before the
 * supervisor observes again. Reconciliation must classify that refusal from the handle it just reconciled;
 * otherwise the marker is lost with the lease and the run is reported `completed`.
 */
test('a refusal recorded between observation and reconciliation still fails the run', async () => {
  const harness = createHarness({
    perTargetConcurrency: 1,
    runtimeOptions: {
      // The attempt is live for the observation, then reconciliation finds it terminated with the refusal
      // already durable on the handle it returns — the exact shape of the observed race.
      steps: [{ at: 0, status: 'running' }],
      reconcileState: attempt => {
        if (!attempt.handle.events.some(event => event.type === 'spend-refused')) {
          attempt.handle.events.push({ cursor: attempt.cursor++, at: 2_000, type: 'spend-refused', text: SPEND_REFUSAL });
          attempt.handle.startupError = SPEND_REFUSAL;
        }
        return 'terminated';
      },
    },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', oneAttempt())]);
    await harness.supervisor.tick(harness.run.runId);
    assert.ok(eventTypes(harness).includes('orchestrator.spend-truncated'),
      'the reconciliation path must durably record the refusal it found on the handle');
    const snapshot = harness.supervisor.snapshot(harness.run.runId);
    assert.equal(snapshot.run.state, 'failed', 'a spend-truncated run must never be labelled completed');
    assert.equal(harness.store.listTasks(harness.run.runId)[0]!.lifecycleState, 'failed');
    assert.deepEqual(harness.store.listResults(harness.run.runId), [], 'a truncated run admits no result');
    const finished = harness.store.listEvents({ runId: harness.run.runId, limit: 1_000 })
      .find(event => event.type === 'orchestrator.run-finished');
    assert.equal(finished?.payload.state, 'failed');
    assert.equal(finished?.payload.truncation, 'model-spend-refusal');
    assert.deepEqual(finished?.payload.truncatedTaskIds, ['task-1']);
  } finally { harness.store.close(); }
});
