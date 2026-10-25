import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerP2O } from '../../../extensions/p2o/index.js';
import { AssessmentStore } from '../../../src/state/store.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './fake-pi.js';

/**
 * Shared harness for the report tests: a real extension registered on a fake Pi, an inert sandbox and a real SQLite store in a temporary workspace.
 * `populate` builds one accepted case, one pending case, a claim, an open gap and a coverage plan with a tested and a blocked cell.
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

/** Builds one accepted case, one pending case, a claim, an open gap and a coverage plan with a tested and an untested cell. */
export async function populate(h: any, titles = { accepted: 'Runtime fixture boundary case', pending: 'Second pending case' }, keys: Record<string, string> = {}) {
  await h.command('--target ./source');
  const asset = (await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /report-fixture' } }] } })).details.acks[0];
  const taskDraft = { question: 'Does the bounded fixture observation match the declared policy?', surface: '/report-fixture', risk: 'authorization', role: 'general', roleReason: 'Bounded inert observation for report export', expectedTrue: 'Receipt records the expected policy observation', expectedFalse: 'Receipt records the contrasting control', stopCondition: 'Stop after one inert command and owner review', evidenceIds: [], prerequisites: [], skills: [], methodReason: 'One inert command with no external target' };
  const task = (await h.call('p2o_task_create', {draft: taskDraft })).details, running = (await h.call('p2o_task_start', {id: task.id })).details;
  const observation = (await h.call('p2o_shell', { command: 'printf bounded-report-observation' })).details;
  const reviewed = (await h.call('p2o_task_review', {id: task.id, revision: running.revision, reason: 'Owner reviewed the exact inert receipt for bounded coordination', evidenceIds: [observation.evidenceId] })).details;
  const claim = (await h.call('p2o_candidate', { candidate: 'report-claim', surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', evidenceRefs: [observation.evidenceId], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Only one inert fixture actor and endpoint were reviewed' })).details;
  const draft = { title: titles.accepted, policyKey: 'policy:report-case', rootCauseKey: 'root:report-gate', assetRefs: [{ id: asset.entityId, revision: 1 }], claimRefs: [claim.id], independentEvidenceRefs: [], taskRefs: [{ taskId: task.id, revision: reviewed.revision }], reportRefs: [], contradictions: [], affectedVariants: ['variant:read'], relatedCaseIds: [], verdict: 'confirmed', reviewStatus: 'pending', reviewReason: 'Pending exact owner review of current support', limitations: 'Only the retained inert fixture receipt and declared policy are covered', remediation: { status: 'unplanned', reason: 'No remediation was implemented or reviewed in this fixture', evidenceRefs: [] } };
  const first = (await h.call('p2o_case_create', {entry: draft, requestId: 'report-case-1' })).details;
  const accepted = (await h.call('p2o_case_revise', {id: first.id, revision: 1, entry: { ...draft, reviewStatus: 'accepted', reviewReason: 'Owner reviewed exact current claim, task, asset and limitations' } })).details;
  const pending = (await h.call('p2o_case_create', {entry: { ...draft, title: titles.pending, policyKey: 'policy:report-other', rootCauseKey: 'root:report-other', claimRefs: [claim.id] }, requestId: 'report-case-2' })).details;
  const plan = (await h.call('p2o_coverage_plan', {plan: { title: 'Report coverage denominator', status: 'active', reason: 'Two declared cells for report export fixtures', exclusions: ['No undeclared endpoints'], unknownScope: ['Deployment parity unknown'] }, requestId: 'report-plan' })).details;
  const cell = (execution: string, assessment: string, extra: any = {}) => ({ assetRef: { id: asset.entityId, revision: 1 }, questionKey: keys[execution] ?? `question:${execution}`, policyKey: 'policy:report-case', actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'offline-observation', execution, assessment, taskRefs: [], claimRefs: [], caseRefs: [], evidenceRefs: [], negativeControlRefs: [], gapRefs: [], reason: `Fixture cell ${execution}`, limitations: 'Says nothing about undeclared actors or assets', ...extra });
  const tested = (await h.call('p2o_coverage_cell', {planId: plan.id, planRevision: plan.revision, cell: cell('tested', 'accepted', { taskRefs: [{ taskId: task.id, revision: reviewed.revision }], claimRefs: [claim.id], caseRefs: [{ caseId: accepted.id, revision: accepted.revision }], evidenceRefs: [observation.evidenceId] }) })).details;
  const gapAck = (await h.call('p2o_note', { kind: 'open', text: 'Credentials for the second actor were not available, so that actor was never tested' })).details, gapId = gapAck.recordId ?? gapAck.id;
  await h.call('p2o_coverage_cell', {planId: plan.id, planRevision: tested.plan.revision, cell: cell('blocked', 'open_gap', { gapRefs: [gapId], reason: 'Credentials for the second actor were not available' }) });
  return { asset, task, claim, accepted, pending, plan, observation, reviewed, tested };
}

