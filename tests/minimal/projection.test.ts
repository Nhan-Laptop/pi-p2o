import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssessmentStore } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { CoverageBoard, type CoveragePlanView } from '../../src/coverage.js';
import type { CoveragePlanDraft } from '../../src/coverage-types.js';
import { CaseBoard } from '../../src/cases.js';
import type { CaseDraft, CaseEntry } from '../../src/case-types.js';
import { TaskBoard, type TaskDraft } from '../../src/tasks.js';
import { readLedger, type AssessmentRecord } from '../../src/records.js';
import { reportProjection } from '../../src/report.js';
import { finishPreflight } from '../../src/finish-preflight.js';
import { ALL_TOOLS, HIDDEN_TOOLS, MODEL_TOOLS, PLANNER_TOOLS } from '../../src/tool-policy.js';
import { BOARD_ACTION_VERBS, COVERAGE_VERB_NAMES } from '../../src/board-verbs.js';
import { TOOL_BOUNDARIES } from '../../src/tool-guidelines.js';

/**
 * A3 (planning_update.md §2.6, P2): coverage is a projection of reviewed work. These tests are the hermetic acceptance:
 * cells derive from reviewed tasks, worker claims and accepted cases; unmapped work is a named gap, never a clean cell;
 * staleness is the existing revision/currentness rule; and no model-facing verb can author or retire a cell.
 */
const runId = 'run-projection';
const workIdentity = (assetId: string, questionKey = 'question:object-access') => ({
  assetRefs: [{ id: assetId, revision: 1 }], questionKey, policyKey: 'policy:coverage', actorContext: 'actor:a', tenantContext: 'tenant:a',
  methodFamily: 'offline-observation', purpose: 'mapping' as const,
});
const taskDraft = (assetId: string, questionKey?: string): TaskDraft => ({
  question: 'Does the bounded fixture observation match the declared policy?', surface: '/a', risk: 'authorization', role: 'recon',
  roleReason: 'Coverage projection fixture only', expectedTrue: 'The receipt records the observed policy behavior', expectedFalse: 'The receipt records the contrasting control',
  stopCondition: 'Stop after one inert observation and owner review', evidenceIds: [], prerequisites: [],
  method: { skills: [], reason: 'Inert fixture method without target activity' }, work: workIdentity(assetId, questionKey),
});
const plan = (overrides: Partial<CoveragePlanDraft> = {}): CoveragePlanDraft => ({
  title: 'Derived authorization denominator', status: 'active', reason: 'Explicit bounded denominator for the projection fixture',
  exclusions: ['No undeclared actors or routes'], unknownScope: ['Deployment parity outside fixture is unknown'], ...overrides,
});
const claimData = (closure: string, extra: Record<string, unknown> = {}) => ({
  candidate: 'projection-claim', closure, execution: closure === 'confirmed' ? 'tested' : 'not_tested', proof: closure === 'confirmed' ? 'offline_reproduction' : 'static_trace',
  policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Only the fixture actor and object variant were reviewed',
  negativeControls: [], control: '', ...extra,
});

