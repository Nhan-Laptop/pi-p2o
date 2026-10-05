// Owner-approved composition document for the live vertical slice.
//
// This is the owner's document, not a fixture: the owner names the loopback lab targets, the approved
// accounts, the exact observation inputs the workers may select, the spend/deadline bounds, the findings
// and the independent-replay recipes. Everything the live model may do comes from here; the model supplies
// only observationIds and packet prose.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  handoffSchema, type Authorization, type JsonObject, type RunManifest, type Scope, type TaskManifest,
} from '../../src/contracts/index.js';
import type {
  CoveragePlanEntry, FindingPlan, GrantedTask, ObservationCheck, OwnerGrant as OwnerGrantDocument,
  PolicyTemplate, VerificationPlan,
} from '../../src/application/index.js';
import type { ApplicationConfigWithSpend } from '../../src/application/composition.js';
import type { ContainerSandboxOptions } from '../../src/tools/index.js';
import type { LabInstance } from './types.js';
import { PINNED_MODEL_PRICES, modelPriceKey } from '../../src/policy/index.js';

// --------------------------------------------------------------------------------------------- identity

export const SURFACE_HEALTH = 'api.health';
export const SURFACE_READ = 'api.read';
export const SURFACE_EXPORT = 'api.export';

export const ACTOR_GUEST = 'acct-guest';
export const ACTOR_ADMIN = 'acct-admin';
/** Environment B is a separate lab instance with its own seeded member account identity. */
export const ACTOR_GUEST_B = 'acct-guest-b';
export const ACTOR_ANONYMOUS = 'anonymous';

export const TARGET_A = 'lab-live-a';
export const TARGET_B = 'lab-live-b';
export const TARGET_SOURCE = 'live-lab-source';
export const ENVIRONMENT_A = 'lab-live-a';
export const ENVIRONMENT_B = 'lab-live-b';
export const INPUT_REVISION = 'snapshot-1';
export const SNAPSHOT_FILE = 'lab-server.mjs';

export const TASK_SURFACE_MAP = 'task-surface-map';
export const TASK_HYP_IDOR = 'task-hyp-idor';
export const TASK_HYP_EXPORT = 'task-hyp-export';
export const TASK_VERIFY = 'task-verify-replay';

export const FINDING_IDOR = 'finding-idor-client-tenant-parameter';
export const FINDING_EXPORT = 'finding-export-missing-authorization';

/** The two claims the owner approved for testing. The replays bind to these exact strings. */
export const CLAIM_IDOR = 'The item read route authorizes on the client-supplied tenant parameter instead of the authenticated session tenant, so the alpha member reads the beta tenant item.';
export const CLAIM_EXPORT = 'The export route serializes any tenant item secret to an authenticated member because it enforces neither the documented admin role nor the tenant boundary.';
export const CLAIM_ANONYMOUS = 'The export route and the item read route are reachable by an unauthenticated caller.';

export const RECIPE_IDOR = 'replay-idor-client-tenant-parameter';
export const RECIPE_EXPORT = 'replay-export-missing-authorization';

/** The one pinned live selection. The pinned price catalog must price this exact key (fail-closed). */
export const LIVE_SELECTION = Object.freeze({ provider: 'deepseek', model: 'deepseek-flash', thinking: 'low' as const });
export const LIVE_UPSTREAM_BASE_URL = 'https://api.deepseek.com';
export const LIVE_API = 'openai-completions' as const;
export const LIVE_PI_VERSION = '1.0.0';
export const LIVE_GATEWAY_APPROVAL = 'live-lab-owner-approved-deepseek-flash-upstream';

/**
 * Provisioned model identity for the controller gateway. `thinkingLevelMap.low` is what makes the requested
 * `low` level observable on the wire (`reasoning_effort: "low"`), which the gateway attests; `maxTokens` is
 * deliberately bounded well below the model maximum so one turn cannot consume the run's spend budget.
 */
export const LIVE_GATEWAY_MODELS = Object.freeze([{
  id: LIVE_SELECTION.model,
  reasoning: true,
  contextWindow: 1_000_000,
  maxTokens: 8_192,
  thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
}]);

export const RUN_MAX_TOKENS = 400_000;
export const RUN_MAX_COST_USD = 1;
export const RUN_DEADLINE_MS = 24 * 60_000;
export const TASK_DEADLINE_MS = 18 * 60_000;
export const AUTHORIZATION_WINDOW_MS = 45 * 60_000;

const WORKER_TOOLS = ['p2o_context', 'p2o_broker', 'p2o_authoring', 'p2o_packet'] as const;
const VERIFIER_TOOLS = ['p2o_context', 'p2o_broker', 'p2o_authoring', 'p2o_verify', 'p2o_packet'] as const;

export const BOUNDARY_RECEIPT = 'real pinned pi worker launched by the managed headless runtime; only the pinned bridge extension tools are exposed; all target traffic is brokered through the owner policy; the execution sandbox is the pinned offline container pack (shared kernel, not hostile-code isolation)';

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

// --------------------------------------------------------------------------------------------- policy

