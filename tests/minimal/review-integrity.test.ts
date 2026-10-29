import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AssessmentStore } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { TaskBoard, type TaskDraft } from '../../src/tasks.js';
import { fixture, seedImpactGoal } from './helpers/report-fixture.js';

/** P5: a review records who authored its receipts and which output fields have no record; `enforce` also refuses foreign receipts. Hermetic: inert sandbox, real SQLite store. */
const settings = (h: any, p2o: Record<string, unknown>) => writeFile(join(h.root, 'settings.json'), JSON.stringify({ p2o }));
const draft = (assetId: string, required: string[]) => ({ question: 'Does the bounded fixture observation match the declared policy?', surface: '/integrity-fixture', risk: 'authorization', role: 'general', roleReason: 'Bounded inert observation for the integrity fixture',
  expectedTrue: 'Receipt records the expected policy observation', expectedFalse: 'Receipt records the contrasting control', stopCondition: 'Stop after one inert command and owner review', evidenceIds: [], prerequisites: [], skills: [], methodReason: 'One inert command with no external target',
  work: { assetRefs: [{ id: assetId, revision: 1 }], questionKey: 'policy:integrity', actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'source-trace', purpose: 'investigation' }, decision: { disposition: 'new', reason: 'No prior matching structured attempt exists' },
  outputContract: { kind: 'investigation', required, partialAllowed: true, artifactPolicy: 'ids-only' } });