interface ReviewedWork { id: string; revision: number; evidenceId: string; claimId?: string }
async function fixture(workBody: (h: {
  store: AssessmentStore; coverage: CoverageBoard; cases: CaseBoard; tasks: TaskBoard; assetId: string; path: string;
  receipt: (by?: string) => string; claim: (taskId: string, closure?: string, extra?: Record<string, unknown>) => string;
  reviewed: (assetId: string, questionKey?: string, claimClosure?: string) => Promise<ReviewedWork>;
  acceptedCase: (claimId: string, task: ReviewedWork, verdict?: 'confirmed' | 'ruled_out') => Promise<CaseEntry>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-projection-')), store = AssessmentStore.create(root, {
    runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture', targetDisplay: 'fixture',
    profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' },
  }), path = join(root, 'alias.sqlite'), unbind = bindAssessmentStore(path, store);
  const [assetId] = store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /a' } }, { asset: { kind: 'endpoint', key: 'GET /b' } }] }).map(row => row.entityId),
    caseContext = { assetRevision: (id: string) => store.assetRevision(id), assertionRevision: (id: string) => store.assertionRevision(id) },
    coverageContext = { ...caseContext, targetRevision: () => store.graphScope(), assetIds: () => store.assetEntityIds() },
    cases = new CaseBoard(runId, path, () => true, caseContext), coverage = new CoverageBoard(runId, path, () => true, coverageContext),
    tasks = new TaskBoard(runId, path, () => true, Date.now, () => store.graphScope(), id => store.assetRevision(id));
  const receipt = (by = 'worker-a') => store.commitRecords([{ id: randomUUID(), runId, at: '2030', by, workerId: by === 'owner' ? undefined : by, kind: 'evidence', text: 'Inert projection receipt' }])[0].recordId;
  /** A worker claim carries the host-stamped `data.taskRef`; the projection reads only the claims the review accepted. */
  const claim = (taskId: string, closure = 'confirmed', extra: Record<string, unknown> = {}) => {
    const evidence = receipt(), record: AssessmentRecord = {
      id: randomUUID(), runId, at: '2030', by: 'worker-a', workerId: 'worker-a', kind: 'candidate', text: 'Bounded projection claim',
      surface: '/a', risk: 'authorization', outcome: closure as AssessmentRecord['outcome'], refs: [evidence],
      data: { ...claimData(closure, extra), taskRef: taskId, evidenceRefs: [evidence], ...(closure === 'ruled_out' ? { negativeControls: [evidence], control: 'Fixture negative control' } : {}) },
    };
    store.commitRecords([record]); return record.id!;
  };
  const reviewed = async (asset: string, questionKey = 'question:object-access', claimClosure?: string): Promise<ReviewedWork> => {
    const created = await tasks.create(taskDraft(asset, questionKey)); await tasks.reserve(created.id, 'owner');
    await tasks.transition(created.id, 'running', 'Owner began the inert projection fixture');
    const claimId = claimClosure ? claim(created.id, claimClosure) : undefined;
    const evidenceId = receipt('owner'), done = await tasks.transition(created.id, 'reviewed', 'Owner reviewed the bounded receipt', [evidenceId]);
    return { id: done.id, revision: done.revision, evidenceId, ...(claimId ? { claimId } : {}) };
  };
  const editable = (entry: CaseEntry): CaseDraft => { const { runId: _run, revision: _revision, recordId: _record, ...draft } = entry; return draft; };
  const acceptedCase = async (claimId: string, task: ReviewedWork, verdict: 'confirmed' | 'ruled_out' = 'confirmed') => {
    const draft: CaseDraft = {
      title: 'Projection case', policyKey: 'policy:coverage', rootCauseKey: verdict === 'confirmed' ? 'root:gate' : 'root:effective-control',
      assetRefs: [{ id: assetId, revision: store.assetRevision(assetId)! }], claimRefs: [claimId], independentEvidenceRefs: [], taskRefs: [{ taskId: task.id, revision: task.revision }],
      reportRefs: [], contradictions: [], affectedVariants: ['variant:a'], relatedCaseIds: [], verdict, reviewStatus: 'pending',
      reviewReason: 'Pending exact support review', limitations: 'Bounded fixture only',
      remediation: { status: 'unplanned', reason: 'No remediation review applies to this fixture', evidenceRefs: [] },
    };
    const created = await cases.create(draft);
    return cases.revise(created.id, 1, { ...editable(created), reviewStatus: 'accepted', reviewReason: 'Owner accepted exact bounded support and limitations' });
  };
  try { await workBody({ store, coverage, cases, tasks, assetId, path, receipt, claim, reviewed, acceptedCase }); }
  finally { unbind(); store.close(); await rm(root, { recursive: true, force: true }); }
}
const planView = (views: Promise<CoveragePlanView[]>) => views.then(list => list[0]);

