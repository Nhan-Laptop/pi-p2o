import type { LedgerIndex } from './records.js';
import { PLANNER_TOOLS, REPORTER_TOOLS, VALIDATION_TOOLS, WORKER_TOOLS } from './tool-policy.js';

/**
 * planning_update.md A4 — the authority facts a reader needs to see which policy produced a run. Everything here is derived
 * from committed records plus the static role matrices: no model, no target, no new gate or wake. `plannerTargetOps` and
 * `ownerClaims` are the two measured invariants (they must be 0 after P0/A1/P1); a legacy run keeps its honest >0.
 */
export interface AuthorityCounters {
  /** Target operations authored by the planner/owner (evidence receipts with no worker attribution). Must be 0 post-A1. */
  plannerTargetOps: number;
  /** Target operations authored by a delegated worker. */
  workerTargetOps: number;
  /** Distinct task ids created (every status counts; cancellation does not un-create). */
  tasksCreated: number;
  /** Distinct task ids that ever reached `running` (a worker launch was registered for them). */
  tasksDispatched: number;
  /** Earliest `running` record; the measured "first dispatch before first target operation" reads against this. */
  firstDispatchAt?: string;
  /** Candidate claims authored without a worker attribution. Must be 0 post-A2. */
  ownerClaims: number;
  /** Candidate claims authored by a delegated worker (the only legal claim author). */
  workerClaims: number;
  /** Distinct tasks whose stored role is `validation`. */
  validationTasks: number;
  /** Recorded `planner.stalled` lifecycle facts (A4): zero-intent rounds that ended with an open goal. */
  stalledRounds: number;
  /** A6.3: recorded heartbeats that actually woke the planner (a timer that fired while busy is not a wake). */
  heartbeatWakes: number;
  /** A6.3: recorded debt continuations — the wake that continues a campaign because work is owed. */
  debtWakes: number;
  /** A6.6: final finishes that recorded a `campaign.partial` reason instead of a completion. */
  campaignPartial: number;
  /** P1: recorded `campaign.resumed` lifecycle facts — human `/p2o resume` interventions, counted so a report can self-evidence them. */
  campaignResumes: number;
  /** P1: recorded `planner.stall-escalation` lifecycle facts — the pause decisions that asked for a human, not every stalled round. */
  stallEscalations: number;
  /** P18.3/D47: recorded `planner.round-start` facts — the rounds the engine admitted, which is the report's round count. */
  roundsStarted: number;
  /** P18.3/D47: rounds a wrap-up directive reached (`planner.round-budget` with state `wrap`), once per round. */
  roundsWrapped: number;
  /** P18.3/D47: rounds that ended at their hard bound (`planner.round-budget` with state `exhausted`). */
  roundBudgetStops: number;
  /** P18.3/D47: recorded `planner.round-end` facts; the reason travels in the row (round-budget, operator-stop). */
  roundsEnded: number;
  /** P18.6/D50: rounds whose loadout the host routed and applied (`planner.round-model`). */
  roundsRouted: number;
  /** P18.6/D50: the distinct model ids those rounds ran, sorted; the rows keep the per-round detail. */
  roundModels: string[];
}
export interface RoleCounts { planner: number; worker: number; validation: number; reporter: number }
export interface AuthorityMode { loopMode?: string; executorMode?: string }
export interface AuthorityReport extends AuthorityCounters { mode?: AuthorityMode; roles: RoleCounts }

export const ROLE_COUNTS: Readonly<RoleCounts> = {
  planner: PLANNER_TOOLS.length, worker: WORKER_TOOLS.length, validation: VALIDATION_TOOLS.length, reporter: REPORTER_TOOLS.length,
};

interface TaskRow { id: string; role?: string; dispatchedAt?: string }
function taskRows(index: LedgerIndex): Map<string, TaskRow> {
  const rows = new Map<string, TaskRow>();
  for (const record of index.records) {
    if (record.kind !== 'task') continue;
    const task = record.data?.task as { id?: unknown; role?: unknown; status?: unknown } | undefined;
    if (!task || typeof task.id !== 'string') continue;
    const row = rows.get(task.id) ?? { id: task.id };
    if (typeof task.role === 'string' && row.role === undefined) row.role = task.role;
    // A dispatch is the record that first moved the task to running; the earliest such record is the first dispatch.
    if (task.status === 'running' && (row.dispatchedAt === undefined || record.at < row.dispatchedAt)) row.dispatchedAt = record.at;
    rows.set(task.id, row);
  }
  return rows;
}

