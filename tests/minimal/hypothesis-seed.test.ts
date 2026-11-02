import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssessmentStore } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { TaskBoard } from '../../src/tasks.js';
import { readLedger } from '../../src/records.js';
import { sha256Hex } from '../../src/validate.js';
import { hypothesisSeedDraft, hypothesisSeedKey, isSeedableHypothesis, type HypothesisSeedSource } from '../../src/hypothesis-seed.js';

/**
 * planning_update.md W-Z option C (C2): an owner-triaged scanner hypothesis seeds exactly ONE investigation intent, never a claim.
 * The seed is pure (it reads a row shape and builds a TaskDraft), so these tests pin the deterministic id/draft, the TaskBoard
 * admission it must survive (investigation purpose on a pinned asset revision, no validationOf/prerequisites/claimRefs), the
 * open-row gate, duplicate refusal, and that neither the hypothesis row nor the ledger gains a claim or a case.
 */
const runId = 'run-hypothesis-seed';
const STATEMENT = 'Quoted path segment returns a 500 with a stack trace';

interface Fixture {
  store: AssessmentStore; board: TaskBoard; path: string;
  asset: { id: string; entityId: string; revision: number };
  hypothesis: { id: string; entityId: string; revision: number };
  evidence: (by?: string) => string;
  source: (overrides?: Partial<HypothesisSeedSource>) => HypothesisSeedSource;
}

async function fixture(work: (h: Fixture) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-hypothesis-seed-'));
  const store = AssessmentStore.create(root, { runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture', targetDisplay: 'fixture',
    profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } });
  const path = join(root, 'alias.sqlite'), unbind = bindAssessmentStore(path, store);
  const [asset] = store.recordGraph({ assets: [{ asset: { kind: 'route', key: '/fixture' } }] });
  const evidence = (by = 'owner') => store.commitRecords([{ id: randomUUID(), runId, at: new Date().toISOString(), by,
    workerId: by === 'owner' ? undefined : by, kind: 'evidence', text: 'Bounded inert scanner receipt for one hypothesis seed' }])[0].recordId;
  // A scanner ingest records an open, unverified hypothesis that cites the same-run receipt the scanner produced.
  const [hypothesis] = store.recordGraph({ hypotheses: [{ assetId: asset.entityId, statement: STATEMENT, status: 'open',
    impact: 'Unauthenticated error disclosure', evidenceRefs: [evidence('worker-a')] }] });
  const board = new TaskBoard(runId, path, () => true, Date.now, () => store.graphScope(), id => store.assetRevision(id));
  const source = (overrides: Partial<HypothesisSeedSource> = {}): HypothesisSeedSource => ({
    rowId: hypothesis.id, entityId: hypothesis.entityId, statement: STATEMENT, impact: 'Unauthenticated error disclosure', severity: 'high',
    assetId: asset.entityId, assetKey: '/fixture', assetRevision: asset.revision, evidenceRefs: [], ...overrides });
  try { await work({ store, board, path, asset, hypothesis, evidence, source }); }
  finally { unbind(); store.close(); await rm(root, { recursive: true, force: true }); }
}

