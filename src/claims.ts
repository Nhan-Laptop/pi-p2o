import { CANDIDATE_CLOSURES, CANDIDATE_EXECUTIONS } from './evidence.js';
import { COVERAGE_EXECUTION } from './coverage-types.js';
import { readCapabilities, type Capability } from './capabilities.js';
import { isEnvironmentId, isPayloadId } from './lab.js';

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
  /** Typed capability pair (P14.1). */
  gained?: unknown;
  needs?: unknown;
  /** Pre-P14 text pair: still read, surfaced as legacy entries, never matched. */
  provides?: unknown;
  requires?: unknown;
  /** Run-scoped payload artifact (P14.2) and environment recipe (P14.3). */
  payloadRef?: unknown;
  environmentRef?: unknown;
  control?: unknown;
  policyBasis?: unknown;
}

const DEMONSTRATED_CLOSURE = 'confirmed' satisfies ClaimClosure;
const DEMONSTRATED_EXECUTION = 'tested' satisfies ClaimExecution;
const OPEN_CLOSURE = 'open_proof_gap' satisfies ClaimClosure;
const RULED_OUT_CLOSURE = 'ruled_out' satisfies ClaimClosure;

/** A primitive that actually ran: confirmed closure and tested execution. The only definition in the codebase. */
export function isDemonstrated(claim: ClaimFields): boolean {
  return claim.closure === DEMONSTRATED_CLOSURE && claim.execution === DEMONSTRATED_EXECUTION;
}

/** A primitive that is still a claim to be exercised. `ruled_out` and untested claims are neither provider nor open gap. */
export function isOpenGap(claim: ClaimFields): boolean { return claim.closure === OPEN_CLOSURE; }

/** A claim whose author states it is confirmed, whether or not it was exercised. Review queues use this, not the provider rule. */
export function isConfirmedClaim(claim: ClaimFields): boolean { return claim.closure === DEMONSTRATED_CLOSURE; }
/** P16.6: a negative result, which needs a control and is allowed at most one re-check. */
export function isRuledOutClaim(claim: ClaimFields): boolean { return claim.closure === RULED_OUT_CLOSURE; }

/** An item still owed an answer: an open gap, or a candidate whose execution was blocked. */
export function isOpenClaim(claim: ClaimFields): boolean { return isOpenGap(claim) || claim.execution === 'blocked'; }

/**
 * The capability pair a claim declares, in the one vocabulary. A pre-P14 record's `provides`/`requires` text becomes a legacy
 * entry: it stays readable and is reported, but it matches nothing (see `capabilityMatches`).
 */
export function claimCapabilities(claim: ClaimFields): { gained: Capability[]; needs: Capability[] } {
  return { gained: readCapabilities(claim.gained ?? claim.provides, 'gained'), needs: readCapabilities(claim.needs ?? claim.requires, 'needs') };
}

/** Only a demonstrated claim may hand a capability to a later step; an unproven one must not look consumable. Legacy entries included. */
export function demonstratedGained(claim: ClaimFields): Capability[] {
  return isDemonstrated(claim) ? claimCapabilities(claim).gained : [];
}

export function claimNeeds(claim: ClaimFields): Capability[] { return claimCapabilities(claim).needs; }

/**
 * planning_update.md P14.2/P14.3: whether another worker can replay this claim's demonstrated effect, derived and never stored.
 * The conjunction is the point: a payload without the environment it was demonstrated in is not reproducible, and an
 * environment without the payload does not say what to run. A report uses it to say "not replayable" instead of implying a
 * second worker can reproduce what only the author's receipt shows.
 */
export function isReplayable(claim: ClaimFields): boolean { return isPayloadId(claim.payloadRef) && isEnvironmentId(claim.environmentRef); }

/** Coverage-cell domain: the cell's own `execution` reached `tested`. Never call this on a claim, or `isDemonstrated` on a cell. */
/**
 * M5: a cell is tested only if its *effective* execution says so. A coverage view derives `effectiveExecution` from the tasks the cell
 * cites, so a cell whose task ended without a verdict reads as `attempted` here even though its stored value says `tested`.
 */
export function isTestedCell(cell: { execution?: unknown; effectiveExecution?: unknown }): boolean {
  const execution = cell.effectiveExecution ?? cell.execution;
  return execution === ('tested' satisfies CellExecution);
}
