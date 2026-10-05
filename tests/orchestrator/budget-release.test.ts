// R2/R4 regression: reservation-before-dispatch stays fail-closed (an exhausted task/run/target budget
// refuses before any traffic), while a reservation whose call provably never dispatched is released BY
// IDENTITY, exactly once. A replay of a released reservation is refused, so it can never refund another
// call's charge. Dispatched work — including failures and redirects — stays charged. Inert fake runtime
// only: no provider, no target traffic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { PolicyError } from '../../src/policy/index.js';
import { ToolExecutionError } from '../../src/tools/index.js';
import { isPreDispatchRefusal } from '../../src/application/composition.js';
import { createSupervisor } from '../../src/orchestrator/index.js';
import { admitRunAndTasks, codeIs, createHarness, latestAttempt, supervisorOptionsFor, taskBudget } from './fixtures.js';

/** Reserve exactly one pre-dispatch call, as the composition bridge does. */
type SupervisorLike = { reserveBudget: ReturnType<typeof createHarness>['supervisor']['reserveBudget']; releaseBudget: ReturnType<typeof createHarness>['supervisor']['releaseBudget'] };

function reserve(supervisor: SupervisorLike, attemptId: string, options: { requests?: number; targetId?: string } = {}) {
  return supervisor.reserveBudget(attemptId, {
    toolCalls: 1,
    ...(options.requests === undefined ? { requests: 1 } : options.requests === 0 ? {} : { requests: options.requests }),
    ...(options.targetId ? { targetId: options.targetId } : {}),
  });
}

function release(supervisor: SupervisorLike, attemptId: string, reservationId: string, code = 'UNAVAILABLE') {
  return supervisor.releaseBudget(attemptId, { reservationId, reason: `pre-dispatch refusal (${code})`, refusal: { code } });
}

test('a released pre-dispatch reservation restores the task/run/target counters exactly once', async () => {
  const harness = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', { budgets: taskBudget({ maxToolCalls: 4, maxRequests: 4 }) })]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');

    const first = reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' });
    const second = reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' });
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.toolCalls, 2, 'the reservations are taken before dispatch');
    assert.equal(harness.store.getTargetUsage(harness.run.runId, 'fixture'), 2);

    release(harness.supervisor, attempt.attemptId, first.reservationId);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.toolCalls, 1);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.requests, 1);
    assert.equal(harness.store.getTargetUsage(harness.run.runId, 'fixture'), 1, 'the target reservation is released too');
    release(harness.supervisor, attempt.attemptId, second.reservationId);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.toolCalls, 0);
    assert.equal(harness.store.getTargetUsage(harness.run.runId, 'fixture'), 0);

    // The reservation identity is recorded durably on both the charge and the release.
    const events = harness.store.listEvents({ runId: harness.run.runId });
    const consumed = events.filter(event => event.type === 'budget.consumed');
    const released = events.filter(event => event.type === 'budget.released');
    assert.equal(consumed.length, 2);
    assert.equal(released.length, 2);
    assert.equal(released[0]?.payload.reservationId, first.reservationId);
    assert.equal(released[1]?.payload.reservationId, second.reservationId);

    // Work can continue afterwards.
    reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' });
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.toolCalls, 1);
  } finally { harness.store.close(); }
});

test('reservation-before-dispatch still refuses an exhausted budget before any traffic', async () => {
  const harness = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', { budgets: taskBudget({ maxToolCalls: 2, maxRequests: 4 }) })]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' });
    reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' });
    assert.throws(
      () => reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' }),
      codeIs('task-budget-exhausted'),
      'an exhausted task budget must refuse before the broker can dispatch',
    );
    // The target-wide allowance (run.budgets.targetRequestLimits.fixture = 5) is enforced by the same code.
    const targetLimited = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
    try {
      await admitRunAndTasks(targetLimited, [targetLimited.task('task-1', { budgets: taskBudget({ maxToolCalls: 9, maxRequests: 9 }) })]);
      await targetLimited.supervisor.tick(targetLimited.run.runId);
      const limitedAttempt = latestAttempt(targetLimited, 'task-1');
      for (let call = 0; call < 5; call++) reserve(targetLimited.supervisor, limitedAttempt.attemptId, { targetId: 'fixture' });
      assert.throws(() => reserve(targetLimited.supervisor, limitedAttempt.attemptId, { targetId: 'fixture' }), codeIs('target-budget-exhausted'));
    } finally { targetLimited.store.close(); }
  } finally { harness.store.close(); }
});

