import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssessmentStore } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { TaskBoard, type AssessmentTask, type TaskDraft } from '../../src/tasks.js';
import { EvidenceStore, type Candidate } from '../../src/evidence.js';
import { CaseBoard, caseViews } from '../../src/cases.js';
import { readLedger } from '../../src/records.js';
import { reviewedValidation, validationDraft, validationKey } from '../../src/validation.js';
import type { WorkSpec } from '../../src/work.js';

const runId = 'run-validation';

async function fixture(work: (h: {
  store: AssessmentStore; board: TaskBoard; path: string; assetId: string;
  evidence: (by: string) => string; task: (input: TaskDraft) => Promise<AssessmentTask>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-validation-'));
  const store = AssessmentStore.create(root, { runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture', targetDisplay: 'fixture',
    profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } });
  const path = join(root, 'alias.sqlite'), unbind = bindAssessmentStore(path, store);
  const assetId = store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /object' } }] })[0].entityId;
  const board = new TaskBoard(runId, path, () => true, Date.now, () => store.graphScope(), id => store.assetRevision(id));
  const evidence = (by: string) => store.commitRecords([{ id: randomUUID(), runId, at: new Date().toISOString(), by,
    workerId: by === 'owner' ? undefined : by, kind: 'evidence', text: 'Bounded inert receipt for one validation fixture' }])[0].recordId;
  try { await work({ store, board, path, assetId, evidence, task: input => board.create(input) }); }
  finally { unbind(); store.close(); await rm(root, { recursive: true, force: true }); }
}

/** A2: the first intent of a run is recon/mapping; the discovery builds on its reviewed task. */
function reconDraft(assetId: string): TaskDraft {
  return {
    question: 'Which recorded fixture surfaces does the object expose?',
    surface: '/object', risk: 'mapping', role: 'recon',
    roleReason: 'Minimal recon intent that anchors the discovery fixture',
    expectedTrue: 'The recorded fixture exposes the object surface',
    expectedFalse: 'The recorded fixture exposes nothing and the receipt says so',
    stopCondition: 'Stop after one bounded mapping observation and owner review',
    evidenceIds: [], prerequisites: [],
    method: { skills: [], reason: 'One inert mapping observation with no target traffic' },
    work: { assetRefs: [{ id: assetId, revision: 1 }], questionKey: 'question:recon-object', policyKey: 'policy:object',
      actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'offline-observation', purpose: 'mapping' },
  };
}

function discoveryDraft(assetId: string, prerequisites: TaskDraft['prerequisites'] = []): TaskDraft {
  return {
    question: 'Does the object boundary permit the declared fixture read?',
    surface: '/object', risk: 'authorization', role: 'discovery',
    roleReason: 'One bounded discovery task for the validation fixture',
    expectedTrue: 'The receipt shows the declared boundary observation',
    expectedFalse: 'The receipt shows the contrasting control',
    stopCondition: 'Stop after one inert observation and owner review',
    evidenceIds: [], prerequisites,
    method: { skills: [], reason: 'One inert observation with no target traffic' },
    work: { assetRefs: [{ id: assetId, revision: 1 }], questionKey: 'question:object', policyKey: 'policy:object',
      actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'offline-observation', purpose: 'discovery' },
    decision: { disposition: 'new', reason: 'First bounded discovery for this fixture object' },
    outputContract: { kind: 'investigation', required: ['evidence'], partialAllowed: true, artifactPolicy: 'ids-only' },
  };
}

function confirmed(evidenceRef: string): Candidate {
  return { candidate: 'object-claim', surface: '/object', risk: 'authorization', closure: 'confirmed', execution: 'tested',
    proof: 'offline_reproduction', evidenceRefs: [evidenceRef], negativeControls: [], limitations: 'One fixture actor only',
    policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture object boundary' };
}

async function reviewTask(board: TaskBoard, task: AssessmentTask, evidenceRef: string) {
  await board.reserve(task.id, 'worker-a');
  await board.transition(task.id, 'running', 'The assignee is exercising the bounded fixture');
  await board.transition(task.id, 'reported', 'The assignee reported its bounded receipt', [evidenceRef]);
  return board.transition(task.id, 'reviewed', 'Owner reviewed the bounded receipt and claim', [evidenceRef]);
}

/** The A2 admission order: a reviewed recon task first, then the discovery anchored to its reviewed revision. */
async function anchoredDiscovery(h: { board: TaskBoard; assetId: string; task: (input: TaskDraft) => Promise<AssessmentTask> }, evidenceRef: string) {
  const recon = await h.task(reconDraft(h.assetId));
  const reviewedRecon = await reviewTask(h.board, recon, evidenceRef);
  return { reviewedRecon, discovery: await h.task(discoveryDraft(h.assetId, [{ taskId: reviewedRecon.id, revision: reviewedRecon.revision }])) };
}

describe('host-created validation and independence (W4)', () => {
  it('builds one deterministic validation task that passes the normal TaskBoard admission and cannot be duplicated', async () => fixture(async ({ board, assetId, evidence, task, path }) => {
    const receipt = evidence('worker-a');
    const { discovery } = await anchoredDiscovery({ board, assetId, task }, receipt);
    const candidate = confirmed(receipt);
    const claim = await new EvidenceStore(runId, path, 'fixture').candidate('worker-a', candidate, discovery.id);
    expect(claim.data?.taskRef).toBe(discovery.id);
    const reviewed = await reviewTask(board, discovery, receipt);
    const draft = validationDraft(claim, candidate, reviewed);
    expect(draft.id).toBe(validationKey(runId, claim, reviewed));
    expect(draft).toMatchObject({ role: 'validation', validationOf: reviewed.id,
      prerequisites: [{ taskId: reviewed.id, revision: reviewed.revision }] });
    expect(draft.work?.claimRefs).toEqual([claim.id]);
    expect(draft.decision).toMatchObject({ disposition: 'validate', relatedTaskId: reviewed.id });
    const created = await board.create(draft);
    expect(created).toMatchObject({ id: draft.id, role: 'validation', status: 'proposed', validationOf: reviewed.id });
    expect(created.work?.claimRefs).toEqual([claim.id]);
    await expect(board.create(draft)).rejects.toThrow(/Duplicate task/);
    const again = validationDraft(claim, candidate, reviewed);
    expect(again.id).toBe(draft.id);
    const index = await readLedger(path, runId);
    expect(reviewedValidation(index, claim)).toMatchObject({ current: false, reason: expect.stringContaining(`validation-proposed:${created.id}`) });
  }));

  it('marks a case independent only after the validation task is reviewed with its assignee own receipt', async () => fixture(async ({ board, assetId, evidence, task, store, path }) => {
    const receipt = evidence('worker-a');
    const { discovery } = await anchoredDiscovery({ board, assetId, task }, receipt);
    const candidate = confirmed(receipt);
    const claim = await new EvidenceStore(runId, path, 'fixture').candidate('worker-a', candidate, discovery.id);
    const context = { assetRevision: (id: string) => store.assetRevision(id) }, cases = new CaseBoard(runId, path, () => true, context);
    const caseDraft = { title: 'Object boundary fixture case', policyKey: 'policy:object', rootCauseKey: 'root:object',
      assetRefs: [{ id: assetId, revision: 1 }], claimRefs: [claim.id!], independentEvidenceRefs: [], taskRefs: [], reportRefs: [],
      contradictions: [], affectedVariants: [], relatedCaseIds: [], verdict: 'confirmed' as const, reviewStatus: 'pending' as const,
      reviewReason: 'Pending owner review of the current claim and validation', limitations: 'One fixture actor only',
      remediation: { status: 'unplanned' as const, reason: 'No remediation reviewed in this fixture', evidenceRefs: [] } };
    await cases.create(caseDraft);
    let views = await caseViews(await readLedger(path, runId), context);
    expect(views[0]).toMatchObject({ independentCurrent: false, independenceReason: expect.stringContaining(`validation-discovery-${discovery.status}:${discovery.id}`) });

    const reviewed = await reviewTask(board, discovery, receipt);
    const validation = await board.create(validationDraft(claim, candidate, reviewed));
    views = await caseViews(await readLedger(path, runId), context);
    expect(views[0]).toMatchObject({ independentCurrent: false, independenceReason: expect.stringContaining(`validation-${validation.status}:${validation.id}`) });

    await board.reserve(validation.id, 'validator-b');
    await board.transition(validation.id, 'running', 'The separate validation worker is replaying the bounded claim');
    const independentReceipt = evidence('validator-b');
    await board.transition(validation.id, 'reported', 'The validation worker reported its own replay receipt', [independentReceipt]);
    await board.transition(validation.id, 'reviewed', 'Owner reviewed the separate replay receipt', [independentReceipt]);

    const index = await readLedger(path, runId);
    expect(reviewedValidation(index, claim)).toMatchObject({ current: true, taskId: validation.id });
    views = await caseViews(index, context);
    expect(views[0]).toMatchObject({ independentCurrent: true, readyToRate: true });
    expect(views[0].independenceReason).toBeUndefined();
  }));

  it('counts a case-cited validation when a lead claim was stamped with the validation task instead of its discovery', async () => fixture(async ({ board, assetId, evidence, task, store, path }) => {
    const receipt = evidence('worker-a');
    const { discovery } = await anchoredDiscovery({ board, assetId, task }, receipt);
    const candidate = confirmed(receipt);
    const claim = await new EvidenceStore(runId, path, 'fixture').candidate('worker-a', candidate, discovery.id);
    const reviewed = await reviewTask(board, discovery, receipt);
    const validation = await board.create(validationDraft(claim, candidate, reviewed));
    await board.reserve(validation.id, 'validator-b');
    await board.transition(validation.id, 'running', 'A separate worker is replaying the bounded claim');
    const independentReceipt = evidence('validator-b');
    await board.transition(validation.id, 'reported', 'The validation worker reported its own replay receipt', [independentReceipt]);
    const reviewedValidationTask = await board.transition(validation.id, 'reviewed', 'Owner reviewed the separate replay receipt', [independentReceipt]);
    // The lead claim records the validation task as its current task, as the paid run did; the case still cites the discovery task.
    const lead = await new EvidenceStore(runId, path, 'fixture').candidate('owner', { ...candidate, candidate: 'object-claim-lead' }, reviewedValidationTask.id);
    const index = await readLedger(path, runId);
    expect(reviewedValidation(index, lead)).toMatchObject({ current: false, reason: 'validation-missing' });
    const context = { assetRevision: (id: string) => store.assetRevision(id) }, cases = new CaseBoard(runId, path, () => true, context);
    const caseDraft = { title: 'Case-cited validation fixture', policyKey: 'policy:object', rootCauseKey: 'root:object',
      assetRefs: [{ id: assetId, revision: 1 }], claimRefs: [lead.id!], independentEvidenceRefs: [], reportRefs: [],
      taskRefs: [{ taskId: reviewed.id, revision: reviewed.revision }, { taskId: reviewedValidationTask.id, revision: reviewedValidationTask.revision }],
      contradictions: [], affectedVariants: [], relatedCaseIds: [], verdict: 'confirmed' as const, reviewStatus: 'pending' as const,
      reviewReason: 'Pending owner review of the case-cited validation', limitations: 'One fixture actor only',
      remediation: { status: 'unplanned' as const, reason: 'No remediation reviewed in this fixture', evidenceRefs: [] } };
    await cases.create(caseDraft);
    const views = await caseViews(await readLedger(path, runId), context);
    expect(views[0]).toMatchObject({ independentCurrent: true, readyToRate: true });
    expect(views[0].independenceReason).toBeUndefined();
  }));

  it('keeps a validation dispatchable after its reviewed discovery is closed', async () => fixture(async ({ board, assetId, evidence, task, path }) => {
    const receipt = evidence('worker-a');
    const { discovery } = await anchoredDiscovery({ board, assetId, task }, receipt);
    const candidate = confirmed(receipt);
    const claim = await new EvidenceStore(runId, path, 'fixture').candidate('worker-a', candidate, discovery.id);
    const reviewed = await reviewTask(board, discovery, receipt);
    const validation = await board.create(validationDraft(claim, candidate, reviewed));
    const closed = await board.transition(discovery.id, 'closed', 'Owner closed the reviewed discovery after the validation was created', [receipt]);
    expect(closed.revision).toBe(reviewed.revision + 1);
    // Closing is a status-only terminal step. The pinned prerequisite remains satisfied, and reserve re-pins to the closed head.
    await expect(board.readiness(validation.id)).resolves.toMatchObject({ ready: true });
    await board.reserve(validation.id, 'validator-b');
    await board.transition(validation.id, 'running', 'The separate validation worker is replaying the bounded claim');
    await expect(board.assertReady('validator-b')).resolves.toBeUndefined();
  }));

  it('names the prerequisite gap for a blocked host validation and refuses same-actor assignment', async () => fixture(async ({ board, assetId, evidence, task, path }) => {
    const receipt = evidence('worker-a');
    const { discovery } = await anchoredDiscovery({ board, assetId, task }, receipt);
    const candidate = confirmed(receipt);
    const claim = await new EvidenceStore(runId, path, 'fixture').candidate('worker-a', candidate, discovery.id);
    const reviewed = await reviewTask(board, discovery, receipt);
    const blocked = await board.create({ ...validationDraft(claim, candidate, reviewed), missingPrerequisites: ['Delegation unavailable: create a worker locally before validation'] });
    expect(blocked.status).toBe('blocked');
    let index = await readLedger(path, runId);
    expect(reviewedValidation(index, claim).reason).toContain('Delegation unavailable');

    // The manual rule still refuses a validation draft that does not reproduce the predecessor's exact question,
    // and the refusal now names the differing identity key with both values.
    const mismatch = board.create({ ...validationDraft(claim, candidate, reviewed), id: 'validation-mismatch', work: { ...validationDraft(claim, candidate, reviewed).work!, questionKey: 'question:other' } });
    await expect(mismatch).rejects.toThrow(/VALIDATION_IDENTITY_MISMATCH/);
    await expect(mismatch).rejects.toThrow(/questionKey draft="question:other" predecessor="question:object"/);
    // A validation assigned back to the claim author is not independent, even when its receipt exists.
    const resumed = await board.revise(blocked.id, blocked.revision, validationDraft(claim, candidate, reviewed));
    await expect(board.reserve(resumed.id, 'worker-a')).rejects.toThrow(/separate worker/);
    void index;
  }));

  it('host-fills a validation prerequisite and derives its work identity when the draft only names the predecessor', async () => fixture(async ({ board, assetId, evidence, task, path }) => {
    const receipt = evidence('worker-a');
    const { discovery } = await anchoredDiscovery({ board, assetId, task }, receipt);
    const candidate = confirmed(receipt);
    const claim = await new EvidenceStore(runId, path, 'fixture').candidate('worker-a', candidate, discovery.id);
    const reviewed = await reviewTask(board, discovery, receipt);
    const full = validationDraft(claim, candidate, reviewed);
    // A paid-run shape: the model names the worker claim (or task) and omits everything the host can derive.
    const created = await board.create({ ...full, validationOf: claim.id!, prerequisites: [], work: undefined, decision: undefined, outputContract: undefined });
    expect(created).toMatchObject({ role: 'validation', validationOf: reviewed.id, status: 'proposed',
      prerequisites: [{ taskId: reviewed.id, revision: reviewed.revision }],
      decision: { disposition: 'validate', relatedTaskId: reviewed.id }, outputContract: { kind: 'validation' } });
    // The host derives the identity a replay must reproduce; the caller did not restate it.
    expect(created.work).toMatchObject({ purpose: 'validation', assetRefs: reviewed.work!.assetRefs,
      questionKey: reviewed.work!.questionKey, policyKey: reviewed.work!.policyKey });
    // The replay cites the claim its reviewed predecessor reported, so it is the successor that consumes the primitive (M4).
    expect(created.work?.claimRefs).toEqual([claim.id]);
  }));

  it('names the differing identity key and both values when a validation restates a different work identity', async () => fixture(async ({ board, assetId, evidence, task, path, store }) => {
    const receipt = evidence('worker-a');
    const { discovery } = await anchoredDiscovery({ board, assetId, task }, receipt);
    const candidate = confirmed(receipt);
    const claim = await new EvidenceStore(runId, path, 'fixture').candidate('worker-a', candidate, discovery.id);
    const reviewed = await reviewTask(board, discovery, receipt);
    const full = validationDraft(claim, candidate, reviewed);
    const otherAsset = store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /other' } }] })[0].entityId;
    const variants: Array<{ id: string; key: string; work: WorkSpec }> = [
      { id: 'validation-diff-question', key: 'questionKey', work: { ...full.work!, questionKey: 'question:another' } },
      { id: 'validation-diff-policy', key: 'policyKey', work: { ...full.work!, policyKey: 'policy:another' } },
      { id: 'validation-diff-assets', key: 'assetRefs', work: { ...full.work!, assetRefs: [{ id: otherAsset, revision: 1 }] } },
    ];
    for (const variant of variants) {
      const refusal = board.create({ ...full, id: variant.id, work: variant.work });
      await expect(refusal).rejects.toThrow(/VALIDATION_IDENTITY_MISMATCH/);
      await expect(refusal).rejects.toThrow(new RegExp(`${variant.key} draft=`));
      await expect(refusal).rejects.toThrow(/predecessor=/);
    }
  }));
});

describe('task admission message for an omitted method reason (P5.1/P2.3)', () => {
  it('names draft.methodReason and the only role allowed to omit it instead of a bare "Invalid task method"', async () => fixture(async ({ assetId, task }) => {
    // Measured gate rerun 2026-10-26: every `role: discovery` intent that omitted draft.methodReason was refused as bare
    // "Invalid task method"; the lead read the role as unusable. The refusal stays, but it now names the field and the fix.
    const prose: TaskDraft = { ...discoveryDraft(assetId) };
    delete prose.work; delete prose.decision; delete prose.outputContract;
    await expect(task({ ...prose, method: { skills: [], reason: '' } }))
      .rejects.toThrow(/Invalid task method: draft\.methodReason is required for role discovery \(at least 10 characters after trim\); only recon may omit it\. legalNext: resend the same draft with draft\.methodReason added/);
    // Recon keeps the lenient rule documented in ADMISSION: mapping may omit the reason entirely.
    const recon = await task({ ...reconDraft(assetId), method: { skills: [], reason: '' } });
    expect(recon.role).toBe('recon');
  }));
});
