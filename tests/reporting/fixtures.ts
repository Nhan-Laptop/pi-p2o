import { attemptSchema, digestJson, type AttemptRecord, type CoverageRecord } from '../../src/contracts/index.js';
import { reviewCoverage, type CoverageReview } from '../../src/reporting/index.js';
import type { Harness } from '../evidence/fixtures.js';

export const QUESTIONS = {
  tested: 'Is the local handler gate enforced for the tested actor?',
  ruledOut: 'Can the equivalent read path bypass the handler gate?',
  untested: 'Is the blocked-actor path exempt from the gate?',
  outOfPlan: 'Is an unplanned surface covered?',
} as const;
export function coverReceipt(h: Harness, id: string, question: string, surfaceId = 'handler', actorId = 'local-reader', purpose: 'regression' | 'negative-control' = 'negative-control'): string {
  return h.collect(id, 'test', { metadata: { claimDigest: digestJson(question), surfaceId, actorId },
    test: { purpose, outcome: 'passed', successes: 1, attempts: 1, invariant: question, originalPolicy: true } }).evidenceId;
}
export function coverageRecord(h: Harness, coverageId: string, question: string, options: { state: CoverageRecord['state']; basis?: CoverageRecord['basis']; evidenceIds?: string[]; surfaceId?: string; actorId?: string; taskId?: string; reason?: string }): CoverageRecord {
  return coverageSchemaShape({ schemaVersion: 1, coverageId, runId: h.run.runId, taskId: options.taskId ?? h.task.taskId, surfaceId: options.surfaceId ?? 'handler', actorId: options.actorId ?? 'local-reader',
    question, state: options.state, basis: options.basis ?? 'runtime-observed', evidenceIds: options.evidenceIds ?? [], reason: options.reason ?? 'Bounded local fixture coverage decision' });
}
function coverageSchemaShape(value: CoverageRecord): CoverageRecord { return value; }
export function acceptedCoverage(h: Harness, coverageId: string, question: string, options: Parameters<typeof coverageRecord>[3]): CoverageReview {
  return reviewCoverage(h.vault, coverageRecord(h, coverageId, question, options), { reviewerId: 'reviewer-1', now: h.task.createdAt });
}
export function terminalAttempt(h: Harness, observed: { runtimeEvidenceId: string; selection?: AttemptRecord['requestedRuntime']['selection'] }): AttemptRecord {
  const selection = observed.selection ?? h.task.requestedRuntime.selection;
  return attemptSchema.parse({ ...h.attempt, lifecycleState: 'exited', exit: { code: 0, observedAt: h.task.createdAt }, observedRuntime: {
    adapter: h.task.requestedRuntime.adapter, selection, capabilities: { ownsLifecycle: true, canHardStop: true, canResume: false, streamsEvents: true, attestsRuntime: false },
    attestation: 'reported', observedAt: h.task.createdAt, receiptEvidenceIds: [observed.runtimeEvidenceId] } });
}
export function runtimeReceipt(h: Harness, id = 'runtime-receipt'): string {
  return h.collect(id, 'runtime', { metadata: { surfaceId: 'handler', actorId: 'local-reader', execution: 'process observation' } }).evidenceId;
}
