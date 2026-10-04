import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelSpendBudget, PolicyError, dispatchModelRequest, type ModelSpendState } from '../../src/policy/index.js';
import { ATTEMPT, LIMITS, RUN, SELECTION, budgetRequest, code, memoryJournal, usage } from './support.js';

const bound = (limits: { maxTokens: number; maxCostUsd: number }) => {
  const ledger = new ModelSpendBudget(limits, { runId: RUN });
  ledger.bindRun(RUN, limits);
  return ledger;
};
const usd = (micros: number) => micros / 1_000_000;

test('refuses an unaffordable worst case before dispatch and leaves no counter behind', async () => {
  const ledger = bound({ maxTokens: 1000, maxCostUsd: 1 });
  let dispatched = 0;
  await assert.rejects(
    dispatchModelRequest(ledger, budgetRequest(ATTEMPT, 950, 100), async () => { dispatched++; return { usage: usage(1, 1) }; }, result => result.usage),
    code('BUDGET_EXCEEDED'),
  );
  assert.equal(dispatched, 0);
  assert.deepEqual(ledger.snapshot().committed, { tokens: 0, costUsd: 0 });
  assert.deepEqual(ledger.snapshot().active, { count: 0, tokens: 0, costUsd: 0 });
  assert.equal(ledger.snapshot().settlements, 0);

  // The token headroom is long, but the pinned price makes the worst case unaffordable in USD terms.
  const priced = bound({ maxTokens: 1_000_000, maxCostUsd: 0.0071 });
  await assert.rejects(
    dispatchModelRequest(priced, budgetRequest(ATTEMPT, 900, 300), async () => { dispatched++; return { usage: usage(1, 1) }; }, result => result.usage),
    code('BUDGET_EXCEEDED'),
  );
  assert.equal(dispatched, 0);
  const smaller = priced.reserve(budgetRequest(ATTEMPT, 800, 100));
  assert.equal(smaller.reservedCostUsd, usd(800 * 3 + 100 * 15));
  assert.throws(() => priced.reserve(budgetRequest(ATTEMPT, 900, 300)), code('BUDGET_EXCEEDED'), 'the worst case must fit next to every reservation already held');
  smaller.release('fixture');
  const exact = bound({ maxTokens: 1_000_000, maxCostUsd: 0.0072 }).reserve(budgetRequest(ATTEMPT, 900, 300));
  assert.equal(exact.reservedCostUsd, usd(900 * 3 + 300 * 15));
  exact.release('fixture');
});

test('reserve then settle charges exactly the provider-reported usage at the pinned prices', () => {
  const ledger = bound(LIMITS);
  const reservation = ledger.reserve(budgetRequest(ATTEMPT, 900, 300));
  assert.equal(reservation.reservedTokens, 1200);
  assert.equal(reservation.reservedCostUsd, usd(900 * 3 + 300 * 15));
  assert.equal(ledger.snapshot().active.count, 1);

  const settled = reservation.settle({ inputTokens: 800, outputTokens: 100, reportedCostUsd: 0.005 });
  assert.equal(settled.duplicate, false);
  assert.equal(settled.tokens, 900);
  assert.equal(settled.costUsd, usd(800 * 3 + 100 * 15));
  assert.equal(settled.reportedCostUsd, 0.005); // recorded for audit, never charged in place of the pinned price
  assert.deepEqual(settled.overshoot, { tokens: 0, costUsd: 0 });
  assert.deepEqual(settled.snapshot.committed, { tokens: 900, costUsd: usd(800 * 3 + 100 * 15) });
  assert.deepEqual(settled.snapshot.active, { count: 0, tokens: 0, costUsd: 0 });
  assert.deepEqual(settled.snapshot.remaining, { tokens: 9100, costUsd: 0.995 }, 'headroom covers the larger observed cost, not only the pinned quote');
  assert.equal(settled.snapshot.observedCostUsd, .005);
  assert.equal(settled.snapshot.accountedCostUsd, .005);
  assert.equal(settled.snapshot.costPolicy, 'pinned-cache-miss-price');
});

