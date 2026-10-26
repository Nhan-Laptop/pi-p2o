import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssessmentStore } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { CoverageBoard, coverageFingerprint, type CoveragePlanView } from '../../src/coverage.js';
import type { CoveragePlanDraft } from '../../src/coverage-types.js';
import { CaseBoard } from '../../src/cases.js';
import type { CaseDraft, CaseEntry } from '../../src/case-types.js';
import { TaskBoard, type TaskDraft } from '../../src/tasks.js';
import { readLedger, type AssessmentRecord } from '../../src/records.js';
import { prepareReport, reportProjection } from '../../src/report.js';
import { finishPreflight } from '../../src/finish-preflight.js';

/**
 * A3 (planning_update.md §2.6, P2): coverage is derived from reviewed work, so the old cell-shape scenarios here are
 * re-expressed as projection scenarios. The last test keeps a pre-A3 stored cell to prove the legacy read path is still
 * read as stored (no rewrite) and that the M5 interrupted-verdict downgrade still applies to it.
 */
const runId = 'run-coverage';
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
  title: 'Declared authorization matrix', status: 'active', reason: 'Explicit bounded denominator for the fixture plan',
  exclusions: ['No undeclared actors or routes'], unknownScope: ['Deployment parity outside fixture is unknown'], ...overrides,
});
const claimData = (closure: string, extra: Record<string, unknown> = {}) => ({
  candidate: 'coverage-claim', closure, execution: closure === 'confirmed' ? 'tested' : 'not_tested', proof: closure === 'confirmed' ? 'offline_reproduction' : 'static_trace',
  policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Only the fixture actor and object variant were reviewed',
  negativeControls: [], control: '', ...extra,
});

interface ReviewedWork { id: string; revision: number; evidenceId: string; claimId?: string }
async function fixture(workBody: (h: {
  store: AssessmentStore; coverage: CoverageBoard; cases: CaseBoard; tasks: TaskBoard; assetId: string; path: string;
  receipt: (by?: string) => string; claim: (taskId: string, closure?: string, extra?: Record<string, unknown>) => string;
  reviewed: (assetId: string, questionKey?: string, claimClosure?: string, claimExtra?: Record<string, unknown>) => Promise<ReviewedWork>;
  acceptedCase: (claimId: string, task: ReviewedWork, verdict?: 'confirmed' | 'ruled_out') => Promise<CaseEntry>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-coverage-')), store = AssessmentStore.create(root, {
    runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture', targetDisplay: 'fixture',
    profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' },
  }), path = join(root, 'alias.sqlite'), unbind = bindAssessmentStore(path, store);
  const [assetId, asset2] = store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /a' } }, { asset: { kind: 'endpoint', key: 'GET /b' } }] }).map(row => row.entityId),
    caseContext = { assetRevision: (id: string) => store.assetRevision(id), assertionRevision: (id: string) => store.assertionRevision(id) },
    coverageContext = { ...caseContext, targetRevision: () => store.graphScope(), assetIds: () => store.assetEntityIds() },
    cases = new CaseBoard(runId, path, () => true, caseContext), coverage = new CoverageBoard(runId, path, () => true, coverageContext),
    tasks = new TaskBoard(runId, path, () => true, Date.now, () => store.graphScope(), id => store.assetRevision(id));
  const receipt = (by = 'worker-a') => store.commitRecords([{ id: randomUUID(), runId, at: '2030', by, workerId: by === 'owner' ? undefined : by, kind: 'evidence', text: 'Inert coverage receipt' }])[0].recordId;
  const claim = (taskId: string, closure = 'confirmed', extra: Record<string, unknown> = {}) => {
    const evidence = receipt(), record: AssessmentRecord = {
      id: randomUUID(), runId, at: '2030', by: 'worker-a', workerId: 'worker-a', kind: 'candidate', text: 'Bounded coverage claim',
      surface: '/a', risk: 'authorization', outcome: closure as AssessmentRecord['outcome'], refs: [evidence],
      data: { ...claimData(closure, extra), taskRef: taskId, evidenceRefs: [evidence], ...(closure === 'ruled_out' ? { negativeControls: Array.isArray(extra.negativeControls) ? extra.negativeControls : [evidence], control: 'Fixture negative control' } : {}) },
    };
    store.commitRecords([record]); return record.id!;
  };
  const reviewed = async (asset: string, questionKey = 'question:object-access', claimClosure?: string, claimExtra: Record<string, unknown> = {}): Promise<ReviewedWork> => {
    const created = await tasks.create(taskDraft(asset, questionKey)); await tasks.reserve(created.id, 'owner');
    await tasks.transition(created.id, 'running', 'Owner began the inert coverage fixture');
    const claimId = claimClosure ? claim(created.id, claimClosure, claimExtra) : undefined;
    const evidenceId = receipt('owner'), done = await tasks.transition(created.id, 'reviewed', 'Owner reviewed the bounded receipt', [evidenceId]);
    return { id: done.id, revision: done.revision, evidenceId, ...(claimId ? { claimId } : {}) };
  };
  const editable = (entry: CaseEntry): CaseDraft => { const { runId: _run, revision: _revision, recordId: _record, ...draft } = entry; return draft; };
  const acceptedCase = async (claimId: string, task: ReviewedWork, verdict: 'confirmed' | 'ruled_out' = 'confirmed') => {
    const draft: CaseDraft = {
      title: 'Coverage case', policyKey: 'policy:coverage', rootCauseKey: verdict === 'confirmed' ? 'root:gate' : 'root:effective-control',
      assetRefs: [{ id: assetId, revision: store.assetRevision(assetId)! }], claimRefs: [claimId], independentEvidenceRefs: [], taskRefs: [{ taskId: task.id, revision: task.revision }],
      reportRefs: [], contradictions: [], affectedVariants: ['variant:a'], relatedCaseIds: [], verdict, reviewStatus: 'pending',
      reviewReason: 'Pending exact support review', limitations: 'Bounded fixture only',
      remediation: { status: 'unplanned', reason: 'No remediation review applies to this fixture', evidenceRefs: [] },
    };
    const created = await cases.create(draft);
    return cases.revise(created.id, 1, { ...editable(created), reviewStatus: 'accepted', reviewReason: 'Owner accepted exact bounded support and limitations' });
  };
  void asset2;
  try { await workBody({ store, coverage, cases, tasks, assetId, path, receipt, claim, reviewed, acceptedCase }); }
  finally { unbind(); store.close(); await rm(root, { recursive: true, force: true }); }
}
const planView = (views: Promise<CoveragePlanView[]>) => views.then(list => list[0]);