test('[R-4/G] a released reservation cannot be replayed (exactly-once)', async () => {
  const harness = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    const reservation = reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' });
    release(harness.supervisor, attempt.attemptId, reservation.reservationId);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.toolCalls, 0);

    assert.throws(
      () => release(harness.supervisor, attempt.attemptId, reservation.reservationId),
      codeIs('reservation-already-released'),
      'the same reservation can only ever be released once',
    );
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.toolCalls, 0, 'the replay refunded nothing');
    assert.equal(harness.store.getTargetUsage(harness.run.runId, 'fixture'), 0);

    // The replay attempt left no second release record.
    assert.equal(harness.store.listEvents({ runId: harness.run.runId }).filter(event => event.type === 'budget.released').length, 1);
  } finally { harness.store.close(); }
});

test('[R-4/G] a replay cannot refund another call\'s charge', async () => {
  const harness = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');

    const first = reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' });
    release(harness.supervisor, attempt.attemptId, first.reservationId);
    const second = reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' });
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.toolCalls, 1, 'the second call is charged');

    assert.throws(() => release(harness.supervisor, attempt.attemptId, first.reservationId), codeIs('reservation-already-released'));
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.toolCalls, 1, 'the second call stays charged: the replay refunded nothing');
    assert.equal(harness.store.getTargetUsage(harness.run.runId, 'fixture'), 1);

    release(harness.supervisor, attempt.attemptId, second.reservationId);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.toolCalls, 0, 'its own reservation still releases once');
  } finally { harness.store.close(); }
});

test('[R-4/G] only the recorded reservation identity can be released', async () => {
  const harness = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    const reservation = reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' });

    assert.throws(() => release(harness.supervisor, attempt.attemptId, 'no-such-reservation'), codeIs('reservation-unknown'));
    // Counters and amounts can never come from the caller.
    assert.throws(
      () => harness.supervisor.releaseBudget(attempt.attemptId, { reservationId: reservation.reservationId, reason: 'x', refusal: { code: 'UNAVAILABLE' }, toolCalls: 5 } as never),
      (error: unknown) => (error as { code?: string }).code === 'invalid-input',
      'a release cannot name counters',
    );
    assert.throws(
      () => harness.supervisor.releaseBudget(attempt.attemptId, { reservationId: reservation.reservationId, reason: 'x', refusal: { code: 'CAPABILITY_DENIED', toolPlane: true } } as never),
      (error: unknown) => (error as { code?: string }).code === 'invalid-input',
      'a release cannot assert the refusal class',
    );
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.toolCalls, 1, 'nothing was refunded by the refused calls');
  } finally { harness.store.close(); }
});

