import { describeCapability, isTypedCapability, readCapabilities, type Capability } from './capabilities.js';
import { FINDING_SEVERITIES } from './case-types.js';
import { isDemonstrated } from './claims.js';
import { CHAIN_REACH_KEYS, type CaseEffect, type ChainReach } from './cvss.js';
import type { EngagementMode } from './campaign.js';

/**
 * A7.6 (planning_update.md P7.2): the access ladder is derived by the host from records that already exist, and nothing stores a rung.
 *
 * The run already knew how to say "severity stops at the furthest executed step" (`src/cases.ts`), but it had no vocabulary for *how far*
 * that step reached: a proven RCE on an internal service and a confirmed header difference both counted as one demonstrated depth. The five
 * rungs below are that vocabulary. Each one is a statement about evidence the ledger holds, never a field a caller may assert:
 *
 *  - `observed`   a receipt exists and a claim cites it, but the claim is not demonstrated.
 *  - `executed`   the claim is demonstrated (closure `confirmed`, execution `tested`; `src/claims.ts:44-46`).
 *  - `controlled` the demonstrated claim cites at least one negative control.
 *  - `crossed`    the demonstrated claim's gained capability names the boundary it holds inside (`scope`), or the demonstrated chain step's
 *                 effect is one that crosses a principal, tenant or sandbox boundary.
 *  - `impact`     a demonstrated chain step shows code execution or an integrity write reached at local or adjacent access. LPE is exactly
 *                 that shape with `PR=L` (owner decision Q16); no new effect value exists for it, and a step that shows no reach cannot claim it.
 *
 * `inferred` policy claims keep their current severity refusal (`src/cases.ts`): a rung is evidence of depth, not permission to rate.
 */

export const RUNGS = ['observed', 'executed', 'controlled', 'crossed', 'impact'] as const;
export type Rung = typeof RUNGS[number];
export function rungRank(rung: Rung): number { return RUNGS.indexOf(rung); }

/** A demonstrated step effect that crosses a principal, tenant or sandbox boundary. */
export const CROSSING_EFFECTS: readonly CaseEffect[] = ['authentication-bypass', 'cross-tenant-read', 'sandbox-escape'];
/** An effect that takes control of code or data. LPE is this at local reach (Q16), not a new effect value. */
export const IMPACT_EFFECTS: readonly CaseEffect[] = ['code-execution', 'integrity-write'];

/** The claim fields the derivation reads. Untyped on purpose: records arrive as ledger JSON, and a malformed field is no rung. */
export interface LadderClaimFields {
  closure?: unknown; execution?: unknown; evidenceRefs?: unknown; negativeControls?: unknown; gained?: unknown; provides?: unknown;
}
export interface LadderClaimInput { id: string; data?: Record<string, unknown> }
/** W-H/F8: the operation an evidence receipt recorded, looked up by its record id. Untyped payload, typed lookup: a receipt
 *  whose `data.operation` is missing or not a string contributes no signal, the same as one the derivation was never given. */
export interface LadderEvidenceInput { id: string; operation?: string }
export interface LadderStepInput { order: number; step: string; claimRef?: string; effect?: CaseEffect; reach?: ChainReach; gained: readonly Capability[] }
export interface LadderCaseInput {
  id: string; revision: number; accepted: boolean; severity?: string; claimRefs: readonly string[];
  chain?: { objective: string; demonstratedThrough?: number; impactSeverity?: string; steps: readonly LadderStepInput[] };
}
export interface LadderStepView { order: number; step: string; claimRef?: string; rung?: Rung; effect?: CaseEffect; capability: string; reach?: string; reachConsistency?: 'inconsistent' }
export interface LadderChainView { caseId: string; revision: number; accepted: boolean; objective: string; demonstratedThrough?: number; steps: LadderStepView[] }
export interface LadderWall { rung: Rung; wall: string }
export interface LadderView {
  mode: EngagementMode;
  start: string;
  /** How many candidate claims the derivation read; printed when no chain was recorded. */
  claims: number;
  chain?: LadderChainView;
  furthest?: Rung;
  /** Owner-attributed severity of the accepted case that rests on the furthest rung, when one exists. Never re-derived here. */
  severity?: string;
  ratedCase?: string;
  walls: LadderWall[];
}

