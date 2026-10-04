import type {
  AttemptRecord, Classification, ContractIssue, CoverageRecord, EvidenceKind, FindingRecord, JsonObject, JsonValue,
  PlanApprovalDocument, PlanCaps, PlanCoverageCell, PlanObservationExpectation, PlanProposal, PlanRunRequest, PlanTarget, PlanTask,
  RunManifest, ThreatModelCaps,
  TaskManifest, HandoffPacket, RequestedRuntime, TestReceipt,
} from '../contracts/index.js';
import type { DurableStore, StoredResult } from '../store/index.js';
import type { SupervisorApi, Authority, Approval, TaskApproval, ModelSwitchProposal, Role, TaskProposal, RunAdmission } from '../orchestrator/index.js';
import type { ModelGateway, RuntimeAdapter, RuntimeSelection, ToolPolicy } from '../runtime/types.js';
import type { ApprovedFuzzTemplate, BrowserPack, ChromeIdentity, ExecutionSandbox, ProxyPack } from '../tools/index.js';
import type { ToolBroker } from '../tools/types.js';
import type { Policy, Capability, Action, ApprovedAccount, Exclusion, WebTarget } from '../policy/index.js';
import type { EvidenceVault, FindingReview, HandoffReview, LocalReplayRecipe, CleanReplayBroker } from '../evidence/index.js';
import type { CollectorBridge } from './evidence.js';
import type { AssessmentReport, CoverageItem } from '../reporting/index.js';
import type { ControlBackend } from '../interface/types.js';
import type { PlanLedger, RequestPlanLedger } from './planner.js';
import { materializeRequestPlan } from './planner.js';
import type { EntrySeams } from './entry/factory.js';
export type ApplicationMode = 'inert-local-fixture' | 'authorized-assessment';

/** Exact acknowledgement strings; a fixture run cannot be selected silently. */
export const INERT_FIXTURE_ACKNOWLEDGEMENT = 'inert-inside-marker-no-hostile-code-isolation';
export const LOCAL_FIXTURE_SANDBOX_ACKNOWLEDGEMENT = 'local-fixtures-only-not-hostile-code-isolation';
/** [F3] Exact acknowledgement required by the host-browser boundary; it is never implied by a fixture mode. */
export const HOST_BROWSER_SANDBOX_ACKNOWLEDGEMENT = 'host-browser-not-container-isolated';

export interface ApplicationRoots {
  /** SQLite database file. */
  state: string;
  /** Supervisor controller metadata root (owner-only, outside task workspaces). */
  control: string;
  /** Approved canonical root of per-task private workspaces. */
  workspace: string;
  /** Evidence vault root (outside every worker-writable root). */
  vault: string;
  /** Trusted read-only input snapshot roots, by artifact root id. */
  artifacts: Record<string, string>;
  /** Every root to which workers have write authority. */
  workerWriteRoots: string[];
}

export interface RuntimeConfig {
  adapter: 'headless' | 'herdr';
  selection: RuntimeSelection;
  piBinary: string;
  piVersion?: string;
  gateway: ModelGateway;
  startupTimeoutMs?: number;
  pollMs?: number;
  stopGraceMs?: number;
  /** Explicit routing metadata for the herdr adapter; never copied from the ambient environment. */
  herdr?: {
    herdrBinary: string;
    herdrVersion?: string;
    parentPaneId: string;
    context: { HERDR_ENV: '1'; HERDR_SOCKET_PATH: string; HERDR_PANE_ID: string };
  };
}

export interface VaultLimits {
  maxArtifactBytes?: number;
  maxTotalBytes?: number;
  maxReceipts?: number;
  maxReceiptBytes?: number;
  maxAgeMs?: number;
}

