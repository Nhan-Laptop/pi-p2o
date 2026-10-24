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
import { goalProofRefusal, type ProofCase, type ProofCoverage } from './goal-proof.js';
import type { ChainClaim } from './chain-view.js';
import type { PlanEntry } from './planning.js';
import type { AssessmentTask } from './tasks.js';

export const REMAINING_CODES = ['GOAL_UNSETTLED', 'GOAL_UNPROVEN', 'PRIMITIVE_UNCHAINED', 'CHAIN_READY'] as const;
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
export interface CompletionInput {
  plans: readonly PlanEntry[]; claims: readonly ChainClaim[]; tasks: readonly AssessmentTask[];
  /** P16.1: the same two sources the plan board reads, so a settled goal cannot be settled here and unproven there. */
  cases?: readonly ProofCase[]; coverage?: readonly ProofCoverage[];
}

const MESSAGES: Record<RemainingCode, string> = {
  GOAL_UNSETTLED: 'a goal is not reviewed or closed yet; settlement is a plan revision, not a report',
  GOAL_UNPROVEN: 'a goal is reviewed or closed but its proof does not hold; a status is not a demonstration',
  PRIMITIVE_UNCHAINED: 'a confirmed and tested claim has no successor step and no recorded wall',
  CHAIN_READY: 'a chain step is ready to take and has not been dispatched',
};

const MAX_IDS = 20;

export function deriveCompletion(input: CompletionInput): Completion {
  // Goals are the run's own denominator: an open goal is remaining work even when every other obligation is settled.
  const goals = input.plans.filter(plan => plan.kind === 'goal');
  const settledGoals = goals.filter(plan => plan.status === 'reviewed' || plan.status === 'closed');
  const openGoals = goals.filter(plan => plan.status !== 'reviewed' && plan.status !== 'closed');
  // P16.1: a reviewed goal whose proof no longer holds (a disputed case, a re-opened coverage plan) is still owed work.
  const unprovenGoals = settledGoals.filter(plan => plan.proof === undefined
    || goalProofRefusal(plan.proof, { claims: input.claims, cases: input.cases ?? [], coverage: input.coverage ?? [] }) !== undefined);
  const { ready, unchained } = chainObligations({ plans: input.plans, claims: input.claims, tasks: input.tasks });
  const items: RemainingItem[] = [];
  const push = (code: RemainingCode, ids: string[]) => {
    if (ids.length) items.push({ code, count: ids.length, ids: ids.slice(0, MAX_IDS), message: MESSAGES[code] });
  };
  push('GOAL_UNSETTLED', openGoals.map(plan => plan.id));
  push('GOAL_UNPROVEN', unprovenGoals.map(plan => plan.id));
  push('PRIMITIVE_UNCHAINED', unchained.map(primitive => primitive.recordId));
  push('CHAIN_READY', ready.map(step => step.planId));
  const remaining = items.reduce((total, item) => total + item.count, 0);
  const reasons = items.map(item => `${item.code} ${item.count}: ${item.message}`);
  return { state: remaining ? 'incomplete' : 'complete', remaining, items, reasons, unchained };
}

/**
 * P16.2: the named obligation for a demand wake. The engine may not invent work, so the owner builds the sentence from the
 * same completion the finish result prints; a quiet round with work owed carries this text instead of pausing.
 */
export function completionDemand(completion: Completion, plans: readonly PlanEntry[]): string | undefined {
  if (!completion.remaining) return undefined;
  const byId = new Map(plans.map(plan => [plan.id, plan])), parts: string[] = [];
  for (const item of completion.items) {
    if (item.code === 'CHAIN_READY') {
      const steps = item.ids.map(id => byId.get(id)).filter(step => step !== undefined).map(step => step.chainOf ? `step ${step.step} of chain ${step.chainOf}` : `step ${step.step}`);
      parts.push(`${steps.length ? steps.join(', ') : `${item.count} chain step(s)`} ready and undispatched`);
    } else if (item.code === 'PRIMITIVE_UNCHAINED') parts.push(`${item.count} demonstrated primitive(s) with no successor step`);
    else if (item.code === 'GOAL_UNPROVEN') parts.push(`${item.count} goal(s) whose proof no longer holds`);
    else if (item.code === 'GOAL_UNSETTLED') parts.push(`${item.count} goal(s) not reviewed or closed`);
  }
  return parts.join('; ') || `${completion.remaining} obligation(s) remain`;
}

/** One line for a result or a prompt: what is still owed, and how much of it. */
export function completionLine(completion: Completion): string {
  return completion.state === 'complete' ? 'complete: no goal, primitive or ready step is left open'
    : `incomplete: ${completion.remaining} obligation(s) — ${completion.reasons.join('; ')}`;
}
