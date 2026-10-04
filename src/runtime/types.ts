import type { ChildProcess } from "node:child_process";
import type { ModelPriceTable, ModelSpendJournal, ModelSpendBudget } from "../policy/budget.js";

export type RuntimeKind = "headless" | "herdr" | "plan";
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface RuntimeSelection { provider: string; model: string; thinking: Thinking }
export interface ApprovedExtension {
  /** Absolute entry point. Approval covers its dependencies, not merely this file. */
  path: string;
  sha256: string;
  approval: string;
}
export type ToolPolicy =
  | { mode: "trusted-fixture"; allowUnsandboxedHostTools: true; tools: string[] }
  | { mode: "sandbox-extension"; extension: ApprovedExtension; boundaryId: string; tools: string[] };
export interface RuntimeRequest {
  runId: string;
  taskId: string;
  attemptId: string;
  workspace: string;
  scopeDigest: string;
  inputDigest: string;
  deadlineAt: number;
  prompt: string;
  requested: RuntimeSelection;
  toolPolicy: ToolPolicy;
  signal?: AbortSignal;
}
export interface RuntimeCapabilities {
  ownsLifecycle: boolean;
  canHardStop: boolean;
  canResume: boolean;
  streamsEvents: boolean;
  attestsRuntime: boolean;
  checkpoints: boolean;
  /** A caller-verified tool boundary can be required; this is NOT a sandbox audit. */
  sandboxBoundTools: boolean;
}
export interface PreflightReceipt {
  ok: boolean;
  kind: RuntimeKind;
  checkedAt: number;
  capabilities: RuntimeCapabilities;
  errors: string[];
  warnings: string[];
  versions?: { pi: string; herdr?: string; protocol?: number };
  boundaryReceipt?: string;
}
export type RuntimeStatus = "starting" | "ready" | "prompt-delivered" | "running" | "settled" |
  "completed" | "failed" | "cancelled" | "timed-out" | "stopped" | "quarantined" | "unmanaged";
export interface ProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  startTicks: string;
  bootId: string;
  state: string;
}
export interface ProcessRow extends ProcessIdentity { argv: string[] }
export interface ProcessProbe {
  snapshot(): Promise<ProcessRow[]>;
  signal(pidOrGroup: number, signal: "SIGTERM" | "SIGKILL"): void;
  /** Cost of the last completed inventory, when the probe can report it. Termination verification
   *  sizes its bounded late-cancellation window from this measured cost instead of a fixed guess. */
  lastSnapshotMs?(): number;
}
export interface RuntimeReceipt {
  source: "rpc-state" | "pi-event";
  event: string;
  at: number;
  provider: string;
  model: string;
  /** Assistant response events alone do not attest thinking. */
  thinking?: Thinking;
  matchesRequest: boolean;
}
export interface RuntimeEvent { cursor: number; at: number; type: string; text: string }
export interface StopReceipt {
  reason: "cancelled" | "timed-out" | "stopped" | "checkpoint" | "completed" | "failed";
  at: number;
  verified: boolean;
  survivors: ProcessIdentity[];
  error?: string;
}
/**
 * [B4] One attempt's session scope: the identity every pack binds its sessions to. A pack session may
 * only ever be created, used and released under the attempt that owns it.
 */
export interface SessionScope { runId: string; taskId: string; attemptId: string }
/**
 * [B4] Owner of a durable session lease. The `process` identity (never a bare pid) is what lets a
 * restarted controller tell a crashed owner from a live one without signalling a recycled pid.
 */
export interface SessionLeaseOwner { instance: string; token: string; process: ProcessIdentity; at: number }
/** Bounded durable inventory: an empty responder cannot erase an enrolled resource. */
export interface SessionResourceRecord {
  pack: string; id: string; state: "active" | "resolved"; data: Record<string, unknown>;
}
/** Session release is invoked on every attempt termination path, including crash reconciliation. */
export type SessionReleaseReason = StopReceipt["reason"] | "quarantined" | "crash-recovery";
/** Result of ONE pack's release attempt. `outstanding` is only present when the pack can attribute it. */
export interface SessionReleaserResult {
  name: string;
  outcome: "released" | "already-released" | "failed";
  /** Live sessions the pack killed for this attempt, when it reports them. */
  released?: number;
  /** Live sessions the pack still attributes to the attempt after its release; absent = cannot attribute. */
  outstanding?: number;
  error?: string;
  ms: number;
}
/**
 * [B4] Durable receipt of one attempt's session release. `verified` is true only when every registered
 * pack released without failure and no pack reported a surviving session; anything else is recorded on
 * the attempt handle and in its event ring, never swallowed into a clean termination.
 */
