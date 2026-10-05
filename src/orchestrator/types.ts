import type { Budget, Question, RunManifest, TaskManifest, RequestedRuntime, HandoffPacket, BudgetUsage, CoverageRecord, PlanApproval, PlanApprovalDocument, PlanProposal, RuntimeSelection as ContractSelection } from '../contracts/index.js';
import type { DurableStore, DurableEvent, StoredResult, ReconciliationReport } from '../store/index.js';
import type { RuntimeAdapter, RuntimeHandle, RuntimeHooks, RuntimeKind, RuntimeRequest, ToolPolicy } from '../runtime/types.js';
import type { BudgetJournal } from '../policy/index.js';

export type Role = 'orchestrator' | 'worker' | 'verifier' | 'reporter';
export type Mode = 'managed' | 'plan';
export interface RunAdmission {
  manifest: RunManifest;
  mode: Mode;
  /** Required exact limits for every approved target, including offline inputs. */
  perTargetConcurrency: Record<string, number>;
}
export interface TaskProposal {
  manifest: TaskManifest;
  role: Role;
  /** Accounts, mutable fixtures or other owner-approved serialization domains. */
  exclusiveKeys?: string[];
}

/**
 * One owner-approved plan batch. The proposal is the exact content-addressed document the owner approved; the
 * task list is the pure materialization of that proposal, re-verified by the supervisor. The tool policy and
 * boundary receipt are composition-supplied execution policy and are validated by the same admission rules as
 * ordinary tasks (unrestricted host tools are still refused).
 */
export interface PlanAdmissionBatch {
  proposal: PlanProposal;
  approval: PlanApprovalDocument;
  tasks: TaskProposal[];
  toolPolicy: ToolPolicy;
  boundaryReceipt: string;
  role?: Role;
}

export interface Approval {
  allowed: boolean;
  /** SHA-256 of the exact canonical proposal passed to the authority. */
  digest: string;
  authorizationRef: string;
  approvedBy: string;
  reference: string;
  expiresAt: string;
}
export interface TaskApproval extends Approval {
  toolPolicy: ToolPolicy;
  /** A pinned sandbox receipt; fixture mode must explicitly identify itself as inert. */
  boundaryReceipt: string;
}
export interface ReplacementProposal {
  runId: string;
  taskId: string;
  attemptId: string;
  requested: RequestedRuntime;
  scopeDigest: string;
  inputDigest: string;
  deadlineAt: number;
  /** A new owner approval is needed for checkpoint and replay, not a worker summary. */
  originalApproval: string;
}
export interface ReplacementApproval extends Approval {
  /** Exact approved old attempt. Prevents reuse for another checkpoint. */
  parentAttemptId: string;
}
/**
 * Deterministic profile an approved model switch must stay inside. Provider identity and the thinking ceiling
 * come from the admitted run authorization; model identity widens only through a durable owner-approved switch.
 */
