import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { type JsonObject, type RunManifest, type TaskManifest, type Authorization, type Scope } from '../../src/contracts/index.js';
import type {
  GrantedTask, ObservationCheck, OwnerGrant, PolicyTemplate, CoveragePlanEntry, FindingPlan,
  VerificationPlan,
} from '../../src/application/index.js';
// [T8/S1] The validated document plus the owner-declared spend bounds (composition-owned type).
import type { ApplicationConfigWithSpend } from '../../src/application/composition.js';
import { type FixtureInstance } from './fixture-server.js';

export const RUN_ID = 'run-loopback-1';
export const TASK_SURFACE_MAP = 'task-surface-map';
export const TASK_HYP_EXPORT = 'task-hyp-export';
export const TASK_HYP_CASE = 'task-hyp-case';
export const TASK_VERIFY_EXPORT = 'task-verify-export';
export const FINDING_EXPORT = 'finding-export-bypass';
export const FINDING_CASE = 'finding-case-normalization';
export const SURFACE_EXPORT = 'api.export';
export const SURFACE_READ = 'api.read';
export const ACTOR_GUEST = 'guest';
export const ACTOR_ANONYMOUS = 'anonymous';
export const TARGET_A = 'lab-fixture-a';
export const TARGET_B = 'lab-fixture-b';
export const TARGET_SOURCE = 'fixture-source';
export const ENVIRONMENT_A = 'lab-fixture-a';
export const ENVIRONMENT_B = 'lab-fixture-b';
export const INPUT_REVISION = 'snapshot-1';
export const SNAPSHOT_FILE = 'fixture-server.ts';

export const CLAIM_EXPORT = 'The export route returns tenant item secrets without enforcing the tenant boundary that the read route enforces.';
export const CLAIM_CASE = 'The guarded read route returns cross-tenant items when the tenant parameter is uppercase.';
export const CLAIM_ANONYMOUS = 'The export route returns tenant secrets to an unauthenticated caller without any approved account.';

export const SELECTION = Object.freeze({ provider: 'inert-fixture', model: 'inert-worker', thinking: 'max' as const });
export const BOUNDARY_RECEIPT = 'inert loopback fixture worker; deterministic scripted steps; no model, no host tools, not hostile-code isolation';
export const RUNTIME_ADAPTER = 'headless';
export const TOOL_POLICY = Object.freeze({
  mode: 'sandbox-extension' as const,
  extension: { path: '', sha256: '', approval: 'owner-approved inert fixture extension' },
  boundaryId: 'inert-fixture-worker-bridge',
  tools: ['p2o_broker', 'p2o_packet'],
});

export interface ScenarioInputs {
  runRoot: string;
  snapshotRoot: string;
  snapshotBytes: Buffer;
  environmentA: FixtureInstance;
  environmentB: FixtureInstance;
  workspaceRoot: string;
  controlRoot: string;
  vaultRoot: string;
  socketPath: string;
  inertWorkerPath: string;
  extensionPath: string;
  /** Real sandbox configuration identity; task/policy/authorization digests must match the broker receipts. */
  configurationDigest: string;
  /** Safe fixture variant (the export route enforces the tenant boundary). */
  exportTenantEnforced?: boolean;
  /** Optional absolute request budget override (regression test for pre-dispatch enforcement). */
  maxRequests?: number;
  /** Optional worker idle window before the packet (pre-dispatch budget regression). */
  probeHoldMs?: number;
  now: number;
}

export interface Scenario {
  config: ApplicationConfigWithSpend;
  ownerGrant: OwnerGrant;
  plans: Map<string, JsonObject>;
  authorization: Authorization;
  checks: ObservationCheck[];
}

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

function policyScope(inputs: ScenarioInputs, configurationDigest: string, expiresAt: string, sourceDigest: string): PolicyTemplate {
  const originA = inputs.environmentA.origin;
  const originB = inputs.environmentB.origin;
  const target = (id: string, origin: string, maxConcurrent: number): PolicyTemplate['targets'][number] => ({
    id,
    origins: [origin],
    pathPrefixes: ['/'],
    allowedCidrs: ['127.0.0.0/8'],
    methods: ['GET', 'HEAD'],
    actions: ['read'],
    accounts: [ACTOR_GUEST],
    limits: { maxRequests: 64, maxBytes: 4_194_304, maxConcurrent, rate: { requests: 32, windowMs: 1_000 } },
  });
  void configurationDigest;
  void sourceDigest;
  return {
    version: 1,
    runId: RUN_ID,
    authorization: { reference: 'owner-authorized-loopback-fixture', approvedBy: 'fixture-owner', expiresAt },
    targets: [target(TARGET_A, originA, 2), target(TARGET_B, originB, 1)],
    exclusions: [],
    accounts: [{ id: ACTOR_GUEST, targetIds: [TARGET_A, TARGET_B], actions: ['read'], expiresAt, kind: 'anonymous' }],
    grantTemplates: [
      { id: 'grant-surface-map', taskId: TASK_SURFACE_MAP, role: 'worker', capabilities: ['source.analyze', 'http.request'], targetIds: [TARGET_A], actions: ['read', 'analyze'], accountIds: [ACTOR_GUEST], expiresAt, maxCalls: 32, maxArtifactBytes: 4_194_304 },
      { id: 'grant-hyp-export', taskId: TASK_HYP_EXPORT, role: 'worker', capabilities: ['source.analyze', 'http.request'], targetIds: [TARGET_A], actions: ['read', 'analyze'], accountIds: [ACTOR_GUEST], expiresAt, maxCalls: 32, maxArtifactBytes: 4_194_304 },
      { id: 'grant-hyp-case', taskId: TASK_HYP_CASE, role: 'worker', capabilities: ['source.analyze', 'http.request'], targetIds: [TARGET_A], actions: ['read', 'analyze'], accountIds: [ACTOR_GUEST], expiresAt, maxCalls: 32, maxArtifactBytes: 4_194_304 },
      { id: 'grant-verify-export', taskId: TASK_VERIFY_EXPORT, role: 'verifier', capabilities: ['source.analyze', 'http.request'], targetIds: [TARGET_B], actions: ['read', 'analyze'], accountIds: [ACTOR_GUEST], expiresAt, maxCalls: 32, maxArtifactBytes: 4_194_304 },
    ],
  };
}

