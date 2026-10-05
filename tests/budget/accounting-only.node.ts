import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelSpendBudget } from '../../src/policy/budget.js';
import { ATTEMPT, RUN, SELECTION, memoryJournal } from './support.js';

const policy = Object.freeze({ mode: 'accounting-only' as const });

test('explicit accounting-only mode accounts above former quotas without monetary refusal and resumes exactly', () => {
  const durable = memoryJournal();
  const first = new ModelSpendBudget(policy, { runId: RUN, journal: durable.journal, freshRun: true });
  const hold = first.reserve({ attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 200_000, maxOutputTokens: 150_000 });
  first.admitTurn({ reservationId: hold.reservationId, attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 200_000, maxOutputTokens: 150_000 })
    .charge({ inputTokens: 180_000, outputTokens: 120_000, reportedCostUsd: 500 });
  assert.equal(first.snapshot().committed.tokens, 300_000);
  assert.equal(first.snapshot().accountedCostUsd, 500);
  assert.deepEqual(first.snapshot().limits, { mode: 'accounting-only', maxTokens: null, maxCostUsd: null });
  assert.deepEqual(first.snapshot().remaining, { tokens: null, costUsd: null });
  assert.deepEqual(first.snapshot().breach, { tokens: 0, costUsd: 0 });
  const reopened = new ModelSpendBudget(policy, { runId: RUN, journal: durable.journal });
  reopened.bindRun(RUN, policy);
  assert.deepEqual(reopened.snapshot(), first.snapshot());
  reopened.admitTurn({ reservationId: hold.reservationId, attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 10, maxOutputTokens: 20 })
    .charge({ inputTokens: 10, outputTokens: 20, reportedCostUsd: 50 });
  assert.equal(reopened.snapshot().accountedCostUsd, 550);
  assert.throws(() => new ModelSpendBudget({ maxTokens: 100_000, maxCostUsd: 5 }, { runId: RUN, journal: durable.journal }), /identity mismatch/);
});

test('legacy bounded journal cannot silently migrate to accounting-only and remains financially enforced', () => {
  const durable = memoryJournal();
  const bounded = new ModelSpendBudget({ maxTokens: 100, maxCostUsd: 1 }, { runId: RUN, journal: durable.journal, freshRun: true });
  assert.throws(() => bounded.reserve({ attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 100, maxOutputTokens: 1 }), /budget/);
  assert.throws(() => bounded.bindRun(RUN, policy), /cannot migrate/);
  assert.throws(() => new ModelSpendBudget(policy, { runId: RUN, journal: durable.journal }), /identity mismatch/);
});

test('accounting-only is not a gate bypass: attempt identity, native output bound and operational turn control still apply', () => {
  const durable = memoryJournal({ attempts: new Map([[ATTEMPT, RUN]]) });
  const ledger = new ModelSpendBudget(policy, { runId: RUN, journal: durable.journal, freshRun: true, maxTurns: 1, selection: SELECTION });
  assert.throws(() => ledger.reserve({ attemptId: 'foreign', selection: SELECTION, inputTokensUpperBound: 1, maxOutputTokens: 10 }), /attempt/);
  const hold = ledger.reserve({ attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 1, maxOutputTokens: 10 });
  ledger.admitTurn({ reservationId: hold.reservationId, attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 1, maxOutputTokens: 10 }).charge({ inputTokens: 1, outputTokens: 11 });
  assert.equal(ledger.snapshot().overshoot.tokens, 1);
  assert.throws(() => ledger.admitTurn({ reservationId: hold.reservationId, attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 1, maxOutputTokens: 10 }), /overshoot|allocation/);
  assert.throws(() => new ModelSpendBudget({ mode: 'accounting-only', maxTokens: 100 } as never), /hidden/);
});

test('informational accounting allows an unpriced selected model and reports its cost as unknown', () => {
  const unpriced = Object.freeze({ provider: 'unpriced-provider', model: 'unpriced-model', thinking: 'max' as const });
  // A bounded legacy ledger still refuses an unpriceable selection before dispatch.
  const bounded = new ModelSpendBudget({ maxTokens: 1_000, maxCostUsd: 1 }, { runId: RUN });
  assert.throws(() => bounded.reserve({ attemptId: ATTEMPT, selection: unpriced, inputTokensUpperBound: 10, maxOutputTokens: 10 }), /No pinned price/);
  // Informational accounting records tokens and leaves the monetary figure unknown, with no refusal.
  const durable = memoryJournal();
  const ledger = new ModelSpendBudget(policy, { runId: RUN, journal: durable.journal, freshRun: true });
  const hold = ledger.reserve({ attemptId: ATTEMPT, selection: unpriced, inputTokensUpperBound: 10, maxOutputTokens: 1_000 });
  ledger.admitTurn({ reservationId: hold.reservationId, attemptId: ATTEMPT, selection: unpriced, inputTokensUpperBound: 10, maxOutputTokens: 1_000 })
    .charge({ inputTokens: 1_234, outputTokens: 567 });
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.committed.tokens, 1_801);
  assert.equal(snapshot.accountedCostUsd, null, 'unknown is not a zero-dollar invoice');
  assert.equal(snapshot.committed.costUsd, null);
  assert.equal(snapshot.observedCostUsd, null);
  assert.equal(snapshot.costPolicy, 'unpriced-informational');
  assert.deepEqual(snapshot.breach, { tokens: 0, costUsd: 0 });
  const reopened = new ModelSpendBudget(policy, { runId: RUN, journal: durable.journal });
  assert.deepEqual(reopened.snapshot(), snapshot, 'restart preserves unknown costs and observed tokens');
  reopened.admitTurn({ reservationId: hold.reservationId, attemptId: ATTEMPT, selection: unpriced, inputTokensUpperBound: 10, maxOutputTokens: 10 }).charge({ inputTokens: 10, outputTokens: 10, reportedCostUsd: 0.25 });
  assert.equal(reopened.snapshot().accountedCostUsd, null, 'one reported turn cannot price an earlier unknown turn');
  const reported = new ModelSpendBudget(policy, { runId: 'reported-only' });
  const reportedHold = reported.reserve({ attemptId: ATTEMPT, selection: unpriced, inputTokensUpperBound: 10, maxOutputTokens: 10 });
  reported.admitTurn({ reservationId: reportedHold.reservationId, attemptId: ATTEMPT, selection: unpriced, inputTokensUpperBound: 10, maxOutputTokens: 10 }).charge({ inputTokens: 10, outputTokens: 10, reportedCostUsd: 0.25 });
  assert.equal(reported.snapshot().accountedCostUsd, 0.25);
  assert.equal(reported.snapshot().observedCostUsd, 0.25);
  assert.equal(reported.snapshot().committed.costUsd, null, 'a provider-reported amount is not a pinned quote');
});
