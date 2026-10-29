import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssessmentStore } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { CaseBoard } from '../../src/cases.js';
import { CoverageBoard, coverageFingerprint } from '../../src/coverage.js';
import { PlanBoard } from '../../src/planning.js';
import { TaskBoard, type AssessmentTask, type TaskDraft } from '../../src/tasks.js';
import { appendRecord, type AssessmentRecord } from '../../src/records.js';
import type { CaseDraft } from '../../src/case-types.js';
import type { CoverageCellDraft, CoveragePlanDraft } from '../../src/coverage-types.js';
import type { PlanDraft } from '../../src/planning.js';
import { fixture, seedImpactGoal } from './helpers/report-fixture.js';

/**
 * P10 authoring half: the host carries the honest defaults and the joins the planner previously had to restate by hand.
 * Every test here is hermetic (real SQLite store, inert receipts, no model/network/docker) and pins one owner decision.
 */
const runId = 'run-p10';
const work = (assetId: string, questionKey: string) => ({
  assetRefs: [{ id: assetId, revision: 1 }], questionKey, policyKey: 'policy:p10', actorContext: 'actor:a', tenantContext: 'tenant:a',
  methodFamily: 'offline-observation', purpose: 'investigation' as const,
});
const taskDraft = (assetId: string, questionKey: string): TaskDraft => ({
  question: 'Does the bounded fixture observation match the declared policy?', surface: '/p10', risk: 'authorization', role: 'general',
  roleReason: 'P10 authoring fixture only', expectedTrue: 'The receipt records the observed policy behavior', expectedFalse: 'The receipt records the contrasting control',
  stopCondition: 'Stop after one inert observation and owner review', evidenceIds: [], prerequisites: [],
  method: { skills: [], reason: 'Inert fixture method without target activity' }, work: work(assetId, questionKey),
});
const claimData = (extra: Record<string, unknown> = {}) => ({
  candidate: 'p10-claim', closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', policyBasis: 'boundary_invariant',
  expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Only the fixture actor and object variant were reviewed',
  negativeControls: [], control: '', ...extra,
});
const caseBase = (overrides: Partial<CaseDraft> = {}): CaseDraft => ({
  title: 'P10 bounded case', policyKey: 'policy:p10', rootCauseKey: 'root:p10', assetRefs: [], claimRefs: [], independentEvidenceRefs: [],
  taskRefs: [], reportRefs: [], contradictions: [], affectedVariants: ['variant:a'], relatedCaseIds: [], verdict: 'confirmed',
  reviewStatus: 'pending', reviewReason: 'Pending exact owner review of current support', limitations: 'Only the bounded fixture is claimed',
  remediation: { status: 'unplanned', reason: 'No remediation was reviewed in this fixture', evidenceRefs: [] }, ...overrides,
});

