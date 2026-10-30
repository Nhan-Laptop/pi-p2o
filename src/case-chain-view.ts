/**
 * planning_update.md P22/A3: an accepted case's chain is the one place the run records links that actually ran, and the planner
 * could not see it. The round brief offered the ready frontier but never said "this chain is already rated and this capability
 * is left hanging", so the lead had to rebuild the path from the case board before authoring a successor row.
 *
 * This module projects that rating record read-only into the brief's bounded form. A projection is never a plan row, task or
 * case, is not a readiness input, and nothing it returns can satisfy a claim, case, coverage cell or goal (D-P22-4): only an
 * executed case chain step still establishes an effect. A chain recorded on a case that is not accepted, or a rating recorded
 * against an older revision, is not evidence for the current one and is not projected at all.
 */
import { capabilityKey, capabilityMatches, isTypedCapability, type Capability } from './capabilities.js';
import type { CaseChain } from './case-types.js';
import type { CaseEffect } from './cvss.js';

/** Bounded so the `ready` section stays inside its re-measured cap; the case board still holds every row. */
export const CASE_CHAIN_MAX_CHAINS = 2;
export const CASE_CHAIN_MAX_LINKS = 2;

/** The case fields the projection reads; `CaseView` satisfies it structurally. */
export interface CaseChainSource {
  id: string;
  revision: number;
  /** Host-set: accepted, confirmed, current and not a duplicate; a raw verdict alone is never accepted. */
  acceptedFinding?: boolean;
  /** Host-set: the latest rating was recorded against this case revision. */
  ratingCurrent?: boolean;
  finding?: { chain?: CaseChain };
}

/** What the projection needs from a claim head; `ChainClaim` satisfies it structurally. */
export interface CaseChainClaimRef { candidate: string; recordId?: string }

export interface CaseChainLinkView {
  order: number;
  step: string;
  /** The cited claim's slug when the head still names that record id; otherwise the reference as recorded. */
  claim?: string;
  effect?: CaseEffect;
  gained: readonly Capability[];
  needs: readonly Capability[];
}

export interface CaseChainView {
  caseId: string;
  revision: number;
  objective: string;
  /** Last executed step of the chain as recorded; absent means no step executed (reasoned only). */
  demonstratedThrough?: number;
  /** Steps the chain records in total, executed and reasoned. */
  totalSteps: number;
  /** The last executed links in execution order; earlier executed links are counted, not projected. */
  links: readonly CaseChainLinkView[];
  omittedLinks: number;
  /** Typed capabilities an executed link gained that no later executed link consumes, in first-gained order. */
  leftover: readonly Capability[];
}

export interface CaseChainProjection {
  chains: readonly CaseChainView[];
  /** The true number of eligible chains before the cap, so the brief can say what it omitted. */
  total: number;
}

/** Pre-P14 prose is readable in the case report but joins to nothing, so it is not projected as a link or a leftover. */
const typed = (capabilities: readonly Capability[]): Capability[] => capabilities.filter(isTypedCapability);

function project(view: CaseChainSource, slugs: ReadonlyMap<string, string>): CaseChainView | undefined {
  const chain = view.finding?.chain;
  if (!chain) return undefined;
  const executed = chain.steps.slice(0, chain.demonstratedThrough ?? 0);
  const shown = executed.slice(Math.max(0, executed.length - CASE_CHAIN_MAX_LINKS));
  const links: CaseChainLinkView[] = shown.map(step => {
    const claim = step.claimRef ? slugs.get(step.claimRef) ?? step.claimRef : undefined;
    return { order: step.order, step: step.step, ...(claim ? { claim } : {}), ...(step.effect ? { effect: step.effect } : {}),
      gained: typed(step.gained), needs: typed(step.needs) };
  });
  // "Left hanging" is a join, not a guess: a gained capability is consumed only by a capability match on a later executed
  // link. Legacy text never matches, and a reasoned link beyond the demonstrated depth consumes nothing.
  const seen = new Set<string>(), leftover: Capability[] = [];
  for (let index = 0; index < executed.length; index++) {
    const later = executed.slice(index + 1);
    for (const gained of typed(executed[index]!.gained)) {
      if (later.some(step => step.needs.some(need => capabilityMatches(need, gained)))) continue;
      const key = capabilityKey(gained);
      if (seen.has(key)) continue;
      seen.add(key); leftover.push(gained);
    }
  }
  return { caseId: view.id, revision: view.revision, objective: chain.objective, totalSteps: chain.steps.length,
    ...(chain.demonstratedThrough !== undefined ? { demonstratedThrough: chain.demonstratedThrough } : {}),
    links, omittedLinks: executed.length - links.length, leftover };
}

/**
 * Project the accepted chains the round should see, most actionable first: a chain that leaves a typed capability hanging is
 * the one that names a successor row, so it outranks a chain whose links are all consumed; a deeper executed path breaks the
 * tie, then the case id, so two runs holding the same ledger render the same brief.
 */
export function projectCaseChains(input: { cases: readonly CaseChainSource[]; claims?: readonly CaseChainClaimRef[] }): CaseChainProjection {
  const slugs = new Map((input.claims ?? []).flatMap(claim => claim.recordId ? [[claim.recordId, claim.candidate] as const] : []));
  const seen = new Set<string>(), chains: CaseChainView[] = [];
  for (const view of input.cases) {
    if (seen.has(view.id) || view.acceptedFinding !== true || view.ratingCurrent !== true) continue;
    const chain = project(view, slugs);
    if (!chain) continue;
    seen.add(view.id); chains.push(chain);
  }
  chains.sort((left, right) => right.leftover.length - left.leftover.length
    || (right.links.length + right.omittedLinks) - (left.links.length + left.omittedLinks) || left.caseId.localeCompare(right.caseId));
  return { chains: chains.slice(0, CASE_CHAIN_MAX_CHAINS), total: chains.length };
}
