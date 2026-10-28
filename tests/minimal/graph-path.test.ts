import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AssessmentStore, type StoreManifest } from '../../src/state/store.js';
import type { AssessmentRecord } from '../../src/records.js';
import { GRAPH_RESPONSE_BYTES } from '../../src/state/graph.js';
import { RELATION_ROLE } from '../../src/path-view.js';

/**
 * R3.2: `path` answers the red-team question — from this entry asset, what can I reach and through which recorded edges —
 * over current heads only, bounded and deterministic, with no claim re-evaluation and no authority. Each case builds its own
 * small graph so an excluded edge in one fixture can never explain a result in another.
 */
const manifest = (runId: string): StoreManifest => ({ runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture-target',
  targetDisplay: 'inert fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } });
async function fixture(work: (store: AssessmentStore) => void | Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-path-')); let store: AssessmentStore | undefined;
  try { store = AssessmentStore.create(root, manifest('run-path')); await work(store); } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
}
const receipt = (store: AssessmentStore, text = 'bounded inert receipt'): string => store.commitRecords([
  { at: '2030', by: 'owner', runId: store.manifest().runId, kind: 'evidence', text } as AssessmentRecord])[0].recordId;
type Chain = { host: string; service: string; endpoint: string; db: string; identity: string; package: string; secret: string };
/** host -hosts-> service -exposes-> endpoint -reads-> db, plus an identity, a package and an unrelated data asset. */
function chain(store: AssessmentStore): Chain {
  const ev = receipt(store);
  const acks = store.recordGraph({ assets: [
    { asset: { kind: 'host', key: 'host-a', label: 'web host' }, ref: 'host' },
    { asset: { kind: 'service', key: 'web', label: 'nginx' }, ref: 'service' },
    { asset: { kind: 'endpoint', key: 'GET /login', label: 'login' }, ref: 'endpoint' },
    { asset: { kind: 'data', key: 'users-db', label: 'users' }, ref: 'db' },
    { asset: { kind: 'identity', key: 'svc-web', label: 'service account' }, ref: 'identity' },
    { asset: { kind: 'package', key: 'npm:express@4.18.2', label: 'express', attributes: { name: 'express', version: '4.18.2', ecosystem: 'npm' } }, ref: 'package' },
    { asset: { kind: 'data', key: 'unreachable-secret', label: 'unrelated' }, ref: 'secret' },
  ], relations: [
    { kind: 'hosts', fromId: '@host', toId: '@service', fromRevision: 1, toRevision: 1, basis: 'observed', evidenceRefs: [ev] },
    { kind: 'exposes', fromId: '@service', toId: '@endpoint', fromRevision: 1, toRevision: 1, basis: 'observed', evidenceRefs: [ev] },
    { kind: 'reads', fromId: '@endpoint', toId: '@db', fromRevision: 1, toRevision: 1, basis: 'observed', evidenceRefs: [ev] },
    { kind: 'authenticates_as', fromId: '@endpoint', toId: '@identity', fromRevision: 1, toRevision: 1, basis: 'observed', evidenceRefs: [ev] },
  ] });
  // Assets are acknowledged before relations in batch order.
  return { host: acks[0]!.entityId, service: acks[1]!.entityId, endpoint: acks[2]!.entityId, db: acks[3]!.entityId,
    identity: acks[4]!.entityId, package: acks[5]!.entityId, secret: acks[6]!.entityId };
}

describe('a path walks the recorded reachability, not a claim (R3.2)', () => {
  it('returns one shortest evidence-carrying path and pins the relation classification', async () => fixture(store => {
    const ids = chain(store);
    const walk = store.graphPath({ fromId: ids.host, toId: ids.db });
    expect(walk.markers).toEqual({ noPath: false, cycle: false, truncated: false });
    expect(walk.paths).toHaveLength(1);
    const hops = walk.paths[0]!.hops;
    expect(hops.map(hop => hop.relation.kind)).toEqual(['hosts', 'exposes', 'reads']);
    expect(hops.map(hop => hop.relation.traversable)).toEqual([true, true, true]);
    expect(hops.map(hop => hop.relation.basis)).toEqual(['observed', 'observed', 'observed']);
    expect(hops.every(hop => hop.relation.evidenceRefs.length === 1)).toBe(true);
    expect(hops[0]!.from).toMatchObject({ id: ids.host, kind: 'host', key: 'host-a', revision: 1 });
    expect(hops[2]!.to).toMatchObject({ id: ids.db, kind: 'data', key: 'users-db' });
    expect(walk.counts.nodes).toBe(5);
    expect(walk.to).toMatchObject({ id: ids.db, kind: 'data' });
  }));

  it('without a target returns the discovered reachable paths in breadth-first order', async () => fixture(store => {
    const ids = chain(store);
    const walk = store.graphPath({ fromId: ids.host });
    expect(walk.paths.map(path => path.hops.length)).toEqual([1, 2, 3, 3]);
    expect(walk.paths.map(path => path.hops.at(-1)!.to.kind)).toEqual(['service', 'endpoint', 'data', 'identity']);
    expect(walk.paths[2]!.hops.at(-1)!.relation.conditional).toBe(false);
    // authenticates_as is a conditional crossing: it is walked and marked, not dropped and not presented as fact.
    expect(walk.paths[3]!.hops.at(-1)!.relation).toMatchObject({ kind: 'authenticates_as', conditional: true, traversable: true });
  }));

  it('stops at the depth and node caps instead of walking an unbounded graph', async () => fixture(store => {
    const ids = chain(store);
    expect(store.graphPath({ fromId: ids.host, toId: ids.db, maxDepth: 2 }).markers.noPath).toBe(true);
    expect(store.graphPath({ fromId: ids.host, toId: ids.db, maxDepth: 3 }).paths).toHaveLength(1);
    expect(store.graphPath({ fromId: ids.host, maxNodes: 1 })).toMatchObject({ markers: { noPath: true, truncated: true } });
  }));

  it('does not walk informational edges (a variant is not a route)', async () => fixture(store => {
    const ev = receipt(store);
    const acks = store.recordGraph({ assets: [{ asset: { kind: 'host', key: 'host-b' }, ref: 'host' }, { asset: { kind: 'package', key: 'npm:other@1.0.0', attributes: { name: 'other', version: '1.0.0', ecosystem: 'npm' } }, ref: 'pkg' }],
      relations: [{ kind: 'variant_of', fromId: '@host', toId: '@pkg', fromRevision: 1, toRevision: 1, evidenceRefs: [ev] }] });
    const walk = store.graphPath({ fromId: acks[0]!.entityId, toId: acks[1]!.entityId });
    expect(walk.markers.noPath).toBe(true);
    expect(walk.excluded).toEqual({ withdrawn: 0, stale: 0, informational: 1 });
    expect(RELATION_ROLE.variant_of).toBe('informational');
  }));

  it('counts and never walks a withdrawn or stale edge', async () => fixture(store => {
    const ids = chain(store);
    const ev = receipt(store);
    store.recordGraph({ relations: [{ kind: 'contains', fromId: ids.host, toId: ids.secret, fromRevision: 1, toRevision: 1, status: 'withdrawn', evidenceRefs: [ev] }] });
    const withdrawn = store.graphPath({ fromId: ids.host, toId: ids.secret });
    expect(withdrawn.markers.noPath).toBe(true);
    expect(withdrawn.excluded.withdrawn).toBe(1);
    // A newer host revision stales the pinned hosts edge: it is counted and not followed.
    store.recordGraph({ assets: [{ asset: { kind: 'host', key: 'host-a', label: 'web host (renamed)' } }] });
    const stale = store.graphPath({ fromId: ids.host, toId: ids.service });
    expect(stale.markers.noPath).toBe(true);
    expect(stale.excluded.stale).toBeGreaterThanOrEqual(1);
  }));

  it('marks a cycle instead of routing repeatedly through it', async () => fixture(store => {
    const ev = receipt(store);
    const acks = store.recordGraph({ assets: [{ asset: { kind: 'host', key: 'a' }, ref: 'a' }, { asset: { kind: 'service', key: 'b' }, ref: 'b' },
      { asset: { kind: 'data', key: 'c' }, ref: 'c' }],
      relations: [{ kind: 'hosts', fromId: '@a', toId: '@b', fromRevision: 1, toRevision: 1, evidenceRefs: [ev] },
        { kind: 'exposes', fromId: '@b', toId: '@c', fromRevision: 1, toRevision: 1, evidenceRefs: [ev] },
        { kind: 'contains', fromId: '@c', toId: '@a', fromRevision: 1, toRevision: 1, evidenceRefs: [ev] }] });
    const walk = store.graphPath({ fromId: acks[0]!.entityId, toId: acks[2]!.entityId, maxDepth: 6 });
    expect(walk.paths).toHaveLength(1);
    expect(walk.markers.cycle).toBe(true);
  }));

  it('applies an explicit kind filter on top of the classification', async () => fixture(store => {
    const ids = chain(store);
    expect(store.graphPath({ fromId: ids.host, toId: ids.db, kinds: ['reads'] }).markers.noPath).toBe(true);
    expect(store.graphPath({ fromId: ids.host, toId: ids.db, kinds: ['hosts', 'exposes', 'reads'] }).paths).toHaveLength(1);
  }));

  it('is deterministic and stays inside the bounded graph response', async () => fixture(store => {
    // A diamond: two middle routes to the same target, so ordering has to be a rule rather than SQL row order.
    const ev = receipt(store);
    const acks = store.recordGraph({ assets: [{ asset: { kind: 'host', key: 'start' }, ref: 'start' },
      { asset: { kind: 'service', key: 'm1' }, ref: 'm1' }, { asset: { kind: 'service', key: 'm2' }, ref: 'm2' }, { asset: { kind: 'data', key: 'goal' }, ref: 'goal' }],
      relations: [{ kind: 'hosts', fromId: '@start', toId: '@m1', fromRevision: 1, toRevision: 1, evidenceRefs: [ev] },
        { kind: 'hosts', fromId: '@start', toId: '@m2', fromRevision: 1, toRevision: 1, evidenceRefs: [ev] },
        { kind: 'exposes', fromId: '@m1', toId: '@goal', fromRevision: 1, toRevision: 1, evidenceRefs: [ev] },
        { kind: 'exposes', fromId: '@m2', toId: '@goal', fromRevision: 1, toRevision: 1, evidenceRefs: [ev] }] });
    const first = store.graphPath({ fromId: acks[0]!.entityId, toKind: 'data', maxDepth: 4 });
    const second = store.graphPath({ fromId: acks[0]!.entityId, toKind: 'data', maxDepth: 4 });
    expect(second).toEqual(first);
    expect(first.paths.length).toBeGreaterThanOrEqual(2);
    expect(first.paths.map(path => path.hops.map(hop => hop.to.key))).toEqual([['m1', 'goal'], ['m2', 'goal']]);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(GRAPH_RESPONSE_BYTES);
  }));

  it('refuses a malformed walk instead of guessing', async () => fixture(store => {
    const ids = chain(store);
    expect(() => store.graphPath({ fromId: 'asset-000000000000000000000000' })).toThrow('Unknown asset entity');
    expect(() => store.graphPath({ fromId: ids.host, toId: ids.host })).toThrow('same asset');
    expect(() => store.graphPath({ fromId: ids.host, maxDepth: 7 })).toThrow('maxDepth');
    expect(() => store.graphPath({ fromId: ids.host, maxNodes: 0 })).toThrow('maxNodes');
    expect(() => store.graphPath({ fromId: ids.host, kinds: ['not-a-kind'] })).toThrow('relation kinds');
    expect(() => store.graphPath({ fromId: ids.host, toKind: 'not-a-kind' })).toThrow('Unknown asset kind');
  }));

  it('exposes the classification on ordinary relation read rows', async () => fixture(store => {
    const ids = chain(store);
    const view = store.assetView(ids.host);
    const relations = view.relations as unknown as Array<{ kind: string; traversable: boolean; conditional: boolean }>;
    expect(relations.length).toBeGreaterThan(0);
    for (const relation of relations) expect(relation.traversable).toBe(RELATION_ROLE[relation.kind as keyof typeof RELATION_ROLE] !== 'informational');
    const exported = store.graphExport().json.relations as unknown as Array<{ kind: string; traversable: boolean }>;
    expect(exported.some(relation => relation.traversable === false)).toBe(false);
    expect(exported.some(relation => relation.traversable === true)).toBe(true);
  }));
});
