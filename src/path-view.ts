/**
 * planning_update.md R3.1/D-R1-11: one constant decides what a recorded relation means for reachability, so a path query
 * cannot invent an edge semantics of its own and a new relation kind cannot silently become traversable.
 *
 * Three roles, and the distinction is deliberately conservative:
 * - `traversable` — the edge is structure: if both endpoints exist, moving along it needs nothing further demonstrated.
 * - `conditional` — the edge is real structure but moving along it depends on a state the run has to show (an identity,
 *   a credential, an input it controls). The path keeps it and marks it, so a reader sees the condition instead of a
 *   confident arrow.
 * - `informational` — the edge is a reading aid, not movement (a variant, a source location, provenance). It never joins a
 *   path, because "similar to" and "compiled from" are not ways to reach anything.
 *
 * The classification is a constant, not state: it is exposed on read rows as `traversable`, derived at read time, so it
 * needs no schema migration and rewriting it later cannot make stored rows disagree with today's rule.
 */
import { CAPABILITY_KINDS, capabilityMatches, type Capability, type CapabilityKind } from './capabilities.js';
import { demonstratedGained, type ClaimFields } from './claims.js';
import { RELATION_KINDS } from './state/graph.js';

export type RelationRole = 'traversable' | 'conditional' | 'informational';

/** R3.1: every relation kind is classified exactly once, with the reason it moves (or does not move) a path. */
export const RELATION_ROLE: Readonly<Record<typeof RELATION_KINDS[number], RelationRole>> = {
  // Structure that a request or a process can actually follow.
  contains: 'traversable', // parent route/host holds a child surface
  resolves_to: 'traversable', // name resolves to an endpoint
  exposes: 'traversable', // endpoint is served by a component
  implemented_by: 'traversable', // the running component implements the surface
  alias_of: 'traversable', // a second name for the same thing
  reads: 'traversable', // a component reads the store
  writes: 'traversable', // a component writes the store
  owns: 'traversable', // ownership of a resource
  hosts: 'traversable', // host carries the asset
  // Real edges whose crossing depends on a demonstrated state.
  consumes: 'conditional', // crossing needs a controllable/authenticated input
  authenticates_as: 'conditional', // crossing needs a demonstrated identity
  authenticates: 'conditional', // the auth boundary must be shown to be passable
  depends_on: 'conditional', // dependency may exist without being reachable
  // Reading aids, never movement.
  variant_of: 'informational', // similarity is not reachability
  anchors: 'informational', // a source/artifact location
  derived_from: 'informational', // provenance of the row, not a route
};

/** The role of a stored relation kind; an unknown kind is informational rather than silently traversable. */
export function relationRole(kind: string): RelationRole { return RELATION_ROLE[kind as keyof typeof RELATION_ROLE] ?? 'informational'; }

/** True when a path may follow the edge. Conditional edges are followed and marked; informational edges are not followed. */
export function isTraversable(kind: string): boolean { return relationRole(kind) !== 'informational'; }

/** True when the edge needs a demonstrated state (identity, credential, input) for the crossing to mean anything. */
export function isConditional(kind: string): boolean { return relationRole(kind) === 'conditional'; }

export const traverseDecision = (kind: string): { traversable: boolean; conditional: boolean } => {
  const role = relationRole(kind); return { traversable: role !== 'informational', conditional: role === 'conditional' };
};

export const CAPABILITY_KINDS_SET: ReadonlySet<string> = new Set(CAPABILITY_KINDS);

/** A `path` effect names one typed capability; an unknown word is refused instead of compared as text. */
export function effectCapability(value: string): Capability | undefined {
  return CAPABILITY_KINDS_SET.has(value) ? { kind: value as CapabilityKind } : undefined;
}

export interface PathEffectHop { relationEntityId: string; fromId: string; toId: string }
export interface PathEffectClaim { claimId: string; claim: ClaimFields }
export interface PathEffectSatisfaction { pathIndex: number; hopIndex: number; relationEntityId: string; claimId: string }
export interface PathEffect {
  /** The capability the caller asked for. */
  kind: string;
  /** True when a demonstrated claim that gains the effect is attached to a hop endpoint. */
  supplied: boolean;
  /** The first hop whose endpoint a demonstrated claim gains the effect from. */
  satisfiedBy?: PathEffectSatisfaction;
  /** The hop that has to supply the effect when nothing does; present only when `supplied` is false. */
  missingHop?: { pathIndex: number; hopIndex: number; relationEntityId: string; reason: string };
}

/**
 * R3.2/R3.3: annotate a walked path with the demonstrated capability it does or does not reach. The capability rule is the
 * same one `chainJoin` uses (`demonstratedGained` + `capabilityMatches`): a path hop is satisfied when a claim that is
 * demonstrated gains the effect and the claim's host-stamped `assetRefs` name that hop's from- or to-asset. Nothing here
 * re-evaluates a claim, and an inferred/untested claim never satisfies an effect.
 */
export function annotatePathEffect(paths: ReadonlyArray<ReadonlyArray<PathEffectHop>>, claims: readonly PathEffectClaim[], kind: string): PathEffect {
  const wanted = effectCapability(kind);
  if (!wanted) throw Error(`Unknown path effect "${kind}"; use one of the typed capability kinds (for example data.read, db.query, host.shell)`);
  const demonstrated = claims.flatMap(entry => {
    const gained = demonstratedGained(entry.claim).filter(capability => capabilityMatches(wanted, capability));
    if (!gained.length) return [];
    const assets = Array.isArray(entry.claim.assetRefs) ? entry.claim.assetRefs as Array<{ id?: unknown }> : [];
    return [{ claimId: entry.claimId, assets: assets.map(ref => typeof ref.id === 'string' ? ref.id : '').filter(Boolean) }];
  });
  for (const [pathIndex, hops] of paths.entries()) {
    for (const [hopIndex, hop] of hops.entries()) {
      const match = demonstrated.find(entry => entry.assets.includes(hop.fromId) || entry.assets.includes(hop.toId));
      if (match) return { kind, supplied: true, satisfiedBy: { pathIndex, hopIndex, relationEntityId: hop.relationEntityId, claimId: match.claimId } };
    }
  }
  const last = paths.at(-1);
  const hopIndex = last && last.length ? last.length - 1 : 0;
  return { kind, supplied: false, ...(last && last.length ? { missingHop: { pathIndex: paths.length - 1, hopIndex,
    relationEntityId: last[hopIndex]!.relationEntityId, reason: `no demonstrated claim gains ${kind} on either endpoint of this edge` } } : {}) };
}

/** Deterministic order for concurrent path candidates: shorter first, then the lexicographic hop chain. */
export function comparePaths(left: ReadonlyArray<PathEffectHop>, right: ReadonlyArray<PathEffectHop>): number {
  if (left.length !== right.length) return left.length - right.length;
  const key = (hops: ReadonlyArray<PathEffectHop>) => hops.map(hop => `${hop.fromId}>${hop.relationEntityId}>${hop.toId}`).join('|');
  return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
}