interface ReviewedWork { task: AssessmentTask; claimId: string; evidenceId: string }
async function boardFixture(body: (h: {
  store: AssessmentStore; path: string; assetId: string; tasks: TaskBoard; cases: CaseBoard; coverage: CoverageBoard; plans: PlanBoard;
  receipt: (by?: string) => string; claim: (taskId: string, extra?: Record<string, unknown>) => string;
  reviewedTask: (questionKey: string, claimExtra?: Record<string, unknown>) => Promise<ReviewedWork>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-p10-')), store = AssessmentStore.create(root, {
    runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture', targetDisplay: 'fixture',
    profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' },
  }), path = join(root, 'alias.sqlite'), unbind = bindAssessmentStore(path, store);
  const assetId = store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /p10' } }] })[0].entityId,
    caseContext = { assetRevision: (id: string) => store.assetRevision(id), assertionRevision: (id: string) => store.assertionRevision(id) },
    coverageContext = { ...caseContext, targetRevision: () => store.graphScope(), assetIds: () => store.assetEntityIds() },
    tasks = new TaskBoard(runId, path, () => true, Date.now, () => store.graphScope(), id => store.assetRevision(id)),
    cases = new CaseBoard(runId, path, () => true, caseContext), coverage = new CoverageBoard(runId, path, () => true, coverageContext),
    plans = new PlanBoard(runId, path, () => true, Date.now, undefined, caseContext);
  const receipt = (by = 'worker-a') => store.commitRecords([{ id: randomUUID(), runId, at: '2030', by, workerId: by === 'owner' ? undefined : by, kind: 'evidence', text: 'Inert P10 receipt, not a finding' }])[0].recordId;
  const claim = (taskId: string, extra: Record<string, unknown> = {}) => {
    const evidence = receipt(), record: AssessmentRecord = {
      id: randomUUID(), runId, at: '2030', by: 'worker-a', workerId: 'worker-a', kind: 'candidate', text: 'Bounded P10 claim',
      surface: '/p10', risk: 'authorization', outcome: 'confirmed', refs: [evidence],
      data: { ...claimData(extra), taskRef: taskId, evidenceRefs: Array.isArray(extra.evidenceRefs) ? extra.evidenceRefs : [evidence] },
    };
    store.commitRecords([record]); return record.id!;
  };
  const reviewedTask = async (questionKey: string, claimExtra: Record<string, unknown> = {}): Promise<ReviewedWork> => {
    const created = await tasks.create(taskDraft(assetId, questionKey)); await tasks.reserve(created.id, 'owner');
    await tasks.transition(created.id, 'running', 'Owner began the inert P10 fixture');
    // The claim is recorded before the reviewed head: only claims the review could have seen are the task's reviewed claims.
    const claimId = claim(created.id, claimExtra), evidenceId = receipt('owner');
    const done = await tasks.transition(created.id, 'reviewed', 'Owner reviewed the bounded receipt', [evidenceId]);
    return { task: done, claimId, evidenceId };
  };
  try { await body({ store, path, assetId, tasks, cases, coverage, plans, receipt, claim, reviewedTask }); }
  finally { unbind(); store.close(); await rm(root, { recursive: true, force: true }); }
}

describe('P10 case references (TR-L01)', () => {
  it('P10/TR-L01: derives pinned asset refs and reviewed claim refs from taskRefs only', async () => boardFixture(async ({ cases, reviewedTask, assetId }) => {
    const reviewed = await reviewedTask('question:derive');
    const created = await cases.create(caseBase({ taskRefs: [{ taskId: reviewed.task.id, revision: reviewed.task.revision }] }));
    expect(created.assetRefs).toEqual([{ id: assetId, revision: 1 }]);
    expect(created.claimRefs).toEqual([reviewed.claimId]);
    expect((await cases.list())[0]).toMatchObject({ currentness: 'current', acceptedFinding: false });
  }));

  it('P10/TR-L01: accepts a candidate slug in claimRefs and stores the resolved record id', async () => boardFixture(async ({ cases, reviewedTask, assetId }) => {
    const reviewed = await reviewedTask('question:slug');
    const created = await cases.create(caseBase({ assetRefs: [{ id: assetId, revision: 1 }], claimRefs: ['p10-claim'] }));
    expect(created.claimRefs).toEqual([reviewed.claimId]);
  }));

  it('P10/TR-L01: refuses an unknown claim slug with the legal next step', async () => boardFixture(async ({ cases, assetId }) => {
    await expect(cases.create(caseBase({ assetRefs: [{ id: assetId, revision: 1 }], claimRefs: ['claim-that-does-not-exist'] })))
      .rejects.toThrow(/Unknown case claim reference claim-that-does-not-exist.*legalNext: copy the record ID from p2o_ledger/);
  }));

  it('P10/TR-L01: refuses an empty derivation with an actionable message instead of a generic schema error', async () => boardFixture(async ({ cases, assetId, tasks }) => {
    const created = await tasks.create(taskDraft(assetId, 'question:noreceipt'));
    await expect(cases.create(caseBase({ taskRefs: [{ taskId: created.id, revision: created.revision }] })))
      .rejects.toThrow(/Case needs exact claim references.*review the worker claim first/);
  }));
});

