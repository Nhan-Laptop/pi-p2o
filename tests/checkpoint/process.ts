/**
 * Two-process restart fixture for the bundled controller checkpoint seam.
 *
 * Process one persists a REAL owner-approved checkpoint over a REAL immutable source snapshot, then dies by
 * SIGKILL. Process two reopens the ORIGINAL SQLite store and source, reconciles owned resources through the
 * REAL managed runtime adapter (durable launch/handle records, exact kernel identity, container session
 * sweep) and the REAL owner ledger, then admits a new attempt.
 *
 * No resource observer is mocked: the only fixture-constructed artifacts are the durable controller records a
 * real launch would have written (launches/handles/session lease), and the guardian identities referenced by
 * them are real kernel processes captured from /proc and then either reaped (quiescent) or kept alive (live).
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { DurableStore } from '../../src/store/index.js';
import { acquireApprovedSource, bindApprovedSourceContainer } from '../../src/application/source-binding/index.js';
import { assertIssuedSourceSnapshot } from '../../src/application/source-binding/acquire.js';
import { persistControllerCheckpoint, prepareControllerRestore } from '../../src/application/checkpoint/index.js';
import {
  createControllerOwnerGate, inspectVerifierRestartState, readControllerApprovedRequest,
  reconcileOwnedResourcesPhysically, resolveControllerRunLayout, type ControllerRunLayout, type PhysicalReconcileRuntime,
} from '../../src/application/checkpoint/restore.js';
import { approvedRequest, hash } from '../source-container/fixtures.js';
import { taskFixture } from '../contracts/fixtures.js';
import { ownerMenuProposal, runManifestFor } from '../entry/fixtures.js';
import { createPlanLedger } from '../../src/application/planner.js';
import { createOwnerAuthority } from '../../src/application/authority.js';
import { readOwnerDocument } from '../../src/application/entry/documents.js';
import { createEntryPlanStore } from '../../src/application/entry/plans.js';
import { sealPlanDigest } from '../../src/application/entry/authoring.js';
import { entryOwnerApprovalPath } from '../../src/application/entry/approvals.js';
import { publishOwnerConsent } from '../../src/application/onboarding/storage.js';
import { configurationDigest, readOwnerConsent, consentCovers } from '../../src/application/onboarding/index.js';
import type { OwnerConfiguration, OnboardingReady } from '../../src/application/onboarding/types.js';
import type { ApprovedSourceRequest } from '../../src/application/source-binding/identity.js';
import type { QualifiedSourceContainerSettings } from '../../src/application/source-binding/index.js';
import type { ApplicationConfigWithSpend } from '../../src/application/composition.js';
import type { ObservationCheck } from '../../src/application/types.js';
import { containerSessionLabels } from '../../src/application/source-binding/container-lifecycle.js';
import { attemptKey } from '../../src/runtime/filesystem-hooks.js';
import { LinuxProcessProbe, processIdentity } from '../../src/runtime/processes.js';
import type { ProcessIdentity, RuntimeHandle } from '../../src/runtime/types.js';
import { digestJson, runSchema } from '../../src/contracts/index.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function qualifiedSettings(): Promise<QualifiedSourceContainerSettings> {
  const repo = process.cwd();
  const lock = JSON.parse(await readFile(join(repo, 'containers/pack.lock.json'), 'utf8'));
  return { enginePath: '/usr/bin/docker', engineVersion: lock.engineVersion, image: lock.image.pin,
    imageRootfsLayers: lock.image.rootfsLayers, baseImageId: lock.base.localBaseImageId, workerSha256: lock.sources.workerSha256,
    sourceSha256: lock.sources.sourceSha256, seccompPath: join(repo, 'containers/seccomp.json'), seccompSha256: lock.sources.seccompSha256,
    qualification: { acknowledgement: 'containers-share-host-kernel-not-hostile-code-isolation', dedicatedLab: true,
      approvedBy: 'user-requested physical restart checkpoint test', expiresAt: new Date(Date.now() + 60_000).toISOString(), nativeEnabled: false } };
}

async function dockerAvailable(): Promise<string | undefined> {
  const q = await qualifiedSettings();
  const version = spawnSync(q.enginePath, ['version', '--format', '{{.Client.Version}}/{{.Server.Version}}'], { encoding: 'utf8', timeout: 5000 });
  if (version.status !== 0 || version.stdout.trim() !== `${q.engineVersion}/${q.engineVersion}`) return 'qualified engine missing';
  const image = spawnSync(q.enginePath, ['image', 'inspect', q.image], { encoding: 'utf8', timeout: 5000 });
  if (image.status !== 0) return 'pinned image missing; no pull';
}

/** Real /proc identity of one live pid, retried until the kernel inventory lists it. */
async function identityOfPid(pid: number): Promise<ProcessIdentity> {
  const probe = new LinuxProcessProbe();
  for (let attempt = 0; attempt < 400; attempt++) {
    const identity = (await probe.snapshot()).map(processIdentity).find(row => row.pid === pid);
    if (identity) return identity;
    await sleep(5);
  }
  throw new Error('could not capture a real fixture process identity');
}

