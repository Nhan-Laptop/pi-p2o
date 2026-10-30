/**
 * P22/A2: the chain context a chain successor's brief carries.
 *
 * A17.3's exploit block answered "which primitive do I stand on"; it did not say which link of which chain this attempt is,
 * what the earlier links already demonstrated, or what the next link consumes, so a worker had to rebuild the path from the
 * graph slice. This derives that context from the plan board and the claim heads — the same `chainBoard` readiness the planner
 * reads — and stores nothing: readiness and position stay derived on read.
 *
 * The task identifies its step three ways, strongest first: a plan row that lists the task (`taskIds`), the ready steps whose
 * providers the task's `claimRefs` cite, and finally the step whose claim the task cites. An ambiguous identity returns
 * nothing rather than naming the wrong chain: a brief that guesses the path is worse than one that reports the gap.
 */
import { chainBoard, type ChainStep, type ChainStepState } from './chain-board.js';
import { describeCapability, capabilityKey, type Capability } from './capabilities.js';
import type { ChainClaim } from './chain-view.js';
import type { PlanEntry } from './planning.js';

export interface ChainBriefFacts {
  chainOf: string;
  step: number;
  total: number;
  state: ChainStepState;
  /** The visible path window, ordered, `|`-separated; the attempt's own step is marked and an omitted end is an ellipsis. */
  path: string;
  /** The nearest recorded step after this one and what it consumes: what this attempt's output has to feed. */
  nextLink?: string;
}

const CHAIN_ID_TEXT = 40;
const TITLE_TEXT = 28;
const PATH_TEXT = 180;
const NEXT_TITLE_TEXT = 40;

const oneLine = (text: string, max: number): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
};

/** One identity, never a wrong one: a single chain's step, or nothing when the evidence spans several. */
const single = (matches: readonly ChainStep[], prefer: 'low' | 'high'): ChainStep | undefined => {
  if (!matches.length) return undefined;
  const chains = new Set(matches.map(step => step.chainOf));
  if (chains.size !== 1) return undefined;
  const sorted = [...matches].sort((left, right) => left.step - right.step);
  return prefer === 'low' ? sorted[0] : sorted[sorted.length - 1];
};

export function chainBriefFor(input: {
  plans: readonly PlanEntry[];
  claims: readonly ChainClaim[];
  task: { id?: string; work?: { claimRefs?: readonly string[]; needs?: readonly Capability[] } };
}): ChainBriefFacts | undefined {
  const board = chainBoard(input.plans, input.claims);
  if (!board.length) return undefined;
  const cited = new Set(input.task.work?.claimRefs ?? []);
  const taskId = input.task.id;
  const planById = new Map(input.plans.map(plan => [plan.id, plan]));
  const steps = board.flatMap(chain => chain.steps);
  // 1. The plan row that lists this task: the lead linked the step explicitly.
  const linked = steps.filter(step => taskId !== undefined && (planById.get(step.planId)?.taskIds ?? []).includes(taskId));
  // 2. A ready step whose providers this task cites: the task is taking that step, whether or not the row lists it.
  const taking = steps.filter(step => step.state === 'ready' && step.needs.length > 0
    && step.needs.every(need => { const provider = step.satisfiedBy[capabilityKey(need)]; return provider !== undefined && cited.has(provider); }));
  // 3. The step whose claim the task stands on: the last link whose claim is cited, so the next link is what it feeds.
  const standing = steps.filter(step => step.claimRefs.some(ref => cited.has(ref)));
  // A task that cites providers for two ready links is taking the lowest one: a chain advances one link at a time.
  const step = single(linked, 'high') ?? single(taking, 'low') ?? single(standing, 'high');
  if (!step) return undefined;
  const chainSteps = board.find(chain => chain.chainOf === step.chainOf)?.steps ?? [step];
  const position = chainSteps.findIndex(item => item.step === step.step);
  // One link either side of the attempt: enough to name the output it stands on and the consumer it feeds, never the whole chain.
  const window = chainSteps.slice(Math.max(0, position - 1), Math.min(chainSteps.length, position + 2));
  const entries = window.map(item => `${item.step}. ${oneLine(item.title, TITLE_TEXT)} (${item.step === step.step ? 'this attempt' : item.state})`);
  const omitted = [window[0]?.step !== chainSteps[0]?.step ? '…' : '', ...entries, window.at(-1)?.step !== chainSteps.at(-1)?.step ? '…' : ''].filter(Boolean);
  const path = entries.length ? (omitted.join(' | ').length <= PATH_TEXT ? omitted.join(' | ') : `${omitted.join(' | ').slice(0, PATH_TEXT - 1).trimEnd()}…`) : 'not recorded';
  const next = chainSteps.find(item => item.step > step.step);
  const nextLink = next && `${next.step}. ${oneLine(next.title, NEXT_TITLE_TEXT)} consumes ${next.needs.length ? next.needs.map(describeCapability).join(', ') : 'no declared need'}`;
  return { chainOf: oneLine(step.chainOf, CHAIN_ID_TEXT), step: step.step, total: step.total, state: step.state, path, ...(nextLink ? { nextLink } : {}) };
}