describe('owner-triaged scanner hypothesis seed (W-Z C2)', () => {
  it('derives a deterministic seed id and a stable bounded draft from the retained hypothesis row', async () => fixture(async ({ evidence, source }) => {
    const receipts = [evidence('worker-a'), evidence('worker-b')];
    const input = source({ evidenceRefs: [receipts[0]!, receipts[1]!, receipts[0]!] });
    const draft = hypothesisSeedDraft(input, { runId });
    // Same run + same retained row revision id => same task id, so re-triaging is deterministic.
    expect(draft.id).toBe(hypothesisSeedKey(runId, input.rowId));
    expect(draft.id).toBe(`seed-${sha256Hex(JSON.stringify([runId, input.rowId])).slice(0, 40)}`);
    expect(draft.id).toMatch(/^seed-[a-f0-9]{40}$/);
    expect(hypothesisSeedDraft(input, { runId })).toEqual(draft);
    expect(hypothesisSeedDraft({ ...input }, { runId }).id).toBe(draft.id);
    // The admission vocabulary is exact; only the bounded prose around it is generated.
    expect(draft).toMatchObject({
      role: 'general',
      roleReason: 'Owner-triaged scanner hypothesis: an unverified match needs its own oracle before it can be a claim',
      surface: '/fixture',
      risk: 'medium',
      stopCondition: 'Stop after one reproduction attempt with/without the oracle, or a concrete prerequisite gap; no retry loop.',
      evidenceIds: receipts,
      prerequisites: [],
      method: { skills: [], reason: 'Host-seeded investigation from an owner-triaged scanner hypothesis; dispatch resolves the method from role/purpose.' },
      work: { assetRefs: [{ id: input.assetId, revision: input.assetRevision }], questionKey: `hypothesis:${input.entityId}`,
        methodFamily: 'scanner-hypothesis-triage', purpose: 'investigation' },
    });
    expect(draft.validationOf).toBeUndefined();
    expect(draft.retestOf).toBeUndefined();
    expect(draft.work?.claimRefs).toBeUndefined();
    // The question names the row, the asset, the statement excerpt and the oracle work a scanner match is missing.
    expect(draft.question).toContain(input.entityId);
    expect(draft.question).toContain('/fixture');
    expect(draft.question).toContain('Quoted path segment returns a 500 with a stack trace');
    expect(draft.question).toMatch(/ONE candidate/);
    expect(draft.question).toMatch(/baseline\+probe, negative control/);
    expect(draft.question).toMatch(/A scanner match is not evidence/);
    expect(draft.expectedTrue).toMatch(/in-band oracle/);
    expect(draft.expectedFalse).toMatch(/do not promote the hypothesis to a claim/);
    // Risk default: critical/high severity becomes medium, anything else low, and an explicit option wins.
    expect(hypothesisSeedDraft(source({ severity: 'critical' }), { runId }).risk).toBe('medium');
    expect(hypothesisSeedDraft(source({ severity: 'HIGH' }), { runId }).risk).toBe('medium');
    expect(hypothesisSeedDraft(source({ severity: 'low' }), { runId }).risk).toBe('low');
    expect(hypothesisSeedDraft(source({ severity: undefined }), { runId }).risk).toBe('low');
    expect(hypothesisSeedDraft(source({ severity: 'critical' }), { runId, risk: 'high' }).risk).toBe('high');
    // The asset head is the fallback surface when the row only carries the asset entity id.
    expect(hypothesisSeedDraft(source({ assetKey: undefined }), { runId }).surface).toBe(`graph ${input.assetId}`);
  }));

  it('keeps every generated string inside the cap the task admission enforces', async () => fixture(async ({ source }) => {
    const draft = hypothesisSeedDraft(source({ statement: 'S'.repeat(5000), assetKey: `/fixture/${'k'.repeat(600)}`, evidenceRefs: ['a', 'b', 'a', 'c', 'd', 'e'] }), { runId });
    expect(draft.question.length).toBeLessThanOrEqual(1500);
    expect(draft.surface.length).toBeLessThanOrEqual(200);
    expect(draft.expectedTrue.length).toBeLessThanOrEqual(1000);
    expect(draft.expectedFalse.length).toBeLessThanOrEqual(1000);
    expect(draft.stopCondition.length).toBeLessThanOrEqual(400);
    expect(draft.evidenceIds).toEqual(['a', 'b', 'c', 'd']); // unique, max 4
  }));

  it('admits exactly one proposed investigation intent on the pinned asset revision and leaves the hypothesis row and ledger claim-free', async () => fixture(async ({ store, board, path, source, evidence }) => {
    const receipt = evidence('worker-a');
    const input = source({ evidenceRefs: [receipt] });
    const before = store.graphQuery({ assertionKind: 'hypothesis' }).rows;
    const draft = hypothesisSeedDraft(input, { runId });
    const task = await board.create(draft);
    expect(task).toMatchObject({ id: draft.id, role: 'general', status: 'proposed',
      prerequisites: [], evidenceIds: [receipt],
      work: { purpose: 'investigation', methodFamily: 'scanner-hypothesis-triage', questionKey: `hypothesis:${input.entityId}`,
        assetRefs: [{ id: input.assetId, revision: input.assetRevision }] },
      decision: { disposition: 'new' }, outputContract: { kind: 'investigation' } });
    // A seed never claims lineage: it is not a validation/retest, has no parent and cites no claim.
    expect(task.validationOf).toBeUndefined();
    expect(task.retestOf).toBeUndefined();
    expect(task.parentTaskId).toBeUndefined();
    expect(task.work?.claimRefs).toBeUndefined();
    // One task record and the receipt it cites: the seed writes no candidate (claim), no case and nothing to the graph.
    const records = (await readLedger(path, runId)).records;
    expect(records.filter(row => row.kind === 'candidate')).toEqual([]);
    expect(records.filter(row => row.data?.case !== undefined)).toEqual([]);
    expect(records.filter(row => row.kind === 'task')).toHaveLength(1);
    // The seed never touches the retained hypothesis row: same id, still open at r1, same graph sequence/dossier row.
    expect(store.graphQuery({ assertionKind: 'hypothesis' }).rows).toEqual(before);
    expect(before[0]).toMatchObject({ id: input.rowId, entityId: input.entityId, status: 'open', revision: 1 });
  }));

  it('gates on the open hypothesis row: settled, foreign and unknown rows never seed', async () => fixture(async ({ store, board, evidence, asset, hypothesis }) => {
    expect(isSeedableHypothesis({ table: 'assertions', kind: 'hypothesis', status: 'open' })).toBe(true);
    for (const status of ['supported', 'refuted', 'inconclusive', undefined, 'OPEN']) expect(isSeedableHypothesis({ table: 'assertions', kind: 'hypothesis', status })).toBe(false);
    expect(isSeedableHypothesis({ table: 'assets', kind: 'hypothesis', status: 'open' })).toBe(false);
    expect(isSeedableHypothesis({ table: 'assertions', kind: 'fact:observed', status: 'open' })).toBe(false);
    expect(isSeedableHypothesis({})).toBe(false);
    // The owner review that answered it supersedes the row (supported, with its evidence); the settled head cannot seed.
    const [settled] = store.recordGraph({ hypotheses: [{ assetId: asset.entityId, statement: STATEMENT, status: 'supported',
      evidenceRefs: [evidence('owner')], supersedes: hypothesis.id }] });
    const head = store.graphQuery({ assertionKind: 'hypothesis' }).rows.find(row => row.entityId === hypothesis.entityId && row.kind === 'hypothesis');
    expect(head).toMatchObject({ id: settled.id, status: 'supported' });
    expect(isSeedableHypothesis({ table: 'assertions', kind: 'hypothesis', status: String(head?.status) })).toBe(false);
    // The gate is the caller's before it builds anything: nothing was seeded while the row was refuted/unknown.
    expect(await board.list()).toEqual([]);
  }));

  it('refuses a second seed for the same row instead of creating a duplicate', async () => fixture(async ({ board, source }) => {
    const first = await board.create(hypothesisSeedDraft(source(), { runId }));
    expect(await board.list()).toHaveLength(1);
    // Same row, same run => same deterministic id => the board refuses the duplicate.
    const again = async () => board.create(hypothesisSeedDraft(source(), { runId }));
    await expect(again()).rejects.toThrow(/Duplicate task/);
    expect(await board.list()).toHaveLength(1);
    expect((await board.list())[0]!.id).toBe(first.id);
  }));
});
