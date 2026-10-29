/**
 * planning_update.md P5 + P14.1: "which step is next" as a query over the claim graph the run already records.
 * A claim gains capabilities and needs others; both are typed (`src/capabilities.ts`), so a link is one match rule rather than
 * word overlap. Nothing new is persisted and no candidate→candidate edge store exists: the join is still derived on read.
 */
import { claimCapabilities, isDemonstrated, isOpenGap, type ClaimFields } from './claims.js';
import { capabilityMatches, isTypedCapability, type Capability } from './capabilities.js';
import { isEnvironmentId } from './lab.js';
import type { LedgerIndex } from './records.js';
import { GRAPH_RESPONSE_BYTES } from './state/graph.js';

export interface ChainClaim extends ClaimFields {
  candidate: string;
  /** Where the primitive lives and what class of weakness it is: the graph records both, the draft needs them (P14.10). */
  surface?: string; risk?: string;
  /** Ledger record id of the candidate head; the identity `CaseFinding.chain.steps[].claimRef` cites (P13a). */
  recordId?: string;
}
export interface ChainPath {
  claimId: string; depth: number; path: string[];
  /** Ledger record id for the slug in `claimId`, when the caller supplied one, so a plan can cite either identity. */
  recordId?: string;
  /** P14.10: the typed capabilities this ready step consumes — what a task created from it has to stand on. */
  needs: Capability[];
  /** P14.10: ledger record ids of the providers on the shortest proven path, in execution order; a task cites these as parents. */
  providers: string[];
  /** P14.10: the recorded environment of the deepest provider that has one, so the step runs where the chain was demonstrated. */
  environmentRef?: string;
}
export interface ChainJoin {
  /** Confirmed and tested claims that hand out a capability without needing one first. */
  primitives: string[];
  /** Open claims whose every need an existing confirmed+tested claim already gains: dispatchable now. */
  ready: string[];
  /** Open claims with at least one need nothing recorded gains. */
  unmet: string[];
  /** Per unmet claim, the capabilities still missing, named by kind (P14.1: a gap is a capability, not a word). */
  uncovered: Record<string, Capability[]>;
  /** Claims whose declared capability is pre-P14 text: readable and reported, joined to nothing. Re-record them to link. */
  legacy: string[];
  /** Ready claims, deepest first, each with a shortest proven path from a primitive. */
  frontier: ChainPath[];
  /** How far each claim sits from a primitive along its shortest proven route, when that distance is known. */
  depth: Record<string, number>;
}

const MAX_DEPTH = 12;
const MAX_FRONTIER = 10;
const MAX_GAP_KINDS = 8;

// One owner for the rule (src/claims.ts): the coverage-cell vocabulary also spells `tested`, and only this import decides claims.
const OPEN = (claim: ClaimFields) => isOpenGap(claim);

