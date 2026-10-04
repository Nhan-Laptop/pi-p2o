/**
 * Application-owned types for the `/p2o --target …` workflow (`src/application/entry/**`).
 *
 * The interface-facing declarations (`TargetEntryPort`, `EntryPreparation`, …) are frozen in
 * `src/interface/target-entry.ts`; this module only adds the seams the entry workflow needs from the
 * surrounding composition: the owner-approved run binding, the model-authored plan author, the
 * generated/owner-menu execution adapters and the delegation to the existing supervisor.
 */
import type { PlanProposal, RunManifest, RuntimeSelection } from '../../contracts/index.js';
import type { PlanRequestEnvelope, PlanRequestProposal } from '../../contracts/plan-request.js';
import type { ControlBackend } from '../../interface/types.js';
import type {
  EntryDepth, EntryHumanApproval, EntryPlan, EntryPreparation, EntryTargetKind,
} from '../../interface/target-entry.js';

/** Failure codes are deliberately explicit; see `errors.ts`. */
export type { EntryFailureCode } from './errors.js';

// ---------------------------------------------------------------------------------------------
// Binding: what the composition tells the entry workflow about the owner-approved run.
// ---------------------------------------------------------------------------------------------

/**
 * One owner-approved target identity from the run authorization, plus the actions/accounts the owner
 * bound to it. The entry workflow may only narrow these; it never invents a target.
 */
export interface EntryApprovedTarget {
  targetId: string;
  kind: 'artifact' | 'web' | 'service' | 'lab';
  locator: string;
  /** Artifact pin: when present, the observed content digest must match exactly. */
  digest?: string;
  /** Artifact pin: when present, the observed revision must match exactly (e.g. a git commit). */
  revision?: string;
  /** Owner-approved action verbs for this target (e.g. `read`, `analyze`); entry never adds one. */
  actions: string[];
  /** Owner-approved account ids bound to this target. */
  accounts: string[];
}

/** One owner-approved observation a plan may *select* (never author). */
export interface EntryOwnerObservation {
  taskId: string;
  observationId: string;
  tool: string;
  summary: string;
  targetIds: string[];
  capabilities: string[];
  actions: string[];
}

/**
 * The owner-approved run the entry workflow binds one `--target` invocation to. Everything here is
 * owner-authored: the entry workflow validates against it and narrows, but never widens or mints it.
 */
export interface EntryRunBinding {
  /** Existing composed backend; the entry workflow delegates run lifecycle to it. */
  backend: ControlBackend;
  /** Canonical absolute path of the owner-approved `RunManifest` document the backend validates. */
  manifestPath: string;
  /** Mode the owner document is configured for; the entry workflow never invents a mode. */
  mode: 'fixture' | 'assessment';
  /** Parsed owner-approved run document. */
  run: RunManifest;
  /** Owner-approved target identities of this run. */
  approvedTargets: EntryApprovedTarget[];
  /** Owner-approved observation menu (`ApplicationConfig.checks`); empty means no owner-menu plan path. */
  ownerObservations: EntryOwnerObservation[];
  /** Controller-derived owner envelope for generated HTTP requests; absent disables that path. */
  requestEnvelope?: PlanRequestEnvelope;
  /** Runtime selection override for the delegated launch; informational, never authority. */
  selection?: RuntimeSelection;
}

// ---------------------------------------------------------------------------------------------
// Model-authored planning seam.
// ---------------------------------------------------------------------------------------------

export type EntryTechnique = 'source.analyze' | 'http.request';

/** Bounded facts about what preparation actually observed; never raw target bytes or secrets. */
export interface EntryPlanFacts {
  targetKind: EntryTargetKind;
  locator: string;
  /** Owner target identity the observed locator was matched against. */
  targetId: string;
  digest?: string;
  revision?: string;
  /** Relative paths sampled from the read-only view, already filtered for secrets; bounded. */
  samplePaths: string[];
  /** Owner-approved observations the plan may select. */
  ownerObservations: EntryOwnerObservation[];
  /** Owner-approved generated-request host tasks (taskId + target ids). */
  generatedTasks: Array<{ taskId: string; targetIds: string[] }>;
  /** Owner-approved accounts and action/capability envelope for generated requests. */
  accounts: string[];
  allowedActions: string[];
  allowedCapabilities: string[];
  /** Exact limits the author must respect. */
  limits: { maxSteps: number; maxStepChars: number; maxSelections: number; maxGeneratedRequests: number };
}

export interface EntryPlanAuthorInput {
  preparation: EntryPreparation;
  /** Owner-reviewed purpose text from argv; bounded data, never authority. */
  purpose?: string;
  /** Requested depth; narrows the skill list only. */
  depth: EntryDepth;
  facts: EntryPlanFacts;
  /** Technique-first routing decided by target kind, never by prose or mode words. */
  techniques: EntryTechnique[];
  /** Portable skill ids selected for the technique and depth. */
  skills: string[];
  /** Which plan flavours this composition can actually execute today (absent = both requested). */
  available?: { ownerMenu: boolean; generatedRequests: boolean };
}

export interface EntryOwnerSelection { taskId: string; observationId: string }

