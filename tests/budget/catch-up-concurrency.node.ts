// T11 regression, moved onto the real journal in T12: R4 §4 (W4) — a catch-up observation that lands while
// admitted provider turns are still in flight must not charge usage those turns are about to charge again.
//
// Before T11 the observation was charged in full while `openTurns` was 2 and consumed none of their holds, so
// the two per-turn charges then landed on top: 2 800 committed against a 2 000 limit, three settlements for two
// provider turns, and `overshoot` read 0 because it measures the per-charge bound, not the run limit (the raw
// pre-fix read-back of this exact sequence is `/tmp/t11/W4-before.json`, witness `/tmp/t11/witness/w4.mjs`).
// The observation is now deferred durably on the attempt hold and applied by the next catch-up or by `release`,
// so the interleaved and the settled ordering settle the identical total and a genuine breach stays visible.
//
// [T12] Every ledger below runs over the real `DurableStore.modelSpendJournal(runId)` fixture (`./support.ts`
// `realJournal`), and the restart tests read the deferral and the totals back out of the SQLite row over a
// second connection. The pre-T12 version used the `structuredClone` stand-in, whose `save` accepted the
// `undefined`-valued hold field the production journal refuses — which is exactly why this suite stayed green
// while R5 §4's cases failed against the real store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelSpendBudget, type ModelSpendJournal } from '../../src/policy/index.js';
import { ATTEMPT, RUN, SELECTION, budgetRequest, code, realJournal, usage } from './support.js';

const W4_LIMITS = Object.freeze({ maxTokens: 2_000, maxCostUsd: 2 });
const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const OBSERVED = usage(1_200, 200); // R4's W4 session: 2 × (600 in + 100 out)
const bound = (fixture: ReturnType<typeof realJournal>) => {
  const ledger = new ModelSpendBudget(W4_LIMITS, { runId: RUN, now: () => NOW, freshRun: true, journal: fixture.journal });
  ledger.bindRun(RUN, W4_LIMITS);
  return ledger;
};
const resumed = (journal: ModelSpendJournal) => {
  const ledger = new ModelSpendBudget(W4_LIMITS, { runId: RUN, now: () => NOW, journal });
  ledger.bindRun(RUN, W4_LIMITS);
  return ledger;
};
const turn = (reservationId: string, inputTokensUpperBound = 600, maxOutputTokens = 100) =>
  ({ reservationId, attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound, maxOutputTokens });
const catchUp = (ledger: ModelSpendBudget, reservationId: string, observed = OBSERVED) =>
  ledger.catchUp({ reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: observed });
/** Raw read-back: printed so every number in the report can be checked against the suite's own output. */
function readBack(ledger: ModelSpendBudget, reservationId: string) {
  const snapshot = ledger.snapshot();
  const state = ledger.exportState();
  return {
    limit: snapshot.limits.maxTokens,
    committed: snapshot.committed.tokens,
    active: snapshot.active.tokens,
    remaining: snapshot.remaining.tokens,
    overshoot: snapshot.overshoot.tokens,
    breach: snapshot.breach.tokens,
    deferredHolds: snapshot.deferred.holds,
    deferredTokens: snapshot.deferred.tokens,
    deferredClaimedTokens: snapshot.deferred.claimedTokens,
    openTurns: state.reservations[reservationId]?.openTurns ?? null,
    deferredCatchUps: state.reservations[reservationId]?.deferredCatchUps ?? null,
    settlements: Object.keys(state.settlements).map((id) => id.slice(id.lastIndexOf(':') + 1)),
  };
}
/** The totals two orderings must agree on. */
const totals = (ledger: ModelSpendBudget, reservationId: string) => {
  const snapshot = ledger.snapshot();
  return { committed: snapshot.committed, remaining: snapshot.remaining, overshoot: snapshot.overshoot, breach: snapshot.breach, settlements: readBack(ledger, reservationId).settlements };
};
/** R4's W4 sequence: two admits, the whole observation, then the two turns settle. */
function interleaved(fixture: ReturnType<typeof realJournal>): { ledger: ModelSpendBudget; held: ReturnType<ModelSpendBudget['reserve']>; first: ReturnType<ModelSpendBudget['admitTurn']>; second: ReturnType<ModelSpendBudget['admitTurn']> } {
  const ledger = bound(fixture);
  const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 100));
  const first = ledger.admitTurn(turn(held.reservationId));
  const second = ledger.admitTurn(turn(held.reservationId));
  assert.equal(ledger.snapshot().active.tokens, 1_400, 'both in-flight worst cases stay reserved, not one shared slot');
  // Both permits are durable, neither response has been released, and the whole observed session arrives.
  assert.equal(catchUp(ledger, held.reservationId), undefined, 'a catch-up with a turn in flight charges nothing');
  return { ledger, held, first, second };
}

