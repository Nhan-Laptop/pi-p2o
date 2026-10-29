import { describe, expect, it } from 'vitest';
import { describeKnowledgeRecord } from '../../src/context.js';
import { LINEAGE_LABEL, lineageOf, lineagePage, priorRunContext, recentLearnings, whyPlanRow } from '../../src/exploration-view.js';
import { indexRecords, type AssessmentRecord } from '../../src/records.js';
import { GRAPH_RESPONSE_BYTES } from '../../src/state/graph.js';

/**
 * P20/A2: the learning and lineage projections are pure reads over the ledger the run already owns. These tests pin the window
 * boundary (a record before the window is history, not "this round"), the true totals against the bounded page, the two
 * directions of the lineage walk with their depth/limit bounds, and that a prior-run reference stays a count, never evidence.
 */
const runId = 'run-explore';
const assetA = `asset-${'a'.repeat(24)}`, assetB = `asset-${'b'.repeat(24)}`;

const row = (id: string, patch: Partial<AssessmentRecord> = {}): AssessmentRecord =>
  ({ version: 2, id, runId, at: '2030-01-01T00:00:00.000Z', by: 'owner', kind: 'note', text: id, ...patch } as AssessmentRecord);
const claimRow = (id: string, candidate: string, data: Record<string, unknown> = {}, patch: Partial<AssessmentRecord> = {}): AssessmentRecord =>
  row(id, { by: 'worker-a', workerId: 'worker-a', kind: 'candidate', surface: '/fixture', risk: 'authorization', ...patch,
    data: { candidate, surface: '/fixture', risk: 'authorization', ...data } });
const taskRow = (id: string, status: string, extra: Record<string, unknown> = {}): AssessmentRecord =>
  row(`note-${id}`, { kind: 'task', data: { task: { runId, id, revision: 1, status, prerequisites: [], evidenceIds: [], ...extra } } });
const todo = (id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id, kind: 'todo', title: `Fixture plan row ${id}`, status, reason: 'Recorded so the fixture has one bounded row to read', ...extra });
const planRow = (recordId: string, plan: Record<string, unknown>): AssessmentRecord => row(recordId, { data: { plan: { runId, revision: 1, ...plan } } });
const caseDraft = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Fixture case over the recorded boundary', policyKey: 'policy:fixture', rootCauseKey: 'root:fixture',
  assetRefs: [{ id: assetA, revision: 1 }], claimRefs: ['claim-1'], independentEvidenceRefs: [],
  taskRefs: [{ taskId: 't-1', revision: 1 }], reportRefs: [], contradictions: [], affectedVariants: [],
  relatedCaseIds: [], verdict: 'confirmed', reviewStatus: 'accepted',
  reviewReason: 'Owner reviewed the exact fixture support for this case',
  limitations: 'Only the inert fixture receipt is covered',
  remediation: { status: 'unplanned', reason: 'No remediation was implemented or reviewed for this fixture', evidenceRefs: [] },
  ...overrides,
});
const caseRow = (recordId: string, id: string, overrides: Record<string, unknown> = {}, patch: Partial<AssessmentRecord> = {}): AssessmentRecord =>
  row(recordId, { ...patch, data: { case: { runId, id, revision: 1, ...caseDraft(overrides) } } });
const referenceRow = (id: string, reference: unknown): AssessmentRecord => row(id, { kind: 'lifecycle', data: { reference } });