function scopeFor(authorization: Authorization, targetIds: string[], inputs: Scope['inputs'], environmentId: string, configurationDigest: string): Scope {
  return {
    authorizationRef: authorization.reference,
    targetIds,
    actor: { id: ACTOR_GUEST, privileges: ['read'] },
    boundary: 'inert loopback fixture only; no external target and no mutation',
    isolation: 'inert local lab: fresh fixture instance, controller-owned bridge, loopback egress only',
    recovery: 'discard the fixture instance and the private workspace; no host state is modified',
    environmentId,
    configurationDigest,
    inputs,
  };
}

function task(
  authorization: Authorization,
  scope: Scope,
  taskId: string,
  question: TaskManifest['question'],
  skills: string[],
  allowedActions: string[],
  requiredCapabilities: string[],
  deadlineAt: string,
  maxRequests: number,
  workspace: string,
  overrides: Partial<TaskManifest> = {},
): TaskManifest {
  void authorization;
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    taskId,
    dependencyTaskIds: [],
    depth: 0,
    createdAt: new Date().toISOString(),
    inputRevision: INPUT_REVISION,
    question,
    scope,
    skills,
    allowedActions,
    requiredCapabilities,
    budgets: { deadlineAt, maxRequests, maxBytes: 2_000_000, maxToolCalls: 32, maxTokens: 2_000, maxCostUsd: 2, maxAttempts: 2 },
    requestedRuntime: { adapter: RUNTIME_ADAPTER, selection: { ...SELECTION }, requiredCapabilities: ['ownsLifecycle'] },
    workspace,
    lifecycleState: 'queued',
    packetState: 'draft',
    ...overrides,
  };
}

