import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  digestNodeId, deriveExploration, explorationNodeId, EXPLORATION_GRAPH_VERSION, EXPLORATION_NODE_KINDS, EXPLORATION_NODE_LIMIT,
  EXPLORATION_EDGE_LIMIT, EXPLORATION_NODE_BYTES, EXPLORATION_RELATIONS, EXPLORATION_STATES, PROVES_FACT_SCAN,
  explorationOverview, explorationFrontier, explorationLineage, explorationAncestryLines, renderOverviewLines,
  EXPLORATION_PROJECTION_LABEL, EXPLORATION_VIEW_BYTES, EXPLORATION_ANCESTRY_BYTES,
  type ExplorationOrigin, type ExplorationProjection, type ExplorationSnapshot,
} from '../../src/exploration-graph.js';
import type { ChainProgress, ChainStep } from '../../src/chain-board.js';
import type { AssessmentRecord } from '../../src/records.js';
import { AssessmentStore, type StoreManifest } from '../../src/state/store.js';
import { sha256Hex } from '../../src/validate.js';

/**
 * planning_update.md P24/B: the exploration graph is a host-derived projection of the committed ledger. These tests pin the
 * closed vocabularies, the deterministic identity, each §3.4 rule, the bounded `proves` evaluation, the unresolved count, the
 * caps, and — most importantly — that the store's incremental projection equals a complete rebuild from `records` after an
 * arbitrary record stream (the differential oracle).
 */
const runId = 'run-explore';
const assetA = `asset-${'a'.repeat(24)}`;
const at = '2030-01-01T00:00:00.000Z';
const originOf = (id = runId): ExplorationOrigin => ({ runId: id, targetKind: 'directory', targetIdentityHash: sha256Hex('fixture-target'), targetDisplay: 'inert fixture' });

const base = (id: string, patch: Partial<AssessmentRecord>): AssessmentRecord =>
  ({ version: 2, id, runId, at, by: 'owner', kind: 'note', text: id, ...patch });
const planRow = (recordId: string, plan: Record<string, unknown>): AssessmentRecord =>
  base(recordId, { data: { plan: { runId, revision: 1, ...plan } } });
const taskRow = (id: string, extra: Record<string, unknown> = {}): AssessmentRecord =>
  base(`record-${id}`, { kind: 'task', data: { task: { runId, id, revision: 1, status: 'proposed', prerequisites: [], evidenceIds: [], ...extra } } });
const claimRow = (recordId: string, slug: string, data: Record<string, unknown> = {}, patch: Partial<AssessmentRecord> = {}): AssessmentRecord =>
  base(recordId, { by: 'worker-a', workerId: 'worker-a', kind: 'candidate', surface: '/fixture', risk: 'authorization', ...patch,
    data: { candidate: slug, surface: '/fixture', risk: 'authorization', ...data } });
const caseDraft = (assetRefs: Array<{ id: string; revision?: number }> = [{ id: assetA, revision: 1 }]): Record<string, unknown> => ({
  title: 'Fixture case over the recorded boundary', policyKey: 'policy:fixture', rootCauseKey: 'root:fixture',
  assetRefs, claimRefs: ['rec-claim-1'], independentEvidenceRefs: [], taskRefs: [{ taskId: 'task-top', revision: 1 }],
  reportRefs: [], contradictions: [], affectedVariants: [], relatedCaseIds: [], verdict: 'confirmed', reviewStatus: 'accepted',
  reviewReason: 'Owner reviewed the exact fixture support for this case', limitations: 'Only the inert fixture receipt is covered',
  remediation: { status: 'unplanned', reason: 'No remediation was implemented or reviewed for this fixture', evidenceRefs: [] },
});
const caseRow = (recordId: string, id: string, overrides: Record<string, unknown> = {}): AssessmentRecord =>
  base(recordId, { data: { case: { runId, id, revision: 1, ...caseDraft(), ...overrides } } });
const project = (rows: readonly AssessmentRecord[], origin = originOf(), caps?: { nodes: number; edges: number; anchors: number }): ExplorationProjection =>
  deriveExploration({ records: rows.map((record, index) => ({ record, sequence: index + 1 })), origin, ...(caps ? { caps } : {}) });
const label = (p: ExplorationProjection, id: string): string => {
  const node = p.nodes.find(row => row.id === id);
  return node ? `${node.kind}:${node.entityId}` : `missing:${id}`;
};
const labels = (p: ExplorationProjection): string[] =>
  p.edges.map(edge => `${label(p, edge.srcId)} -${edge.rel}-> ${label(p, edge.dstId)}`);
const node = (p: ExplorationProjection, kind: string, entityId: string) => p.nodes.find(row => row.kind === kind && row.entityId === entityId);