const asRows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const receiptCount = (claim: LadderClaimFields): number => asRows(claim.evidenceRefs).length + asRows(claim.negativeControls).length;
const crossedCapability = (gained: readonly Capability[]): Capability | undefined =>
  gained.find(capability => isTypedCapability(capability) && (capability.scope ?? '').length > 0);
/** A7.6: the impact rung needs a reach that names local (AV:L) or adjacent (AV:A) access. */
export function localOrAdjacent(reach: ChainReach | undefined): boolean { return reach !== undefined && (reach.AV === 'L' || reach.AV === 'A'); }

/** W-H/F8: receipt-producing operations (`src/policy.ts`'s POLICY_KINDS plus `pty-read`/`capture`) split by whether the
 *  operation reaches the target over the network, or runs inside an already-held session (shell/PTY/capture). */
const FOOTHOLD_OPERATIONS = new Set(['shell', 'pty-read', 'capture']);
const NETWORK_OPERATIONS = new Set(['net', 'http']);
export type ReachConsistency = 'consistent' | 'inconsistent' | 'unchecked';
/**
 * W-H/F8: whether a step's claimed `reach.AV` is structurally consistent with how its cited evidence was actually gathered —
 * a check against the receipts, not a second trust of the field `localOrAdjacent` already reads. `AV:P` has no structural
 * signal here (no operation implies physical access), and evidence that names no recognized operation gives none either:
 * both stay `unchecked`, because an absent signal is not a verdict in either direction. `AV:N` (reachable from anywhere)
 * needs at least one network operation among the evidence; `AV:L`/`AV:A` need at least one foothold operation. Evidence
 * that is purely the other kind is `inconsistent`; evidence that cites both (a pivot through an obtained session) is not.
 */
export function reachEvidenceConsistency(reach: ChainReach | undefined, operations: readonly string[]): ReachConsistency {
  if (!reach || reach.AV === 'P') return 'unchecked';
  const hasFoothold = operations.some(op => FOOTHOLD_OPERATIONS.has(op)), hasNetwork = operations.some(op => NETWORK_OPERATIONS.has(op));
  if (!hasFoothold && !hasNetwork) return 'unchecked';
  if (reach.AV === 'N' && hasFoothold && !hasNetwork) return 'inconsistent';
  if ((reach.AV === 'L' || reach.AV === 'A') && hasNetwork && !hasFoothold) return 'inconsistent';
  return 'consistent';
}

/**
 * The rung one claim reaches on its own, or `undefined` when it reaches none (no receipt and not demonstrated). Observed needs a receipt:
 * a claim with nothing cited behind it is an assertion, and this module prints evidence.
 */
export function claimRung(claim: LadderClaimFields): Rung | undefined {
  if (!isDemonstrated(claim)) return receiptCount(claim) > 0 ? 'observed' : undefined;
  if (crossedCapability(readCapabilities(claim.gained ?? claim.provides, 'gained'))) return 'crossed';
  return asRows(claim.negativeControls).length > 0 ? 'controlled' : 'executed';
}

/**
 * The rung one chain step reaches: its cited claim's rung, raised when that demonstrated step's own effect proves a crossing
 * or impact. Impact additionally needs the cited evidence not to contradict the claimed reach (`operations`, the demonstrating
 * claim's receipts' operation kinds; W-H/F8's `reachEvidenceConsistency`) — a reach the evidence disputes does not credit it.
 */
