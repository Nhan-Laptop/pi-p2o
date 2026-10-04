// T12 regression: the defer / apply / clear / release paths against the REAL DurableStore journal.
//
// R5 §4 (cases A–L) and §5.1 falsified T11's durability claim: the only budget tests that exercised a
// deferral used the `structuredClone` stand-in (`./support.ts` `memoryJournal`), whose `save` accepts an own
// key whose value is `undefined`. The production journal writes `canonicalJson(state)` and refuses such a key
// as non-JSON, so every deferral clear, every observed charge, every terminal release and every restart
// reconciliation threw `UNAVAILABLE` and then poisoned the ledger (`snapshot()` → UNAVAILABLE, holds never
// released, restart unable to recover).
//
// These tests drive the same paths through `DurableStore.modelSpendJournal(runId)` on a real SQLite file and
// read the state back over a second, independent connection, so every assertion is about the journal itself
// rather than the ledger's in-memory view. The W4/control pair lives in `catch-up-concurrency.node.ts`,
// which uses the same real-journal fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../../src/contracts/index.js';
import { ModelSpendBudget, type ModelSpendJournal, type ModelSpendState } from '../../src/policy/index.js';
import { ATTEMPT, LIMITS, NOW_MS, RUN, SELECTION, budgetRequest, code, faultyJournal, realJournal, usage } from './support.js';

const W4_LIMITS = Object.freeze({ maxTokens: 2_000, maxCostUsd: 2 });
/** R4's W4 session: 2 × (600 in + 100 out); case A/D/F use a single turn's share. */
const OBSERVED = usage(1_200, 200);
const now = () => NOW_MS;

/** A fresh ledger over a real journal (the journal holds nothing yet, so `freshRun` is explicit). */
const bound = (journal: ModelSpendJournal, limits: { maxTokens: number; maxCostUsd: number } = LIMITS) => {
  const ledger = new ModelSpendBudget(limits, { runId: RUN, now, freshRun: true, journal });
  ledger.bindRun(RUN, limits);
  return ledger;
};
/** A restarted ledger over an existing journal; no `freshRun`, so a missing state is an error. */
const resumed = (journal: ModelSpendJournal, limits: { maxTokens: number; maxCostUsd: number } = LIMITS) => {
  const ledger = new ModelSpendBudget(limits, { runId: RUN, now, journal });
  ledger.bindRun(RUN, limits);
  return ledger;
};
const turn = (reservationId: string, inputTokensUpperBound = 600, maxOutputTokens = 100) =>
  ({ reservationId, attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound, maxOutputTokens });
const catchUp = (ledger: ModelSpendBudget, reservationId: string, observed = OBSERVED) =>
  ledger.catchUp({ reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: observed });
/** Raw SQL read-back: printed so every number in the report can be checked against the durable row. */
const durable = (state: ModelSpendState | undefined, reservationId: string) => ({
  committed: state?.committed,
  overshoot: state?.overshoot,
  settlements: Object.keys(state?.settlements ?? {}).map((id) => id.slice(id.lastIndexOf(':') + 1)),
  released: Object.keys(state?.released ?? {}),
  reservation: state?.reservations[reservationId] ?? null,
});