describe('the closed vocabulary and deterministic identity (P24/B §3.1-§3.2)', () => {
  it('declares one kind, relation and state vocabulary and derives ids without a clock', () => {
    expect(EXPLORATION_NODE_KINDS).toEqual(['origin', 'goal', 'link', 'intent', 'fact', 'finding', 'digest']);
    expect(EXPLORATION_RELATIONS).toEqual(['spawns', 'derived_from', 'yields', 'proves', 'covers']);
    expect(EXPLORATION_STATES.goal).toContain('met');
    expect(EXPLORATION_STATES.digest).toEqual(['active', 'superseded']);
    expect(EXPLORATION_GRAPH_VERSION).toBe(1);
    // §3.1 fixes the identity shape, so an id can be recomputed by a reader that never wrote it.
    expect(explorationNodeId('goal', runId, 'goal-a')).toBe(`goal-${sha256Hex(`${runId}\u0000goal\u0000goal-a`).slice(0, 24)}`);
    expect(explorationNodeId('goal', runId, 'goal-a')).toBe(explorationNodeId('goal', runId, 'goal-a'));
    expect(explorationNodeId('goal', runId, 'goal-a')).not.toBe(explorationNodeId('goal', runId, 'goal-b'));
    expect(digestNodeId('run-1234567890abcdef', 3)).toBe('digest-run-1234-3');
  });

  it('is deterministic: the same record stream produces byte-identical rows twice', () => {
    const rows = [planRow('rec-goal', { id: 'goal-1', kind: 'goal', title: 'Fixture goal', status: 'active', reason: 'A bounded fixture goal', proof: { kind: 'capability', capability: { kind: 'data.read' } } }),
      claimRow('rec-claim-1', 'claim-one', { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'data.read' }] })];
    const first = project(rows), second = project(rows);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.unresolved).toBe(0);
    expect(first.overflow).toBe(0);
  });
});

