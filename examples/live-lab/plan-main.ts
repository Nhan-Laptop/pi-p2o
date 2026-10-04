#!/usr/bin/env node
// Live PLANNER demo harness (workstream P2).
//
// One owner-approved run, two compositions over the same durable roots:
//
//   phase 1  a REAL pinned `pi` worker (the live provider/model, controller-owned credential gateway,
//            tight budgets) acts as the run's planner: it maps the surface to one H1 packet, reads the
//            run threat model through the authenticated bridge, writes a baseline draft, and proposes a
//            plan through the plan-context/propose bridge tools;
//   propose  the proposal packet is validated and capped by the plan ledger and stored with its exact digest
//            (`p2o_plan propose`, the real interface dispatch);
//   owner    the owner authors a batch approval document for that exact digest and it is placed in the
//            owner grant of phase 2 (the model never sees or edits it);
//   phase 2  `p2o_plan approve` materializes and admits the approved batch under the owner-approved tool
//            policy; the plan-materialized workers execute the owner-approved observations (narrowed to the
//            exact plan selection), each reads the shared threat model and at least one appends an
//            attributed amendment; the owner-approved verifier task independently replays both findings.
//
// The report is then finalized through the composition's coverage gate: the gate REFUSES the report while a
// planned cell is open, and the harness records the controller-derived resolutions (durable accepted
// evidence) before building the final report.
//
// Nothing here is faked. Every live precondition is checked by `plan.mjs`; a missing precondition is an
// honest SKIP (exit 0) or a FAIL with `--require-live` (exit 1).
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication, loadApplicationConfig, type AssessmentApplication, type VerificationServices } from '../../src/application/index.js';
import { ApplicationError } from '../../src/application/validation.js';
import type { ApplicationConfigWithSpend } from '../../src/application/composition.js';
import type { OwnerCredentialEntry, OwnerCredentialStore } from '../../src/application/authority.js';
import { InterfaceController } from '../../src/interface/controller.js';
import type { CoverageReconciliation, PlanApprovalDocument, PlanProposal } from '../../src/contracts/index.js';
import { auditArtifactsForSecrets, type GatewayAttestation } from '../../src/runtime/config.js';
import { createContainerSandbox, type ContainerSandboxOptions } from '../../src/tools/index.js';
import { buildContainerSandboxOptions, readPackLock, packPaths } from './pack.js';
import { createLabReplayEnvironment } from './replay-environment.js';
import {
  loadLabModule, resolveProviderCredential, type LiveResultDecision, type LiveToolReceipt, type LiveTurnSettlement, type LiveWorkerSession,
} from './main.js';
import {
  ACTOR_ADMIN, ACTOR_GUEST, ACTOR_GUEST_B, AUTHORIZATION_WINDOW_MS, BOUNDARY_RECEIPT, ENVIRONMENT_A, ENVIRONMENT_B,
  LIVE_API, LIVE_GATEWAY_APPROVAL, LIVE_GATEWAY_MODELS, LIVE_PI_VERSION, LIVE_SELECTION, LIVE_UPSTREAM_BASE_URL,
  RUN_MAX_COST_USD, RUN_MAX_TOKENS, SNAPSHOT_FILE, TARGET_A, TARGET_B,
  TASK_SURFACE_MAP, TASK_VERIFY, assertPricedSelection, buildScenario, sourceSnapshotDigest,
} from './scenario.js';
import type { GrantedTask } from '../../src/application/types.js';
import type { LabInstance, LabServerModule } from './types.js';

/** Seeded identities of environment B; the fresh replay instance must provision the same ones. */
const ENVIRONMENT_B_ACCOUNTS = Object.freeze([
  Object.freeze({ accountId: ACTOR_GUEST_B, tenant: 'alpha', role: 'member', password: 'guest-live-fixture-password' }),
]);

const PLANNER_MAX_TOKENS = 200_000;
const PLANNER_MAX_COST_USD = 0.55;
const PLANNER_PHASE_BUDGET_MS = 14 * 60_000;
const PLAN_RUN_DEADLINE_MS = 32 * 60_000;
const PLAN_SENTINEL_TASK = 'task-plan-sentinel';
const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_ATTEMPT = new Set(['exited', 'failed', 'timed-out', 'cancelled']);

/** The planner task's owner question: the proven H1 map task plus the plan deliverables. */
const PLANNER_STEPS = [
  'This attempt has two deliverables, in this order.',
  'Plan first: (1) call p2o_threat_model with action "read" and no targetKey to read the current run threat model; (2) call p2o_plan_context to read the owner-approved planning menu; (3) call p2o_plan_propose with a JSON selection that chooses the approved hypothesis tasks and the observationIds that decide the two owner-approved claims, names exactly one scopeId from the menu, and includes a threat-model baseline draft (threatModel.targetKey = the first entry of that scope\'s threatModelKeys, threatModel.body = at least 200 characters naming the in-scope assets, trust boundaries, likely weaknesses and what the plan will not test). The owner reviews the exact proposal digest before any planned task is admitted; writing the packet grants nothing.',
  'Then the surface map: perform the approved observations you rely on, call p2o_authoring with contract "H1" for the exact packet shape, and write exactly one H1 handoff packet with p2o_packet. If the plan packet is refused, fix exactly what the refusal names before finishing the H1 packet.',
].join('\n\n');

export interface LivePlanOptions {
  /** Upstream provider credential. Held in-process only; never written, logged or passed to a worker. */
  apiKey: string;
  credentialAccount?: string;
  credentialVersion?: string;
  repoRoot?: string;
  sourceRoot?: string;
  runId?: string;
  runRoot?: string;
  keep?: boolean;
  log?: (message: string) => void;
}

export interface PlanCapsCheck {
  declared: { maxTasks: number; maxDepth: number; maxObservations: number; maxRequests: number };
  counts: { tasks: number; observations: number; coverage: number; requests: number; maxDepth: number };
  withinCaps: boolean;
}

export interface PlanThreatModelAmendment {
  amendmentId: string;
  authorAttemptId: string;
  at: string;
  digest: string;
  text: string;
  authorIsDurableAttempt: boolean;
}

export interface PlanBridgeEvent {
  sequence: number;
  type: string;
  attemptId: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
}

