import type { AttemptRecord, BudgetUsage, ExitObservation, GateDecision, HandoffPacket, JsonObject, LifecycleState, ObservedRuntime, RequestedRuntime, ArtifactReference } from '../contracts/index.js';

export interface StoreOptions { path: string; clock?: () => string; busyTimeoutMs?: number }
export interface WorkspaceLease {
  workspace: string; runId: string; taskId: string; attemptId: string; ownerId: string;
  token: string; generation: number; acquiredAt: string; heartbeatAt: string; expiresAt: string;
}
export interface BeginAttemptInput { taskId: string; ownerId: string; attemptId?: string; leaseMs: number; requestedRuntime?: RequestedRuntime }
export interface AttemptUpdate {
  lifecycleState?: LifecycleState;
  observedRuntime?: ObservedRuntime;
  checkpoint?: ArtifactReference;
  exit?: ExitObservation;
}
export interface BudgetConsumption extends Partial<BudgetUsage> { attemptId: string; leaseToken: string; targetId?: string }
/** One durable pre-dispatch reservation; the store mints its identity and records it on the charge. */
export interface BudgetReservation { attemptId: string; leaseToken: string; targetId?: string; toolCalls: number; requests?: number }
/**
 * Exactly-once release of ONE recorded reservation. Counters are taken from the recorded reservation, so the
 * caller can neither choose amounts nor replay an id to refund another call's charge.
 */
export interface BudgetRelease {
  attemptId: string;
  leaseToken: string;
  /** Identity minted by `reserveBudget` and recorded in the `budget.consumed` event. */
  reservationId: string;
  reason: string;
  /** Structured refusal identity of the released reservation: recorded durably, never free-form authority. */
  code: string;
  /** True only for tool-plane failures (TIMEOUT/CANCELLED/UNAVAILABLE); denials prove the plane answered. */
  toolPlane: boolean;
}
export interface StoredResult {
  resultId: string; runId: string; taskId: string; attemptId: string; digest: string;
  packet: HandoffPacket; decision: GateDecision; admittedAt: string;
}
export interface ResultAdmission extends StoredResult { duplicate: boolean }
export interface ResultInput { packet: unknown; idempotencyKey: string; leaseToken: string; reviewerId: string }
export interface EventInput { runId: string; taskId?: string; attemptId?: string; type: string; payload: JsonObject }
export interface DurableEvent extends EventInput { sequence: number; eventId: string; occurredAt: string }
export interface OutboxEntry {
  event: DurableEvent; deliveryAttempts: number; availableAt: string; deliveredAt?: string;
  claimOwner?: string; claimToken?: string; claimUntil?: string; lastError?: string;
}
export interface ClaimedOutboxEntry extends OutboxEntry { claimOwner: string; claimToken: string; claimUntil: string }
export type TerminalLifecycleState = 'exited' | 'failed' | 'timed-out' | 'cancelled';
export type ReconciliationObservation =
  | { attemptId: string; status: 'unknown'; observedAt: string }
  | { attemptId: string; status: 'running'; observedAt: string; receiptEvidenceIds: string[]; runtime: ObservedRuntime }
  | { attemptId: string; status: 'terminated' | 'not-started'; observedAt: string; receiptEvidenceIds: string[]; terminationConfirmed: true; lifecycleState?: TerminalLifecycleState; exit?: ExitObservation };
export interface ReconciliationReport {
  runId: string; resumed: string[]; released: string[]; unknown: string[]; retryableTaskIds: string[];
}
export interface AttemptLease { attempt: AttemptRecord; lease: WorkspaceLease }
export class StoreError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'StoreError'; }
}
