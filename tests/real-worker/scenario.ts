// Owner-approved composition document for the real-Pi worker test.
//
// The "worker" here is the project-pinned Pi binary launched by the real headless runtime adapter in RPC mode
// with only the pinned bridge extension tools. The "model" is a loopback-only deterministic gateway fixture
// (tests/real-worker/inert-gateway.mjs); no provider is contacted and no credential exists.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Authorization, RunManifest, Scope, TaskManifest } from '../../src/contracts/index.js';
import {
  INERT_FIXTURE_ACKNOWLEDGEMENT, LOCAL_FIXTURE_SANDBOX_ACKNOWLEDGEMENT,
  type GrantedTask, type ObservationCheck, type PolicyTemplate,
} from '../../src/application/index.js';
// [T8/S1] The validated document plus the owner-declared spend bounds (composition-owned type).
import type { ApplicationConfigWithSpend } from '../../src/application/composition.js';
import type { FixtureInstance } from '../../examples/local-assessment/fixture-server.js';

export const REAL_WORKER_RUN_ID = 'run-real-worker-1';
export const REAL_WORKER_REFUSED_RUN_ID = 'run-real-worker-refused';
/** [T9] Run whose budget is nearly exhausted mid-conversation, so the next turn is refused at the gateway. */
export const REAL_WORKER_REFUSED_TURN_RUN_ID = 'run-real-worker-refused-turn';
export const REAL_WORKER_TASK_ID = 'task-real-worker';
export const REAL_WORKER_TARGET = 'lab-fixture-a';
export const REAL_WORKER_SOURCE_TARGET = 'fixture-source';
export const REAL_WORKER_ENVIRONMENT = 'lab-fixture-a';
export const REAL_WORKER_ACTOR = 'guest';
export const REAL_WORKER_SURFACE = 'api.read';
export const REAL_WORKER_INPUT_REVISION = 'snapshot-1';
export const REAL_WORKER_SNAPSHOT_FILE = 'fixture-server.ts';
// [T8] This selection is also a key in the pinned model price table (`inert-fixture/inert-worker`), so the
// spend ledger can bound the worst case with a pinned quote instead of refusing an unpriced selection.
export const REAL_WORKER_PROVIDER = 'inert-fixture';
export const REAL_WORKER_MODEL = 'inert-worker';
export const REAL_WORKER_THINKING = 'max' as const;
export const REAL_WORKER_PI_VERSION = '1.0.0';
export const REAL_WORKER_TOOLS = ['p2o_context', 'p2o_broker', 'p2o_packet'] as const;
export const REAL_WORKER_PACKET_ID = 'packet-real-worker';
export const REAL_WORKER_OBSERVATION_BASELINE = 'rw-baseline';
export const REAL_WORKER_OBSERVATION_SOURCE = 'rw-source';
export const REAL_WORKER_OBSERVATION_DENIED = 'rw-denied';
export const REAL_WORKER_CLAIM = 'The guarded read route returns the same-tenant item to the approved guest actor while an unapproved destination is denied before dispatch.';
export const REAL_WORKER_BOUNDARY_RECEIPT = 'real Pi worker via the owner-pinned bridge extension; loopback fixture and loopback inert gateway only; not hostile-code isolation';
export const REAL_WORKER_GATEWAY_APPROVAL = 'inert-loopback-gateway-no-model';

export const REAL_WORKER_SELECTION = Object.freeze({
  provider: REAL_WORKER_PROVIDER,
  model: REAL_WORKER_MODEL,
  thinking: REAL_WORKER_THINKING,
});

export interface RealWorkerScenarioInputs {
  /** Durable run identity; each scenario instance gets its own run, state store and roots. */
  runId?: string;
  runRoot: string;
  snapshotRoot: string;
  /** Bytes of the hashed fixture source snapshot the owner approves as the offline analysis input. */
  snapshotBytes: Buffer;
  fixture: FixtureInstance;
  workspaceRoot: string;
  controlRoot: string;
  vaultRoot: string;
  socketPath: string;
  /** Absolute path of the real pinned bridge extension outside every worker workspace. */
  extensionPath: string;
  /** Absolute path of the real pinned Pi binary. */
  piBinary: string;
  /** Loopback origin of the inert gateway (no credentials, no non-loopback destination). */
  gatewayOrigin: string;
  /** Managed adapter under test; `herdr` additionally needs explicit local Herdr routing metadata. */
  adapter?: 'headless' | 'herdr';
  herdr?: { herdrBinary: string; herdrVersion?: string; parentPaneId: string; context: { HERDR_ENV: '1'; HERDR_SOCKET_PATH: string; HERDR_PANE_ID: string } };
  now: number;
  /** [T8/S1] Declared run token budget; defaults to 4 000 so an unaffordable declaration can be tested. */
  runMaxTokens?: number;
  /** [T9] Task attempt budget; 1 keeps a mid-run refusal a single-attempt witness. */
  taskMaxAttempts?: number;
  /** [T8/S1] Optional owner-declared worst-case bounds; enforcement is on either way. */
  spend?: { inputTokensUpperBound?: number; maxOutputTokens?: number };
  /** [T8/S1] Selection override, used to prove an unpriceable run is refused before anything runs. */
  selection?: { provider: string; model: string; thinking: 'max' };
}