export type SandboxConfig =
  | {
    mode: 'local-fixture';
    acknowledgement: typeof LOCAL_FIXTURE_SANDBOX_ACKNOWLEDGEMENT;
    inputRoot: string;
    outputRoot: string;
    maxFileBytes?: number;
    maxArtifactBytes?: number;
    maxArtifacts?: number;
    /** Optional expected sandbox configuration digest; the composition fails closed on a mismatch. */
    identityDigest?: string;
  }
  | { mode: 'container'; options: unknown }
  /**
   * [F3] Real headless Chrome on the host, with an explicitly acknowledged non-containment boundary. The
   * pinned launcher and executable are re-hashed from disk at preflight; drift is refused. This boundary is
   * never selected implicitly, never a container fallback, and only valid in `authorized-assessment` mode.
   */
  | {
    mode: 'host-browser';
    acknowledgement: typeof HOST_BROWSER_SANDBOX_ACKNOWLEDGEMENT;
    inputRoot: string;
    outputRoot: string;
    /** Owner identity that acknowledged this boundary and the expiry of that acknowledgement. */
    approvedBy: string;
    expiresAt: string;
    /** `loopback-only` is the fixture-safe default; `policy-scope` allows owner-approved CIDRs. */
    egress: 'loopback-only' | 'policy-scope';
    /** Private per-session Chrome profile root; must be owner-only and outside the host profile tree. */
    profileRoot: string;
    maxSessions?: number;
    sessionTtlMs?: number;
    maxActionsPerSession?: number;
    maxRequestsPerSession?: number;
    maxFileBytes?: number;
    maxArtifactBytes?: number;
    maxArtifacts?: number;
    /** Pinned Chrome identity; both pinned binaries are verified byte-for-byte before any launch. */
    identity: ChromeIdentity;
    /** Optional expected sandbox configuration digest; the composition fails closed on a mismatch. */
    identityDigest?: string;
  };

/**
 * [F3] Optional owner-configured capability packs. Each one is off unless the owner document asks for it, and
 * the composition refuses a pack whose adapter is not qualified on the configured sandbox boundary.
 */
export interface PacksConfig {
  /**
   * Real headless Chrome (`browser.session`/`browser.act`) on the acknowledged host-browser boundary. The
   * boundary must be configured explicitly; the packs are never enabled by the sandbox mode alone.
   */
  browser?: boolean;
  /**
   * Capture/replay interception (`proxy.session`/`proxy.history`). Qualified on `local-fixture` (loopback-only
   * capture) and on the acknowledged host-browser boundary; container isolation refuses it.
   */
  proxy?: boolean;
  /**
   * Fuzzing pack. `fuzz.differential` imports owner-supplied local modules into the controller process, so it is
   * only reachable on the `local-fixture` boundary (the only boundary that qualifies
   * `codeExecution: 'trusted-local-modules'`); it gets no URL, method or account authority.
   */
  fuzz?: { templates?: ApprovedFuzzTemplate[] };
}

export interface GrantedTask {
  manifest: TaskManifest;
  role: Role;
  exclusiveKeys?: string[];
  /** Owner-approved runtime tool policy for this task (pinned extension + exact allowlist). */
  toolPolicy: ToolPolicy;
  /** Owner-authored boundary statement recorded with the approval. */
  boundaryReceipt: string;
  /**
   * Controller-derived task whose exact manifest is owner-authorized here but is *admitted* only after a
   * separate controller gate (an admitted producer packet plus the receipt-backed candidate validation).
   * It is never auto-admitted by `admitApprovedTasks` and never offered in a planning menu.
   */
  deferred?: boolean;
  /** Inert fixture only: deterministic scripted steps written into the task workspace before launch. */
  workerPlan?: JsonObject;
}

/** An owner approval document. Nothing outside it is approved, including worker-proposed children. */
export interface OwnerGrant {
  version: 1;
  runs: RunAdmission[];
  tasks: Array<{
    proposal: TaskProposal;
    toolPolicy: ToolPolicy;
    boundaryReceipt: string;
    /** Optional hard expiry for this approval; must still cover the task deadline. */
    expiresAt?: string;
  }>;
  replacements?: Array<{ proposal: ReplacementProposalDocument; reference: string; expiresAt: string }>;
  /**
   * Owner-approved model switches. Mirrors the replacements list: only the exact canonical proposal (attempt,
   * generation, previous/requested selection, reason, execution window, profile digest) is approved, and an
   * empty/absent list means no switch can ever be approved or applied.
   */
  modelSwitches?: Array<{ proposal: ModelSwitchProposal; reference: string; expiresAt: string }>;
  /**
   * Owner-authored batch approvals for exact canonical plan proposals, held verbatim like every other grant.
   * An absent or empty list means no plan can ever be approved: the model cannot fabricate one.
   */
  planApprovals?: PlanApprovalDocument[];
  controlTransfer?: { reference: string; expiresAt: string; previousControllerFenced: true };
}