test('[R-4/G] a reservation from another attempt is not releasable here', async () => {
  const harness = createHarness({ perTargetConcurrency: 2, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-a'), harness.task('task-b')]);
    await harness.supervisor.tick(harness.run.runId);
    const first = latestAttempt(harness, 'task-a');
    const second = latestAttempt(harness, 'task-b');
    const reservation = reserve(harness.supervisor, first.attemptId, { targetId: 'fixture' });
    assert.throws(
      () => harness.supervisor.releaseBudget(second.attemptId, { reservationId: reservation.reservationId, reason: 'cross attempt', refusal: { code: 'UNAVAILABLE' } }),
      codeIs('reservation-unknown'),
      'a reservation is bound to the attempt that minted it',
    );
    assert.equal(harness.store.getAttempt(first.attemptId)?.usage.toolCalls, 1, 'the original charge is untouched');
    release(harness.supervisor, first.attemptId, reservation.reservationId);
    assert.equal(harness.store.getAttempt(first.attemptId)?.usage.toolCalls, 0);
  } finally { harness.store.close(); }
});

test('[R-1/D] a policy-denial release resets the streak instead of counting toward the halt', async () => {
  const harness = createHarness({
    noProgress: { windowMs: 60_000, minToolCalls: 3, consecutiveRefusals: 3 },
    runtimeOptions: { steps: [{ at: 0, status: 'running' }] },
  });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', { budgets: taskBudget({ maxAttempts: 1 }) })]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    for (const code of ['CAPABILITY_DENIED', 'INVALID_INPUT', 'TARGET_DENIED', 'ACCOUNT_DENIED', 'ADDRESS_DENIED']) {
      const reservation = reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' });
      release(harness.supervisor, attempt.attemptId, reservation.reservationId, code);
    }
    harness.clock.advance(600_000);
    await harness.supervisor.tick(harness.run.runId);
    assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'running', 'a denial proves the plane answered and must not halt the attempt');
    assert.equal(harness.store.listEvents({ runId: harness.run.runId }).some(event => event.type === 'orchestrator.no-progress-halt'), false);
    assert.equal(harness.runtime.stops.length, 0);
  } finally { harness.store.close(); }
});

test('[R-2/E] a restarted supervisor re-derives the refusal streak from durable release events', async () => {
  const noProgress = { windowMs: 60_000, minToolCalls: 3, consecutiveRefusals: 3 };
  const harness = createHarness({ noProgress, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', { budgets: taskBudget({ maxAttempts: 1 }) })]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    for (let call = 0; call < 2; call++) {
      const reservation = reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' });
      release(harness.supervisor, attempt.attemptId, reservation.reservationId);
    }
    // A different controller takes over with an empty in-memory map: the streak must come from the ledger.
    const restarted = createSupervisor(supervisorOptionsFor(harness, { noProgress }));
    try {
      const third = reserve(restarted, attempt.attemptId, { targetId: 'fixture' });
      release(restarted, attempt.attemptId, third.reservationId);
      harness.clock.advance(600_000);
      await restarted.tick(harness.run.runId);
      assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'failed');
      assert.equal(harness.runtime.stops.length, 1, 'the restarted controller stopped the dead runtime');
      const halt = harness.store.listEvents({ runId: harness.run.runId }).find(event => event.type === 'orchestrator.no-progress-halt');
      assert.equal(halt?.payload.refusals, 3, 'two durable releases plus the live one');
    } finally { restarted.dispose(); }
  } finally { harness.store.close(); }
});

test('[R-2/handover] a handed-over controller keeps the runtime alive and the replacement halts on the durable streak', async () => {
  const noProgress = { windowMs: 60_000, minToolCalls: 3, consecutiveRefusals: 3 };
  const harness = createHarness({ noProgress, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', { budgets: taskBudget({ maxAttempts: 1 }) })]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    release(harness.supervisor, attempt.attemptId, reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' }).reservationId);
    // Handover must NOT fence the owned execution: the attempt stays live for the replacement to adopt.
    harness.supervisor.handover?.();
    const restarted = createSupervisor(supervisorOptionsFor(harness, { noProgress }));
    try {
      assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'running', 'the handed-over attempt is still live');
      release(restarted, attempt.attemptId, reserve(restarted, attempt.attemptId, { targetId: 'fixture' }).reservationId);
      release(restarted, attempt.attemptId, reserve(restarted, attempt.attemptId, { targetId: 'fixture' }).reservationId);
      harness.clock.advance(600_000);
      await restarted.tick(harness.run.runId);
      assert.equal(harness.store.getAttempt(attempt.attemptId)?.lifecycleState, 'failed', 'the replacement halts it as a dead plane');
      assert.equal(harness.runtime.stops.length, 1);
      const halt = harness.store.listEvents({ runId: harness.run.runId }).find(event => event.type === 'orchestrator.no-progress-halt');
      assert.equal(halt?.payload.refusals, 3, 'one durable release before the handover plus two after');
    } finally { restarted.dispose(); }
  } finally { harness.store.close(); }
});

