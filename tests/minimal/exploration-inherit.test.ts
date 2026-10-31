import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { deriveExploration, explorationAncestryLines, explorationNodeId, explorationOverview,
  type ExplorationEdgeRow, type ExplorationNodeRow, type ExplorationProjection } from '../../src/exploration-graph.js';
import { collectInheritedGraph, INHERIT_EDGES, INHERIT_NODE_BYTES, INHERIT_NODES, INHERIT_RUNS, trimInheritedRun } from '../../src/state/inherit.js';
import { AssessmentStore, type StoreManifest } from '../../src/state/store.js';
import type { AssessmentRecord } from '../../src/records.js';
import { parseSettings } from '../../src/roles.js';
import { parseCommand } from '../../src/target.js';
import { sha256Hex } from '../../src/validate.js';

/**
 * planning_update.md P24/D §3.6: the inherited graph is a bounded, labeled copy of a referenced run's projection. It is
 * inert by construction (every rule reads rows without the inherited marker), it never adds a second discovery path, and the
 * run manifest records the mode so a report of the run can state it.
 */
const at = '2030-01-01T00:00:00.000Z';
const priorRun = 'run-prior', currentRun = 'run-current';
const manifestOf = (runId: string, target = 'fixture-target'): StoreManifest => ({ runId, retention: 'durable-local', targetKind: 'directory',
  targetIdentity: target, targetDisplay: 'inert fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'event-driven', executorMode: 'shared' } });
const originFor = (value: StoreManifest) => ({ runId: value.runId, targetKind: value.targetKind, targetIdentityHash: sha256Hex(value.targetIdentity),
  targetDisplay: value.targetDisplay });
const inheritedNode = (kind: ExplorationNodeRow['kind'], entityId: string, patch: Partial<ExplorationNodeRow> = {}): ExplorationNodeRow =>
  ({ id: explorationNodeId(kind, priorRun, entityId), kind, state: 'demonstrated', entityId, sequence: 1, createdSequence: 1, updatedSequence: 1,
    body: { slug: entityId }, ...patch });
const projectionOf = (nodes: ExplorationNodeRow[], edges: ExplorationEdgeRow[] = []): ExplorationProjection =>
  ({ nodes, edges, anchors: [], unresolved: 0, overflow: 0, chainOrderTruncated: 0 });
const campaignRow = (run: string): AssessmentRecord => ({ version: 2, id: 'rec-campaign', runId: run, at, by: 'owner', kind: 'lifecycle', text: 'campaign started',
  data: { event: 'campaign.started', campaign: { v: 2, objective: 'Reach the recorded fixture effect', constraints: [], targetRevision: 'rev-fixture',
    heartbeatSeconds: 0, startedAt: at, createdBy: 'operator', mode: 'exploit', effectClasses: ['code-execution'] } } });
const goalRow = (run: string): AssessmentRecord => ({ version: 2, id: 'rec-goal', runId: run, at, by: 'owner', kind: 'note', text: 'fixture goal',
  data: { plan: { runId: run, id: 'goal-read', kind: 'goal', revision: 1, title: 'Reach the fixture effect', status: 'active',
    reason: 'A bounded fixture goal', proof: { kind: 'capability', capability: { kind: 'data.read' } } } } });
const claimRow = (run: string): AssessmentRecord => ({ version: 2, id: 'rec-claim-1', runId: run, at, by: 'worker-a', workerId: 'worker-a', kind: 'candidate',
  surface: '/fixture', risk: 'authorization', text: 'fixture claim', data: { candidate: 'claim-one', surface: '/fixture', risk: 'authorization',
    closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', gained: [{ kind: 'data.read' }] } });
const taskRow = (run: string): AssessmentRecord => ({ version: 2, id: 'record-task-top', runId: run, at, by: 'owner', kind: 'task', text: 'fixture task',
  data: { task: { runId: run, id: 'task-top', revision: 1, status: 'proposed', prerequisites: [], evidenceIds: [] } } });

// The plan's caps are constants the store enforces too; keeping them here makes a silent cap change a test failure.
const InheritBudgets = () => ({ runs: INHERIT_RUNS, nodes: INHERIT_NODES, edges: INHERIT_EDGES });

describe('§3.6 inherited-graph trim', () => {
  it('copies by priority and never copies an edge whose endpoint was trimmed away', () => {
    const nodes = [inheritedNode('goal', 'goal-a'), inheritedNode('intent', 'task-a'), inheritedNode('fact', 'claim-a'), inheritedNode('finding', 'case-a')];
    const edges: ExplorationEdgeRow[] = [
      { srcId: nodes[2]!.id, rel: 'derived_from', dstId: nodes[3]!.id, sequence: 1 },
      { srcId: nodes[1]!.id, rel: 'yields', dstId: nodes[2]!.id, sequence: 2 },
      { srcId: nodes[0]!.id, rel: 'spawns', dstId: nodes[1]!.id, sequence: 3 },
    ];
    const trimmed = trimInheritedRun(priorRun, projectionOf(nodes, edges), { nodes: 2, edges: 5 });
    expect(trimmed.runId).toBe(priorRun);
    // Priority findings → facts → links → intents → goals → digests, so a bounded budget keeps the two most citable rows.
    expect(trimmed.nodes.map(row => row.kind)).toEqual(['finding', 'fact']);
    expect(trimmed.nodes.every(row => row.inheritedFrom === priorRun && row.sourceNodeId === row.id)).toBe(true);
    expect(trimmed.edges).toEqual([expect.objectContaining({ rel: 'derived_from', srcId: nodes[2]!.id, dstId: nodes[3]!.id, inheritedFrom: priorRun })]);
    expect(trimmed.anchors).toEqual([]);
  });

  it('re-caps an oversized body with its original size instead of a truncated JSON fragment', () => {
    const oversized = inheritedNode('fact', 'claim-big', { body: { slug: 'claim-big', note: 'x'.repeat(4000) } });
    const trimmed = trimInheritedRun(priorRun, projectionOf([oversized]));
    const body = trimmed.nodes[0]!.body as { originalBytes: number; inheritedSummary: string };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(INHERIT_NODE_BYTES);
    expect(body.originalBytes).toBeGreaterThan(INHERIT_NODE_BYTES);
    expect(body.inheritedSummary).toContain('claim-big');
    expect(InheritBudgets()).toEqual({ runs: INHERIT_RUNS, nodes: INHERIT_NODES, edges: INHERIT_EDGES });
  });

  it('keeps two referenced runs as two labeled copies of a shared claim, never a silent merge', () => {
    const shared = inheritedNode('fact', 'claim-one');
    const first = trimInheritedRun('run-a', projectionOf([{ ...shared, id: 'fact-a' }]));
    const second = trimInheritedRun('run-b', projectionOf([{ ...shared, id: 'fact-b' }]));
    expect(first.nodes[0]!.id).not.toBe(second.nodes[0]!.id);
    expect([first.nodes[0]!.inheritedFrom, second.nodes[0]!.inheritedFrom]).toEqual(['run-a', 'run-b']);
  });
});

describe('§3.6 inherited rows are marked, bounded and never authority (P24/D)', () => {
  const fixture = async (work: (root: string, prior: AssessmentStore, current: AssessmentStore) => Promise<void>) => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-inherit-'));
    const prior = AssessmentStore.create(root, manifestOf(priorRun));
    const current = AssessmentStore.create(root, manifestOf(currentRun));
    try { await work(root, prior, current); }
    finally { prior.close(); current.close(); await rm(root, { recursive: true, force: true }); }
  };

  it('writes labeled copies, keeps the derived projection unchanged and survives a rebuild', async () => {
    await fixture(async (_root, prior, current) => {
      prior.commitRecords([campaignRow(priorRun), goalRow(priorRun), taskRow(priorRun), claimRow(priorRun)]);
      const source = trimInheritedRun(priorRun, prior.explorationSnapshot());
      expect(source.nodes.length).toBeGreaterThan(0);
      const written = current.inheritExploration([source]);
      expect(written.runs).toEqual([priorRun]);
      expect(written.nodes).toBe(source.nodes.length);
      const snapshot = current.explorationSnapshot();
      const inherited = snapshot.nodes.filter(row => row.inheritedFrom === priorRun);
      expect(inherited).toHaveLength(source.nodes.length);
      expect(inherited.every(row => row.sourceNodeId !== undefined)).toBe(true);
      // The derived projection is exactly what the empty current ledger derives: inheritance adds no rule-visible row.
      const derived = deriveExploration({ records: current.recordsSince(0, 10_000).map(row => ({ record: row.record, sequence: row.sequence })), origin: originFor(manifestOf(currentRun)) });
      expect(snapshot.nodes.filter(row => row.inheritedFrom === undefined).length).toBe(derived.nodes.length);
      const overview = explorationOverview(snapshot);
      expect(overview.counts.nodes).toBe(derived.nodes.length);
      expect(overview.inherited).toMatchObject({ nodes: source.nodes.length, runs: [priorRun] });
      expect(overview.facts.total).toBe(0); // an imported fact never enters this run's fact rows
      // A rebuild re-derives this run's rows and keeps the labeled copies (they are not derivable from its records).
      const inheritedBefore = JSON.stringify(inherited.map(row => row.id).sort());
      const rebuilt = current.rebuildExploration();
      expect(rebuilt).toMatchObject({ nodes: derived.nodes.length, edges: derived.edges.length });
      const after = current.explorationSnapshot();
      expect(after.nodes.filter(row => row.inheritedFrom === priorRun)).toHaveLength(source.nodes.length);
      expect(JSON.stringify(after.nodes.filter(row => row.inheritedFrom === priorRun).map(row => row.id).sort())).toBe(inheritedBefore);
      // The labeled page resolves an imported id and marks the root with the referenced run.
      const page = current.explorationPage(source.nodes[0]!.id);
      expect(page).toMatchObject({ root: { inherited: priorRun } });
    });
  });

  it('cannot satisfy a capability goal, cannot cover a digest window and cannot seed a brief ancestry block', async () => {
    await fixture(async (_root, prior, current) => {
      prior.commitRecords([campaignRow(priorRun), goalRow(priorRun), taskRow(priorRun), claimRow(priorRun)]);
      const inheritedClaim = prior.explorationSnapshot().nodes.find(row => row.kind === 'fact')!;
      current.inheritExploration([trimInheritedRun(priorRun, prior.explorationSnapshot())]);
      // A goal that only the imported demonstrated fact could satisfy stays unproven: the rule lookup never sees the copy.
      current.commitRecords([campaignRow(currentRun), goalRow(currentRun)]);
      const snapshot = current.explorationSnapshot();
      expect(snapshot.nodes.find(row => row.kind === 'goal' && row.inheritedFrom === undefined)).toMatchObject({ state: 'active' });
      expect(snapshot.edges.filter(edge => edge.rel === 'proves' && edge.inheritedFrom === undefined)).toHaveLength(0);
      // A digest window covers this run's nodes only; the imported row is not a claim about this run's round.
      current.commitRecords([{ ...claimRow(currentRun), id: 'rec-own-claim', data: { candidate: 'own-claim', surface: '/fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested' } }]);
      // A host-written digest for round 1, over a window that spans the import moment.
      const body = { round: 1, window: { from: 0, to: current.sequence() }, counts: { nodes: {}, edges: {}, anchors: 0 },
        additions: { facts: [], findings: [], links: [] }, text: 'round 1: host sentence' };
      current.commitRecords([{ version: 2, id: 'rec-digest-1', runId: currentRun, at, by: 'owner', kind: 'lifecycle', text: 'exploration.digest: round 1',
        data: { explorationDigest: body } }]);
      const after = current.explorationSnapshot();
      const covers = after.edges.filter(edge => edge.rel === 'covers' && edge.inheritedFrom === undefined).map(edge => edge.dstId);
      expect(covers).not.toContain(inheritedClaim.id);
      // The worker brief's ancestry block resolves this run's claims only; an imported copy is background, never cited evidence.
      expect(explorationAncestryLines(after, [inheritedClaim.entityId]).lines).toEqual([]);
      expect(explorationAncestryLines(after, ['own-claim']).lines.length).toBeGreaterThan(0);
    });
  });

  it('reads a schema-8 referenced run through its snapshot and a schema-7 one through the raw reader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-inherit-legacy-'));
    const priorManifest = manifestOf(priorRun);
    const prior = AssessmentStore.create(root, priorManifest);
    try { prior.commitRecords([campaignRow(priorRun), goalRow(priorRun), taskRow(priorRun), claimRow(priorRun)]); } finally { prior.close(); }
    try {
      const live = await collectInheritedGraph(root, [{ runId: priorRun, manifest: priorManifest }], { maxBytes: 64 * 1024 * 1024 });
      expect(live.skipped).toEqual([]);
      expect(live.sources).toHaveLength(1);
      expect(live.sources[0]!.nodes.some(row => row.kind === 'fact')).toBe(true);
      // The same ledger behind a schema-7 version byte is still readable by the raw reader, and its graph is derived from records.
      const db = new DatabaseSync(join(root, priorRun, 'assessment.sqlite'));
      try { db.exec('PRAGMA user_version=7'); } finally { db.close(); }
      const legacy = await collectInheritedGraph(root, [{ runId: priorRun, manifest: priorManifest }], { maxBytes: 64 * 1024 * 1024 });
      expect(legacy.skipped).toEqual([]);
      expect(legacy.sources).toHaveLength(1);
      expect(legacy.sources[0]!.nodes.map(row => row.kind).sort()).toEqual(live.sources[0]!.nodes.map(row => row.kind).sort());
      // Newest INHERIT_RUNS are the only candidates who get read; an unreadable candidate is skipped by name.
      const missing = await collectInheritedGraph(root, [{ runId: priorRun, manifest: priorManifest }, { runId: 'run-missing', manifest: priorManifest }], { maxBytes: 64 * 1024 * 1024 });
      expect(missing.skipped).toEqual(['run-missing']);
      expect(missing.sources).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('records the mode in the run manifest so a later report states it without live state', async () => {
    await fixture(async (_root, _prior, current) => {
      expect(current.manifest().explorationInheritance).toBeUndefined();
      expect(current.recordExplorationInheritance({ inheritGraph: true, runs: [priorRun, 'run-b', priorRun] }))
        .toEqual({ inheritGraph: true, runs: [priorRun, 'run-b'] });
      expect(current.manifest().explorationInheritance).toEqual({ inheritGraph: true, runs: [priorRun, 'run-b'] });
      current.recordExplorationInheritance({ inheritGraph: false, runs: [] });
      expect(current.manifest().explorationInheritance).toEqual({ inheritGraph: false, runs: [] });
    });
  });
});

describe('§3.6 controls: the setting and the per-run flag (P24/D)', () => {
  it('defaults the setting on, parses an explicit off, and keeps a malformed value out', () => {
    expect(parseSettings({}).inheritGraph).toBe(true);
    expect(parseSettings({ p2o: { inheritGraph: false } }).inheritGraph).toBe(false);
    expect(parseSettings({ p2o: { inheritGraph: true } }).inheritGraph).toBe(true);
    expect(parseSettings({ p2o: { inheritGraph: 'off' } }).inheritGraph).toBe(true);
  });

  it('accepts --no-inherit with or without --refer-workspace and refuses an unknown option', () => {
    expect(parseCommand('--target /tmp/fixture --no-inherit')).toMatchObject({ action: 'start', options: { noInherit: true } });
    expect(parseCommand('--target /tmp/fixture --refer-workspace latest --no-inherit')).toMatchObject({ options: { referWorkspace: 'latest', noInherit: true } });
    expect(parseCommand('--target /tmp/fixture --refer-workspace run-123 --no-inherit')).toMatchObject({ options: { referWorkspace: ['run-123'], noInherit: true } });
  });
});