test('a catch-up that lands while two admitted turns are in flight is deferred, not double-charged (R4 §4 / W4)', () => {
  const fixture = realJournal({ limits: W4_LIMITS });
  try {
    const { ledger, held, first, second } = interleaved(fixture);
    const duringFlight = readBack(ledger, held.reservationId);
    console.log(`W4-during-flight ${JSON.stringify(duringFlight)}`);
    console.log(`W4-during-flight SQL ${JSON.stringify(fixture.readBack()!.reservations[held.reservationId])}`);
    assert.deepEqual(duringFlight, {
      limit: 2_000, committed: 0, active: 1_400, remaining: 600, overshoot: 0, breach: 0,
      deferredHolds: 1, deferredTokens: 1_400, deferredClaimedTokens: 0, openTurns: 2, deferredCatchUps: 1, settlements: [],
    });
    const reservation = ledger.exportState().reservations[held.reservationId]!;
    assert.deepEqual(reservation.deferred, { inputTokens: 1_200, outputTokens: 200, reportedCostMicros: null, basis: 'session-catch-up', openTurns: 2, deferredAt: NOW });
    assert.equal(reservation.observedCharges, 0, 'a deferred observation mints no charge identity');
    const durableDuring = fixture.readBack()!;
    assert.equal(durableDuring.reservations[held.reservationId]!.openTurns, 2, 'the in-flight counters are durable before either charge');
    assert.deepEqual(durableDuring.committed, { tokens: 0, costMicros: 0 });

    // Truthful headroom: the third turn still cannot fit, and its refusal changes nothing.
    const beforeRefusal = ledger.exportState();
    assert.throws(() => ledger.admitTurn(turn(held.reservationId)), code('BUDGET_EXCEEDED'));
    assert.deepEqual(ledger.exportState(), beforeRefusal, 'a refused turn leaves the ledger untouched');
    assert.deepEqual(fixture.readBack(), durableDuring, 'a refused turn leaves the durable row untouched');

    // The two in-flight turns settle under their own identities: the observation was not charged a second time.
    first.charge(usage(600, 100));
    second.charge(usage(600, 100));
    const settled = readBack(ledger, held.reservationId);
    console.log(`W4-after-both-turns-charged ${JSON.stringify(settled)}`);
    assert.deepEqual(settled, {
      limit: 2_000, committed: 1_400, active: 0, remaining: 600, overshoot: 0, breach: 0,
      deferredHolds: 1, deferredTokens: 1_400, deferredClaimedTokens: 0, openTurns: 0, deferredCatchUps: 1, settlements: ['turn-1', 'turn-2'],
    });
    assert.equal(ledger.attemptUsage(held.reservationId, ATTEMPT).turns, 2, 'two provider turns settle exactly twice, not three times');
    assert.ok(ledger.snapshot().committed.tokens <= ledger.snapshot().limits.maxTokens!, 'the run limit is not breached by double counting');

    // The terminal catch-up retry finds nothing left to charge and clears the durable deferral.
    assert.equal(catchUp(ledger, held.reservationId), undefined);
    assert.equal(ledger.exportState().reservations[held.reservationId]!.deferred, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(fixture.readBack()!.reservations[held.reservationId], 'deferred'), false, 'the cleared deferral is absent from the durable row, not `undefined`');
    held.release('completed:charged-turns=2');
    const released = readBack(ledger, held.reservationId);
    console.log(`W4-released ${JSON.stringify(released)}`);
    console.log(`W4-released SQL ${JSON.stringify(fixture.readBack()!.released)}`);
    assert.deepEqual(released, { ...settled, deferredHolds: 0, deferredTokens: 0, deferredClaimedTokens: 0, openTurns: null, deferredCatchUps: null });
    assert.equal(fixture.readBack()!.released[held.reservationId]!.reason, 'completed:charged-turns=2');
    // The unspent headroom is real: exactly 600 tokens remain and a 601-token reservation is refused.
    // The unspent headroom is real: exactly 600 tokens remain and a 601-token reservation is refused. (The
    // second reservation reuses the attempt's durable identity — the real journal refuses a foreign attempt.)
    assert.equal(ledger.reserve({ attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 600, maxOutputTokens: 0, reservationId: 'headroom-probe' }).reservedTokens, 600);
    assert.throws(() => ledger.reserve({ attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 601, maxOutputTokens: 0, reservationId: 'overhead-probe' }), code('BUDGET_EXCEEDED'));
  } finally { fixture.cleanup(); }
});

test('the same catch-up after the turns settle settles the identical total (W4 control)', () => {
  const controlFixture = realJournal({ limits: W4_LIMITS });
  const interleavedFixture = realJournal({ limits: W4_LIMITS });
  try {
    const control = bound(controlFixture);
    const held = control.reserve(budgetRequest(ATTEMPT, 200, 100));
    const first = control.admitTurn(turn(held.reservationId));
    const second = control.admitTurn(turn(held.reservationId));
    first.charge(usage(600, 100));
    second.charge(usage(600, 100));
    assert.equal(catchUp(control, held.reservationId), undefined, 'the same observation has nothing left to add');
    control.release(held.reservationId, 'completed:charged-turns=2');
    const controlFinal = readBack(control, held.reservationId);
    console.log(`W4-control ${JSON.stringify(controlFinal)}`);
    console.log(`W4-control SQL ${JSON.stringify(controlFixture.readBack()!.committed)}`);
    assert.deepEqual(controlFinal, {
      limit: 2_000, committed: 1_400, active: 0, remaining: 600, overshoot: 0, breach: 0,
      deferredHolds: 0, deferredTokens: 0, deferredClaimedTokens: 0, openTurns: null, deferredCatchUps: null, settlements: ['turn-1', 'turn-2'],
    });

    // The same numbers through the interleaved ordering, in this test, so the totals are compared directly.
    const W4 = interleaved(interleavedFixture);
    W4.first.charge(usage(600, 100));
    W4.second.charge(usage(600, 100));
    W4.held.release('completed:charged-turns=2');
    console.log(`W4-interleaved-final ${JSON.stringify(readBack(W4.ledger, W4.held.reservationId))}`);
    assert.deepEqual(totals(W4.ledger, W4.held.reservationId), totals(control, held.reservationId), 'the interleaving must not change the total');
    assert.deepEqual(interleavedFixture.readBack()!.committed, controlFixture.readBack()!.committed, 'both orderings commit the same durable total');
  } finally { controlFixture.cleanup(); interleavedFixture.cleanup(); }
});

