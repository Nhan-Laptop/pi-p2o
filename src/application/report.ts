import { canonicalJson, digestJson, type CoverageRecord, type FindingRecord, type HandoffPacket } from '../contracts/index.js';
import type { DurableStore, StoredResult } from '../store/index.js';
import { EvidenceError, type EvidenceVault, type FindingReview, type HandoffReview } from '../evidence/index.js';
import { receiptSupportsClaim } from '../evidence/verification.js';
// NOTE: importing from the reporting module barrel keeps one source of report typing.
import { buildReport, renderJson, renderMarkdown, reviewCoverage, type AssessmentReport, type CoverageReview } from '../reporting/index.js';
import type { AssessmentArtifacts, CoveragePlanEntry, FindingPlan } from './types.js';
import { ApplicationError } from './validation.js';

export interface ReportInputs {
  vault: EvidenceVault;
  store: DurableStore;
  runId: string;
  reviewerId: string;
  generatedAt: string;
  handoffs: readonly HandoffReview[];
  findings: readonly FindingReview[];
  coveragePlan: readonly CoveragePlanEntry[];
  coverage: readonly CoverageReview[];
  controllerReceipts?: readonly unknown[];
  controller?: unknown;
  /** Planner coverage reconciliation: when supplied, an unresolved planned cell blocks report finalization. */
  planCoverage?: import('../contracts/index.js').CoverageReconciliation;
}

/** Select claim-bound receipts from an accepted packet, never every nearby tool result.
 * Explicit IDs narrow packet authority; omitted IDs require authenticated collector claim linkage.
 * Finding review still checks provenance, receipt semantics and reproduction independently.
 */
export function producerFinding(plan: FindingPlan, packet: HandoffPacket, runId: string, vault?: EvidenceVault): FindingRecord {
  if (packet.runId !== runId || packet.taskId !== plan.taskId) {
    throw new ApplicationError('finding-packet-mismatch', 'Finding and accepted packet must belong to the same run and task');
  }
  const select = (requested: readonly string[] | undefined, admitted: readonly string[]): string[] => {
    if (requested !== undefined) {
      if (new Set(requested).size !== requested.length || requested.some(id => !admitted.includes(id))) {
        throw new ApplicationError('finding-evidence-selector', 'Claim receipt selectors must be unique members of the accepted packet evidence category');
      }
      return [...requested];
    }
    if (!vault) return [];
    return [...new Set(admitted)].filter(id => {
      const receipt = vault.get(id);
      return receipt !== undefined && receipt.runId === runId && receipt.taskId === packet.taskId
        && receipt.attemptId === packet.attemptId && receiptSupportsClaim(receipt, plan.claim);
    });
  };
  return {
    schemaVersion: 1,
    findingId: plan.findingId,
    runId,
    taskId: plan.taskId,
    producerId: packet.producer.id,
    title: plan.title,
    claim: plan.claim,
    classification: plan.classification,
    state: plan.state,
    evidenceIds: select(plan.evidenceIds, packet.evidenceIds),
    negativeControlEvidenceIds: select(plan.negativeControlEvidenceIds, packet.limits.negativeControlEvidenceIds),
    limitations: [...plan.limitations],
    ...(plan.impact ? { impact: plan.impact } : {}),
  };
}

export function acceptedResult(store: DurableStore, runId: string, taskId: string): StoredResult | undefined {
  return store.listResults(runId, taskId).find(result => result.decision.status === 'accepted');
}

export function acceptedPacket(store: DurableStore, runId: string, taskId: string): HandoffPacket | undefined {
  return acceptedResult(store, runId, taskId)?.packet;
}

/**
 * Coverage records are derived from the accepted packet of the planned task. A planned cell whose task has no
 * accepted packet keeps an empty evidence list and is rejected by the reviewer, which surfaces it as a gap.
 */
export function coverageRecords(store: DurableStore, runId: string, plan: readonly CoveragePlanEntry[]): CoverageRecord[] {
  return plan.map((entry, index) => {
    const packet = entry.taskId ? acceptedPacket(store, runId, entry.taskId) : undefined;
    const evidenceIds = packet ? [...new Set([...packet.evidenceIds, ...packet.limits.negativeControlEvidenceIds])] : [];
    return {
      schemaVersion: 1,
      coverageId: `cov-${entry.surfaceId}-${entry.actorId}-${index}`,
      runId,
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      surfaceId: entry.surfaceId,
      actorId: entry.actorId,
      question: entry.question,
      state: entry.state,
      basis: entry.basis,
      evidenceIds,
      reason: entry.reason,
    };
  });
}

export function coverageReviews(vault: EvidenceVault, records: readonly CoverageRecord[], context: { reviewerId: string; now: string }): CoverageReview[] {
  return records.map(record => reviewCoverage(vault, record, context));
}

/** Build the report from authenticated reviews only. */
export function buildAssessmentArtifacts(input: ReportInputs): AssessmentArtifacts {
  const run = input.store.getRun(input.runId);
  const tasks = input.store.listTasks(input.runId);
  const attempts = input.store.listAttempts(input.runId);
  if (!run) throw new ApplicationError('run-missing', `No durable run ${input.runId}`);
  let report: AssessmentReport;
  try {
  report = buildReport({
    vault: input.vault,
    run,
    tasks,
    attempts,
    handoffs: [...input.handoffs],
    findings: [...input.findings],
    coveragePlan: input.coveragePlan.map(({ surfaceId, actorId, question, taskId }) => ({ surfaceId, actorId, question, ...(taskId ? { taskId } : {}) })),
    coverage: [...input.coverage],
    generatedAt: input.generatedAt,
    ...(input.controllerReceipts ? { controllerReceipts: input.controllerReceipts as never } : {}),
    ...(input.controller ? { controller: input.controller as never } : {}),
    ...(input.planCoverage ? { planCoverage: input.planCoverage as never } : {}),
  } as Parameters<typeof buildReport>[0]) as AssessmentReport;
} catch (error) {
  // The plan coverage gate is a deliberate refusal, not a build diagnosis: surface its exact code unchanged.
  if (error instanceof EvidenceError && error.code === 'coverage-unresolved-cell') throw error;
    const diagnosis = input.findings.map(review => ({
      findingId: review.finding?.findingId, state: review.finding?.state, status: review.status,
      evidenceIds: review.finding?.evidenceIds, verifierEvidence: review.finding?.verifier?.evidenceIds,
      issues: review.issues.map(issue => issue.code), limitations: review.finding?.limitations,
    }));
    throw new ApplicationError('report-build', `${error instanceof Error ? error.message : 'report failed'}; findings=${JSON.stringify(diagnosis).slice(0, 1500)}`);
  }
  return {
    runId: input.runId,
    report,
    markdown: renderMarkdown(report),
    json: renderJson(report),
    reviews: [...input.handoffs],
    findings: [...input.findings],
    accepted: input.store.listResults(input.runId).filter(result => result.decision.status === 'accepted'),
  };
}

/** Deterministic identity for a packet byte buffer (diagnostics/tests only). */
export function packetDigest(packet: unknown): string {
  return digestJson(packet);
}

export function packetBytes(packet: HandoffPacket): string {
  return canonicalJson(packet);
}