describe('proof-aware coverage projection (A3)', () => {
  it('records an explicit plan-version denominator and discovered-but-unplanned assets without claiming clean', async () => fixture(async ({ coverage, tasks, assetId }) => {
    const created = await coverage.createPlan(plan());
    await tasks.create(taskDraft(assetId));
    const view = await planView(coverage.list());
    expect(view).toMatchObject({ id: created.id, revision: 1, derivation: 'projected', cellIds: [] });
    expect(view.cells).toHaveLength(1);
    expect(view.counts).toMatchObject({ execution: { planned: 1 }, assessment: { unreviewed: 1 }, stale: 0, reviewed: 0 });
    expect(view.discoveredUnplannedAssets).toBe(1);
    expect(view.warning).toContain('derived from reviewed worker work');
    expect(view.warning).toContain('never implies clean');
  }));

  it('requires reviewed receipts for tested cells and a current accepted case for accepted assessment', async () => fixture(async ({ coverage, tasks, reviewed, acceptedCase, assetId }) => {
    await coverage.createPlan(plan());
    await tasks.create(taskDraft(assetId, 'question:unreviewed'));
    const task = await reviewed(assetId, 'question:tested', 'confirmed'), accepted = await acceptedCase(task.claimId!, task);
    const view = await planView(coverage.list()), byKey = new Map(view.cells.map(cell => [cell.questionKey, cell]));
    expect(byKey.get('question:unreviewed')).toMatchObject({ execution: 'planned', assessment: 'unreviewed' });
    expect(byKey.get('question:tested')).toMatchObject({ execution: 'tested', assessment: 'accepted', currentness: 'current', reviewed: true });
    expect(byKey.get('question:tested')!.caseRefs).toEqual([{ caseId: accepted.id, revision: accepted.revision }]);
    expect(view.counts.assessment).toMatchObject({ unreviewed: 1, accepted: 1 });
  }));

  it('does not stale a cell when its reviewed task is closed after the cell was written', async () => fixture(async ({ coverage, reviewed, tasks, assetId }) => {
    await coverage.createPlan(plan());
    const task = await reviewed(assetId, 'question:closed', 'confirmed');
    expect((await planView(coverage.list())).cells[0].currentness).toBe('current');
    await tasks.transition(task.id, 'closed', 'Owner closed the reviewed task after its coverage cell', [task.evidenceId]);
    const cell = (await planView(coverage.list())).cells[0];
    expect(cell.currentness).toBe('current');
    expect(cell.staleReasons).not.toContain(`superseded-task:${task.id}@r${task.revision}`);
  }));

  it('never turns blocked or untested work into clean/accepted coverage', async () => fixture(async ({ coverage, tasks, assetId }) => {
    await coverage.createPlan(plan());
    const blocked = await tasks.create(taskDraft(assetId, 'question:blocked'));
    await tasks.transition(blocked.id, 'blocked', 'Blocked on an unavailable fixture prerequisite');
    await tasks.create(taskDraft(assetId, 'question:pending'));
    const view = await planView(coverage.list()), byKey = new Map(view.cells.map(cell => [cell.questionKey, cell]));
    expect(byKey.get('question:blocked')).toMatchObject({ execution: 'blocked', effectiveAssessment: 'open_gap', reviewed: false });
    expect(byKey.get('question:pending')).toMatchObject({ execution: 'planned', assessment: 'unreviewed', reviewed: false });
    expect(view.counts.assessment).not.toHaveProperty('accepted');
    await expect(coverage.revisePlan(view.id, view.revision, plan({ status: 'closed', reason: 'Plan closed partial with a retained blocker, not clean' }))).resolves.toMatchObject({ status: 'closed' });
  }));

  it('downgrades accepted cells to stale when case support or asset revision changes', async () => fixture(async ({ coverage, reviewed, acceptedCase, store, assetId }) => {
    await coverage.createPlan(plan());
    const task = await reviewed(assetId, 'question:case', 'confirmed'), accepted = await acceptedCase(task.claimId!, task);
    let cell = (await planView(coverage.list())).cells[0];
    expect(cell).toMatchObject({ currentness: 'current', effectiveAssessment: 'accepted', reviewed: true });
    // A later revision of the supported claim makes the accepted case stale, and the derived cell with it.
    store.commitRecords([{ id: randomUUID(), runId, at: '2031', by: 'worker-a', workerId: 'worker-a', kind: 'candidate', text: 'Later claim revision', surface: '/a', risk: 'authorization', outcome: 'open_proof_gap', refs: [], supersedes: task.claimId, data: { ...claimData('open_proof_gap'), taskRef: task.id, evidenceRefs: [] } }]);
    cell = (await planView(coverage.list())).cells[0];
    expect(cell).toMatchObject({ currentness: 'stale', effectiveAssessment: 'stale', reviewed: false });
    expect(cell.staleReasons).toContain(`stale-case:${accepted.id}`);
    store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /a', label: 'changed revision', expectedRevision: 1 } }] });
    cell = (await planView(coverage.list())).cells[0];
    expect(cell.staleReasons).toContain(`stale-asset:${assetId}@r1->r2`);
    expect((await planView(coverage.list())).cells).toHaveLength(1);
  }));

  it('requires bounded controls for ruled-out cells and preserves separate execution/assessment axes', async () => fixture(async ({ coverage, reviewed, tasks, assetId }) => {
    await coverage.createPlan(plan());
    await reviewed(assetId, 'question:ruled-bounded', 'ruled_out');
    await reviewed(assetId, 'question:ruled-unbounded', 'ruled_out', { negativeControls: [], candidate: 'coverage-claim-unbounded' });
    const blocked = await tasks.create(taskDraft(assetId, 'question:blocked-axis'));
    await tasks.transition(blocked.id, 'blocked', 'Blocked on an unavailable fixture prerequisite');
    const view = await planView(coverage.list()), byKey = new Map(view.cells.map(cell => [cell.questionKey, cell]));
    expect(byKey.get('question:ruled-bounded')).toMatchObject({ execution: 'tested', assessment: 'ruled_out_bounded' });
    expect(byKey.get('question:ruled-bounded')!.negativeControlRefs.length).toBeGreaterThan(0);
    // A ruled-out claim with no negative control is not a bounded negative result.
    expect(byKey.get('question:ruled-unbounded')).toMatchObject({ execution: 'tested', assessment: 'open_gap' });
    expect(byKey.get('question:blocked-axis')).toMatchObject({ execution: 'blocked', assessment: 'open_gap' });
    expect(view.counts.execution).toMatchObject({ tested: 2, blocked: 1 });
    expect(view.counts.assessment).toMatchObject({ ruled_out_bounded: 1, open_gap: 2 });
  }));

  it('builds a bounded final report index with unique cases/coverage and does not count repeated handoff delivery as findings', async () => fixture(async ({ coverage, reviewed, acceptedCase, store, path, assetId }) => {
    const planEntry = await coverage.createPlan(plan());
    const task = await reviewed(assetId, 'question:report', 'confirmed');
    await acceptedCase(task.claimId!, task);
    for (let i = 0; i < 2; i++) store.commitRecords(prepareReport(runId, 'worker-report', { summary: `Repeated attributed delivery ${i}`, findings: ['same textual claim'], evidence: [], coverage: [], openItems: [], confidence: 'low', outcome: 'completed' }).records);
    const caseContext = { assetRevision: (id: string) => store.assetRevision(id), assertionRevision: (id: string) => store.assertionRevision(id) },
      projection = reportProjection(await readLedger(path, runId), { cases: caseContext, coverage: { ...caseContext, targetRevision: () => store.graphScope(), assetIds: () => store.assetEntityIds() } });
    expect(projection.counts).toMatchObject({ reports: 1, reportHistory: 2, cases: 1, uniqueAcceptedFindings: 1, duplicateCases: 0, coveragePlans: 1, coverageCells: 1, unmappedCoverageTasks: 0 });
    expect(projection.cases).toHaveLength(1);
    expect(projection.coveragePlans[0]).toMatchObject({ id: planEntry.id, cellCount: 1 });
    expect(projection.reports[0].findings).toBe(1);
  }));

  it('downgrades a stored verdict to attempted/open_gap and reports it as the interrupted cell it is', async () => fixture(async ({ coverage, tasks, store, assetId, receipt, path }) => {
    const created = await tasks.create(taskDraft(assetId, 'question:legacy'));
    await tasks.reserve(created.id, 'owner');
    await tasks.transition(created.id, 'running', 'Owner began the inert interrupt fixture');
    const evidenceId = receipt('owner'), blockedAt = await tasks.transition(created.id, 'blocked', 'Blocked after the stored cell was written', [evidenceId]);
    // A run written before A3 holds stored cells: the projection must read them as stored (no rewrite), and M5 must still
    // downgrade a verdict whose cited task ended without one.
    const targetRevision = store.graphScope(), planId = 'coverage-plan-legacy', cellId = 'coverage-cell-legacy',
      draft = {
        assetRef: { id: assetId, revision: 1 }, questionKey: 'question:legacy', policyKey: 'policy:coverage', actorContext: 'actor:a', tenantContext: 'tenant:a',
        methodFamily: 'offline-observation', execution: 'tested' as const, assessment: 'confirmed_claim' as const,
        taskRefs: [{ taskId: created.id, revision: blockedAt.revision }], claimRefs: [], caseRefs: [], evidenceRefs: [evidenceId], negativeControlRefs: [], gapRefs: [],
        reason: 'Stored verdict retained for the legacy fixture', limitations: 'Only the bounded fixture is claimed',
      },
      fingerprint = coverageFingerprint(targetRevision, draft),
      planNote = (revision: number, cellIds: string[]) => ({ title: 'Legacy stored denominator', status: 'active', reason: 'Explicit legacy denominator for the fixture', exclusions: [], unknownScope: ['Only the fixture'], id: planId, runId, revision, targetRevision, cellIds }),
      first = randomUUID(), second = randomUUID();
    store.commitRecords([{ id: first, runId, at: '2030', by: 'owner', kind: 'note', text: 'coverage plan @r1: legacy denominator', data: { coveragePlan: planNote(1, []) } }]);
    store.commitRecords([{ id: second, runId, at: '2030', by: 'owner', kind: 'note', text: 'coverage plan @r2: legacy denominator +1', supersedes: first, data: { coveragePlan: planNote(2, [cellId]) } }]);
    store.commitRecords([{ id: cellId, runId, at: '2030', by: 'owner', kind: 'note', text: 'stored legacy coverage cell', refs: [evidenceId], data: { coverageCell: { ...draft, id: cellId, runId, revision: 1, planId, planRevision: 2, targetRevision, fingerprint, retired: false } } }]);
    const view = (await coverage.list())[0], cell = view.cells[0];
    expect(view.derivation).toBeUndefined();
    expect(cell).toMatchObject({ execution: 'tested', effectiveExecution: 'attempted', effectiveAssessment: 'open_gap', currentness: 'stale', reviewed: false });
    expect(cell.staleReasons.some(reason => reason.startsWith('interrupted-task:'))).toBe(true);
    const index = await readLedger(path, runId);
    const interrupted = finishPreflight(index, { cases: { assetRevision: () => undefined }, coverage: { targetRevision: () => store.graphScope(), assetRevision: () => 1 }, integrity: 'annotate' }).advisory.find(item => item.code === 'INTERRUPTED_CELL');
    expect(interrupted).toMatchObject({ count: 1, ids: [cell.id] });
    expect(interrupted?.message).toContain('stays attempted');
  }));
});