test('R5 case A: a deferral cleared after the turn settles round-trips instead of poisoning the ledger', () => {
  const fixture = realJournal({ limits: W4_LIMITS });
  try {
    const ledger = bound(fixture.journal, W4_LIMITS);
    const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 100));
    const first = ledger.admitTurn(turn(held.reservationId));
    // The observation lands while the admitted turn is still in flight: it is deferred, not charged.
    assert.equal(catchUp(ledger, held.reservationId, usage(600, 100)), undefined);
    const deferredRow = fixture.rawJson()!;
    console.log(`A-raw-after-defer ${deferredRow.slice(0, 240)}…`);
    assert.ok(deferredRow.includes('"deferred"'), 'the deferral is in the durable row');
    assert.equal(ledger.snapshot().committed.tokens, 0);

    // The turn then settles for exactly the observation, so the terminal catch-up has a zero delta: R5's
    // case A is the `clearDeferral` path, which used to leave `deferred: undefined` on the hold and fail.
    first.charge(usage(600, 100));
    assert.equal(catchUp(ledger, held.reservationId, usage(600, 100)), undefined, 'a zero delta clears the deferral');
    const cleared = fixture.readBack()!;
    console.log(`A-after-clear ${JSON.stringify(durable(cleared, held.reservationId))}`);
    assert.equal(Object.prototype.hasOwnProperty.call(cleared.reservations[held.reservationId], 'deferred'), false, 'the key is removed, never persisted as undefined');
    assert.equal(cleared.reservations[held.reservationId]!.deferredCatchUps, 1, 'the deferral stayed durable evidence');
    assert.equal(ledger.snapshot().deferred.holds, 0);

    assert.equal(ledger.release(held.reservationId, 'completed:charged-turns=1'), true);
    const final = fixture.readBack()!;
    console.log(`A-final ${JSON.stringify(durable(final, held.reservationId))}`);
    assert.deepEqual(final.committed, { tokens: 700, costMicros: 3_300 });
    assert.deepEqual(Object.keys(final.settlements), [`${held.reservationId}:turn-1`]);
    assert.deepEqual(Object.keys(final.released), [held.reservationId]);
    assert.equal(final.reservations[held.reservationId], undefined);
    assert.equal(fixture.rawJson(), canonicalJson(final), 'the durable row is canonical strict JSON');
  } finally { fixture.cleanup(); }
});

test('R5 case J: the primary no-gateway catch-up charges and releases through the real journal', () => {
  const fixture = realJournal();
  try {
    const ledger = bound(fixture.journal);
    const held = ledger.reserve(budgetRequest(ATTEMPT, 600, 100));
    // No provider turn was ever admitted: the observation is charged immediately (T9's primary path).
    const charged = catchUp(ledger, held.reservationId, usage(600, 100));
    assert.ok(charged, 'an observation with no in-flight turn is a charge, not a deferral');
    console.log(`J-charge ${JSON.stringify({ turnId: charged.turnId, tokens: charged.tokens, basis: charged.basis, duplicate: charged.duplicate })}`);
    assert.equal(charged.turnId, `${held.reservationId}:observed-1`);
    assert.equal(charged.tokens, 700);
    assert.equal(charged.basis, 'session-catch-up');
    assert.deepEqual(charged.overshoot, { tokens: 0, costUsd: 0 });
    assert.equal(ledger.release(held.reservationId, 'completed:charged-turns=1'), true);
    const final = fixture.readBack()!;
    console.log(`J-final ${JSON.stringify(durable(final, held.reservationId))}`);
    assert.deepEqual(final.committed, { tokens: 700, costMicros: 3_300 });
    assert.deepEqual(Object.keys(final.settlements), [`${held.reservationId}:observed-1`]);
    assert.deepEqual(Object.keys(final.released), [held.reservationId]);
    assert.equal(final.reservations[held.reservationId], undefined);
  } finally { fixture.cleanup(); }
});