/** Build the complete owner-approved composition document for the local fixture. */
export function buildScenario(inputs: ScenarioInputs): Scenario {
  const configurationDigest = inputs.configurationDigest;
  const sourceDigest = sha256(inputs.snapshotBytes);
  const validFrom = new Date(inputs.now - 60_000).toISOString();
  const expiresAt = new Date(inputs.now + 20 * 60_000).toISOString();
  const runDeadline = new Date(inputs.now + 12 * 60_000).toISOString();
  const taskDeadline = new Date(inputs.now + 10 * 60_000).toISOString();
  const authorization: Authorization = {
    reference: 'owner-authorized-loopback-fixture',
    authorizedBy: 'fixture-owner',
    validFrom,
    expiresAt,
    targets: [
      { id: TARGET_A, kind: 'lab', locator: inputs.environmentA.origin, digest: configurationDigest, revision: '1' },
      { id: TARGET_B, kind: 'lab', locator: inputs.environmentB.origin, digest: configurationDigest, revision: '1' },
      { id: TARGET_SOURCE, kind: 'artifact', locator: SNAPSHOT_FILE, digest: sourceDigest, revision: INPUT_REVISION },
    ],
    exclusions: [],
    allowedActions: ['read', 'analyze', 'local-test'],
  };
  const inputsRecord = [{ id: TARGET_SOURCE, digest: sourceDigest, locator: SNAPSHOT_FILE, revision: INPUT_REVISION }];
  const scopeA = scopeFor(authorization, [TARGET_A, TARGET_SOURCE], inputsRecord, ENVIRONMENT_A, configurationDigest);
  const scopeB = scopeFor(authorization, [TARGET_B, TARGET_SOURCE], inputsRecord, ENVIRONMENT_B, configurationDigest);

  const run: RunManifest = {
    schemaVersion: 1,
    runId: RUN_ID,
    createdAt: validFrom,
    state: 'created',
    authorization,
    budgets: {
      // [T8/S1] Model-spend enforcement is on by default and one worst-case hold is taken per live attempt, so
      // the declared run token/cost budget must cover the authorized concurrency (3): 3 x (8 000 input + 4 096
      // output) fits inside 48 000 tokens. A smaller budget correctly refuses the second concurrent attempt.
      deadlineAt: runDeadline, maxRequests: 128, maxBytes: 8_000_000, maxToolCalls: 128, maxTokens: 48_000,
      maxCostUsd: 10, maxAttempts: 2, maxTasks: 8, maxDepth: 3, maxConcurrency: 3, reportReserveMs: 60_000,
      targetRequestLimits: { [TARGET_A]: 64, [TARGET_B]: 32, [TARGET_SOURCE]: 8 },
    },
    requestedRuntime: { adapter: RUNTIME_ADAPTER, selection: { ...SELECTION }, requiredCapabilities: ['ownsLifecycle'] },
    allowedCapabilities: ['source.analyze', 'http.request'],
  };

  const extensionDigest = sha256(readFileSync(inputs.extensionPath));
  const toolPolicy = { ...TOOL_POLICY, extension: { ...TOOL_POLICY.extension, path: inputs.extensionPath, sha256: extensionDigest } };
  const requestBudget = inputs.maxRequests ?? 32;
  const workspace = (taskId: string): string => join(inputs.workspaceRoot, taskId);
  const mapTask = task(authorization, scopeA, TASK_SURFACE_MAP, {
    text: 'Which HTTP surfaces of the loopback fixture expose tenant-scoped item data, and which actor can reach them?',
    ifTrue: 'The fixture exposes a read surface and a separate export surface to the guest actor',
    ifFalse: 'The fixture exposes only the guarded read surface to the guest actor',
  }, ['attack-surface-mapping'], ['read', 'analyze', 'local-test'], ['http.request', 'source.analyze'], taskDeadline, requestBudget, workspace(TASK_SURFACE_MAP));
  const hypExport = task(authorization, scopeA, TASK_HYP_EXPORT, {
    text: 'Does the export surface enforce the same tenant boundary as the guarded read surface?',
    ifTrue: 'The export surface rejects a cross-tenant request',
    ifFalse: 'The export surface serializes another tenant secret for the guest actor',
  }, ['dynamic-analysis', 'authorization-auditing'], ['read', 'local-test'], ['http.request', 'source.analyze'], taskDeadline, requestBudget, workspace(TASK_HYP_EXPORT), {
    parentTaskId: TASK_SURFACE_MAP, dependencyTaskIds: [TASK_SURFACE_MAP], depth: 1,
  });
  const hypCase = task(authorization, scopeA, TASK_HYP_CASE, {
    text: 'Does the guarded read surface treat an uppercase tenant parameter as cross-tenant access?',
    ifTrue: 'An uppercase tenant parameter is normalized and accepted for another tenant',
    ifFalse: 'An uppercase tenant parameter is rejected with the same guard as an exact mismatch',
  }, ['dynamic-analysis', 'parser-differential-auditing'], ['read', 'local-test'], ['http.request', 'source.analyze'], taskDeadline, requestBudget, workspace(TASK_HYP_CASE), {
    parentTaskId: TASK_SURFACE_MAP, dependencyTaskIds: [TASK_SURFACE_MAP], depth: 1,
  });
  const verifyTask = task(authorization, scopeB, TASK_VERIFY_EXPORT, {
    text: 'Does an independent replay in a fresh fixture environment reproduce the cross-tenant export disclosure under the original policy?',
    ifTrue: 'The fresh environment rejects the cross-tenant export',
    ifFalse: 'The fresh environment reproduces the cross-tenant export disclosure',
  }, ['dynamic-analysis', 'exploitability-assessment'], ['read'], ['http.request', 'source.analyze'], taskDeadline, requestBudget, workspace(TASK_VERIFY_EXPORT), {
    parentTaskId: TASK_HYP_EXPORT, dependencyTaskIds: [TASK_HYP_EXPORT], depth: 2,
  });

  const tasks: GrantedTask[] = [
    { manifest: mapTask, role: 'worker', toolPolicy, boundaryReceipt: BOUNDARY_RECEIPT },
    { manifest: hypExport, role: 'worker', toolPolicy, boundaryReceipt: BOUNDARY_RECEIPT },
    { manifest: hypCase, role: 'worker', toolPolicy, boundaryReceipt: BOUNDARY_RECEIPT },
    { manifest: verifyTask, role: 'verifier', toolPolicy, boundaryReceipt: BOUNDARY_RECEIPT },
  ];

  const ownerGrant: OwnerGrant = {
    version: 1,
    // The owner approves two concurrent readers of the read-only source snapshot: the offline artifact target has
    // no target traffic, and the supervisor's per-target admission requires capacity for every target in scope, so
    // a limit of 1 here would serialize the two independent hypothesis tasks.
    runs: [{ manifest: run, mode: 'managed', perTargetConcurrency: { [TARGET_A]: 2, [TARGET_B]: 1, [TARGET_SOURCE]: 2 } }],
    tasks: tasks.map(entry => ({
      proposal: { manifest: entry.manifest, role: entry.role, ...(entry.exclusiveKeys ? { exclusiveKeys: entry.exclusiveKeys } : {}) },
      toolPolicy,
      boundaryReceipt: 'inert loopback fixture worker; deterministic scripted steps; no model, no host tools, not hostile-code isolation',
    })),
  };

  const originA = inputs.environmentA.origin;
  const originB = inputs.environmentB.origin;
  // Owner-approved observation checks: the controller executes these exact inputs and evaluates the
  // expectations over the collected bytes. Workers can only select an approved observationId.
  const checks: ObservationCheck[] = [
    {
      checkId: 'map-source',
      taskId: TASK_SURFACE_MAP,
      observationId: 'map-source',
      tool: 'source.analyze',
      input: { paths: [SNAPSHOT_FILE], contains: 'export' },
      kind: 'source',
      classification: 'static-inference',
      summary: 'Lexical route and handler map of the hashed fixture source snapshot',
      expectation: { type: 'source', contains: 'routes' },
      surfaceId: SURFACE_EXPORT,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'map-health',
      taskId: TASK_SURFACE_MAP,
      observationId: 'map-health',
      tool: 'http.request',
      input: { url: `${originA}/healthz`, accountId: ACTOR_GUEST },
      kind: 'observation',
      classification: 'independently-observed',
      summary: 'Fixture identity and configuration digest observation',
      expectation: { type: 'http', status: 200, bodyIncludes: '"ok":true' },
      surfaceId: SURFACE_EXPORT,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'map-read-ok',
      taskId: TASK_SURFACE_MAP,
      observationId: 'map-read-ok',
      tool: 'http.request',
      input: { url: `${originA}/api/v1/items/i-100?tenant=alpha`, accountId: ACTOR_GUEST },
      kind: 'observation',
      classification: 'independently-observed',
      summary: 'Same-tenant read returns item metadata to the guest actor',
      expectation: { type: 'http', status: 200, bodyIncludes: '"tenant":"alpha"' },
      surfaceId: SURFACE_READ,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'map-export-own',
      taskId: TASK_SURFACE_MAP,
      observationId: 'map-export-own',
      tool: 'http.request',
      input: { url: `${originA}/api/v1/export?item=i-100&tenant=alpha`, accountId: ACTOR_GUEST },
      kind: 'observation',
      classification: 'independently-observed',
      summary: 'Benign same-tenant export request reaches the export handler',
      expectation: { type: 'http', status: 200, bodyIncludes: '"exported":true' },
      surfaceId: SURFACE_EXPORT,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-export-source',
      taskId: TASK_HYP_EXPORT,
      observationId: 'hyp-export-source',
      tool: 'source.analyze',
      input: { paths: [SNAPSHOT_FILE], contains: 'tenant' },
      kind: 'source',
      classification: 'static-inference',
      summary: 'Source slice for the guarded read and export handlers',
      expectation: { type: 'source', contains: 'routes' },
      claim: CLAIM_EXPORT,
      surfaceId: SURFACE_EXPORT,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-export-baseline',
      taskId: TASK_HYP_EXPORT,
      observationId: 'hyp-export-baseline',
      tool: 'http.request',
      // Bounded owner-approved server-side delay: two hypothesis workers overlap inside the fixture, which the
      // overlap regression asserts through the fixture's maxConcurrent and the owned process windows.
      input: { url: `${originA}/api/v1/items/i-100?tenant=alpha&delayMs=250`, accountId: ACTOR_GUEST },
      kind: 'baseline',
      classification: 'independently-observed',
      summary: 'Known-good same-tenant read establishes the baseline for the tenant invariant',
      expectation: { type: 'http', status: 200, bodyIncludes: '"tenant":"alpha"' },
      test: { purpose: 'baseline', invariant: CLAIM_EXPORT, originalPolicy: true, targetId: TARGET_A },
      surfaceId: SURFACE_EXPORT,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-export-control',
      taskId: TASK_HYP_EXPORT,
      observationId: 'hyp-export-control',
      tool: 'http.request',
      input: { url: `${originA}/api/v1/items/i-100?tenant=beta&delayMs=250`, accountId: ACTOR_GUEST },
      kind: 'negative-control',
      classification: 'independently-observed',
      summary: 'Guarded read rejects the cross-tenant request under the original policy',
      expectation: { type: 'http', status: 403, bodyIncludes: 'tenant_mismatch' },
      test: { purpose: 'negative-control', invariant: CLAIM_EXPORT, originalPolicy: true, targetId: TARGET_A },
      surfaceId: SURFACE_EXPORT,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-export-reproduction',
      taskId: TASK_HYP_EXPORT,
      observationId: 'hyp-export-reproduction',
      tool: 'http.request',
      input: { url: `${originA}/api/v1/export?item=i-100&tenant=beta`, accountId: ACTOR_GUEST },
      kind: 'reproduction',
      classification: 'independently-observed',
      summary: 'Cross-tenant export returns the other tenant value to the guest actor',
      expectation: { type: 'http', status: 200, bodyIncludes: '"value":"alpha-tenant-value"' },
      test: { purpose: 'reproduction', invariant: CLAIM_EXPORT, originalPolicy: true, targetId: TARGET_A },
      surfaceId: SURFACE_EXPORT,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-case-source',
      taskId: TASK_HYP_CASE,
      observationId: 'hyp-case-source',
      tool: 'source.analyze',
      input: { paths: [SNAPSHOT_FILE], contains: 'tenant' },
      kind: 'source',
      classification: 'static-inference',
      summary: 'Source slice for the exact-match tenant guard',
      expectation: { type: 'source', contains: 'routes' },
      claim: CLAIM_CASE,
      surfaceId: SURFACE_READ,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-case-baseline',
      taskId: TASK_HYP_CASE,
      observationId: 'hyp-case-baseline',
      tool: 'http.request',
      input: { url: `${originA}/api/v1/items/i-200?tenant=beta&delayMs=250`, accountId: ACTOR_GUEST },
      kind: 'baseline',
      classification: 'independently-observed',
      summary: 'Known-good same-tenant read for the second seeded tenant',
      expectation: { type: 'http', status: 200, bodyIncludes: '"tenant":"beta"' },
      test: { purpose: 'baseline', invariant: CLAIM_CASE, originalPolicy: true, targetId: TARGET_A },
      surfaceId: SURFACE_READ,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-case-control',
      taskId: TASK_HYP_CASE,
      observationId: 'hyp-case-control',
      tool: 'http.request',
      input: { url: `${originA}/api/v1/items/i-100?tenant=BETA&delayMs=250`, accountId: ACTOR_GUEST },
      kind: 'negative-control',
      classification: 'independently-observed',
      summary: 'Uppercase cross-tenant read is rejected by the original-policy guard',
      expectation: { type: 'http', status: 403, bodyIncludes: 'tenant_mismatch' },
      test: { purpose: 'negative-control', invariant: CLAIM_CASE, originalPolicy: true, targetId: TARGET_A },
      surfaceId: SURFACE_READ,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-case-inconclusive',
      taskId: TASK_HYP_CASE,
      observationId: 'hyp-case-inconclusive',
      tool: 'http.request',
      input: { url: `${originA}/healthz`, accountId: ACTOR_GUEST },
      kind: 'observation',
      // Deliberately not an HTTP expectation: over the collected HTTP bytes the controller can only classify this
      // as inconclusive, and the worker plan hint 'passed' is never consulted.
      expectation: { type: 'source', contains: '"ok":true' },
      test: { purpose: 'negative-control', invariant: CLAIM_CASE, originalPolicy: true, targetId: TARGET_A },
      classification: 'independently-observed',
      summary: 'Owner-approved check whose expectation cannot be evaluated over the collected HTTP bytes',
      claim: CLAIM_CASE,
      surfaceId: SURFACE_READ,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'denied-probe',
      taskId: TASK_HYP_CASE,
      observationId: 'denied-probe',
      tool: 'http.request',
      // Not the loopback fixture: outside every approved target, so the policy must deny before any dispatch.
      // The pre-dispatch budget regression selects this observation directly while the attempt is live.
      input: { url: 'http://127.0.0.1:9/not-an-approved-destination', accountId: ACTOR_GUEST },
      kind: 'observation',
      classification: 'independently-observed',
      summary: 'Owner-approved probe against an unapproved destination: scope denial must precede any traffic',
      expectation: { type: 'http', status: 200 },
      surfaceId: SURFACE_READ,
      actorId: ACTOR_GUEST,
    },
    {
      checkId: 'verify-export-source',
      taskId: TASK_VERIFY_EXPORT,
      observationId: 'verify-export-source',
      tool: 'source.analyze',
      input: { paths: [SNAPSHOT_FILE], contains: 'tenant' },
      kind: 'source',
      classification: 'static-inference',
      summary: 'Verifier source slice for the export tenant invariant',
      expectation: { type: 'source', contains: 'routes' },
      claim: CLAIM_EXPORT,
      surfaceId: SURFACE_EXPORT,
      actorId: ACTOR_GUEST,
    },
  ];

  const plans = new Map<string, JsonObject>();
  plans.set(TASK_SURFACE_MAP, {
    taskIdHint: TASK_SURFACE_MAP,
    step: 'mapping',
    observations: [
      { observationId: 'map-source', name: 'source' },
      { observationId: 'map-health', name: 'health' },
      { observationId: 'map-read-ok', name: 'read-ok' },
      { observationId: 'map-export-own', name: 'export-own' },
    ],
    packet: {
      contract: 'H1',
      schemaVersion: 1, packetId: 'packet-surface-map', runId: '$runId', taskId: '$taskId', attemptId: '$attemptId',
      producer: { id: '$producerId', role: 'worker' }, consumer: { id: 'p2o-reviewer', role: 'reviewer' },
      createdAt: '$observedAt', inputRevision: '$inputRevision', scope: '$scope', question: '$question',
      classification: 'independently-observed', outcome: 'supported',
      evidenceIds: '$evidenceIds:source,health,read-ok,export-own',
      limits: { negativeControlEvidenceIds: [], failedAssumptions: [], untestedScope: ['unmapped parameter combinations', 'non-GET methods'], risks: [], reproduction: { successes: 1, attempts: 1 } },
      nextAction: { action: 'admit a bounded hypothesis task for the export surface tenant check', stopCondition: 'stop after one tenant-differential check per surface', allowedActions: ['read', 'analyze'] },
      requestedRuntime: '$requestedRuntime', observedRuntime: '$runtime',
      details: {
        architecture: 'Single-process loopback HTTP fixture with a guarded read route and an export route.',
        unresolvedRoutes: ['no OpenAPI document was published by the fixture'],
        interfaces: [
          {
            surfaceId: SURFACE_READ, registration: 'GET /api/v1/items/{id}', handler: 'guarded item read handler',
            actorId: ACTOR_GUEST, gate: 'exact tenant parameter equality with the stored item tenant',
            processIdentity: 'loopback fixture process', formats: ['json'], benignOperations: ['read own-tenant item metadata'],
            priority: 1, priorityReason: 'Direct tenant-scoped read surface reachable by the least-privilege guest actor',
            evidenceIds: ['$evidence:read-ok', '$evidence:source'], reachability: 'observed',
            proposedCheck: 'Request another tenant item with the same actor and compare the guard response',
          },
          {
            surfaceId: SURFACE_EXPORT, registration: 'GET /api/v1/export?item={id}', handler: 'bulk export handler',
            actorId: ACTOR_GUEST, gate: 'no tenant gate observed on a same-tenant export request',
            processIdentity: 'loopback fixture process', formats: ['json'], benignOperations: ['export own-tenant item'],
            priority: 2, priorityReason: 'Separate export handler serializes tenant secrets and repeats the tenant decision',
            evidenceIds: ['$evidence:export-own', '$evidence:source'], reachability: 'observed',
            proposedCheck: 'Export a cross-tenant item with the guest actor and compare the observed policy',
          },
        ],
      },
    },
  } as unknown as JsonObject);

  plans.set(TASK_HYP_EXPORT, {
    taskIdHint: TASK_HYP_EXPORT,
    step: 'hypothesis',
    observations: [
      { observationId: 'hyp-export-source', name: 'source' },
      // Worker-side hint prose only: the controller never reads it, and the regression asserts that the
      // classification derived from the collected bytes can disagree with it.
      { observationId: 'hyp-export-baseline', name: 'baseline', hint: 'failed' },
      { observationId: 'hyp-export-control', name: 'control' },
      { observationId: 'hyp-export-reproduction', name: 'probe', hint: 'passed' },
    ],
    packet: {
      contract: 'H2',
      schemaVersion: 1, packetId: 'packet-hyp-export', runId: '$runId', taskId: '$taskId', attemptId: '$attemptId',
      producer: { id: '$producerId', role: 'worker' }, consumer: { id: 'p2o-reviewer', role: 'reviewer' },
      createdAt: '$observedAt', inputRevision: '$inputRevision', scope: '$scope', question: '$question',
      classification: 'independently-observed', outcome: 'supported',
      evidenceIds: '$evidenceIds:source,baseline,probe',
      limits: {
        negativeControlEvidenceIds: ['$evidence:control'], failedAssumptions: [], risks: [],
        untestedScope: ['administrative or role-scoped export paths', 'tenants beyond the two seeded fixtures', 'non-GET export variants'],
        reproduction: { successes: 1, attempts: 1 },
      },
      nextAction: { action: 'independently replay the bounded export check in a fresh fixture environment', stopCondition: 'stop after one baseline/control/probe set on the fresh instance', allowedActions: ['read'] },
      requestedRuntime: '$requestedRuntime', observedRuntime: '$runtime',
      details: {
        minimalSlice: 'GET /api/v1/export?item=i-100 with tenant=beta and the approved guest account',
        invariant: CLAIM_EXPORT,
        controllableFields: ['item parameter', 'tenant parameter', 'approved account'],
        constraints: ['loopback fixture only', 'read-only HTTP requests', 'no mutation of fixture state'],
        unknown: 'whether the export handler consults the tenant parameter before serializing the record',
        predictions: {
          ifTrue: 'The export route rejects the cross-tenant request', ifFalse: 'The export route serializes the other tenant secret',
          observableIfTrue: 'HTTP 403 with a tenant mismatch error', observableIfFalse: 'HTTP 200 whose body contains the other tenant value',
        },
        observationPoints: ['HTTP status and JSON body of the export response'],
        instrumentation: [],
        prerequisites: ['fixture listening on 127.0.0.1', 'items i-100 (alpha) and i-200 (beta) seeded', 'guest account approved for read'],
        prerequisitesKnown: true,
        baseline: { status: 'observed', evidenceIds: ['$evidence:baseline'] },
        lab: { safety: 'inert loopback fixture; no external target and no mutation', isolation: '$isolation', authorized: true },
        modifiedBuild: false,
      },
    },
  } as unknown as JsonObject);

  plans.set(TASK_HYP_CASE, {
    taskIdHint: TASK_HYP_CASE,
    step: 'hypothesis',
    // Optional bounded idle window after the observations; the pre-dispatch budget regression uses it to measure
    // one denied probe against a quiet owned attempt that is still durably running.
    ...(typeof inputs.probeHoldMs === 'number' && inputs.probeHoldMs > 0 ? { holdBeforePacketMs: inputs.probeHoldMs } : {}),
    observations: [
      { observationId: 'hyp-case-source', name: 'source' },
      { observationId: 'hyp-case-baseline', name: 'baseline', hint: 'failed' },
      { observationId: 'hyp-case-control', name: 'control' },
      { observationId: 'hyp-case-inconclusive', name: 'inconclusive', hint: 'passed' },
    ],
    packet: {
      contract: 'H2',
      schemaVersion: 1, packetId: 'packet-hyp-case', runId: '$runId', taskId: '$taskId', attemptId: '$attemptId',
      producer: { id: '$producerId', role: 'worker' }, consumer: { id: 'p2o-reviewer', role: 'reviewer' },
      createdAt: '$observedAt', inputRevision: '$inputRevision', scope: '$scope', question: '$question',
      classification: 'independently-observed', outcome: 'supported',
      evidenceIds: '$evidenceIds:source,baseline,control',
      limits: {
        negativeControlEvidenceIds: ['$evidence:control'], failedAssumptions: ['assumed the guard compares the raw parameter'], risks: [],
        untestedScope: ['Unicode or percent-encoded tenant spellings', 'other parameter encodings', 'non-GET methods'],
        reproduction: { successes: 1, attempts: 1 },
      },
      nextAction: { action: 'retain the guard behaviour as ruled out for the exact-match claim', stopCondition: 'stop after one baseline/control pair', allowedActions: ['read'] },
      requestedRuntime: '$requestedRuntime', observedRuntime: '$runtime',
      details: {
        minimalSlice: 'GET /api/v1/items/i-100 with tenant=BETA and the approved guest account',
        invariant: CLAIM_CASE,
        controllableFields: ['tenant parameter spelling', 'item parameter'],
        constraints: ['loopback fixture only', 'read-only HTTP requests'],
        unknown: 'whether the guard normalizes case before comparison',
        predictions: {
          ifTrue: 'The uppercase tenant parameter is accepted for the other tenant', ifFalse: 'The uppercase tenant parameter is rejected',
          observableIfTrue: 'HTTP 200 whose body contains the other tenant item', observableIfFalse: 'HTTP 403 with a tenant mismatch error',
        },
        observationPoints: ['HTTP status and JSON body of the guarded read response'],
        instrumentation: [],
        prerequisites: ['fixture listening on 127.0.0.1', 'items i-100 (alpha) and i-200 (beta) seeded', 'guest account approved for read'],
        prerequisitesKnown: true,
        baseline: { status: 'observed', evidenceIds: ['$evidence:baseline'] },
        lab: { safety: 'inert loopback fixture; no external target and no mutation', isolation: '$isolation', authorized: true },
        modifiedBuild: false,
      },
    },
  } as unknown as JsonObject);

  const recipe: Record<string, unknown> = {
    recipeId: 'replay-export-tenant', fixtureId: 'loopback-tenant-lab-b', targetId: TARGET_B,
    invariant: CLAIM_EXPORT, inputDigests: [sourceDigest],
    baseline: { input: { url: `${originB}/api/v1/items/i-100?tenant=alpha`, accountId: ACTOR_GUEST }, expected: { status: 200, bodyIncludes: '"tenant":"alpha"' } },
    negativeControl: { input: { url: `${originB}/api/v1/items/i-100?tenant=beta`, accountId: ACTOR_GUEST }, expected: { status: 403, bodyIncludes: 'tenant_mismatch' } },
    probe: {
      input: { url: `${originB}/api/v1/export?item=i-100&tenant=beta`, accountId: ACTOR_GUEST },
      violation: { status: 200, bodyIncludes: '"value":"alpha-tenant-value"' }, safe: { status: 403 },
    },
  };
  plans.set(TASK_VERIFY_EXPORT, {
    taskIdHint: TASK_VERIFY_EXPORT,
    step: 'verifier',
    observations: [
      { observationId: 'verify-export-source', name: 'source' },
    ],
    verify: { findingId: FINDING_EXPORT },
    packet: {
      contract: 'H2',
      schemaVersion: 1, packetId: 'packet-verify-export', runId: '$runId', taskId: '$taskId', attemptId: '$attemptId',
      producer: { id: '$producerId', role: 'verifier' }, consumer: { id: 'p2o-reviewer', role: 'reviewer' },
      createdAt: '$observedAt', inputRevision: '$inputRevision', scope: '$scope', question: '$question',
      classification: 'independently-observed', outcome: 'supported',
      evidenceIds: '$evidenceIds:source,verifier-1,verifier-3',
      limits: {
        negativeControlEvidenceIds: ['$evidence:verifier-2'], failedAssumptions: [], risks: [],
        untestedScope: ['administrative export paths', 'other tenants and actors'],
        reproduction: { successes: 1, attempts: 1 },
      },
      nextAction: { action: 'report the independently reproduced export disclosure and its bounds', stopCondition: 'stop after the single bounded replay', allowedActions: ['read'] },
      requestedRuntime: '$requestedRuntime', observedRuntime: '$runtime',
      details: {
        minimalSlice: 'GET /api/v1/export?item=i-100 with tenant=beta in a freshly created fixture environment',
        invariant: CLAIM_EXPORT,
        controllableFields: ['item parameter', 'tenant parameter'],
        constraints: ['fresh loopback fixture environment', 'read-only HTTP requests'],
        unknown: 'whether the defect depends on fixture instance state',
        predictions: {
          ifTrue: 'The fresh environment rejects the cross-tenant export', ifFalse: 'The fresh environment reproduces the disclosure',
          observableIfTrue: 'HTTP 403 with a tenant mismatch error', observableIfFalse: 'HTTP 200 whose body contains the other tenant value',
        },
        observationPoints: ['HTTP status and JSON body in the fresh environment'],
        instrumentation: [],
        prerequisites: ['fresh fixture instance qualified by health response digest', 'guest account approved for read'],
        prerequisitesKnown: true,
        baseline: { status: 'observed', evidenceIds: ['$evidence:verifier-1'] },
        lab: { safety: 'fresh inert loopback fixture; no external target and no mutation', isolation: '$isolation', authorized: true },
        modifiedBuild: false,
      },
    },
  } as unknown as JsonObject);

  const configurationDigestForRun = configurationDigest;
  const findings: FindingPlan[] = [
    {
      findingId: FINDING_EXPORT, taskId: TASK_HYP_EXPORT, title: 'Cross-tenant export discloses another tenant value',
      claim: CLAIM_EXPORT, state: 'reproduced', classification: 'independently-observed',
      limitations: ['Bounded to the loopback fixture, the guest actor and the two seeded tenants.', 'No administrative or role-scoped export path was tested.'],
      impact: 'Any actor able to reach the export route can read another tenant value without a tenant match.',
    },
    {
      findingId: FINDING_CASE, taskId: TASK_HYP_CASE, title: 'Uppercase tenant parameter does not bypass the read guard',
      claim: CLAIM_CASE, state: 'rejected', classification: 'independently-observed',
      limitations: ['The exact-match guard rejected the tested uppercase spelling; other encodings remain untested.'],
    },
  ];
  const verification: VerificationPlan[] = [
    { verifierTaskId: TASK_VERIFY_EXPORT, producerTaskId: TASK_HYP_EXPORT, findingId: FINDING_EXPORT, recipe: recipe as unknown as VerificationPlan['recipe'], maxMs: 15_000 },
  ];
  const coverage: CoveragePlanEntry[] = [
    { surfaceId: SURFACE_EXPORT, actorId: ACTOR_GUEST, question: CLAIM_EXPORT, taskId: TASK_HYP_EXPORT, state: 'tested', basis: 'reviewer-validated', reason: 'Reproduced by the producing attempt and independently replayed in a fresh fixture environment under the original policy.' },
    { surfaceId: SURFACE_READ, actorId: ACTOR_GUEST, question: CLAIM_CASE, taskId: TASK_HYP_CASE, state: 'ruled-out', basis: 'reviewer-validated', reason: 'Uppercase cross-tenant read returned the guard rejection under the original policy.' },
    { surfaceId: SURFACE_EXPORT, actorId: ACTOR_ANONYMOUS, question: CLAIM_ANONYMOUS, state: 'untested', basis: 'worker-asserted', reason: 'No task was admitted for an unauthenticated actor; the gap is retained instead of being marked tested.' },
  ];

  const config: ApplicationConfigWithSpend = {
    schemaVersion: 1,
    mode: 'inert-local-fixture',
    acknowledgement: 'inert-inside-marker-no-hostile-code-isolation',
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
      adapter: RUNTIME_ADAPTER,
      selection: { ...SELECTION },
      piBinary: inputs.inertWorkerPath,
      piVersion: '1.0.0',
      gateway: { approval: 'inert-gateway-never-called', baseUrl: 'http://127.0.0.1:9/', api: 'openai-completions', models: [{ id: SELECTION.model }] },
      startupTimeoutMs: 10_000,
      pollMs: 50,
      stopGraceMs: 200,
    },
    sandbox: {
      mode: 'local-fixture',
      acknowledgement: 'local-fixtures-only-not-hostile-code-isolation',
      inputRoot: inputs.snapshotRoot,
      outputRoot: join(inputs.runRoot, 'broker-artifacts'),
      identityDigest: inputs.configurationDigest,
    },
    policy: policyScope(inputs, configurationDigestForRun, expiresAt, sourceDigest),
    checks,
    bridge: {
      socketPath: inputs.socketPath,
      controllerArtifactRootId: 'controller-artifacts',
      brokerArtifactRootId: 'broker-artifacts',
      inertLocalOnly: true,
    },
    reporting: { coverage, findings, verification },
    interface: { perTargetConcurrency: { [TARGET_A]: 2, [TARGET_B]: 1, [TARGET_SOURCE]: 2 } },
    // [T8/S1] Owner-declared worst-case bounds for one provider request. Enforcement itself is not optional:
    // the ledger is built from the run budgets above even without this field. These bounds keep each
    // concurrent attempt's hold inside the declared run budget.
    spend: { inputTokensUpperBound: 8_000, maxOutputTokens: 4_096 },
  };

  // Attach the deterministic fixture plans to the approved tasks the composition launches.
  for (const task of config.tasks) {
    const plan = plans.get(task.manifest.taskId);
    if (plan) (task as { workerPlan?: JsonObject }).workerPlan = plan;
  }
  return { config, ownerGrant, plans, authorization, checks };
}


