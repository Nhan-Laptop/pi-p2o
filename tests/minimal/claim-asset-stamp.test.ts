import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssessmentStore } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { TaskBoard, type TaskDraft } from '../../src/tasks.js';
import { EvidenceStore, claimAssetRefsFromWork, type Candidate } from '../../src/evidence.js';
import { claimAssetRefs } from '../../src/claims.js';

/**
 * R1.2/D-R1-1: a claim is attached to the assets of the task that produced it by the host, not by the model. The tool schema
 * has no asset field, the record's stamp is derived from the task's pinned work identity, and a legacy claim stays asset-less.
 */
const runId = 'run-claim-assets';

async function fixture(work: (h: { store: AssessmentStore; path: string; assetId: string; taskId: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-claim-assets-'));
  const store = AssessmentStore.create(root, { runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture', targetDisplay: 'fixture',
    profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } });
  const path = join(root, 'alias.sqlite'), unbind = bindAssessmentStore(path, store);
  try {
    const assetId = store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /objects' } }] })[0].entityId;
    const board = new TaskBoard(runId, path, () => true, Date.now, () => store.graphScope(), id => store.assetRevision(id));
    const draft: TaskDraft = {
      question: 'Which recorded surface does the fixture expose?', surface: '/objects', risk: 'mapping', role: 'recon',
      roleReason: 'Minimal recon intent for the claim-asset stamp fixture',
      expectedTrue: 'The recorded fixture exposes the surface', expectedFalse: 'The recorded fixture exposes nothing',
      stopCondition: 'Stop after one bounded observation', evidenceIds: [], prerequisites: [],
      method: { skills: [], reason: 'One inert observation with no target traffic' },
      work: { assetRefs: [{ id: assetId, revision: 1 }], questionKey: 'question:objects', policyKey: 'policy:objects',
        actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'offline-observation', purpose: 'mapping' },
    };
    const taskId = (await board.create(draft)).id;
    await work({ store, path, assetId, taskId });
  } finally { unbind(); store.close(); await rm(root, { recursive: true, force: true }); }
}

const claim = (overrides: Partial<Candidate> = {}): Candidate => ({
  candidate: 'stamped-claim', surface: '/objects', risk: 'mapping', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
  evidenceRefs: [], negativeControls: [], limitations: 'Inert fixture claim with no target traffic', policyBasis: 'inferred',
  expectedPolicy: 'The fixture boundary is recorded, not assumed', ...overrides,
});

describe('claim asset stamping (R1.2)', () => {
  it('derives the claim assets from the task work identity with the pinned revision', () => {
    expect(claimAssetRefsFromWork({ assetRefs: [{ id: 'asset-' + 'a'.repeat(24), revision: 3 }] })).toEqual([{ id: 'asset-' + 'a'.repeat(24), revision: 3 }]);
    expect(claimAssetRefsFromWork(undefined)).toEqual([]);
    // Bounded: a work identity cannot attach more than the ten references the dossier and report can show.
    expect(claimAssetRefsFromWork({ assetRefs: Array.from({ length: 12 }, (_, i) => ({ id: `asset-${String(i).padStart(24, '0')}`, revision: 1 })) })).toHaveLength(10);
  });

  it('stamps the host-derived assets on the candidate record and keeps them through a revision', async () => fixture(async h => {
    const evidence = new EvidenceStore(runId, h.path, 'fixture');
    const assets = claimAssetRefsFromWork({ assetRefs: [{ id: h.assetId, revision: 1 }] });
    const first = await evidence.candidate('worker-a', claim(), h.taskId, assets);
    expect(claimAssetRefs(first.data ?? {})).toEqual([{ id: h.assetId, revision: 1 }]);
    // A revision keeps the producing task's stamp: the review chain must not lose which assets the claim speaks about.
    const revised = await evidence.candidate('worker-a', claim({ candidate: 'stamped-claim', supersedes: first.id }), h.taskId, assets);
    expect(claimAssetRefs(revised.data ?? {})).toEqual([{ id: h.assetId, revision: 1 }]);
    expect(revised.data?.taskRef).toBe(h.taskId);
  }));

  it('never writes an asset reference the model supplied on the claim input', async () => fixture(async h => {
    const evidence = new EvidenceStore(runId, h.path, 'fixture');
    const smuggled = claim() as Candidate & { assetRefs?: unknown };
    smuggled.assetRefs = [{ id: 'asset-' + 'f'.repeat(24), revision: 9 }];
    const record = await evidence.candidate('worker-a', smuggled, h.taskId, claimAssetRefsFromWork({ assetRefs: [{ id: h.assetId, revision: 1 }] }));
    expect(claimAssetRefs(record.data ?? {})).toEqual([{ id: h.assetId, revision: 1 }]);
    // With no host stamp at all, an input field is still dropped rather than stored: there is no model path to claim assets.
    const legacy = await evidence.candidate('worker-a', claim({ candidate: 'legacy-claim' }), h.taskId);
    expect(claimAssetRefs(legacy.data ?? {})).toEqual([]);
  }));

  it('refuses a malformed host reference instead of writing a dangling attachment', async () => fixture(async h => {
    const evidence = new EvidenceStore(runId, h.path, 'fixture');
    await expect(evidence.candidate('worker-a', claim(), h.taskId, [{ id: 'asset-not-hex' }])).rejects.toThrow('asset-<24 hex>');
    await expect(evidence.candidate('worker-a', claim(), h.taskId, [{ id: h.assetId, revision: 0 }])).rejects.toThrow('positive revision');
  }));
});