describe('§3.3/§3.4 node and edge rules', () => {
  /** Goal → task → demonstrated claim → chain link → child task → case: one record of every projecting kind. */
  const chain = (): AssessmentRecord[] => [
    planRow('rec-goal-cap', { id: 'goal-cap', kind: 'goal', title: 'Reach the fixture effect', status: 'active', reason: 'A bounded fixture goal', proof: { kind: 'capability', capability: { kind: 'data.read' } } }),
    taskRow('task-top', { work: { assetRefs: [{ id: assetA, revision: 1 }] } }),
    claimRow('rec-claim-1', 'claim-one', { closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', gained: [{ kind: 'data.read' }], taskRef: 'task-top', assetRefs: [{ id: assetA, revision: 1 }] }),
    planRow('rec-plan-link', { id: 'plan-link', kind: 'todo', title: 'Step one of the chain', status: 'open', reason: 'A bounded fixture step', chainOf: 'chain-1', step: 1, effect: 'code-execution', claimRefs: ['rec-claim-1'], taskIds: ['task-top'] }),
    taskRow('task-child', { prerequisites: [{ taskId: 'task-top', revision: 1 }], parentTaskId: 'task-top', work: { claimRefs: ['rec-claim-1'] } }),
    planRow('rec-goal-case', { id: 'goal-case', kind: 'goal', title: 'Settle the fixture case', status: 'active', reason: 'A bounded fixture goal', proof: { kind: 'case', ref: 'case-1' } }),
    caseRow('rec-case-1', 'case-1'),
    claimRow('rec-claim-1-v2', 'claim-one', { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'data.read' }] }, { supersedes: 'rec-claim-1' }),
  ];

  it('projects every record kind and writes the parent→child edges of §3.4', () => {
    const p = project(chain()), edges = labels(p);
    expect(node(p, 'origin', runId)).toMatchObject({ state: 'current', createdSequence: 1 });
    expect(node(p, 'goal', 'goal-cap')).toMatchObject({ state: 'met' });
    expect(node(p, 'goal', 'goal-case')).toMatchObject({ state: 'met' });
    expect(node(p, 'intent', 'task-top')).toMatchObject({ state: 'proposed', body: { taskId: 'task-top', claimRefs: [] } });
    expect(node(p, 'link', 'plan-link')).toMatchObject({ state: 'open', body: { chainOf: 'chain-1', step: 1, effect: 'code-execution' } });
    expect(node(p, 'fact', 'claim-one')).toMatchObject({ state: 'demonstrated', body: { slug: 'claim-one', gained: [{ kind: 'data.read' }] } });
    expect(node(p, 'finding', 'case-1')).toMatchObject({ state: 'accepted', body: { verdict: 'confirmed' } });
    expect(edges).toEqual(expect.arrayContaining([
      `origin:${runId} -spawns-> goal:goal-cap`,
      `origin:${runId} -spawns-> intent:task-top`,
      `origin:${runId} -spawns-> goal:goal-case`,
      `intent:task-top -yields-> fact:claim-one`,
      `fact:claim-one -derived_from-> intent:task-child`,
      `intent:task-top -derived_from-> intent:task-child`,
      `fact:claim-one -derived_from-> link:plan-link`,
      `link:plan-link -derived_from-> intent:task-top`,
      `intent:task-top -yields-> finding:case-1`,
      `fact:claim-one -derived_from-> finding:case-1`,
      `fact:claim-one -proves-> goal:goal-cap`,
      `finding:case-1 -proves-> goal:goal-case`,
    ]));
    // The child task cites its parent, so it is derived rather than spawned.
    expect(edges).not.toContain(`origin:${runId} -spawns-> intent:task-child`);
    // The revision updates one node instead of creating a second fact.
    const facts = p.nodes.filter(row => row.kind === 'fact');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ entityId: 'claim-one', recordId: 'rec-claim-1-v2', createdSequence: 3, updatedSequence: 8 });
    // The claim's host-stamped asset is an anchor on the fact node; the case's asset on the finding node.
    expect(p.anchors.map(anchor => [label(p, anchor.nodeId), anchor.assetEntity]).sort()).toEqual([
      ['fact:claim-one', assetA], ['finding:case-1', assetA], ['intent:task-top', assetA],
    ]);
  });

  it('drops an unknown edge target and counts it instead of fabricating a node', () => {
    const rows = [...chain().slice(0, 4),
      planRow('rec-plan-unresolved', { id: 'plan-unresolved', kind: 'todo', title: 'Step citing nothing on record', status: 'open', reason: 'A bounded fixture step', chainOf: 'chain-1', step: 2, claimRefs: ['unknown-claim-record'] })];
    const p = project(rows);
    expect(p.unresolved).toBe(1);
    expect(p.nodes.some(row => row.entityId === 'unknown-claim-record')).toBe(false);
    expect(labels(p)).not.toContain('fact:unknown-claim-record -derived_from-> link:plan-unresolved');
  });

  it('writes no node for an ordinary (non-chain) todo and none for a decision row', () => {
    const p = project([
      planRow('rec-todo-plain', { id: 'todo-plain', kind: 'todo', title: 'An ordinary planning row', status: 'open', reason: 'A bounded fixture row' }),
      planRow('rec-decision', { id: 'decision-1', kind: 'decision', title: 'A recorded decision', status: 'recorded', reason: 'A bounded fixture row' }),
    ]);
    expect(p.nodes.filter(row => row.kind === 'link')).toEqual([]);
    expect(p.nodes.filter(row => row.kind === 'goal')).toEqual([]);
    expect(p.nodes.map(row => row.kind)).toEqual(['origin']);
  });

  it('updates the origin objective when the campaign frame is recorded, without a second origin', () => {
    const campaign = { v: 2, objective: 'Reach the recorded fixture effect', constraints: [], targetRevision: 'rev-fixture', heartbeatSeconds: 0,
      startedAt: at, createdBy: 'operator', mode: 'exploit', effectClasses: ['code-execution'] };
    const p = project([base('rec-campaign', { kind: 'lifecycle', text: 'campaign started', data: { event: 'campaign.started', campaign } }),
      planRow('rec-goal', { id: 'goal-1', kind: 'goal', title: 'Fixture goal', status: 'active', reason: 'A bounded fixture goal', proof: { kind: 'capability', capability: { kind: 'data.read' } } })]);
    const origins = p.nodes.filter(row => row.kind === 'origin');
    expect(origins).toHaveLength(1);
    expect(origins[0]!.body).toMatchObject({ objective: 'Reach the recorded fixture effect', mode: 'exploit', targetKind: 'directory', graphVersion: 1 });
    expect(origins[0]).toMatchObject({ createdSequence: 1, updatedSequence: 1 });
  });
});