/** A6.3: the lifecycle facts an engine wake writes, so wakes are durable and countable instead of inferred. */
const wakeRows = (index: LedgerIndex) => index.records.filter(record => record.kind === 'lifecycle'
  && (record.data?.engine as { event?: unknown } | undefined)?.event === 'planner.wake');
/** P18.3/D51: one round's lifecycle facts, read through the same `data.engine.event` envelope as wakes and stalls. */
const roundRows = (index: LedgerIndex, event: string) => index.records.filter(record => record.kind === 'lifecycle'
  && (record.data?.engine as { event?: unknown } | undefined)?.event === event);
export function authorityCounters(index: LedgerIndex): AuthorityCounters {
  const tasks = [...taskRows(index).values()];
  const dispatched = tasks.flatMap(row => row.dispatchedAt === undefined ? [] : [row.dispatchedAt]);
  const evidence = index.records.filter(record => record.kind === 'evidence');
  const claims = index.records.filter(record => record.kind === 'candidate');
  const wakes = wakeRows(index).map(record => String((record.data?.engine as { reason?: unknown }).reason ?? 'event'));
  return {
    plannerTargetOps: evidence.filter(record => !record.workerId).length,
    workerTargetOps: evidence.filter(record => Boolean(record.workerId)).length,
    tasksCreated: tasks.length,
    tasksDispatched: dispatched.length,
    ...(dispatched.length ? { firstDispatchAt: dispatched.sort()[0] } : {}),
    ownerClaims: claims.filter(record => !record.workerId).length,
    workerClaims: claims.filter(record => Boolean(record.workerId)).length,
    validationTasks: tasks.filter(row => row.role === 'validation').length,
    stalledRounds: index.records.filter(record => record.kind === 'lifecycle'
      && (record.data?.engine as { event?: unknown } | undefined)?.event === 'planner.stalled').length,
    heartbeatWakes: wakes.filter(reason => reason === 'heartbeat').length,
    debtWakes: wakes.filter(reason => reason === 'debt').length,
    roundsStarted: roundRows(index, 'planner.round-start').length,
    roundsWrapped: roundRows(index, 'planner.round-budget').filter(record => (record.data?.engine as { state?: unknown }).state === 'wrap').length,
    roundBudgetStops: roundRows(index, 'planner.round-budget').filter(record => (record.data?.engine as { state?: unknown }).state === 'exhausted').length,
    roundsEnded: roundRows(index, 'planner.round-end').length,
    roundsRouted: roundRows(index, 'planner.round-model').length,
    roundModels: [...new Set(roundRows(index, 'planner.round-model').flatMap(record => {
      const model = (record.data?.engine as { model?: unknown }).model;
      return typeof model === 'string' && model ? [model] : [];
    }))].sort(),
    campaignPartial: index.records.filter(record => record.kind === 'lifecycle'
      && (record.data as { event?: unknown } | undefined)?.event === 'campaign.partial').length,
    campaignResumes: index.records.filter(record => record.kind === 'lifecycle'
      && (record.data as { event?: unknown } | undefined)?.event === 'campaign.resumed').length,
    stallEscalations: index.records.filter(record => record.kind === 'lifecycle'
      && (record.data?.engine as { event?: unknown } | undefined)?.event === 'planner.stall-escalation').length,
  };
}

/** A6.6: campaign rounds recorded as wakes; the engine snapshot is preferred when the owner is live. */
export const wakeRoundCount = (index: LedgerIndex): number => wakeRows(index).length;
/** Ledger counters + the static role matrix (+ the run mode when the caller has it) — one object for report and status. */
export function authorityReport(index: LedgerIndex, mode?: AuthorityMode): AuthorityReport {
  return { ...authorityCounters(index), roles: ROLE_COUNTS, ...(mode ? { mode } : {}) };
}