test('R5 case D: an unissued provider turn leaves the deferral for the terminal release, charged once', () => {
  const fixture = realJournal({ limits: W4_LIMITS });
  try {
    const ledger = bound(fixture.journal, W4_LIMITS);
    const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 100));
    const abandoned = ledger.admitTurn(turn(held.reservationId));
    // The gateway's upstream was unreachable: the permit is abandoned and never charges. The session usage
    // still arrives while the admitted turn is counted in flight, so it is deferred.
    assert.equal(catchUp(ledger, held.reservationId, usage(600, 100)), undefined);
    const during = fixture.readBack()!;
    console.log(`D-during ${JSON.stringify(durable(during, held.reservationId))}`);
    assert.equal(during.reservations[held.reservationId]!.deferredCatchUps, 1);
    assert.deepEqual(during.committed, { tokens: 0, costMicros: 0 });

    // Terminal path: the hold is released and the deferred observation is charged exactly once.
    ledger.reconcileTerminal(held.reservationId, { terminationVerified: true, reference: 'fixture-terminal-collection', usage: usage(600, 100), completeUsageVerified: true });
    assert.equal(ledger.release(held.reservationId, 'failed:charged-turns=0'), true);
    const final = fixture.readBack()!;
    console.log(`D-final ${JSON.stringify(durable(final, held.reservationId))}`);
    assert.deepEqual(final.committed, { tokens: 700, costMicros: 3_300 });
    assert.deepEqual(Object.keys(final.settlements), [`${held.reservationId}:observed-1`]);
    assert.deepEqual(Object.keys(final.released), [held.reservationId]);
    assert.equal(final.reservations[held.reservationId], undefined);

    // A late charge from the abandoned permit cannot double-charge after the release.
    assert.throws(() => abandoned.charge(usage(600, 100)), code('INVALID_INPUT'));
    assert.deepEqual(fixture.readBack()!.committed, final.committed);
    assert.deepEqual(Object.keys(fixture.readBack()!.settlements), [`${held.reservationId}:observed-1`]);
  } finally { fixture.cleanup(); }
});

test('R5 case F: a cancellation release wins the race with a late catch-up; the late catch-up is refused', () => {
  const fixture = realJournal({ limits: W4_LIMITS });
  try {
    const ledger = bound(fixture.journal, W4_LIMITS);
    const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 100));
    ledger.admitTurn(turn(held.reservationId));
    assert.equal(catchUp(ledger, held.reservationId, usage(600, 100)), undefined);
    // Cancellation arrives first: it must settle the deferred observation and release the hold.
    ledger.reconcileTerminal(held.reservationId, { terminationVerified: true, reference: 'fixture-terminal-collection', usage: usage(600, 100), completeUsageVerified: true });
    assert.equal(ledger.release(held.reservationId, 'cancelled:charged-turns=0'), true);
    const afterRelease = fixture.readBack()!;
    console.log(`F-after-release ${JSON.stringify(durable(afterRelease, held.reservationId))}`);
    assert.deepEqual(afterRelease.committed, { tokens: 700, costMicros: 3_300 });
    // The late catch-up that raced the cancellation is refused instead of double-charging.
    assert.throws(() => catchUp(ledger, held.reservationId, usage(600, 100)), code('INVALID_INPUT'));
    const final = fixture.readBack()!;
    console.log(`F-final ${JSON.stringify(durable(final, held.reservationId))}`);
    assert.deepEqual(final.committed, afterRelease.committed);
    assert.deepEqual(Object.keys(final.settlements), [`${held.reservationId}:observed-1`]);
  } finally { fixture.cleanup(); }
});