function policyScope(runId: string, input: { authorization: Authorization; originA: string; originB: string; expiresAt: string }): PolicyTemplate {
  const target = (id: string, origin: string, accounts: string[], maxConcurrent: number) => ({
    id,
    origins: [origin],
    pathPrefixes: ['/'],
    allowedCidrs: ['127.0.0.0/8'],
    methods: ['GET', 'HEAD'],
    actions: ['read'] as const,
    accounts,
    limits: { maxRequests: 48, maxBytes: 4_194_304, maxConcurrent, rate: { requests: 32, windowMs: 1_000 } },
  });
  return {
    version: 1,
    runId,
    authorization: { reference: input.authorization.reference, approvedBy: input.authorization.authorizedBy, expiresAt: input.expiresAt },
    targets: [
      { ...target(TARGET_A, input.originA, [ACTOR_GUEST, ACTOR_ADMIN], 4), actions: ['read'] },
      { ...target(TARGET_B, input.originB, [ACTOR_GUEST_B], 1), actions: ['read'] },
    ],
    exclusions: [],
    accounts: [
      // Credential-tier accounts: the broker resolves the lab session token at dispatch from the owner's
      // in-memory store and injects the header; the token never reaches the worker, the policy or a receipt.
      { id: ACTOR_GUEST, targetIds: [TARGET_A], actions: ['read'], expiresAt: input.expiresAt, kind: 'credential' },
      { id: ACTOR_ADMIN, targetIds: [TARGET_A], actions: ['read'], expiresAt: input.expiresAt, kind: 'credential' },
      { id: ACTOR_GUEST_B, targetIds: [TARGET_B], actions: ['read'], expiresAt: input.expiresAt, kind: 'credential' },
    ],
    grantTemplates: [
      { id: 'grant-surface-map', taskId: TASK_SURFACE_MAP, role: 'worker', capabilities: ['source.analyze', 'http.request'], targetIds: [TARGET_A], actions: ['read', 'analyze'], accountIds: [ACTOR_GUEST, ACTOR_ADMIN], expiresAt: input.expiresAt, maxCalls: 24, maxArtifactBytes: 4_194_304 },
      { id: 'grant-hyp-idor', taskId: TASK_HYP_IDOR, role: 'worker', capabilities: ['source.analyze', 'http.request'], targetIds: [TARGET_A], actions: ['read', 'analyze'], accountIds: [ACTOR_GUEST], expiresAt: input.expiresAt, maxCalls: 16, maxArtifactBytes: 4_194_304 },
      { id: 'grant-hyp-export', taskId: TASK_HYP_EXPORT, role: 'worker', capabilities: ['source.analyze', 'http.request'], targetIds: [TARGET_A], actions: ['read', 'analyze'], accountIds: [ACTOR_GUEST], expiresAt: input.expiresAt, maxCalls: 16, maxArtifactBytes: 4_194_304 },
      { id: 'grant-verify-replay', taskId: TASK_VERIFY, role: 'verifier', capabilities: ['source.analyze', 'http.request'], targetIds: [TARGET_B], actions: ['read', 'analyze'], accountIds: [ACTOR_GUEST_B], expiresAt: input.expiresAt, maxCalls: 24, maxArtifactBytes: 4_194_304 },
    ],
  };
}

function scopeFor(input: { authorization: Authorization; targetIds: string[]; inputs: Scope['inputs']; environmentId: string; configurationDigest: string; actorId?: string }): Scope {
  return {
    authorizationRef: input.authorization.reference,
    targetIds: input.targetIds,
    actor: { id: input.actorId ?? ACTOR_GUEST, privileges: ['read'] },
    boundary: 'loopback live lab only; read-only HTTP requests; no state-changing requests and no external destination',
    isolation: 'pinned offline container pack for every capability; owner-started loopback lab instances; broker-only target egress',
    recovery: 'the harness stops the lab instances and its owned worker processes; no host state is modified',
    environmentId: input.environmentId,
    configurationDigest: input.configurationDigest,
    inputs: input.inputs,
  };
}

function task(input: {
  authorization: Authorization;
  scope: Scope;
  runId: string;
  taskId: string;
  question: TaskManifest['question'];
  skills: string[];
  allowedActions: string[];
  requiredCapabilities: string[];
  deadlineAt: string;
  maxRequests: number;
  maxTokens: number;
  maxCostUsd: number;
  workspace: string;
  overrides?: Partial<TaskManifest>;
}): TaskManifest {
  return {
    schemaVersion: 1,
    runId: input.runId,
    taskId: input.taskId,
    dependencyTaskIds: [],
    depth: 0,
    createdAt: new Date().toISOString(),
    inputRevision: INPUT_REVISION,
    question: input.question,
    scope: input.scope,
    skills: input.skills,
    allowedActions: input.allowedActions,
    requiredCapabilities: input.requiredCapabilities,
    budgets: {
      deadlineAt: input.deadlineAt,
      maxRequests: input.maxRequests,
      maxBytes: 2_000_000,
      maxToolCalls: 24,
      maxTokens: input.maxTokens,
      maxCostUsd: input.maxCostUsd,
      maxAttempts: 2,
    },
    requestedRuntime: { adapter: 'headless', selection: { ...LIVE_SELECTION }, requiredCapabilities: ['ownsLifecycle'] },
    workspace: input.workspace,
    lifecycleState: 'queued',
    packetState: 'draft',
    ...input.overrides,
  };
}

// --------------------------------------------------------------------------------------------- scenario

export interface ScenarioInputs {
  runId: string;
  runRoot: string;
  snapshotRoot: string;
  snapshotBytes: Buffer;
  labA: LabInstance;
  labB: LabInstance;
  workspaceRoot: string;
  controlRoot: string;
  vaultRoot: string;
  socketPath: string;
  piBinary: string;
  extensionPath: string;
  sandboxOptions: ContainerSandboxOptions;
  /** Digest of the constructed container sandbox; every scope and target is bound to it. */
  configurationDigest: string;
  now: number;
}

export interface Scenario {
  config: ApplicationConfigWithSpend;
  ownerGrant: OwnerGrantDocument;
  authorization: Authorization;
  checks: ObservationCheck[];
}

export interface LiveLabDocument {
  /** The serialized owner document, as the harness writes it to disk before loading it again. */
  config: ApplicationConfigWithSpend;
  ownerGrant: OwnerGrantDocument;
  authorization: Authorization;
  checks: ObservationCheck[];
}


