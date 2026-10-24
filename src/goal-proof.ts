/**
 * planning_update.md P16.1: a goal is a promise about the target, and only a demonstration can settle it.
 *
 * M3 made completion derived; this module makes "settled by status" insufficient. A goal names one of three proofs — a typed
 * capability (the run gained it), an accepted case, or a coverage plan whose cells are all terminal — and the same resolver
 * runs when the goal is revised and when completion is derived, so the plan board and the final state cannot disagree.
 */
import { capabilityMatches, describeCapability, type Capability } from './capabilities.js';
import { claimCapabilities, isDemonstrated } from './claims.js';
import { caseViews } from './cases.js';
import { coverageCells, coveragePlans } from './coverage.js';
import { claimHeadClaims } from './chain-view.js';
import type { LedgerIndex } from './records.js';

export type GoalProof =
  | { kind: 'capability'; capability: Capability }
  | { kind: 'case'; ref: string }
  | { kind: 'coverage'; ref: string };

export interface ProofClaim { closure?: unknown; execution?: unknown; gained?: unknown }
export interface ProofCase { id: string; verdict: string; reviewStatus: string; currentness?: string }
export interface ProofCoverage { planId: string; cells: readonly { id: string; execution: string; retired?: boolean }[] }
export interface ProofData { claims: readonly ProofClaim[]; cases: readonly ProofCase[]; coverage: readonly ProofCoverage[] }

/** A mapping goal may be settled by a plan that examined every cell; a reachability goal may not. */
const TERMINAL_EXECUTION = new Set(['tested', 'blocked', 'not_applicable']);

export function proofLabel(proof: GoalProof): string {
  return proof.kind === 'capability' ? describeCapability(proof.capability) : `${proof.kind} ${proof.ref}`;
}

/** Undefined when the proof holds; otherwise the sentence the plan revision and the report both print. */
export function goalProofRefusal(proof: GoalProof, data: ProofData): string | undefined {
  if (proof.kind === 'capability') {
    const satisfied = data.claims.some(claim => isDemonstrated(claim) && claimCapabilities(claim).gained.some(gained => capabilityMatches(gained, proof.capability)));
    return satisfied ? undefined
      : `GOAL_UNPROVEN: no confirmed and tested claim gains ${describeCapability(proof.capability)}; a goal is settled by a demonstrated primitive, not by notes`;
  }
  if (proof.kind === 'case') {
    const found = data.cases.find(view => view.id === proof.ref);
    if (!found) return `GOAL_UNPROVEN: case ${proof.ref} is not a same-run case`;
    if (found.reviewStatus !== 'accepted' || found.verdict !== 'confirmed') return `GOAL_UNPROVEN: case ${proof.ref} is ${found.reviewStatus}/${found.verdict}; only an accepted, confirmed case settles a goal`;
    if (found.currentness !== undefined && found.currentness !== 'current') return `GOAL_UNPROVEN: case ${proof.ref} is ${found.currentness}; revise or re-accept it first`;
    return undefined;
  }
  const plan = data.coverage.find(view => view.planId === proof.ref);
  if (!plan) return `GOAL_UNPROVEN: coverage plan ${proof.ref} is not a same-run plan`;
  const open = plan.cells.filter(cell => !cell.retired && !TERMINAL_EXECUTION.has(cell.execution));
  return open.length ? `GOAL_UNPROVEN: coverage plan ${proof.ref} still has ${open.length} cell(s) not tested, blocked or not-applicable` : undefined;
}

export interface ProofCaseView { id: string; verdict: string; reviewStatus: string; currentness?: string }
export interface ProofCoverageView { id: string; cells: readonly { id: string; effectiveExecution: string; retired?: boolean; currentness?: string }[] }
/** A report or a finish path already holds context-aware views; use those rather than default views that cannot tell freshness. */
export function proofViews(cases: readonly ProofCaseView[], coverage: readonly ProofCoverageView[]): { cases: ProofCase[]; coverage: ProofCoverage[] } {
  return {
    cases: cases.map(view => ({ id: view.id, verdict: view.verdict, reviewStatus: view.reviewStatus, currentness: view.currentness })),
    coverage: coverage.map(view => ({ planId: view.id, cells: view.cells.map(cell => ({ id: cell.id, execution: cell.effectiveExecution, retired: cell.retired === true || cell.currentness === 'retired' })) })),
  };
}

/** One reader for both the plan board and the completion derivation, so neither re-implements the other's rule. */
export function proofData(index: LedgerIndex): ProofData {
  const plans = coveragePlans(index), cells = coverageCells(index);
  return {
    claims: claimHeadClaims(index).map(claim => ({ closure: claim.closure, execution: claim.execution, gained: claimCapabilities(claim).gained })),
    cases: caseViews(index).map(view => ({ id: view.id, verdict: view.verdict, reviewStatus: view.reviewStatus, currentness: view.currentness })),
    coverage: plans.map(plan => ({ planId: plan.id, cells: cells.filter(cell => plan.cellIds.includes(cell.id)).map(cell => ({ id: cell.id, execution: cell.execution, retired: cell.retired })) })),
  };
}
