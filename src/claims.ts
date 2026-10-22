import { CANDIDATE_CLOSURES, CANDIDATE_EXECUTIONS } from './evidence.js';
import { COVERAGE_EXECUTION } from './coverage-types.js';

/**
 * planning_update.md P13(b): "was this actually demonstrated?" had no owner.
 *
 * Two vocabularies share the field name `execution` and three of their values (`tested`, `blocked`, `not_applicable`):
 * `CANDIDATE_EXECUTIONS` (this file's `ClaimExecution`) says whether a *primitive ran*, while `COVERAGE_EXECUTION`
 * (`CellExecution`) says whether a *cell was attempted and settled*. Rows arrive as untyped ledger JSON, so the compiler could
 * not tell them apart, and the same literal `execution === 'tested'` was written at eight sites across both domains.
 *
 * The rule now lives here only: a primitive counts as demonstrated when it is confirmed **and** tested, and a cell counts as
 * tested when its own vocabulary says so. `tests/minimal/claims.test.ts` fails if a literal comparison reappears elsewhere.
 */
export type ClaimExecution = typeof CANDIDATE_EXECUTIONS[number];
export type CellExecution = typeof COVERAGE_EXECUTION[number];
export type ClaimClosure = typeof CANDIDATE_CLOSURES[number];

/** The untyped shape a claim arrives as: a `p2o_candidate` tool input or a ledger record's `data`. */
export interface ClaimFields {
  closure?: unknown;
  execution?: unknown;
  provides?: unknown;
  requires?: unknown;
  control?: unknown;
  policyBasis?: unknown;
}

const DEMONSTRATED_CLOSURE = 'confirmed' satisfies ClaimClosure;
const DEMONSTRATED_EXECUTION = 'tested' satisfies ClaimExecution;
const OPEN_CLOSURE = 'open_proof_gap' satisfies ClaimClosure;

/** A primitive that actually ran: confirmed closure and tested execution. The only definition in the codebase. */
export function isDemonstrated(claim: ClaimFields): boolean {
  return claim.closure === DEMONSTRATED_CLOSURE && claim.execution === DEMONSTRATED_EXECUTION;
}

/** A primitive that is still a claim to be exercised. `ruled_out` and untested claims are neither provider nor open gap. */
export function isOpenGap(claim: ClaimFields): boolean { return claim.closure === OPEN_CLOSURE; }

/** A claim whose author states it is confirmed, whether or not it was exercised. Review queues use this, not the provider rule. */
export function isConfirmedClaim(claim: ClaimFields): boolean { return claim.closure === DEMONSTRATED_CLOSURE; }

/** An item still owed an answer: an open gap, or a candidate whose execution was blocked. */
export function isOpenClaim(claim: ClaimFields): boolean { return isOpenGap(claim) || claim.execution === 'blocked'; }

/** Only a demonstrated claim may hand a capability to a later step; an unproven one must not look consumable. */
export function demonstratedProvides(claim: ClaimFields): string | undefined {
  return isDemonstrated(claim) && typeof claim.provides === 'string' && claim.provides.trim() ? claim.provides : undefined;
}

export function claimRequires(claim: ClaimFields): string | undefined {
  return typeof claim.requires === 'string' && claim.requires ? claim.requires : undefined;
}

/** Coverage-cell domain: the cell's own `execution` reached `tested`. Never call this on a claim, or `isDemonstrated` on a cell. */
export function isTestedCell(cell: { execution?: unknown }): boolean { return cell.execution === ('tested' satisfies CellExecution); }