test('[R-2/reservation] a reservation minted before a restart is still released exactly once afterwards', async () => {
  const harness = createHarness({ runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1')]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    const reservation = reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' });
    const restarted = createSupervisor(supervisorOptionsFor(harness));
    try {
      release(restarted, attempt.attemptId, reservation.reservationId);
      assert.equal(harness.store.getAttempt(attempt.attemptId)?.usage.toolCalls, 0, 'the durable reservation survives the restart');
      assert.throws(() => release(restarted, attempt.attemptId, reservation.reservationId), codeIs('reservation-already-released'));
    } finally { restarted.dispose(); }
  } finally { harness.store.close(); }
});

test('[R-5] the durable refusal derivation is complete beyond a single page cap', async () => {
  const noProgress = { windowMs: 60_000, minToolCalls: 3, consecutiveRefusals: 3 };
  const harness = createHarness({ noProgress, runtimeOptions: { steps: [{ at: 0, status: 'running' }] } });
  try {
    await admitRunAndTasks(harness, [harness.task('task-1', { budgets: taskBudget({ maxAttempts: 1 }) })]);
    await harness.supervisor.tick(harness.run.runId);
    const attempt = latestAttempt(harness, 'task-1');
    release(harness.supervisor, attempt.attemptId, reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' }).reservationId);
    release(harness.supervisor, attempt.attemptId, reserve(harness.supervisor, attempt.attemptId, { targetId: 'fixture' }).reservationId);
    // A bounded forward page scan (20 x 1000) would stop long before a late release in a long run. The filler
    // history is seeded directly in one transaction only to keep the boundary test fast.
    const database = new DatabaseSync(join(harness.root, 'run.sqlite'));
    try {
      database.exec('BEGIN');
      const insert = database.prepare("INSERT INTO events(event_id, run_id, type, occurred_at, payload_json) VALUES (?, ?, 'filler.event', ?, '{}')");
      for (let index = 0; index < 20_100; index++) insert.run(`filler-${index}`, harness.run.runId, harness.clock.iso());
      database.exec('COMMIT');
    } finally { database.close(); }
    const restarted = createSupervisor(supervisorOptionsFor(harness, { noProgress }));
    try {
      release(restarted, attempt.attemptId, reserve(restarted, attempt.attemptId, { targetId: 'fixture' }).reservationId);
      harness.clock.advance(600_000);
      await restarted.tick(harness.run.runId);
      assert.equal(harness.runtime.stops.length, 1, 'a late release must still halt after a restart in a long run');
      let halt; let after = 0;
      for (;;) {
        const events = harness.store.listEvents({ runId: harness.run.runId, afterSequence: after, limit: 1_000 });
        if (!events.length) break;
        after = events.at(-1)!.sequence;
        halt = events.find(event => event.type === 'orchestrator.no-progress-halt') ?? halt;
        if (events.length < 1_000) break;
      }
      assert.equal(halt?.payload.refusals, 3, 'all three durable releases are counted');
    } finally { restarted.dispose(); }
  } finally { harness.store.close(); }
});

test('only a provably pre-dispatch broker failure releases the reservation', () => {
  const error = (dispatched: boolean) => new ToolExecutionError(new PolicyError('UNAVAILABLE', 'pre-dispatch refusal'), {} as never, dispatched);
  assert.equal(isPreDispatchRefusal(error(false)), true);
  assert.equal(isPreDispatchRefusal(error(true)), false, 'dispatched work — including a failure or redirect — stays charged');
  assert.equal(isPreDispatchRefusal(new Error('not a broker failure')), false);
});