test('R5 case L: a restarted ledger recovers the pending deferral, applies it once, and releases', () => {
  const fixture = realJournal({ limits: W4_LIMITS });
  try {
    const first = bound(fixture.journal, W4_LIMITS);
    const held = first.reserve(budgetRequest(ATTEMPT, 200, 100));
    first.admitTurn(turn(held.reservationId));
    first.admitTurn(turn(held.reservationId));
    assert.equal(catchUp(first, held.reservationId, OBSERVED), undefined);
    const beforeRestart = fixture.readBack()!;
    console.log(`L-before-restart ${JSON.stringify(durable(beforeRestart, held.reservationId))}`);
    assert.equal(beforeRestart.reservations[held.reservationId]!.deferredCatchUps, 1);
    assert.deepEqual(beforeRestart.committed, { tokens: 0, costMicros: 0 });

    // A new process opens the same database. The pending deferral and the stale durable in-flight counters
    // survive, but no turn of the dead process can still charge this ledger, so the observation is charged
    // by reconciliation instead of being deferred again forever (T9's `reconcileSpend` contract).
    const reopened = fixture.reopen();
    const resumedLedger = resumed(reopened.journal, W4_LIMITS);
    assert.equal(resumedLedger.snapshot().deferred.holds, 1, 'the deferral is recovered from the journal');
    assert.equal(resumedLedger.snapshot().deferred.tokens, 1_400);
    assert.deepEqual(resumedLedger.snapshot().committed, { tokens: 0, costUsd: 0 });
    const reconciled = catchUp(resumedLedger, held.reservationId, OBSERVED);
    assert.ok(reconciled);
    assert.equal(reconciled.turnId, `${held.reservationId}:observed-1`);
    assert.equal(reconciled.tokens, 1_400, 'the whole observation is charged once, not twice');
    resumedLedger.reconcileTerminal(held.reservationId, { terminationVerified: true, reference: 'fixture-terminal-collection', usage: OBSERVED, completeUsageVerified: true });
    assert.equal(resumedLedger.release(held.reservationId, 'reconciled:charged-turns=1'), true);
    const afterReconcile = fixture.readBack()!;
    console.log(`L-after-reconcile ${JSON.stringify(durable(afterReconcile, held.reservationId))}`);
    assert.deepEqual(afterReconcile.committed, { tokens: 1_400, costMicros: 6_600 });
    assert.deepEqual(Object.keys(afterReconcile.settlements), [`${held.reservationId}:observed-1`]);
    assert.deepEqual(Object.keys(afterReconcile.released), [held.reservationId]);

    // A third process must not double-charge, re-defer or keep any hold.
    const third = resumed(fixture.reopen().journal, W4_LIMITS);
    console.log(`L-third ${JSON.stringify(durable(fixture.readBack(), held.reservationId))}`);
    assert.deepEqual(third.snapshot().committed, { tokens: 1_400, costUsd: 0.0066 });
    assert.equal(third.snapshot().settlements, 1);
    assert.equal(third.snapshot().released, 1);
    assert.deepEqual(third.activeReservations(), []);
    assert.throws(() => catchUp(third, held.reservationId, OBSERVED), code('INVALID_INPUT'));
  } finally { fixture.cleanup(); }
});

test('a persistence failure never poisons the ledger: one bounded retry on the terminal path absorbs it', () => {
  const fixture = realJournal({ limits: W4_LIMITS });
  try {
    let remaining = 1; let injected = 0;
    const journal = faultyJournal(fixture.journal, (state) => {
      if (remaining > 0 && Object.keys(state.released).length > 0) { remaining -= 1; injected += 1; return true; }
      return false;
    });
    const ledger = bound(journal, W4_LIMITS);
    const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 100));
    const first = ledger.admitTurn(turn(held.reservationId));
    assert.equal(catchUp(ledger, held.reservationId, OBSERVED), undefined);
    first.charge(usage(600, 100));
    // The release save fails once; the terminal path retries from the rolled-back durable state and lands.
    assert.equal(ledger.release(held.reservationId, 'completed:charged-turns=1'), true);
    assert.equal(injected, 1, 'the injected fault was actually exercised');
    const final = fixture.readBack()!;
    console.log(`RETRY-final ${JSON.stringify(durable(final, held.reservationId))}`);
    assert.deepEqual(final.committed, { tokens: 1_400, costMicros: 6_600 });
    assert.deepEqual(Object.keys(final.settlements).sort(), [`${held.reservationId}:observed-1`, `${held.reservationId}:turn-1`]);
    assert.deepEqual(Object.keys(final.released), [held.reservationId]);
    assert.equal(ledger.snapshot().settlements, 2, 'the retry did not double-charge');
    // The retry committed, so the degraded state is cleared: the supervisor view is healthy again.
    assert.deepEqual(ledger.snapshot().committed, { tokens: 1_400, costUsd: 0.0066 });
  } finally { fixture.cleanup(); }
});

