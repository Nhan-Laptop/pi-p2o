import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLedger } from '../../src/records.js';
import { fixture, seedImpactGoal } from './helpers/report-fixture.js';

/**
 * planning_update.md W-Z option C (C2): an owner review that settles a scanner hypothesis as supported is the triage itself.
 * The host seeds exactly ONE investigation intent on the scanned asset (pinned revision, scanner receipts, no claim), refuses
 * to seed when admission does not hold, and never turns a scanner match into a claim, finding or case. A repeated review is
 * the same intent, not a second one.
 */
async function recordOpenHypothesis(h: any, statement: string) {
  const receipt = (await h.call('p2o_shell', { command: `printf ${JSON.stringify(statement).slice(1, -1)}` })).details;
  const asset = (await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'route', key: 'GET /search' } }] } })).details.acks[0];
  const hypothesis = (await h.call('p2o_graph_record', { batch: { hypotheses: [{ assetId: asset.entityId, statement, status: 'open',
    impact: 'Unauthenticated error disclosure', evidenceRefs: [receipt.evidenceId] }] } })).details.acks[0];
  return { receipt, asset, hypothesis };
}

async function runLedger(h: any) {
  const run = (await readdir(join(h.root, 'control'))).find((name: string) => name.startsWith('p2o-run-'));
  if (!run) throw new Error('fixture run missing');
  return readLedger(join(h.root, 'control', run, 'records.sqlite'));
}

const tasksPage = async (h: any) => (await h.call('p2o_board', { board: 'tasks' })).details;

describe('owner-triaged scanner hypothesis seeds one investigation intent (W-Z C2)', () => {
  it('seeds one pinned investigation intent from a supported review and replays the same intent instead of duplicating it', async () => fixture(async (h: any) => {
    await h.command('--target ./source');
    await seedImpactGoal(h);
    const statement = 'Quoted path segment on /search returns a 500 with a stack trace';
    const { receipt, asset, hypothesis } = await recordOpenHypothesis(h, statement);
    const review = (await h.call('p2o_graph_review', { id: hypothesis.id, outcome: 'supported', evidenceRefs: [receipt.evidenceId], requestId: 'triage-1' })).details;
    expect(review.replayed).toBe(false);
    // The review result names the seeded intent and says what it is: an intent on the scanned asset, never a claim.
    expect(review.seededTaskId).toMatch(/^seed-[a-f0-9]{40}$/);
    expect(review.seededReplay).toBe(false);
    expect(review.seedRefused).toBeUndefined();
    expect(review.triageNote).toContain('not a claim');
    const seededId = review.seededTaskId;
    // The board holds exactly that one proposed task: role general, purpose investigation, pinned to the asset revision the
    // hypothesis was recorded against, and citing the scanner receipt the row already held.
    const list = await tasksPage(h);
    expect(list.tasks.map((task: any) => task.id)).toEqual([seededId]);
    expect(list.tasks[0]).toMatchObject({ id: seededId, role: 'general', status: 'proposed' });
    const detail = (await h.call('p2o_board', { board: 'tasks', id: seededId })).details;
    expect(detail).toMatchObject({ id: seededId, role: 'general', status: 'proposed',
      work: { questionKey: `hypothesis:${hypothesis.entityId}`, methodFamily: 'scanner-hypothesis-triage', purpose: 'investigation' } });
    expect(detail.work.assetRefs).toEqual([{ id: asset.entityId, revision: 1 }]);
    expect(detail.work.claimRefs).toBeUndefined();
    expect(detail.validationOf).toBeUndefined();
    expect(detail.evidenceIds).toEqual([receipt.evidenceId]);
    // One lifecycle fact records the seed, and the seed created no claim, no candidate and no case.
    const index = await runLedger(h);
    expect(index.records.filter(record => record.data?.event === 'hypothesis.seed').map(record => record.data?.taskId)).toEqual([seededId]);
    expect(index.records.filter(record => record.kind === 'candidate')).toEqual([]);
    expect((await h.call('p2o_board', { board: 'cases' })).details.total).toBe(0);
    // Replaying the same review (same request id) is the same triage: no second intent, no second task.
    const replay = (await h.call('p2o_graph_review', { id: hypothesis.id, outcome: 'supported', evidenceRefs: [receipt.evidenceId], requestId: 'triage-1' })).details;
    expect(replay.replayed).toBe(true);
    expect(replay.seededTaskId).toBe(seededId);
    expect(replay.seededReplay).toBe(true);
    expect((await tasksPage(h)).tasks.map((task: any) => task.id)).toEqual([seededId]);
  }));

  it('refutes the hypothesis without seeding any intent', async () => fixture(async (h: any) => {
    await h.command('--target ./source');
    await seedImpactGoal(h);
    const statement = 'Trailing slash on /search returns a stack trace';
    const { receipt, hypothesis } = await recordOpenHypothesis(h, statement);
    const review = (await h.call('p2o_graph_review', { id: hypothesis.id, outcome: 'refuted', counterevidenceRefs: [receipt.evidenceId] })).details;
    expect(review.acks.length).toBe(1);
    expect(review.seededTaskId).toBeUndefined();
    expect(review.seedRefused).toBeUndefined();
    expect((await tasksPage(h)).total).toBe(0);
    const index = await runLedger(h);
    expect(index.records.filter(record => record.data?.event === 'hypothesis.seed')).toEqual([]);
  }));

  it('takes the same engagement gate as an authored intent and reports why the seed was refused', async () => fixture(async (h: any) => {
    // Exploit mode is the default and every target-executing intent needs an impact goal: the host seed does not dodge that rule.
    await h.command('--target ./source');
    const { receipt, hypothesis } = await recordOpenHypothesis(h, 'Quoted path segment on /search returns a 500');
    const review = (await h.call('p2o_graph_review', { id: hypothesis.id, outcome: 'supported', evidenceRefs: [receipt.evidenceId] })).details;
    expect(review.acks.length).toBe(1);
    expect(review.seededTaskId).toBeUndefined();
    expect(review.seedRefused).toContain('EXPLOIT_MODE_NEEDS_IMPACT_GOAL');
    expect((await tasksPage(h)).total).toBe(0);
    const index = await runLedger(h);
    const refused = index.records.filter(record => record.kind === 'lifecycle' && /triaged supported; no investigation intent seeded/.test(record.text));
    expect(refused.length).toBe(1);
  }));
});
