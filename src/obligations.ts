/**
 * planning_update.md M2 + M4: the frontier is an obligation, not a suggestion.
 *
 * M2 — when a chain step is ready on a surface (every capability it needs is already gained by a demonstrated claim), a new
 * task on that surface either takes that step (cites the provider), or says in the plan why it is not taking it (a deferred
 * or blocked row for the step). Breadth elsewhere stays allowed: the rule is per surface, never global.
 *
 * M4 — every confirmed-and-tested claim is either taken further or walled: a successor chain row that consumes what it gains,
 * a task that stands on it, or a deferred/blocked row naming it. Nothing here refuses a finish (p2o has no finish gate); it is
 * what makes a run incomplete and what the dispatch path cites when a breadth task ignores a live primitive.
 *
 * Both conditions are pure reads over plans, claims and tasks; no new record kind and no stored edge.
 */
import { capabilityKey, capabilityMatches, describeCapability, isTypedCapability, type Capability } from './capabilities.js';
import { claimCapabilities, isDemonstrated } from './claims.js';
import type { ChainClaim } from './chain-view.js';
import { chainBoard, type ChainStep } from './chain-board.js';
import type { PlanEntry } from './planning.js';
import type { AssessmentTask, TaskDraft } from './tasks.js';

/** A demonstrated claim that nothing consumes yet: the depth obligation. */
export interface UnchainedPrimitive {
  claimId: string;
  recordId: string;
  surface?: string;
  /** First typed capability the claim hands out, described for a message; undefined when it declared none. */
  capability?: string;
}
/** A ready chain step, with the need and provider that make it ready. */
export interface ReadyStep {
  chainOf: string;
  step: number;
  planId: string;
  claimRefs: readonly string[];
  surface?: string;
  need: Capability;
  /** The demonstrated claim that already gains `need`; a task that cites it is taking the step. */
  provider: string;
}
export interface ChainObligations {
  ready: ReadyStep[];
  unchained: UnchainedPrimitive[];
}

const settledRow = (plan: PlanEntry): boolean => plan.status === 'deferred' || plan.status === 'blocked';
const liveTask = (task: AssessmentTask): boolean => !['cancelled', 'expired', 'closed'].includes(task.status);
const sameSurface = (left: string | undefined, right: string | undefined): boolean =>
  typeof left === 'string' && typeof right === 'string' && left.trim().toLowerCase() === right.trim().toLowerCase();

/** A plan row that says "this link is not being taken", citing the claim it walls off. */
const walled = (plans: readonly PlanEntry[], recordIds: readonly string[]): boolean =>
  plans.some(plan => settledRow(plan) && (plan.claimRefs ?? []).some(ref => recordIds.includes(ref)));

/** A chain row whose declared need consumes what the claim gains: the successor step, taken or not. */
const successor = (plans: readonly PlanEntry[], gained: readonly Capability[]): boolean =>
  plans.some(plan => plan.kind === 'todo' && (plan.needs ?? []).some(need => gained.some(have => capabilityMatches(need, have))));

const surfaceOf = (claimRefs: readonly string[], claims: ReadonlyMap<string, ChainClaim>): string | undefined => {
  for (const ref of claimRefs) { const surface = claims.get(ref)?.surface; if (surface) return surface; }
  return undefined;
};

export function chainObligations(input: { plans: readonly PlanEntry[]; claims: readonly ChainClaim[]; tasks: readonly AssessmentTask[] }): ChainObligations {
  const byRecord = new Map(input.claims.filter(claim => claim.recordId).map(claim => [claim.recordId!, claim]));
  // A step a live task is already taking is not an outstanding obligation: the debt is that nobody moved, not that the plan says so.
  const taken = (refs: readonly string[]) => input.tasks.some(task => liveTask(task) && refs.some(ref => (task.work?.claimRefs ?? []).includes(ref)));
  const ready: ReadyStep[] = [];
  for (const chain of chainBoard(input.plans, input.claims)) {
    for (const step of chain.steps) {
      if (step.state !== 'ready' || taken([...step.claimRefs, ...Object.values(step.satisfiedBy)])) continue;
      // The first need is the link's subject; a step with no needs is a primitive, not a step waiting on a provider.
      const need = step.needs.find(item => step.satisfiedBy[capabilityKey(item)] !== undefined);
      if (!need) continue;
      ready.push({ chainOf: chain.chainOf, step: step.step, planId: step.planId, claimRefs: step.claimRefs, surface: surfaceOf(step.claimRefs, byRecord),
        need, provider: step.satisfiedBy[capabilityKey(need)]! });
    }
  }
  const unchained: UnchainedPrimitive[] = [];
  for (const claim of input.claims) {
    if (!claim.recordId || !isDemonstrated(claim)) continue;
    const gained = claimCapabilities(claim).gained.filter(isTypedCapability);
    const recordId = claim.recordId;
    if (successor(input.plans, gained)) continue;
    if (walled(input.plans, [recordId])) continue;
    if (input.tasks.some(task => liveTask(task) && (task.work?.claimRefs ?? []).includes(recordId))) continue;
    unchained.push({ claimId: claim.candidate, recordId, ...(claim.surface ? { surface: claim.surface } : {}),
      ...(gained.length ? { capability: describeCapability(gained[0]!) } : {}) });
  }
  return { ready, unchained };
}

/**
 * The create-time refusal, in one place. M2 comes first because it is the more specific obligation (a step is ready now);
 * M4 answers when nothing is ready but a primitive still has no successor.
 */
export function dispatchRefusal(input: { draft: TaskDraft; obligations: ChainObligations; plans: readonly PlanEntry[] }): string | undefined {
  const { draft, obligations, plans } = input;
  const cites = (recordId: string) => (draft.work?.claimRefs ?? []).includes(recordId);
  const step = obligations.ready.find(item => sameSurface(item.surface, draft.surface));
  // Deferring the step itself (or any row citing it or its provider) is the recorded reason M2 asks for.
  if (step) {
    if (!cites(step.provider) && !walled(plans, [...step.claimRefs, step.provider])) {
      return `CHAIN_READY_UNDISPATCHED: step ${step.step} of chain ${step.chainOf} consumes ${describeCapability(step.need)} that claim ${step.provider} already gains; dispatch it, cite it as a parent, or defer it with a reason`;
    }
    return undefined;
  }
  const primitive = obligations.unchained.find(item => sameSurface(item.surface, draft.surface));
  if (primitive && !cites(primitive.recordId)) {
    return `PRIMITIVE_UNCHAINED: claim ${primitive.recordId} (${primitive.capability ?? 'no typed capability'}) is confirmed and tested on ${primitive.surface ?? 'its surface'} and nothing consumes it; take the next step or record which successors were ruled out and why`;
  }
  return undefined;
}