test('a failed commit keeps the previous durable state, fails closed, and stays releasable', () => {
  const fixture = realJournal({ limits: W4_LIMITS });
  try {
    let remaining = 2; let injected = 0;
    const journal = faultyJournal(fixture.journal, (state) => {
      if (remaining > 0 && Object.keys(state.released).length > 0) { remaining -= 1; injected += 1; return true; }
      return false;
    });
    const ledger = bound(journal, W4_LIMITS);
    const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 100));
    const first = ledger.admitTurn(turn(held.reservationId));
    assert.equal(catchUp(ledger, held.reservationId, OBSERVED), undefined);
    first.charge(usage(600, 100));

    assert.throws(() => ledger.release(held.reservationId, 'completed:charged-turns=1'), code('UNAVAILABLE'), 'the operation fails explicitly');
    assert.equal(injected, 2, 'both attempts were refused, so the caller really saw the failure');
    const afterFailure = fixture.readBack()!;
    console.log(`DEGRADED-after-failure ${JSON.stringify(durable(afterFailure, held.reservationId))}`);
    // The state is exactly the last successful commit: the observed charge landed, the release did not.
    assert.deepEqual(afterFailure.committed, { tokens: 1_400, costMicros: 6_600 });
    assert.deepEqual(Object.keys(afterFailure.settlements).sort(), [`${held.reservationId}:observed-1`, `${held.reservationId}:turn-1`]);
    assert.deepEqual(Object.keys(afterFailure.released), []);
    assert.ok(afterFailure.reservations[held.reservationId], 'the hold is still durable, for a later retry');
    assert.equal(Object.prototype.hasOwnProperty.call(afterFailure.reservations[held.reservationId], 'deferred'), false);

    // Degraded but not wedged: the durable state stays readable to reconciliation and the hold stays
    // releasable, while new dispatch and the supervisor-facing `snapshot()` fail closed until a commit lands.
    const state = ledger.exportState();
    console.log(`DEGRADED-exportState ${JSON.stringify({ committed: state.committed, reservations: Object.keys(state.reservations), released: Object.keys(state.released) })}`);
    assert.deepEqual(state.committed, { tokens: 1_400, costMicros: 6_600 });
    assert.deepEqual(Object.keys(state.reservations), [held.reservationId]);
    assert.deepEqual(ledger.activeReservations().map((r) => r.reservationId), [held.reservationId]);
    assert.throws(() => ledger.snapshot(), /Model spend journal failed/, 'the snapshot refuses while the commit is outstanding');
    assert.throws(() => ledger.reserve({ ...budgetRequest(ATTEMPT, 1, 0), reservationId: 'blocked-probe' }), code('UNAVAILABLE'), 'new dispatch is refused');
    assert.throws(() => ledger.admitTurn(turn(held.reservationId, 1, 0)), code('UNAVAILABLE'), 'no further provider turn may be admitted');

    // Retry once the fault is over: the same terminal call lands exactly once, without re-charging.
    assert.equal(ledger.release(held.reservationId, 'completed:charged-turns=1'), true);
    const final = fixture.readBack()!;
    console.log(`DEGRADED-final ${JSON.stringify(durable(final, held.reservationId))}`);
    assert.deepEqual(final.committed, { tokens: 1_400, costMicros: 6_600 });
    assert.deepEqual(Object.keys(final.settlements).sort(), [`${held.reservationId}:observed-1`, `${held.reservationId}:turn-1`]);
    assert.deepEqual(Object.keys(final.released), [held.reservationId]);
    // The release committed, so the degraded state is cleared and the ledger is fully usable again.
    assert.deepEqual(ledger.snapshot().committed, { tokens: 1_400, costUsd: 0.0066 });
    assert.equal(ledger.snapshot().released, 1);
  } finally { fixture.cleanup(); }
});