/** The ledger one lineage test reads: a prerequisite task, a claim on a task, a plan row that cites both, and an accepted case. */
function lineageLedger(): AssessmentRecord[] {
  return [
    taskRow('t-0', 'reviewed'),
    taskRow('t-1', 'reported', { prerequisites: ['t-0'], parentTaskId: 't-0' }),
    claimRow('claim-1', 'fixture-claim', { closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', taskRef: 't-1', assetRefs: [{ id: assetA, revision: 1 }] }),
    planRow('plan-record', todo('todo-a', 'open', { taskIds: ['t-1'], claimRefs: ['claim-1'], goalIds: ['goal-a'] })),
    caseRow('case-record', 'case-a', { claimRefs: ['claim-1'], taskRefs: [{ taskId: 't-1', revision: 1 }] }),
  ];
}

describe('recentLearnings (P20/A2)', () => {
  it('reads only the window, newest first, and reports true totals against a bounded page', () => {
    const index = indexRecords([
      claimRow('claim-0', 'old-claim', { closure: 'open_proof_gap', execution: 'not_tested' }),
      claimRow('claim-1', 'claim-one', { closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', taskRef: 't-1', assetRefs: [{ id: assetA, revision: 1 }] }, { refs: ['ev-1'] }),
      claimRow('claim-2', 'claim-two', { closure: 'open_proof_gap', execution: 'not_tested' }),
      claimRow('claim-3', 'claim-three', { closure: 'confirmed', execution: 'tested', assetRefs: [{ id: assetB }] }),
    ], runId);
    const all = recentLearnings(index, { since: 0, limit: 2 });
    expect(all.since).toBe(0);
    expect(all.window).toBe(4);
    expect(all.counts).toEqual({ claims: 4, cases: 0, walls: 0 });
    expect(all.omitted).toEqual({ claims: 2, cases: 0, walls: 0 });
    expect(all.claims.map(claim => claim.recordId)).toEqual(['claim-3', 'claim-2']);

    const windowed = recentLearnings(index, { since: 2 });
    expect(windowed.since).toBe(2);
    expect(windowed.window).toBe(2);
    expect(windowed.counts.claims).toBe(2);
    expect(windowed.claims).toHaveLength(2);
    expect(windowed.claims[0]).toMatchObject({ recordId: 'claim-3', candidate: 'claim-three', closure: 'confirmed', execution: 'tested', assetIds: [assetB] });
    // The claim that carries the host-stamped source task and pinned asset is the one a planner must be able to read back.
    expect(windowed.claims[0]!.taskId).toBeUndefined();
    const fromOne = recentLearnings(index, { since: 1 });
    expect(fromOne.counts.claims).toBe(3);
    expect(fromOne.claims[1]).toMatchObject({ recordId: 'claim-2', closure: 'open_proof_gap', execution: 'not_tested', assetIds: [], evidenceIds: [] });
    expect(fromOne.claims[2]).toMatchObject({
      recordId: 'claim-1', taskId: 't-1', assetIds: [assetA], proof: 'offline_reproduction', evidenceIds: ['ev-1'],
    });
  });

  it('keeps one row per claim slug: the latest revision is the claim the run holds', () => {
    const index = indexRecords([
      claimRow('rev-1', 'same-claim', { closure: 'open_proof_gap' }, { surface: '/same' }),
      claimRow('rev-2', 'same-claim', { closure: 'confirmed', execution: 'tested' }, { surface: '/same', supersedes: 'rev-1' }),
      claimRow('other', 'other-claim'),
    ], runId);
    const learnings = recentLearnings(index);
    expect(learnings.counts.claims).toBe(2);
    expect(learnings.claims.map(claim => claim.recordId)).toEqual(['other', 'rev-2']);
    expect(learnings.claims[1]!.closure).toBe('confirmed');
  });

  it('lists accepted cases (never pending ones) and walls, bounded by the same window', () => {
    const index = indexRecords([
      claimRow('claim-1', 'fixture-claim', { closure: 'confirmed', execution: 'tested' }),
      caseRow('case-pending-record', 'case-pending', { policyKey: 'policy:pending', rootCauseKey: 'root:pending', reviewStatus: 'pending', claimRefs: ['claim-1'] }),
      caseRow('case-accepted', 'case-a'),
      planRow('wall-record', todo('wall-a', 'blocked', { debtRefs: ['debt-gap-untriaged-aaaaaaaaaaaa'] })),
      planRow('plain-record', todo('plain-a', 'blocked')),
      planRow('open-record', todo('open-a', 'open', { debtRefs: ['debt-gap-untriaged-aaaaaaaaaaaa'] })),
    ], runId);
    const learnings = recentLearnings(index, { since: 2 });
    expect(learnings.counts).toEqual({ claims: 0, cases: 1, walls: 1 });
    expect(learnings.cases).toEqual([{ recordId: 'case-accepted', caseId: 'case-a', verdict: 'confirmed', reviewStatus: 'accepted',
      assetIds: [assetA], taskIds: ['t-1'], claimRefs: ['claim-1'] }]);
    expect(learnings.walls).toEqual([{ planId: 'wall-a', recordId: 'wall-record', title: 'Fixture plan row wall-a', status: 'blocked',
      debtRefs: ['debt-gap-untriaged-aaaaaaaaaaaa'] }]);
    // A blocked todo with no debt id is not a wall (P19/C), and an open todo with one is not a wall either.
    expect(recentLearnings(index, { since: 4 }).counts.walls).toBe(0);
    expect(recentLearnings(index, { since: 3 }).counts.walls).toBe(1);
  });

  it('reads an empty or entirely folded ledger as zero recorded rows, not as a claim about learning', () => {
    const empty = recentLearnings(indexRecords([], runId));
    expect(empty).toMatchObject({ since: 0, window: 0, claims: [], cases: [], walls: [], counts: { claims: 0, cases: 0, walls: 0 } });
    const folded = recentLearnings(indexRecords([claimRow('claim-0', 'old-claim')], runId), { since: 1 });
    expect(folded).toMatchObject({ window: 0, counts: { claims: 0, cases: 0, walls: 0 } });
  });
});

describe('priorRunContext (P20/A5)', () => {
  it('reduces the newest reference lifecycle record to run identities and gap counts', () => {
    const reference = {
      runs: [{ runId: 'run-prior-1', targetDisplay: '/same-target', currency: 'stale' }, { runId: 'run-prior-2', currency: 'current' }],
      gaps: { covered: [{ kind: 'coverage', runId: 'run-prior-1' }], leftOpen: [{ kind: 'coverage' }, { kind: 'candidate' }],
        stale: [], neverReached: ['wstg-athn-01', 'wstg-athn-02', 'wstg-athn-03'], unknown: ['run-prior-2: unsupported schema'] },
    };
    const index = indexRecords([referenceRow('reference-old', { runs: [], gaps: {} }), referenceRow('reference-new', reference)], runId);
    expect(priorRunContext(index)).toEqual({
      recordId: 'reference-new',
      runs: [{ runId: 'run-prior-1', currency: 'stale' }, { runId: 'run-prior-2', currency: 'current' }],
      gaps: { covered: 1, leftOpen: 2, stale: 0, neverReached: 3, unknown: 1 },
    });
  });

  it('says nothing when no run-start reference was recorded, or when it found nothing', () => {
    expect(priorRunContext(indexRecords([row('plain-note')], runId))).toBeUndefined();
    expect(priorRunContext(indexRecords([referenceRow('reference-empty', { runs: [], gaps: {} })], runId))).toBeUndefined();
    // A malformed reference is unknown, never a clean result.
    expect(priorRunContext(indexRecords([referenceRow('reference-bad', 'not-an-object')], runId))).toBeUndefined();
    expect(priorRunContext(indexRecords([referenceRow('reference-bad-runs', { runs: [{ runId: '' }], gaps: {} })], runId))).toBeUndefined();
  });
});

describe('lineageOf (P20/A2)', () => {
  const index = indexRecords(lineageLedger(), runId);

  it('walks upstream to what a plan row stands on, and names a target that is not a knowledge head', () => {
    const lineage = lineageOf(index, 'plan-record')!;
    expect(lineage.root).toMatchObject({ domain: 'todo', entityId: 'todo-a', recordId: 'plan-record' });
    expect(lineage.upstream).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'task', domain: 'task', entityId: 't-1', depth: 1, resolved: true }),
      expect.objectContaining({ relation: 'claim', domain: 'candidate', entityId: expect.stringMatching(/^claim-head-/), depth: 1, resolved: true }),
      // A goal row that was never recorded is reported unresolved instead of being silently dropped.
      expect.objectContaining({ relation: 'goal', domain: 'unknown', entityId: 'goal-a', depth: 1, resolved: false }),
    ]));
    expect(lineage.downstream).toEqual([]);
  });

  it('walks downstream from a claim to the case that answers it, through the record id the case cites', () => {
    const lineage = lineageOf(index, 'claim-1')!;
    expect(lineage.root.domain).toBe('candidate');
    expect(lineage.upstream).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'task', entityId: 't-1', resolved: true }),
      expect.objectContaining({ relation: 'asset', entityId: assetA, resolved: false }),
    ]));
    expect(lineage.downstream).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'claim', domain: 'case', entityId: 'case-a', depth: 1, resolved: true }),
    ]));
  });

  it('walks a task downstream to its claim and case, and bounds depth and rows', () => {
    const task = lineageOf(index, 't-1')!;
    expect(task.root).toMatchObject({ domain: 'task', entityId: 't-1' });
    // Prerequisite and parent point at the same entity, so the walk reports it once (the first relation derived).
    expect(task.upstream).toEqual([expect.objectContaining({ relation: 'prerequisite', entityId: 't-0', depth: 1, resolved: true })]);
    expect(task.downstream).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'task', domain: 'candidate', recordId: 'claim-1', depth: 1, resolved: true }),
      expect.objectContaining({ relation: 'task', domain: 'todo', entityId: 'todo-a', depth: 1, resolved: true }),
      expect.objectContaining({ relation: 'task', domain: 'case', entityId: 'case-a', depth: 1, resolved: true }),
    ]));
    expect(lineageOf(index, 'plan-record', { depth: 1 })!.upstream.every(entry => entry.depth === 1)).toBe(true);
    const limited = lineageOf(index, 'plan-record', { depth: 2, limit: 1 })!;
    expect(limited.upstream).toHaveLength(1);
    expect(limited.omitted).toBeGreaterThan(0);
    expect(lineageOf(index, 'missing-id')).toBeUndefined();
  });
});