test('settling more usage than reserved charges the observed amount and records the overshoot', () => {
  const ledger = bound({ maxTokens: 1000, maxCostUsd: 1 });
  const reservation = ledger.reserve(budgetRequest(ATTEMPT, 10, 10));
  const settled = reservation.settle(usage(60, 60));
  assert.equal(settled.tokens, 120);
  assert.equal(settled.costUsd, usd(60 * 3 + 60 * 15));
  assert.deepEqual(settled.overshoot, { tokens: 100, costUsd: usd(60 * 3 + 60 * 15 - (10 * 3 + 10 * 15)) });
  assert.deepEqual(ledger.snapshot().committed, { tokens: 120, costUsd: usd(60 * 3 + 60 * 15) });
  assert.deepEqual(ledger.snapshot().overshoot, { tokens: 100, costUsd: usd(60 * 3 + 60 * 15 - (10 * 3 + 10 * 15)) });
  assert.deepEqual(ledger.snapshot().remaining, { tokens: 880, costUsd: usd(1_000_000 - (60 * 3 + 60 * 15)) });
  assert.throws(() => ledger.reserve(budgetRequest(ATTEMPT, 881, 0)), code('BUDGET_EXCEEDED'), 'observed overshoot immediately tightens the next admission');
});

test('the worst-case reservation holds budget until settlement, not until dispatch', () => {
  const ledger = bound({ maxTokens: 1000, maxCostUsd: 1 });
  const first = ledger.reserve(budgetRequest(ATTEMPT, 500, 500));
  assert.throws(() => ledger.reserve(budgetRequest(ATTEMPT, 1, 0)), code('BUDGET_EXCEEDED'));
  first.settle(usage(50, 50));
  assert.deepEqual(ledger.snapshot().committed, { tokens: 100, costUsd: usd(50 * 3 + 50 * 15) });
  const second = ledger.reserve(budgetRequest(ATTEMPT, 500, 400));
  assert.equal(second.reservedTokens, 900);
  second.release('fixture cancellation');
  assert.equal(ledger.snapshot().active.count, 0);
  assert.deepEqual(ledger.snapshot().committed, { tokens: 100, costUsd: usd(50 * 3 + 50 * 15) });
});

test('replaying a settlement never double-charges and conflicting replays are refused', () => {
  const ledger = bound(LIMITS);
  const reservation = ledger.reserve(budgetRequest(ATTEMPT, 900, 300));
  const first = reservation.settle(usage(800, 100));
  const stateAfterFirst = ledger.exportState();
  const committed = ledger.snapshot().committed;

  const replay = ledger.settle({ reservationId: reservation.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(800, 100) });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.tokens, first.tokens);
  assert.equal(replay.costUsd, first.costUsd);
  assert.deepEqual(ledger.snapshot().committed, committed);
  assert.deepEqual(ledger.exportState(), stateAfterFirst);

  assert.throws(() => ledger.settle({ reservationId: reservation.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(801, 100) }), code('IDENTITY_DENIED'));
  assert.throws(() => ledger.settle({ reservationId: reservation.reservationId, attemptId: 'other-attempt', selection: SELECTION, usage: usage(800, 100) }), code('IDENTITY_DENIED'));
  assert.throws(() => ledger.settle({ reservationId: reservation.reservationId, attemptId: ATTEMPT, selection: { ...SELECTION, thinking: 'low' }, usage: usage(800, 100) }), code('IDENTITY_DENIED'));
  assert.deepEqual(ledger.snapshot().committed, committed);
});

