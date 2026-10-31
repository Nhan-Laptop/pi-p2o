import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  deriveExploration, explorationNodeId, EXPLORATION_GRAPH_VERSION, type ExplorationOrigin,
} from '../../src/exploration-graph.js';
import type { AssessmentRecord } from '../../src/records.js';
import { AssessmentStore, type StoreManifest } from '../../src/state/store.js';
import { sha256Hex } from '../../src/validate.js';

/**
 * planning_update.md P25 §3.3: a store whose derived projection was written by an older rule set renames its version in the
 * origin body. A writable open replays only the derived rows from `records` (never a record, schema change or authority), a
 * read-only open never writes, and a store that is already current is repaired exactly once.
 */
const manifest: StoreManifest = { runId: 'run-graph-version', retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture-target',
  targetDisplay: 'inert fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } };
const at = '2030-01-01T00:00:00.000Z';
const originFor = (value: StoreManifest): ExplorationOrigin => ({ runId: value.runId, targetKind: value.targetKind,
  targetIdentityHash: sha256Hex(value.targetIdentity), targetDisplay: value.targetDisplay });

const planRecord = (id: string, order: number, patch: Partial<AssessmentRecord> = {}): AssessmentRecord =>
  ({ version: 2, id: `rec-${id}`, runId: manifest.runId, at, by: 'owner', kind: 'note', text: `${id} step ${order}`, ...patch,
    data: { plan: { runId: manifest.runId, id, revision: 1, kind: 'todo', title: `${id} step ${order}`, status: 'open',
      reason: 'A bounded fixture step', chainOf: 'chain-version', step: order } } });

const importedLink = (entityId: string, order: number) => ({ id: explorationNodeId('link', 'run-prior', entityId), kind: 'link' as const,
  state: 'open', entityId, sequence: 1, createdSequence: 1, updatedSequence: 1,
  body: { planId: entityId, chainOf: 'chain-version', step: order, status: 'open' } });

async function withStore(work: (root: string, store: AssessmentStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-exploration-version-'));
  const store = AssessmentStore.create(root, manifest);
  try { await work(root, store); } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

/** Rewrite the origin body's derivation version as an older build would have written it (test-only, direct SQLite). */
async function downgradeOrigin(root: string): Promise<void> {
  const db = new DatabaseSync(join(root, manifest.runId, 'assessment.sqlite'));
  try {
    const row = db.prepare("SELECT id,body FROM exploration_nodes WHERE run_id=? AND kind='origin' AND inherited_from IS NULL").get(manifest.runId) as { id: string; body: string } | undefined;
    if (!row) throw Error('fixture origin missing');
    db.prepare('UPDATE exploration_nodes SET body=? WHERE run_id=? AND id=?').run(JSON.stringify({ ...JSON.parse(row.body), graphVersion: 1 }), manifest.runId, row.id);
  } finally { db.close(); }
}

describe('P25 §3.3 derived-graph version and repair', () => {
  it('writes the current version, never repairs a current store, and keeps leads_to edges', async () => {
    await withStore(async (_root, store) => {
      store.commitRecords([planRecord('plan-a', 1), planRecord('plan-b', 2)]);
      expect(store.explorationHealth()).toMatchObject({ graphVersion: EXPLORATION_GRAPH_VERSION, stale: false, derivedRebuilds: 0, deferred: 0 });
      expect(store.explorationSnapshot().graphVersion).toBe(EXPLORATION_GRAPH_VERSION);
      expect(store.explorationSnapshot().edges.filter(edge => edge.rel === 'leads_to')).toHaveLength(1);
      expect(store.rebuildExploration()).toMatchObject({ chainOrderTruncated: 0, edges: 1 });
    });
  });

  it('a read-only open of an older projection never writes and says the projection is stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-exploration-version-'));
    const seed = AssessmentStore.create(root, manifest);
    try { seed.commitRecords([planRecord('plan-a', 1), planRecord('plan-b', 2)]); } finally { seed.close(); }
    try {
      await downgradeOrigin(root);
      const path = join(root, manifest.runId, 'assessment.sqlite'), before = await readFile(path);
      const reader = AssessmentStore.open(root, manifest.runId, { readOnly: true });
      try {
        expect(reader.explorationHealth()).toMatchObject({ graphVersion: 1, stale: true, derivedRebuilds: 0 });
        expect(reader.explorationSnapshot().graphVersion).toBe(1);
        expect(reader.explorationSnapshot().edges.filter(edge => edge.rel === 'leads_to')).toHaveLength(1);
      } finally { reader.close(); }
      expect(await readFile(path)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('a writable open replays the derived rows once and then leaves the store current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-exploration-version-'));
    const seed = AssessmentStore.create(root, manifest);
    try { seed.commitRecords([planRecord('plan-a', 1), planRecord('plan-b', 2)]); } finally { seed.close(); }
    try {
      await downgradeOrigin(root);
      const recordsBefore = ((): AssessmentRecord[] => {
        const reader = AssessmentStore.open(root, manifest.runId, { readOnly: true });
        try { return reader.records(); } finally { reader.close(); }
      })();
      const writer = AssessmentStore.open(root, manifest.runId, { readOnly: false });
      try {
        expect(writer.explorationHealth()).toMatchObject({ graphVersion: EXPLORATION_GRAPH_VERSION, stale: false, derivedRebuilds: 1 });
        const snapshot = writer.explorationSnapshot();
        expect(snapshot.graphVersion).toBe(EXPLORATION_GRAPH_VERSION);
        expect(snapshot.edges.filter(edge => edge.rel === 'leads_to')).toHaveLength(1);
        // The repair wrote no record and changed no ledger row: same record ids, same count, same order.
        expect(writer.records().map(row => row.id)).toEqual(recordsBefore.map(row => row.id));
        // The repaired projection is the complete derivation, so a later rebuild changes nothing.
        const projection = deriveExploration({ records: writer.recordsSince(0, 10_000).map(row => ({ record: row.record, sequence: row.sequence })), origin: originFor(manifest) });
        expect(snapshot.edges).toEqual(projection.edges);
        expect(snapshot.nodes).toEqual(projection.nodes);
      } finally { writer.close(); }
      const second = AssessmentStore.open(root, manifest.runId, { readOnly: false });
      try { expect(second.explorationHealth()).toMatchObject({ graphVersion: EXPLORATION_GRAPH_VERSION, stale: false, derivedRebuilds: 1 }); }
      finally { second.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('never builds order edges from inherited link rows', async () => {
    await withStore(async (_root, store) => {
      store.inheritExploration([{ runId: 'run-prior', nodes: [importedLink('plan-prior-a', 1), importedLink('plan-prior-b', 2)], edges: [], anchors: [] }]);
      store.commitRecords([planRecord('plan-own', 1)]);
      const snapshot = store.explorationSnapshot();
      expect(snapshot.nodes.filter(node => node.inheritedFrom === 'run-prior' && node.kind === 'link')).toHaveLength(2);
      // The group the new link joins holds only this run's own rows, so no inherited pair can become order evidence.
      expect(snapshot.edges.filter(edge => edge.rel === 'leads_to')).toHaveLength(0);
    });
  });
});