describe('P10 host defaults (TR-L05/L06)', () => {
  it('P10/TR-L05: a goal created without a status is an active promise, and completion still reads it as open work', async () => boardFixture(async ({ plans }) => {
    const { status: _status, ...withoutStatus } = { kind: 'goal' as const, title: 'P10 goal without status', status: 'active', reason: 'Bounded fixture goal with a proof', criteria: ['The receipt is reviewed'], proof: { kind: 'capability' as const, capability: { kind: 'file.read' as const, subject: 'p10' } } } satisfies PlanDraft;
    const created = await plans.create(withoutStatus as unknown as PlanDraft);
    expect(created.status).toBe('active');
  }));

  it('P10/TR-L06: a case created without reviewStatus/remediation is pending and honestly unplanned', async () => boardFixture(async ({ cases, reviewedTask }) => {
    const reviewed = await reviewedTask('question:defaults');
    const { reviewStatus: _review, remediation: _remediation, ...rest } = caseBase({ taskRefs: [{ taskId: reviewed.task.id, revision: reviewed.task.revision }] });
    const created = await cases.create(rest as CaseDraft);
    expect(created).toMatchObject({ reviewStatus: 'pending', remediation: { status: 'unplanned', evidenceRefs: [] } });
    expect(created.remediation.reason).toContain('No remediation was planned or reviewed');
  }));

  it('P10/TR-L06: a coverage plan created without status/exclusions/unknownScope is a draft with empty scope lists', async () => boardFixture(async ({ coverage }) => {
    const created = await coverage.createPlan({ title: 'P10 plan without scope', reason: 'Explicit bounded denominator for the default fixture' } as CoveragePlanDraft);
    expect(created).toMatchObject({ status: 'draft', exclusions: [], unknownScope: [] });
  }));

  it('P10/TR-L06: the task-create host stores empty evidence/prerequisite arrays when the intent omits them', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      await seedImpactGoal(h);
      const draft = { question: 'Does the bounded P10 fixture record empty task arrays?', surface: '/p10-fixture', risk: 'coordination', role: 'general',
        roleReason: 'Bounded local fixture with no target work', expectedTrue: 'The host records empty arrays', expectedFalse: 'The caller must restate none',
        stopCondition: 'Stop after one local admission', skills: [], methodReason: 'No target or model work' };
      const task = (await h.call('p2o_task_author', { draft })).details;
      expect(task.evidenceIds).toEqual([]); expect(task.prerequisites).toEqual([]);
      const stored = (await h.reader()).records().find((row: any) => row.data?.task?.id === task.id) as any;
      expect(stored.data.task).toMatchObject({ evidenceIds: [], prerequisites: [] });
    });
  });
});

describe('P10 todo criteria are advisory (TR-L08)', () => {
  it('P10/TR-L08: a todo may carry criteria/exclusions, recorded but never a completion gate', async () => boardFixture(async ({ plans }) => {
    const todo = await plans.create({ kind: 'todo', title: 'P10 advisory checklist todo', status: 'open', reason: 'Explicit bounded checklist fixture',
      criteria: ['The receipt is inspected by the owner'], exclusions: ['No target execution in this fixture'] } as PlanDraft);
    expect(todo).toMatchObject({ criteria: ['The receipt is inspected by the owner'], exclusions: ['No target execution in this fixture'] });
  }));

  it('P10/TR-L08: a decision row still refuses criteria/exclusions, and a goal still needs criteria', async () => boardFixture(async ({ plans }) => {
    // validatePlanDraft refuses before the board returns a promise, so the refusal is asserted on the call itself.
    expect(() => plans.create({ kind: 'decision', title: 'P10 decision with criteria', status: 'recorded', reason: 'Explicit bounded decision fixture',
      criteria: ['A criterion a decision cannot hold'], decision: { disposition: 'defer', chosenTaskIds: [], deferredTaskIds: [] } } as PlanDraft))
      .toThrow(/Only goals and todos define criteria\/exclusions/);
    expect(() => plans.create({ kind: 'goal', title: 'P10 goal without criteria', reason: 'Bounded fixture goal with no acceptance criteria',
      proof: { kind: 'capability', capability: { kind: 'file.read', subject: 'p10' } } } as PlanDraft)).toThrow('Goal needs bounded acceptance criteria');
  }));
});