test('cancellation releases the reservation, restores headroom and refuses late usage', async () => {
  const ledger = bound({ maxTokens: 1000, maxCostUsd: 1 });
  const reservation = ledger.reserve(budgetRequest(ATTEMPT, 800, 200));
  reservation.release('cancelled');
  assert.equal(ledger.release(reservation.reservationId, 'cancelled again'), false);
  assert.equal(ledger.snapshot().active.count, 0);
  assert.deepEqual(ledger.snapshot().committed, { tokens: 0, costUsd: 0 });
  assert.throws(() => reservation.settle(usage(1, 1)), code('INVALID_INPUT'));
  const again = ledger.reserve(budgetRequest(ATTEMPT, 800, 200));
  again.release();

  const controller = new AbortController();
  let dispatched = 0;
  await assert.rejects(
    dispatchModelRequest(
      ledger,
      budgetRequest(ATTEMPT, 800, 200),
      async () => { dispatched++; throw new PolicyError('CANCELLED', 'fixture cancellation mid-flight'); },
      () => usage(1, 1),
      { signal: controller.signal },
    ),
    code('CANCELLED'),
  );
  assert.equal(dispatched, 1);
  assert.equal(ledger.snapshot().active.count, 0);

  controller.abort();
  await assert.rejects(
    dispatchModelRequest(ledger, budgetRequest(ATTEMPT, 800, 200), async () => { dispatched++; return {}; }, () => usage(1, 1), { signal: controller.signal }),
    code('CANCELLED'),
  );
  assert.equal(dispatched, 1, 'an aborted request is refused before dispatch and never reserved');
});