async function started(h: any, required: string[]) {
  await h.command('--target ./source');
  // A3/D32: the default exploit mode admits no target-executing intent before the run holds an impact goal.
  await seedImpactGoal(h);
  const asset = (await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /integrity-fixture' } }] } })).details.acks[0];
  const task = (await h.call('p2o_task_author', {draft: draft(asset.entityId, required) })).details, running = (await h.call('p2o_task_start', {id: task.id })).details;
  const own = (await h.call('p2o_shell', { command: 'printf integrity-own' })).details;
  return { asset, task, running, own };
}
const head = async (h: any, id: string) => (await h.call('p2o_board', { board: 'tasks', id })).details;

describe('review integrity', () => {
  it('annotates a review with the receipt authors and the output fields no record backs, without changing the decision', async () => fixture(async h => {
    const s = await started(h, ['evidence', 'gaps', 'assets']);
    const reviewed = (await h.call('p2o_task_review', {id: s.task.id, revision: s.running.revision, reason: 'Owner reviewed the exact inert receipt for bounded coordination', evidenceIds: [s.own.evidenceId] })).details;
    expect(reviewed.status).toBe('reviewed'); expect(reviewed.reviewIntegrity).toEqual({ assignee: 'owner', foreignEvidence: [], contractGap: ['gaps'], contractUnchecked: ['assets'] });
    expect((await head(h, s.task.id)).reviewIntegrity.contractGap).toEqual(['gaps']);
  }));

  it('records nothing when the mode is off, and never marks a field with a record as missing', async () => {
    await fixture(async h => { await settings(h, { reviewIntegrity: 'off' }); const s = await started(h, ['evidence']);
      const reviewed = (await h.call('p2o_task_review', {id: s.task.id, revision: s.running.revision, reason: 'Owner reviewed the exact inert receipt for bounded coordination', evidenceIds: [s.own.evidenceId] })).details;
      expect(reviewed).not.toHaveProperty('reviewIntegrity'); });
    await fixture(async h => { const s = await started(h, ['evidence']);
      expect((await h.call('p2o_task_review', {id: s.task.id, revision: s.running.revision, reason: 'Owner reviewed the exact inert receipt for bounded coordination', evidenceIds: [s.own.evidenceId] })).details.reviewIntegrity.contractGap).toEqual([]); });
  });

});

/** The same rules at the TaskBoard, where a receipt authored by another actor can be written directly (a worker pane is not needed). */
describe('review integrity at the task board', () => {
  const runId = 'run-integrity';
  const base = (id: string, assetId: string): TaskDraft => ({ id, question: 'Which observation distinguishes the declared policy?', surface: '/fixture', risk: 'authorization', role: 'general', roleReason: 'Bounded inert source comparison only',
    expectedTrue: 'Declared actor reaches the consumer', expectedFalse: 'Control actor does not reach the consumer', stopCondition: 'Stop after the bounded observation or a concrete gap', evidenceIds: [], prerequisites: [], method: { skills: [], reason: 'Controlled offline fixture, not a target assessment' },
    work: { assetRefs: [{ id: assetId, revision: 1 }], questionKey: 'policy:object-access', policyKey: 'policy:declared-contract', actorContext: 'actor:fixture-a', tenantContext: 'tenant:fixture', methodFamily: 'source-trace', purpose: 'investigation' },
    decision: { disposition: 'new', reason: 'No prior retained attempt for this structured identity' }, outputContract: { kind: 'investigation', required: ['evidence', 'gaps', 'facts'], partialAllowed: true, artifactPolicy: 'ids-only' } });
  async function board(mode: 'off' | 'annotate' | 'enforce', work: (h: { board: TaskBoard; store: AssessmentStore; assetId: string }) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'p2o-integrity-')), store = AssessmentStore.create(root, { runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'inert', targetDisplay: 'inert', profile: { runtimeHash: 'inert', image: 'inert', loopMode: 'manual', executorMode: 'shared' } });
    const path = join(root, 'alias.sqlite'), unbind = bindAssessmentStore(path, store), tasks = new TaskBoard(runId, path, () => true, Date.now, () => store.graphScope(), id => store.assetRevision(id)); tasks.integrity = mode;
    try { await work({ board: tasks, store, assetId: store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /fixture' } }] })[0].entityId }); } finally { unbind(); store.close(); await rm(root, { recursive: true, force: true }); }
  }
  const receipt = (store: AssessmentStore, by: string) => store.commitRecords([{ runId, at: '2030', by, kind: 'evidence', text: 'Inert fixture receipt; not semantic finding proof' }])[0].recordId;
  async function reported(tasks: TaskBoard, id: string, assetId: string, assignee = 'worker-a') {
    await tasks.create(base(id, assetId)); await tasks.reserve(id, assignee); await tasks.transition(id, 'running', 'Inert assignment began'); await tasks.transition(id, 'reported', 'Inert report committed');
  }

  it('annotates foreign receipts and empty contract fields without refusing in annotate mode', async () => board('annotate', async ({ board: tasks, store, assetId }) => {
    await reported(tasks, 'a', assetId); const own = receipt(store, 'worker-a'), foreign = receipt(store, 'worker-b');
    const reviewed = await tasks.transition('a', 'reviewed', 'Owner accepted the bounded coordination receipts', [own, foreign]);
    expect(reviewed.reviewIntegrity).toEqual({ assignee: 'worker-a', foreignEvidence: [foreign], contractGap: ['gaps'], contractUnchecked: ['facts'] });
  }));

  it('refuses a foreign receipt in enforce mode unless the lead acknowledges it as external', async () => board('enforce', async ({ board: tasks, store, assetId }) => {
    await reported(tasks, 'a', assetId); const foreign = receipt(store, 'worker-b');
    await expect(tasks.transition('a', 'reviewed', 'Owner accepted the bounded coordination receipt', [foreign])).rejects.toThrow(/REVIEW_INTEGRITY: receipts not authored by worker-a/);
    const reviewed = await tasks.transition('a', 'reviewed', 'Owner accepted the bounded coordination receipt', [foreign], undefined, true);
    expect(reviewed.reviewIntegrity).toMatchObject({ foreignEvidence: [foreign], externalAcknowledged: true });
  }));

  it('accepts the assignee’s own receipts in enforce mode, and a solo owner’s own receipts', async () => board('enforce', async ({ board: tasks, store, assetId }) => {
    await reported(tasks, 'a', assetId); expect((await tasks.transition('a', 'reviewed', 'Owner accepted the bounded coordination receipt', [receipt(store, 'worker-a')])).reviewIntegrity?.foreignEvidence).toEqual([]);
    await tasks.create({ ...base('b', assetId), work: { ...base('b', assetId).work!, questionKey: 'policy:other' } }); await tasks.reserve('b', 'owner'); await tasks.transition('b', 'running', 'Lead is investigating this bounded question');
    expect((await tasks.transition('b', 'reviewed', 'Owner accepted the bounded coordination receipt', [receipt(store, 'owner')])).reviewIntegrity).toMatchObject({ assignee: 'owner', foreignEvidence: [] });
  }));

  it('writes no note at all when the mode is off, so old behaviour and stored shape are unchanged', async () => board('off', async ({ board: tasks, store, assetId }) => {
    await reported(tasks, 'a', assetId); const reviewed = await tasks.transition('a', 'reviewed', 'Owner accepted the bounded coordination receipt', [receipt(store, 'worker-b')]);
    expect(reviewed).not.toHaveProperty('reviewIntegrity');
  }));
});