export type EntryPlanPacket =
  | { kind: 'owner-menu'; proposal: PlanProposal }
  /** A bounded model selection; the composition expands it into a full owner-data `PlanProposal`. */
  | { kind: 'owner-menu-selection'; selection: EntryOwnerSelection[] }
  | { kind: 'generated-requests'; proposal: PlanRequestProposal };

/**
 * A model-authored (or, in tests, fixture-authored) plan. `authoredBy: 'model'` is refused by the
 * production factory when a fixture author is the source, so a hardcoded lab menu can never masquerade
 * as target planning.
 */
export interface EntryPlanAuthorOutput {
  authoredBy: 'model' | 'fixture';
  /** Bounded provenance label for receipts/diagnostics; never authority. */
  attemptId: string;
  steps: string[];
  packet: EntryPlanPacket;
  notes?: string[];
}

/** The Pi/planner runtime seam. Production must bind a real model author; tests may bind a fixture. */
export interface EntryPlanAuthor {
  author(input: EntryPlanAuthorInput, signal?: AbortSignal): Promise<EntryPlanAuthorOutput>;
}

// ---------------------------------------------------------------------------------------------
// Execution adapters: reuse the existing planner/generated-request APIs; never mint approval.
// ---------------------------------------------------------------------------------------------

export interface EntryPlanExecutionProposeInput {
  packet: EntryPlanPacket;
  preparation: EntryPreparation;
}

export interface EntryPlanExecutionCompletion {
  proposalId: string;
  proposalDigest: string;
  taskIds: string[];
  observationIds: string[];
}

export interface EntryPlanExecutionCompleteInput {
  preparation: EntryPreparation;
  plan: EntryPlan;
  approval: EntryHumanApproval;
  proposalId: string;
  proposalDigest: string;
  /** Observed post-approval target acquisition identity, when one was made. */
  acquisition?: EntryAcquisition;
}

/**
 * Composition-owned execution adapter for one plan flavour. `propose` validates/stores the
 * model-authored packet without touching the target; `authorize` re-reads the exact owner approval
 * artifact and runs the existing owner gate *before* any clone or target request; `complete` re-checks
 * that gate (idempotently) and then materializes/registers. It never fabricates approval: the owner
 * document is read from an owner-authored path and verified by the existing ledger.
 */
export interface EntryPlanExecution {
  readonly kind: EntryPlanPacket['kind'];
  available(): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  propose(input: EntryPlanExecutionProposeInput): Promise<{ proposalId: string; proposalDigest: string }>;
  /**
   * Owner-gate the sealed proposal against its approval artifact; no target I/O and no materialization.
   * Optional only for test doubles; every production adapter implements it and the port calls it before
   * acquisition so an expired, foreign or mutated proposal is refused before any network or clone.
   */
  authorize?(input: EntryPlanExecutionCompleteInput): Promise<void>;
  complete(input: EntryPlanExecutionCompleteInput): Promise<EntryPlanExecutionCompletion>;
}

// ---------------------------------------------------------------------------------------------
// Target acquisition (post-approval only) and delegation to the existing supervisor backend.
// ---------------------------------------------------------------------------------------------