test('a refused request never reaches the loopback provider; an admitted one settles its reported usage', async () => {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ usage: usage(10, 2) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const provider = async (): Promise<{ usage: { inputTokens: number; outputTokens: number } }> => {
    const body = await new Promise<string>((resolve, reject) => {
      const call = get({ host: '127.0.0.1', port, path: '/v1/complete' }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk as Buffer));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      call.on('error', reject);
    });
    return JSON.parse(body) as { usage: { inputTokens: number; outputTokens: number } };
  };
  try {
    const refused = bound({ maxTokens: 20, maxCostUsd: 1 });
    await assert.rejects(dispatchModelRequest(refused, budgetRequest(ATTEMPT, 20, 10), provider, result => result.usage), code('BUDGET_EXCEEDED'));
    assert.equal(hits.length, 0, 'a refused request is never issued to the provider');

    const admitted = bound({ maxTokens: 1000, maxCostUsd: 1 });
    const result = await dispatchModelRequest(admitted, budgetRequest(ATTEMPT, 20, 10), provider, value => value.usage);
    assert.deepEqual(result.usage, usage(10, 2));
    assert.equal(hits.length, 1);
    assert.deepEqual(admitted.snapshot().committed, { tokens: 12, costUsd: usd(10 * 3 + 2 * 15) });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('refuses an unpriced selection before dispatch', async () => {
  const ledger = bound(LIMITS);
  let dispatched = 0;
  await assert.rejects(
    dispatchModelRequest(
      ledger,
      { attemptId: ATTEMPT, selection: { provider: 'unknown-provider', model: 'unknown-model', thinking: 'max' }, inputTokensUpperBound: 1, maxOutputTokens: 1 },
      async () => { dispatched++; return {}; },
      () => usage(1, 1),
    ),
    code('BUDGET_EXCEEDED'),
  );
  assert.equal(dispatched, 0);
  assert.equal(ledger.snapshot().settlements, 0);
  assert.throws(() => ledger.reserve({ ...budgetRequest(), selection: { ...SELECTION, thinking: 'impossible' as never } }), code('INVALID_INPUT'));
});

test('rejects looser or lower limit configurations, foreign runs and foreign attempts', () => {
  const approved = { maxTokens: 1000, maxCostUsd: 0.5 };
  assert.throws(() => new ModelSpendBudget({ maxTokens: 2000, maxCostUsd: 0.5 }).bindRun(RUN, approved), code('BUDGET_EXCEEDED'));
  assert.throws(() => new ModelSpendBudget({ maxTokens: 1000, maxCostUsd: 1 }).bindRun(RUN, approved), code('BUDGET_EXCEEDED'));
  assert.throws(() => new ModelSpendBudget(approved).bindRun(RUN, { maxTokens: 900, maxCostUsd: 0.5 }), code('BUDGET_EXCEEDED'));

  const ledger = bound(approved);
  assert.throws(() => ledger.bindRun('foreign-run', approved), code('IDENTITY_DENIED'));

  const attempts = new Map([['attempt-a', 'run-a'], ['attempt-b', 'run-b']]);
  const owned = new ModelSpendBudget(approved, { runId: 'run-a', freshRun: true, journal: memoryJournal({ attempts }).journal });
  owned.bindRun('run-a', approved);
  assert.throws(() => owned.reserve({ attemptId: 'attempt-b', selection: SELECTION, inputTokensUpperBound: 1, maxOutputTokens: 1 }), code('IDENTITY_DENIED'));
  const allowed = owned.reserve({ attemptId: 'attempt-a', selection: SELECTION, inputTokensUpperBound: 1, maxOutputTokens: 1 });
  allowed.release();
});

test('freshRun is explicit and a failed journal fails closed before any dispatch', () => {
  const approved = { maxTokens: 1000, maxCostUsd: 0.5 };
  const memory = memoryJournal();
  const first = new ModelSpendBudget(approved, { runId: RUN, freshRun: true, journal: memory.journal });
  first.bindRun(RUN, approved);
  assert.ok(memory.state());
  assert.throws(() => new ModelSpendBudget(approved, { runId: RUN, freshRun: true, journal: memory.journal }), code('UNAVAILABLE'));
  const resumed = new ModelSpendBudget(approved, { runId: RUN, journal: memory.journal });
  assert.deepEqual(resumed.snapshot().committed, { tokens: 0, costUsd: 0 });

  assert.throws(() => new ModelSpendBudget(approved, { runId: RUN, journal: memoryJournal().journal }), code('UNAVAILABLE'));

  // A persistently failing journal refuses every dispatch, but it never wedges the ledger (T12): each failed
  // reserve rolls back to the last commit, so no half-applied reservation is left and the next attempt retries.
  const faulty = memoryJournal({ faultAfter: 1 });
  const faultyLedger = new ModelSpendBudget(approved, { runId: RUN, freshRun: true, journal: faulty.journal });
  assert.throws(() => faultyLedger.reserve(budgetRequest(ATTEMPT, 1, 1)), code('UNAVAILABLE'));
  assert.throws(() => faultyLedger.reserve(budgetRequest(ATTEMPT, 1, 1)), code('UNAVAILABLE'));
  // Every failed commit rolls back, so nothing half-applied is durable and the ledger fails closed while
  // the journal is unavailable — it is not wedged: a commit would clear the state (see the T12 suite).
  assert.deepEqual(faulty.state()!.reservations, {}, 'the failed reservations left nothing durable');
  assert.throws(() => faultyLedger.snapshot(), /Model spend journal failed/);
});

test('durable journals restore totals and preserve unknown active reservations', () => {
  const memory = memoryJournal();
  const first = new ModelSpendBudget(LIMITS, { runId: RUN, freshRun: true, journal: memory.journal });
  first.bindRun(RUN, LIMITS);
  const settled = first.reserve(budgetRequest(ATTEMPT, 100, 100));
  settled.settle(usage(50, 50));
  const holding = first.reserve(budgetRequest(ATTEMPT, 200, 200));

  const resumed = new ModelSpendBudget(LIMITS, { runId: RUN, journal: memory.journal });
  resumed.bindRun(RUN, LIMITS);
  assert.deepEqual(resumed.snapshot().committed, { tokens: 100, costUsd: usd(50 * 3 + 50 * 15) });
  const active = resumed.activeReservations();
  assert.equal(active.length, 1);
  assert.equal(active[0]!.reservationId, holding.reservationId);
  assert.equal(active[0]!.reservedTokens, 400);
  assert.throws(() => resumed.reserve(budgetRequest(ATTEMPT, 10_000, 1)), code('BUDGET_EXCEEDED'), 'the unknown in-flight reservation still holds budget');

  const after = resumed.settle({ reservationId: holding.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(100, 100) });
  assert.equal(after.duplicate, false);
  assert.deepEqual(resumed.snapshot().committed, { tokens: 300, costUsd: usd(150 * 3 + 150 * 15) });
  assert.equal(resumed.snapshot().active.count, 0);
});

// ---------------------------------------------------------------------------------------------
// [T9] Per-turn admission and settlement: the R2 residuals (one reservation per attempt with no
// pre-request re-check; failed attempts released without charging) are closed at the ledger itself.
// ---------------------------------------------------------------------------------------------

const turn = (reservationId: string, inputTokensUpperBound: number, maxOutputTokens: number) =>
  ({ reservationId, attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound, maxOutputTokens });

test('admits each provider turn against its payload-derived worst case and charges it per turn', () => {
  const ledger = bound({ maxTokens: 1000, maxCostUsd: 1 });
  const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 0));
  assert.equal(held.reservedTokens, 200);
  const first = ledger.admitTurn(turn(held.reservationId, 300, 100));
  assert.equal(first.turnId, `${held.reservationId}:turn-1`);
  assert.equal(first.turn, 1);
  assert.equal(first.reservedTokens, 400, 'the admitted turn holds its own worst case');
  assert.equal(first.reservedCostUsd, usd(300 * 3 + 100 * 15));
  // The attempt hold grew to the turn worst case inside the same run budget.
  assert.deepEqual(ledger.snapshot().active, { count: 1, tokens: 400, costUsd: usd(300 * 3 + 100 * 15) });

  const charge = first.charge(usage(250, 20));
  assert.equal(charge.basis, 'provider-usage');
  assert.equal(charge.assumed, false);
  assert.equal(charge.tokens, 270);
  assert.equal(charge.costMicros, 250 * 3 + 20 * 15);
  assert.deepEqual(charge.overshoot, { tokens: 0, costUsd: 0 });
  assert.deepEqual(ledger.snapshot().committed, { tokens: 270, costUsd: usd(250 * 3 + 20 * 15) });
  assert.deepEqual(ledger.snapshot().active, { count: 1, tokens: 130, costUsd: usd((300 * 3 + 100 * 15) - (250 * 3 + 20 * 15)) }, 'the charge consumes the hold, never more');

  // Idempotent: replaying the same turn receipt never double-charges.
  const replay = first.charge(usage(250, 20));
  assert.equal(replay.duplicate, true);
  assert.deepEqual(ledger.snapshot().committed, { tokens: 270, costUsd: usd(250 * 3 + 20 * 15) });
  assert.throws(() => first.charge(usage(251, 20)), code('IDENTITY_DENIED'));

  // A turn whose worst case no longer fits is refused with no state change at all.
  const before = ledger.exportState();
  assert.throws(() => ledger.admitTurn(turn(held.reservationId, 900, 100)), code('BUDGET_EXCEEDED'));
  assert.deepEqual(ledger.exportState(), before, 'a refused turn must leave the ledger untouched');

  // A smaller next turn is admitted against the tighter headroom and charged at its own bound.
  const second = ledger.admitTurn(turn(held.reservationId, 100, 10));
  assert.equal(second.turn, 2);
  assert.equal(ledger.attemptUsage(held.reservationId, ATTEMPT).turns, 1, 'only the charged turn counts as used');
  assert.equal(second.charge(usage(80, 5)).tokens, 85);
  assert.equal(ledger.snapshot().committed.tokens, 355);

  // No usage could be read: the admitted worst case is charged and marked as an explicit assumption.
  const third = ledger.admitTurn(turn(held.reservationId, 40, 10));
  const assumed = third.chargeUnobserved('provider-response-usage-absent');
  assert.equal(assumed.assumed, true);
  assert.equal(assumed.basis, 'assumed-worst-case:provider-response-usage-absent');
  assert.equal(assumed.tokens, 50, 'an unreadable turn is charged its admitted worst case, never zero');
  const usageSoFar = ledger.attemptUsage(held.reservationId, ATTEMPT);
  assert.deepEqual({ turns: usageSoFar.turns, assumedTurns: usageSoFar.assumedTurns }, { turns: 3, assumedTurns: 1 });
});