export interface SessionReleaseReceipt {
  version: 1;
  scope: SessionScope;
  attemptKey: string;
  reason: SessionReleaseReason;
  at: number;
  state: "released" | "already-released" | "failed" | "orphaned";
  verified: boolean;
  /** Sum of every reported surviving session; 0 also when no pack can attribute them (see `releasers`). */
  outstanding: number;
  /** True when this call reused the durable result of an earlier, verified release (idempotent no-op). */
  duplicate: boolean;
  releasers: SessionReleaserResult[];
  /** Bounded wall time the whole release consumed. */
  ms: number;
  /**
   * Bounded note about the verdict itself: a release that could not be made durable, a lease that could
   * not be read, or an attempt that never leased. Never a substitute for `verified`.
   */
  evidenceNote?: string;
}
/** What one stale lease's crash-recovery sweep did. `unverifiable` is never reported as clean. */
export interface SessionSweepEntry {
  attemptKey: string;
  scope: SessionScope;
  state: "swept" | "skipped-live-owner" | "unverifiable" | "already-sealed";
  released?: number;
  outstanding?: number;
  error?: string;
}
/** Durable result of one restart sweep over unsealed session leases. */
export interface SessionSweepReceipt {
  version: 1;
  at: number;
  scanned: number;
  stale: number;
  swept: number;
  skipped: number;
  unverifiable: number;
  entries: SessionSweepEntry[];
  /** True when every stale lease was provisionally or fully resolved and no orphan remains unresolved. */
  verified: boolean;
}
/**
 * [B4] Pack-agnostic session releaser. A pack registers one of these with the runtime; the runtime calls
 * it on attempt completion, verified stop, deadline expiry, cancellation, quarantine and crash
 * reconciliation. Implementations must be idempotent (a second release of the same attempt is a no-op)
 * and must not await anything unbounded.
 */
