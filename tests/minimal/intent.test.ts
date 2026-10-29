import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { registerP2O, testSeamFor } from '../../extensions/p2o/index.js';
import { AssessmentStore } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { TaskBoard, type AssessmentTask, type TaskDraft } from '../../src/tasks.js';
import { EvidenceStore, type Candidate } from '../../src/evidence.js';
import { readLedger } from '../../src/records.js';
import { validationDraft, validationKey } from '../../src/validation.js';
import type { WorkSpec } from '../../src/work.js';
import { BrokerClient } from '../../src/broker.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

/**
 * planning_update.md P1/A2 (intent admission): the cheap intent is admitted with the host-derived purpose/contract/decision,
 * a non-recon intent must anchor to reviewed work, the first intent is recon/mapping, one worker claim buys one validation,
 * and a claim can only be authored by the executing worker. These are hermetic TaskBoard/extension facts; no paid model runs.
 */
const runId = 'run-intent';

async function fixture(work: (h: {
  store: AssessmentStore; board: TaskBoard; path: string; assetId: string; receipt: (by: string) => string;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-intent-'));
  const store = AssessmentStore.create(root, { runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture', targetDisplay: 'fixture',
    profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } });
  const path = join(root, 'alias.sqlite'), unbind = bindAssessmentStore(path, store);
  const assetId = store.recordGraph({ assets: [{ asset: { kind: 'endpoint', key: 'GET /fixture' } }] })[0].entityId;
  const board = new TaskBoard(runId, path, () => true, Date.now, () => store.graphScope(), id => store.assetRevision(id));
  const receipt = (by: string) => store.commitRecords([{ id: randomUUID(), runId, at: new Date().toISOString(), by,
    workerId: by === 'owner' ? undefined : by, kind: 'evidence', text: 'Inert fixture receipt for one intent admission' }])[0].recordId;
  try { await work({ store, board, path, assetId, receipt }); }
  finally { unbind(); store.close(); await rm(root, { recursive: true, force: true }); }
}

/** A structured identity with the derived fields deliberately absent where a test wants them derived. */
function structuredWork(assetId: string, purpose?: WorkSpec['purpose'], extra: Partial<WorkSpec> = {}): WorkSpec {
  return { assetRefs: [{ id: assetId, revision: 1 }], questionKey: 'question:fixture-surface', policyKey: 'policy:fixture',
    actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'offline-observation',
    ...(purpose ? { purpose } : {}), ...extra } as WorkSpec;
}

/** The minimal recon intent from the A2 acceptance: role, question, surface, work.assetRefs, roleReason and nothing derived. */
function reconDraft(assetId: string): TaskDraft {
  return { id: 'recon-first', question: 'Which recorded surfaces does the retained fixture graph expose?', surface: '/fixture', risk: 'mapping', role: 'recon',
    roleReason: '', expectedTrue: '', expectedFalse: '', stopCondition: '', evidenceIds: [], prerequisites: [],
    method: { skills: [], reason: '' }, work: structuredWork(assetId) };
}

function discoveryDraft(assetId: string, extra: Partial<TaskDraft> = {}): TaskDraft {
  return { question: 'Does the recorded boundary permit the declared fixture read?', surface: '/fixture', risk: 'authorization', role: 'discovery',
    roleReason: 'One bounded discovery intent for the fixture surface', expectedTrue: 'The retained receipt shows the declared boundary observation',
    expectedFalse: 'The control receipt shows the contrasting outcome', stopCondition: 'Stop after one inert observation or a concrete gap',
    evidenceIds: [], prerequisites: [], method: { skills: [], reason: 'One inert observation with no target traffic' },
    work: structuredWork(assetId, 'discovery'), ...extra };
}

function validationDraftFor(assetId: string, validationOf: string): TaskDraft {
  return { question: 'Does an independent replay reproduce the declared fixture claim?', surface: '/fixture', risk: 'authorization', role: 'validation',
    roleReason: 'The host owes one independent replay to the reviewed worker claim', expectedTrue: 'A fresh worker reproduces the declared observation',
    expectedFalse: 'The replay does not reproduce the claim; record the mismatch and keep it unreviewed', stopCondition: 'Stop after one independent replay or a concrete prerequisite gap',
    evidenceIds: [], prerequisites: [], validationOf, method: { skills: [], reason: 'Independent replay of the claim that actually ran' },
    work: structuredWork(assetId) };
}

/** A worker claim that is enough to anchor a validation; the host stamps its taskRef. */
function claimCandidate(slug = 'fixture-claim'): Candidate {
  return { candidate: slug, surface: '/fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
    evidenceRefs: [], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture boundary',
    limitations: 'Inert fixture claim; nothing was executed against a target' };
}

async function reviewed(board: TaskBoard, task: AssessmentTask, receipt: string, assignee = 'owner'): Promise<AssessmentTask> {
  await board.reserve(task.id, assignee);
  await board.transition(task.id, 'running', 'Inert assignment began');
  if (assignee !== 'owner') await board.transition(task.id, 'reported', 'Inert report committed');
  return board.transition(task.id, 'reviewed', 'Owner accepted the bounded coordination receipt', [receipt]);
}

describe('intent admission (P1/A2)', () => {
  it('accepts a minimal recon intent and stores the derived purpose, output contract and decision', async () => fixture(async ({ board, assetId, path }) => {
    const created = await board.create(reconDraft(assetId));
    expect(created).toMatchObject({ id: 'recon-first', role: 'recon', status: 'proposed',
      decision: { disposition: 'new' }, outputContract: { kind: 'inventory', required: ['assets', 'evidence', 'gaps'], partialAllowed: true, artifactPolicy: 'ids-only' } });
    expect(created.work?.purpose).toBe('mapping');
    // The derived fields are part of the stored record, not only of the returned value: review/report projections read the head.
    const stored = (await readLedger(path, runId)).records.filter(row => row.kind === 'task').at(-1)!.data!.task as AssessmentTask;
    expect(stored).toMatchObject({ id: 'recon-first', role: 'recon', decision: { disposition: 'new' }, outputContract: { kind: 'inventory' } });
    expect(stored.work?.purpose).toBe('mapping');
  }));

  it('refuses a discovery intent with no claim or prerequisite before anything is written, and accepts one anchored to a reviewed worker claim', async () => fixture(async ({ board, path, assetId, receipt }) => {
    // The empty run admits recon/mapping only: the refusal names the legal next role.
    await expect(board.create(discoveryDraft(assetId))).rejects.toThrow(/PURPOSE_NEEDS_ANCHOR/);
    await expect(board.create(discoveryDraft(assetId))).rejects.toThrow(/legalNext: create a recon task first/);
    expect(await board.list()).toEqual([]); // no pane, ticket or task record was created
    const recon = await board.create(reconDraft(assetId));
    // A recon/mapping task exists but the discovery still states no anchor: it is refused with the claim it must cite.
    await expect(board.create(discoveryDraft(assetId))).rejects.toThrow(/legalNext: cite the reviewed claim/);
    const reviewedRecon = await reviewed(board, recon, receipt('owner'));
    const claim = await new EvidenceStore(runId, path, 'fixture').candidate('worker-a', claimCandidate(), reviewedRecon.id);
    const anchored = await board.create(discoveryDraft(assetId, { work: structuredWork(assetId, 'discovery', { claimRefs: [claim.id!] }) }));
    expect(anchored).toMatchObject({ role: 'discovery', status: 'proposed' });
    expect(anchored.work?.claimRefs).toEqual([claim.id!]);
  }));

  it('refuses a first validation intent with the legal next role and writes nothing', async () => fixture(async ({ board, assetId }) => {
    const draft = validationDraftFor(assetId, `claim-${'a'.repeat(32)}`);
    await expect(board.create(draft)).rejects.toThrow(/PURPOSE_NEEDS_PREDECESSOR/);
    await expect(board.create(draft)).rejects.toThrow(/legalNext: create a recon task first/);
    expect(await board.list()).toEqual([]);
  }));

  it('resolves a worker claim to its discovery task and pins the reviewed revision', async () => fixture(async ({ board, path, assetId, receipt }) => {
    const recon = await board.create(reconDraft(assetId));
    const reviewedRecon = await reviewed(board, recon, receipt('owner'));
    const claim = await new EvidenceStore(runId, path, 'fixture').candidate('worker-a', claimCandidate(), reviewedRecon.id);
    // The draft names the CLAIM id; the host resolves it to the task and pins the reviewed revision, and derives validate.
    const created = await board.create(validationDraftFor(assetId, claim.id!));
    expect(created).toMatchObject({ role: 'validation', validationOf: reviewedRecon.id,
      prerequisites: [{ taskId: reviewedRecon.id, revision: reviewedRecon.revision }], decision: { disposition: 'validate', relatedTaskId: reviewedRecon.id } });
    expect(created.work?.purpose).toBe('validation');
    expect(created.outputContract).toMatchObject({ kind: 'validation', required: ['evidence', 'controls', 'gaps'] });
    // The stored link is the task id, so a later claim revision cannot move the validation's predecessor.
    const stored = (await readLedger(path, runId)).records.filter(row => row.kind === 'task').at(-1)!.data!.task as AssessmentTask;
    expect(stored.validationOf).toBe(reviewedRecon.id);
    expect(stored.prerequisites).toEqual([{ taskId: reviewedRecon.id, revision: reviewedRecon.revision }]);
  }));

  it('refuses a validation anchored to an owner claim, an unreviewed predecessor or another validation', async () => fixture(async ({ board, path, assetId, receipt }) => {
    const recon = await board.create(reconDraft(assetId));
    const ownerClaim = await new EvidenceStore(runId, path, 'fixture').candidate('owner', claimCandidate(), recon.id);
    await expect(board.create(validationDraftFor(assetId, ownerClaim.id!))).rejects.toThrow(/OWNER_CLAIM_NOT_ANCHORABLE/);
    await expect(board.create(validationDraftFor(assetId, recon.id))).rejects.toThrow(/UNREVIEWED_PREDECESSOR/);
    const reviewedRecon = await reviewed(board, recon, receipt('owner'));
    const claim = await new EvidenceStore(runId, path, 'fixture').candidate('worker-a', claimCandidate('fixture-worker-claim'), reviewedRecon.id);
    const validation = await board.create(validationDraftFor(assetId, claim.id!));
    await reviewed(board, validation, receipt('worker-b'), 'worker-b');
    await expect(board.create(validationDraftFor(assetId, validation.id))).rejects.toThrow(/NO_REVALIDATION/);
  }));

  it('creates exactly one validation task for one worker claim, so a re-posted candidate cannot buy a second', async () => fixture(async ({ board, path, assetId, receipt }) => {
    const recon = await board.create(reconDraft(assetId));
    const reviewedRecon = await reviewed(board, recon, receipt('owner'));
    const store = new EvidenceStore(runId, path, 'fixture');
    const claim = await store.candidate('worker-a', claimCandidate(), reviewedRecon.id);
    const reposted = await store.candidate('worker-a', { ...claimCandidate(), supersedes: claim.id!, limitations: 'The same claim re-posted with no new observation' }, reviewedRecon.id);
    expect(reposted.data?.candidate).toBe(claim.data?.candidate);
    expect(validationKey(runId, reposted, reviewedRecon)).toBe(validationKey(runId, claim, reviewedRecon));
    const created = await board.create(validationDraft(claim, claimCandidate(), reviewedRecon));
    expect(created).toMatchObject({ id: validationKey(runId, claim, reviewedRecon), role: 'validation', status: 'proposed' });
    // The second claim record derives the same validation id, so no second task can exist for the same claim.
    await expect(board.create(validationDraft(reposted, claimCandidate(), reviewedRecon))).rejects.toThrow(/Duplicate task/);
    expect((await board.list()).filter(task => task.role === 'validation')).toHaveLength(1);
    // Independence still holds: the replay cannot be assigned to the discovery assignee.
    await expect(board.reserve(created.id, reviewedRecon.assignee ?? 'owner')).rejects.toThrow(/separate worker/);
    expect(await board.reserve(created.id, 'worker-b')).toMatchObject({ status: 'reserved', assignee: 'worker-b' });
  }));

  it('clamps over-long cosmetic risk/surface with a truncation warning instead of refusing the intent', async () => fixture(async ({ board, assetId, path }) => {
    const risk = 'Anonymous read-only observation; '.padEnd(260, 'r'), surface = `/fixture/${'s'.repeat(260)}`;
    const created = await board.create({ ...reconDraft(assetId), risk, surface });
    expect(created.risk).toBe(risk.slice(0, 200));
    expect(created.surface).toBe(surface.slice(0, 200));
    expect(created.admissionWarnings).toHaveLength(2);
    expect(created.admissionWarnings).toContain(`truncated:risk (stored 200 of ${risk.length} characters)`);
    expect(created.admissionWarnings).toContain(`truncated:surface (stored 200 of ${surface.length} characters)`);
    // The trace is part of the stored record, so the data loss cannot become silent once the ACK is gone.
    const stored = (await readLedger(path, runId)).records.filter(row => row.kind === 'task').at(-1)!.data!.task as AssessmentTask;
    expect(stored.admissionWarnings).toEqual(created.admissionWarnings);
    expect(stored.risk).toBe(risk.slice(0, 200));
    // Semantic prose keeps the hard cap: only cosmetic fields are clamped.
    await expect(board.create({ ...reconDraft(assetId), id: 'long-question', question: 'q'.repeat(1501) })).rejects.toThrow(/Invalid task question/);
  }));

  it('names the excess decision field and the legal next call when new-work terms ride on a validation intent', async () => fixture(async ({ board, path, assetId, receipt }) => {
    const recon = await board.create(reconDraft(assetId));
    const reviewedRecon = await reviewed(board, recon, receipt('owner'));
    const claim = await new EvidenceStore(runId, path, 'fixture').candidate('worker-a', claimCandidate(), reviewedRecon.id);
    const refusal = board.create({ ...validationDraftFor(assetId, claim.id!),
      decision: { disposition: 'new' as const, reason: 'Restated a fresh direction', relatedTaskId: reviewedRecon.id, changeReason: 'Changed inert policy fixture selected' } });
    await expect(refusal).rejects.toThrow(/NEW_WORK_HAS_PRIOR_CLAIM/);
    await expect(refusal).rejects.toThrow(/decision\.relatedTaskId and decision\.changeReason/);
    await expect(refusal).rejects.toThrow(/disposition=new/);
    await expect(refusal).rejects.toThrow(/legalNext: retry p2o_task_author/);
  }));
});

interface ExtensionHarness {
  root: string; pi: ReturnType<typeof createFakePi>; contexts: ReturnType<typeof createContext>;
  sandboxes: InertSandbox[]; herdr: ReturnType<typeof createSimpleHerdr>;
  command: (args: string) => Promise<void>;
  call: (name: string, params?: any) => Promise<any>;
  runDir: () => Promise<string>;
}

async function extensionFixture(provisionFails = false): Promise<ExtensionHarness> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-intent-ext-'));
  await mkdir(join(root, 'repo'), { recursive: true });
  const pi = createFakePi(), contexts = createContext({ cwd: root }), herdr = createSimpleHerdr(), sandboxes: InertSandbox[] = [];
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'settings.json'), herdr: herdr.client,
    createSandbox: (target: any) => { const sandbox = new InertSandbox(target); if (provisionFails && sandboxes.length > 0) sandbox.failProvision = true; sandboxes.push(sandbox); return sandbox; } });
  const runDir = async () => {
    const entries = await readdir(join(root, 'control'));
    return join(root, 'control', entries.find(name => name.startsWith('p2o-run-'))!);
  };
  // S1/B10: the hidden delegate/task-start verbs are gone; the harness runs their code through the registration seam.
  const seam = (name: string, params: any) => name === 'p2o_delegate' ? testSeamFor(pi.pi).spawn(params) : name === 'p2o_task_start' ? testSeamFor(pi.pi).startTask(params) : undefined;
  return { root, pi, contexts, sandboxes, herdr, runDir,
    command: args => pi.commands.get('p2o')!.handler(args, contexts.ctx),
    call: (name, params = {}) => seam(name, params) ?? pi.tools.get(name)!.execute(randomUUID(), params, undefined, undefined, contexts.ctx) };
}