test('a turn far above the run limit is refused instead of settled (R2 residual 1)', () => {
  const ledger = bound({ maxTokens: 1000, maxCostUsd: 1 });
  const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 0));
  assert.throws(() => ledger.admitTurn(turn(held.reservationId, 20_000, 20_000)), code('BUDGET_EXCEEDED'));
  assert.throws(() => ledger.admitTurn(turn(held.reservationId, 20_000, 20_000)), /next provider turn's worst case/);
  assert.deepEqual(ledger.snapshot().committed, { tokens: 0, costUsd: 0 }, 'a refused turn is never charged');
  assert.deepEqual(ledger.snapshot().overshoot, { tokens: 0, costUsd: 0 });
  assert.equal(ledger.attemptUsage(held.reservationId, ATTEMPT).turns, 0);
  assert.equal(Object.keys(ledger.exportState().settlements).length, 0);
  // The charge is impossible without the attempt hold: a released attempt cannot be charged silently.
  held.release('failed:charged-turns=0');
  assert.throws(() => ledger.admitTurn(turn(held.reservationId, 1, 1)), code('INVALID_INPUT'));
});

test('a failed attempt is charged for its observed turns and releases only the residual hold (R2 residual 3)', () => {
  const ledger = bound({ maxTokens: 10_000, maxCostUsd: 1 });
  const held = ledger.reserve(budgetRequest(ATTEMPT, 500, 500));
  const one = ledger.admitTurn(turn(held.reservationId, 400, 100));
  one.charge(usage(300, 50));
  const two = ledger.admitTurn(turn(held.reservationId, 500, 100));
  two.charge(usage(450, 60));
  const committed = ledger.snapshot().committed;
  assert.deepEqual(committed, { tokens: 860, costUsd: usd(750 * 3 + 110 * 15) });

  // The attempt fails: the consumed tokens stay charged and only the remaining hold is released.
  held.release('failed:charged-turns=2');
  assert.deepEqual(ledger.snapshot().committed, committed, 'a failed attempt must not release consumed tokens');
  assert.equal(ledger.snapshot().released, 1);
  assert.equal(ledger.exportState().released[held.reservationId]!.reason, 'failed:charged-turns=2');
  assert.deepEqual(ledger.snapshot().active, { count: 0, tokens: 0, costUsd: 0 });
  assert.equal(ledger.attemptUsage(held.reservationId, ATTEMPT).turns, 2);
  // The failed attempt's spend immediately tightens the next attempt's admission.
  assert.throws(() => ledger.reserve({ attemptId: 'second-attempt', selection: SELECTION, inputTokensUpperBound: 9_500, maxOutputTokens: 0 }), code('BUDGET_EXCEEDED'));
});