test('a genuine run-limit breach is charged once and stays visible in the ledger evidence', () => {
  const fixture = realJournal({ limits: W4_LIMITS });
  try {
    const ledger = bound(fixture);
    const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 100));
    const first = ledger.admitTurn(turn(held.reservationId));
    const second = ledger.admitTurn(turn(held.reservationId));
    // The observation exceeds both in-flight holds: R4's W6 provider-side overshoot, arriving as a catch-up.
    assert.equal(catchUp(ledger, held.reservationId, usage(2_000, 400)), undefined);
    const duringFlight = readBack(ledger, held.reservationId);
    console.log(`W4-breach-during-flight ${JSON.stringify(duringFlight)}`);
    assert.deepEqual(duringFlight, {
      limit: 2_000, committed: 0, active: 1_400, remaining: 0, overshoot: 0, breach: 0,
      deferredHolds: 1, deferredTokens: 2_400, deferredClaimedTokens: 1_000, openTurns: 2, deferredCatchUps: 1, settlements: [],
    });
    // Headroom is truthful: 1 000 tokens of the observation are neither charged nor held by a turn, so neither a
    // further turn on this attempt nor a new attempt may be admitted.
    assert.throws(() => ledger.admitTurn(turn(held.reservationId, 60, 10)), code('BUDGET_EXCEEDED'));
    assert.throws(() => ledger.reserve({ attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 1, maxOutputTokens: 0, reservationId: 'claim-probe' }), code('BUDGET_EXCEEDED'));

    first.charge(usage(600, 100));
    second.charge(usage(600, 100));
    held.release('failed:charged-turns=2');
    const released = readBack(ledger, held.reservationId);
    console.log(`W4-breach-released ${JSON.stringify(released)}`);
    console.log(`W4-breach-released SQL ${JSON.stringify({ committed: fixture.readBack()!.committed, settlements: Object.keys(fixture.readBack()!.settlements) })}`);
    // The observed 2 400 tokens are charged exactly once (not 1 400 + 2 400), and the 400-token run-limit breach
    // plus the 1 000-token per-charge overshoot are both recorded instead of being hidden behind `overshoot 0`.
    assert.deepEqual(released, {
      limit: 2_000, committed: 2_400, active: 0, remaining: 0, overshoot: 1_000, breach: 400,
      deferredHolds: 0, deferredTokens: 0, deferredClaimedTokens: 0, openTurns: null, deferredCatchUps: null, settlements: ['turn-1', 'turn-2', 'observed-1'],
    });
    const observedCharge = ledger.exportState().settlements[`${held.reservationId}:observed-1`]!;
    assert.equal(observedCharge.basis, 'session-catch-up');
    assert.deepEqual({ tokens: observedCharge.tokens, overshoot: observedCharge.overshootTokens }, { tokens: 1_000, overshoot: 1_000 });
    assert.equal(fixture.readBack()!.settlements[`${held.reservationId}:observed-1`]!.tokens, 1_000, 'the breach charge is durable');
  } finally { fixture.cleanup(); }
});

test('a turn that charges less than its bound leaves the deferred remainder to the terminal path', () => {
  const fixture = realJournal({ limits: W4_LIMITS });
  try {
    const ledger = bound(fixture);
    const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 100));
    const first = ledger.admitTurn(turn(held.reservationId));
    const second = ledger.admitTurn(turn(held.reservationId));
    assert.equal(catchUp(ledger, held.reservationId), undefined);
    first.charge(usage(300, 100));
    second.charge(usage(300, 100));
    // The in-flight bounds are gone, but 600 of the observed tokens are still unpaid: the deferral must survive
    // its own claim reaching 0 here, or the terminal path would drop them.
    assert.equal(ledger.snapshot().committed.tokens, 800);
    assert.equal(ledger.snapshot().deferred.tokens, 1_400);
    assert.equal(ledger.snapshot().deferred.claimedTokens, 600, 'the unpaid part is the admission claim');
    held.release('completed:charged-turns=2');
    const released = readBack(ledger, held.reservationId);
    console.log(`W4-partial-turn-usage-released ${JSON.stringify(released)}`);
    assert.deepEqual(released, {
      limit: 2_000, committed: 1_400, active: 0, remaining: 600, overshoot: 0, breach: 0,
      deferredHolds: 0, deferredTokens: 0, deferredClaimedTokens: 0, openTurns: null, deferredCatchUps: null, settlements: ['turn-1', 'turn-2', 'observed-1'],
    });
    assert.equal(fixture.readBack()!.settlements[`${held.reservationId}:observed-1`]!.tokens, 600, 'only the unpaid remainder is charged');
  } finally { fixture.cleanup(); }
});