const RECON_INTENT = { question: 'Which recorded surfaces does the retained fixture expose?', surface: '/fixture', risk: 'mapping', role: 'recon', evidenceIds: [], prerequisites: [] };
/** A3/D32: exploit mode admits no target-executing intent before the run holds an impact goal. */
const seedGoal = (h: ExtensionHarness) => h.call('p2o_goal_author', { entry: { kind: 'goal', title: 'Reach the recorded fixture effect under an impact goal',
  status: 'active', proof: { kind: 'capability', capability: { kind: 'data.read' } }, criteria: ['The bounded fixture intent is recorded and attributed'],
  reason: 'A3/D32 fixture prerequisite: exploit mode needs an impact goal before the first target-executing intent' } });
const WORKER_CLAIM = { candidate: 'fixture-worker-claim', surface: '/fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested',
  proof: 'static_trace', evidenceRefs: [], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture boundary',
  limitations: 'Inert worker claim; the receipt is mechanical metadata, not proof' };

describe('intent admission at the extension surface (P1/A2)', () => {
  it('refuses a planner candidate call as worker-only and stamps the worker claim with the host taskRef', async () => {
    const h = await extensionFixture();
    try {
      await h.command('--target ./repo');
      await seedGoal(h);
      const task = (await h.call('p2o_task_author', { entry: RECON_INTENT })).details;
      // The planner has no confirmed-claim path: review of a worker claim is the only one left.
      await expect(h.call('p2o_candidate', WORKER_CLAIM)).rejects.toThrow(/WORKER_ONLY/);
      expect((await readLedger(join(await h.runDir(), 'records.sqlite'))).records.filter(row => row.kind === 'candidate')).toEqual([]);
      const worker = (await h.call('p2o_delegate', { focus: 'recon', task: 'Map the retained fixture surface', taskId: task.id })).details;
      const ticket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${worker.workerId}.json`), 'utf8'));
      const client = new BrokerClient(ticket.socket, ticket.token);
      try {
        const claim = (await client.request('candidate', { candidate: WORKER_CLAIM })).value;
        expect(claim.data?.taskRef).toBe(task.id);
      } finally { client.close(); }
      const claims = (await readLedger(join(await h.runDir(), 'records.sqlite'))).records.filter(row => row.kind === 'candidate');
      expect(claims).toHaveLength(1);
      expect(claims[0].by).toBe(worker.workerId);
    } finally { try { await h.command('stop'); } catch { /* run may already be stopped */ } await rm(h.root, { recursive: true, force: true }); }
  });

  it('leaves a task blocked when its executor cannot be provisioned, never a fake worker report', async () => {
    const h = await extensionFixture(true);
    try {
      await h.command('--target ./repo --executors isolated --target-ops 2');
      await seedGoal(h);
      const task = (await h.call('p2o_task_author', { entry: RECON_INTENT })).details;
      await expect(h.call('p2o_delegate', { focus: 'recon', task: 'Map the retained fixture surface', taskId: task.id })).rejects.toThrow(/provision executor/);
      // The assignment is a blocked prerequisite the planner can see and settle, not a worker that reported.
      expect((await h.call('p2o_board', { board: 'tasks', id: task.id })).details).toMatchObject({ id: task.id, status: 'blocked' });
      expect(h.herdr.calls.filter((call: any) => call.op === 'split')).toHaveLength(0);
      expect((await readLedger(join(await h.runDir(), 'records.sqlite'))).records.filter(row => row.kind === 'report')).toEqual([]);
    } finally { try { await h.command('stop'); } catch { /* run may already be stopped */ } await rm(h.root, { recursive: true, force: true }); }
  });

  it('returns the truncation warning in the task ACK and keeps the clamped cosmetic value on the board', async () => {
    const h = await extensionFixture();
    try {
      await h.command('--target ./repo');
      await seedGoal(h);
      const risk = `Anonymous read-only reconnaissance; ${'r'.repeat(260)}`, surface = `/fixture/${'s'.repeat(260)}`;
      const task = (await h.call('p2o_task_author', { entry: { ...RECON_INTENT, risk, surface } })).details;
      expect(task).toMatchObject({ risk: risk.slice(0, 200), surface: surface.slice(0, 200) });
      expect(task.admissionWarnings).toHaveLength(2);
      expect(task.admissionWarnings).toContain(`truncated:risk (stored 200 of ${risk.length} characters)`);
      expect(task.admissionWarnings).toContain(`truncated:surface (stored 200 of ${surface.length} characters)`);
      // The same trace survives the board read: the model can tell what was dropped, and no pane was refused.
      expect((await h.call('p2o_board', { board: 'tasks', id: task.id })).details).toMatchObject({ risk: risk.slice(0, 200), admissionWarnings: task.admissionWarnings });
    } finally { try { await h.command('stop'); } catch { /* run may already be stopped */ } await rm(h.root, { recursive: true, force: true }); }
  });
});