describe('P10 goal settlement (TR-L07)', () => {
  it('P10/TR-L07: a goal whose capability proof holds may be settled without supportRefs, and the host records the demonstrating claim', async () => boardFixture(async ({ plans, claim }) => {
    const proofClaim = claim('task-p10-unused', { gained: [{ kind: 'file.read', subject: 'p10-proof' }] }),
      goal: PlanDraft = { kind: 'goal', title: 'P10 capability proof goal', status: 'active', reason: 'Bounded fixture goal settled by a demonstrated capability',
        criteria: ['A confirmed tested claim gains the capability'], proof: { kind: 'capability', capability: { kind: 'file.read', subject: 'p10-proof' } } };
    const created = await plans.create(goal);
    const reviewed = await plans.revise(created.id, 1, { ...goal, status: 'reviewed' });
    expect(reviewed.supportRefs).toEqual([proofClaim]);
    // The recorded proof is itself a support reference, so the close revision round-trips without the caller editing the row.
    const closed = await plans.revise(reviewed.id, reviewed.revision, { ...goal, status: 'closed', supportRefs: reviewed.supportRefs });
    expect(closed.status).toBe('closed');
  }));

  it('P10/TR-L07: an accepted current case proof settles a goal without supportRefs', async () => boardFixture(async ({ plans, cases, reviewedTask, assetId }) => {
    const reviewed = await reviewedTask('question:case-proof'),
      pending = await cases.create(caseBase({ assetRefs: [{ id: assetId, revision: 1 }], claimRefs: [reviewed.claimId], taskRefs: [{ taskId: reviewed.task.id, revision: reviewed.task.revision }] })),
      { runId: _run, revision: _revision, recordId: _record, ...editable } = pending,
      accepted = await cases.revise(pending.id, 1, { ...editable, reviewStatus: 'accepted', reviewReason: 'Owner accepted exact bounded case support' }),
      goal: PlanDraft = { kind: 'goal', title: 'P10 case proof goal', status: 'active', reason: 'Bounded fixture goal settled by an accepted case',
        criteria: ['An accepted current case settles this goal'], proof: { kind: 'case', ref: accepted.id } };
    const created = await plans.create(goal);
    const reviewedGoal = await plans.revise(created.id, 1, { ...goal, status: 'reviewed' });
    expect(reviewedGoal.supportRefs).toEqual([accepted.id]);
  }));

  it('P10/TR-L07: an unsatisfied proof is still refused, even with no supportRefs', async () => boardFixture(async ({ plans }) => {
    const goal: PlanDraft = { kind: 'goal', title: 'P10 unproven capability goal', status: 'active', reason: 'Bounded fixture goal with no demonstration',
      criteria: ['A demonstration is expected'], proof: { kind: 'capability', capability: { kind: 'host.shell' } } };
    const created = await plans.create(goal);
    await expect(plans.revise(created.id, 1, { ...goal, status: 'reviewed' })).rejects.toThrow(/GOAL_UNPROVEN: no confirmed and tested claim gains host.shell/);
  }));
});

describe('P10 plan support references (TR-L09)', () => {
  it('P10/TR-L09: supportRefs accept same-run candidate, task and plan ids, and still refuse an unknown one', async () => boardFixture(async ({ plans, reviewedTask }) => {
    const reviewed = await reviewedTask('question:support'), todo = await plans.create({ kind: 'todo', title: 'P10 support carrier todo', status: 'open', reason: 'Explicit bounded support fixture' } as PlanDraft),
      goal: PlanDraft = { kind: 'goal', title: 'P10 support references goal', status: 'active', reason: 'Bounded fixture goal standing on recorded work',
        criteria: ['Recorded work is cited'], proof: { kind: 'capability', capability: { kind: 'file.read', subject: 'p10' } }, supportRefs: [reviewed.claimId, reviewed.task.id, todo.id] };
    const created = await plans.create(goal);
    expect(created.supportRefs).toEqual([reviewed.claimId, reviewed.task.id, todo.id]);
    await expect(plans.create({ ...goal, supportRefs: ['foreign-receipt'] })).rejects.toThrow(/not a same-run evidence, candidate, task or plan reference/);
  }));
});