describe('§3.4.1 the bounded proves evaluation', () => {
  it('writes the capability edge when the goal is committed after its demonstration', () => {
    const p = project([
      claimRow('rec-claim-1', 'claim-one', { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'data.read' }] }),
      planRow('rec-goal', { id: 'goal-cap', kind: 'goal', title: 'Reach the fixture effect', status: 'active', reason: 'A bounded fixture goal', proof: { kind: 'capability', capability: { kind: 'data.read' } } }),
    ]);
    expect(node(p, 'goal', 'goal-cap')?.state).toBe('met');
    expect(labels(p)).toContain('fact:claim-one -proves-> goal:goal-cap');
  });

  it('records provesTruncated instead of inventing a negative when the source is outside the scan', () => {
    const rows: AssessmentRecord[] = [claimRow('rec-claim-match', 'claim-match', { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'data.read' }] })];
    // 500 newer demonstrated facts without the required capability push the matching one out of the newest window.
    for (let index = 0; index < PROVES_FACT_SCAN; index += 1)
      rows.push(claimRow(`rec-claim-other-${index}`, `claim-other-${index}`, { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'file.read' }] }));
    rows.push(planRow('rec-goal', { id: 'goal-cap', kind: 'goal', title: 'Reach the fixture effect', status: 'active', reason: 'A bounded fixture goal', proof: { kind: 'capability', capability: { kind: 'data.read' } } }));
    const p = project(rows), goal = node(p, 'goal', 'goal-cap');
    expect(goal?.state).toBe('active');
    expect(goal?.body).toMatchObject({ provesTruncated: true });
    expect(labels(p)).not.toContain('fact:claim-match -proves-> goal:goal-cap');
    expect(p.unresolved).toBe(0);
  });

  it('holds a coverage proof in the goal body and writes no edge, because a plan is not executed evidence', () => {
    const coveragePlan = base('rec-cov-plan', { data: { coveragePlan: { id: 'cov-plan', runId, revision: 1, targetRevision: 'rev-fixture', status: 'active', title: 'Fixture coverage plan', cellIds: ['cov-cell-1', 'cov-cell-2'] } } });
    const cell = (id: string, execution: string) => base(`rec-${id}`, { data: { coverageCell: { id, runId, revision: 1, planId: 'cov-plan', planRevision: 1, targetRevision: 'rev-fixture', execution, assessment: 'accepted' } } });
    const goal = planRow('rec-goal', { id: 'goal-cov', kind: 'goal', title: 'Map the fixture surface', status: 'active', reason: 'A bounded fixture goal', proof: { kind: 'coverage', ref: 'cov-plan' } });
    const holds = project([coveragePlan, cell('cov-cell-1', 'tested'), cell('cov-cell-2', 'blocked'), goal]);
    expect(node(holds, 'goal', 'goal-cov')?.body).toMatchObject({ proofHolds: 'coverage' });
    expect(holds.edges.filter(edge => edge.rel === 'proves')).toEqual([]);
    const open = project([coveragePlan, cell('cov-cell-1', 'tested'), cell('cov-cell-2', 'not_tested'), goal]);
    expect(node(open, 'goal', 'goal-cov')?.body).not.toHaveProperty('proofHolds');
  });
});

