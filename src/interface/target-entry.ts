/**
 * Target-entry port — the application-owned workflow behind `/p2o --target …`.
 *
 * The interface classifies the argv target and drives this port; the port owns resolution, snapshot/clone,
 * planning, admission and delegation. The declarations here are the frozen contract requested in
 * `/tmp/p2o-entry-contract.md`; implementations live under `src/application/entry/**`.
 *
 * Authority rules enforced by `src/interface/command.ts` and `src/application/entry/port.ts`:
 *   * `prepare` and `plan` must issue **zero** target requests and must never spawn a worker.
 *   * `start` and `approve` are only reachable from the human `/p2o` command after an interactive
 *     confirmation. The confirmation mints a non-serializable single-use capability bound to the exact
 *     run/scope/plan; a JSON field or replayed `human-command` string never starts a run.
 *   * The exact owner approval artifact for the sealed proposal is minted controller-side from that
 *     capability, inside the pre-existing owner authorization window, and is then still verified by the
 *     existing owner ledger gate before any clone, target request or delegation.
 *   * No `p2o_*` tool can reach this port.
 */
import type { HumanConfirmationCapability } from './human-approval.js';

export type EntryTargetKind = 'local-dir' | 'github-repo' | 'http-url';

export interface EntryTarget {
  kind: EntryTargetKind;
  /** Exactly the argv value, trimmed of outer whitespace; never rewritten. */
  raw: string;
  /** Resolver-owned canonical locator: absolute local path | canonical https repo URL | normalized http(s) URL. */
  locator: string;
  /** Optional immutable revision observed during preparation (e.g. resolved git commit). */
  revision?: string;
  /** Optional digest of what was actually read during preparation. */
  digest?: string;
}

export type EntryDepth = 'quick' | 'standard' | 'deep';

export interface EntryPrepareInput {
  target: EntryTarget;
  purpose?: string;
  depth: EntryDepth;
  planOnly: boolean;
  budgetUsd?: number;
  concurrency?: number;
}

export interface EntrySpend {
  maxCostUsd: number;
  maxRequests: number;
  maxTokens: number;
  maxToolCalls: number;
  maxAttempts: number;
  deadlineMs?: number;
}

export interface EntryPreparation {
  /** Reserved run identity. prepare() launches nothing and reserves nothing in the supervisor. */
  runId: string;
  target: EntryTarget;
  /** Explicit, never inferred from prose. Displayed for human review. */
  mode: 'fixture' | 'assessment';
  scopeDigest: string;
  /** Exact action allowlist the human reviews and approves. */
  actions: string[];
  spend: EntrySpend;
  concurrency: number;
  warnings: string[];
  /** Must be literal true; the interface refuses to start without one. */
  requiresHumanApproval: true;
  /** Evidence that prepare() issued no request to the target (including no clone/fetch). Must be 0. */
  targetRequests: 0;
  planOnly: boolean;
}

export interface EntryPlanInput { preparation: EntryPreparation }

/**
 * The one finite step bound for `EntryPlan.steps`, shared by every layer: the model-author prompt states
 * these exact numbers, the author validator refuses anything larger, and the human-command contract accepts
 * the same values. A plan that is valid when authored is therefore valid when displayed and approved; no
 * layer truncates or re-interprets a step to fit a different bound.
 */
export const ENTRY_PLAN_STEP_BOUNDS = Object.freeze({ maxSteps: 16, maxStepChars: 300 });
export interface EntryPlan {
  planId: string;
  runId: string;
  /** Exact digest of the plan content the human approves; start/approve with another digest must fail. */
  digest: string;
  /** Ordered bounded steps; the shared ENTRY_PLAN_STEP_BOUNDS is the only accepted bound, shown whole to the human. */
  steps: string[];
  /** Evidence that plan() issued no request to the target. Must be 0. */
  targetRequests: 0;
}

export interface EntryHumanApproval {
  /** Only src/interface/command.ts mints this after an interactive confirm; never a tool. */
  channel: 'human-command';
  approvalRef: string;
  approvedAt: string;
  scopeDigest: string;
  planDigest: string;
  /**
   * Controller-issued, non-serializable, single-use proof of the interactive confirmation this approval
   * claims. Present for every `/p2o` confirmation; absent means the caller relies on an externally
   * authored owner approval artifact (headless workflows) and the port refuses when none exists.
   */
  authority?: HumanConfirmationCapability;
}

export interface EntryStartInput {
  preparation: EntryPreparation;
  /** Present for the direct flow and for plan approval; its absence must not skip the scope checks. */
  plan?: EntryPlan;
  approval: EntryHumanApproval;
}

export interface EntryRun {
  runId: string;
  state: string;
  planId?: string;
  approvalRef?: string;
  /** Exact owner approval artifact used for this admission, when one was resolved or minted. */
  approvalPath?: string;
  mode?: 'fixture' | 'assessment';
}

export interface EntryRunSummary { runId: string; state?: string; targetKind?: EntryTargetKind; startedAt?: string }

export interface EntryReadPlan { plan: EntryPlan; preparation: EntryPreparation }

export interface EntryApproveInput { planId: string; planDigest: string; approval: EntryHumanApproval }

export interface EntryApprovalReceipt {
  planId: string;
  approved: true;
  /** True only when this call admitted the batch exactly once. */
  admittedOnce: boolean;
  run?: EntryRun;
}

export interface EntryStopReceipt {
  runId: string;
  schedulingStopped: boolean;
  terminationVerified: boolean;
  failures: { code: string; message: string }[];
}

export interface TargetEntryPort {
  prepare(input: EntryPrepareInput, signal?: AbortSignal): Promise<EntryPreparation>;
  plan(input: EntryPlanInput, signal?: AbortSignal): Promise<EntryPlan>;
  start(input: EntryStartInput, signal?: AbortSignal): Promise<EntryRun>;
  resume(runId: string, signal?: AbortSignal): Promise<EntryRun>;
  /** Optional; omit to force `/p2o approve` to use the session plan registry only. */
  readPlan?(planId: string, signal?: AbortSignal): Promise<EntryReadPlan | null>;
  approve(input: EntryApproveInput, signal?: AbortSignal): Promise<EntryApprovalReceipt>;
  /** Optional unambiguous current-run selection; return null when none or more than one is possible. */
  currentRun?(signal?: AbortSignal): Promise<EntryRunSummary | null>;
  /** Optional; when absent `/p2o stop` uses the verified legacy ControlBackend.stop path. */
  stop?(runId: string, reason: string): Promise<EntryStopReceipt>;
}