describe('whyPlanRow (P20/A2)', () => {
  const index = indexRecords(lineageLedger(), runId);

  it('answers with the plan row, the claims it cites, the tasks behind them and its lineage', () => {
    const why = whyPlanRow(index, 'todo-a')!;
    expect(why.plan.id).toBe('todo-a');
    expect(why.goals).toEqual(['goal-a']);
    expect(why.claims).toEqual([{
      recordId: 'claim-1', candidate: 'fixture-claim', closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction',
      taskId: 't-1', assetIds: [assetA], evidenceIds: [], surface: '/fixture', risk: 'authorization',
    }]);
    expect(why.tasks).toEqual(['t-1']);
    expect(why.upstream.root.entityId).toBe('todo-a');
    expect(why.upstream.upstream).toEqual(expect.arrayContaining([expect.objectContaining({ recordId: 'claim-1', relation: 'claim' })]));
  });

  it('returns nothing for a plan id the board does not hold', () => {
    expect(whyPlanRow(index, 'missing-plan')).toBeUndefined();
  });
});

describe('the knowledge index carries the host-stamped links a projection reads (P20/A1)', () => {
  it('links a claim to its source task and pinned assets, and a plan row to the claims it cites', () => {
    const claim = describeKnowledgeRecord(claimRow('claim-1', 'fixture-claim', { taskRef: 't-1', assetRefs: [{ id: assetA, revision: 2 }] }))!;
    expect(claim.domain).toBe('candidate');
    expect(claim.links).toEqual(expect.arrayContaining([['task', 't-1'], ['asset', assetA]]));
    const plan = describeKnowledgeRecord(planRow('plan-record', todo('todo-a', 'open', { claimRefs: ['claim-1'] })))!;
    expect(plan.links).toEqual(expect.arrayContaining([['claim', 'claim-1']]));
  });
});

