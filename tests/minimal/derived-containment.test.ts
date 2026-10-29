import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssessmentStore } from '../../src/state/store.js';
import type { AssessmentRecord } from '../../src/records.js';

/**
 * planning_update.md P21/A3/D-P21-10: containment is derived from anchors at write time, structural and never evidential.
 * The fixtures record the same asset/anchor shapes the run measured (a host keyed by hostname, routes with url+path anchors,
 * endpoints with path anchors) and read the edges back through the public graph reads, not through SQL.
 */
const runId = 'run-derived';
async function fixture(work: (h: { store: AssessmentStore; receipt: () => string; root: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-derived-'));
  const store = AssessmentStore.create(root, { runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture',
    targetDisplay: 'fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } });
  const receipt = () => store.commitRecords([{ id: randomUUID(), runId, at: '2030-01-01', by: 'owner', kind: 'evidence',
    text: 'Bounded inert receipt, not finding proof' } as AssessmentRecord])[0].recordId;
  try { await work({ store, receipt, root }); } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}
const graph = (store: AssessmentStore) => store.recordGraph({ assets: [
  { asset: { kind: 'host', key: 'fixture.test', anchors: [{ kind: 'url', value: 'https://fixture.test' }] } },
  { asset: { kind: 'route', key: '/fixture', anchors: [{ kind: 'url', value: 'https://fixture.test/fixture' }, { kind: 'path', value: '/fixture' }] } },
  { asset: { kind: 'endpoint', key: 'GET /fixture/orders', anchors: [{ kind: 'path', value: '/fixture/orders' }] } },
] }).filter(row => row.kind === 'asset');

describe('P21/A3 derived containment (store)', () => {
  it('derives host → route → endpoint from the anchors, and every hop is labelled derived', async () => {
    await fixture(async ({ store }) => {
      const [host, route, endpoint] = graph(store);
      const walk = store.graphPath({ fromId: host.entityId, toId: endpoint.entityId });
      expect(walk.paths).toHaveLength(1);
      const hops = walk.paths[0]!.hops;
      expect(hops.map(hop => [hop.from.kind, hop.relation.kind, hop.to.kind])).toEqual([['host', 'contains', 'route'], ['route', 'contains', 'endpoint']]);
      expect(hops.every(hop => hop.relation.derived === true)).toBe(true);
      // Structure, not evidence: a derived row cites nothing, and a route that an anchor does not state is not invented.
      expect(hops.every(hop => hop.relation.evidenceRefs.length === 0)).toBe(true);
      expect(route.entityId).not.toBe(endpoint.entityId);
    });
  });

  it('derives nothing without an anchor, and resolves a host only when that host asset already exists', async () => {
    await fixture(async ({ store }) => {
      const [host, route] = store.recordGraph({ assets: [
        { asset: { kind: 'host', key: 'fixture.test' } },
        { asset: { kind: 'route', key: '/fixture' } },
        { asset: { kind: 'endpoint', key: 'GET /other', anchors: [{ kind: 'path', value: '/other/orders' }, { kind: 'url', value: 'https://other.test/orders' }] } },
      ] }).filter(row => row.kind === 'asset');
      expect(store.graphPath({ fromId: host.entityId, toId: route.entityId }).markers.noPath).toBe(true);
      // The URL anchor names other.test, which was never recorded as an asset: no guessed host, so no edge.
      const summary = store.graphSummary();
      expect(summary.relations).toBe(0);
    });
  });

  it('lets an asserted relation win on the same endpoints and never rewrites it on a later asset revision', async () => {
    await fixture(async ({ store, receipt }) => {
      const [, route, endpoint] = graph(store);
      expect(store.graphPath({ fromId: route.entityId, toId: endpoint.entityId }).paths[0]!.hops[0]!.relation.derived).toBe(true);
      const evidence = receipt();
      store.recordGraph({ relations: [{ kind: 'contains', fromId: route.entityId, toId: endpoint.entityId, basis: 'observed', evidenceRefs: [evidence] }] });
      const asserted = store.graphPath({ fromId: route.entityId, toId: endpoint.entityId });
      expect(asserted.paths[0]!.hops[0]!.relation.derived).toBeUndefined();
      expect(asserted.paths[0]!.hops[0]!.relation.basis).toBe('observed');
      // A later revision of the endpoint retriggers the derivation pass: the asserted row is the head and must stay the head.
      // Its revision pin then makes the walk honestly stale (excluded, not silently replaced by a derived row).
      store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /fixture/orders', label: 'revised endpoint label', expectedRevision: 1 } }] });
      const walk = store.graphPath({ fromId: route.entityId, toId: endpoint.entityId });
      expect(walk.paths).toEqual([]);
      expect(walk.excluded.stale).toBeGreaterThanOrEqual(1);
      const exported = store.graphExport();
      const row = exported.json.relations.find((relation: any) => relation.fromId === route.entityId && relation.toId === endpoint.entityId)!;
      expect(row.basis).toBe('observed');
      expect(row.derived).toBeUndefined();
      expect(row.evidenceRefs).toEqual([evidence]);
    });
  });

  it('marks derived rows in the export render and counts them without making them evidence', async () => {
    await fixture(async ({ store }) => {
      graph(store);
      const exported = store.graphExport();
      expect(exported.json.relations).toHaveLength(2);
      expect(exported.json.relations.every((relation: any) => relation.derived === true && (relation.evidenceRefs ?? []).length === 0)).toBe(true);
      expect(exported.mermaid).toContain('DERIVED');
      expect(exported.json.warning).toContain('not verified findings');
      // The summary counts structural rows; it is not a count of demonstrated edges.
      expect(store.graphSummary().relations).toBe(2);
    });
  });
});