/** A replacement proposal plus the digest of the exact task/tool policy it was approved against. */
export interface ReplacementProposalDocument {
  runId: string;
  taskId: string;
  attemptId: string;
  requested: RequestedRuntime;
  scopeDigest: string;
  inputDigest: string;
  deadlineAt: number;
  originalApproval: string;
}

/** Attempt-independent policy template. The concrete attempt id is bound when a broker is created. */
export interface PolicyTemplate {
  version: 1;
  runId: string;
  authorization: { reference: string; approvedBy: string; expiresAt: string; notBefore?: string };
  targets: WebTarget[];
  exclusions: Exclusion[];
  accounts: ApprovedAccount[];
  grantTemplates: Array<{
    id: string;
    taskId: string;
    role: Role;
    capabilities: Capability[];
    targetIds: string[];
    actions: Action[];
    accountIds: string[];
    expiresAt: string;
    maxCalls: number;
    maxArtifactBytes: number;
  }>;
}

export interface FindingPlan {
  findingId: string;
  taskId: string;
  title: string;
  claim: string;
  state: FindingRecord['state'];
  classification: FindingRecord['classification'];
  limitations: string[];
  /** Exact per-claim receipt selectors; never authority to use evidence outside the accepted packet. */
  evidenceIds?: string[];
  negativeControlEvidenceIds?: string[];
  impact?: string;
}

export interface CoveragePlanEntry extends CoverageItem {
  state: CoverageRecord['state'];
  basis: CoverageRecord['basis'];
  reason: string;
}

export interface VerificationPlan {
  verifierTaskId: string;
  producerTaskId: string;
  findingId: string;
  recipe: LocalReplayRecipe;
  /** Optional per-run deadline for the replay, in milliseconds. */
  maxMs?: number;
}

export type BridgeOperation = 'broker.execute' | 'worker.acceptedInputs' | 'attempt.state' | 'packet.admit' | 'verify.finding' | 'threat-model.read' | 'threat-model.amend' | 'plan.context';

export interface BridgeConfig {
  /** Unix socket path; must live outside every task workspace. */
  socketPath: string;
  /** Vault artifact-root id for controller-authored documents. */
  controllerArtifactRootId: string;
  /** Vault artifact-root id for broker-collected artifacts (the sandbox output root). */
  brokerArtifactRootId: string;
  /** True only for the explicitly acknowledged inert local fixture composition. */
  inertLocalOnly: boolean;
}

/**
 * Owner-approved planner document. Its presence is what wires `p2o_plan` into the default composition; an absent
 * planner fails closed with INTEGRATION_REQUIRED and an invalid one is refused at config validation. Plan tasks
 * execute under this exact tool policy/boundary receipt, and `planApprovals` is the owner's own copy of every
 * approval document that can authorize a batch. An absent or empty list approves nothing.
 */
export interface PlannerConfig {
  toolPolicy: ToolPolicy;
  boundaryReceipt: string;
  role?: Role;
  caps?: Partial<PlanCaps>;
  threatModelCaps?: Partial<ThreatModelCaps>;
  planApprovals?: PlanApprovalDocument[];
}

export interface ApplicationConfig {
  schemaVersion: 1;
  mode: ApplicationMode;
  acknowledgement?: string;
  roots: ApplicationRoots;
  run: RunManifest;
  tasks: GrantedTask[];
  runtime: RuntimeConfig;
  sandbox: SandboxConfig;
  policy: PolicyTemplate;
  bridge: BridgeConfig;
  /** Owner-approved observation checks; a worker can only select one of these, never define one. */
  checks?: ObservationCheck[];
  reporting?: {
    coverage?: CoveragePlanEntry[];
    findings?: FindingPlan[];
    verification?: VerificationPlan[];
  };
  interface?: { perTargetConcurrency?: Record<string, number> };
  /**
   * Owner-approved planner document. Present wires `p2o_plan` into this composition; absent fails closed with
   * INTEGRATION_REQUIRED. Invalid planner content is refused before any run is admitted.
   */
  planner?: PlannerConfig;
  /**
   * [F3] Owner-configured optional capability packs. Nothing here is enabled by default, and every pack is
   * refused unless the configured sandbox qualifies it: `browser` needs the acknowledged host-browser
   * boundary, `proxy` is refused on container, and `fuzz` is qualified on the boundaries the pack documents.
   */
  packs?: PacksConfig;
  /** Optional explicit vault limits (defaults are chosen by the evidence module). */
  vaultLimits?: VaultLimits;
}