describe('lineagePage (P20/A4)', () => {
  const index = indexRecords(lineageLedger(), runId);

  it('answers a plan row with the row, its goals, claims, tasks and its upstream walk', () => {
    const page = lineagePage(index, 'todo-a')!;
    expect(page.label).toBe(LINEAGE_LABEL);
    expect(page.plan).toMatchObject({ id: 'todo-a', kind: 'todo' });
    expect(page.goals).toEqual(['goal-a']);
    expect(page.claims?.map(claim => claim.recordId)).toEqual(['claim-1']);
    expect(page.tasks).toEqual(['t-1']);
    expect(page.lineage.root.entityId).toBe('todo-a');
    expect(page.truncated).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(GRAPH_RESPONSE_BYTES);
  });

  it('answers any other knowledge record id with its own walk, and trims rows tail-first under a small budget', () => {
    const record = lineagePage(index, 'claim-1')!;
    expect(record.plan).toBeUndefined();
    expect(record.lineage.root.domain).toBe('candidate');
    // A dense page (six cited claims plus the walk) is trimmed until it fits, and says it was trimmed.
    const claims = Array.from({ length: 6 }, (_, at) => claimRow(`dense-claim-${at}`, `fixture-claim-${at}`,
      { closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', taskRef: 't-1', assetRefs: [{ id: assetA, revision: 1 }] }));
    const dense = lineagePage(indexRecords([...claims, planRow('dense-plan', todo('todo-dense', 'open',
      { claimRefs: claims.map(claim => claim.id!), goalIds: ['goal-a'] }))], runId), 'todo-dense', { budget: 1024 })!;
    expect(dense.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(dense))).toBeLessThanOrEqual(1024);
    expect(lineagePage(index, 'missing-id')).toBeUndefined();
  });

  it('is a pure read: the same index builds the same page twice', () => {
    expect(lineagePage(index, 'todo-a')).toEqual(lineagePage(index, 'todo-a'));
  });
});