describe('P10 paged coverage plan view (TR-H02)', () => {
  it('P10/TR-H02: a large plan pages its derived cells with stable totals and a nextCursor walk', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const asset = (await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /p10-pages' } }] } })).details.acks[0],
        run = await h.runId(), reader = await h.reader(), targetRevision = reader.graphScope();
      // The extension holds the writable store; its private broker alias is bound to that same store, so a canonical append here is
      // a same-run record the tools read. A pre-A3 stored plan is the only way to hold this many cells without 80 reviewed tasks.
      const [control] = (await readdir(join(h.root, 'control'))).filter((name: string) => name.startsWith('p2o-run-')),
        ledger = join(h.root, 'control', control, 'records.sqlite'), planId = 'coverage-plan-p10-pages',
        draft = (index: number): CoverageCellDraft => ({
          assetRef: { id: asset.entityId, revision: 1 }, questionKey: `question:p10-${index}`, policyKey: 'policy:p10',
          actorContext: 'actor:a', tenantContext: 'tenant:a', methodFamily: 'offline-observation', execution: 'planned', assessment: 'unreviewed',
          taskRefs: [], claimRefs: [], caseRefs: [], evidenceRefs: [], negativeControlRefs: [], gapRefs: [], reason: 'Paged fixture row', limitations: 'Fixture only',
        }),
        cells = Array.from({ length: 80 }, (_, index) => { const input = draft(index), id = `coverage-cell-p10-${index}`; return { id, input, fingerprint: coverageFingerprint(targetRevision, input) }; });
      reader.close();
      await appendRecord(ledger, { id: randomUUID(), runId: run, at: '2030', by: 'owner', kind: 'note', text: 'P10 paged coverage plan', data: { coveragePlan: { id: planId, runId: run, revision: 1, title: 'P10 paged coverage plan', status: 'active', reason: 'Explicit bounded paged denominator', exclusions: [], unknownScope: [], targetRevision, cellIds: cells.map(cell => cell.id) } } });
      for (const cell of cells) await appendRecord(ledger, { id: cell.id, runId: run, at: '2030', by: 'owner', kind: 'note', text: 'P10 stored paging cell', data: { coverageCell: { ...cell.input, id: cell.id, runId: run, revision: 1, planId, planRevision: 1, targetRevision, fingerprint: cell.fingerprint, retired: false } } });
      const first = (await h.call('p2o_board', { board: 'coverage', id: planId })).details;
      // The page is small; the totals are the whole denominator, and the paging rule is stated in the warning.
      expect(first).toMatchObject({ total: 80, shown: 20, omitted: 60, cursor: 0, nextCursor: 20, counts: { execution: { planned: 80 }, assessment: { unreviewed: 80 } } });
      expect(first.cells.map((cell: any) => cell.id)).toEqual(cells.slice(0, 20).map(cell => cell.id));
      expect(first.warning).toContain('Cells are paged');
      const ids: string[] = [...first.cells.map((cell: any) => cell.id)];
      let cursor: number | undefined = first.nextCursor;
      while (cursor !== undefined) {
        const page = (await h.call('p2o_board', { board: 'coverage', id: planId, cursor })).details as any;
        expect(page).toMatchObject({ total: 80, cursor }); expect(page.shown).toBeGreaterThan(0); expect(page.cells).toHaveLength(page.shown);
        ids.push(...page.cells.map((cell: any) => cell.id)); cursor = page.nextCursor;
      }
      expect(ids).toEqual(cells.map(cell => cell.id));
    });
  }, 60_000);
});