/** One authenticated broker observation, as returned to the worker. */
export interface BridgeObservation {
  evidenceId: string;
  kind: string;
  /** Controller-evaluated outcome of the owner-approved check, never a worker claim. */
  outcome?: 'passed' | 'failed' | 'inconclusive';
  data: unknown;
}

/** The worker selects which owner-approved observation to perform; it never supplies inputs or check outcomes. */
export interface BridgeCall {
  observationId: string;
}

/**
 * Owner-approved observation check. The controller executes the owner-approved input, evaluates the expectation
 * over the collected bytes, and mints the receipt. Worker prose, worker test outcomes and worker metadata cannot
 * influence any of it.
 */
export interface ObservationCheck {
  checkId: string;
  taskId: string;
  observationId: string;
  tool: Capability;
  input: JsonValue;
  kind: EvidenceKind;
  classification: Classification;
  summary: string;
  expectation?: ObservationExpectation;
  test?: { purpose: TestReceipt['purpose']; invariant: string; originalPolicy?: boolean; targetId?: string };
  /** Owner-approved claim this observation supports (used for receipt-to-question binding). */
  claim?: string;
  surfaceId?: string;
  actorId?: string;
}

export type ObservationExpectation = PlanObservationExpectation;

/**
 * Run-scoped threat-model context available to a live worker attempt through the authenticated bridge.
 * Read is bounded; amend appends an attributed, size-capped, rate-limited addendum. Absent means the
 * bridge serves no context operation and fails closed.
 */
export interface WorkerContextPort {
  read(attempt: Readonly<AttemptRecord>, payload: unknown): Promise<unknown>;
  amend(attempt: Readonly<AttemptRecord>, payload: unknown, signal: AbortSignal): Promise<unknown>;
}

/**
 * Planner context served to the one owner-approved planner task. It is derived from the owner document and the
 * durable run state: the approved target/account/capability envelope, the candidate task menu with the exact
 * owner observation bindings, the caps ceiling and the plan contract's own rules. It grants no authority and
 * cannot widen the owner document; proposing still requires the owner's batch approval.
 */
export interface PlanContextObservation {
  observationId: string;
  tool: Capability;
  kind: EvidenceKind;
  classification: Classification;
  summary: string;
  requests: number;
  /** Query-free binding the plan may declare; the owner-approved check input is what executes. */
  input: JsonObject;
}

export interface PlanContextTask {
  taskId: string;
  role: Role;
  question: PlanTask['question'];
  surfaceId: string;
  surface: string;
  actor: PlanTask['actor'];
  targetIds: string[];
  skills: string[];
  allowedActions: string[];
  requiredCapabilities: string[];
  dependencies: string[];
  depth: number;
  priority: PlanTask['priority'];
  observations: PlanContextObservation[];
  coverage: PlanCoverageCell[];
}

export interface PlanContextScope {
  /** Stable label for this approved scope (its environment identity). */
  scopeId: string;
  scope: PlanRunRequest['scope'];
  taskIds: string[];
  /** Normalized target keys of this scope's targets: a threat-model draft for this scope must name one. */
  threatModelKeys: string[];
}

export interface PlanContextDocument {
  version: 1;
  runId: string;
  plannerAttemptId: string;
  purposeHint: string;
  inputRevision: string;
  requestedSelection: PlanProposal['provenance']['requestedSelection'];
  scopes: PlanContextScope[];
  targets: PlanTarget[];
  accounts: string[];
  allowedCapabilities: string[];
  allowedActions: string[];
  budgets: PlanRunRequest['budgets'];
  capsCeiling: PlanCaps;
  tasks: PlanContextTask[];
  findings: Array<{ findingId: string; taskId: string; claim: string }>;
  /** Normalized target keys accepted by the threat-model draft. */
  threatModelKeys: string[];
  rules: string[];
  limitations: string[];
}