export interface SessionReleaser {
  readonly name: string;
  /** Explicit composition declaration; legal only when this family owns no resources. */
  readonly ownsNoResources?: true;
  /** Kill every session bound to this attempt; returns the number of live sessions killed if known. */
  release(scope: SessionScope): Promise<number | void>;
  /** Live sessions still attributable to the attempt; absent when the pack cannot attribute them. */
  outstanding?(scope: SessionScope): number | undefined | Promise<number | undefined>;
  /**
   * Crash recovery for a lease whose owning controller is dead (restart sweep). Only a pack that can
   * identify its own sessions from durable pid/profile files implements this; without it a stale lease
   * is durably reported as `unverifiable`, never as clean.
   */
  sweep?(scope: SessionScope, owner: SessionLeaseOwner): Promise<number | void>;
  /** Graceful controller exit: the pack closes every session it still holds. */
  shutdown?(): Promise<void>;
}
/** Hard bounds for session release; a missed bound is durable evidence, never a hang. */
export interface SessionReleaseOptions {
  releasers?: readonly SessionReleaser[];
  /** Bound for ONE releaser call (default 2000 ms). */
  timeoutMs?: number;
  /** Bound for the whole release/sweep across every registered pack (defaulting to 4 calls). */
  totalTimeoutMs?: number;
}
export interface RuntimeHandle {
  version: 1;
  kind: RuntimeKind;
  runId: string;
  taskId: string;
  attemptId: string;
  ownerToken: string;
  workspace: string;
  scopeDigest: string;
  inputDigest: string;
  deadlineAt: number;
  requested: RuntimeSelection;
  toolPolicy: ToolPolicy;
  createdAt: number;
  status: RuntimeStatus;
  controlDir: string;
  sessionFile: string;
  sessionId: string;
  launchIntent: boolean;
  native: { guardian?: ProcessIdentity; processes: ProcessIdentity[]; paneId?: string; agentName?: string; paneTerminalId?: string };
  observed: RuntimeReceipt[];
  events: RuntimeEvent[];
  nextCursor: number;
  logTail: string;
  droppedLogBytes: number;
  startupError?: string;
  exit?: { code: number | null; signal: string | null };
  stopReceipt?: StopReceipt;
  /** Supervisor-owned mandatory partial/failure semantics; never a worker completion assertion. */
  budgetOutcome?: { outcome: "partial" | "failed"; reason: string; at: number; extensionRequired: boolean };
  provenance?: { checkpointId: string; parentAttemptId: string; parentSessionId: string; sessionDigest: string };
  /** [B4] Durable session-release verdict for this attempt (idempotent, bounded, never swallowed). */
  sessionRelease?: SessionReleaseReceipt;
  plan?: { tool: "herd_spawn"; arguments: { role: string; task: string; model: string }; guarantees: "unmanaged" };
}
export interface ObserveOptions { cursor?: number; limit?: number; waitMs?: number }
export interface RuntimeObservation {
  status: RuntimeStatus;
  events: RuntimeEvent[];
  cursor: number;
  gap: boolean;
  requested: RuntimeSelection;
  observed: RuntimeReceipt[];
  startupError?: string;
}
export interface RuntimeCollection {
  handle: RuntimeHandle;
  outcome: RuntimeStatus;
  logTail: string;
  droppedLogBytes: number;
  requested: RuntimeSelection;
  observed: RuntimeReceipt[];
  resultAcceptance: "not-evaluated";
}
export interface RuntimeCheckpoint {
  version: 1;
  id: string;
  createdAt: number;
  handle: RuntimeHandle;
  session: { path: string; sha256: string; id: string; bytes: number };
  termination: StopReceipt;
  restoredToolProcesses: false;
}
export interface CheckpointOptions { /** Controller-authored note, not an agent-authored summary. */ note?: string }
export interface StopOptions { reason?: StopReceipt["reason"]; /** May shorten, never extend, the original deadline. */ deadlineAt?: number }
export interface ReconciliationReceipt {
  state: "live" | "terminated" | "quarantined" | "unmanaged";
  handle: RuntimeHandle;
  explanation: string;
}
export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly capabilities: RuntimeCapabilities;
  preflight(request: RuntimeRequest): Promise<PreflightReceipt>;
  start(request: RuntimeRequest): Promise<RuntimeHandle>;
  observe(handle: RuntimeHandle, options?: ObserveOptions): Promise<RuntimeObservation>;
  checkpoint(handle: RuntimeHandle, options?: CheckpointOptions): Promise<RuntimeCheckpoint>;
  stop(handle: RuntimeHandle, options?: StopOptions): Promise<StopReceipt>;
  resume(checkpoint: RuntimeCheckpoint, request: RuntimeRequest): Promise<RuntimeHandle>;
  collect(handle: RuntimeHandle): Promise<RuntimeCollection>;
  reconcile(handle: RuntimeHandle): Promise<ReconciliationReceipt>;
}
/** Store integrations must implement atomic workspace claims and token-checked persistence/release. */
export interface RuntimeHooks {
  claim(handle: RuntimeHandle): Promise<boolean>;
  release(handle: RuntimeHandle): Promise<void>;
  persistHandle(handle: RuntimeHandle): Promise<void>;
  loadHandle(identity: Pick<RuntimeHandle, "runId" | "taskId" | "attemptId">): Promise<RuntimeHandle | undefined>;
  emit(handle: RuntimeHandle, event: RuntimeEvent): Promise<void>;
  validateResume(checkpoint: RuntimeCheckpoint, request: RuntimeRequest): Promise<boolean>;
}
/** No keys, host auth files, arbitrary headers, shell substitutions, or ambient environment. */
export interface ModelGateway {
  approval: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  models: Array<{
    id: string;
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    /** Owner-pinned chat API dialect. Never selected by worker JSON. */
    completionTokenField?: "max_tokens" | "max_completion_tokens";
    thinkingLevelMap?: Partial<Record<Thinking, string | null>>;
  }>;
}
export interface CommandResult { stdout: string; stderr: string; code: number | null }
export interface CommandOptions { env: Record<string, string>; deadlineAt: number; signal?: AbortSignal; maxBytes: number }
export type CommandRunner = (binary: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;
export type SpawnWorker = (binary: string, args: readonly string[], options: {
  cwd: string; env: Record<string, string>; detached: true; stdio: ["pipe", "pipe", "pipe"];
}) => ChildProcess;
export interface RuntimeDependencies {
  now(): number;
  /** Monotonic millisecond clock. Absolute deadlines stay epoch-shaped, but no wait may be extended
   *  or shortened by a wall-clock step: see `Deadline`. */
  monoNow?(): number;
  sleep(ms: number): Promise<void>;
  spawn: SpawnWorker;
  command: CommandRunner;
  processes: ProcessProbe;
}
export interface ManagedRuntimeOptions {
  /** Private controller-owned directory outside every worker workspace. */
  controlRoot: string;
  /** Absolute, trusted executables. */
  piBinary: string;
  nodeBinary?: string;
  /** Compiled guardian.js and pi-receipts.js (or explicitly approved Pi-loadable TS entry). */
  guardianPath?: string;
  receiptExtensionPath?: string;
  piVersion?: string;
  gateway: ModelGateway;
  hooks?: RuntimeHooks;
  dependencies?: Partial<RuntimeDependencies>;
  verifySandbox?: (policy: Extract<ToolPolicy, { mode: "sandbox-extension" }>, request: RuntimeRequest) => Promise<string | undefined>;
  startupTimeoutMs?: number;
  stopGraceMs?: number;
  pollMs?: number;
  limits?: { logBytes?: number; events?: number; eventBytes?: number; frameBytes?: number; sessionBytes?: number };
  /**
   * [T3] Supervisor-owned model spend ledger input. The composition supplies the owner-approved run
   * limits and the durable journal; the runtime creates and binds the ledger before any dispatch.
   */
  spend?: ModelSpendRuntimeOptions;
  /**
   * [T3] Optional per-task phase resolution. A composition that runs one protected phase per task on the same
   * adapter (for example an owner-approved verifier task inside the protected verifier pool) resolves that
   * task's ledger here; every other attempt keeps using `spend`. Absent, behaviour is unchanged.
   */
  spendByTask?: (taskId: string) => ModelSpendRuntimeOptions | undefined;
  /**
   * [B4] Pack-agnostic session lifetime: packs register a releaser here and the runtime calls it on
   * every attempt termination path. A run without an entry keeps the pre-existing behaviour.
   */
  sessions?: SessionReleaseOptions;
}
export interface ModelSpendRuntimeOptions {
  limits: { maxTokens: number; maxCostUsd: number };
  /** Finite phase-wide admission count (persisted in ledger policy digest); not replenished on restart. */
  maxTurns?: number;
  /** Optional allocation selection pin; a worker cannot spend another phase's model allocation. */
  selection?: RuntimeSelection;
  journal?: ModelSpendJournal;
  /** Trusted shared phase ledger from createAutonomousPhaseBudgets; do not create one per worker. */
  ledger?: ModelSpendBudget;
  /** Explicit fresh-run admission when the durable journal holds no prior state for the run. */
  freshRun?: boolean;
  /** Launch input estimate; gateway admits every actual transmitted body separately using its labeled estimation policy. */
  inputTokensUpperBound?: number;
  /** Supervisor completion ceiling; defaults to min(4096, remaining launch token headroom). */
  maxOutputTokens?: number;
  prices?: ModelPriceTable;
}
export interface HerdrRuntimeOptions extends ManagedRuntimeOptions {
  herdrBinary: string;
  herdrVersion?: string;
  parentPaneId: string;
  /** Explicit routing metadata; no copying process.env. Requires local same-host server. */
  context: { HERDR_ENV: "1"; HERDR_SOCKET_PATH: string; HERDR_PANE_ID: string };
}
export interface WorkerConfig {
  version: 1;
  token: string;
  controlDir: string;
  workspace: string;
  deadlineAt: number;
  stopGraceMs: number;
  piBinary: string;
  args: string[];
  env: Record<string, string>;
  sessionFile: string;
  requested: RuntimeSelection;
  toolPolicy: ToolPolicy;
  receiptFile: string;
  journalFile: string;
}
export interface GuardianJournal {
  token: string;
  guardian: ProcessIdentity;
  processes: ProcessIdentity[];
  updatedAt: number;
  finished?: boolean;
  exit?: { code: number | null; signal: string | null };
  termination?: StopReceipt;
  error?: string;
}
export interface PiReceiptFile {
  token: string;
  seq: number;
  ready: boolean;
  error?: string;
  /** [T3] Provider-reported usage the Pi worker observed; the spend ledger settles from this, never from worker JSON. */
  events: Array<{ seq: number; at: number; type: string; selection?: RuntimeSelection; assistant?: { provider: string; model: string; stopReason: string; errorMessage?: string }; usage?: { inputTokens: number; outputTokens: number; reportedCostUsd?: number }; idle?: boolean }>;
}
