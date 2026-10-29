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
import type { DebtSummary } from './debt.js';

export const REMAINING_CODES = ['GOAL_UNSETTLED', 'GOAL_UNPROVEN', 'PRIMITIVE_UNCHAINED', 'CHAIN_READY', 'RESEARCH_DEBT'] as const;
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
  /**
   * P19/E: goals settled `blocked` with their reason. A blocked goal is settled-with-debt, not silently open: it no longer
   * keeps `remaining` or the demand floor alive, but the run still prints the debt it carries.
   */
  settledBlocked: Array<{ id: string; reason: string }>;
}
export interface CompletionInput {
  plans: readonly PlanEntry[]; claims: readonly ChainClaim[]; tasks: readonly AssessmentTask[];
  /** P16.1: the same two sources the plan board reads, so a settled goal cannot be settled here and unproven there. */
  cases?: readonly ProofCase[]; coverage?: readonly ProofCoverage[];
  /** A6.2: host-derived research debt; when present it is remaining work like any other obligation. */
  debt?: DebtSummary;
}

const MESSAGES: Record<RemainingCode, string> = {
  GOAL_UNSETTLED: 'a goal is not reviewed or closed yet; settlement is a plan revision, not a report',
  GOAL_UNPROVEN: 'a goal is reviewed or closed but its proof does not hold; a status is not a demonstration',
  PRIMITIVE_UNCHAINED: 'a confirmed and tested claim has no successor step and no recorded wall',
  CHAIN_READY: 'a chain step is ready to take and has not been dispatched',
  RESEARCH_DEBT: 'research debt the host can name is outstanding; a decision row and prose do not discharge it',
};

const MAX_IDS = 20;

export function deriveCompletion(input: CompletionInput): Completion {
  // Goals are the run's own denominator: an open goal is remaining work even when every other obligation is settled.
  const goals = input.plans.filter(plan => plan.kind === 'goal');
  const settledGoals = goals.filter(plan => plan.status === 'reviewed' || plan.status === 'closed');
  // P19/E: a goal whose proof the run cannot reach is settled `blocked` by a plan revision; it stops being open work here
  // and is reported as settled-with-debt instead (not as a silent disappearance).
  const blockedGoals = goals.filter(plan => plan.status === 'blocked');
  const openGoals = goals.filter(plan => plan.status !== 'reviewed' && plan.status !== 'closed' && plan.status !== 'blocked');
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
  // A6.2: the debt report is the same denominator the finish preflight and the report read, so an empty goal board can no
  // longer be read as "nothing owed" while the host is naming work.
  if (input.debt && input.debt.gateable > 0) push('RESEARCH_DEBT', [...input.debt.ids]);
  const remaining = items.reduce((total, item) => total + item.count, 0);
  const reasons = items.map(item => `${item.code} ${item.count}: ${item.message}`);
  return { state: remaining ? 'incomplete' : 'complete', remaining, items, reasons, unchained,
    settledBlocked: blockedGoals.map(plan => ({ id: plan.id, reason: plan.reason })) };
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
    else if (item.code === 'RESEARCH_DEBT') parts.push(`${item.count} research debt item(s) with no discharge`);
    else if (item.code === 'GOAL_UNPROVEN') parts.push(`${item.count} goal(s) whose proof no longer holds`);
    else if (item.code === 'GOAL_UNSETTLED') parts.push(`${item.count} goal(s) not reviewed or closed`);
  }
  return parts.join('; ') || `${completion.remaining} obligation(s) remain`;
}

/** One line for a result or a prompt: what is still owed, how much of it, and which goal settled with debt (P19/E). */
export function completionLine(completion: Completion): string {
  const blocked = completion.settledBlocked.length
    ? `; settled with debt: ${completion.settledBlocked.map(item => `${item.id} blocked (${item.reason.slice(0, 160)})`).join('; ')}`
    : '';
  return completion.state === 'complete' ? `complete: no goal, primitive or ready step is left open${blocked}`
    : `incomplete: ${completion.remaining} obligation(s) — ${completion.reasons.join('; ')}${blocked}`;
}