test('the session catch-up charges only the uncharged delta and never double-charges', () => {
  const ledger = bound({ maxTokens: 10_000, maxCostUsd: 1 });
  const held = ledger.reserve(budgetRequest(ATTEMPT, 100, 100));
  assert.equal(ledger.catchUp({ reservationId: held.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(60, 20) })!.tokens, 80);
  assert.equal(ledger.catchUp({ reservationId: held.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(60, 20) }), undefined, 'repeating the same observation charges nothing');
  const grew = ledger.catchUp({ reservationId: held.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(100, 40) });
  assert.equal(grew!.tokens, 60, 'only the delta above what this attempt already paid is charged');
  assert.equal(grew!.basis, 'session-catch-up');
  assert.equal(grew!.turnId, `${held.reservationId}:observed-2`);
  assert.deepEqual(ledger.snapshot().committed, { tokens: 140, costUsd: usd(100 * 3 + 40 * 15) });
  // A per-turn charge already paid for the observed usage: the catch-up for the same usage adds nothing.
  const turnOne = ledger.admitTurn(turn(held.reservationId, 100, 100));
  turnOne.charge(usage(40, 10));
  assert.equal(ledger.catchUp({ reservationId: held.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(140, 50) }), undefined);
  // Cumulative settlement on top of per-turn charges would double-charge the same usage: refused.
  assert.throws(() => ledger.settle({ reservationId: held.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(140, 50) }), code('INVALID_INPUT'));
  assert.equal(ledger.attemptUsage(held.reservationId, ATTEMPT).turns, 3);
});