export interface EntryAcquisition {
  kind: EntryTargetKind;
  /** Canonical locator of what was acquired (snapshot root, clone root or the normalized URL). */
  locator: string;
  revision?: string;
  digest?: string;
  /** Always true: entry never mounts or copies the target writable. */
  readOnly: true;
  files?: number;
  bytes?: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// Owner approval artifact minting (controller-side, from a consumed human confirmation).
// ---------------------------------------------------------------------------------------------

/**
 * One exact owner approval artifact to create for a sealed proposal. The port derives every field from the
 * stored plan record and the owner run document; `approvalRef`/`approvedAt` come from the consumed human
 * confirmation capability and are never model input.
 */
export interface EntryApprovalMintRequest {
  kind: 'plan' | 'request';
  runId: string;
  proposalId: string;
  proposalDigest: string;
  approvalRef: string;
  approvedAt: string;
  /** Always at or before the owner authorization window and run deadline, and after `approvedAt`. */
  expiresAt: string;
  requestCount?: number;
  taskCount?: number;
  observationCount?: number;
}

/**
 * Composition-owned approval artifact store. `exists` answers whether an owner-authored document already
 * covers this exact proposal digest (preserved for headless workflows); `write` atomically creates the
 * owner-only document and refuses to overwrite a different one. Neither method verifies authority: the
 * existing owner ledger gate remains the only decision maker.
 */
export interface EntryApprovalPort {
  exists(kind: 'plan' | 'request', proposalDigest: string): Promise<boolean>;
  write(request: EntryApprovalMintRequest): Promise<{ path: string; reused: boolean }>;
}

export interface EntryDelegationInput {
  preparation: EntryPreparation;
  plan: EntryPlan;
  approval: EntryHumanApproval;
  acquisition: EntryAcquisition;
  completion?: EntryPlanExecutionCompletion;
}

export interface EntryDelegationPreflight {
  ok: boolean;
  runId: string;
  issues: Array<{ code: string; message: string }>;
  warnings: string[];
}
export interface EntryDelegationPreflightInput {
  preparation: EntryPreparation;
  plan: EntryPlan;
  approval: EntryHumanApproval;
}

export interface EntryDelegationPort {
  /** Read-only readiness re-check over the existing backend; never admits or launches. */
  preflight(input: EntryDelegationPreflightInput): Promise<EntryDelegationPreflight>;
  /** Admit + launch through the existing supervisor backend; returns the observed run state. */
  delegate(input: EntryDelegationInput): Promise<{ runId: string; state: string }>;
  /** Resume one known run through the existing supervisor backend after entry-side re-checks. */
  resume(input: { runId: string; preparation: EntryPreparation; plan?: EntryPlan }): Promise<{ runId: string; state: string }>;
}

// ---------------------------------------------------------------------------------------------
// Bounds and diagnostics.
// ---------------------------------------------------------------------------------------------

export interface EntryBounds {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxPathChars: number;
  maxDepth: number;
  maxSamplePaths: number;
}

export const ENTRY_BOUNDS_DEFAULTS: Readonly<EntryBounds> = Object.freeze({
  maxFiles: 20_000,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 250 * 1024 * 1024,
  maxPathChars: 512,
  maxDepth: 32,
  maxSamplePaths: 64,
});

/** Observer seam: tests prove "no target I/O" and "no action before approval" by counting events. */
export interface EntryObserver {
  io?(event: { kind: 'stat' | 'readdir' | 'read' | 'copy' | 'clone' | 'spawn'; locator: string }): void;
  decision?(event: { step: string; code?: string; detail?: string }): void;
}

export interface EntryCommandResult { code: number; stdout: string; stderr: string }

/** Bounded process seam; the default uses `spawn` with an argv array and no shell. */
export interface EntryCommandRunner {
  run(input: {
    file: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
  }): Promise<EntryCommandResult>;
}

/** Low-level factory options. The production factory (`createApplicationEntryPort`) fills these in. */
export interface TargetEntryOptions {
  /** Static binding or a provider re-read per call (the composition owns the owner document). */
  binding: EntryRunBinding | (() => Promise<EntryRunBinding>);
  /** Absolute canonical root for private snapshots/clones/plan records; outside every target. */
  workspaceRoot: string;
  /** Working directory used to resolve relative local targets (the Pi session cwd). */
  cwd: string;
  planAuthor?: EntryPlanAuthor;
  /**
   * Composition-owned expansion of a model-authored owner-menu selection into a full `PlanProposal`.
   * The model selects ids; the composition builds the packet from owner data only. Absent means the
   * owner-menu-selection flavour fails closed with `ENTRY_OWNER_MENU_UNSUPPORTED`.
   */
  buildOwnerMenuProposal?(input: {
    selection: EntryOwnerSelection[];
    preparation: EntryPreparation;
    binding: EntryRunBinding;
    targetId: string;
  }): Promise<{ proposal: PlanProposal; steps?: string[] }>;
  /** Execution adapters by plan flavour; a missing flavour makes that plan fail explicitly. */
  executions?: Partial<Record<EntryPlanPacket['kind'], EntryPlanExecution>>;
  /** Delegation to the existing supervisor backend; defaults to `createBackendDelegation(binding)`. */
  delegation?: EntryDelegationPort;
  bounds?: Partial<EntryBounds>;
  /**
   * Composition-owned owner approval artifact store. When absent the port can only consume externally
   * authored documents (or a test double that verifies nothing), never mint one.
   */
  approvals?: EntryApprovalPort;
  /** How long a controller-minted approval stays valid; clamped to the owner window and run deadline. */
  approvalTtlMs?: number;
  clock?: () => number;
  newId?: () => string;
  /** Test seam: allow an author that self-reports `authoredBy: 'fixture'`. Production never sets this. */
  allowFixtureAuthor?: boolean;
  /** Test seam: process runner for git; the default spawns `git` with a sanitized environment. */
  commandRunner?: EntryCommandRunner;
  /** Test seam: git binary path. */
  gitBinary?: string;
  observer?: EntryObserver;
}

export interface StoredEntryPlan {
  version: 1;
  planId: string;
  runId: string;
  digest: string;
  scopeDigest: string;
  mode: 'fixture' | 'assessment';
  manifestPath: string;
  preparation: EntryPreparation;
  plan: EntryPlan;
  packet: EntryPlanPacket;
  proposalId: string;
  proposalDigest: string;
  createdAt: string;
}

export interface EntryPlanStore {
  save(record: StoredEntryPlan): Promise<void>;
  read(planId: string): Promise<StoredEntryPlan | null>;
  /** Returns the runId of a stored admission, or null; never overwrites an existing admission. */
  admitted(planId: string): Promise<{ runId: string } | null>;
  /** Marks an admission once-only; false when this plan was already admitted. */
  markAdmitted(planId: string, runId: string): Promise<boolean>;
  /** Distinct admitted runs, newest first, for unambiguous current-run selection. */
  runs(): Promise<Array<{ runId: string; planId: string; targetKind: EntryTargetKind; startedAt: string }>>;
}