/** Real /proc identity of a short-lived process; the process is reaped, so the identity is provably dead. */
async function deadProcessIdentity(): Promise<ProcessIdentity> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120)'], { stdio: 'ignore' });
  const identity = await identityOfPid(child.pid!);
  await once(child, 'exit');
  return identity;
}

const [mode, root] = process.argv.slice(2) as [string, string];
const original = join(root, 'original');
const canary = 'export const checkpointCanary = "IMMUTABLE_RESTART";\n';
const layoutFrom = (runId: string, runRoot: string): Promise<ControllerRunLayout> => resolveControllerRunLayout({ runId, runRoot });

interface RestoreInput {
  runId: string;
  runRoot: string;
  request: ApprovedSourceRequest;
  ownerConfigPath: string;
  approvalPath: string;
  attemptId: string;
  leaseToken: string;
}

function physicalRuntime(engineVersion: string): PhysicalReconcileRuntime {
  const runtimeDir = fileURLToPath(new URL('../../src/runtime/', import.meta.url));
  return {
    adapter: 'headless',
    piBinary: process.execPath,
    gateway: { approval: 'restart-checkpoint-fixture', baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', models: [] },
    sandbox: { mode: 'container', enginePath: '/usr/bin/docker', engineVersion },
    runtimePaths: { guardianPath: join(runtimeDir, 'guardian.js'), receiptExtensionPath: join(runtimeDir, 'pi-receipts.js'), nodeBinary: process.execPath },
  };
}

/** Durable controller records a real supervised launch writes before execution (same shapes/paths). */
async function writeLaunchRecords(input: {
  controlRoot: string; runId: string; taskId: string; attemptId: string; ownerToken: string; ownerId: string;
  leaseToken: string; generation: number; workspace: string; deadlineAt: number; guardian: ProcessIdentity;
  selection: { provider: string; model: string; thinking: import('../../src/runtime/types.js').Thinking };
}): Promise<{ controlDir: string; sessionFile: string }> {
  const key = attemptKey({ runId: input.runId, taskId: input.taskId, attemptId: input.attemptId });
  const controlDir = join(input.controlRoot, `${key}-${input.ownerToken}`);
  const sessionFile = join(controlDir, 'session.jsonl');
  const scopeDigest = digestJson({ runId: input.runId, taskId: input.taskId, attemptId: input.attemptId });
  const inputDigest = digestJson({ input: 'restart-checkpoint-fixture' });
  const toolPolicy = { mode: 'trusted-fixture' as const, allowUnsandboxedHostTools: true as const, tools: [] as string[] };
  const handle: RuntimeHandle = {
    version: 1, kind: 'headless', runId: input.runId, taskId: input.taskId, attemptId: input.attemptId,
    ownerToken: input.ownerToken, workspace: input.workspace, scopeDigest, inputDigest,
    deadlineAt: input.deadlineAt, requested: { ...input.selection }, toolPolicy,
    createdAt: Date.now() - 1000, status: 'failed', controlDir, sessionFile, sessionId: randomUUID(),
    launchIntent: true, native: { guardian: input.guardian, processes: [input.guardian] },
    observed: [], events: [], nextCursor: 1, logTail: '', droppedLogBytes: 0,
  };
  const launch = {
    version: 1, runId: input.runId, taskId: input.taskId, attemptId: input.attemptId, producerId: input.ownerId,
    leaseToken: input.leaseToken, generation: input.generation, adapterKind: 'headless', keys: [],
    request: { runId: input.runId, taskId: input.taskId, attemptId: input.attemptId, workspace: input.workspace,
      scopeDigest, inputDigest, deadlineAt: input.deadlineAt, prompt: 'restart checkpoint fixture',
      requested: { ...input.selection }, toolPolicy },
  };
  const lease = {
    version: 1, attemptKey: key,
    scope: { runId: input.runId, taskId: input.taskId, attemptId: input.attemptId },
    owner: { instance: randomUUID(), token: input.ownerToken, process: input.guardian, at: Date.now() - 1000 },
    state: 'open', openedAt: Date.now() - 1000, updatedAt: Date.now() - 1000, resources: [],
  };
  for (const directory of ['launches', 'handles', 'sessions']) await mkdir(join(input.controlRoot, directory), { recursive: true, mode: 0o700 });
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  await writeFile(join(input.controlRoot, 'launches', `${input.attemptId}.json`), `${JSON.stringify(launch)}\n`, { mode: 0o600 });
  await writeFile(join(input.controlRoot, 'handles', `${input.attemptId}.json`), `${JSON.stringify(handle)}\n`, { mode: 0o600 });
  await writeFile(join(input.controlRoot, 'sessions', `lease-${key}.json`), `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  await writeFile(join(controlDir, 'worker.json'), `${JSON.stringify({ version: 1, token: input.ownerToken, journalFile: join(controlDir, 'guardian.json') })}\n`, { mode: 0o600 });
  return { controlDir, sessionFile };
}

/**
 * Enroll a REAL docker container under a durable session lease whose recorded owner is a real dead process.
 * The daemon identity, image ID and session labels are captured from the actual engine/container; recovery
 * must verify them and physically remove the container, or refuse.
 */
async function enrollContainerResource(input: {
  controlRoot: string; runId: string; taskId: string; attemptId: string; ownerToken: string;
  dead: ProcessIdentity; imagePin: string; engineVersion: string;
}): Promise<{ name: string; id: string }> {
  const docker = (args: string[]) => {
    const result = spawnSync('/usr/bin/docker', args, { encoding: 'utf8', timeout: 20_000 });
    if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const scope = { runId: input.runId, taskId: input.taskId, attemptId: input.attemptId };
  const name = `p2o-${randomUUID()}`;
  const configurationDigest = digestJson({ container: 'restart-fixture', identity: input.attemptId });
  const labels = containerSessionLabels(scope, name, configurationDigest);
  const daemonId = docker(['info', '--format', '{{.ID}}']);
  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', input.imagePin]);
  const id = docker(['create', '--name', name, ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), input.imagePin, 'true']);
  const data = { kind: 'docker-container', protocol: 1, name, enginePath: '/usr/bin/docker', engineVersion: input.engineVersion,
    daemonId, imagePin: input.imagePin, imageId, labels, scope, stage: 'created', containerId: id };
  const key = attemptKey(scope);
  await writeFile(join(input.controlRoot, 'sessions', `lease-${key}.json`), `${JSON.stringify({
    version: 1, attemptKey: key, scope,
    owner: { instance: randomUUID(), token: input.ownerToken, process: input.dead, at: Date.now() - 1000 },
    state: 'open', openedAt: Date.now() - 1000, updatedAt: Date.now() - 1000,
    resources: [{ pack: 'container-pack', id: name, state: 'active', data }],
  })}\n`, { mode: 0o600 });
  return { name, id };
}

if (mode === 'persist' || mode === 'persist-live') {
  const live = mode === 'persist-live';
  const runId = 'source-run';
  const runRoot = join(root, 'runs', `assessment-${randomUUID()}`);
  const controlRoot = join(runRoot, 'control'), workspaceRoot = join(runRoot, 'workspaces');
  const privateRoot = join(controlRoot, 'immutable-source');
  const checkpointRoot = join(root, 'checkpoints', runId);
  for (const directory of [runRoot, controlRoot, workspaceRoot, privateRoot]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const store = new DurableStore({ path: join(runRoot, 'state.sqlite') });
  await mkdir(original, { mode: 0o700 }); await writeFile(join(original, 'canary.ts'), canary);
  const approved = await approvedRequest({ root, origin: original });
  approved.request.run.runId = runId;
  approved.request.run.state = 'active';
  approved.request.run.budgets.maxAttempts = 3;
  store.createRun(approved.request.run);
  const workspace = join(workspaceRoot, 'source-task');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const task = taskFixture('source-task', workspace);
  Object.assign(task, { runId, createdAt: new Date().toISOString(),
    allowedActions: ['analyze'], requiredCapabilities: ['source.analyze'], requestedRuntime: approved.request.run.requestedRuntime,
    budgets: { deadlineAt: new Date(Date.parse(approved.request.run.budgets.deadlineAt) - 60_000).toISOString(), maxRequests: 32, maxBytes: 4 * 1024 * 1024,
      maxToolCalls: 64, maxTokens: 100_000, maxCostUsd: 10, maxAttempts: 3 } });
  task.scope.authorizationRef = approved.request.run.authorization.reference;
  task.scope.targetIds = [approved.request.run.authorization.targets[0]!.id];
  const target = approved.request.run.authorization.targets[0]!;
  task.scope.inputs = [{ id: target.id, locator: target.locator, digest: target.digest!, revision: target.revision! }];
  task.inputRevision = target.revision!;
  store.createTask(task);
  const lease = store.beginAttempt({ taskId: task.taskId, ownerId: 'controller-1', attemptId: 'attempt-before-restart', leaseMs: 60_000 });
  store.consumeBudget({ attemptId: lease.attempt.attemptId, leaseToken: lease.lease.token, tokens: 9, costUsd: 0.01, toolCalls: 1 });
  const source = await acquireApprovedSource({ ...approved, privateRoot });
  const configuration: OwnerConfiguration = {
    schemaVersion: 1, owner: { uid: process.getuid!() },
    scope: { target: { kind: 'local-dir', raw: original, locator: original }, boundary: 'directory-tree-no-symlinks' },
    authorization: { basis: 'owner', reference: approved.request.run.authorization.reference, attestation: 'human-self-attested' },
    permissions: { readStatic: true, repositoryScripts: false, stateChanges: false }, allowedActions: ['read', 'analyze'],
    limits: { maxCostUsd: approved.request.run.budgets.maxCostUsd, maxRequests: approved.request.run.budgets.maxRequests,
      maxTokens: approved.request.run.budgets.maxTokens, maxToolCalls: approved.request.run.budgets.maxToolCalls, maxAttempts: 3,
      deadlineMs: Date.parse(approved.request.run.budgets.deadlineAt), concurrency: approved.request.run.budgets.maxConcurrency },
    disclosure: { version: 1, modelCosts: true, modelDataSharing: true, planOnlyTargetIO: 0 },
  };
  const ownerConfigPath = await publishOwnerConsent(join(root, 'consent'), configuration, null, Date.now());
  const entries = createEntryPlanStore({ root: join(root, 'entry-control'), digestOf() { throw new Error('not used for admission-only check'); } });
  assert.equal(await entries.markAdmitted(approved.request.plan.planId, runId), true);
  // The live mode leaves a real process whose argv carries this attempt's durable control markers.
  const ownerToken = 'restart-owner-token-0001';
  const attemptId = lease.attempt.attemptId;
  const controlDir = join(controlRoot, `${attemptKey({ runId, taskId: task.taskId, attemptId })}-${ownerToken}`);
  const guardianPath = join(fileURLToPath(new URL('../../src/runtime/', import.meta.url)), 'guardian.js');
  let guardian: ProcessIdentity;
  if (live) {
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)', join(controlDir, 'worker.json'), guardianPath], { detached: true, stdio: 'ignore' });
    sentinel.unref();
    await writeFile(join(root, 'sentinel.pid'), String(sentinel.pid), { mode: 0o600 });
    guardian = await identityOfPid(sentinel.pid!);
  } else guardian = await deadProcessIdentity();
  await writeLaunchRecords({ controlRoot, runId, taskId: task.taskId, attemptId,
    ownerToken, ownerId: lease.attempt.ownerId, leaseToken: lease.lease.token,
    generation: lease.lease.generation, workspace: task.workspace, deadlineAt: Date.parse(task.budgets.deadlineAt),
    guardian, selection: approved.request.run.requestedRuntime.selection });
  const lock = JSON.parse(readFileSync(join(process.cwd(), 'containers/pack.lock.json'), 'utf8'));
  const containerFixture = await enrollContainerResource({ controlRoot, runId, taskId: 'container-task',
    attemptId: 'attempt-container-before-restart', ownerToken: 'restart-container-token-0001',
    dead: await deadProcessIdentity(), imagePin: lock.image.pin, engineVersion: lock.engineVersion });
  await writeFile(join(root, 'container-fixture.json'), JSON.stringify(containerFixture), { mode: 0o600 });
  await writeFile(join(root, 'restore-input.json'), JSON.stringify({ runId, runRoot, request: approved.request, ownerConfigPath,
    approvalPath: approved.approvalPath, attemptId: lease.attempt.attemptId, leaseToken: lease.lease.token }), { mode: 0o600 });
  await persistControllerCheckpoint({ root: checkpointRoot, forbiddenRoots: [original, privateRoot, workspaceRoot, controlRoot], store, ...approved, source, ownerConfigPath });
  store.consumeBudget({ attemptId: lease.attempt.attemptId, leaseToken: lease.lease.token, tokens: 4, costUsd: 0.02 });
  console.log('PERSISTED');
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'verifier-state') {
  const runRoot = join(root, 'runs', `assessment-${randomUUID()}`);
  const controlRoot = join(runRoot, 'control'), workspaceRoot = join(runRoot, 'workspaces');
  const checkpointRoot = join(root, 'checkpoints', 'verifier-run');
  for (const directory of [runRoot, controlRoot, workspaceRoot, checkpointRoot]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const store = new DurableStore({ path: join(runRoot, 'state.sqlite') });
  const layout = await layoutFrom('verifier-run', runRoot);
  const run = runManifestFor({ webUrl: 'http://127.0.0.1:8123/lab', runId: 'verifier-run' });
  const now = Date.now();
  run.createdAt = new Date(now - 60_000).toISOString();
  run.authorization.validFrom = new Date(now - 60_000).toISOString();
  run.authorization.expiresAt = new Date(now + 600_000).toISOString();
  run.budgets.deadlineAt = new Date(now + 600_000).toISOString();
  run.allowedCapabilities = ['http.request'];
  run.authorization.targets[0]!.kind = 'web';
  store.createRun(run);
  const workspace = join(workspaceRoot, 'assessment');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const producerTask = taskFixture('assessment', workspace);
  Object.assign(producerTask, { runId: 'verifier-run', createdAt: new Date().toISOString(), allowedActions: ['read'],
    requiredCapabilities: ['http.request'], budgets: { deadlineAt: new Date(now + 540_000).toISOString(), maxRequests: 32, maxBytes: 1024 * 1024,
      maxToolCalls: 64, maxTokens: 100_000, maxCostUsd: 10, maxAttempts: 1 } });
  producerTask.scope.authorizationRef = run.authorization.reference;
  producerTask.scope.targetIds = ['web-target'];
  store.createTask(producerTask);
  const checks: ObservationCheck[] = ['observation', 'negative-control', 'reproduction'].map((kind, index) => ({
    checkId: `check-${index}`, observationId: `obs-${index}`, taskId: 'assessment', tool: 'http.request',
    input: { url: `http://127.0.0.1:8123/lab/${index}`, method: 'GET', accountId: 'anonymous', action: 'read' },
    kind: kind as ObservationCheck['kind'], classification: 'independently-observed', summary: `${kind} restart fixture`,
    expectation: { type: 'http', status: index === 1 ? 403 : 200, bodyIncludes: index === 1 ? 'denied' : index === 2 ? 'foreign' : 'own' },
  }));
  const configuration: OwnerConfiguration = {
    schemaVersion: 1, owner: { uid: process.getuid!() },
    scope: { target: { kind: 'http-url', raw: 'http://127.0.0.1:8123/lab', locator: 'http://127.0.0.1:8123/lab' }, boundary: 'exact-url-no-redirects' },
    authorization: { basis: 'owner', reference: run.authorization.reference, attestation: 'human-self-attested' },
    permissions: { readStatic: true, repositoryScripts: false, stateChanges: false }, allowedActions: ['read', 'analyze'],
    limits: { maxCostUsd: 10, maxRequests: 32, maxTokens: 100_000, maxToolCalls: 64, maxAttempts: 1,
      deadlineMs: Date.parse(run.budgets.deadlineAt), concurrency: 1 },
    disclosure: { version: 1, modelCosts: true, modelDataSharing: true, planOnlyTargetIO: 0 },
  };
  const ownerConfigPath = await publishOwnerConsent(join(root, 'consent'), configuration, null, Date.now());
  const bundle = await readOwnerConsent(ownerConfigPath);
  const owner: OnboardingReady = { status: 'ready', configuration: bundle.configuration, effectiveLimits: bundle.configuration.limits,
    effectivePermissions: bundle.configuration.permissions, configPath: ownerConfigPath, receiptPath: '', reused: false };
  const verifierBudget = { maxRequests: 32, maxToolCalls: 64, maxTokens: 24_576, maxCostUsd: 0.02 };
  const derivedAt = new Date().toISOString();
  const { deriveFirstUseVerificationPlan } = await import('../../src/application/first-use-verification/index.js');
  const planned = deriveFirstUseVerificationPlan({ run, producerTask, targetId: 'web-target', targetLocator: 'http://127.0.0.1:8123/lab',
    checks, workspaceRoot, verifierBudget, now: derivedAt, verifierTaskCreatedAt: derivedAt });
  assert.equal(planned.supported, true, 'restart verifier derivation must be supported for the fixture checks');
  if (!planned.supported) process.exit(1);
  const toolPolicy = { mode: 'sandbox-extension' as const, extension: { path: '/tmp/x.js', sha256: 'a'.repeat(64) }, boundaryId: 'fixture', tools: ['p2o_packet'] };
  const config = {
    schemaVersion: 1, mode: 'authorized-assessment', roots: { workspace: workspaceRoot }, run, checks,
    tasks: [
      { manifest: producerTask, role: 'worker', toolPolicy, boundaryReceipt: 'fixture' },
      { manifest: planned.draft.verifierTask, role: 'verifier', deferred: true, toolPolicy, boundaryReceipt: 'fixture' },
    ],
  } as unknown as ApplicationConfigWithSpend;
  await writeFile(layout.verificationPath, JSON.stringify({ supported: true, phase: 'candidate-evidence-required',
    verifierTaskId: planned.draft.verifierTask.taskId, findingId: planned.draft.finding.findingId,
    claimDigest: digestJson(planned.draft.finding.claim), protectedReserve: verifierBudget, derivedAt }), { mode: 0o600 });
  const preAdmission = await inspectVerifierRestartState({ layout, store, config, owner });
  assert.equal(preAdmission.kind, 'pre-admission');
  assert.equal(preAdmission.kind === 'pre-admission' && preAdmission.schedule.verifierTaskId, planned.draft.verifierTask.taskId);
  store.createTask(planned.draft.verifierTask);
  const withVerifierState = await inspectVerifierRestartState({ layout, store, config, owner });
  assert.equal(withVerifierState.kind, 'refused');
  assert.equal(withVerifierState.kind === 'refused' && withVerifierState.code, 'CHECKPOINT_VERIFIER_STATE');
  store.close();
  console.log('VERIFIER_RESTART_STATE_GATES_OK');
} else if (mode === 'reconstruct') {
  const runId = 'reconstruct-run';
  const runRoot = join(root, 'runs', `assessment-${randomUUID()}`);
  const controlRoot = join(root, 'plan-control');
  const entryRoot = join(root, 'entry');
  const approvalDirectory = join(entryRoot, 'approvals');
  const layout: ControllerRunLayout = {
    base: root, runId, runRoot, controlRoot,
    workspaceRoot: join(root, 'workspaces'), vaultRoot: join(runRoot, 'vault'), statePath: join(root, 'state.sqlite'),
    checkpointRoot: join(root, 'checkpoints', runId),
    entryControlRoot: join(entryRoot, 'entry-control'), approvalDirectory,
    configPath: join(controlRoot, 'application.json'), budgetPath: join(root, 'autonomous-budget.json'),
    sourceApprovalPath: join(controlRoot, 'source-approval.json'), verificationPath: join(controlRoot, 'verification-synthesis.json'),
    verificationAdmissionPath: join(controlRoot, 'verification', 'admission.json'),
  };
  for (const directory of [runRoot, controlRoot, entryRoot, approvalDirectory]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(original, { mode: 0o700 }); await writeFile(join(original, 'canary.ts'), canary);
  const store = new DurableStore({ path: layout.statePath });
  await mkdir(join(root, 'fixture'), { recursive: true, mode: 0o700 });
  const fixture = await approvedRequest({ root: join(root, 'fixture'), origin: original, runId });
  const request = fixture.request;
  request.run.state = 'active';
  runSchema.parse(request.run);
  store.createRun(request.run);
  // A real plan ledger under the run's control root, exactly like the composition owns it.
  const admission = { mode: 'managed' as const, manifest: request.run, perTargetConcurrency: { [request.run.authorization.targets[0]!.id]: 1 } };
  const ownerDocumentPath = join(root, 'owner-plan-approval.json');
  const authority = { ...createOwnerAuthority({ version: 1, runs: [admission], tasks: [] }),
    async approvePlan(p: never, d: never, context: never) {
      const document = readOwnerDocument(ownerDocumentPath, 'reconstruct owner approval');
      return createOwnerAuthority({ version: 1, runs: [admission], tasks: [], planApprovals: [document as never] }).approvePlan!(p, d, context);
    } };
  const ledger = createPlanLedger({ controlRoot, authority });
  const proposal = ownerMenuProposal({ run: request.run, targetId: request.run.authorization.targets[0]!.id,
    targetKind: 'artifact', targetLocator: original, observationId: 'source-observation' });
  proposal.provenance.producedAt = new Date().toISOString();
  proposal.provenance.inputDigests = [request.preparation.scopeDigest];
  const proposed = ledger.propose({ packet: proposal, run: request.run, plannerAttemptId: proposal.provenance.plannerAttemptId,
    inputDigests: [request.preparation.scopeDigest] });
  if (!proposed.ok) throw new Error(`real reconstruct proposal refused: ${JSON.stringify(proposed)}`);
  const ownerDocument = { version: 1, approvalId: 'reconstruct-owner-approval', proposalId: proposed.record.proposalId,
    proposalDigest: proposed.record.digest, runId, approvedBy: 'restart reconstruct fixture',
    reference: request.run.authorization.reference, approvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(), taskCount: proposal.tasks.length, observationCount: proposal.observations.length };
  await writeFile(ownerDocumentPath, JSON.stringify(ownerDocument), { mode: 0o600 });
  const packet = { kind: 'owner-menu' as const, proposal };
  const seal = sealPlanDigest({ preparation: request.preparation, steps: request.plan.steps, packet,
    proposalId: proposed.record.proposalId, proposalDigest: proposed.record.digest });
  const plan = { planId: 'plan-reconstruct', runId, digest: seal, steps: request.plan.steps, targetRequests: 0 as const };
  const entries = createEntryPlanStore({ root: layout.entryControlRoot, digestOf: record => sealPlanDigest({
    preparation: record.preparation, steps: record.plan.steps, packet: record.packet,
    proposalId: record.proposalId, proposalDigest: record.proposalDigest }) });
  await entries.save({ version: 1, planId: plan.planId, runId, digest: seal, scopeDigest: request.preparation.scopeDigest,
    mode: 'assessment', manifestPath: join(controlRoot, 'run-manifest.json'), preparation: request.preparation, plan,
    packet, proposalId: proposed.record.proposalId, proposalDigest: proposed.record.digest, createdAt: new Date().toISOString() });
  assert.equal(await entries.markAdmitted(plan.planId, runId), true);
  await writeFile(entryOwnerApprovalPath(approvalDirectory, 'plan', proposed.record.digest), JSON.stringify(ownerDocument), { mode: 0o600 });
  await writeFile(layout.sourceApprovalPath, JSON.stringify({ source: { ...request.run.authorization.targets[0], version: 1, runId,
    targetId: request.run.authorization.targets[0]!.id, kind: 'local-dir', origin: original, digest: request.preparation.target.digest,
    scopeDigest: request.preparation.scopeDigest, planDigest: seal, approvalRef: ownerDocument.reference },
    planDigest: seal, approvalRef: ownerDocument.reference, sourceUIConfirmed: true, fingerprints: {} }), { mode: 0o600 });
  const reconstructed = await readControllerApprovedRequest({ layout, store, planId: plan.planId });
  assert.equal(reconstructed.request.plan.digest, seal);
  assert.equal(reconstructed.request.approval.approvalRef, ownerDocument.reference);
  assert.equal(reconstructed.request.run.authorization.targets[0]!.digest, request.preparation.target.digest);
  const configuration: OwnerConfiguration = {
    schemaVersion: 1, owner: { uid: process.getuid!() },
    scope: { target: { kind: 'local-dir', raw: original, locator: original }, boundary: 'directory-tree-no-symlinks' },
    authorization: { basis: 'owner', reference: request.run.authorization.reference, attestation: 'human-self-attested' },
    permissions: { readStatic: true, repositoryScripts: false, stateChanges: false }, allowedActions: ['read', 'analyze'],
    limits: { maxCostUsd: request.run.budgets.maxCostUsd, maxRequests: request.run.budgets.maxRequests,
      maxTokens: request.run.budgets.maxTokens, maxToolCalls: request.run.budgets.maxToolCalls, maxAttempts: request.run.budgets.maxAttempts,
      deadlineMs: Date.parse(request.run.budgets.deadlineAt), concurrency: request.run.budgets.maxConcurrency },
    disclosure: { version: 1, modelCosts: true, modelDataSharing: true, planOnlyTargetIO: 0 },
  };
  const ownerConfigPath = await publishOwnerConsent(join(root, 'consent'), configuration, null, Date.now());
  const bundle = await readOwnerConsent(ownerConfigPath);
  const config = { run: request.run, tasks: [], roots: {} } as unknown as ApplicationConfigWithSpend;
  const gate = createControllerOwnerGate({ layout, config, ownerConfigPath, ownerConfigurationDigest: configurationDigest(bundle.configuration) });
  await gate(reconstructed.request);
  // Lost original entry ledger: the sealed plan is gone and restart must refuse, never reconstruct it.
  await rm(join(layout.entryControlRoot, 'plans'), { recursive: true, force: true });
  await assert.rejects(readControllerApprovedRequest({ layout, store, planId: plan.planId }),
    (error: { code?: string }) => error.code === 'CHECKPOINT_APPROVAL');
  store.close();
  console.log('RECONSTRUCTED_APPROVED_REQUEST_OK');
} else {
  const input = JSON.parse(await readFile(join(root, 'restore-input.json'), 'utf8')) as RestoreInput;
  const layout = await layoutFrom(input.runId, input.runRoot);
  const store = new DurableStore({ path: layout.statePath });
  const privateRoot = join(layout.controlRoot, 'immutable-source');
  const lock = JSON.parse(await readFile(join(process.cwd(), 'containers/pack.lock.json'), 'utf8'));
  const runtime = physicalRuntime(lock.engineVersion);
  const reconcile = () => reconcileOwnedResourcesPhysically({ store, layout, runId: input.runId, runtime, log: message => console.error(message) });

  if (mode === 'missing-handle') await rm(join(layout.controlRoot, 'handles', `${input.attemptId}.json`), { force: true });
  if (mode === 'terminal') {
    const proof = await reconcile();
    assert.equal(proof.status, 'quiescent', JSON.stringify(proof));
    store.setRunState(input.runId, 'cancelled');
  }
  if (mode === 'consent-change') {
    const previous = await readOwnerConsent(input.ownerConfigPath);
    const changed = structuredClone(previous.configuration);
    changed.limits.maxTokens = changed.limits.maxTokens! - 1;
    await publishOwnerConsent(join(root, 'consent'), changed, previous.receipt.configurationDigest, Date.now());
  }

  const admission = { mode: 'managed' as const, manifest: store.getRun(input.runId)!, perTargetConcurrency: { [input.request.run.authorization.targets[0]!.id]: 1 } };
  const ledger = createPlanLedger({ controlRoot: join(root, 'plan-control'), authority: {
    ...createOwnerAuthority({ version: 1, runs: [admission], tasks: [] }),
    async approvePlan(p, d, context) {
      const document = readOwnerDocument(input.approvalPath, 'restart owner approval');
      return createOwnerAuthority({ version: 1, runs: [admission], tasks: [], planApprovals: [document as never] }).approvePlan!(p, d, context);
    },
  } });
  const options = { root: layout.checkpointRoot, forbiddenRoots: [original, privateRoot, layout.workspaceRoot, layout.controlRoot],
    store, runId: input.runId, privateSourceRoot: privateRoot, ownerConfigPath: input.ownerConfigPath,
    async readApprovedRequest(planId: string) { assert.equal(planId, input.request.plan.planId); return structuredClone(input.request); },
    async authorize(incoming: ApprovedSourceRequest) {
      const owner = await readOwnerConsent(input.ownerConfigPath);
      assert(consentCovers(owner.configuration, owner.configuration.scope, undefined, undefined));
      const result = await ledger.approve({ run: incoming.run, proposalDigest: incoming.plan.digest,
        document: readOwnerDocument(input.approvalPath, 'restart approval') });
      assert(result.ok, JSON.stringify(result));
    },
    reconcileOwnedResources: reconcile };

  const entries = createEntryPlanStore({ root: join(root, 'entry-control'), digestOf() { throw new Error('not used for admission-only check'); } });
  assert.deepEqual(await entries.admitted(input.request.plan.planId), { runId: input.runId });
  assert.equal(await entries.markAdmitted(input.request.plan.planId, input.runId), false);
  if (mode === 'expired') Date.now = () => Date.parse(input.request.run.budgets.deadlineAt) + 1;
  if (mode === 'lost-ledger') {
    await rm(join(root, 'plan-control'), { recursive: true, force: true });
    await rm(input.approvalPath, { force: true });
  }
  const serialized = JSON.parse(await readFile(join(layout.checkpointRoot, 'checkpoint.json'), 'utf8'));
  assert.throws(() => assertIssuedSourceSnapshot(serialized.checkpoint.source));
  const refused = (error: unknown): never => {
    const failure = error as { code?: string; message?: string };
    console.error(`RESTORE_REFUSED ${failure.code ?? 'UNKNOWN'} ${failure.message ?? ''}`);
    process.exit(1);
  };
  const ticket = await prepareControllerRestore(options).catch(refused);
  assert.equal(ticket.phase, 'reconciliation-required'); assert(!('source' in ticket));
  await assert.rejects(prepareControllerRestore(options), (error: { code?: string }) => error.code === 'CHECKPOINT_BUSY');
  const pending = ticket.reconcile();
  await assert.rejects(ticket.close(), (error: { code?: string }) => error.code === 'CHECKPOINT_BUSY');
  const ready = await pending.catch(refused);
  assertIssuedSourceSnapshot(ready.source);
  await assert.rejects(ticket.reconcile(), (error: { code?: string }) => error.code === 'CHECKPOINT_USED');
  assert.equal(ready.progress.usage.tokens, 13); assert.equal(ready.progress.usage.costUsd, 0.03);
  assert.equal(ready.deadlineAt, input.request.run.budgets.deadlineAt);
  assert.equal(store.getLease('source-task'), undefined);
  assert.equal(store.getAttempt(input.attemptId)!.lifecycleState, 'failed');
  const receipts = store.listEvidence(input.runId).filter(evidence => evidence.kind === 'runtime' && evidence.attemptId === input.attemptId);
  assert(receipts.length > 0, 'physical reconciliation must admit a collector-trusted runtime receipt');
  assert.equal(receipts.every(evidence => evidence.provenance.trust === 'collector'), true);
  const next = store.beginAttempt({ taskId: 'source-task', ownerId: 'controller-2', leaseMs: 60_000 });
  assert.notEqual(next.attempt.attemptId, input.attemptId); assert.equal(next.attempt.sequence, 2);
  assert.equal(store.getAttempt(input.attemptId)!.usage.tokens, 13);
  assert.throws(() => store.beginAttempt({ taskId: 'source-task', ownerId: 'duplicate', leaseMs: 60_000 }));
  const dockerMissing = await dockerAvailable();
  if (!dockerMissing) {
    const binding = await bindApprovedSourceContainer({ request: input.request, authorize: options.authorize, source: ready.source, qualified: await qualifiedSettings() });
    const proof = await binding.sandbox.verifyMountedSource('canary.ts');
    assert.equal(proof.sha256, hash(canary));
    console.log('PHYSICAL_PINNED_DOCKER_READBACK_OK');
  } else console.log(`PHYSICAL_DOCKER_SKIPPED: ${dockerMissing}`);
  await ready.close(); store.close(); console.log('RESTORED_NEW_ATTEMPT_NO_BUDGET_RESET');
}