test('per-turn charges and releases survive a durable restart without double-charging', () => {
  const memory = memoryJournal();
  const first = new ModelSpendBudget(LIMITS, { runId: RUN, freshRun: true, journal: memory.journal });
  first.bindRun(RUN, LIMITS);
  const held = first.reserve(budgetRequest(ATTEMPT, 500, 500));
  const one = first.admitTurn(turn(held.reservationId, 600, 200));
  one.charge(usage(500, 100));

  const resumed = new ModelSpendBudget(LIMITS, { runId: RUN, journal: memory.journal });
  resumed.bindRun(RUN, LIMITS);
  assert.deepEqual(resumed.snapshot().committed, { tokens: 600, costUsd: usd(500 * 3 + 100 * 15) });
  const restarted = resumed.admitTurn(turn(held.reservationId, 600, 200));
  assert.equal(restarted.turn, 2, 'the restarted ledger continues after the charged turn');
  assert.equal(resumed.catchUp({ reservationId: held.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(500, 100) }), undefined, 'the restarted catch-up never re-charges a turn already paid');
  restarted.charge(usage(400, 80));
  assert.equal(resumed.snapshot().committed.tokens, 1080);
  resumed.release(held.reservationId, 'completed:charged-turns=2');
  assert.equal(resumed.snapshot().committed.tokens, 1080, 'the completed attempt keeps its per-turn charges');
});

// ---------------------------------------------------------------------------------------------
// [T10] Concurrent admission (R3 §6.1): overlapping provider turns must not share one reservation slot or
// one turn identity. Admission, the per-turn hold growth and the minted identity are one critical section.
// ---------------------------------------------------------------------------------------------

test('overlapping provider turns each hold their own worst case and are charged exactly once (R3 §6.1)', () => {
  const ledger = bound({ maxTokens: 2_000, maxCostUsd: 1 });
  const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 100)); // launch envelope: 300 tokens
  // Three genuinely overlapping requests: every admit happens before any of them is charged.
  const first = ledger.admitTurn(turn(held.reservationId, 600, 100));
  const second = ledger.admitTurn(turn(held.reservationId, 600, 100));
  assert.equal(first.turnId, `${held.reservationId}:turn-1`);
  assert.equal(second.turnId, `${held.reservationId}:turn-2`, 'overlapping admits must never collide on one turn id');
  assert.equal(ledger.snapshot().active.tokens, 1_400, 'both in-flight worst cases stay reserved, not one shared slot');
  const beforeRefusal = ledger.exportState();
  assert.throws(() => ledger.admitTurn(turn(held.reservationId, 600, 100)), code('BUDGET_EXCEEDED'), 'the third overlapping turn cannot fit the run budget');
  assert.deepEqual(ledger.exportState(), beforeRefusal, 'a refused overlapping turn leaves the ledger untouched');

  // Each admitted turn is charged under its own identity, exactly once, and never collapses into another.
  assert.equal(first.charge(usage(600, 100)).tokens, 700);
  assert.equal(second.charge(usage(600, 100)).tokens, 700);
  assert.equal(ledger.snapshot().committed.tokens, 1_400);
  assert.equal(Object.keys(ledger.exportState().settlements).length, 2);
  assert.equal(ledger.attemptUsage(held.reservationId, ATTEMPT).turns, 2);
  // The cumulative session usage has nothing left to add: both turns already paid. The catch-up that used to
  // push the run past its limit now charges nothing.
  assert.equal(ledger.catchUp({ reservationId: held.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(1_200, 200) }), undefined);
  assert.throws(() => ledger.admitTurn(turn(held.reservationId, 600, 100)), code('BUDGET_EXCEEDED'), 'the run is really exhausted, not only apparently');
  held.release('completed:charged-turns=2');
  assert.ok(ledger.snapshot().committed.tokens < 2_000, 'final committed spend stays below the declared limit');
});