export interface LivePlanResult {
  runId: string;
  runRoot: string;
  runState: string;
  terminal: boolean;
  assessmentStatus: string;
  reportPaths: { json: string; markdown: string; summary: string };
  proposal: {
    proposalId: string;
    digest: string;
    plannerKind: string;
    plannerAttemptId: string;
    purpose: string;
    taskIds: string[];
    observationIds: string[];
    coverageCellIds: string[];
    threats: number;
    caps: PlanCapsCheck;
    path: string;
  };
  approval: {
    approvalId: string;
    reference: string;
    approvedBy: string;
    expiresAt: string;
    path: string;
    duplicate: boolean;
    admittedTaskIds: string[];
    observationCount: number;
    coverageCellIds: string[];
  };
  phase1: {
    plannerTaskId: string;
    plannerAttemptId: string | null;
    plannerTaskState: string;
    plannerPacketState: string;
    proposalWritten: boolean;
  };
  gate: {
    refusedBeforeResolutions: { code: string; message: string } | null;
    reconciliationBefore: CoverageReconciliation;
    resolutions: Array<{ cellId: string; outcome: string; basis: string; carried: boolean; evidenceIds: string[]; authorAttemptId: string; reason: string }>;
    reconciliation: CoverageReconciliation;
  };
  threatModel: {
    models: Array<{ targetKey: string; revision: number; bodyDigest: boolean; bodyChars: number; amendments: PlanThreatModelAmendment[] }>;
  };
  bridgeEvents: PlanBridgeEvent[];
  gateway: {
    gatewayId: string | null;
    exchanges: number;
    forwarded: number;
    denied: number;
    observed: { provider: string; model: string; thinking: string; matchesRequest: boolean }[];
    attestations: GatewayAttestation[];
  };
  spend: {
    limits: { maxTokens: number; maxCostUsd: number };
    committed: { tokens: number; costMicros: number };
    overshoot: { tokens: number; costMicros: number };
    settlements: LiveTurnSettlement[];
  };
  workerSessions: LiveWorkerSession[];
  toolReceipts: LiveToolReceipt[];
  decisions: LiveResultDecision[];
  verifierOutcomes: string[];
  report: {
    findings: { findingId: string; state: string; classification: string; evidenceCount: number; verifier: string | null }[];
    coverage: { state: string; count: number }[];
    packets: { taskId: string; contract: string; outcome: string; classification: string }[];
  };
  scope: { approvedOrigins: string[]; observedOrigins: string[]; escapes: string[] };
  leakAudit: { providerCredential: { files: number; clean: boolean; detail: string }; labTokens: { files: number; clean: boolean; detail: string } };
  acceptance: { ok: boolean; reasons: string[] };
}

