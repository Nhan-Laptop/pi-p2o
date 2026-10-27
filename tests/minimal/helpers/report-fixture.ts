import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerP2O } from '../../../extensions/p2o/index.js';
import { EvidenceStore } from '../../../src/evidence.js';
import { appendRecord, type AssessmentRecord } from '../../../src/records.js';
import { AssessmentStore } from '../../../src/state/store.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './fake-pi.js';

/**
 * Shared harness for the report tests: a real extension registered on a fake Pi, an inert sandbox and a real SQLite store in a temporary workspace.
 * `populate` builds one accepted case, one pending case, a claim, an open gap and a projected coverage plan whose tested and
 * blocked cells the host derives from the fixture's reviewed work.
 */
export async function fixture(work: (h: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-report-'));
  await mkdir(join(root, 'source'));
  const pi = createFakePi(), ctx = createContext({ cwd: root }), herdr = createSimpleHerdr(), sandboxes: InertSandbox[] = [];
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'settings.json'), herdr: herdr.client,
    createSandbox: (target: any) => { const sandbox = new InertSandbox(target); sandboxes.push(sandbox); return sandbox; } });
  const command = (text: string) => pi.commands.get('p2o').handler(text, ctx.ctx);
  const call = (name: string, params: any = {}) => pi.tools.get(name).execute(randomUUID(), params, undefined, undefined, ctx.ctx);
  const screen = () => ctx.screens.at(-1).render(200).join('\n');
  const runId = async () => (await readdir(join(root, '.p2o-state')))[0];
  const reader = async () => AssessmentStore.open(join(root, '.p2o-state'), await runId());
  const read = async (directory: string) => Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(join(directory, name), 'utf8')])));
  try { await work({ root, pi, ctx, sandboxes, command, call, screen, runId, reader, read }); }
  finally { await command('stop'); await command('close'); await rm(root, { recursive: true, force: true }); }
}

/**
 * A2 (planning_update.md P1): `p2o_candidate` is worker-only, so an in-process fixture cannot author a claim from the owner
 * surface. This seeds the exact candidate record the worker broker would commit, through the same canonical ledger adapter the
 * extension holds (the store's own writable handle), attributed to `worker-a`. The old owner call returned the record itself;
 * this returns the same fields plus `recordId`.
 */
export async function seedClaim(h: any, input: Record<string, any>, taskRef?: string): Promise<AssessmentRecord & { id: string; recordId: string; data: Record<string, any> }> {
  const [run] = (await readdir(join(h.root, 'control'))).filter((name: string) => name.startsWith('p2o-run-'));
  if (!run) throw new Error('seedClaim needs the active run control directory');
  const id = randomUUID(), at = new Date().toISOString();
  const data = { ...input, ...(taskRef ? { taskRef } : {}) };
  const record: AssessmentRecord = {
    id, version: 2, runId: await h.runId(), at, by: 'worker-a', workerId: 'worker-a', kind: 'candidate',
    text: `${input.candidate}: ${input.closure} (${input.execution}, ${input.proof}); agent claim, not automatic verification`,
    surface: input.surface, risk: input.risk, outcome: input.closure, refs: input.evidenceRefs,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}), ...(input.resolves ? { resolves: input.resolves } : {}), data,
  };
  await appendRecord(join(h.root, 'control', run, 'records.sqlite'), record);
  return { ...record, id, recordId: id, data } as AssessmentRecord & { id: string; recordId: string; data: Record<string, any> };
}

/** The worker-side claim service the broker uses, bound to the active run's canonical ledger: same validators, seeded fixture. */
export async function evidenceFor(h: any): Promise<EvidenceStore> {
  const [run] = (await readdir(join(h.root, 'control'))).filter((name: string) => name.startsWith('p2o-run-'));
  if (!run) throw new Error('evidenceFor needs the active run control directory');
  return new EvidenceStore(await h.runId(), join(h.root, 'control', run, 'records.sqlite'), 'fixture');
}

/**
 * Builds one accepted case, one pending case, a confirmed worker claim, an open gap and a projected coverage plan whose two
 * cells the host derives from reviewed work: a reviewed task whose structured work identity settles a current accepted case
 * (tested/accepted), and a second work identity on the same asset that ended blocked without a verdict (blocked/open_gap).
 * A3 removed the stored cell write path, so this seeds work and reads the projection back instead of authoring a cell.
 */