describe('§3.9 caps and overflow', () => {
  it('stops at the node cap and reports overflow rather than returning an over-bound page', () => {
    const rows = Array.from({ length: 5 }, (_, index) => taskRow(`task-${index}`));
    const p = project(rows, originOf(), { nodes: 2, edges: 10, anchors: 10 });
    expect(p.nodes.length).toBe(2);
    expect(p.overflow).toBeGreaterThan(0);
    expect(EXPLORATION_NODE_LIMIT).toBe(4000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The store's incremental projection must equal a complete rebuild from the same ledger (P24/B acceptance).
const manifest: StoreManifest = { runId: 'run-graph-store', retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture-target',
  targetDisplay: 'inert fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } };
const originFor = (value: StoreManifest): ExplorationOrigin => ({ runId: value.runId, targetKind: value.targetKind,
  targetIdentityHash: sha256Hex(value.targetIdentity), targetDisplay: value.targetDisplay, ...(value.profile.mode ? { mode: value.profile.mode } : {}) });
const campaignRow = (recordId: string, run: string): AssessmentRecord => base(recordId, { runId: run, kind: 'lifecycle', text: 'campaign started',
  data: { event: 'campaign.started', campaign: { v: 2, objective: 'Reach the recorded fixture effect', constraints: [], targetRevision: 'rev-fixture',
    heartbeatSeconds: 0, startedAt: at, createdBy: 'operator', mode: 'exploit', effectClasses: ['code-execution'] } } });

async function storeFixture(work: (store: AssessmentStore) => Promise<void>, run = manifest.runId) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-exploration-'));
  const value = { ...manifest, runId: run };
  const store = AssessmentStore.create(root, value);
  try { await work(store); } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

describe('store projection equals a rebuild from records (differential, P24/B)', () => {
  it('writes the same rows incrementally and on rebuild, through every projecting record kind', async () => {
    let snapshotBefore: ReturnType<AssessmentStore['explorationSnapshot']> | undefined;
    await storeFixture(async store => {
      const run = manifest.runId;
      const withRun = (row: AssessmentRecord): AssessmentRecord => ({ ...row, runId: run });
      const goalRow = (recordId: string, plan: Record<string, unknown>) => withRun(base(recordId, { data: { plan: { runId: run, revision: 1, ...plan } } }));
      const task = (id: string, extra: Record<string, unknown> = {}) =>
        withRun(base(`record-${id}`, { kind: 'task', data: { task: { runId: run, id, revision: 1, status: 'proposed', prerequisites: [], evidenceIds: [], ...extra } } }));
      const claim = (recordId: string, data: Record<string, unknown>, patch: Partial<AssessmentRecord> = {}) =>
        withRun(claimRow(recordId, 'claim-one', data, patch));
      const caseEntry = (id: string) => ({ ...withRun(caseRow('rec-case-1', id)), data: { case: { ...(caseRow('rec-case-1', id).data!.case as Record<string, unknown>), runId: run } } });
      // Two packets, so the incremental path is exercised across commits and the campaign frame lands before the origin is read.
      store.commitRecords([campaignRow('rec-campaign', run), goalRow('rec-goal-cap', { id: 'goal-cap', kind: 'goal', title: 'Reach the fixture effect', status: 'active', reason: 'A bounded fixture goal', proof: { kind: 'capability', capability: { kind: 'data.read' } } })]);
      store.commitRecords([task('task-top'), claim('rec-claim-1', { closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', gained: [{ kind: 'data.read' }], taskRef: 'task-top', assetRefs: [{ id: assetA, revision: 1 }] })]);
      store.commitRecords([
        goalRow('rec-plan-link', { id: 'plan-link', kind: 'todo', title: 'Step one of the chain', status: 'open', reason: 'A bounded fixture step', chainOf: 'chain-1', step: 1, effect: 'code-execution', claimRefs: ['rec-claim-1'], taskIds: ['task-top'] }),
        goalRow('rec-plan-unresolved', { id: 'plan-unresolved', kind: 'todo', title: 'Step citing nothing on record', status: 'open', reason: 'A bounded fixture step', chainOf: 'chain-1', step: 2, claimRefs: ['unknown-claim-record'] }),
        task('task-child', { prerequisites: [{ taskId: 'task-top', revision: 1 }], parentTaskId: 'task-top' }),
        goalRow('rec-goal-case', { id: 'goal-case', kind: 'goal', title: 'Settle the fixture case', status: 'active', reason: 'A bounded fixture goal', proof: { kind: 'case', ref: 'case-1' } }),
        caseEntry('case-1'),
        claim('rec-claim-1-v2', { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'data.read' }] }, { supersedes: 'rec-claim-1' }),
      ]);
      const incremental = store.explorationSnapshot();
      const projection = deriveExploration({ records: store.recordsSince(0, 10_000).map(row => ({ record: row.record, sequence: row.sequence })), origin: originFor(manifest) });
      expect(incremental.nodes).toEqual(projection.nodes);
      expect(incremental.edges).toEqual(projection.edges);
      expect(incremental.anchors).toEqual(projection.anchors);
      expect(incremental.unresolved).toBe(projection.unresolved);
      expect(incremental.overflow).toBe(projection.overflow);
      expect(incremental.counts).toEqual({ nodes: projection.nodes.length, edges: projection.edges.length, anchors: projection.anchors.length });
      expect(incremental.unresolved).toBe(1);
      expect(store.explorationHealth()).toMatchObject({ nodes: projection.nodes.length, edges: projection.edges.length, anchors: projection.anchors.length, unresolved: 1, failures: 0 });
      // The rebuilt projection is the same page, so a damaged or old store can always be repaired from the ledger.
      const rebuilt = store.rebuildExploration();
      expect(rebuilt).toMatchObject({ nodes: projection.nodes.length, edges: projection.edges.length, anchors: projection.anchors.length, unresolved: 1, overflow: 0 });
      const after = store.explorationSnapshot();
      expect(after).toEqual(incremental);
      expect(store.rebuildExploration()).toEqual(rebuilt);
      expect(store.explorationSnapshot()).toEqual(after);
      snapshotBefore = after;
    });
    expect(snapshotBefore?.version).toBe(1);
  });

  it('keeps a 1,000-record fixture inside the per-run row caps with no overflow', async () => {
    await storeFixture(async store => {
      const run = manifest.runId, rows: AssessmentRecord[] = [];
      for (let index = 0; index < 250; index += 1) {
        const goalId = `goal-${index}`, taskId = `task-${index}`, claimId = `rec-claim-${index}`, linkId = `plan-link-${index}`;
        rows.push(base(`rec-goal-${index}`, { runId: run, data: { plan: { runId: run, id: goalId, kind: 'goal', revision: 1, title: `Goal ${index}`,
          status: 'active', reason: 'A bounded fixture goal', proof: { kind: 'capability', capability: { kind: 'data.read' } } } } }));
        rows.push(base(`record-${taskId}`, { runId: run, kind: 'task', data: { task: { runId: run, id: taskId, revision: 1, status: 'proposed', prerequisites: [], evidenceIds: [] } } }));
        rows.push(base(claimId, { runId: run, by: 'worker-a', workerId: 'worker-a', kind: 'candidate', surface: '/fixture', risk: 'authorization',
          data: { candidate: `claim-${index}`, surface: '/fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested',
            proof: 'offline_reproduction', gained: [{ kind: 'data.read' }], taskRef: taskId } }));
        rows.push(base(`rec-${linkId}`, { runId: run, data: { plan: { runId: run, id: linkId, kind: 'todo', revision: 1, title: `Step ${index}`,
          status: 'open', reason: 'A bounded fixture step', chainOf: `chain-${index}`, step: 1, claimRefs: [claimId], taskIds: [taskId] } } }));
      }
      expect(rows).toHaveLength(1000);
      for (let offset = 0; offset < rows.length; offset += 128) store.commitRecords(rows.slice(offset, offset + 128));
      const snapshot = store.explorationSnapshot();
      expect(snapshot.counts.nodes).toBe(1001);
      expect(snapshot.counts.edges).toBe(1500);
      expect(snapshot.counts.nodes).toBeLessThanOrEqual(EXPLORATION_NODE_LIMIT);
      expect(snapshot.counts.edges).toBeLessThanOrEqual(EXPLORATION_EDGE_LIMIT);
      expect(snapshot.overflow).toBe(0);
      expect(store.explorationHealth()).toMatchObject({ nodes: 1001, edges: 1500, unresolved: 0, overflow: 0, failures: 0 });
      expect(snapshot.nodes.every(row => Buffer.byteLength(JSON.stringify(row.body)) <= EXPLORATION_NODE_BYTES)).toBe(true);
      // The same fixture rebuilt from the ledger is identical, so the growth is a projection and not an accumulating log.
      expect(store.rebuildExploration()).toMatchObject({ nodes: 1001, edges: 1500, overflow: 0 });
      expect(store.explorationSnapshot().counts).toEqual(snapshot.counts);
    });
  });

  it('never fails a record write when the projection cannot be applied, and counts the failure', async () => {
    await storeFixture(async store => {
      // A candidate whose cited task node is unknown is a legitimate record: the projection drops edges, the ledger keeps the row.
      store.commitRecords([{ ...claimRow('rec-claim-orphan', 'claim-orphan', { closure: 'open_proof_gap', execution: 'not_tested', taskRef: 'missing-task' }), runId: manifest.runId }]);
      expect(store.records()).toHaveLength(1);
      expect(store.explorationHealth().failures).toBe(0);
      expect(store.explorationHealth().unresolved).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// §3.7 read model: every page is a pure, deterministic, bounded read of one snapshot (P24/C).
const snapshotOf = (rows: readonly AssessmentRecord[]): ExplorationSnapshot => {
  const projection = project(rows);
  return { version: 1, runId, asOfSequence: rows.length, nodes: projection.nodes, edges: projection.edges, anchors: projection.anchors,
    unresolved: projection.unresolved, overflow: projection.overflow,
    counts: { nodes: projection.nodes.length, edges: projection.edges.length, anchors: projection.anchors.length } };
};
/** Goal + producing task + demonstrated claim + the chain link that cites it: one node of every non-digest kind. */
const readRows = (): AssessmentRecord[] => [
  planRow('rec-goal-read', { id: 'goal-read', kind: 'goal', title: 'Reach the fixture effect', status: 'active', reason: 'A bounded fixture goal',
    proof: { kind: 'capability', capability: { kind: 'data.read' } } }),
  taskRow('task-top'),
  claimRow('rec-claim-1', 'claim-one', { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'data.read' }], taskRef: 'task-top' }),
  planRow('rec-plan-link', { id: 'plan-link', kind: 'todo', title: 'Step one of the chain', status: 'open', reason: 'A bounded fixture step',
    chainOf: 'chain-1', step: 1, claimRefs: ['rec-claim-1'], taskIds: ['task-top'] }),
];

describe('§3.7 overview, frontier and lineage pages (P24/C)', () => {
  it('summarises counts, origin, goals, facts and inheritance from one snapshot', () => {
    const overview = explorationOverview(snapshotOf(readRows()));
    expect(overview.label).toBe(EXPLORATION_PROJECTION_LABEL);
    expect(overview.counts.nodes).toBe(5); // origin, goal, intent, fact, link
    expect(overview.counts.byKind).toMatchObject({ origin: 1, goal: 1, link: 1, intent: 1, fact: 1, finding: 0, digest: 0 });
    expect(overview.counts.byRelation.spawns).toBe(2);
    expect(overview.origin).toMatchObject({ targetKind: 'directory', targetDisplay: 'inert fixture' });
    expect(overview.goals).toMatchObject({ total: 1, open: 0, met: 1 });
    expect(overview.goals.rows[0]).toMatchObject({ kind: 'goal', entityId: 'goal-read', text: 'Reach the fixture effect' });
    expect(overview.links).toMatchObject({ total: 1, open: 1 });
    expect(overview.facts).toMatchObject({ total: 1, demonstrated: 1 });
    expect(overview.latestDigest).toBeUndefined();
    expect(overview.inherited).toEqual({ nodes: 0, edges: 0, runs: [] });
    // An imported row is counted and named, never merged into this run's own projection.
    const snapshot = snapshotOf(readRows());
    snapshot.nodes = snapshot.nodes.map((node, index) => index === 0 ? { ...node, inheritedFrom: 'run-prior' } : node);
    snapshot.edges = snapshot.edges.map((edge, index) => index === 0 ? { ...edge, inheritedFrom: 'run-prior' } : edge);
    expect(explorationOverview(snapshot).inherited).toEqual({ nodes: 1, edges: 1, runs: ['run-prior'] });
  });

  it('joins chain-board readiness to the link nodes without becoming a second authority', () => {
    const snapshot = snapshotOf(readRows());
    const ready = { planId: 'plan-link', planRevision: 1, chainOf: 'chain-1', step: 1, total: 2, title: 'Step one of the chain', status: 'open',
      claimRefs: ['rec-claim-1'], needs: [], state: 'ready', waitingOn: [], satisfiedBy: {} } as unknown as ChainStep;
    const waiting = { ...ready, planId: 'plan-link-2', step: 2, state: 'waiting', waitingOn: [{ kind: 'data.read' }] } as unknown as ChainStep;
    const chain = { chainOf: 'chain-1', total: 2, done: 0, steps: [ready, waiting], ready: [ready], waiting: [waiting], next: ready, line: 'chain chain-1 0/2' } as unknown as ChainProgress;
    const frontier = explorationFrontier(snapshot, [chain]);
    expect(frontier).toMatchObject({ chains: 1, total: 2, ready: 1, waiting: 1, omitted: 0 });
    expect(frontier.rows.map(row => row.planId).sort()).toEqual(['plan-link', 'plan-link-2']);
    expect(frontier.rows.find(row => row.planId === 'plan-link')?.nodeId).toBe(explorationNodeId('link', runId, 'plan-link'));
    expect(frontier.rows.find(row => row.planId === 'plan-link-2')?.waitingOn).toEqual(['data.read']);
    expect(frontier.next).toMatchObject({ chainOf: 'chain-1', step: 1 });
  });

  it('walks up, down or both from a resolved seed and trims tail-first against the byte bound', () => {
    const snapshot = snapshotOf(readRows());
    const factId = explorationNodeId('fact', runId, 'claim-one');
    const up = explorationLineage(snapshot, [factId], { direction: 'up', depth: 6, limit: 60 })!;
    expect(up).toMatchObject({ id: factId, direction: 'up', depth: 6, label: EXPLORATION_PROJECTION_LABEL });
    expect(up.root).toMatchObject({ kind: 'fact', entityId: 'claim-one' });
    expect(up.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'yields', direction: 'up', kind: 'intent', entityId: 'task-top', depth: 1 }),
      expect.objectContaining({ relation: 'proves', direction: 'up', kind: 'goal', entityId: 'goal-read', depth: 1 }),
    ]));
    // Down from the fact reaches the chain step that cites it; down and up are inverses through the same relation table.
    const down = explorationLineage(snapshot, [factId], { direction: 'down', limit: 60 })!;
    expect(down.rows.map(row => `${row.relation}:${row.kind}:${row.entityId}`)).toEqual(expect.arrayContaining(['derived_from:link:plan-link']));
    expect(down.rows.every(row => row.direction === 'down')).toBe(true);
    const both = explorationLineage(snapshot, [factId])!;
    expect(both.rows.some(row => row.direction === 'up') && both.rows.some(row => row.direction === 'down')).toBe(true);
    // Determinism: the same seed and options produce the same bytes.
    expect(JSON.stringify(explorationLineage(snapshot, [factId]))).toBe(JSON.stringify(both));
    // Depth and limit are host bounds: depth 1 stops after the immediate neighbourhood, limit 1 reports the omitted rows.
    expect(explorationLineage(snapshot, [factId], { direction: 'up', depth: 1 })!.rows.every(row => row.depth === 1)).toBe(true);
    const limited = explorationLineage(snapshot, [factId], { direction: 'both', limit: 1 })!;
    expect(limited.rows).toHaveLength(1);
    expect(limited.omitted).toBeGreaterThan(0);
    expect(limited.truncated).toBe(true);
    // A tight byte budget keeps the root and the strongest rows, and says it trimmed instead of failing the read.
    const tight = explorationLineage(snapshot, [factId], { direction: 'both', budget: 600 })!;
    expect(tight.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(tight))).toBeLessThanOrEqual(600);
    // An unknown seed is not invented into a node.
    expect(explorationLineage(snapshot, ['missing-node'])).toBeUndefined();
    expect(EXPLORATION_VIEW_BYTES).toBe(24 * 1024);
  });

  it('renders the ancestry block and the overview lines within their caps', () => {
    const snapshot = snapshotOf(readRows());
    const factId = explorationNodeId('fact', runId, 'claim-one');
    const ancestry = explorationAncestryLines(snapshot, ['rec-claim-1']);
    expect(ancestry.lines).toEqual([
      'ANCESTRY: fact#claim-one \u2190 intent#task-top \u2190 link#plan-link',
      `NODE: ${factId}`,
    ]);
    expect(ancestry.truncated).toBe(false);
    expect(ancestry.bytes).toBeLessThanOrEqual(EXPLORATION_ANCESTRY_BYTES);
    // Nothing resolves → no block at all (a brief must not print an empty header).
    expect(explorationAncestryLines(snapshot, ['missing-record'])).toMatchObject({ lines: [], bytes: 0 });
    // A second claim is a second line, never an unbounded block.
    const two = explorationAncestryLines(snapshot, ['rec-claim-1', 'claim-one']);
    expect(two.lines.length).toBe(2); // the duplicate claim is rendered once
    const overview = explorationOverview(snapshot);
    const rendered = renderOverviewLines(overview);
    expect(rendered.truncated).toBe(false);
    expect(rendered.lines[0]).toContain('Graph: 5 node(s)');
    expect(rendered.lines.join('\n')).toContain('Goals: 0 open, 1 met of 1');
    expect(rendered.lines.join('\n')).toContain('Inherited graph: none.');
    expect(rendered.bytes).toBeLessThanOrEqual(900);
    const frontier = explorationFrontier(snapshot, []);
    const withFrontier = renderOverviewLines(overview, { frontier });
    expect(withFrontier.lines.join('\n')).toContain('Links: 0 ready, 0 waiting of 0 step(s) across 0 chain(s)');
    const capped = renderOverviewLines(overview, { byteCap: 200 });
    expect(capped.truncated).toBe(true);
    expect(capped.bytes).toBeLessThanOrEqual(200);
  });
});

describe('the store answers one bounded lineage page (P24/C)', () => {
  it('resolves a node id, a record id and an entity id, and refuses an unknown address', async () => {
    await storeFixture(async store => {
      const run = manifest.runId;
      const withRun = (record: AssessmentRecord): AssessmentRecord => ({ ...record, runId: run });
      const planRecord = (recordId: string, plan: Record<string, unknown>) => withRun(base(recordId, { data: { plan: { runId: run, revision: 1, ...plan } } }));
      store.commitRecords([
        campaignRow('rec-campaign', run),
        planRecord('rec-goal-read', { id: 'goal-read', kind: 'goal', title: 'Reach the fixture effect', status: 'active', reason: 'A bounded fixture goal',
          proof: { kind: 'capability', capability: { kind: 'data.read' } } }),
        withRun(base('record-task-top', { kind: 'task', data: { task: { runId: run, id: 'task-top', revision: 1, status: 'proposed', prerequisites: [], evidenceIds: [] } } })),
        withRun(claimRow('rec-claim-1', 'claim-one', { closure: 'confirmed', execution: 'tested', gained: [{ kind: 'data.read' }], taskRef: 'task-top' })),
        planRecord('rec-plan-link', { id: 'plan-link', kind: 'todo', title: 'Step one of the chain', status: 'open', reason: 'A bounded fixture step',
          chainOf: 'chain-1', step: 1, claimRefs: ['rec-claim-1'], taskIds: ['task-top'] }),
      ]);
      const snapshot = store.explorationSnapshot();
      const factId = explorationNodeId('fact', run, 'claim-one');
      const byNode = store.explorationPage(factId, { direction: 'up', depth: 6, limit: 60 })!;
      expect(byNode).toMatchObject({ id: factId, direction: 'up', depth: 6, truncated: false });
      expect(byNode.rows).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'yields', kind: 'intent', entityId: 'task-top', direction: 'up' })]));
      // The address may be the exact record the claim was projected from, or an entity id a reader already holds.
      expect(store.explorationPage('rec-claim-1', { direction: 'up' })?.id).toBe(factId);
      expect(store.explorationPage('plan-link')).toMatchObject({ root: { kind: 'link', entityId: 'plan-link' } });
      expect(store.explorationPage('goal-read')).toMatchObject({ root: { kind: 'goal', entityId: 'goal-read' } });
      expect(store.explorationPage('missing-everywhere')).toBeUndefined();
      // A page never writes: the projection is byte-identical after every read.
      expect(store.explorationSnapshot()).toEqual(snapshot);
      // A tight budget trims the page tail-first and keeps it inside the bound instead of failing the read.
      const tight = store.explorationPage(factId, { direction: 'both', budget: 600 })!;
      expect(tight.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(tight))).toBeLessThanOrEqual(600);
    });
  });
});