// ------------------------------------------------------------------------------------------------ helpers

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server: Server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('no port')); return; }
      const port = address.port;
      server.close(error => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function parseJsonFile<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

/** Owner-store credential boundary for the two lab environments; session tokens live in this process only. */
function labCredentialStore(input: { labA: () => LabInstance | undefined; labB: () => LabInstance | undefined; version: string; expiresAt: string }): OwnerCredentialStore {
  const entryFor = (accountId: string, instance: LabInstance | undefined): OwnerCredentialEntry | undefined => {
    if (!instance) return undefined;
    const token = instance.tokenFor(accountId);
    if (!token) return undefined;
    return { accountId, version: `${input.version}-${instance.instanceId}`, secret: token, expiresAt: input.expiresAt, targetIds: [TARGET_A, TARGET_B], actions: ['read'] };
  };
  return {
    async read(accountId: string) {
      if (accountId === ACTOR_GUEST || accountId === ACTOR_ADMIN) return entryFor(accountId, input.labA());
      if (accountId === ACTOR_GUEST_B) return entryFor(accountId, input.labB());
      return undefined;
    },
    async list() { return [ACTOR_GUEST, ACTOR_ADMIN, ACTOR_GUEST_B]; },
  };
}

/** The plan variant of the owner document: a real planner task plus an owner-approved planner document. */
function planVariant(config: ApplicationConfigWithSpend, input: { planExtensionPath: string; planExtensionDigest: string; planApprovals: PlanApprovalDocument[]; now: number }): ApplicationConfigWithSpend {
  const extension = { path: input.planExtensionPath, sha256: input.planExtensionDigest, approval: 'owner-approved live-lab plan bridge extension' };
  const materializedToolPolicy = {
    mode: 'sandbox-extension' as const, boundaryId: 'live-lab-plan-worker-bridge',
    tools: ['p2o_context', 'p2o_broker', 'p2o_authoring', 'p2o_packet', 'p2o_threat_model'],
    extension,
  };
  const plannerToolPolicy = {
    mode: 'sandbox-extension' as const, boundaryId: 'live-lab-planner-bridge',
    tools: ['p2o_context', 'p2o_broker', 'p2o_authoring', 'p2o_packet', 'p2o_threat_model', 'p2o_plan_context', 'p2o_plan_propose'],
    extension,
  };
  const tasks = config.tasks.map(entry => {
    if (entry.manifest.taskId === TASK_SURFACE_MAP) {
      return {
        ...entry,
        manifest: {
          ...entry.manifest,
          skills: [...new Set([...entry.manifest.skills, 'plan-authoring'])],
          question: { ...entry.manifest.question, text: `${entry.manifest.question.text}\n\n${PLANNER_STEPS}` },
          budgets: { ...entry.manifest.budgets, maxTokens: PLANNER_MAX_TOKENS, maxCostUsd: PLANNER_MAX_COST_USD },
        },
        toolPolicy: plannerToolPolicy,
      };
    }
    if (entry.manifest.taskId === TASK_VERIFY) {
      // The plan materializes its own (flattened) task graph, so the owner verifier is declared here as a plan
      // root whose ordering constraint is its dependency list rather than the original parent depth. Its
      // question, scope, budgets, tool policy and dependencies are unchanged.
      const manifest = { ...entry.manifest, depth: 0 };
      delete manifest.parentTaskId;
      return { ...entry, manifest };
    }
    return entry;
  });
  // Durable-run sentinel. The two-phase demo cannot admit the verifier before its plan dependencies exist, so a
  // small never-launchable task keeps the run active across the composition restart: its deadline is a few
  // seconds out (the scheduler skips expired tasks) and it depends on the planner task, so it can never run.
  // Phase 2 explicitly cancels it so the run can reach its terminal state without adding a process to the report.
  const mapTask = config.tasks.find(entry => entry.manifest.taskId === TASK_SURFACE_MAP)!;
  const sentinelTask: GrantedTask = {
    manifest: {
      ...mapTask.manifest,
      taskId: PLAN_SENTINEL_TASK,
      parentTaskId: TASK_SURFACE_MAP,
      dependencyTaskIds: [TASK_SURFACE_MAP],
      depth: 1,
      question: {
        text: 'Run sentinel: this owner-approved task exists only to keep the durable run active while the planner proposes and the owner approves the plan batch. It is cancelled by the harness before the run may complete and it never launches a worker.',
        ifTrue: 'The sentinel is still queued, so the durable run remains active across the two compositions',
        ifFalse: 'The sentinel reached a terminal state and the run may complete',
      },
      skills: [],
      allowedActions: ['analyze'],
      requiredCapabilities: ['source.analyze'],
      budgets: { deadlineAt: new Date(input.now + 5_000).toISOString(), maxRequests: 1, maxBytes: 1_024, maxToolCalls: 1, maxTokens: 1, maxCostUsd: 0, maxAttempts: 1 },
      workspace: join(config.roots.workspace, PLAN_SENTINEL_TASK),
    },
    role: 'worker',
    toolPolicy: materializedToolPolicy,
    boundaryReceipt: 'sentinel only: never launched, cancelled before the run may complete',
  };
  const sentinelGrant = {
    id: 'grant-plan-sentinel', taskId: PLAN_SENTINEL_TASK, role: 'worker' as const,
    capabilities: ['source.analyze'] as ['source.analyze'], targetIds: [TARGET_A], actions: ['read', 'analyze'] as ['read', 'analyze'],
    accountIds: [ACTOR_GUEST], expiresAt: config.policy.authorization.expiresAt, maxCalls: 1, maxArtifactBytes: 1_024,
  };
  return {
    ...config,
    tasks: [...tasks, sentinelTask],
    policy: { ...config.policy, grantTemplates: [...config.policy.grantTemplates, sentinelGrant] },
    planner: {
      toolPolicy: materializedToolPolicy,
      boundaryReceipt: `${BOUNDARY_RECEIPT}; plan-materialized tasks execute only the owner-approved observations the approved plan selected`,
      role: 'worker',
      caps: { maxTasks: 4, maxDepth: 3, maxObservations: 32, maxRequests: 96 },
      threatModelCaps: { maxBodyChars: 8_192, maxAmendmentChars: 1_024, maxAmendments: 16 },
      planApprovals: input.planApprovals.map(document => ({ ...document })),
    },
  };
}

interface PlanReadView {
  runId: string;
  proposals: Array<{ proposalId: string; digest: string; plannerAttemptId: string; taskCount: number; observationCount: number; coverageCount: number; approved: boolean }>;
  proposal?: PlanProposal;
  digest?: string;
  approvals: Array<{ proposalId: string; approvalId: string; reference: string; expiresAt: string; approvedAt: string; admittedTaskIds: string[] }>;
  threatModels: Array<{ found: boolean; targetKey: string; revision: number; body: string; amendmentCount: number; amendments: Array<{ amendmentId: string; authorAttemptId: string; at: string; digest: string; text: string }> }>;
  coverage: CoverageReconciliation;
}

interface PlanProposeView { ok: boolean; proposalId: string; proposalDigest: string; taskCount: number; observationCount: number; coverageCount: number; code?: string }
interface PlanApproveView {
  ok: boolean;
  code?: string;
  admittedTaskIds: string[];
  observationCount: number;
  coverageCellIds: string[];
  approval: { approvalId: string; reference: string; expiresAt: string; duplicate: boolean };
}

// ---------------------------------------------------------------------------------------------------- run

export async function runLivePlan(options: LivePlanOptions): Promise<LivePlanResult> {
  if (!options?.apiKey || options.apiKey.length < 8) throw new Error('a resolved upstream credential is required');
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const repoRoot = options.repoRoot ?? process.env.P2O_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const sourceRoot = options.sourceRoot ?? process.env.P2O_EXAMPLE_SOURCE ?? join(repoRoot, 'examples', 'live-lab');
  const runId = options.runId ?? `live-plan-${Date.now().toString(36)}`;
  const now = Date.now();

  const priceLine = assertPricedSelection(LIVE_SELECTION.provider, LIVE_SELECTION.model);
  log(`[plan] selection ${LIVE_SELECTION.provider}/${LIVE_SELECTION.model} thinking=${LIVE_SELECTION.thinking}; pinned price ${priceLine}`);
  log(`[plan] sandbox pack ${readPackLock(packPaths(repoRoot).lockPath).image.pin} source snapshot ${SNAPSHOT_FILE}`);

  const labModule: LabServerModule = await loadLabModule(sourceRoot);
  const piBinary = join(repoRoot, 'node_modules', '.bin', 'pi');
  if (!existsSync(piBinary)) throw new Error(`pinned worker binary missing: ${piBinary}`);
  const piPackage = parseJsonFile<{ version?: string }>(join(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'));
  if (piPackage?.version !== LIVE_PI_VERSION) throw new Error(`worker binary version ${piPackage?.version ?? 'unknown'} does not match the pinned ${LIVE_PI_VERSION}`);
  const planExtensionPath = join(sourceRoot, 'plan-extension.mjs');
  if (!existsSync(planExtensionPath)) throw new Error(`plan extension missing: ${planExtensionPath}`);
  const planExtensionDigest = sha256(readFileSync(planExtensionPath));

  const runRootWasGiven = options.runRoot !== undefined;
  if (options.runRoot) mkdirSync(options.runRoot, { recursive: true, mode: 0o700 });
  const runRoot = mkdtempSync(join(options.runRoot ?? tmpdir(), 'lp-'));
  const snapshotRoot = join(runRoot, 'snapshot');
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  const snapshotFile = join(snapshotRoot, SNAPSHOT_FILE);
  copyFileSync(join(sourceRoot, SNAPSHOT_FILE), snapshotFile);
  const snapshotBytes = readFileSync(snapshotFile);
  if (sourceSnapshotDigest(snapshotBytes) !== sourceSnapshotDigest(readFileSync(join(sourceRoot, SNAPSHOT_FILE)))) throw new Error('snapshot copy is not identical to the executed lab target');

  const authorizationExpiresAt = new Date(now + AUTHORIZATION_WINDOW_MS).toISOString();
  const sandboxOptions: ContainerSandboxOptions = buildContainerSandboxOptions({
    repoRoot, inputRoot: snapshotRoot, outputRoot: join(runRoot, 'broker-artifacts'),
    approvedBy: 'live-plan-owner', expiresAt: authorizationExpiresAt,
  });
  const configurationDigest = createContainerSandbox(sandboxOptions).configurationDigest;

  const portB = await freePort();
  let labA: LabInstance | undefined;
  let labB: LabInstance | undefined;
  const credentials = labCredentialStore({ labA: () => labA, labB: () => labB, version: 'live-plan', expiresAt: authorizationExpiresAt });

  let app1: AssessmentApplication | undefined;
  let app2: AssessmentApplication | undefined;
  const logLines: string[] = [];
  const logSink = (message: string): void => {
    logLines.push(message);
    if (logLines.length > 6_000) logLines.splice(0, logLines.length - 6_000);
    log(`[plan] ${message}`);
  };
  const overrides = () => ({
    upstream: {
      approval: LIVE_GATEWAY_APPROVAL,
      provider: LIVE_SELECTION.provider,
      upstreamBaseUrl: LIVE_UPSTREAM_BASE_URL,
      api: LIVE_API,
      models: [...LIVE_GATEWAY_MODELS],
      credential: {
        accountId: options.credentialAccount ?? 'deepseek-owner-account',
        version: options.credentialVersion ?? 'pi-auth-print-api-key',
        secret: options.apiKey,
      },
      log: logSink,
    },
    credentials,
    replayEnvironment: (services: VerificationServices) => createLabReplayEnvironment(services, {
      module: labModule, port: portB, environmentId: ENVIRONMENT_B,
      initial: () => labB, setCurrent: (instance: LabInstance) => { labB = instance; },
      accounts: ENVIRONMENT_B_ACCOUNTS,
    }),
    log: (event: string, detail: string) => logSink(`${event} ${detail}`),
  });

  try {
    labA = await labModule.startLabServer({ environmentId: ENVIRONMENT_A, port: 0, configurationDigest });
    labB = await labModule.startLabServer({ environmentId: ENVIRONMENT_B, port: portB, configurationDigest, accounts: ENVIRONMENT_B_ACCOUNTS });
    log(`[plan] lab A ${labA.origin}  lab B ${labB.origin}  sandbox digest ${configurationDigest.slice(0, 16)}`);

    const scenario = buildScenario({
      runId, runRoot, snapshotRoot, snapshotBytes, labA, labB,
      workspaceRoot: join(runRoot, 'workspaces'), controlRoot: join(runRoot, 'control'), vaultRoot: join(runRoot, 'vault'),
      socketPath: join(runRoot, 'b.sock'), piBinary, extensionPath: join(sourceRoot, 'bridge-extension.js'),
      sandboxOptions, configurationDigest, now,
    });
    // Two compositions over one run need more wall-clock than the single-phase slice; the extended deadline
    // still sits inside the owner-approved 45-minute authorization window.
    scenario.config.run.budgets.deadlineAt = new Date(now + PLAN_RUN_DEADLINE_MS).toISOString();
    const phase1Path = join(runRoot, 'assessment-phase1.json');
    const phase2Path = join(runRoot, 'assessment-phase2.json');
    const manifestPath = join(runRoot, 'run-manifest.json');
    const phase1Config = planVariant(scenario.config, { planExtensionPath, planExtensionDigest, planApprovals: [], now });
    writeFileSync(phase1Path, `${JSON.stringify(phase1Config, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(manifestPath, `${JSON.stringify(phase1Config.run, null, 2)}\n`, { mode: 0o600 });

    // ------------------------------------------------------------------ phase 1: the planner worker proposes
    const config1 = loadApplicationConfig(phase1Path);
    app1 = await createApplication(config1, overrides());
    const plannerTask = config1.tasks.find(entry => entry.manifest.taskId === TASK_SURFACE_MAP);
    const verifyTask = config1.tasks.find(entry => entry.manifest.taskId === TASK_VERIFY);
    const sentinelTask = config1.tasks.find(entry => entry.manifest.taskId === PLAN_SENTINEL_TASK);
    if (!plannerTask || !verifyTask || !sentinelTask) throw new Error('the plan owner document must carry the planner, verifier and sentinel tasks');
    await app1.admitApprovedRun();
    await app1.supervisor.admitTask({ manifest: plannerTask.manifest, role: plannerTask.role });
    // The owner-approved sentinel depends on the planner task and expires seconds after admission, so it can
    // never launch; it keeps the durable run active across the two compositions instead of letting a
    // single-task phase complete and seal the run.
    await app1.supervisor.admitTask({ manifest: sentinelTask.manifest, role: sentinelTask.role });
    app1.supervisor.start(runId);
    log('[plan] phase 1 started: real planner worker admitted');

    const plannerDeadline = now + PLANNER_PHASE_BUDGET_MS;
    const plannerSettled = async (): Promise<boolean> => {
      const task = app1?.store.getTask(TASK_SURFACE_MAP);
      if (task?.packetState === 'accepted') return true;
      const attempts = app1?.store.listAttempts(runId, TASK_SURFACE_MAP) ?? [];
      return attempts.length > 0 && attempts.length >= plannerTask.manifest.budgets.maxAttempts
        && attempts.every(attempt => TERMINAL_ATTEMPT.has(attempt.lifecycleState));
    };
    while (!(await plannerSettled()) && Date.now() < plannerDeadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
      await app1.supervisor.tick(runId);
    }
    const plannerState = app1.store.getTask(TASK_SURFACE_MAP);
    const plannerAttempts = app1.store.listAttempts(runId, TASK_SURFACE_MAP);
    const plannerAttemptId = plannerAttempts.at(-1)?.attemptId ?? null;
    const proposalPath = join(runRoot, 'workspaces', TASK_SURFACE_MAP, 'plan.proposal.json');
    const proposalWritten = existsSync(proposalPath);
    log(`[plan] phase 1 settled: task=${plannerState?.lifecycleState}/${plannerState?.packetState} attempts=${plannerAttempts.length} proposal=${proposalWritten}`);
    if (!proposalWritten) throw new Error('the real planner attempt wrote no plan proposal packet; nothing is faked');

    const controller1 = new InterfaceController(async () => app1!.interfaceBackend);
    const proposed = await controller1.execute('plan', { action: 'propose', runId, proposalPath }, runRoot) as PlanProposeView;
    if (proposed.ok !== true) throw new Error(`p2o_plan propose refused the worker packet: ${String(proposed.code)}`);
    log(`[plan] p2o_plan propose stored ${proposed.proposalId} digest=${proposed.proposalDigest.slice(0, 16)}… tasks=${proposed.taskCount} observations=${proposed.observationCount} coverage=${proposed.coverageCount}`);

    const readAfterPropose = await controller1.execute('plan', {
      action: 'read', runId, proposalId: proposed.proposalId,
    }, runRoot) as PlanReadView;
    const proposal = readAfterPropose.proposal;
    if (!proposal) throw new Error('p2o_plan propose stored no proposal');
    const requestSum = proposal.observations.reduce((sum, observation) => sum + observation.requests, 0);
    const capsCheck: PlanCapsCheck = {
      declared: { ...proposal.caps },
      counts: {
        tasks: proposal.tasks.length, observations: proposal.observations.length, coverage: proposal.coverage.length,
        requests: requestSum, maxDepth: proposal.tasks.reduce((deepest, task) => Math.max(deepest, task.depth), 0),
      },
      withinCaps: proposal.tasks.length <= proposal.caps.maxTasks && proposal.observations.length <= proposal.caps.maxObservations
        && requestSum <= proposal.caps.maxRequests && proposal.tasks.every(task => task.depth <= proposal.caps.maxDepth),
    };
    log(`[plan] caps check: declared=${JSON.stringify(capsCheck.declared)} counts=${JSON.stringify(capsCheck.counts)} withinCaps=${capsCheck.withinCaps}`);

    // ------------------------------------------------------------------ owner batch approval (owner-authored)
    const approvalDocument: PlanApprovalDocument = {
      version: 1,
      approvalId: `approval-${proposal.proposalId}`.slice(0, 128),
      proposalId: proposal.proposalId,
      proposalDigest: proposed.proposalDigest,
      runId,
      approvedBy: 'live-lab-owner',
      reference: 'owner-plan-approval-live-lab',
      approvedAt: new Date().toISOString(),
      expiresAt: authorizationExpiresAt,
      taskCount: proposal.tasks.length,
      observationCount: proposal.observations.length,
      note: 'Owner batch approval of the exact planner proposal digest recorded by p2o_plan propose.',
    };
    const approvalPath = join(runRoot, 'plan-approval.json');
    writeFileSync(approvalPath, `${JSON.stringify(approvalDocument, null, 2)}\n`, { mode: 0o600 });
    log(`[plan] owner approval document written for digest ${proposed.proposalDigest.slice(0, 16)}… (${approvalPath})`);

    await app1.close();
    app1 = undefined;
    log('[plan] phase 1 composition closed; the durable run stays active because the verifier task is still queued');

    // ------------------------------------------------------------------ phase 2: approve the batch and execute
    const phase2Config = planVariant(scenario.config, { planExtensionPath, planExtensionDigest, planApprovals: [approvalDocument], now });
    writeFileSync(phase2Path, `${JSON.stringify(phase2Config, null, 2)}\n`, { mode: 0o600 });
    const config2 = loadApplicationConfig(phase2Path);
    app2 = await createApplication(config2, overrides());
    await app2.admitApprovedRun();
    const controller2 = new InterfaceController(async () => app2!.interfaceBackend);
    const approved = await controller2.execute('plan', {
      action: 'approve', runId, proposalDigest: proposed.proposalDigest, approvalPath,
    }, runRoot) as PlanApproveView;
    if (approved.ok !== true) throw new Error(`p2o_plan approve refused the owner-approved batch: ${String(approved.code)}`);
    log(`[plan] p2o_plan approve admitted ${approved.admittedTaskIds.length} task(s): ${approved.admittedTaskIds.join(', ')}`);
    await app2.supervisor.admitTask({ manifest: verifyTask.manifest, role: verifyTask.role });
    // The sentinel's only job is done: cancel it so the run can reach its terminal state (it never launched).
    app2.store.cancelQueuedTask(PLAN_SENTINEL_TASK);
    await app2.supervisor.recover(runId);
    app2.supervisor.start(runId);
    log('[plan] phase 2 started: plan-materialized workers plus the owner-approved verifier task');

    const runDeadlineAt = Date.parse(phase2Config.run.budgets.deadlineAt);
    let snapshot = app2.supervisor.snapshot(runId);
    let lastProgress = 0;
    while (!TERMINAL_RUN.has(snapshot.run.state) && Date.now() < runDeadlineAt + 5_000) {
      await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
      snapshot = await app2.supervisor.tick(runId);
      if (Date.now() - lastProgress > 30_000) {
        lastProgress = Date.now();
        log(`[plan] progress ${snapshot.tasks.map(task => `${task.taskId}:${task.lifecycleState}/${task.packetState}`).join(' ')}`);
      }
    }
    if (!TERMINAL_RUN.has(snapshot.run.state)) {
      log('[plan] declared deadline reached without a terminal run; cancelling owned execution');
      snapshot = await app2.supervisor.cancel(runId);
    }
    log(`[plan] run ${snapshot.run.runId} state=${snapshot.run.state} tasks=${snapshot.tasks.map(task => `${task.taskId}:${task.lifecycleState}/${task.packetState}`).join(' ')}`);

    // ------------------------------------------------------------------ plan context / threat model / gate
    const planRead = await controller2.execute('plan', { action: 'read', runId }, runRoot) as PlanReadView;
    const durableAttemptIds = new Set(app2.store.listAttempts(runId).map(attempt => attempt.attemptId));
    const bridgeEvents: PlanBridgeEvent[] = [];
    {
      // The event log is paged: a live two-phase run emits more than one default page of durable events.
      const types = ['worker.threat-model-read', 'worker.threat-model-amend', 'worker.plan-context-read'];
      let afterSequence = 0;
      for (let page = 0; page < 40; page += 1) {
        const rows = app2.store.listEvents({ runId, afterSequence, limit: 1_000 });
        for (const event of rows) {
          if (!types.includes(event.type)) continue;
          bridgeEvents.push({
            sequence: event.sequence, type: event.type,
            attemptId: event.attemptId ?? null, taskId: event.taskId ?? null,
            payload: (event.payload ?? {}) as Record<string, unknown>,
          });
        }
        if (rows.length < 1_000) break;
        afterSequence = rows[rows.length - 1]!.sequence;
      }
    }
    const threatModel = {
      models: planRead.threatModels.map(model => ({
        targetKey: model.targetKey, revision: model.revision, bodyDigest: model.body.length > 0, bodyChars: model.body.length,
        amendments: model.amendments.map(amendment => ({
          amendmentId: amendment.amendmentId, authorAttemptId: amendment.authorAttemptId, at: amendment.at,
          digest: amendment.digest, text: amendment.text, authorIsDurableAttempt: durableAttemptIds.has(amendment.authorAttemptId),
        })),
      })),
    };

    const planLedger = app2.planLedger;
    if (!planLedger) throw new Error('the composition exposed no plan ledger; the coverage gate cannot be evaluated');
    const planCells = planLedger.approvedCells(runId);
    const reconciliationBefore = planRead.coverage;
    // The gate must refuse the report while a planned cell is open. This is the real finalization path.
    let refusedBeforeResolutions: { code: string; message: string } | null = null;
    try { app2.artifacts(runId); }
    catch (error) {
      if (error instanceof ApplicationError) refusedBeforeResolutions = { code: error.code, message: error.message.slice(0, 512) };
      else if (error instanceof Error) refusedBeforeResolutions = { code: String((error as { code?: unknown }).code ?? 'unknown'), message: error.message.slice(0, 512) };
      else refusedBeforeResolutions = { code: 'unknown', message: String(error).slice(0, 512) };
    }
    log(`[plan] coverage gate before resolutions: ${refusedBeforeResolutions ? `REFUSED ${refusedBeforeResolutions.code}` : 'NOT REFUSED'}`);
    if (refusedBeforeResolutions?.code !== 'coverage-unresolved-cell') {
      throw new Error(`the report gate did not refuse an un-reconciled plan: ${JSON.stringify(refusedBeforeResolutions)}`);
    }

    // Controller-derived resolutions from durable accepted evidence; carried cells keep an explicit reason.
    const resolutions: LivePlanResult['gate']['resolutions'] = [];
    for (const cell of planCells) {
      const result = app2.store.listResults(runId, cell.taskId).find(candidate => candidate.decision.status === 'accepted');
      const packet = result?.packet;
      if (packet && packet.outcome === 'supported') {
        resolutions.push({
          cellId: cell.cellId, outcome: 'resolved', basis: 'runtime-observed',
          evidenceIds: [...packet.evidenceIds].slice(0, 16),
          carried: false,
          authorAttemptId: result!.attemptId,
          reason: `Accepted packet ${packet.packetId} from attempt ${result!.attemptId} supports ${cell.surfaceId}/${cell.actorId}; the owner-approved verifier task independently replays the claim in a fresh environment.`,
        });
      } else {
        resolutions.push({
          cellId: cell.cellId, outcome: 'untested', basis: 'reviewer-validated', evidenceIds: [],
          carried: true,
          authorAttemptId: 'p2o-plan-finalizer',
          reason: 'No accepted packet exists for the planned task, so the cell is carried into the report as untested with an explicit reason instead of being dropped.',
        });
      }
    }
    for (const resolution of resolutions) {
      const recorded = planLedger.recordCoverageResolution({
        runId, cellId: resolution.cellId, outcome: resolution.outcome, basis: resolution.basis,
        evidenceIds: resolution.evidenceIds, reason: resolution.reason, carried: resolution.carried,
        authorAttemptId: resolution.authorAttemptId, at: new Date().toISOString(),
      });
      if (!recorded.ok) throw new Error(`the plan ledger refused a coverage resolution: ${recorded.code}`);
    }
    const reconciliation = planLedger.coverage(runId);
    log(`[plan] coverage after resolutions: canFinalize=${reconciliation.canFinalize} resolved=${reconciliation.resolved.length} carried=${reconciliation.carried.length} unresolved=${reconciliation.unresolved.length}`);

    const artifacts = app2.artifacts(runId);
    const reportJsonPath = join(runRoot, 'report.json');
    const reportMarkdownPath = join(runRoot, 'report.md');
    writeFileSync(reportJsonPath, `${artifacts.json}\n`, { mode: 0o600 });
    writeFileSync(reportMarkdownPath, `${artifacts.markdown}\n`, { mode: 0o600 });

    // ------------------------------------------------------------------ controller-side run evidence
    const results = app2.store.listResults(runId);
    const evidence = app2.store.listEvidence(runId);
    const controlRoot = config2.roots.control;
    const attestations: GatewayAttestation[] = [];
    const workerSessions: LiveWorkerSession[] = [];
    const handlesRoot = join(controlRoot, 'handles');
    for (const entry of readdirSync(handlesRoot)) {
      if (!entry.endsWith('.json')) continue;
      const handle = parseJsonFile<{ attemptId?: string; taskId?: string; controlDir?: string }>(join(handlesRoot, entry));
      if (!handle?.attemptId || !handle.taskId || !handle.controlDir) continue;
      try { if (!statSync(handle.controlDir).isDirectory()) continue; } catch { continue; }
      const worker = parseJsonFile<{ toolPolicy?: { tools?: string[] } }>(join(handle.controlDir, 'worker.json'));
      const exchange = parseJsonFile<GatewayAttestation[]>(join(handle.controlDir, 'gateway-attestation.json'));
      if (Array.isArray(exchange)) attestations.push(...exchange);
      const receipt = parseJsonFile<{ events?: Array<{ type?: string }> }>(join(handle.controlDir, 'pi-receipt.json'));
      const events = Array.isArray(receipt?.events) ? receipt.events : [];
      workerSessions.push({
        attemptId: handle.attemptId, taskId: handle.taskId,
        tools: Array.isArray(worker?.toolPolicy?.tools) ? worker.toolPolicy.tools : [],
        turns: events.filter(event => event.type === 'message_end').length,
        inputTokens: 0, outputTokens: 0,
      });
    }
    attestations.sort((left, right) => left.seq - right.seq);

    const toolReceipts: LiveToolReceipt[] = [];
    const observedOrigins = new Set<string>();
    const escapes: string[] = [];
    const approvedOrigins = [labA.origin, labB?.origin].filter((origin): origin is string => typeof origin === 'string');
    for (const receipt of evidence) {
      let collectorRole = 'unknown';
      try { collectorRole = app2.vault.inspect(receipt.evidenceId)?.collector.role ?? 'controller'; } catch { collectorRole = 'unverifiable'; }
      const metadata = (receipt.metadata ?? {}) as Record<string, unknown>;
      toolReceipts.push({
        evidenceId: receipt.evidenceId, taskId: receipt.taskId, attemptId: receipt.attemptId,
        toolName: receipt.provenance.tool.name, kind: receipt.kind, classification: receipt.classification,
        collectorId: receipt.provenance.collectorId, collectorRole, environmentId: receipt.provenance.environmentId,
        testOutcome: receipt.test?.outcome ?? null, testPurpose: receipt.test?.purpose ?? null,
        checkId: typeof metadata.checkId === 'string' ? metadata.checkId : null,
        observationId: typeof metadata.observationId === 'string' ? metadata.observationId : null,
        collectedAt: receipt.provenance.collectedAt,
      });
      if (receipt.provenance.tool.name !== 'http.request') continue;
      let bytes: Buffer | undefined;
      try { bytes = app2.vault.read(receipt.evidenceId); } catch { bytes = undefined; }
      if (!bytes) continue;
      const data = JSON.parse(bytes.toString('utf8')) as { hops?: Array<{ url?: string }> };
      for (const hop of data.hops ?? []) {
        if (typeof hop.url !== 'string') continue;
        let origin: string;
        try { origin = new URL(hop.url).origin; } catch { escapes.push(`${receipt.evidenceId}: unparseable hop url`); continue; }
        observedOrigins.add(origin);
        if (!approvedOrigins.includes(origin)) escapes.push(`${receipt.evidenceId}: ${origin} is outside the approved targets`);
      }
    }
    toolReceipts.sort((left, right) => left.collectedAt.localeCompare(right.collectedAt));

    const ledger = app2.store.modelSpendJournal(runId).load(runId) as {
      limits?: { maxTokens?: number; maxCostUsdMicros?: number };
      committed?: { tokens?: number; costMicros?: number };
      overshoot?: { tokens?: number; costMicros?: number };
      settlements?: Record<string, { attemptId?: string; selection?: { provider: string; model: string; thinking: string }; inputTokens?: number; outputTokens?: number; tokens?: number; costMicros?: number; basis?: string }>;
    } | undefined;
    const settlements: LiveTurnSettlement[] = Object.entries(ledger?.settlements ?? {}).map(([turnId, record]) => ({
      turnId, attemptId: record.attemptId ?? 'unknown',
      selection: record.selection ?? { provider: 'unknown', model: 'unknown', thinking: 'unknown' },
      inputTokens: record.inputTokens ?? 0, outputTokens: record.outputTokens ?? 0,
      tokens: record.tokens ?? 0, costMicros: record.costMicros ?? 0, basis: record.basis ?? 'provider-usage',
    })).sort((left, right) => left.turnId.localeCompare(right.turnId));
    for (const session of workerSessions) {
      const charged = settlements.filter(settlement => settlement.attemptId === session.attemptId);
      session.inputTokens = charged.reduce((sum, settlement) => sum + settlement.inputTokens, 0);
      session.outputTokens = charged.reduce((sum, settlement) => sum + settlement.outputTokens, 0);
    }

    const decisions: LiveResultDecision[] = results.map(result => ({
      taskId: result.taskId, attemptId: result.attemptId, packetId: result.packet?.packetId ?? null,
      status: result.decision.status, contract: result.decision.contract ?? null, outcome: result.decision.outcome ?? null,
      reasons: result.decision.reasons.map(reason => reason.code),
    }));

    const audit = async (secrets: string[]): Promise<{ files: number; clean: boolean; detail: string }> => {
      if (!secrets.length) return { files: 0, clean: true, detail: 'no secret material to scan for' };
      try { return { files: await auditArtifactsForSecrets(runRoot, secrets), clean: true, detail: 'absent' }; }
      catch (error) { return { files: 0, clean: false, detail: error instanceof Error ? error.message.slice(0, 200) : 'scan failed' }; }
    };
    const labTokens = [labA.tokenFor(ACTOR_GUEST), labA.tokenFor(ACTOR_ADMIN), labB?.tokenFor(ACTOR_GUEST_B)].filter((token): token is string => typeof token === 'string');
    const leakAudit = { providerCredential: await audit([options.apiKey]), labTokens: await audit(labTokens) };

    const reportFindings = artifacts.report.findings.map(finding => ({
      findingId: finding.findingId, state: finding.state, classification: finding.classification,
      evidenceCount: finding.evidenceIds.length, verifier: finding.verifier?.identity ?? null,
    }));
    const verifierOutcomes = logLines.filter(line => line.startsWith('verifier.outcome'));
    const amendments = threatModel.models.flatMap(model => model.amendments);
    const workerAmendments = amendments.filter(amendment => amendment.authorIsDurableAttempt && amendment.authorAttemptId !== plannerAttemptId);
    const independentlyValidated = reportFindings.filter(finding => finding.state === 'independently-validated').length;
    const acceptedPlanTasks = approved.admittedTaskIds.filter(taskId => app2!.store.getTask(taskId)?.packetState === 'accepted');

    const acceptanceReasons: string[] = [];
    if (!TERMINAL_RUN.has(snapshot.run.state)) acceptanceReasons.push(`run state is ${snapshot.run.state}`);
    if (proposal.provenance.plannerKind !== 'worker') acceptanceReasons.push('the stored proposal is not a real worker packet');
    if (!capsCheck.withinCaps) acceptanceReasons.push('the proposal exceeded its declared caps');
    if (!proposed.proposalDigest) acceptanceReasons.push('no proposal digest was recorded');
    if (approved.admittedTaskIds.length === 0) acceptanceReasons.push('the owner approval admitted no plan task');
    if (acceptedPlanTasks.length !== approved.admittedTaskIds.length) acceptanceReasons.push(`only ${acceptedPlanTasks.length}/${approved.admittedTaskIds.length} admitted plan tasks produced an accepted packet`);
    if (reconciliationBefore.canFinalize || reconciliationBefore.unresolved.length === 0) acceptanceReasons.push('the plan coverage gate was not open before resolutions (nothing to reconcile)');
    if (refusedBeforeResolutions?.code !== 'coverage-unresolved-cell') acceptanceReasons.push('the report did not refuse an un-reconciled plan');
    if (!reconciliation.canFinalize) acceptanceReasons.push(`plan coverage reconciliation left ${reconciliation.unresolved.length} unresolved cell(s)`);
    if (!threatModel.models.length) acceptanceReasons.push('no run threat model exists');
    if (!bridgeEvents.some(event => event.type === 'worker.threat-model-read')) acceptanceReasons.push('no real worker read the threat model through the bridge');
    if (!bridgeEvents.some(event => event.type === 'worker.plan-context-read')) acceptanceReasons.push('the planner never read the plan context through the bridge');
    if (!workerAmendments.length) acceptanceReasons.push('no plan-materialized worker appended an attributed threat-model amendment');
    if (!independentlyValidated) acceptanceReasons.push('no finding reached independently-validated');
    if (escapes.length) acceptanceReasons.push(`scope escapes: ${escapes.join('; ')}`);
    if (!leakAudit.providerCredential.clean) acceptanceReasons.push(`credential leak audit failed: ${leakAudit.providerCredential.detail}`);
    if (!leakAudit.labTokens.clean) acceptanceReasons.push(`lab token leak audit failed: ${leakAudit.labTokens.detail}`);
    if ((ledger?.committed?.tokens ?? 0) > RUN_MAX_TOKENS) acceptanceReasons.push('run token budget exceeded');
    if ((ledger?.committed?.costMicros ?? 0) > RUN_MAX_COST_USD * 1_000_000) acceptanceReasons.push('run cost budget exceeded');

    const summaryPath = join(runRoot, 'plan-summary.json');
    const result: LivePlanResult = {
      runId, runRoot,
      runState: snapshot.run.state,
      terminal: TERMINAL_RUN.has(snapshot.run.state),
      assessmentStatus: artifacts.report.assessmentStatus,
      reportPaths: { json: reportJsonPath, markdown: reportMarkdownPath, summary: summaryPath },
      proposal: {
        proposalId: proposal.proposalId, digest: proposed.proposalDigest,
        plannerKind: proposal.provenance.plannerKind, plannerAttemptId: proposal.provenance.plannerAttemptId,
        purpose: proposal.run.purpose,
        taskIds: proposal.tasks.map(task => task.taskId),
        observationIds: proposal.observations.map(observation => observation.observationId),
        coverageCellIds: proposal.coverage.map(cell => cell.cellId),
        threats: threatModel.models.length, caps: capsCheck, path: proposalPath,
      },
      approval: {
        approvalId: approved.approval.approvalId, reference: approved.approval.reference,
        approvedBy: approvalDocument.approvedBy, expiresAt: approved.approval.expiresAt, path: approvalPath,
        duplicate: approved.approval.duplicate, admittedTaskIds: approved.admittedTaskIds,
        observationCount: approved.observationCount, coverageCellIds: approved.coverageCellIds,
      },
      phase1: {
        plannerTaskId: TASK_SURFACE_MAP, plannerAttemptId,
        plannerTaskState: plannerState?.lifecycleState ?? 'unknown', plannerPacketState: plannerState?.packetState ?? 'unknown',
        proposalWritten,
      },
      gate: { refusedBeforeResolutions, reconciliationBefore, resolutions, reconciliation },
      threatModel,
      bridgeEvents,
      gateway: {
        gatewayId: attestations[0]?.gatewayId ?? null,
        exchanges: attestations.length,
        forwarded: attestations.filter(entry => entry.outcome === 'forwarded').length,
        denied: attestations.filter(entry => entry.outcome === 'denied').length,
        observed: attestations.map(entry => ({ provider: entry.observed.provider, model: entry.observed.model ?? 'none', thinking: entry.observed.thinking, matchesRequest: entry.matchesRequest })),
        attestations: attestations.slice(-60),
      },
      spend: {
        limits: { maxTokens: ledger?.limits?.maxTokens ?? 0, maxCostUsd: (ledger?.limits?.maxCostUsdMicros ?? 0) / 1_000_000 },
        committed: { tokens: ledger?.committed?.tokens ?? 0, costMicros: ledger?.committed?.costMicros ?? 0 },
        overshoot: { tokens: ledger?.overshoot?.tokens ?? 0, costMicros: ledger?.overshoot?.costMicros ?? 0 },
        settlements,
      },
      workerSessions, toolReceipts, decisions, verifierOutcomes,
      report: {
        findings: reportFindings,
        coverage: Object.entries(artifacts.report.coverage.counts).map(([state, count]) => ({ state, count: Number(count) })),
        packets: artifacts.report.packets.map(packet => ({ taskId: packet.taskId, contract: packet.contract, outcome: packet.outcome, classification: packet.classification })),
      },
      scope: { approvedOrigins, observedOrigins: [...observedOrigins].sort(), escapes },
      leakAudit,
      acceptance: { ok: acceptanceReasons.length === 0, reasons: acceptanceReasons },
    };
    writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    if (options.keep !== true) {
      const durable = join(sourceRoot, '.runs', 'latest');
      mkdirSync(durable, { recursive: true, mode: 0o700 });
      for (const [name, path] of [['report.json', reportJsonPath], ['report.md', reportMarkdownPath], ['plan-summary.json', summaryPath]] as const) {
        copyFileSync(path, join(durable, name));
      }
      result.reportPaths = { json: join(durable, 'report.json'), markdown: join(durable, 'report.md'), summary: join(durable, 'plan-summary.json') };
    }
    return result;
  } finally {
    try { await app1?.close(); } catch { /* phase 1 may already be closed */ }
    try { await app2?.close(); } catch { /* the app owns its runtimes */ }
    try { await labA?.close(); } catch { /* instance may already be closed */ }
    try { await labB?.close(); } catch { /* instance may already be closed */ }
    if (options.keep !== true && !runRootWasGiven) rmSync(runRoot, { recursive: true, force: true });
    else log(`[plan] run directory kept at ${runRoot}`);
  }
}

// -------------------------------------------------------------------------------------------------- print

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(6)}`;

/** Raw, printable planner-demo evidence. Contains no credential material by construction. */
export function formatPlanResult(result: LivePlanResult): string {
  const lines: string[] = [];
  lines.push(`run ${result.runId} state=${result.runState} terminal=${result.terminal} assessmentStatus=${result.assessmentStatus}`);
  lines.push(`ACCEPTANCE ok=${result.acceptance.ok}${result.acceptance.ok ? '' : ` reasons=${result.acceptance.reasons.join(' | ')}`}`);
  lines.push('plan proposal (real worker packet):');
  lines.push(`  proposal=${result.proposal.proposalId} digest=${result.proposal.digest} plannerKind=${result.proposal.plannerKind} plannerAttempt=${result.proposal.plannerAttemptId ?? 'none'}`);
  lines.push(`  purpose=${result.proposal.purpose}`);
  lines.push(`  tasks=[${result.proposal.taskIds.join(',')}] observations=[${result.proposal.observationIds.join(',')}] cells=[${result.proposal.coverageCellIds.join(',')}] threats=${result.proposal.threats} path=${result.proposal.path}`);
  lines.push(`  caps declared=${JSON.stringify(result.proposal.caps.declared)} counts=${JSON.stringify(result.proposal.caps.counts)} withinCaps=${result.proposal.caps.withinCaps}`);
  lines.push('owner batch approval:');
  lines.push(`  approval=${result.approval.approvalId} reference=${result.approval.reference} approvedBy=${result.approval.approvedBy} expiresAt=${result.approval.expiresAt} duplicate=${result.approval.duplicate}`);
  lines.push(`  admitted=[${result.approval.admittedTaskIds.join(',')}] observations=${result.approval.observationCount} cells=[${result.approval.coverageCellIds.join(',')}] document=${result.approval.path}`);
  lines.push(`phase1 planner: task=${result.phase1.plannerTaskId} attempt=${result.phase1.plannerAttemptId ?? 'none'} state=${result.phase1.plannerTaskState}/${result.phase1.plannerPacketState} proposalWritten=${result.phase1.proposalWritten}`);
  lines.push('coverage gate:');
  lines.push(`  before resolutions: ${result.gate.refusedBeforeResolutions ? `REFUSED ${result.gate.refusedBeforeResolutions.code} — ${result.gate.refusedBeforeResolutions.message}` : 'NOT REFUSED'}`);
  lines.push(`  reconciliation before: canFinalize=${result.gate.reconciliationBefore.canFinalize} cells=${result.gate.reconciliationBefore.cells.length} unresolved=[${result.gate.reconciliationBefore.unresolved.join(',')}]`);
  for (const resolution of result.gate.resolutions) {
    lines.push(`  resolution cell=${resolution.cellId} outcome=${resolution.outcome} basis=${resolution.basis} carried=${resolution.carried} evidence=${resolution.evidenceIds.length} author=${resolution.authorAttemptId}`);
  }
  lines.push(`  reconciliation after: canFinalize=${result.gate.reconciliation.canFinalize} resolved=[${result.gate.reconciliation.resolved.join(',')}] carried=[${result.gate.reconciliation.carried.join(',')}] unresolved=[${result.gate.reconciliation.unresolved.join(',')}]`);
  lines.push('threat model (run-scoped, shared):');
  for (const model of result.threatModel.models) {
    lines.push(`  model targetKey=${model.targetKey} revision=${model.revision} bodyChars=${model.bodyChars} amendments=${model.amendments.length}`);
    for (const amendment of model.amendments) {
      lines.push(`    amendment ${amendment.amendmentId} author=${amendment.authorAttemptId} durableAttempt=${amendment.authorIsDurableAttempt} at=${amendment.at} digest=${amendment.digest.slice(0, 16)}… text=${JSON.stringify(amendment.text.slice(0, 240))}`);
    }
  }
  lines.push(`bridge context events (${result.bridgeEvents.length}):`);
  for (const event of result.bridgeEvents) {
    lines.push(`  seq=${event.sequence} ${event.type} task=${event.taskId ?? 'n/a'} attempt=${event.attemptId ?? 'n/a'} payload=${JSON.stringify(event.payload)}`);
  }
  lines.push(`gateway id=${result.gateway.gatewayId ?? 'none'} exchanges=${result.gateway.exchanges} forwarded=${result.gateway.forwarded} denied=${result.gateway.denied}`);
  lines.push(`spend limits maxTokens=${result.spend.limits.maxTokens} maxCostUsd=${result.spend.limits.maxCostUsd} committed tokens=${result.spend.committed.tokens} cost=${usd(result.spend.committed.costMicros)} overshoot tokens=${result.spend.overshoot.tokens} cost=${usd(result.spend.overshoot.costMicros)}`);
  for (const settlement of result.spend.settlements) {
    lines.push(`  turn ${settlement.turnId} attempt=${settlement.attemptId} selection=${settlement.selection.provider}/${settlement.selection.model}/${settlement.selection.thinking} in=${settlement.inputTokens} out=${settlement.outputTokens} tokens=${settlement.tokens} cost=${usd(settlement.costMicros)} basis=${settlement.basis}`);
  }
  for (const session of result.workerSessions) {
    lines.push(`  worker attempt=${session.attemptId} task=${session.taskId} tools=[${session.tools.join(',')}] turns=${session.turns} in=${session.inputTokens} out=${session.outputTokens}`);
  }
  lines.push(`result decisions (${result.decisions.length}):`);
  for (const decision of result.decisions) {
    lines.push(`  task=${decision.taskId} attempt=${decision.attemptId} status=${decision.status} contract=${decision.contract ?? 'n/a'} outcome=${decision.outcome ?? 'n/a'} packet=${decision.packetId ?? 'none'}${decision.reasons.length ? ` reasons=${decision.reasons.join(',')}` : ''}`);
  }
  for (const outcome of result.verifierOutcomes) lines.push(`  ${outcome}`);
  lines.push(`packets: ${result.report.packets.map(packet => `${packet.taskId}/${packet.contract}/${packet.outcome}/${packet.classification}`).join(', ') || 'none'}`);
  lines.push(`findings: ${result.report.findings.map(finding => `${finding.findingId}=${finding.state}/${finding.classification} evidence=${finding.evidenceCount} verifier=${finding.verifier ?? 'none'}`).join(', ') || 'none'}`);
  lines.push(`coverage (report): ${result.report.coverage.map(entry => `${entry.state}=${entry.count}`).join(', ')}`);
  lines.push(`scope: approved=[${result.scope.approvedOrigins.join(',')}] observed=[${result.scope.observedOrigins.join(',')}] escapes=${result.scope.escapes.length}${result.scope.escapes.length ? ` (${result.scope.escapes.join('; ')})` : ''}`);
  lines.push(`leak-audit: provider-credential ${result.leakAudit.providerCredential.clean ? 'ABSENT' : 'DETECTED'} (${result.leakAudit.providerCredential.files} files scanned, ${result.leakAudit.providerCredential.detail}); lab-session-tokens ${result.leakAudit.labTokens.clean ? 'ABSENT' : 'DETECTED'} (${result.leakAudit.labTokens.files} files scanned, ${result.leakAudit.labTokens.detail})`);
  lines.push(`report: ${result.reportPaths.json} | ${result.reportPaths.markdown} | ${result.reportPaths.summary}`);
  lines.push(`run directory: ${result.runRoot}`);
  return lines.join('\n');
}

export { resolveProviderCredential };
