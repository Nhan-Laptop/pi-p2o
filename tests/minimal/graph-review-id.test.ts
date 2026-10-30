import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssessmentStore } from '../../src/state/store.js';

/**
 * A5-fix-3 (live run run-1b201c1a-ba04-4dd5-8aca-e0ed302c2904): `p2o_graph action=query` returned an assertion row with only
 * `entityId`, while `p2o_graph_review` resolves a retained row by its revision id (`entityId-rN`). The planner copied the only
 * id it was shown and the review was refused in both rounds ("No retained assertion or relation row with id assertion-…"),
 * leaving six worker hypotheses carried as GRAPH_UNREVIEWED. A query row must now expose the id a review resolves.
 */
async function fixture(work: (store: AssessmentStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-graph-review-'));
  const store = AssessmentStore.create(root, { runId: 'run-graph-review', retention: 'durable-local', targetKind: 'directory',
    targetIdentity: 'inert', targetDisplay: 'inert', profile: { runtimeHash: 'inert', image: 'inert', loopMode: 'manual', executorMode: 'shared' } });
  try { await work(store); } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

describe('graph query exposes the retained id a review resolves (A5-fix-3)', () => {
  it('names the assertion revision id, not only its lineage entity id, and the review accepts it', async () => fixture(async store => {
    const [asset] = store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /fixture' } }] });
    const [hypothesis] = store.recordGraph({ hypotheses: [{ assetId: asset.entityId, statement: 'The fixture returns 401 for anonymous callers', status: 'open' }] });
    const page = store.graphQuery({ assertionKind: 'hypothesis' });
    const row = page.rows.find(entry => entry.type === 'assertion' && entry.entityId === hypothesis.entityId)!;
    expect(row.id).toBe(hypothesis.id);
    expect(row.id).toBe(`${hypothesis.entityId}-r1`);
    expect(row.id).not.toBe(row.entityId);
    expect(store.graphReviewRow(row.id)?.row.id).toBe(row.id);
    const evidenceId = store.commitRecords([{ id: randomUUID(), runId: 'run-graph-review', by: 'worker-a', at: '2030', kind: 'evidence', text: 'inert receipt for the review' }])[0].recordId;
    const [settled] = store.recordGraph({ hypotheses: [{ assetId: asset.entityId, statement: 'The fixture returns 401 for anonymous callers', status: 'supported', evidenceRefs: [evidenceId], supersedes: row.id }] });
    expect(settled).toMatchObject({ entityId: row.entityId, revision: 2, created: true });
  }));

  it('keeps the row shape bounded and still reports the revision id on a paged query', async () => fixture(async store => {
    const [asset] = store.recordGraph({ assets: [{ asset: { kind: 'route', key: '/fixture' } }] });
    for (const [index, status] of ['open', 'open', 'open'].entries()) store.recordGraph({ hypotheses: [{ assetId: asset.entityId, statement: `Fixture hypothesis ${index}`, status: status as 'open' }] });
    const first = store.graphQuery({ assertionKind: 'hypothesis' }, { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.rows.every(entry => /^assertion-[a-f0-9]{24}-r\d+$/.test(entry.id))).toBe(true);
    expect(first.nextCursor).toBeDefined();
    const next = store.graphQuery({ assertionKind: 'hypothesis' }, { cursor: first.nextCursor, limit: 2 });
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]!.id).toMatch(/^assertion-[a-f0-9]{24}-r1$/);
  }));
});