export interface RealWorkerScenario {
  config: ApplicationConfigWithSpend;
  authorization: Authorization;
  checks: ObservationCheck[];
}

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

function policyScope(inputs: RealWorkerScenarioInputs, runId: string, expiresAt: string): PolicyTemplate {
  const origin = inputs.fixture.origin;
  return {
    version: 1,
    runId,
    authorization: { reference: 'owner-authorized-real-worker', approvedBy: 'fixture-owner', expiresAt },
    targets: [{
      id: REAL_WORKER_TARGET,
      origins: [origin],
      pathPrefixes: ['/'],
      allowedCidrs: ['127.0.0.0/8'],
      methods: ['GET', 'HEAD'],
      actions: ['read'],
      accounts: [REAL_WORKER_ACTOR],
      limits: { maxRequests: 16, maxBytes: 4_194_304, maxConcurrent: 1, rate: { requests: 8, windowMs: 1_000 } },
    }],
    exclusions: [],
    accounts: [{ id: REAL_WORKER_ACTOR, targetIds: [REAL_WORKER_TARGET], actions: ['read'], expiresAt, kind: 'anonymous' }],
    grantTemplates: [{
      id: 'grant-real-worker', taskId: REAL_WORKER_TASK_ID, role: 'worker',
      capabilities: ['source.analyze', 'http.request'],
      targetIds: [REAL_WORKER_TARGET],
      actions: ['read', 'analyze'],
      accountIds: [REAL_WORKER_ACTOR],
      expiresAt, maxCalls: 16, maxArtifactBytes: 4_194_304,
    }],
  };
}

function scopeFor(authorization: Authorization, targetIds: string[], inputs: Scope['inputs'], configurationDigest: string): Scope {
  return {
    authorizationRef: authorization.reference,
    targetIds,
    actor: { id: REAL_WORKER_ACTOR, privileges: ['read'] },
    boundary: 'inert loopback fixture only; no external target and no mutation',
    isolation: 'inert local lab: fresh loopback fixture, controller-owned bridge, loopback egress only',
    recovery: 'discard the fixture instance and the private workspace; no host state is modified',
    environmentId: REAL_WORKER_ENVIRONMENT,
    configurationDigest,
    inputs,
  };
}

