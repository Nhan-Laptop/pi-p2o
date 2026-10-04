import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ModelSpendBudget } from '../../src/policy/index.js';
import { DurableStore, STORE_SCHEMA_VERSION, migrations } from '../../src/store/index.js';
import { runFixture, taskFixture } from '../contracts/fixtures.js';
import { ATTEMPT, RUN, SELECTION, code, usage } from './support.js';

const CLOCK = '2026-10-02T10:00:00.000Z';
const usd = (micros: number) => micros / 1_000_000;
const limits = { maxTokens: 1000, maxCostUsd: 0.5 };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'p2o-model-spend-'));
  const path = join(dir, 'run.sqlite');
  const store = new DurableStore({ path, clock: () => CLOCK });
  const run = runFixture();
  run.budgets.maxTokens = limits.maxTokens;
  run.budgets.maxCostUsd = limits.maxCostUsd;
  store.createRun(run);
  const task = taskFixture('task-1', join(dir, 'work', 'task-1'));
  task.budgets.maxTokens = limits.maxTokens;
  task.budgets.maxCostUsd = limits.maxCostUsd;
  store.createTask(task);
  store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-1', attemptId: ATTEMPT, leaseMs: 60_000 });
  return { dir, path, store };
}

test('restart restores totals, preserves unknown in-flight reservations and replays settlements once', () => {
  const { dir, path, store } = setup();
  const first = new ModelSpendBudget(limits, { runId: RUN, freshRun: true, journal: store.modelSpendJournal(RUN) });
  first.bindRun(RUN, limits);
  const settled = first.reserve({ attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 100, maxOutputTokens: 100 });
  settled.settle(usage(80, 20));
  const holding = first.reserve({ attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 400, maxOutputTokens: 100 });
  store.close();

  const raw = new DatabaseSync(path);
  const stored = JSON.parse(String((raw.prepare('SELECT json FROM model_spend_journal WHERE run_id = ?').get(RUN) as { json: string }).json));
  raw.close();
  assert.equal(stored.runId, RUN);
  assert.equal(Object.keys(stored.reservations).length, 1);

  const resumed = new DurableStore({ path, clock: () => CLOCK });
  try {
    assert.equal(resumed.schemaVersion, STORE_SCHEMA_VERSION);
    const ledger = new ModelSpendBudget(limits, { runId: RUN, journal: resumed.modelSpendJournal(RUN) });
    ledger.bindRun(RUN, limits);
    assert.deepEqual(ledger.snapshot().committed, { tokens: 100, costUsd: usd(80 * 3 + 20 * 15) });
    assert.deepEqual(ledger.snapshot().active, { count: 1, tokens: 500, costUsd: usd(400 * 3 + 100 * 15) });
    const active = ledger.activeReservations();
    assert.equal(active.length, 1);
    assert.equal(active[0]!.reservationId, holding.reservationId);
    assert.equal(ledger.snapshot().remaining.tokens, 400, 'the unknown in-flight reservation still holds its worst case');
    assert.throws(() => ledger.reserve({ attemptId: ATTEMPT, selection: SELECTION, inputTokensUpperBound: 401, maxOutputTokens: 0 }), code('BUDGET_EXCEEDED'));

    const receipt = { reservationId: holding.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(300, 50) };
    const after = ledger.settle(receipt);
    assert.equal(after.duplicate, false);
    assert.deepEqual(ledger.snapshot().committed, { tokens: 450, costUsd: usd(80 * 3 + 20 * 15 + 300 * 3 + 50 * 15) });
    const replay = ledger.settle(receipt);
    assert.equal(replay.duplicate, true);
    assert.deepEqual(ledger.snapshot().committed, { tokens: 450, costUsd: usd(80 * 3 + 20 * 15 + 300 * 3 + 50 * 15) });
  } finally { resumed.close(); }

  const third = new DurableStore({ path, clock: () => CLOCK });
  try {
    const ledger = new ModelSpendBudget(limits, { runId: RUN, journal: third.modelSpendJournal(RUN) });
    assert.deepEqual(ledger.snapshot().committed, { tokens: 450, costUsd: usd(80 * 3 + 20 * 15 + 300 * 3 + 50 * 15) });
    assert.deepEqual(ledger.snapshot().active, { count: 0, tokens: 0, costUsd: 0 });
    assert.equal(ledger.snapshot().settlements, 2);
    const replayAfterRestart = ledger.settle({ reservationId: holding.reservationId, attemptId: ATTEMPT, selection: SELECTION, usage: usage(300, 50) });
    assert.equal(replayAfterRestart.duplicate, true);
    assert.deepEqual(ledger.snapshot().committed, { tokens: 450, costUsd: usd(80 * 3 + 20 * 15 + 300 * 3 + 50 * 15) });
    assert.equal(ledger.snapshot().settlements, 2);
  } finally { third.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('refuses reset, foreign runs and attempts that do not belong to the ledger run', () => {
  const { dir, path, store } = setup();
  try {
    const ledger = new ModelSpendBudget(limits, { runId: RUN, freshRun: true, journal: store.modelSpendJournal(RUN) });
    assert.throws(() => new ModelSpendBudget(limits, { runId: RUN, freshRun: true, journal: store.modelSpendJournal(RUN) }), code('UNAVAILABLE'));
    ledger.bindRun(RUN, limits);
    assert.throws(() => ledger.bindRun('other-run', limits), code('IDENTITY_DENIED'));
    assert.equal(store.modelSpendJournal(RUN).ownsAttempt!(RUN, ATTEMPT), true);
    assert.equal(store.modelSpendJournal(RUN).ownsAttempt!(RUN, 'attempt-2'), false);

    const otherRun = runFixture();
    otherRun.runId = 'run-2';
    otherRun.budgets.maxTokens = limits.maxTokens;
    otherRun.budgets.maxCostUsd = limits.maxCostUsd;
    store.createRun(otherRun);
    const otherTask = taskFixture('task-2', join(dir, 'work', 'task-2'));
    otherTask.runId = 'run-2';
    otherTask.budgets.maxTokens = limits.maxTokens;
    otherTask.budgets.maxCostUsd = limits.maxCostUsd;
    store.createTask(otherTask);
    store.beginAttempt({ taskId: 'task-2', ownerId: 'worker-2', attemptId: 'attempt-2', leaseMs: 60_000 });

    assert.throws(() => ledger.reserve({ attemptId: 'attempt-2', selection: SELECTION, inputTokensUpperBound: 1, maxOutputTokens: 1 }), code('IDENTITY_DENIED'));
    const forged = { ...ledger.exportState(), reservations: { forged: { attemptId: 'attempt-2', selection: SELECTION, reservedTokens: 1, reservedCostMicros: 3, createdAt: 1, admittedTurns: 0, observedCharges: 0, openTurns: 0, openTokens: 0, openCostMicros: 0 } } };
    assert.throws(() => store.modelSpendJournal(RUN).save(forged), /outside this run/);
  } finally { store.close(); rmSync(path, { force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('migration 3 creates the durable model spend journal and upgrades a version-2 store', () => {
  // Migration 3 still owns the model spend journal; later schema versions (the autonomous phase journals) must
  // upgrade the same legacy store, so this pins the current version instead of a frozen historical one.
  assert.equal(STORE_SCHEMA_VERSION, 4);
  const dir = mkdtempSync(join(tmpdir(), 'p2o-model-spend-legacy-'));
  const path = join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(migrations[0].sql);
  legacy.exec(migrations[1].sql);
  legacy.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(1, migrations[0].name, CLOCK);
  legacy.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(2, migrations[1].name, CLOCK);
  legacy.exec('PRAGMA user_version = 2');
  legacy.close();
  const upgraded = new DurableStore({ path, clock: () => CLOCK });
  try {
    assert.equal(upgraded.schemaVersion, STORE_SCHEMA_VERSION);
    const raw = new DatabaseSync(path);
    assert.equal(Number((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), STORE_SCHEMA_VERSION);
    assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_spend_journal'").get());
    raw.close();
  } finally { upgraded.close(); rmSync(dir, { recursive: true, force: true }); }
});
