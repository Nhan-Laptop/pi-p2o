// P0 liveness regression: the finalize path must stamp the controller receipt and the observation it backs
// with ONE instant. The store requires `receipt.collectedAt >= observation.observedAt`
// (src/store/store.ts `runtimeReceipts`); a caller that admits the receipt first and samples the clock after
// lets a millisecond tick invert the pair, which permanently refuses the only reconciliation that can settle an
// already-`reconciling` attempt — the attempt never terminalizes, the task never closes and the run stays
// `active` forever (live-lab ll-N1L6Co, event 103 `orchestrator.finalize-rejected`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTerminalLifecycle } from '../../src/contracts/index.js';
import {
  ManualClock, admitRunAndTasks, codeIs, collectorReceipt, createHarness, latestAttempt,
} from './fixtures.js';

/**
 * A clock that advances one millisecond on EVERY reading, so any code path that samples the time twice sees
 * two distinct instants. This turns the millisecond race that wedged the live run into a deterministic fault.
 */
class TickingClock extends ManualClock {
  override now(): number { this.advance(1); return super.now(); }
  override iso(): string { this.advance(1); return super.iso(); }
}

const TASK_DEADLINE_MS = Date.parse('2026-10-02T11:00:00.000Z');

test('a verified stop terminalizes an already-reconciling attempt: receipt and observation share one instant', async () => {
  const harness = createHarness({ clock: new TickingClock(), runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    assert.equal(attempt.lifecycleState, 'running');

    // The attempt was already marked `reconciling` by an earlier unverifiable termination. Only the
    // receipt-backed branch of `terminate` can settle it: the ordinary fence path refuses a reconciling
    // attempt (`reconciliation-required`) and the lease cannot be released without a receipt.
    harness.store.updateAttempt(attempt.attemptId, { lifecycleState: 'reconciling' }, { leaseToken: attempt.leaseToken });
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'reconciling');

    // Past the task deadline: the reconcile pass stops the live attempt through `terminate('timed-out')`.
    harness.clock.advance(TASK_DEADLINE_MS + 1_000 - harness.clock.now());
    await harness.supervisor.recover(harness.run.runId);

    const settled = harness.store.getAttempt(attempt.attemptId);
    assert.ok(settled, 'the attempt is still recorded');
    assert.notEqual(settled.lifecycleState, 'reconciling', 'the attempt must not wedge in reconciling');
    assert.ok(isTerminalLifecycle(settled.lifecycleState), `expected a terminal lifecycle, got ${settled.lifecycleState}`);
    assert.equal(settled.lifecycleState, 'timed-out');

    const events = harness.store.listEvents({ runId: harness.run.runId, afterSequence: 0, limit: 1_000 });
    const refused = events.filter(event => event.type === 'orchestrator.finalize-rejected');
    assert.deepEqual(refused, [], 'the receipt-backed reconciliation must not be refused by its own ordering');
    assert.ok(events.some(event => event.type === 'orchestrator.attempt-terminated'), 'the finalize path ran to completion');
    assert.equal(harness.store.getLease('task-1'), undefined, 'a settled attempt releases its workspace lease');

    // The run can now finish instead of sitting `active` forever.
    await harness.supervisor.tick(harness.run.runId);
    const run = harness.store.getRun(harness.run.runId);
    assert.ok(run && ['completed', 'failed', 'cancelled'].includes(run.state), `the run must reach a terminal state, got ${run?.state}`);
  } finally { harness.store.close(); }
});

test('the store still refuses an observation whose runtime receipt predates it (negative control, unchanged)', async () => {
  const harness = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    assert.equal(attempt.lifecycleState, 'running');

    // A genuine collector runtime receipt, admitted now...
    const receipt = collectorReceipt({
      evidenceId: 'runtime-predating', runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId,
      collectedAt: harness.clock.iso(),
    });
    harness.store.putEvidence({ ...receipt, kind: 'runtime' });
    // ...followed by an observation one second LATER: the receipt cannot back it.
    harness.clock.advance(1_000);
    assert.throws(
      () => harness.store.reconcileRun(harness.run.runId, [{
        attemptId: attempt.attemptId, status: 'terminated', observedAt: harness.clock.iso(),
        receiptEvidenceIds: ['runtime-predating'], terminationConfirmed: true, lifecycleState: 'failed',
      }], { leaseMs: 120_000 }),
      codeIs('reconciliation-receipt'),
      'a pre-dating receipt is still refused; the check itself was never relaxed',
    );
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'running', 'a refused reconciliation changes nothing');
  } finally { harness.store.close(); }
});