/** Authenticated planner-context operation served by the composition to the planner attempt only. */
export interface PlannerContextPort {
  context(attempt: Readonly<AttemptRecord>, payload: unknown): Promise<unknown>;
}

export interface WorkerBridge {
  readonly socketPath: string;
  /** Number of authenticated operation calls served (diagnostics only). */
  readonly served: number;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export interface IndependentVerifier {
  /** Producer finding review, built from the accepted packet; required before any replay. */
  producerReview(findingId: string): FindingReview;
  verify(input: {
    findingId: string;
    verifierTaskId: string;
    verifierAttemptId: string;
    recipe: LocalReplayRecipe;
    reviewerId: string;
    maxMs?: number;
    signal?: AbortSignal;
  }): Promise<{ status: 'accepted' | 'returned-for-evidence'; review: FindingReview; evidenceIds: string[]; issues: readonly ContractIssue[] }>;
}

export interface AssessmentArtifacts {
  runId: string;
  report: AssessmentReport;
  markdown: string;
  json: string;
  reviews: HandoffReview[];
  findings: FindingReview[];
  accepted: StoredResult[];
}

export interface AssessmentApplication {
  readonly store: DurableStore;
  readonly supervisor: SupervisorApi;
  readonly vault: EvidenceVault;
  readonly authority: Authority;
  readonly sandbox: ExecutionSandbox;
  readonly config: ApplicationConfig;
  readonly collector: CollectorBridge;
  readonly bridge: WorkerBridge;
  readonly verifier: IndependentVerifier;
  readonly interfaceBackend: ControlBackend;
  readonly runtimes: Record<string, RuntimeAdapter>;
  /** Per-attempt policy; created lazily from the attempt's approved grant template. */
  policyFor(attemptId: string): Policy;
  /** Approved grant identity for the attempt's task. */
  grantIdFor(taskId: string): string;
  brokerFor(attemptId: string): ToolBroker;
  admitApprovedRun(): Promise<RunManifest>;
  admitApprovedTasks(): Promise<TaskManifest[]>;
  collectAccepted(taskId: string): StoredResult | undefined;
  acceptedPacket(taskId: string): HandoffPacket | undefined;
  /** Build the authenticated report artifacts (requires a configured publication bridge). */
  artifacts(runId: string): AssessmentArtifacts;
  /**
   * Composition-owned plan ledger when an owner planner document is configured. The report coverage gate and the
   * worker threat-model context read the same durable state; absent means this composition has no planner.
   */
  readonly planLedger?: PlanLedger;
  /**
   * Owner-document-derived seams of the `/p2o --target` workflow. `createP2OBackend` turns them into the
   * attached `ControlBackend.entry` port (adding the composed backend, the Pi session cwd and the model
   * author); a caller that ignores them simply gets no target workflow.
   */
  readonly entrySeams?: EntrySeams;
  /**
   * [F3/F5] Generated-plan (request-plan) seam, present only when the caller configured one: the hosted planner
   * ledger and the materializer that turns an approved proposal into checks and grants. It grants nothing by
   * itself - authorization still comes from the owner document and the policy/broker path.
   */
  readonly requestPlan?: { readonly ledger: RequestPlanLedger; readonly materialize: typeof materializeRequestPlan };
  /**
   * [F3] The composition-owned pack instances of one attempt: the exact objects the broker dispatches to and the
   * runtime releases. Present only when the owner document enables a pack. This is an operator/test accessor:
   * dispatching to a pack directly bypasses the broker's policy check and the attempt-liveness fence, so it must
   * never be handed to a worker.
   */
  readonly packInstancesFor?: (attemptId: string) => { readonly browser?: BrowserPack; readonly proxy?: ProxyPack };
  close(): Promise<void>;
}

export type { Approval, TaskApproval, AssessmentReport, LocalReplayRecipe, CleanReplayBroker, HandoffReview, FindingReview };

/** Re-exported for compositions that need the exact set of seam types. */
export type ApplicationSeams = {
  authority: Authority;
  supervisor: SupervisorApi;
  vault: EvidenceVault;
  broker: ToolBroker;
  sandbox: ExecutionSandbox;
  policy: Policy;
  backend: ControlBackend;
};