const schemaTypeNames = (schema: JsonNode | undefined): string[] => {
  if (!schema || typeof schema !== 'object') return ['value'];
  if (Array.isArray(schema.anyOf)) return [...new Set((schema.anyOf as JsonNode[]).flatMap(schemaTypeNames))].sort();
  if (schema.type === 'array') return ['array'];
  if (schema.type === 'object') return ['object'];
  if (schema.type === 'integer') return ['integer'];
  if (schema.type === 'number') return ['number'];
  if (schema.type === 'string') return ['string'];
  if (schema.type === 'boolean') return ['boolean'];
  if ('const' in schema) return [typeof schema.const];
  return ['value'];
};
const schemaTypeDescription = (schema: JsonNode | undefined): string => {
  if (!schema || typeof schema !== 'object') return 'value';
  if (Array.isArray(schema.anyOf)) return [...new Set((schema.anyOf as JsonNode[]).map(schemaTypeDescription))].join(' or ');
  if (schema.type === 'array') return `array of ${schema.items ? schemaTypeDescription(schema.items as JsonNode) : 'value'}`;
  if ('const' in schema) return `literal ${JSON.stringify(schema.const)}`;
  if (schema.type) return String(schema.type);
  return 'value';
};
type TypeEntry = { types: string[]; description: string; required: boolean; items?: string[]; itemDescription?: string };
function walkTypes(node: JsonNode, path: string, requiredKeys: readonly string[] | undefined, out: Record<string, TypeEntry>): void {
  const required = requiredKeys ?? [];
  for (const [key, child] of Object.entries((node.properties ?? {}) as Record<string, JsonNode>)) {
    const childPath = path ? `${path}.${key}` : key;
    const entry: TypeEntry = { types: schemaTypeNames(child), description: schemaTypeDescription(child), required: required.includes(key) };
    if (child.type === 'array' && child.items) { entry.items = schemaTypeNames(child.items as JsonNode); entry.itemDescription = schemaTypeDescription(child.items as JsonNode); }
    out[childPath] = entry;
    walkTypes(child, childPath, Array.isArray(child.required) ? (child.required as string[]) : undefined, out);
    const items = child.items as JsonNode | undefined;
    if (items && items.properties) walkTypes(items, `${childPath}[]`, Array.isArray(items.required) ? (items.required as string[]) : undefined, out);
  }
}
const sortedRecord = <T>(value: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

// ------------------------------------------------------- authoring-contract drift guard

/** The worker authoring crib's required fields and enum values, keyed by handoff contract. */
export interface ContractEnumTable {
  version: 1;
  contracts: Record<string, {
    /** Every root-level packet key the contract accepts (an unknown root key is rejected at admission). */
    rootKeys: readonly string[];
    /** Root keys that must be present in every packet of this contract. */
    requiredRootKeys: readonly string[];
    /** Every key the contract accepts inside `details` (required and optional). */
    detailsKeys: readonly string[];
    required: Record<string, readonly string[]>;
    enums: Record<string, readonly string[]>;
    /**
     * Exact accepted JSON value types per `details` field and nested object/array element, generated from the
     * handoff schema. `description` is what the authoring gate reports at the field's JSON pointer.
     */
    types: Record<string, { types: readonly string[]; description: string; required: boolean; items?: readonly string[]; itemDescription?: string }>;
  }>;
}

export function contractEnumsPath(sourceRoot = process.env.P2O_EXAMPLE_SOURCE ?? import.meta.dirname): string {
  return join(sourceRoot, 'contract-enums.json');
}

export function readContractEnumTable(path = contractEnumsPath()): ContractEnumTable {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ContractEnumTable;
  if (parsed?.version !== 1 || !parsed.contracts || typeof parsed.contracts !== 'object') throw new Error('contract-enums.json is not a version-1 table');
  return parsed;
}

type JsonNode = Record<string, unknown>;

function walkEnums(node: unknown, path: string, out: Record<string, string[]>): void {
  if (!node || typeof node !== 'object') return;
  const entry = node as JsonNode;
  if (Array.isArray(entry.enum)) { out[path] = entry.enum.map(String); return; }
  if (entry.properties && typeof entry.properties === 'object') {
    for (const [key, child] of Object.entries(entry.properties as Record<string, unknown>)) walkEnums(child, path ? `${path}.${key}` : key, out);
  }
  if (entry.items) walkEnums(entry.items, `${path}[]`, out);
  if (Array.isArray(entry.anyOf)) for (const child of entry.anyOf) walkEnums(child, path, out);
}

/** The same facts read from the supervisor's handoff gate, so the crib cannot drift from it. */
export function schemaContractEnumTable(): ContractEnumTable {
  const contracts: ContractEnumTable['contracts'] = {};
  const json = handoffSchema.jsonSchema as { anyOf?: JsonNode[] };
  for (const branch of json.anyOf ?? []) {
    const properties = (branch.properties ?? {}) as Record<string, JsonNode>;
    const contract = (properties.contract?.const ?? '') as string;
    if (contract !== 'H1' && contract !== 'H2') continue;
    const details = properties.details ?? {};
    const required: Record<string, string[]> = {};
    if (Array.isArray(details.required)) required.details = (details.required as string[]).slice();
    const items = details.items as JsonNode | undefined;
    if (items && Array.isArray(items.required)) required['interfaces[]'] = (items.required as string[]).slice();
    for (const [key, child] of Object.entries((details.properties ?? {}) as Record<string, JsonNode>)) {
      const childItems = child.items as JsonNode | undefined;
      if (childItems && Array.isArray(childItems.required)) required[`${key}[]`] = (childItems.required as string[]).slice();
      if (child.properties && Array.isArray(child.required)) required[key] = (child.required as string[]).slice();
    }
    const enums: Record<string, string[]> = {};
    walkEnums(details, 'details', enums);
    const types: Record<string, TypeEntry> = {};
    walkTypes(details, 'details', Array.isArray(details.required) ? (details.required as string[]) : undefined, types);
    contracts[contract] = {
      rootKeys: Object.keys(properties).sort(),
      detailsKeys: Object.keys((details.properties ?? {}) as Record<string, JsonNode>).sort(),
      requiredRootKeys: Array.isArray(branch.required) ? (branch.required as string[]).slice().sort() : [],
      required,
      enums: sortedRecord(Object.fromEntries(Object.entries(enums).map(([path, values]) => [path.replace(/^details\.?/, ''), values]))),
      types: sortedRecord(Object.fromEntries(Object.entries(types).map(([path, entry]) => [path.replace(/^details\.?/, ''), entry]))),
    };
  }
  return { version: 1, contracts };
}

/**
 * Fail loudly at authoring time (scenario construction), never at packet admission: the worker crib must
 * enumerate exactly the enum values the gate accepts and exactly the required fields per contract.
 */
export function assertContractEnumCoverage(table: ContractEnumTable = readContractEnumTable()): void {
  const expected = schemaContractEnumTable();
  for (const [contract, schemaEntry] of Object.entries(expected.contracts)) {
    const crib = table.contracts[contract];
    if (!crib) throw new Error(`authoring crib is missing contract ${contract}`);
    const cribEnums = JSON.stringify(crib.enums ?? {}), schemaEnums = JSON.stringify(schemaEntry.enums ?? {});
    if (cribEnums !== schemaEnums) throw new Error(`authoring crib enum drift for ${contract}: crib=${cribEnums} gate=${schemaEnums}`);
    const cribRoot = JSON.stringify(crib.rootKeys ?? []), schemaRoot = JSON.stringify(schemaEntry.rootKeys ?? []);
    if (cribRoot !== schemaRoot) throw new Error(`authoring crib root-key drift for ${contract}: crib=${cribRoot} gate=${schemaRoot}`);
    const cribRequiredRoot = JSON.stringify(crib.requiredRootKeys ?? []), schemaRequiredRoot = JSON.stringify(schemaEntry.requiredRootKeys ?? []);
    if (cribRequiredRoot !== schemaRequiredRoot) throw new Error(`authoring crib required-root-key drift for ${contract}: crib=${cribRequiredRoot} gate=${schemaRequiredRoot}`);
    const cribTypes = JSON.stringify(crib.types ?? {}), schemaTypes = JSON.stringify(schemaEntry.types ?? {});
    if (cribTypes !== schemaTypes) throw new Error(`authoring crib value-type drift for ${contract}; regenerate with \`npm run build && node examples/live-lab/generate-contract-enums.mjs\` (crib=${cribTypes.slice(0, 240)} gate=${schemaTypes.slice(0, 240)})`);
    const cribDetails = JSON.stringify(crib.detailsKeys ?? []), schemaDetails = JSON.stringify(schemaEntry.detailsKeys ?? []);
    if (cribDetails !== schemaDetails) throw new Error(`authoring crib details-key drift for ${contract}: crib=${cribDetails} gate=${schemaDetails}`);
    for (const [scope, keys] of Object.entries(schemaEntry.required)) {
      const covered = crib.required?.[scope] ?? [];
      for (const key of keys) if (!covered.includes(key)) throw new Error(`authoring crib does not require ${contract} ${scope}.${key}`);
      for (const key of covered) if (!keys.includes(key)) throw new Error(`authoring crib invents ${contract} ${scope}.${key}`);
    }
  }
}

/** Build the complete owner-approved composition document for the live lab. */
export function buildScenario(inputs: ScenarioInputs): Scenario {
  // Authoring-time drift guard: the worker crib must match the packet gate before any worker launches.
  assertContractEnumCoverage(readContractEnumTable(contractEnumsPath(dirname(inputs.extensionPath))));
  const runId = inputs.runId;
  const configurationDigest = inputs.configurationDigest;
  const sourceDigest = sha256(inputs.snapshotBytes);
  const originA = inputs.labA.origin;
  const originB = inputs.labB.origin;
  const validFrom = new Date(inputs.now - 60_000).toISOString();
  const authorizationExpiresAt = new Date(inputs.now + AUTHORIZATION_WINDOW_MS).toISOString();
  const runDeadline = new Date(inputs.now + RUN_DEADLINE_MS).toISOString();
  const taskDeadline = new Date(inputs.now + TASK_DEADLINE_MS).toISOString();

  const authorization: Authorization = {
    reference: 'owner-authorized-live-lab',
    authorizedBy: 'live-lab-owner',
    validFrom,
    expiresAt: authorizationExpiresAt,
    targets: [
      { id: TARGET_A, kind: 'lab', locator: originA, digest: configurationDigest, revision: '1' },
      { id: TARGET_B, kind: 'lab', locator: originB, digest: configurationDigest, revision: '1' },
      { id: TARGET_SOURCE, kind: 'artifact', locator: SNAPSHOT_FILE, digest: sourceDigest, revision: INPUT_REVISION },
    ],
    exclusions: [],
    allowedActions: ['read', 'analyze'],
  };
  const inputsRecord = [{ id: TARGET_SOURCE, digest: sourceDigest, locator: SNAPSHOT_FILE, revision: INPUT_REVISION }];
  const scopeA = scopeFor({ authorization, targetIds: [TARGET_A, TARGET_SOURCE], inputs: inputsRecord, environmentId: ENVIRONMENT_A, configurationDigest });
  const scopeB = scopeFor({ authorization, targetIds: [TARGET_B, TARGET_SOURCE], inputs: inputsRecord, environmentId: ENVIRONMENT_B, configurationDigest, actorId: ACTOR_GUEST_B });

  const run: RunManifest = {
    schemaVersion: 1,
    runId,
    createdAt: validFrom,
    state: 'created',
    authorization,
    budgets: {
      // One worst-case spend hold is taken per live attempt, so the declared run budget must cover the
      // authorized concurrency (3) with margin: 3 x (8 000 input + 8 192 output) fits inside 400 000 tokens.
      deadlineAt: runDeadline, maxRequests: 256, maxBytes: 16_000_000, maxToolCalls: 128, maxTokens: RUN_MAX_TOKENS,
      maxCostUsd: RUN_MAX_COST_USD, maxAttempts: 2, maxTasks: 8, maxDepth: 3, maxConcurrency: 3, reportReserveMs: 120_000,
      targetRequestLimits: { [TARGET_A]: 96, [TARGET_B]: 32, [TARGET_SOURCE]: 24 },
    },
    requestedRuntime: { adapter: 'headless', selection: { ...LIVE_SELECTION }, requiredCapabilities: ['ownsLifecycle'] },
    allowedCapabilities: ['source.analyze', 'http.request'],
  };

  const extensionDigest = sha256(readFileSync(inputs.extensionPath));
  const boundaryExtension = { path: inputs.extensionPath, sha256: extensionDigest, approval: 'owner-approved live-lab bridge extension' };
  const workerToolPolicy = { mode: 'sandbox-extension' as const, extension: boundaryExtension, boundaryId: 'live-lab-worker-bridge', tools: [...WORKER_TOOLS] };
  const verifierToolPolicy = { mode: 'sandbox-extension' as const, extension: boundaryExtension, boundaryId: 'live-lab-verifier-bridge', tools: [...VERIFIER_TOOLS] };

  const workspace = (taskId: string): string => join(inputs.workspaceRoot, taskId);
  const common = { authorization, runId, deadlineAt: taskDeadline, maxRequests: 24, maxTokens: 120_000, maxCostUsd: 0.4 };

  const mapTask = task({
    ...common,
    scope: scopeA,
    taskId: TASK_SURFACE_MAP,
    question: {
      text: `Map the loopback lab HTTP surface: which routes exist, which approved actor reaches each one, and which gate each route applies. Deliverable: exactly one H1 handoff packet; call p2o_authoring with contract "H1" for the exact packet shape, perform the approved observations you rely on, then write the packet with p2o_packet.`,
      ifTrue: 'The approved member reaches the item read route and a separate export route, and a health route answers with the lab identity',
      ifFalse: 'Only the guarded item read route is reachable by the approved member',
    },
    skills: ['attack-surface-mapping'],
    allowedActions: ['read', 'analyze'],
    requiredCapabilities: ['http.request', 'source.analyze'],
    workspace: workspace(TASK_SURFACE_MAP),
  });

  const idorTask = task({
    ...common,
    scope: scopeA,
    taskId: TASK_HYP_IDOR,
    question: {
      text: `Decide whether the item read route authorizes on the client-supplied tenant parameter instead of the authenticated session tenant. Claim under test: ${CLAIM_IDOR} Measure the approved baseline, negative-control and reproduction observations for the member account, then answer whether the claim holds. Deliverable: exactly one H2 handoff packet; call p2o_authoring with contract "H2" for the exact packet shape, then write the packet with p2o_packet.`,
      ifTrue: 'The member account receives the other tenant item when it supplies that tenant as the parameter, while a mismatched parameter is rejected',
      ifFalse: 'The read route rejects every cross-tenant read because it compares the parameter with the caller session tenant',
    },
    skills: ['dynamic-analysis', 'authorization-auditing'],
    allowedActions: ['read', 'analyze'],
    requiredCapabilities: ['http.request', 'source.analyze'],
    workspace: workspace(TASK_HYP_IDOR),
    overrides: { parentTaskId: TASK_SURFACE_MAP, dependencyTaskIds: [TASK_SURFACE_MAP], depth: 1 },
  });

  const exportTask = task({
    ...common,
    scope: scopeA,
    taskId: TASK_HYP_EXPORT,
    question: {
      text: `Decide whether the export route enforces the documented admin role and tenant boundary. Claim under test: ${CLAIM_EXPORT} Measure the approved baseline, negative-control and reproduction observations for the member account, then answer whether the claim holds. Deliverable: exactly one H2 handoff packet; call p2o_authoring with contract "H2" for the exact packet shape, then write the packet with p2o_packet.`,
      ifTrue: 'The member account receives another tenant secret value from the export route with no role or tenant check',
      ifFalse: 'The export route rejects the member account or the cross-tenant export',
    },
    skills: ['dynamic-analysis', 'authorization-auditing'],
    allowedActions: ['read', 'analyze'],
    requiredCapabilities: ['http.request', 'source.analyze'],
    workspace: workspace(TASK_HYP_EXPORT),
    overrides: { parentTaskId: TASK_SURFACE_MAP, dependencyTaskIds: [TASK_SURFACE_MAP], depth: 1 },
  });

  const verifyTask = task({
    ...common,
    maxRequests: 32,
    scope: scopeB,
    taskId: TASK_VERIFY,
    question: {
      text: `Independently replay the two owner-approved findings in a fresh lab environment and report exactly what the controller's verifier returns. Call p2o_verify with findingId "${FINDING_IDOR}" and then with findingId "${FINDING_EXPORT}", reference the verifier-owned evidenceIds each call returns, and answer whether both replays reproduced. Deliverable: exactly one H2 handoff packet; call p2o_authoring with contract "H2" for the exact packet shape, then write the packet with p2o_packet.`,
      ifTrue: 'Both independent replays in the fresh environment reproduce their claim (verifier status accepted)',
      ifFalse: 'At least one replay does not reproduce its claim in the fresh environment',
    },
    skills: ['dynamic-analysis', 'exploitability-assessment'],
    allowedActions: ['read', 'analyze'],
    requiredCapabilities: ['http.request', 'source.analyze'],
    workspace: workspace(TASK_VERIFY),
    overrides: { parentTaskId: TASK_HYP_EXPORT, dependencyTaskIds: [TASK_HYP_IDOR, TASK_HYP_EXPORT], depth: 2 },
  });

  const tasks: GrantedTask[] = [
    { manifest: mapTask, role: 'worker', toolPolicy: workerToolPolicy, boundaryReceipt: BOUNDARY_RECEIPT },
    { manifest: idorTask, role: 'worker', toolPolicy: workerToolPolicy, boundaryReceipt: BOUNDARY_RECEIPT },
    { manifest: exportTask, role: 'worker', toolPolicy: workerToolPolicy, boundaryReceipt: BOUNDARY_RECEIPT },
    { manifest: verifyTask, role: 'verifier', toolPolicy: verifierToolPolicy, boundaryReceipt: BOUNDARY_RECEIPT },
  ];

  const ownerGrant: OwnerGrantDocument = {
    version: 1,
    runs: [{ manifest: run, mode: 'managed', perTargetConcurrency: { [TARGET_A]: 2, [TARGET_B]: 1, [TARGET_SOURCE]: 2 } }],
    tasks: tasks.map(entry => ({
      proposal: { manifest: entry.manifest, role: entry.role, ...(entry.exclusiveKeys ? { exclusiveKeys: entry.exclusiveKeys } : {}) },
      toolPolicy: entry.toolPolicy,
      boundaryReceipt: entry.boundaryReceipt,
    })),
  };

  // Owner-approved observation checks. The controller executes exactly these inputs and evaluates the
  // expectations over the collected bytes; a worker may only select an observationId.
  const checks: ObservationCheck[] = [
    {
      checkId: 'map-source', taskId: TASK_SURFACE_MAP, observationId: 'map-source',
      tool: 'source.analyze', input: { paths: [SNAPSHOT_FILE], contains: 'app.' }, kind: 'source',
      classification: 'static-inference', summary: 'Lexical route/handler map of the hashed lab source snapshot',
      expectation: { type: 'source', contains: 'routes' }, surfaceId: SURFACE_READ, actorId: ACTOR_GUEST,
    },
    {
      checkId: 'map-health', taskId: TASK_SURFACE_MAP, observationId: 'map-health',
      tool: 'http.request', input: { url: `${originA}/healthz`, accountId: ACTOR_GUEST }, kind: 'observation',
      classification: 'independently-observed', summary: 'Lab identity, seeded items and configuration digest as served by the target',
      expectation: { type: 'http', status: 200, bodyIncludes: '"ok":true' }, surfaceId: SURFACE_HEALTH, actorId: ACTOR_GUEST,
    },
    {
      checkId: 'map-read-own', taskId: TASK_SURFACE_MAP, observationId: 'map-read-own',
      tool: 'http.request', input: { url: `${originA}/api/v1/items/i-100?tenant=alpha`, accountId: ACTOR_GUEST }, kind: 'observation',
      classification: 'independently-observed', summary: 'Same-tenant read of the member own item succeeds',
      expectation: { type: 'http', status: 200, bodyIncludes: '"tenant":"alpha"' }, surfaceId: SURFACE_READ, actorId: ACTOR_GUEST,
    },
    {
      checkId: 'map-export-secure', taskId: TASK_SURFACE_MAP, observationId: 'map-export-secure',
      tool: 'http.request', input: { url: `${originA}/api/v1/export/secure?item=i-200`, accountId: ACTOR_ADMIN }, kind: 'observation',
      classification: 'independently-observed', summary: 'The guarded export variant serves the admin own-tenant export',
      expectation: { type: 'http', status: 200, bodyIncludes: '"exported":true' }, surfaceId: SURFACE_EXPORT, actorId: ACTOR_ADMIN,
    },
    {
      checkId: 'map-export-admin', taskId: TASK_SURFACE_MAP, observationId: 'map-export-admin',
      tool: 'http.request', input: { url: `${originA}/api/v1/export?item=i-200`, accountId: ACTOR_ADMIN }, kind: 'observation',
      classification: 'independently-observed', summary: 'Admin same-tenant export reaches the export handler',
      expectation: { type: 'http', status: 200, bodyIncludes: '"exported":true' }, surfaceId: SURFACE_EXPORT, actorId: ACTOR_ADMIN,
    },

    {
      checkId: 'hyp-idor-source', taskId: TASK_HYP_IDOR, observationId: 'hyp-idor-source',
      tool: 'source.analyze', input: { paths: [SNAPSHOT_FILE], contains: 'requestedTenant' }, kind: 'source',
      classification: 'static-inference', summary: 'Source slice for the read route tenant comparison',
      expectation: { type: 'source', contains: 'routes' }, claim: CLAIM_IDOR, surfaceId: SURFACE_READ, actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-idor-baseline', taskId: TASK_HYP_IDOR, observationId: 'hyp-idor-baseline',
      tool: 'http.request', input: { url: `${originA}/api/v1/items/i-100?tenant=alpha`, accountId: ACTOR_GUEST }, kind: 'baseline',
      classification: 'independently-observed', summary: 'Known-good same-tenant read establishes the read-path baseline',
      expectation: { type: 'http', status: 200, bodyIncludes: '"tenant":"alpha"' },
      test: { purpose: 'baseline', invariant: CLAIM_IDOR, originalPolicy: true, targetId: TARGET_A }, surfaceId: SURFACE_READ, actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-idor-control', taskId: TASK_HYP_IDOR, observationId: 'hyp-idor-control',
      tool: 'http.request', input: { url: `${originA}/api/v1/items/i-200?tenant=alpha`, accountId: ACTOR_GUEST }, kind: 'negative-control',
      classification: 'independently-observed', summary: 'A tenant parameter that does not match the target item is rejected, so the parameter is compared with the item record',
      expectation: { type: 'http', status: 403, bodyIncludes: 'tenant_mismatch' },
      test: { purpose: 'negative-control', invariant: CLAIM_IDOR, originalPolicy: true, targetId: TARGET_A }, surfaceId: SURFACE_READ, actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-idor-reproduction', taskId: TASK_HYP_IDOR, observationId: 'hyp-idor-reproduction',
      tool: 'http.request', input: { url: `${originA}/api/v1/items/i-200?tenant=beta`, accountId: ACTOR_GUEST }, kind: 'reproduction',
      classification: 'independently-observed', summary: 'The member account receives the beta item by supplying the beta tenant parameter',
      expectation: { type: 'http', status: 200, bodyIncludes: '"tenant":"beta"' },
      test: { purpose: 'reproduction', invariant: CLAIM_IDOR, originalPolicy: true, targetId: TARGET_A }, claim: CLAIM_IDOR, surfaceId: SURFACE_READ, actorId: ACTOR_GUEST,
    },

    {
      checkId: 'hyp-export-source', taskId: TASK_HYP_EXPORT, observationId: 'hyp-export-source',
      tool: 'source.analyze', input: { paths: [SNAPSHOT_FILE], contains: '/api/v1/export' }, kind: 'source',
      classification: 'static-inference', summary: 'Source slice for the export handler and its (absent) role/tenant check',
      expectation: { type: 'source', contains: 'routes' }, claim: CLAIM_EXPORT, surfaceId: SURFACE_EXPORT, actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-export-baseline', taskId: TASK_HYP_EXPORT, observationId: 'hyp-export-baseline',
      tool: 'http.request', input: { url: `${originA}/api/v1/export?item=i-100`, accountId: ACTOR_GUEST }, kind: 'baseline',
      classification: 'independently-observed', summary: 'Known-good member export of the member own tenant item establishes the export baseline',
      expectation: { type: 'http', status: 200, bodyIncludes: '"exported":true' },
      test: { purpose: 'baseline', invariant: CLAIM_EXPORT, originalPolicy: true, targetId: TARGET_A }, surfaceId: SURFACE_EXPORT, actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-export-control', taskId: TASK_HYP_EXPORT, observationId: 'hyp-export-control',
      tool: 'http.request', input: { url: `${originA}/api/v1/export/secure?item=i-200`, accountId: ACTOR_GUEST }, kind: 'negative-control',
      classification: 'independently-observed', summary: 'The guarded sibling export route in the same build refuses the member cross-tenant export, so the unguarded export route is the outlier',
      expectation: { type: 'http', status: 403, bodyIncludes: 'forbidden' },
      test: { purpose: 'negative-control', invariant: CLAIM_EXPORT, originalPolicy: true, targetId: TARGET_A }, claim: CLAIM_EXPORT, surfaceId: SURFACE_EXPORT, actorId: ACTOR_GUEST,
    },
    {
      checkId: 'hyp-export-reproduction', taskId: TASK_HYP_EXPORT, observationId: 'hyp-export-reproduction',
      tool: 'http.request', input: { url: `${originA}/api/v1/export?item=i-200`, accountId: ACTOR_GUEST }, kind: 'reproduction',
      classification: 'independently-observed', summary: 'The member account exports the beta tenant secret value without any role or tenant check',
      expectation: { type: 'http', status: 200, bodyIncludes: '"value":"beta-live-value"' },
      test: { purpose: 'reproduction', invariant: CLAIM_EXPORT, originalPolicy: true, targetId: TARGET_A }, claim: CLAIM_EXPORT, surfaceId: SURFACE_EXPORT, actorId: ACTOR_GUEST,
    },

    {
      checkId: 'verify-source', taskId: TASK_VERIFY, observationId: 'verify-source',
      tool: 'source.analyze', input: { paths: [SNAPSHOT_FILE], contains: 'app.' }, kind: 'source',
      classification: 'static-inference', summary: 'Verifier source slice for the replay target build',
      expectation: { type: 'source', contains: 'routes' }, surfaceId: SURFACE_EXPORT, actorId: ACTOR_GUEST,
    },
    {
      checkId: 'denied-unapproved-destination', taskId: TASK_VERIFY, observationId: 'denied-unapproved-destination',
      tool: 'http.request',
      // Outside every approved target, so the policy must deny before any connection is created. The
      // attempted call is still charged to the task budget, exactly like any other denied request.
      input: { url: 'http://127.0.0.1:9/not-an-approved-destination', accountId: ACTOR_GUEST_B }, kind: 'observation',
      classification: 'independently-observed', summary: 'Owner-approved probe against an unapproved destination: scope denial must precede any traffic',
      expectation: { type: 'http', status: 200 }, surfaceId: SURFACE_HEALTH, actorId: ACTOR_GUEST,
    },
  ];

  const findings: FindingPlan[] = [
    {
      findingId: FINDING_IDOR, taskId: TASK_HYP_IDOR,
      title: 'Cross-tenant item read (client-supplied tenant parameter decides authorization)',
      claim: CLAIM_IDOR, state: 'reproduced', classification: 'independently-observed',
      limitations: [
        'Bounded to the two seeded tenants and the approved member account on the loopback lab.',
        'Encoding/case variants of the tenant parameter and the admin account on the read route were not tested.',
      ],
      impact: 'Any authenticated member can read another tenant item record by asserting that tenant in the request parameter.',
    },
    {
      findingId: FINDING_EXPORT, taskId: TASK_HYP_EXPORT,
      title: 'Export route discloses any tenant secret without a role or tenant check',
      claim: CLAIM_EXPORT, state: 'reproduced', classification: 'independently-observed',
      limitations: [
        'Bounded to the two seeded tenants and the approved member account on the loopback lab.',
        'No administrative or unauthenticated export path was tested; those cells remain untested.',
      ],
      impact: 'A plain member receives another tenant secret value from the export route, bypassing the documented tenant and role boundary.',
    },
  ];

  const verification: VerificationPlan[] = [
    {
      verifierTaskId: TASK_VERIFY, producerTaskId: TASK_HYP_IDOR, findingId: FINDING_IDOR, maxMs: 20_000,
      recipe: {
        recipeId: RECIPE_IDOR, fixtureId: 'live-lab-tenant-api-b', targetId: TARGET_B, invariant: CLAIM_IDOR, inputDigests: [sourceDigest],
        baseline: { input: { url: `${originB}/api/v1/items/i-100?tenant=alpha`, accountId: ACTOR_GUEST_B }, expected: { status: 200, bodyIncludes: '"tenant":"alpha"' } },
        negativeControl: { input: { url: `${originB}/api/v1/items/i-200?tenant=alpha`, accountId: ACTOR_GUEST_B }, expected: { status: 403, bodyIncludes: 'tenant_mismatch' } },
        probe: { input: { url: `${originB}/api/v1/items/i-200?tenant=beta`, accountId: ACTOR_GUEST_B }, violation: { status: 200, bodyIncludes: '"tenant":"beta"' }, safe: { status: 403 } },
      },
    },
    {
      verifierTaskId: TASK_VERIFY, producerTaskId: TASK_HYP_EXPORT, findingId: FINDING_EXPORT, maxMs: 20_000,
      recipe: {
        recipeId: RECIPE_EXPORT, fixtureId: 'live-lab-tenant-api-b', targetId: TARGET_B, invariant: CLAIM_EXPORT, inputDigests: [sourceDigest],
        baseline: { input: { url: `${originB}/api/v1/export?item=i-100`, accountId: ACTOR_GUEST_B }, expected: { status: 200, bodyIncludes: '"exported":true' } },
        negativeControl: { input: { url: `${originB}/api/v1/export/secure?item=i-200`, accountId: ACTOR_GUEST_B }, expected: { status: 403, bodyIncludes: 'forbidden' } },
        probe: { input: { url: `${originB}/api/v1/export?item=i-200`, accountId: ACTOR_GUEST_B }, violation: { status: 200, bodyIncludes: '"value":"beta-live-value"' }, safe: { status: 403 } },
      },
    },
  ];

  /**
   * Coverage reasons are authored BEFORE the run and are copied into `report.coverage.records` verbatim, so this
   * text may claim only what the producing attempt's own accepted packet supports. Independent replay is a
   * separate verifier task: its outcome belongs to the finding record (which carries the verifier's receipts).
   * A static independence claim here would assert a replay that a blocked or failed verifier never performed —
   * an unresolved finding would still be described as "independently replayed".
   */
  const PRODUCER_TESTED_REASON = 'Reproduced live by the producing attempt: the approved reproduction and negative-control checks for this surface, actor and question back this cell (see evidenceIds). Independent replay is a separate verifier task; its outcome is reported on the finding record and is not asserted by this coverage entry.';
  const coverage: CoveragePlanEntry[] = [
    {
      surfaceId: SURFACE_READ, actorId: ACTOR_GUEST, question: CLAIM_IDOR, taskId: TASK_HYP_IDOR, state: 'tested',
      basis: 'reviewer-validated',
      reason: PRODUCER_TESTED_REASON,
    },
    {
      surfaceId: SURFACE_EXPORT, actorId: ACTOR_GUEST, question: CLAIM_EXPORT, taskId: TASK_HYP_EXPORT, state: 'tested',
      basis: 'reviewer-validated',
      reason: PRODUCER_TESTED_REASON,
    },
    {
      surfaceId: SURFACE_EXPORT, actorId: ACTOR_ANONYMOUS, question: CLAIM_ANONYMOUS, state: 'untested',
      basis: 'worker-asserted',
      reason: 'No task was admitted for an unauthenticated actor: every approved account is credential-tier, so anonymous reachability is retained as an explicit gap rather than assumed.',
    },
  ];

  const config: ApplicationConfigWithSpend = {
    schemaVersion: 1,
    mode: 'authorized-assessment',
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
      adapter: 'headless',
      selection: { ...LIVE_SELECTION },
      piBinary: inputs.piBinary,
      piVersion: LIVE_PI_VERSION,
      // The composition replaces this with the controller-owned credential gateway at construction time
      // (`overrides.upstream`); the document itself never carries a credential or a remote-origin URL.
      gateway: { approval: LIVE_GATEWAY_APPROVAL, baseUrl: 'http://127.0.0.1:9/p2o-gw/document-placeholder', api: LIVE_API, models: [...LIVE_GATEWAY_MODELS] },
      startupTimeoutMs: 30_000,
      pollMs: 100,
      stopGraceMs: 1_000,
    },
    sandbox: { mode: 'container', options: inputs.sandboxOptions },
    policy: policyScope(runId, { authorization, originA, originB, expiresAt: authorizationExpiresAt }),
    checks,
    bridge: {
      socketPath: inputs.socketPath,
      controllerArtifactRootId: 'controller-artifacts',
      brokerArtifactRootId: 'broker-artifacts',
      inertLocalOnly: false,
    },
    reporting: { coverage, findings, verification },
    interface: { perTargetConcurrency: { [TARGET_A]: 2, [TARGET_B]: 1, [TARGET_SOURCE]: 2 } },
    // Owner-declared worst-case bounds for one provider request. Enforcement itself is not optional; these
    // bounds only pin how much a single request may reserve before it is admitted.
    spend: { inputTokensUpperBound: 8_000, maxOutputTokens: 8_192 },
  };

  assertPricedSelection(config.run.requestedRuntime.selection.provider, config.run.requestedRuntime.selection.model);
  return { config, ownerGrant, authorization, checks };
}

/** Fail-closed local mirror of the composition's pinned-price gate, so the harness reports it before dispatch. */
export function assertPricedSelection(provider: string, model: string): string {
  const key = modelPriceKey(provider, model);
  const price = PINNED_MODEL_PRICES[key];
  if (!price) throw new Error(`No pinned model price for ${key}; the live run cannot be bounded (fail-closed)`);
  return `${key} input=$${price.inputMicroUsdPerMillion / 1_000_000}/M output=$${price.outputMicroUsdPerMillion / 1_000_000}/M`;
}

/** Stable identity of the live-lab artifact target for logs and reports. */
export function sourceSnapshotDigest(bytes: Buffer): string {
  return sha256(bytes);
}

export type { JsonObject };