describe('coverage projection (A3)', () => {
  it('derives zero cells and a no-denominator-work warning when the plan has no tasks', async () => fixture(async ({ coverage }) => {
    await coverage.createPlan(plan());
    const view = await planView(coverage.list());
    expect(view).toMatchObject({ derivation: 'projected', cells: [], cellIds: [], omittedCells: 0, unmappedCount: 0 });
    expect(view.counts).toEqual({ execution: {}, assessment: {}, stale: 0, reviewed: 0 });
    expect(view.warning).toContain('no denominator work');
    expect(view.warning).toContain('not clean coverage');
    // Derivations are the denominator: a plan with no work cannot be reviewed, so a zero task run cannot look finished.
    await expect(coverage.revisePlan(view.id, view.revision, plan({ status: 'reviewed' }))).rejects.toThrow('at least one denominator cell');
  }));

  it('derives one planned cell from a reviewed recon task whose receipt is not a claim', async () => fixture(async ({ coverage, reviewed, assetId }) => {
    await coverage.createPlan(plan());
    const task = await reviewed(assetId);
    const view = await planView(coverage.list());
    expect(view.cells).toHaveLength(1);
    expect(view.cells[0]).toMatchObject({ execution: 'planned', assessment: 'unreviewed', currentness: 'current', assetRef: { id: assetId, revision: 1 } });
    expect(view.cells[0].taskRefs).toEqual([{ taskId: task.id, revision: task.revision }]);
    expect(view.counts.execution).toEqual({ planned: 1 });
  }));

  it('derives a tested confirmed_claim cell with task and claim references auto-filled', async () => fixture(async ({ coverage, reviewed, assetId }) => {
    await coverage.createPlan(plan());
    const task = await reviewed(assetId, 'question:object-access', 'confirmed');
    const view = await planView(coverage.list()), cell = view.cells[0];
    expect(cell).toMatchObject({ execution: 'tested', assessment: 'confirmed_claim', currentness: 'current', staleReasons: [] });
    expect(cell.taskRefs).toEqual([{ taskId: task.id, revision: task.revision }]);
    expect(cell.claimRefs).toEqual([task.claimId]);
    expect(task.claimId).toBeTruthy();
    expect(view.counts.assessment).toEqual({ confirmed_claim: 1 });
  }));

  it('derives tested ruled_out_bounded from a bounded negative claim and its control', async () => fixture(async ({ coverage, reviewed, assetId }) => {
    await coverage.createPlan(plan());
    const task = await reviewed(assetId, 'question:ruled-out', 'ruled_out');
    const cell = (await planView(coverage.list())).cells[0];
    expect(cell).toMatchObject({ execution: 'tested', assessment: 'ruled_out_bounded', currentness: 'current' });
    expect(cell.claimRefs).toEqual([task.claimId]);
    // The negative control comes from the claim the review accepted, never from a model-authored cell field.
    expect(cell.negativeControlRefs.length).toBeGreaterThan(0);
  }));

  it('derives tested open_gap from an open worker claim instead of clean coverage', async () => fixture(async ({ coverage, reviewed, assetId }) => {
    await coverage.createPlan(plan());
    const task = await reviewed(assetId, 'question:open', 'open_proof_gap');
    const cell = (await planView(coverage.list())).cells[0];
    expect(cell).toMatchObject({ execution: 'tested', assessment: 'open_gap', currentness: 'current', reviewed: false });
    expect(cell.claimRefs).toEqual([task.claimId]);
  }));

  it('derives tested accepted with case references from a current accepted case', async () => fixture(async ({ coverage, reviewed, acceptedCase, assetId, cases }) => {
    await coverage.createPlan(plan());
    const task = await reviewed(assetId, 'question:accepted', 'confirmed'), settled = await acceptedCase(task.claimId!, task);
    expect((await cases.list())[0].reviewStatus).toBe('accepted');
    const view = await planView(coverage.list()), cell = view.cells[0];
    expect(cell).toMatchObject({ execution: 'tested', assessment: 'accepted', currentness: 'current', reviewed: true });
    expect(cell.caseRefs).toEqual([{ caseId: settled.id, revision: settled.revision }]);
    expect(view.counts.reviewed).toBe(1);
  }));

  it('reports a task without asset references as an unmapped gap, never a cell', async () => fixture(async ({ coverage, tasks, store, path }) => {
    await coverage.createPlan(plan());
    const created = await tasks.create({
      question: 'What did the bounded prose-only observation record?', surface: '/legacy', risk: 'authorization', role: 'general',
      roleReason: 'Legacy prose fixture without a work identity', expectedTrue: 'The receipt records the observation', expectedFalse: 'The receipt records the control',
      stopCondition: 'Stop after one inert prose observation', evidenceIds: [], prerequisites: [], method: { skills: [], reason: 'Inert prose fixture method' },
    });
    const view = await planView(coverage.list());
    expect(view.cells).toHaveLength(0);
    expect(view.unmappedCount).toBe(1);
    expect(view.unmapped[0]).toMatchObject({ taskId: created.id, revision: 1, role: 'general', status: 'proposed' });
    expect(view.unmapped[0].reason).toContain('no work.assetRefs');
    expect(view.warning).toContain('no denominator work');
    // The gap is carried into the report and preflight too, so a finish cannot quietly drop it.
    const index = await readLedger(path, runId), context = { assetRevision: (id: string) => store.assetRevision(id), assertionRevision: (id: string) => store.assertionRevision(id) },
      projection = reportProjection(index, { cases: context, coverage: { ...context, targetRevision: () => store.graphScope(), assetIds: () => store.assetEntityIds() } });
    expect(projection.coveragePlans[0]).toMatchObject({ unmappedTasks: 1 });
    expect(projection.counts.unmappedCoverageTasks).toBe(1);
    const unmapped = finishPreflight(index, { coverage: { targetRevision: () => store.graphScope(), assetRevision: () => 1 }, integrity: 'annotate' }).advisory.find(item => item.code === 'UNMAPPED_TASK');
    expect(unmapped).toMatchObject({ count: 1, ids: [created.id] });
  }));

  it('stales a derived cell when the declared asset revision moves', async () => fixture(async ({ coverage, reviewed, store, assetId }) => {
    await coverage.createPlan(plan());
    await reviewed(assetId, 'question:asset', 'confirmed');
    expect((await planView(coverage.list())).cells[0].currentness).toBe('current');
    store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /a', label: 'changed revision', expectedRevision: 1 } }] });
    const cell = (await planView(coverage.list())).cells[0];
    expect(cell.currentness).toBe('stale');
    expect(cell.effectiveAssessment).toBe('stale');
    expect(cell.staleReasons).toContain(`stale-asset:${assetId}@r1->r2`);
  }));

  it('stales a derived cell when a later claim revision supersedes the reviewed claim', async () => fixture(async ({ coverage, reviewed, store, assetId }) => {
    await coverage.createPlan(plan());
    const task = await reviewed(assetId, 'question:claim', 'confirmed');
    // A claim recorded after the review is a new revision of the same candidate slug: the reviewed claim is no longer the head.
    store.commitRecords([{
      id: randomUUID(), runId, at: '2031', by: 'worker-a', workerId: 'worker-a', kind: 'candidate', text: 'Later claim revision',
      surface: '/a', risk: 'authorization', outcome: 'open_proof_gap', refs: [], supersedes: task.claimId,
      data: { ...claimData('open_proof_gap'), taskRef: task.id, evidenceRefs: [] },
    }]);
    const cell = (await planView(coverage.list())).cells[0];
    expect(cell.staleReasons).toContain(`superseded-claim:${task.claimId}`);
    expect(cell.effectiveAssessment).toBe('stale');
  }));
});

describe('coverage projection surface (A3)', () => {
  it('exposes no model-facing coverage-cell tool or board verb', () => {
    for (const name of ['p2o_coverage_cell', 'p2o_coverage_cell_retire']) {
      expect(MODEL_TOOLS).not.toContain(name);
      expect(ALL_TOOLS).not.toContain(name);
      expect(HIDDEN_TOOLS).not.toContain(name);
      expect(PLANNER_TOOLS).not.toContain(name);
      expect(TOOL_BOUNDARIES[name]).toBeUndefined();
    }
    expect(COVERAGE_VERB_NAMES).toEqual(['p2o_coverage_plan', 'p2o_wstg_suggest']);
    expect(BOARD_ACTION_VERBS.p2o_coverage['cell-create']).toBeNull();
    expect(BOARD_ACTION_VERBS.p2o_coverage['cell-revise']).toBeNull();
    expect(BOARD_ACTION_VERBS.p2o_coverage['cell-retire']).toBeNull();
  });
});