/** Build the complete owner-approved real-worker document. Every path and identity is passed in. */
export function buildRealWorkerScenario(inputs: RealWorkerScenarioInputs): RealWorkerScenario {
  const runId = inputs.runId ?? REAL_WORKER_RUN_ID;
  const adapter = inputs.adapter ?? 'headless';
  const runMaxTokens = inputs.runMaxTokens ?? 4_000;
  const taskMaxAttempts = inputs.taskMaxAttempts ?? 2;
  const selection = inputs.selection ?? REAL_WORKER_SELECTION;
  const configurationDigest = inputs.fixture.configurationDigest;
  const sourceDigest = sha256(inputs.snapshotBytes);
  const validFrom = new Date(inputs.now - 60_000).toISOString();
  const expiresAt = new Date(inputs.now + 20 * 60_000).toISOString();
  const runDeadline = new Date(inputs.now + 10 * 60_000).toISOString();
  const taskDeadline = new Date(inputs.now + 8 * 60_000).toISOString();

  const authorization: Authorization = {
    reference: 'owner-authorized-real-worker',
    authorizedBy: 'fixture-owner',
    validFrom,
    expiresAt,
    targets: [
      { id: REAL_WORKER_TARGET, kind: 'lab', locator: inputs.fixture.origin, digest: configurationDigest, revision: '1' },
      { id: REAL_WORKER_SOURCE_TARGET, kind: 'artifact', locator: REAL_WORKER_SNAPSHOT_FILE, digest: sourceDigest, revision: REAL_WORKER_INPUT_REVISION },
    ],
    exclusions: [],
    allowedActions: ['read', 'analyze', 'local-test'],
  };
  const inputsRecord = [{ id: REAL_WORKER_SOURCE_TARGET, digest: sourceDigest, locator: REAL_WORKER_SNAPSHOT_FILE, revision: REAL_WORKER_INPUT_REVISION }];
  const scope = scopeFor(authorization, [REAL_WORKER_TARGET, REAL_WORKER_SOURCE_TARGET], inputsRecord, configurationDigest);

  const run: RunManifest = {
    schemaVersion: 1,
    runId,
    createdAt: validFrom,
    state: 'created',
    authorization,
    budgets: {
      // [T8/S1] The declared run budget bounds the model spend ledger too; one worst-case hold is taken per
      // live attempt (maxConcurrency is 1 here).
      deadlineAt: runDeadline, maxRequests: 32, maxBytes: 2_000_000, maxToolCalls: 32, maxTokens: runMaxTokens,
      maxCostUsd: 2, maxAttempts: 2, maxTasks: 2, maxDepth: 1, maxConcurrency: 1, reportReserveMs: 30_000,
      targetRequestLimits: { [REAL_WORKER_TARGET]: 16, [REAL_WORKER_SOURCE_TARGET]: 2 },
    },
    requestedRuntime: { adapter, selection: { ...selection }, requiredCapabilities: ['ownsLifecycle'] },
    allowedCapabilities: ['source.analyze', 'http.request'],
  };

  const extensionDigest = sha256(readFileSync(inputs.extensionPath));
  const toolPolicy = {
    mode: 'sandbox-extension' as const,
    extension: { path: inputs.extensionPath, sha256: extensionDigest, approval: 'owner-approved real worker bridge extension' },
    boundaryId: 'real-pi-worker-bridge',
    tools: [...REAL_WORKER_TOOLS],
  };

  const manifest: TaskManifest = {
    schemaVersion: 1,
    runId,
    taskId: REAL_WORKER_TASK_ID,
    dependencyTaskIds: [],
    depth: 0,
    createdAt: validFrom,
    inputRevision: REAL_WORKER_INPUT_REVISION,
    question: {
      text: 'Does the guarded read route of the loopback fixture return the same-tenant item to the approved guest actor, while an owner-approved probe outside every approved destination is denied before dispatch?',
      ifTrue: 'The guarded read route returns the same-tenant item and the out-of-scope probe is denied before any target traffic',
      ifFalse: 'The guarded read route rejects the same-tenant read, or the out-of-scope probe is not denied before dispatch',
    },
    scope,
    skills: ['dynamic-analysis'],
    allowedActions: ['read', 'local-test'],
    requiredCapabilities: ['http.request', 'source.analyze'],
    budgets: { deadlineAt: taskDeadline, maxRequests: 16, maxBytes: 2_000_000, maxToolCalls: 16, maxTokens: 4_000, maxCostUsd: 2, maxAttempts: taskMaxAttempts },
    requestedRuntime: { adapter, selection: { ...selection }, requiredCapabilities: ['ownsLifecycle'] },
    workspace: join(inputs.workspaceRoot, REAL_WORKER_TASK_ID),
    lifecycleState: 'queued',
    packetState: 'draft',
  };

  const tasks: GrantedTask[] = [{ manifest, role: 'worker', toolPolicy, boundaryReceipt: REAL_WORKER_BOUNDARY_RECEIPT }];

  // Owner-approved observations. The worker may only select these ids; inputs, expectations and test metadata
  // stay in this document and are never exposed over the bridge.
  const checks: ObservationCheck[] = [
    {
      checkId: REAL_WORKER_OBSERVATION_BASELINE,
      taskId: REAL_WORKER_TASK_ID,
      observationId: REAL_WORKER_OBSERVATION_BASELINE,
      tool: 'http.request',
      input: { url: `${inputs.fixture.origin}/api/v1/items/i-100?tenant=alpha`, accountId: REAL_WORKER_ACTOR },
      kind: 'baseline',
      classification: 'independently-observed',
      summary: 'Known-good same-tenant read establishes the H2 baseline for the tenant invariant',
      expectation: { type: 'http', status: 200, bodyIncludes: '"tenant":"alpha"' },
      test: { purpose: 'baseline', invariant: REAL_WORKER_CLAIM, originalPolicy: true, targetId: REAL_WORKER_TARGET },
      claim: REAL_WORKER_CLAIM,
      surfaceId: REAL_WORKER_SURFACE,
      actorId: REAL_WORKER_ACTOR,
    },
    {
      checkId: REAL_WORKER_OBSERVATION_SOURCE,
      taskId: REAL_WORKER_TASK_ID,
      observationId: REAL_WORKER_OBSERVATION_SOURCE,
      tool: 'source.analyze',
      input: { paths: [REAL_WORKER_SNAPSHOT_FILE], contains: 'export' },
      kind: 'source',
      classification: 'static-inference',
      summary: 'Lexical route/handler slice of the hashed fixture snapshot for the invariant under test',
      expectation: { type: 'source', contains: 'routes' },
      claim: REAL_WORKER_CLAIM,
      surfaceId: REAL_WORKER_SURFACE,
      actorId: REAL_WORKER_ACTOR,
    },
    {
      checkId: REAL_WORKER_OBSERVATION_DENIED,
      taskId: REAL_WORKER_TASK_ID,
      observationId: REAL_WORKER_OBSERVATION_DENIED,
      tool: 'http.request',
      // Outside every approved target: the controller policy must deny it before any connection is created.
      input: { url: 'http://127.0.0.1:9/not-approved', accountId: REAL_WORKER_ACTOR },
      kind: 'observation',
      classification: 'independently-observed',
      summary: 'Owner-approved probe against an unapproved destination: scope denial must precede any traffic',
      expectation: { type: 'http', status: 200 },
      claim: REAL_WORKER_CLAIM,
      surfaceId: REAL_WORKER_SURFACE,
      actorId: REAL_WORKER_ACTOR,
    },
  ];

  const config: ApplicationConfigWithSpend = {
    schemaVersion: 1,
    mode: 'inert-local-fixture',
    acknowledgement: INERT_FIXTURE_ACKNOWLEDGEMENT,
    roots: {
      state: join(inputs.runRoot, 'state', 'p2o.sqlite'),
      control: inputs.controlRoot,
      workspace: inputs.workspaceRoot,
      vault: inputs.vaultRoot,
      artifacts: {
        'controller-artifacts': join(inputs.runRoot, 'controller-artifacts'),
        'broker-artifacts': join(inputs.runRoot, 'broker-artifacts'),
        'worker-workspaces': inputs.workspaceRoot,
        'input-snapshot': inputs.snapshotRoot,
      },
      workerWriteRoots: [inputs.workspaceRoot],
    },
    run,
    tasks,
    runtime: {
      adapter,
      ...(inputs.herdr ? { herdr: inputs.herdr } : {}),
      selection: { ...selection },
      piBinary: inputs.piBinary,
      piVersion: REAL_WORKER_PI_VERSION,
      gateway: {
        approval: REAL_WORKER_GATEWAY_APPROVAL,
        baseUrl: inputs.gatewayOrigin,
        api: 'openai-completions',
        models: [{
          id: selection.model,
          reasoning: true,
          contextWindow: 32_000,
          // Synthetic provider script includes a full schema/evidence packet (>512 synthetic tokens).
          // Catalog matches the EXISTING 4096 owner ceiling; no run/owner budget is increased.
          maxTokens: 4096,
          thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
        }],
      },
      startupTimeoutMs: 15_000,
      pollMs: 50,
      stopGraceMs: 500,
    },
    sandbox: {
      mode: 'local-fixture',
      acknowledgement: LOCAL_FIXTURE_SANDBOX_ACKNOWLEDGEMENT,
      inputRoot: inputs.snapshotRoot,
      outputRoot: join(inputs.runRoot, 'broker-artifacts'),
      identityDigest: configurationDigest,
    },
    policy: policyScope(inputs, runId, expiresAt),
    checks,
    bridge: {
      socketPath: inputs.socketPath,
      controllerArtifactRootId: 'controller-artifacts',
      brokerArtifactRootId: 'broker-artifacts',
      inertLocalOnly: true,
    },
    interface: { perTargetConcurrency: { [REAL_WORKER_TARGET]: 1, [REAL_WORKER_SOURCE_TARGET]: 1 } },
    // [T8/S1] Optional owner-declared worst-case bounds; enforcement is on either way.
    ...(inputs.spend ? { spend: inputs.spend } : {}),
  };

  return { config, authorization, checks };
}
