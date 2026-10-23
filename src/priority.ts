import type { WorkPurpose } from './duties.js';

/**
 * planning_update.md P4: a stated, repeatable derivation for a task's dispatch priority, so triage order is
 * explainable instead of an arbitrary 0-100 the lead picks by feel (E6/E10). This is a *suggestion* only — the lead's
 * explicit `priority` always wins and nothing auto-dispatches by score (the engine admits accepted work in the lead's
 * order; see docs/PLANNER_ENGINE.md). The function is pure so the weights can be table-tested without an engine, and the
 * weights live here and in docs/PLANNER_ENGINE.md in step so the two cannot drift.
 */
export interface PriorityFacts {
  /** A reviewed prerequisite this task pins is not yet satisfied, so dispatching now would only stall. */
  prerequisitesUnmet: boolean;
  /** What the task is for (src/duties.ts). Validation and retest are cheap and tend to close out a pending case. */
  purpose: WorkPurpose;
  /** Some confirmed+tested claim already gains every capability this task's claim needs (P5 chainJoin). */
  requiresSatisfiedByConfirmed: boolean;
  /** The task's target asset already carries an owner-accepted finding, so it is a proven-productive surface. */
  targetAssetHasAcceptedFinding: boolean;
  /** This task's questionKey is already answered by a non-stale coverage cell, so re-asking it is low value. */
  questionCoveredByFreshCell: boolean;
}

/** Neutral starting point: a task with no signal either way sits mid-band. */
export const PRIORITY_BASE = 50;
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 100;

/** Each signal's effect on the suggestion, written here and mirrored in docs/PLANNER_ENGINE.md. */
export const PRIORITY_WEIGHTS = {
  prerequisitesUnmet: -30,
  cheapUnlockingPurpose: 15,
  requiresSatisfiedByConfirmed: 20,
  targetAssetHasAcceptedFinding: 10,
  questionCoveredByFreshCell: -20,
} as const;

/** Purposes that are cheap to run and tend to close out a pending case rather than open a new direction. */
export const UNLOCKING_PURPOSES: ReadonlySet<WorkPurpose> = new Set(['validation', 'retest']);

const clamp = (value: number): number => Math.max(PRIORITY_MIN, Math.min(PRIORITY_MAX, value));

/**
 * A suggested 0-100 priority derived from recorded facts. Pure: same facts in, same number out — no reads, no dispatch.
 */
export function suggestPriority(facts: PriorityFacts): number {
  let score = PRIORITY_BASE;
  if (facts.prerequisitesUnmet) score += PRIORITY_WEIGHTS.prerequisitesUnmet;
  if (UNLOCKING_PURPOSES.has(facts.purpose)) score += PRIORITY_WEIGHTS.cheapUnlockingPurpose;
  if (facts.requiresSatisfiedByConfirmed) score += PRIORITY_WEIGHTS.requiresSatisfiedByConfirmed;
  if (facts.targetAssetHasAcceptedFinding) score += PRIORITY_WEIGHTS.targetAssetHasAcceptedFinding;
  if (facts.questionCoveredByFreshCell) score += PRIORITY_WEIGHTS.questionCoveredByFreshCell;
  return clamp(score);
}