export function stepRung(claim: LadderClaimFields | undefined, step: Pick<LadderStepInput, 'effect' | 'reach'>, operations: readonly string[] = []): Rung | undefined {
  const base = claim ? claimRung(claim) : undefined;
  if (!claim || !isDemonstrated(claim)) return base;
  if (step.effect && CROSSING_EFFECTS.includes(step.effect)) return 'crossed';
  if (step.effect && IMPACT_EFFECTS.includes(step.effect) && localOrAdjacent(step.reach) && reachEvidenceConsistency(step.reach, operations) !== 'inconsistent') return 'impact';
  return base;
}

const rankOf = (rung: Rung | undefined): number => rung === undefined ? -1 : rungRank(rung);
const claimData = (record: LadderClaimInput): Record<string, unknown> => record.data ?? {};
const reachLine = (reach: ChainReach | undefined): string | undefined => reach && CHAIN_REACH_KEYS.map(metric => `${metric}:${reach[metric]}`).join(' ');

/** The wall a rung above the demonstrated depth records: what the ledger says stopped short, not a guess about the target. */
function wallFor(rung: Rung, claims: readonly LadderClaimInput[], chosen: { steps: LadderStepView[] } | undefined): string {
  const fields = claims.map(claim => ({ id: claim.id, data: claimData(claim) }));
  const demonstrated = fields.filter(claim => isDemonstrated(claim.data));
  const blocked = fields.find(claim => !isDemonstrated(claim.data) && typeof claim.data.requirement === 'string' && claim.data.requirement.trim());
  const observedOnly = fields.find(claim => !isDemonstrated(claim.data) && receiptCount(claim.data) > 0);
  const noControl = demonstrated.find(claim => asRows(claim.data.negativeControls).length === 0);
  const step = chosen?.steps.filter(item => item.rung !== undefined).at(-1);
  switch (rung) {
    case 'observed': return 'no receipt is recorded as a claim';
    case 'executed': return blocked
      ? `claim ${blocked.id} is ${String(blocked.data.closure)}/${String(blocked.data.execution)}: ${String(blocked.data.requirement)}`
      : demonstrated.length ? 'every demonstrated claim already reaches it' : 'no claim is demonstrated (confirmed closure and tested execution; a source trace is not runtime proof)';
    case 'controlled': return noControl
      ? `claim ${noControl.id} cites no negative control`
      : demonstrated.length ? 'every demonstrated claim cites a negative control' : 'no demonstrated claim is recorded';
    case 'crossed': return demonstrated.length
      ? `claim ${demonstrated[0].id} gained ${readCapabilities(demonstrated[0].data.gained ?? demonstrated[0].data.provides, 'gained').map(describeCapability).join(', ') || 'no capability'} with no scope, and no demonstrated step effect crosses a principal, tenant or sandbox boundary`
      : 'no demonstrated claim or step crosses a principal, tenant or sandbox boundary';
    case 'impact': return step
      ? step.reachConsistency === 'inconsistent'
        ? `the deepest demonstrated step (${step.order}) shows ${step.effect ?? 'no recorded effect'}${step.reach ? ` at ${step.reach}` : ''}, but its cited evidence does not match that reach, so the rung is not credited`
        : `the deepest demonstrated step (${step.order}) shows ${step.effect ?? 'no recorded effect'}${step.reach ? ` at ${step.reach}` : ' with no recorded reach'}`
      : 'no demonstrated chain step shows code execution or an integrity write at local or adjacent access';
  }
}

/**
 * Derive the run's ladder from committed records. The headline chain is the deepest recorded one (rung, then demonstrated depth, then case ID, so
 * the choice is a function of state); claims alone still produce a furthest rung and the walls that stopped short of the next one.
 */