test('a failed deferral leaves the previous durable state intact and the operation can be retried', () => {
  const fixture = realJournal({ limits: W4_LIMITS });
  try {
    let remaining = 1; let injected = 0;
    const journal = faultyJournal(fixture.journal, (state) => {
      const reservation = state.reservations[Object.keys(state.reservations)[0]!];
      if (remaining > 0 && reservation?.deferred !== undefined) { remaining -= 1; injected += 1; return true; }
      return false;
    });
    const ledger = bound(journal, W4_LIMITS);
    const held = ledger.reserve(budgetRequest(ATTEMPT, 200, 100));
    ledger.admitTurn(turn(held.reservationId));
    const before = fixture.readBack()!;
    console.log(`DEFER-FAIL-before ${JSON.stringify(durable(before, held.reservationId))}`);

    assert.throws(() => catchUp(ledger, held.reservationId, OBSERVED), code('UNAVAILABLE'));
    assert.equal(injected, 1, 'the injected fault was actually exercised');
    const afterFailure = fixture.readBack()!;
    console.log(`DEFER-FAIL-after ${JSON.stringify(durable(afterFailure, held.reservationId))}`);
    assert.deepEqual(afterFailure, before, 'the previous durable state survives byte-for-byte (no deferral landed)');
    // The attempted commit failed, so the ledger fails closed until one succeeds: the supervisor view and
    // new dispatch are refused, while the retry itself is allowed and clears the degraded state.
    assert.throws(() => ledger.snapshot(), /Model spend journal failed/);
    assert.throws(() => ledger.reserve({ ...budgetRequest(ATTEMPT, 1, 0), reservationId: 'blocked-probe' }), code('UNAVAILABLE'));
    assert.equal(catchUp(ledger, held.reservationId, OBSERVED), undefined);
    assert.equal(ledger.snapshot().deferred.holds, 1);
    assert.equal(ledger.snapshot().active.count, 1);
    const afterRetry = fixture.readBack()!;
    console.log(`DEFER-FAIL-retry ${JSON.stringify(durable(afterRetry, held.reservationId))}`);
    assert.equal(afterRetry.reservations[held.reservationId]!.deferredCatchUps, 1);
    assert.equal(afterRetry.reservations[held.reservationId]!.deferred!.inputTokens, 1_200);

    ledger.reconcileTerminal(held.reservationId, { terminationVerified: true, reference: 'fixture-terminal-collection', usage: OBSERVED, completeUsageVerified: true });
    assert.equal(ledger.release(held.reservationId, 'failed:charged-turns=0'), true);
    const final = fixture.readBack()!;
    console.log(`DEFER-FAIL-final ${JSON.stringify(durable(final, held.reservationId))}`);
    assert.deepEqual(final.committed, { tokens: 1_400, costMicros: 6_600 });
    assert.deepEqual(Object.keys(final.settlements), [`${held.reservationId}:observed-1`]);
  } finally { fixture.cleanup(); }
});

test('the real journal stays strict: non-JSON, foreign and corrupt state are still refused', () => {
  const fixture = realJournal({ limits: LIMITS });
  try {
    const ledger = bound(fixture.journal);
    const held = ledger.reserve(budgetRequest(ATTEMPT, 100, 100));
    const state = ledger.exportState();
    assert.equal(fixture.rawJson(), canonicalJson(fixture.readBack()), 'the durable row is canonical JSON');
    assert.ok(!fixture.rawJson()!.includes('undefined'), 'the ledger never persists an undefined value');

    // The R5 root-cause shape is still rejected, not silently widened away.
    const withUndefined = { ...state, reservations: { ...state.reservations, [held.reservationId]: { ...state.reservations[held.reservationId]!, deferred: undefined } } };
    assert.throws(() => fixture.journal.save(withUndefined), /JSON/);
    // A reservation that names an attempt outside this run is still refused.
    const foreign = { ...state, reservations: { ...state.reservations, [held.reservationId]: { ...state.reservations[held.reservationId]!, attemptId: 'attempt-does-not-exist' } } };
    assert.throws(() => fixture.journal.save(foreign), /outside this run/);
    // A corrupt (but well-formed JSON) deferral cannot be restored into an unbounded claim.
    const corrupt = { ...state, reservations: { ...state.reservations, [held.reservationId]: { ...state.reservations[held.reservationId]!, deferred: { inputTokens: -1, outputTokens: 0, reportedCostMicros: null, basis: 'session-catch-up', openTurns: 1, deferredAt: 1 } } } };
    fixture.journal.save(corrupt);
    assert.throws(() => resumed(fixture.journal), code('UNAVAILABLE'));
    // ...and neither can totals that disagree with the settled receipts.
    fixture.journal.save({ ...state, committed: { tokens: 1, costMicros: 1 } });
    assert.throws(() => resumed(fixture.journal), code('UNAVAILABLE'));
  } finally { fixture.cleanup(); }
});