export interface ModelSwitchProfile {
  adapter: string;
  providers: string[];
  models: string[];
  thinkingCeiling: ContractSelection['thinking'];
  requiredCapabilities: string[];
}
export interface ModelSwitchRequest {
  selection: ContractSelection;
  reason: string;
}
export interface ModelSwitchProposal {
  runId: string;
  taskId: string;
  attemptId: string;
  generation: number;
  previous: ContractSelection;
  requested: ContractSelection;
  reason: string;
  /** Execution window facts shown to the approver; the supervisor re-validates them after approval. */
  deadlineAt: number;
  executionEndAt: number;
  profileDigest: string;
}
export interface ModelSwitchApproval extends Approval {
  /** Exact approved attempt. An approval can never be replayed for another attempt. */
  attemptId: string;
}
export interface ModelSwitchDecision {
  version: 1;
  switchId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  generation: number;
  status: 'pending' | 'applied' | 'rejected';
  from: ContractSelection;
  to: ContractSelection;
  reason: string;
  code?: string;
  reasons: string[];
  approvedBy?: string;
  approval?: string;
  replacement?: { previousAttemptId: string; attemptId: string; checkpointId: string; generation: number };
  decidedAt: string;
}
/** A worker-requested discovered subtask. Every field narrows the parent; nothing here grants authority. */
export interface SubtaskRequest {
  question: Question;
  targetIds: string[];
  actor: { id: string; privileges: string[] };
  inputRevision: string;
  role: 'worker' | 'verifier';
  /** Recorded rationale. Never used as authority, budget or scope. */
  reason: string;
  budgets?: Partial<Budget>;
  skills?: string[];
  allowedActions?: string[];
  requiredCapabilities?: string[];
  /** Extra gating inputs, restricted to the parent's own dependency set. */
  dependencyTaskIds?: string[];
}
export interface SubtaskDecision {
  version: 1;
  decisionId: string;
  runId: string;
  parentTaskId: string;
  parentAttemptId: string;
  parentGeneration: number;
  role: Role;
  admitted: boolean;
  code?: string;
  reasons: string[];
  depth: number;
  taskId?: string;
  approval?: string;
  requestDigest: string;
  scopeDigest: string;
  inputDigest: string;
  decidedAt: string;
}
export interface ControlTransfer {
  runId: string;
  previousOwner: string;
  previousToken: string;
  nextOwner: string;
}
export interface ControlApproval {
  allowed: boolean;
  digest: string;
  reference: string;
  previousControllerFenced: true;
}
/** All callbacks are trusted dependencies, never exposed as worker/LLM tool inputs. */
export interface Authority {
  verifyRun(proposal: Readonly<RunAdmission>): Promise<Approval>;
  approveTask(proposal: Readonly<TaskProposal>, run: Readonly<RunManifest>): Promise<TaskApproval>;
  approveReplacement(proposal: Readonly<ReplacementProposal>, run: Readonly<RunManifest>): Promise<ReplacementApproval>;
  /** Optional owner gate for a model switch. Absent means no switch can ever be approved or applied. */
  approveModelSwitch?(proposal: Readonly<ModelSwitchProposal>, run: Readonly<RunManifest>): Promise<ModelSwitchApproval>;
  /** Must independently fence the old supervisor before returning true. No expiry takeover. */
  transferControl?(proposal: Readonly<ControlTransfer>): Promise<ControlApproval>;
  /** Optional owner batch approval for one exact canonical plan proposal. Absent means no plan can be admitted. */
  approvePlan?(proposal: Readonly<PlanProposal>, approval: Readonly<PlanApprovalDocument>, context: { runId: string; now: string }): Promise<PlanApproval>;
}
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
export interface ResultCandidate { packet: unknown; idempotencyKey: string }
export interface ResultCollector {
  /** Non-waiting bounded snapshot; bytes/provenance are admitted by the evidence owner. */
  collect(handle: Readonly<RuntimeHandle>): Promise<ResultCandidate[]>;
}
export interface EventSink { deliver(event: Readonly<DurableEvent>): Promise<void> }
export interface SupervisorOptions {
  /** Private controller-owned directory for durable restart metadata (handles, launches, approvals, receipts). */
  controlRoot: string;
  /** Approved canonical root for per-task private workspaces; required for managed admission. */
  workspaceRoot?: string;
  store: DurableStore;
  authority: Authority;
  /** May be populated after constructing the supervisor to attach runtimeHooks(). */
  runtimes: Record<string, RuntimeAdapter>;
  ownerId?: string;
  reviewerId?: string;
  clock?: Clock;
  results?: ResultCollector;
  events?: EventSink;
  pollMs?: number;
  leaseMs?: number;
  startupTimeoutMs?: number;
  operationTimeoutMs?: number;
  stopReserveMs?: number;
  /** Deterministic tests/CLI can disable background pumping and call tick(). */
  automatic?: boolean;
  /** Default true: durable events are retained in the store and acknowledged without an external sink. */
  ackWithoutSink?: boolean;
  /**
   * No-progress circuit breaker. A live attempt that has never collected one observation (non-runtime/log
   * evidence) and never produced an accepted packet is terminated once it has charged at least
   * `minToolCalls` tool calls and `windowMs` has elapsed since that attempt's progress marker was last seen
   * unchanged. Termination stops the owned runtime, so provider turns stop being charged for a dead plane.
   * `{ windowMs: 0 }` disables the breaker; absolute run/task deadlines and cancellation are unaffected.
   */
  noProgress?: { windowMs?: number; minToolCalls?: number; consecutiveRefusals?: number };
}
export interface RunSnapshot {
  run: RunManifest;
  mode: Mode;
  tasks: TaskManifest[];
  attempts: ReturnType<DurableStore['listAttempts']>;
  results: StoredResult[];
  coverage: CoverageRecord[];
  outstandingLeases: string[];
  draining: boolean;
}
export interface ManagedRun {
  runId: string;
  mode: 'managed';
  wait(): Promise<RunSnapshot>;
  cancel(): Promise<RunSnapshot>;
}
export interface PlanPreview {
  mode: 'plan';
  guarantees: 'unmanaged-no-execution';
  runId: string;
  tasks: Array<{ taskId: string; requested: RequestedRuntime; workspace: string; question: TaskManifest['question']; dependencies: string[]; skills: string[]; allowedActions: string[] }>;
}
export interface WorkerPort {
  readonly identity: { runId: string; taskId: string; attemptId: string; producerId: string; generation: number };
  submit(candidate: ResultCandidate): Promise<StoredResult>;
  proposeChild(proposal: TaskProposal): Promise<TaskManifest>;
  acceptedInputs(): ReadonlyArray<HandoffPacket>;
  /** Deterministic admission of a discovered subtask; rejection is explicit and durably recorded. */
  requestSubtask(request: SubtaskRequest): Promise<SubtaskDecision>;
}
export interface ReplacementResult {
  previousAttemptId: string;
  taskId: string;
  continuity: 'resume' | 'successor';
  checkpointId: string;
  generation: number;
  attemptId?: string;
  successorTaskId?: string;
}
export interface SupervisorApi {
  admitRun(proposal: RunAdmission): Promise<RunManifest>;
  admitTask(proposal: TaskProposal): Promise<TaskManifest>;
  /** Optional IDEMPOTENT batch admission of one owner-approved plan; replay or crash re-admits the same tasks once. */
  admitPlan?(batch: PlanAdmissionBatch): Promise<TaskManifest[]>;
  /** Optional derived private workspace for a task id; required for plan materialization in managed mode. */
  workspaceFor?(taskId: string): string;
  start(runId: string): ManagedRun;
  tick(runId: string): Promise<RunSnapshot>;
  wait(runId: string): Promise<RunSnapshot>;
  cancel(runId: string): Promise<RunSnapshot>;
  recover(runId: string): Promise<ReconciliationReport>;
  replace(attemptId: string, selection: ContractSelection, options?: { continuity?: 'resume' | 'successor' }): Promise<ReplacementResult>;
  /** Owner-approved model switch; validated against the run profile and remaining budget, then applied by replacement. */
  switchModel(attemptId: string, request: ModelSwitchRequest): Promise<ModelSwitchDecision>;
  subtaskDecisions(runId: string): SubtaskDecision[];
  modelSwitches(runId: string): ModelSwitchDecision[];
  modelProfile(runId: string): ModelSwitchProfile;
  /** Release reservations for a call that provably never dispatched; recorded, never a limit widening. */
  releaseBudget(attemptId: string, delta: { reservationId: string; reason: string; refusal: { code: string } }): BudgetUsage;
  snapshot(runId: string): RunSnapshot;
  preview(runId: string): PlanPreview;
  worker(attemptId: string): WorkerPort;
  runtimeHooks(): RuntimeHooks;
  budgetJournal(): BudgetJournal;
  consumeBudget(attemptId: string, delta: Partial<BudgetUsage> & { targetId?: string }): BudgetUsage;
  /** Mint a durable pre-dispatch reservation; its id is the only handle that can release exactly this charge. */
  reserveBudget(attemptId: string, delta: { toolCalls: number; requests?: number; targetId?: string }): { reservationId: string; usage: BudgetUsage };
  flushOutbox(): Promise<{ delivered: number; retried: number }>;
  dispose(): void;
  /** Optional owner-approved handover: stop pumping without aborting owned executions (replacement adoption). */
  handover?(): void;
}
export interface TaskRecord { proposal: TaskProposal; approval: TaskApproval; digest: string }
export interface RunRecord { digest: string; admission: RunAdmission; approval: Approval }
export interface LaunchRecord {
  version: 1;
  runId: string;
  taskId: string;
  attemptId: string;
  /** Durable producing identity of this attempt (distinct from the controller ownership identity). */
  producerId: string;
  leaseToken: string;
  generation: number;
  adapterKind: RuntimeKind;
  keys: string[];
  request: Omit<RuntimeRequest, 'signal'>;
  replacedFrom?: string;
  checkpointId?: string;
  /** Durable switch decision that caused this attempt, when the attempt is a switch replacement. */
  switchId?: string;
  /** Durable discovered-subtask decision this task lineage descends from, when applicable. */
  discoveredFrom?: string;
}
export interface ControlRecord { ownerId: string; token: string; reference: string }