test('a deferred catch-up is durable and a restarted controller charges it instead of deferring it again', () => {
  const fixture = realJournal({ limits: W4_LIMITS });
  try {
    const first = bound(fixture);
    const held = first.reserve(budgetRequest(ATTEMPT, 200, 100));
    first.admitTurn(turn(held.reservationId));
    first.admitTurn(turn(held.reservationId));
    assert.equal(catchUp(first, held.reservationId), undefined);
    const durable = fixture.readBack()!;
    console.log(`W4-restart-durable ${JSON.stringify(durable.reservations[held.reservationId])}`);
    assert.equal(durable.reservations[held.reservationId]!.deferredCatchUps, 1, 'the deferral count is durable evidence');
    assert.deepEqual(durable.reservations[held.reservationId]!.deferred, { inputTokens: 1_200, outputTokens: 200, reportedCostMicros: null, basis: 'session-catch-up', openTurns: 2, deferredAt: NOW });
    assert.equal(durable.committed.tokens, 0, 'a deferred observation is not a charge');

    // A restarted ledger owns those tokens: no turn of the dead process can charge it, so the observation is
    // charged immediately (R3 §9.3's reconciliation contract) rather than deferred forever by stale counters.
    const resumedLedger = resumed(fixture.reopen().journal);
    assert.equal(resumedLedger.activeReservations()[0]!.reservedTokens, 1_400, 'the in-flight holds are restored conservatively');
    const reconciled = catchUp(resumedLedger, held.reservationId);
    assert.equal(reconciled!.tokens, 1_400);
    assert.equal(reconciled!.turnId, `${held.reservationId}:observed-1`);
    assert.throws(() => resumedLedger.release(held.reservationId), /Unobserved admitted provider turns/, 'observations alone cannot erase unknown in-flight admissions');
    resumedLedger.reconcileTerminal(held.reservationId, { terminationVerified: true, reference: 'fixture-process-exit', usage: OBSERVED, completeUsageVerified: true });
    resumedLedger.release(held.reservationId, 'reconciled:charged-turns=1');
    assert.deepEqual({ committed: resumedLedger.snapshot().committed.tokens, deferred: resumedLedger.snapshot().deferred.holds }, { committed: 1_400, deferred: 0 });
    console.log(`W4-restart-reconciled SQL ${JSON.stringify(fixture.readBack()!.committed)}`);
    assert.deepEqual(fixture.readBack()!.committed, { tokens: 1_400, costMicros: 6_600 });
  } finally { fixture.cleanup(); }
});

test('a deferred observation is never dropped with the hold: the terminal release charges it', () => {
  const fixture = realJournal({ limits: W4_LIMITS });
  try {
    const first = bound(fixture);
    const held = first.reserve(budgetRequest(ATTEMPT, 200, 100));
    first.admitTurn(turn(held.reservationId));
    first.admitTurn(turn(held.reservationId));
    assert.equal(catchUp(first, held.reservationId), undefined);

    // Restart, then release without any further catch-up: the terminal path itself must settle the observation.
    const resumedLedger = resumed(fixture.reopen().journal);
    resumedLedger.reconcileTerminal(held.reservationId, { terminationVerified: true, reference: 'fixture-process-exit', usage: OBSERVED, completeUsageVerified: true });
    assert.equal(resumedLedger.release(held.reservationId, 'failed:charged-turns=0'), true);
    const released = readBack(resumedLedger, held.reservationId);
    console.log(`W4-release-only-terminal ${JSON.stringify(released)}`);
    assert.deepEqual(released, {
      limit: 2_000, committed: 1_400, active: 0, remaining: 600, overshoot: 0, breach: 0,
      deferredHolds: 0, deferredTokens: 0, deferredClaimedTokens: 0, openTurns: null, deferredCatchUps: null, settlements: ['observed-1'],
    });
    assert.equal(resumedLedger.snapshot().committed.costUsd, 0.0066, 'the observed usage is charged at the pinned prices');
    assert.equal(resumedLedger.release(held.reservationId, 'failed:charged-turns=0'), false, 'release stays idempotent');
    assert.deepEqual(fixture.readBack()!.committed, { tokens: 1_400, costMicros: 6_600 });
  } finally { fixture.cleanup(); }
});