export function deriveLadder(input: { mode: EngagementMode; start: string; claims: readonly LadderClaimInput[]; cases: readonly LadderCaseInput[]; evidence?: readonly LadderEvidenceInput[] }): LadderView {
  const byId = new Map(input.claims.map(claim => [claim.id, claimData(claim)]));
  const operationById = new Map((input.evidence ?? []).map(row => [row.id, row.operation]));
  // W-H/F8: the operation kinds behind a claim's cited receipts, for `reachEvidenceConsistency`. A ref the evidence list
  // does not cover (an older run derived with no `evidence` input, or a ref that names no evidence row) contributes nothing.
  const operationsFor = (claim: LadderClaimFields | undefined): string[] =>
    asRows(claim?.evidenceRefs).filter((ref): ref is string => typeof ref === 'string').map(ref => operationById.get(ref)).filter((op): op is string => typeof op === 'string');
  const chainViews = input.cases.filter(item => item.chain && item.chain.steps.length).map(item => {
    const steps = item.chain!.steps.map(step => {
      const claim = step.claimRef ? byId.get(step.claimRef) : undefined, operations = operationsFor(claim);
      return {
        order: step.order, step: step.step, ...(step.claimRef ? { claimRef: step.claimRef } : {}), rung: stepRung(claim, step, operations),
        ...(step.effect ? { effect: step.effect } : {}), capability: step.gained.length ? step.gained.map(describeCapability).join(', ') : 'none recorded',
        ...(reachLine(step.reach) ? { reach: reachLine(step.reach)! } : {}),
        // Surfaced only on the branch that can actually cost a rung (local/adjacent disputed by network-only evidence): the
        // other branch (AV:N disputed by foothold-only evidence) can never affect `impact` (`localOrAdjacent` already excludes
        // AV:N from it), so reporting it here would attach a false "not credited because of this" to an unrelated rung.
        ...(localOrAdjacent(step.reach) && reachEvidenceConsistency(step.reach, operations) === 'inconsistent' ? { reachConsistency: 'inconsistent' as const } : {}),
      } satisfies LadderStepView;
    });
    return { item, steps, deepest: Math.max(-1, ...steps.map(step => rankOf(step.rung))), depth: item.chain!.demonstratedThrough ?? 0 };
  });
  chainViews.sort((left, right) => right.deepest - left.deepest || right.depth - left.depth || left.item.id.localeCompare(right.item.id));
  const chosen = chainViews[0];
  const claimRungs = input.claims.map(claim => claimRung(claimData(claim))).filter((rung): rung is Rung => rung !== undefined);
  const furthestRank = Math.max(-1, ...claimRungs.map(rungRank), ...(chosen?.steps.map(step => rankOf(step.rung)) ?? []));
  const furthest = furthestRank < 0 ? undefined : RUNGS[furthestRank];
  // The severity printed with the rung is the owner's rating of the accepted case that rests on it; the host only selects, never rates.
  const rungClaims = new Set(input.claims.filter(claim => claimRung(claimData(claim)) === furthest).map(claim => claim.id));
  const backed = input.cases.filter(item => item.accepted && item.severity && (item.id === chosen?.item.id || item.claimRefs.some(ref => rungClaims.has(ref))))
    .filter(item => (FINDING_SEVERITIES as readonly string[]).includes(item.severity!))
    .sort((left, right) => FINDING_SEVERITIES.indexOf(left.severity! as typeof FINDING_SEVERITIES[number]) - FINDING_SEVERITIES.indexOf(right.severity! as typeof FINDING_SEVERITIES[number]) || left.id.localeCompare(right.id));
  const chain: LadderChainView | undefined = chosen ? { caseId: chosen.item.id, revision: chosen.item.revision, accepted: chosen.item.accepted,
    objective: chosen.item.chain!.objective, ...(chosen.item.chain!.demonstratedThrough === undefined ? {} : { demonstratedThrough: chosen.item.chain!.demonstratedThrough }), steps: chosen.steps } : undefined;
  const walls = furthestRank >= RUNGS.length - 1 ? [] : RUNGS.slice(furthestRank + 1).map(rung => ({ rung, wall: wallFor(rung, input.claims, chosen) }));
  return { mode: input.mode, start: input.start, claims: input.claims.length, ...(chain ? { chain } : {}), ...(furthest ? { furthest } : {}),
    ...(backed[0] ? { severity: backed[0].severity!, ratedCase: backed[0].id } : {}), walls };
}
