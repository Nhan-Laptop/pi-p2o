/**
 * planning_update.md P5: "which step is next" as a query over the claim graph the run already records.
 * A claim hands out a capability (`provides`) and consumes others (`requires`); the join reads those two prose
 * fields as token sets, so nothing new is persisted and no candidate→candidate edge store exists.
 */
import { isDemonstrated, isOpenGap } from './claims.js';

export interface ChainClaim { candidate: string; closure: string; execution?: string; provides?: string; requires?: string; /** Ledger record id of the candidate head; the identity `CaseFinding.chain.steps[].claimRef` cites (P13a). */ recordId?: string }
export interface ChainPath { claimId: string; depth: number; path: string[]; /** Ledger record id for the slug in `claimId`, when the caller supplied one, so a plan can cite either identity. */ recordId?: string }
export interface ChainJoin {
  /** Confirmed and tested claims that hand out a capability without needing one first. */
  primitives: string[];
  /** Open claims whose every required token an existing confirmed+tested claim already provides: dispatchable now. */
  ready: string[];
  /** Open claims with at least one token nothing recorded provides. */
  unmet: string[];
  /** Per unmet claim, the tokens still missing. */
  uncovered: Record<string, string[]>;
  /** Ready claims, deepest first, each with a shortest proven path from a primitive. */
  frontier: ChainPath[];
  /** How far each claim sits from a primitive along its shortest proven route, when that distance is known. */
  depth: Record<string, number>;
}

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'and', 'or', 'for', 'in', 'on', 'with', 'by', 'from', 'as', 'that', 'this',
  'it', 'its', 'is', 'be', 'any', 'one', 'some', 'at', 'into', 'via', 'through', 'own', 'not', 'then', 'than', 'an', 'per']);
const MAX_DEPTH = 12;
const MAX_FRONTIER = 10;

/** Lowercased word tokens without stopwords: the unit the join compares. Deterministic and order-free. */
export function chainTokens(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1 && !STOP.has(token)))].sort();
}

// One owner for the rule (src/claims.ts): the coverage-cell vocabulary also spells `tested`, and only this import decides claims.
const PROVIDES = (claim: ChainClaim) => isDemonstrated(claim);
const OPEN = (claim: ChainClaim) => isOpenGap(claim);

export function chainJoin(claims: readonly ChainClaim[]): ChainJoin {
  const byId = new Map(claims.map(claim => [claim.candidate, claim]));
  const providers = claims.filter(PROVIDES).map(claim => ({ id: claim.candidate, tokens: new Set(chainTokens(claim.provides)) }));
  const required = new Map(claims.map(claim => [claim.candidate, chainTokens(claim.requires)]));
  const covers = (claimId: string, tokens: readonly string[]) => providers
    .filter(provider => provider.id !== claimId && tokens.some(token => provider.tokens.has(token)))
    .map(provider => provider.id);
  const missing = (claimId: string) => required.get(claimId)!.filter(token => !providers.some(provider => provider.id !== claimId && provider.tokens.has(token)));
  const depth = new Map<string, number>();
  const depthOf = (claimId: string, seen: Set<string> = new Set()): number | undefined => {
    if (depth.has(claimId)) return depth.get(claimId);
    const tokens = required.get(claimId) ?? [];
    if (!tokens.length) return byId.get(claimId) && PROVIDES(byId.get(claimId)!) ? (depth.set(claimId, 0), 0) : undefined;
    if (missing(claimId).length || seen.has(claimId) || seen.size > MAX_DEPTH) return undefined;
    const parents = covers(claimId, tokens).map(parent => depthOf(parent, new Set([...seen, claimId]))).filter((value): value is number => value !== undefined);
    if (!parents.length) return undefined;
    // Shortest distance from a primitive: the same path breadth-first search below reports, so depth and path agree.
    const value = Math.min(...parents) + 1;
    if (value > MAX_DEPTH) return undefined;
    depth.set(claimId, value);
    return value;
  };
  for (const claim of claims) depthOf(claim.candidate);
  const ready = claims.filter(claim => OPEN(claim) && !missing(claim.candidate).length);
  const unmet = claims.filter(claim => OPEN(claim) && missing(claim.candidate).length > 0);
  // Shortest primitive→claim path by breadth-first walk over provider edges; the deepest ready claim is the frontier.
  const parentOf = new Map<string, string | undefined>();
  const queue = claims.filter(claim => required.get(claim.candidate)!.length === 0 && PROVIDES(claim)).map(claim => claim.candidate);
  const seen = new Set(queue);
  for (let index = 0; index < queue.length && index < 500; index++) {
    const id = queue[index]!;
    for (const claim of claims) {
      if (seen.has(claim.candidate)) continue;
      if (!covers(claim.candidate, required.get(claim.candidate)!).includes(id)) continue;
      if (missing(claim.candidate).length) continue;
      seen.add(claim.candidate); parentOf.set(claim.candidate, id); queue.push(claim.candidate);
    }
  }
  const pathTo = (claimId: string) => { const path: string[] = [claimId]; let cursor = parentOf.get(claimId); let guard = 0;
    while (cursor && guard++ < MAX_DEPTH) { path.unshift(cursor); cursor = parentOf.get(cursor); } return path; };
  const frontier = ready.map(claim => ({ claimId: claim.candidate, depth: depth.get(claim.candidate) ?? 0, path: pathTo(claim.candidate), ...(claim.recordId ? { recordId: claim.recordId } : {}) }))
    .sort((left, right) => right.depth - left.depth || left.claimId.localeCompare(right.claimId)).slice(0, MAX_FRONTIER);
  const uncovered: Record<string, string[]> = {};
  for (const claim of unmet.slice(0, MAX_FRONTIER)) uncovered[claim.candidate] = missing(claim.candidate).slice(0, 8);
  return {
    primitives: providers.filter(provider => !required.get(provider.id)!.length).map(provider => provider.id).sort(),
    ready: ready.map(claim => claim.candidate).sort(), unmet: unmet.map(claim => claim.candidate).sort(), uncovered, frontier,
    depth: Object.fromEntries([...depth.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
}