test('a journal written before the durable turn counters restores them from the charged ids (R3 §6.1)', () => {
  const memory = memoryJournal();
  const first = new ModelSpendBudget(LIMITS, { runId: RUN, freshRun: true, journal: memory.journal });
  first.bindRun(RUN, LIMITS);
  const held = first.reserve(budgetRequest(ATTEMPT, 200, 100));
  first.admitTurn(turn(held.reservationId, 300, 100)).charge(usage(250, 50));
  // Strip the counters exactly as the previous revision persisted that hold.
  const legacy = memory.state() as unknown as { reservations: Record<string, Record<string, unknown>> };
  for (const reservation of Object.values(legacy.reservations)) for (const key of ['admittedTurns', 'observedCharges', 'openTurns', 'openTokens', 'openCostMicros', 'turnHolds']) delete reservation[key];
  let saved: unknown = structuredClone(legacy);
  const resumed = new ModelSpendBudget(LIMITS, { runId: RUN, journal: { load: () => structuredClone(saved), save: state => { saved = structuredClone(state); } } });
  resumed.bindRun(RUN, LIMITS);
  const next = resumed.admitTurn(turn(held.reservationId, 300, 100));
  assert.equal(next.turn, 2, 'a legacy journal continues after the charged turn instead of re-minting its identity');
  assert.equal(next.turnId, `${held.reservationId}:turn-2`);
  assert.equal(next.charge(usage(120, 20)).duplicate, false);
  assert.equal(Object.keys(resumed.exportState().settlements).length, 2);
});

test('a charge that cannot be persisted is refused and charged by terminal reconciliation (R3 §9.3)', () => {
  // Exactly one save fails: the first state that carries a settlement, i.e. the completion charge.
  const memory = memoryJournal();
  let faults = 0;
  const journal = {
    load: (runId: string) => memory.journal.load(runId),
    save: (state: Readonly<ModelSpendState>) => {
      if (faults === 0 && Object.keys(state.settlements).length > 0) { faults += 1; throw new Error('fixture journal unavailable'); }
      memory.journal.save(state);
    },
  };
  const ledger = new ModelSpendBudget(LIMITS, { runId: RUN, freshRun: true, journal });
  ledger.bindRun(RUN, LIMITS);
  const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 100));
  const admitted = ledger.admitTurn(turn(held.reservationId, 600, 100));
  const durable = memory.state()!;
  assert.equal(durable.reservations[held.reservationId]!.reservedTokens, 700, 'the admitted turn is durable before the provider is paid');
  assert.throws(() => admitted.charge(usage(500, 50)), code('UNAVAILABLE'), 'an unpersistable charge fails closed instead of attesting a charge');
  assert.deepEqual(memory.state(), durable, 'no settlement and no committed total may be durable after the failure');
  assert.equal(Object.keys(durable.settlements).length, 0);
  // [T12] The failure must not wedge the ledger: `persist()` rolled the in-memory state back to the last
  // commit, so the durable hold is intact and remains readable to reconciliation, while new spend is
  // refused and the hold cannot be dropped before its paid turn is charged.
  assert.deepEqual(ledger.exportState(), durable, 'the ledger reads exactly the durable state after the failure');
  assert.deepEqual(Object.keys(ledger.exportState().reservations), [held.reservationId]);
  assert.throws(() => ledger.snapshot(), /Model spend journal failed/, 'the supervisor-facing snapshot refuses while the paid turn is uncharged');
  assert.throws(() => ledger.reserve({ ...budgetRequest(ATTEMPT, 1, 0), reservationId: 'blocked-probe' }), code('UNAVAILABLE'), 'no new spend may be dispatched');
  assert.throws(() => ledger.release(held.reservationId, 'failed:charged-turns=0'), code('UNAVAILABLE'), 'the hold is retained: releasing it would erase the paid turn');
  // A restarted controller charges the very same turn from the durable hold before releasing it.
  const resumed = new ModelSpendBudget(LIMITS, { runId: RUN, journal });
  resumed.bindRun(RUN, LIMITS);
  const restored = resumed.activeReservations()[0]!;
  assert.equal(restored.reservedTokens, 700);
  const reconciled = resumed.catchUp({ reservationId: restored.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(500, 50) });
  assert.equal(reconciled!.tokens, 550);
  resumed.reconcileTerminal(restored.reservationId, { terminationVerified: true, reference: 'fixture-terminal-collection', usage: usage(500, 50), completeUsageVerified: true });
  resumed.release(restored.reservationId, 'reconciled:charged-turns=1');
  assert.equal(resumed.snapshot().committed.tokens, 550, 'the paid turn is charged by terminal reconciliation, never lost');
  assert.equal(resumed.exportState().released[restored.reservationId]!.reason, 'reconciled:charged-turns=1');
});
