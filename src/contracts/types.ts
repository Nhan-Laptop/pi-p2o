export const SCHEMA_VERSION = 1 as const;
export type Id = string;
export type Digest = string;
export type Timestamp = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const lifecycleStates = ['queued', 'starting', 'running', 'waiting', 'reconciling', 'exited', 'failed', 'timed-out', 'cancelled'] as const;
export type LifecycleState = typeof lifecycleStates[number];
export const packetStates = ['draft', 'ready', 'schema-valid', 'accepted', 'returned-for-evidence'] as const;
export type PacketState = typeof packetStates[number];
export const findingStates = ['candidate', 'supported-static', 'reproduced', 'independently-validated', 'rejected', 'unresolved'] as const;
export type FindingState = typeof findingStates[number];
export const runStates = ['created', 'active', 'paused', 'completed', 'failed', 'cancelled'] as const;
export type RunState = typeof runStates[number];
export const classifications = ['independently-observed', 'static-inference', 'source-author-report', 'hypothesis', 'defensive-recommendation', 'unresolved'] as const;
export type Classification = typeof classifications[number];
export const runtimeCapabilityNames = ['ownsLifecycle', 'canHardStop', 'canResume', 'streamsEvents', 'attestsRuntime'] as const;
export type RuntimeCapabilityName = typeof runtimeCapabilityNames[number];
export type RuntimeCapabilities = Record<RuntimeCapabilityName, boolean>;
export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export interface RuntimeSelection {
  provider: string;
  model: string;
  thinking: typeof thinkingLevels[number];
}
export interface RequestedRuntime {
  adapter: string;
  selection: RuntimeSelection;
  requiredCapabilities: RuntimeCapabilityName[];
}
export interface ProcessIdentity { pid: number; hostId: string; startToken: string }
export interface ObservedRuntime {
  adapter: string;
  selection?: RuntimeSelection;
  capabilities: RuntimeCapabilities;
  attestation: 'attested' | 'reported' | 'unavailable';
  observedAt: Timestamp;
  receiptEvidenceIds: Id[];
  processIdentity?: ProcessIdentity;
}
export interface ArtifactReference {
  id: Id;
  digest: Digest;
  locator: string;
  revision: string;
}
export interface TargetIdentity {
  id: Id;
  kind: 'artifact' | 'web' | 'service' | 'lab';
  locator: string;
  digest?: Digest;
  revision?: string;
}
export interface Authorization {
  reference: string;
  authorizedBy: string;
  validFrom: Timestamp;
  expiresAt: Timestamp;
  targets: TargetIdentity[];
  exclusions: string[];
  allowedActions: string[];
}
export interface Scope {
  authorizationRef: string;
  targetIds: Id[];
  actor: { id: Id; privileges: string[] };
  boundary: string;
  isolation: string;
  recovery: string;
  environmentId: Id;
  configurationDigest: Digest;
  inputs: ArtifactReference[];
}
export interface Question { text: string; ifTrue: string; ifFalse: string }
export interface Budget {
  deadlineAt: Timestamp;
  maxRequests: number;
  maxBytes: number;
  maxToolCalls: number;
  /** Null only with explicit informational model accounting; legacy numbers remain caps. */
  maxTokens: number | null;
  modelAccounting?: 'informational';
  maxCostUsd: number | null;
  maxAttempts: number;
}
export interface RunBudget extends Budget {
  maxTasks: number;
  maxDepth: number;
  maxConcurrency: number;
  reportReserveMs: number;
  targetRequestLimits: Record<Id, number>;
}
export interface BudgetUsage { requests: number; bytes: number; toolCalls: number; tokens: number; costUsd: number }
export interface RunManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: Id;
  createdAt: Timestamp;
  state: RunState;
  authorization: Authorization;
  budgets: RunBudget;
  requestedRuntime: RequestedRuntime;
  allowedCapabilities: string[];
}
export interface TaskManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: Id;
  taskId: Id;
  parentTaskId?: Id;
  dependencyTaskIds: Id[];
  depth: number;
  createdAt: Timestamp;
  inputRevision: string;
  question: Question;
  scope: Scope;
  skills: string[];
  allowedActions: string[];
  requiredCapabilities: string[];
  budgets: Budget;
  requestedRuntime: RequestedRuntime;
  workspace: string;
  lifecycleState: LifecycleState;
  packetState: PacketState;
}
export interface ExitObservation { code: number | null; signal?: string; observedAt: Timestamp }
export interface AttemptRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: Id;
  taskId: Id;
  attemptId: Id;
  sequence: number;
  ownerId: Id;
  leaseToken: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lifecycleState: LifecycleState;
  requestedRuntime: RequestedRuntime;
  observedRuntime?: ObservedRuntime;
  heartbeatAt: Timestamp;
  deadlineAt: Timestamp;
  checkpoint?: ArtifactReference;
  exit?: ExitObservation;
  usage: BudgetUsage;
}
export const evidenceKinds = ['source', 'observation', 'baseline', 'negative-control', 'reproduction', 'test', 'build', 'deployment', 'enforcement', 'runtime', 'trace', 'seed', 'coverage', 'sanitizer', 'log'] as const;
export type EvidenceKind = typeof evidenceKinds[number];
export interface TestReceipt {
  purpose: 'baseline' | 'negative-control' | 'reproduction' | 'regression' | 'forbidden';
  outcome: 'passed' | 'failed' | 'inconclusive';
  successes: number;
  attempts: number;
  invariant?: string;
  originalPolicy: boolean;
  targetId?: Id;
  artifactDigest?: Digest;
}
export interface EvidenceReceipt {
  schemaVersion: typeof SCHEMA_VERSION;
  evidenceId: Id;
  runId: Id;
  taskId: Id;
  attemptId: Id;
  kind: EvidenceKind;
  classification: Classification;
  digest: Digest;
  locator: string;
  mediaType: string;
  byteLength: number;
  summary: string;
  redacted: boolean;
  provenance: {
    collectorId: Id;
    trust: 'collector' | 'worker';
    method: string;
    collectedAt: Timestamp;
    tool: { name: string; version: string; options: string[] };
    environmentId: Id;
    configurationDigest: Digest;
    inputDigests: Digest[];
    originalEnvironment: boolean;
    modifications: string[];
  };
  test?: TestReceipt;
  artifact?: { digest: Digest; revision: string; sourceDigest?: Digest };
  deployment?: {
    targetId: Id;
    artifactDigest: Digest;
    sourceDigest: Digest;
    containsAssessedFix: boolean;
    activeEnforcement: boolean;
    originalPolicy: boolean;
  };
  analysis?: {
    requestedRanges: string[];
    recoveredRanges: string[];
    truncated: boolean;
    errors: string[];
    unresolvedCoverage: string[];
  };
  metadata?: JsonObject;
}
export interface CoverageRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  coverageId: Id;
  runId: Id;
  taskId?: Id;
  surfaceId: Id;
  actorId: Id;
  question: string;
  state: 'tested' | 'ruled-out' | 'blocked' | 'untested' | 'not-applicable';
  basis: 'worker-asserted' | 'runtime-observed' | 'reviewer-validated';
  evidenceIds: Id[];
  reason: string;
}
export interface FindingRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  findingId: Id;
  runId: Id;
  taskId: Id;
  producerId: Id;
  title: string;
  claim: string;
  classification: Classification;
  state: FindingState;
  evidenceIds: Id[];
  negativeControlEvidenceIds: Id[];
  limitations: string[];
  impact?: string;
  verifier?: { identity: Id; attemptId: Id; environmentId: Id; evidenceIds: Id[] };
}
export interface H1Details {
  interfaces: {
    surfaceId: Id;
    registration: string;
    handler: string;
    actorId: Id;
    gate: string;
    processIdentity: string;
    formats: string[];
    benignOperations: string[];
    priority: number;
    priorityReason: string;
    evidenceIds: Id[];
    reachability: 'observed' | 'inferred';
    proposedCheck?: string;
  }[];
  architecture?: string;
  unresolvedRoutes: string[];
  peerTopology?: { peer: string; identityOrigin: string; membershipEvidenceIds: Id[]; authorityEvidenceIds: Id[] }[];
}
export interface H2Details {
  minimalSlice: string;
  invariant: string;
  controllableFields: string[];
  constraints: string[];
  unknown: string;
  predictions: { ifTrue: string; ifFalse: string; observableIfTrue: string; observableIfFalse: string };
  observationPoints: string[];
  instrumentation: string[];
  prerequisites: string[];
  prerequisitesKnown: boolean;
  baseline: { status: 'observed' | 'unavailable'; evidenceIds: Id[]; reason?: string };
  lab: { safety: string; isolation: string; authorized: boolean };
  modifiedBuild: boolean;
  modificationDisclosure?: string;
  composition?: {
    representationChanges: string[];
    writersReaders: string[];
    encoding: string;
    phaseGuards: string[];
    inferredEdges: string[];
    terminalStateEvidenceIds: Id[];
  };
}
export interface H3Details {
  seedEvidenceIds: Id[];
  minimizedInputEvidenceIds: Id[];
  initialization: string;
  reset: string;
  harnessComparisonEvidenceIds: Id[];
  buildEvidenceIds: Id[];
  coverageEvidenceIds: Id[];
  rejectionEvidenceIds: Id[];
  faultEvidenceIds: Id[];
  firstInvalidOperation: string;
  context: string;
  reproductionEvidenceIds: Id[];
  deduplicationRationale: string;
  harnessIsSoleFailure: boolean;
  originalAndModifiedSeparated: boolean;
}
export interface H4Details {
  invariant: string;
  earliestViolation: string;
  primitive: {
    operation: string;
    direction: 'read' | 'write' | 'state' | 'logic' | 'other';
    width: string;
    controllability: string;
    repetition: string;
    addressSpace: string;
    lifetime: string;
    constraints: string[];
  };
  gates: string[];
  mitigations: string[];
  damageRecovery: string;
  missingCapabilities: string[];
  reachabilityEvidenceIds: Id[];
  capabilityEdges: { from: string; to: string; preconditions: string[]; evidenceIds: Id[] }[];
  setupDisclosures: string[];
}
export interface H5Details {
  invariant: string;
  enforcementPoint: string;
  affectedConsumers: string[];
  variants: string[];
  impact: string;
  emergencyMitigation: string;
  acceptedControlEvidenceIds: Id[];
  rejectedCaseEvidenceIds: Id[];
  matrix: { role: string; feature: string; state: string; runtime: string; expected: string }[];
  regressionProperties: string[];
  equivalentPathsReviewed: boolean;
  repairKind: 'root-cause' | 'exposure-mitigation' | 'unresolved';
  sourceShippedGap: string;
  loggingRedaction: string;
}
export interface H6Details {
  sourceChangeEvidenceIds: Id[];
  buildEvidenceIds: Id[];
  deploymentEvidenceIds: Id[];
  enforcementEvidenceIds: Id[];
  acceptedControlEvidenceIds: Id[];
  forbiddenClassEvidenceIds: Id[];
  deploymentInventory: { targetId: Id; artifactDigest: Digest; revision: string; active: boolean }[];
  originalPolicy: boolean;
  rollout: string;
  activationRequirements: string[];
  listenerMembershipChanges: string[];
  detectionTransportCoverage: string[];
  compatibilityTradeoffs: string[];
  secretRotationScope: string;
  residualRisks: string[];
  closure: 'repaired' | 'exposure-mitigated' | 'partially-repaired' | 'unverified';
}
export interface HandoffEnvelope {
  schemaVersion: typeof SCHEMA_VERSION;
  packetId: Id;
  runId: Id;
  taskId: Id;
  attemptId: Id;
  producer: { id: Id; role: string };
  consumer: { id: Id; role: string };
  createdAt: Timestamp;
  inputRevision: string;
  scope: Scope;
  question: Question;
  classification: Classification;
  outcome: 'supported' | 'static-only' | 'unresolved';
  evidenceIds: Id[];
  limits: {
    negativeControlEvidenceIds: Id[];
    failedAssumptions: string[];
    untestedScope: string[];
    risks: string[];
    reproduction: { successes: number; attempts: number };
  };
  nextAction: { action: string; stopCondition: string; allowedActions: string[] };
  requestedRuntime: RequestedRuntime;
  observedRuntime: ObservedRuntime;
}
export type HandoffPacket = HandoffEnvelope & (
  | { contract: 'H1'; details: H1Details }
  | { contract: 'H2'; details: H2Details }
  | { contract: 'H3'; details: H3Details }
  | { contract: 'H4'; details: H4Details }
  | { contract: 'H5'; details: H5Details }
  | { contract: 'H6'; details: H6Details }
);
export interface ContractIssue { code: string; path: string; message: string; question: string }
export interface GateDecision {
  status: 'accepted' | 'returned-for-evidence';
  contract?: HandoffPacket['contract'];
  outcome?: HandoffPacket['outcome'];
  reviewerId: Id;
  evaluatedAt: Timestamp;
  reasons: ContractIssue[];
  unansweredQuestions: string[];
  acceptedDigest?: Digest;
}
