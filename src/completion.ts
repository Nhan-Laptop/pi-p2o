/**
 * planning_update.md M3: completion is derived, never called.
 *
 * A run is `complete` when there is nothing left that a reviewer could still act on: every goal is reviewed or closed, no
 * demonstrated primitive is unchained (M4), and no chain step is ready (M1/M2). Exporting a report is not termination and
 * stopping is not completion — both are facts a human can read, not verdicts this module decides.
 *
 * The three states M3 names (`complete`, `blocked/human-needed`, `stopped`) are `state` plus the ending the run recorded;
 * `blocked/human-needed` arrives with M6 (escalation), so today a run is either `complete` or `incomplete` while it is open.
 */
import { chainObligations, type UnchainedPrimitive } from './obligations.js';
import type { ChainClaim } from './chain-view.js';
import type { PlanEntry } from './planning.js';
import type { AssessmentTask } from './tasks.js';

export const REMAINING_CODES = ['GOAL_UNSETTLED', 'PRIMITIVE_UNCHAINED', 'CHAIN_READY'] as const;
export type RemainingCode = typeof REMAINING_CODES[number];
export interface RemainingItem { code: RemainingCode; count: number; ids: string[]; message: string }
export interface Completion {
  state: 'complete' | 'incomplete';
  /** One number for the report and the finish result: every open goal, unconsumed primitive and ready chain step. */
  remaining: number;
  items: RemainingItem[];
  /** Named for a reader who asks "why is this incomplete" without re-deriving it. */
  reasons: string[];
  unchained: UnchainedPrimitive[];
}
export interface CompletionInput { plans: readonly PlanEntry[]; claims: readonly ChainClaim[]; tasks: readonly AssessmentTask[] }

const MESSAGES: Record<RemainingCode, string> = {
  GOAL_UNSETTLED: 'a goal is not reviewed or closed yet; settlement is a plan revision, not a report',
  PRIMITIVE_UNCHAINED: 'a confirmed and tested claim has no successor step and no recorded wall',
  CHAIN_READY: 'a chain step is ready to take and has not been dispatched',
};

const MAX_IDS = 20;

export function deriveCompletion(input: CompletionInput): Completion {
  // Goals are the run's own denominator: an open goal is remaining work even when every other obligation is settled.
  const openGoals = input.plans.filter(plan => plan.kind === 'goal' && plan.status !== 'reviewed' && plan.status !== 'closed');
  const { ready, unchained } = chainObligations({ plans: input.plans, claims: input.claims, tasks: input.tasks });
  const items: RemainingItem[] = [];
  const push = (code: RemainingCode, ids: string[]) => {
    if (ids.length) items.push({ code, count: ids.length, ids: ids.slice(0, MAX_IDS), message: MESSAGES[code] });
  };
  push('GOAL_UNSETTLED', openGoals.map(plan => plan.id));
  push('PRIMITIVE_UNCHAINED', unchained.map(primitive => primitive.recordId));
  push('CHAIN_READY', ready.map(step => step.planId));
  const remaining = items.reduce((total, item) => total + item.count, 0);
  const reasons = items.map(item => `${item.code} ${item.count}: ${item.message}`);
  return { state: remaining ? 'incomplete' : 'complete', remaining, items, reasons, unchained };
}

/** One line for a result or a prompt: what is still owed, and how much of it. */
export function completionLine(completion: Completion): string {
  return completion.state === 'complete' ? 'complete: no goal, primitive or ready step is left open'
    : `incomplete: ${completion.remaining} obligation(s) — ${completion.reasons.join('; ')}`;
}
