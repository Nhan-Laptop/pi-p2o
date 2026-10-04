import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { PolicyError, type ModelSpendJournal, type ModelSpendSelection, type ModelSpendState } from '../../src/policy/index.js';
import { DurableStore } from '../../src/store/index.js';
import { runFixture, taskFixture } from '../contracts/fixtures.js';

export const RUN = 'run-1';
export const ATTEMPT = 'fixture-attempt';
export const NOW_MS = Date.parse('2026-10-02T12:00:00.000Z');
/** Store clock: inside the run's authorization window and both fixture deadlines (09:00–12:00). */
export const STORE_CLOCK = '2026-10-02T10:00:00.000Z';
export const SELECTION: ModelSpendSelection = Object.freeze({ provider: 'fixture-provider', model: 'fixture-model', thinking: 'max' });
export const LIMITS = Object.freeze({ maxTokens: 10_000, maxCostUsd: 1 });

/** Offline, in-memory stand-in for DurableStore.modelSpendJournal; optional attempt ownership map. */
export function memoryJournal(options: { attempts?: ReadonlyMap<string, string>; faultAfter?: number } = {}) {
  let saved: ModelSpendState | undefined;
  let saves = 0;
  const journal: ModelSpendJournal = {
    load: () => (saved === undefined ? undefined : structuredClone(saved)),
    save: (state) => {
      if (options.faultAfter !== undefined && ++saves > options.faultAfter) throw new Error('fixture journal unavailable');
      saved = structuredClone(state) as ModelSpendState;
    },
    ...(options.attempts ? { ownsAttempt: (runId: string, attemptId: string) => options.attempts!.get(attemptId) === runId } : {}),
  };
  return Object.freeze({ journal, state: () => saved, saves: () => saves });
}

/**
 * [T12] Wrap a journal so selected saves fail. The wrapper keeps the *real* durability path underneath (the
 * state still round-trips through SQLite when it is allowed through); it only injects the transient /
 * persistent write failure the ledger must survive without poisoning itself.
 */
export function faultyJournal(journal: ModelSpendJournal, shouldFail: (state: Readonly<ModelSpendState>) => boolean): ModelSpendJournal {
  return {
    load: (runId: string) => journal.load(runId),
    save: (state: Readonly<ModelSpendState>) => {
      if (shouldFail(state)) throw new Error('injected model spend journal fault');
      journal.save(state);
    },
    ...(journal.ownsAttempt ? { ownsAttempt: (runId: string, attemptId: string) => journal.ownsAttempt!(runId, attemptId) } : {}),
  };
}

export interface RealJournalFixture {
  readonly dir: string;
  readonly path: string;
  readonly store: DurableStore;
  readonly journal: ModelSpendJournal;
  /** The journal's JSON column exactly as SQLite holds it, read over a second, independent connection. */
  rawJson(): string | undefined;
  /** The same column parsed, i.e. the durable state the store would restore. */
  readBack(): ModelSpendState | undefined;
  /** Close the store and open the same database file again: a new process-equivalent connection/journal. */
  reopen(): { store: DurableStore; journal: ModelSpendJournal };
  close(): void;
  cleanup(): void;
}

/**
 * [T12] Real `DurableStore.modelSpendJournal(runId)` over a temporary SQLite file, with real run/task/attempt
 * records so the store's own validation runs. R5 §4 showed every deferral/clear/release path only worked
 * against the `structuredClone` stand-in above; these tests exercise the production journal end to end and
 * read the result back over a second connection instead of trusting the ledger's in-memory view.
 */
export function realJournal(options: { limits?: { maxTokens: number; maxCostUsd: number }; runId?: string; attemptId?: string } = {}): RealJournalFixture {
  const runId = options.runId ?? RUN;
  const attemptId = options.attemptId ?? ATTEMPT;
  const limits = options.limits ?? LIMITS;
  const dir = mkdtempSync(join(tmpdir(), 'p2o-budget-real-journal-'));
  const path = join(dir, 'run.sqlite');
  let store = new DurableStore({ path, clock: () => STORE_CLOCK });
  const run = runFixture();
  run.runId = runId;
  run.budgets.maxTokens = limits.maxTokens;
  run.budgets.maxCostUsd = limits.maxCostUsd;
  store.createRun(run);
  const task = taskFixture('task-1', join(dir, 'work', 'task-1'));
  task.runId = runId;
  task.budgets.maxTokens = limits.maxTokens;
  task.budgets.maxCostUsd = limits.maxCostUsd;
  store.createTask(task);
  store.beginAttempt({ taskId: 'task-1', ownerId: 'worker-1', attemptId, leaseMs: 60_000 });
  const column = (): string | undefined => {
    const raw = new DatabaseSync(path);
    try {
      const row = raw.prepare('SELECT json FROM model_spend_journal WHERE run_id = ?').get(runId) as { json: string } | undefined;
      return row?.json;
    } finally { raw.close(); }
  };
  return Object.freeze({
    dir,
    path,
    get store(): DurableStore { return store; },
    get journal(): ModelSpendJournal { return store.modelSpendJournal(runId); },
    rawJson: column,
    readBack: () => {
      const json = column();
      return json === undefined ? undefined : JSON.parse(json) as ModelSpendState;
    },
    reopen: () => {
      store.close();
      store = new DurableStore({ path, clock: () => STORE_CLOCK });
      return Object.freeze({ store, journal: store.modelSpendJournal(runId) });
    },
    close: () => { store.close(); },
    cleanup: () => { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); },
  });
}

export const code = (expected: string) => (error: unknown) => error instanceof PolicyError && error.code === expected;
export const budgetRequest = (attemptId = ATTEMPT, inputTokensUpperBound = 100, maxOutputTokens = 100) =>
  ({ attemptId, selection: SELECTION, inputTokensUpperBound, maxOutputTokens });
export const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });
