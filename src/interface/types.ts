import type { RuntimeSelection } from '../contracts/index.js';
import type { TargetEntryPort } from './target-entry.js';

import type { OnboardingReady } from '../application/onboarding/types.js';
/** Owner-gated control requests the interface may forward to the supervisor; the interface mints no authority. */
export interface SwitchModelInput { attemptId: string; selection: RuntimeSelection; reason: string }
export interface SubtaskRequestInput {
  attemptId: string;
  question: { text: string; ifTrue: string; ifFalse: string };
  targetIds: string[];
  actor: { id: string; privileges: string[] };
  inputRevision: string;
  role: 'worker' | 'verifier';
  reason: string;
  budgets?: Record<string, number>;
  skills?: string[];
  allowedActions?: string[];
  requiredCapabilities?: string[];
  dependencyTaskIds?: string[];
}

/**
 * Planner control input. `propose` and `approve` reference files on disk: the proposal packet is planner-authored
 * data and the approval document is owner-authored; this interface never mints, edits or fabricates approval.
 */
export type PlanInput =
  | { action: 'propose'; runId: string; proposalPath: string }
  | { action: 'read'; runId: string; proposalId?: string }
  | { action: 'approve'; runId: string; proposalDigest: string; approvalPath: string };

/** Explicit safety label, never an authority grant or a sandbox claim. Fixture targets are lab
 * fixtures and/or approved read-only source artifacts; web/service targets need assessment mode.
 * A configured application must also enforce its exact mode at preflight and dispatch. */
export type RunMode = 'fixture' | 'assessment';
export interface StartInput {
  manifestPath: string;
  mode: RunMode;
  selection?: RuntimeSelection;
  runtime?: 'headless' | 'herdr';
}
export interface ResumeInput extends StartInput { runId: string }
export interface Page { offset: number; limit: number }
export interface EventPage { afterSequence: number; limit: number }
export interface Issue { code: string; message: string }
export interface Preflight {
  ok: boolean;
  mode: RunMode;
  runId: string;
  requested: { adapter: string; selection: RuntimeSelection };
  issues: Issue[];
  warnings: string[];
}
export interface RunHandle { runId: string; mode: RunMode }
export interface CancellationReceipt {
  runId: string;
  schedulingStopped: boolean;
  terminationVerified: boolean;
  failures: Issue[];
}
/** Raw trusted supervisor data. Projection is mandatory before crossing the interface. */
export interface Snapshot {
  run: unknown;
  tasks: unknown[];
  attempts: unknown[];
  packets: unknown[];
  findings: unknown[];
  coverage: unknown[];
  failures: unknown[];
  mode: RunMode;
}
export interface RecordPage { items: unknown[]; total: number; offset: number }
export interface EventRecord {
  sequence: number;
  eventId: string;
  occurredAt: string;
  type: string;
  taskId?: string;
  attemptId?: string;
  /** Only a trusted redacting collector may opt free text into presentation. */
  display?: { redacted: true; text: string; kind: 'event' | 'log' };
}
export interface Events {
  items: EventRecord[];
  nextSequence: number;
  gap: boolean;
}
/** Native Pi message usage is separate from gateway-bounded worker usage and worker attestation. */
export interface ForegroundUsageReceipt {
  recordId: string; occurredAt: string; provider: string; model: string; thinkingRequested: string;
  basis: 'native-pi-message';
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; costUsd: number | null };
}
export interface Report {
  foregroundUsage?: unknown;
  format: 'json' | 'markdown';
  /** Redacted report data, never raw artifact bytes or filesystem paths. */
  content: unknown;
  /** Controller-owned phase caps/accounting; no additional model call to render a partial report. */
  modelBudget?:
    | { policy: 'isolated-phase-caps-no-borrowing'; phases: Record<import('../policy/budget.js').AutonomousBudgetPhase, Readonly<import('../policy/budget.js').ModelSpendSnapshot>> }
    | { policy: 'informational-durable-no-phase-quotas'; accounting: Readonly<import('../policy/budget.js').ModelSpendSnapshot> };
}
/**
 * This port does not mint authority. start/resume MUST revalidate scope, input identity,
 * deadlines and prerequisites at dispatch, even after a successful preflight.
 * stop/close MUST reach owned runtimes and must not require unexpired scope.
 */
export interface ControlBackend {
  /** Optional read-only integration readiness report. Falls back to preflight when absent. */
  doctor?(input: StartInput | ResumeInput, signal?: AbortSignal): Promise<Preflight>;
  preflight(input: StartInput | ResumeInput, signal?: AbortSignal): Promise<Preflight>;
  start(input: StartInput, signal?: AbortSignal): Promise<RunHandle>;
  resume(input: ResumeInput, signal?: AbortSignal): Promise<RunHandle>;
  stop(runId: string, reason: string): Promise<CancellationReceipt>;
  status(runId: string): Promise<Snapshot>;
  tasks(runId: string, page: Page): Promise<RecordPage>;
  evidence(runId: string, page: Page, evidenceId?: string): Promise<RecordPage>;
  report(runId: string, format: Report['format']): Promise<Report>;
  events(runId: string, page: EventPage): Promise<Events>;
  /** Optional owner-gated model switch; absent fails closed with INTEGRATION_REQUIRED. */
  switchModel?(input: SwitchModelInput): Promise<unknown>;
  /** Optional supervisor-adjudicated subtask request; absent fails closed with INTEGRATION_REQUIRED. */
  requestSubtask?(input: SubtaskRequestInput): Promise<unknown>;
  /** Optional planner port; absent fails closed with INTEGRATION_REQUIRED. Approval always comes from the owner file, never this tool. */
  plan?(input: PlanInput, signal?: AbortSignal): Promise<unknown>;
  /** Optional target-entry workflow for the human `/p2o` command; absent fails closed with INTEGRATION_REQUIRED. */
  entry?: TargetEntryPort;
  /** Host event-only accounting, never a model-callable authority. */
  recordForegroundUsage?(runId: string, receipt: ForegroundUsageReceipt): Promise<void>;
  close(): Promise<void>;
}
/**
 * Mutable, session-scoped author slot owned by `InterfaceController`. A composition reads `current` at
 * plan time instead of capturing the first value, so call ordering never unbinds the session author.
 * The value is opaque to the interface; it is never authority and never a confirmation.
 */
export interface PlanAuthorSlot { current?: unknown }

/**
 * Host-supplied factory context. `planAuthor` is the host session's model-author seam for the target
 * workflow's planning step (`/p2o --target`); it is opaque here on purpose, so the interface layer keeps
 * no dependency on application types. `planAuthorSlot` is the late-binding companion for compositions
 * that build once and plan later. A composition that ignores both leaves `plan` failing closed with
 * `ENTRY_PLAN_AUTHOR_REQUIRED`; neither value is authority and neither is ever a confirmation.
 */
/** Latest owner consent is late-bound just like the model author; never persisted in a model transcript. */
export interface OnboardingSlot { current?: OnboardingReady }
export interface BackendFactoryContext {
  cwd: string;
  planAuthor?: unknown;
  planAuthorSlot?: PlanAuthorSlot;
  /** Owner-authored consent from human UI, validated and persisted before factory construction. */
  onboarding?: OnboardingReady;
  /** Read current at prepare/dispatch if a backend was created earlier by a status/tool call. */
  onboardingSlot?: OnboardingSlot;
  /** Host-only owner storage root; defaults to the shipped location. A fresh-process resume needs it to find
   * the original owner consent bundle without any session-local onboarding value. */
  ownerStorageRoot?: string;
}
export type BackendFactory = (context: BackendFactoryContext) => Promise<ControlBackend> | ControlBackend;
export class InterfaceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'InterfaceError';
  }
}