export function chainJoin(claims: readonly ChainClaim[]): ChainJoin {
  // Read both vocabularies once here: a pre-P14 record's text arrives as a legacy entry and matches nothing.
  const entries = claims.map(claim => ({ claim, ...claimCapabilities(claim) }));
  const gained = new Map(entries.map(entry => [entry.claim.candidate, entry.gained.filter(isTypedCapability)]));
  const needs = new Map(entries.map(entry => [entry.claim.candidate, entry.needs]));
  const providers = entries.filter(entry => isDemonstrated(entry.claim)).map(entry => entry.claim.candidate);
  const covers = (claimId: string, wanted: readonly Capability[]) => providers
    .filter(provider => provider !== claimId && wanted.some(need => gained.get(provider)!.some(have => capabilityMatches(need, have))));
  const missing = (claimId: string) => needs.get(claimId)!
    .filter(need => !providers.some(provider => provider !== claimId && gained.get(provider)!.some(have => capabilityMatches(need, have))));

  const depth = new Map<string, number>();
  const depthOf = (claimId: string, seen: Set<string> = new Set()): number | undefined => {
    if (depth.has(claimId)) return depth.get(claimId);
    const wanted = needs.get(claimId) ?? [];
    if (!wanted.length) return providers.includes(claimId) ? (depth.set(claimId, 0), 0) : undefined;
    if (missing(claimId).length || seen.has(claimId) || seen.size > MAX_DEPTH) return undefined;
    const parents = covers(claimId, wanted).map(parent => depthOf(parent, new Set([...seen, claimId]))).filter((value): value is number => value !== undefined);
    if (!parents.length) return undefined;
    // Shortest distance from a primitive: the same path breadth-first search below reports, so depth and path agree.
    const value = Math.min(...parents) + 1;
    if (value > MAX_DEPTH) return undefined;
    depth.set(claimId, value);
    return value;
  };
  for (const entry of entries) depthOf(entry.claim.candidate);

  const ready = entries.filter(entry => OPEN(entry.claim) && !missing(entry.claim.candidate).length).map(entry => entry.claim.candidate);
  const unmet = entries.filter(entry => OPEN(entry.claim) && missing(entry.claim.candidate).length > 0).map(entry => entry.claim.candidate);

  // Shortest primitive→claim path by breadth-first walk over provider edges; the deepest ready claim is the frontier.
  const parentOf = new Map<string, string | undefined>();
  const queue = entries.filter(entry => !needs.get(entry.claim.candidate)!.length && providers.includes(entry.claim.candidate)).map(entry => entry.claim.candidate);
  const seen = new Set(queue);
  for (let index = 0; index < queue.length && index < 500; index++) {
    const id = queue[index]!;
    for (const entry of entries) {
      if (seen.has(entry.claim.candidate)) continue;
      if (!covers(entry.claim.candidate, needs.get(entry.claim.candidate)!).includes(id)) continue;
      if (missing(entry.claim.candidate).length) continue;
      seen.add(entry.claim.candidate); parentOf.set(entry.claim.candidate, id); queue.push(entry.claim.candidate);
    }
  }
  const pathTo = (claimId: string) => { const path: string[] = [claimId]; let cursor = parentOf.get(claimId); let guard = 0;
    while (cursor && guard++ < MAX_DEPTH) { path.unshift(cursor); cursor = parentOf.get(cursor); } return path; };
  const recordOf = new Map(entries.map(entry => [entry.claim.candidate, entry.claim.recordId]));
  const environmentOf = new Map(entries.map(entry => [entry.claim.candidate, isEnvironmentId(entry.claim.environmentRef) ? entry.claim.environmentRef : undefined]));
  const frontier = entries.filter(entry => ready.includes(entry.claim.candidate))
    .map(entry => {
      const path = pathTo(entry.claim.candidate), ancestors = path.slice(0, -1);
      // The environment travels with the deepest provider that recorded one: that is where the consumed capability was demonstrated.
      const environmentRef = [...ancestors].reverse().map(slug => environmentOf.get(slug)).find((value): value is string => value !== undefined);
      return { claimId: entry.claim.candidate, depth: depth.get(entry.claim.candidate) ?? 0, path, needs: needs.get(entry.claim.candidate) ?? [],
        providers: ancestors.map(slug => recordOf.get(slug)).filter((value): value is string => value !== undefined),
        ...(entry.claim.recordId ? { recordId: entry.claim.recordId } : {}), ...(environmentRef ? { environmentRef } : {}) };
    })
    .sort((left, right) => right.depth - left.depth || left.claimId.localeCompare(right.claimId)).slice(0, MAX_FRONTIER);

  const uncovered: Record<string, Capability[]> = {};
  for (const claimId of unmet.slice(0, MAX_FRONTIER)) uncovered[claimId] = missing(claimId).slice(0, MAX_GAP_KINDS);
  const legacy = entries.filter(entry => [...entry.gained, ...entry.needs].some(capability => !isTypedCapability(capability)))
    .map(entry => entry.claim.candidate).sort();
  return {
    primitives: providers.filter(provider => !needs.get(provider)!.length).sort(),
    ready: [...ready].sort(), unmet: [...unmet].sort(), uncovered, legacy, frontier,
    depth: Object.fromEntries([...depth.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
}

/** The shape `fitChainPage` bounds: the four sliced lists it may trim, plus the `shown` denominators it keeps honest. */
export interface BoundedChainPage {
  primitives: unknown[]; ready: unknown[]; unmet: unknown[]; frontier: unknown[];
  shown: { primitives: number; ready: number; unmet: number; frontier: number };
}

/**
 * S1/C2 (F-42): every graph read is bounded by `GRAPH_RESPONSE_BYTES`, and the chain page is the one read the host assembles
 * after slicing, so a long path or a large join could still overflow it. Trim the listed rows tail-first and recompute
 * `shown`, so a trimmed row reads as `counts > shown` instead of disappearing silently; `counts` stay the true totals and
 * are never rewritten here. A page that cannot fit even at the floor (one frontier row) is refused by name rather than
 * handed to the model over the bound.
 */
export function fitChainPage<T extends BoundedChainPage>(page: T, budget = GRAPH_RESPONSE_BYTES - 1024): T {
  const value: T = { ...page, shown: { ...page.shown } };
  const lists = ['frontier', 'ready', 'unmet', 'primitives'] as const;
  while (Buffer.byteLength(JSON.stringify(value)) > budget) {
    const key = lists.find(item => (value[item] as unknown[]).length > (item === 'frontier' ? 1 : 0));
    if (!key) throw Error(`Chain response cannot fit the ${budget}-byte graph bound; narrow it with limit`);
    (value[key] as unknown[]).pop();
    value.shown = { ...value.shown, [key]: (value[key] as unknown[]).length };
  }
  return value;
}

/**
 * Candidate heads as chain claims, one per slug, each with the ledger record id the case, plan and task vocabularies cite.
 * One reader for the situation counts, the graph view, the plan board and the dispatch obligation, so those four cannot drift.
 */
export function claimHeadClaims(index: LedgerIndex, runId?: string): Array<ChainClaim & { closure: string }> {
  const heads = new Map<string, Record<string, unknown>>(), ids = new Map<string, string>();
  for (const row of index.records) {
    // The ledger file is already run-scoped; a caller that holds the run id filters anyway, so a detached index cannot mix runs.
    if (row.kind !== 'candidate' || (runId !== undefined && row.runId !== runId) || typeof row.data?.candidate !== 'string') continue;
    heads.set(row.data.candidate, row.data as Record<string, unknown>);
    if (row.id) ids.set(row.data.candidate, row.id);
  }
  const text = (value: unknown) => typeof value === 'string' ? value : undefined;
  return [...heads.values()].map(data => ({ candidate: String(data.candidate), closure: text(data.closure) ?? '', execution: text(data.execution),
    ...(text(data.surface) ? { surface: text(data.surface) } : {}), ...(text(data.risk) ? { risk: text(data.risk) } : {}),
    ...claimCapabilities(data as ClaimFields), ...(data.environmentRef === undefined ? {} : { environmentRef: data.environmentRef }),
    recordId: ids.get(String(data.candidate)) }));
}