export async function populate(h: any, titles = { accepted: 'Runtime fixture boundary case', pending: 'Second pending case' }, keys: Record<string, string> = {}) {
  await h.command('--target ./source');
  const asset = (await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /report-fixture' } }] } })).details.acks[0];
  // The work identity is what places a task in the denominator; the reviewed or blocked status then decides the axes on read.
  const work = (questionKey: string) => ({ assetRefs: [{ id: asset.entityId, revision: 1 }], questionKey, policyKey: 'policy:report-case', actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'offline-observation', purpose: 'investigation' });
  const taskDraft = { question: 'Does the bounded fixture observation match the declared policy?', surface: '/report-fixture', risk: 'authorization', role: 'general', roleReason: 'Bounded inert observation for report export', expectedTrue: 'Receipt records the expected policy observation', expectedFalse: 'Receipt records the contrasting control', stopCondition: 'Stop after one inert command and owner review', evidenceIds: [], prerequisites: [], skills: [], methodReason: 'One inert command with no external target',
    // The fixture's exact output is one receipt; the default investigation contract also asks for controls and gaps nobody recorded.
    outputContract: { kind: 'investigation', required: ['evidence'], partialAllowed: true, artifactPolicy: 'ids-only' } };
  const task = (await h.call('p2o_task_author', { draft: { ...taskDraft, work: work(keys.tested ?? 'question:tested') } })).details;
  const blocked = (await h.call('p2o_task_author', { draft: { ...taskDraft, question: 'Does the second fixture actor stay blocked on its human prerequisite?', work: work(keys.blocked ?? 'question:blocked') } })).details;
  await h.call('p2o_task_settle', { id: blocked.id, revision: blocked.revision, outcome: 'blocked', reason: 'The second fixture actor needs a human-provided credential, so no observation could run' });
  const running = (await h.call('p2o_task_start', { id: task.id })).details;
  const observation = (await h.call('p2o_shell', { command: 'printf bounded-report-observation' })).details;
  const reviewed = (await h.call('p2o_task_review', {id: task.id, revision: running.revision, reason: 'Owner reviewed the exact inert receipt for bounded coordination', evidenceIds: [observation.evidenceId] })).details;
  // The claim carries its host `taskRef` so the derivation can always link it to this task. It is seeded after the reviewed head on
  // purpose: review auto-creates a validation intent for a demonstrated worker claim it sees, and a fixture that queued one paid
  // validation would leave every finish consumer blocked on INTENTS_QUEUED. The accepted-case branch of the projection does not
  // read claim record order (that order only matters for the claim-only derivation), so the tested/accepted cell is unaffected.
  const claim = await seedClaim(h, { candidate: 'report-claim', surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', evidenceRefs: [observation.evidenceId], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Only one inert fixture actor and endpoint were reviewed' }, task.id);
  const draft = { title: titles.accepted, policyKey: 'policy:report-case', rootCauseKey: 'root:report-gate', assetRefs: [{ id: asset.entityId, revision: 1 }], claimRefs: [claim.id], independentEvidenceRefs: [], taskRefs: [{ taskId: task.id, revision: reviewed.revision }], reportRefs: [], contradictions: [], affectedVariants: ['variant:read'], relatedCaseIds: [], verdict: 'confirmed', reviewStatus: 'pending', reviewReason: 'Pending exact owner review of current support', limitations: 'Only the retained inert fixture receipt and declared policy are covered', remediation: { status: 'unplanned', reason: 'No remediation was implemented or reviewed in this fixture', evidenceRefs: [] } };
  const first = (await h.call('p2o_case_author', {entry: draft, requestId: 'report-case-1' })).details;
  const accepted = (await h.call('p2o_case_author', {id: first.id, revision: 1, entry: { ...draft, reviewStatus: 'accepted', reviewReason: 'Owner reviewed exact current claim, task, asset and limitations' } })).details;
  const pending = (await h.call('p2o_case_author', {entry: { ...draft, title: titles.pending, policyKey: 'policy:report-other', rootCauseKey: 'root:report-other', claimRefs: [claim.id] }, requestId: 'report-case-2' })).details;
  const plan = (await h.call('p2o_coverage_plan', {plan: { title: 'Report coverage denominator', status: 'active', reason: 'Two declared cells for report export fixtures', exclusions: ['No undeclared endpoints'], unknownScope: ['Deployment parity unknown'] }, requestId: 'report-plan' })).details;
  const gapAck = (await h.call('p2o_note', { kind: 'open', text: 'Credentials for the second actor were not available, so that actor was never tested' })).details, gapId = gapAck.recordId ?? gapAck.id;
  // A3: the cells are read back from the projection, never authored; the plan is the fixture's only coverage write.
  const view = (await h.call('p2o_board', { board: 'coverage', id: plan.id })).details;
  return { asset, task, claim, accepted, pending, plan: view, observation, reviewed, blocked, gapId, cells: view.cells, tested: view.cells.find((cell: any) => cell.questionKey === (keys.tested ?? 'question:tested')), unmapped: view.unmapped };
}
