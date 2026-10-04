import {
  attemptSchema, compareRuntime, digestJson, handoffEvidenceIds, isTerminalLifecycle, runSchema, taskSchema,
  type AttemptRecord, type CoverageReconciliation, type EvidenceReceipt, type FindingRecord, type ObservedRuntime, type RequestedRuntime,
} from '../contracts/index.js';
import {
  assertFindingReview, assertHandoffReview, authenticateControllerReceipt, checkTime, EvidenceError, freeze, requireEvidence, validateFinding,
  type ControllerAttestationPolicy, type EvidenceVault, type FindingReview, type HandoffReview,
} from '../evidence/index.js';
import { assertCoverageReview, assertPlanCoverageFinalizable, CoverageLedger, type CoverageItem, type CoverageReview, type CoverageSummary } from './coverage.js';
import { assertRemediation, assertRetest, type RemediationRecord, type RetestRecord } from './remediation.js';

export interface ReportEvidence {
  evidenceId: string; digest: string; originalDigest?: string; byteLength: number; kind: EvidenceReceipt['kind']; classification: EvidenceReceipt['classification'];
  summary: string; redacted: true; attestation: 'vault' | 'controller'; collectorId: string; collectorRole: 'collector' | 'verifier'; collectedAt: string;
  tool: { name: string; version: string; implementationDigest?: string }; operationInputDigest?: string; inputDigests: string[];
  environmentId: string; configurationDigest: string; originalEnvironment: boolean; modifications: string[];
  test?: EvidenceReceipt['test']; analysis?: EvidenceReceipt['analysis'];
}
export interface ReportProcess {
  taskId: string; attemptId: string; state: AttemptRecord['lifecycleState']; exit?: AttemptRecord['exit'];
  requestedRuntime: RequestedRuntime; observedRuntime?: ObservedRuntime; runtimeEvidenceVerified: boolean;
  runtimeDiscrepancies: string[];
}
export interface AssessmentReport {
  schemaVersion: 1; runId: string; generatedAt: string; runState: string; assessmentStatus: 'incomplete' | 'bounded-complete';
  scope: { authorizationValidFrom: string; authorizationExpiresAt: string; targetIds: string[]; excludedIdentities: string[] };
  packets: { packetId: string; taskId: string; contract: string; outcome: string; classification: string; reviewerId: string; acceptedDigest: string; evidenceIds: string[]; limitations: string[] }[];
  findings: FindingRecord[]; coverage: CoverageSummary; processes: ReportProcess[];
  returned: { category: 'packet' | 'finding' | 'coverage'; identity: string; codes: string[]; questions: string[] }[];
  evidence: ReportEvidence[]; remediation: RemediationRecord[]; retests: RetestRecord[]; limitations: string[];
}
export interface ReportOptions {
  vault: EvidenceVault; run: unknown; tasks: readonly unknown[]; attempts: readonly unknown[];
  handoffs: readonly HandoffReview[]; findings: readonly FindingReview[];
  coveragePlan: readonly CoverageItem[]; coverage: readonly CoverageReview[];
  remediation?: readonly RemediationRecord[]; retests?: readonly RetestRecord[]; generatedAt: string;
  /** Independently controller-attested runtime receipts (from `publishHandoffReviews`); never worker JSON. */
  controllerReceipts?: readonly EvidenceReceipt[];
  /** Required when `controllerReceipts` is supplied: re-attests each receipt against its durable attempt. */
  controller?: ControllerAttestationPolicy;
  /**
   * Planner coverage reconciliation for an approved plan. When supplied, report finalization is refused unless
   * every planned cell is resolved, not-applicable, or explicitly carried as untested/blocked with a reason.
   */
  planCoverage?: CoverageReconciliation;
}
const reports = new WeakSet<object>();
export function assertReport(report: AssessmentReport): void {
  if (!report || !reports.has(report)) throw new EvidenceError('untrusted-report', 'Render only a report built from authenticated accepted data');
}
/** A trusted supervisor supplies manifests/attempts. Raw worker accepted flags, prose and consensus are not inputs. */
export function buildReport(options: ReportOptions): AssessmentReport {
  const run = runSchema.parse(options.run), generated = checkTime(options.generatedAt);
  requireEvidence(generated >= checkTime(run.createdAt), 'report-time', 'Report cannot predate the run');
  for (const values of [options.tasks, options.attempts, options.handoffs, options.findings, options.coveragePlan, options.coverage, options.remediation ?? [], options.retests ?? []]) requireEvidence(values.length <= 10_000, 'report-limit', 'Report input exceeds its record limit');
  const tasks = options.tasks.map(t => taskSchema.parse(t)), attempts = options.attempts.map(a => attemptSchema.parse(a));
  requireEvidence(new Set(tasks.map(t => t.taskId)).size === tasks.length && tasks.every(t => t.runId === run.runId), 'report-identity', 'Report tasks must be unique and belong to the run');
  requireEvidence(new Set(attempts.map(a => a.attemptId)).size === attempts.length && attempts.every(a => a.runId === run.runId && tasks.some(t => t.taskId === a.taskId)), 'report-identity', 'Report attempts must belong to the declared tasks/run');
  // Controller receipts are resolved only through a durable controller observation of their own attempt and the
  // attestation policy. An attempt is observed repeatedly while it runs, and the packet the supervisor admitted
  // pins the observation of that moment; both the attempt's latest observation and the ones admitted packets
  // carry are legitimate controller attestations of the same attempt, and nothing else is.
  const attestedByAttempt = new Map<string, Set<string>>();
  const noteAttested = (attemptId: string | undefined, ids: readonly string[] | undefined): void => {
    if (!attemptId || !ids?.length) return;
    const attested = attestedByAttempt.get(attemptId) ?? new Set<string>();
    for (const id of ids) attested.add(id);
    attestedByAttempt.set(attemptId, attested);
  };
  for (const attempt of attempts) noteAttested(attempt.attemptId, attempt.observedRuntime?.receiptEvidenceIds);
  for (const review of options.handoffs) {
    if (review.decision.status === 'accepted') noteAttested(review.packet?.attemptId, review.packet?.observedRuntime.receiptEvidenceIds);
  }
  const controllerById = new Map<string, EvidenceReceipt>();
  if (options.controllerReceipts?.length) {
    requireEvidence(options.controller, 'controller-policy', 'Controller-attested runtime receipts require their attestation policy');
    for (const candidate of options.controllerReceipts.slice(0, 10_000)) {
      const attempt = attempts.find(a => a.attemptId === candidate.attemptId);
      const attested = attempt ? attestedByAttempt.get(attempt.attemptId) : undefined;
      if (!attempt || !attested || authenticateControllerReceipt(candidate, attempt, options.controller, [...attested]).length) continue;
      controllerById.set(candidate.evidenceId, candidate);
    }
  }
  const returned: AssessmentReport['returned'] = [], packets: AssessmentReport['packets'] = [], evidenceIds = new Set<string>(), acceptedByTask = new Map<string, Set<string>>();
  const packetIds = new Set<string>();
  for (const review of options.handoffs) {
    assertHandoffReview(review, options.vault);
    requireEvidence(checkTime(review.decision.evaluatedAt) <= generated && (!review.packet || review.packet.runId === run.runId), 'report-identity', 'Packet review is foreign or future-dated');
    if (review.decision.status !== 'accepted' || !review.packet) {
      returned.push({ category: 'packet', identity: review.packet?.packetId ?? 'invalid-packet', codes: review.decision.reasons.map(i => i.code), questions: review.decision.unansweredQuestions });
      continue;
    }
    const p = review.packet;
    requireEvidence(!packetIds.has(p.packetId) && tasks.some(t => t.taskId === p.taskId) && attempts.some(a => a.attemptId === p.attemptId && a.ownerId === p.producer.id), 'report-identity', 'Accepted packet must correspond to a declared unique task/attempt');
    requireEvidence(review.decision.acceptedDigest === digestJson(p), 'packet-integrity', 'Accepted packet digest differs from the reviewed content');
    packetIds.add(p.packetId);
    const ids = handoffEvidenceIds(p), accepted = acceptedByTask.get(p.taskId) ?? new Set<string>();
    for (const id of ids) { evidenceIds.add(id); accepted.add(id); }
    acceptedByTask.set(p.taskId, accepted);
    packets.push({ packetId: p.packetId, taskId: p.taskId, contract: p.contract, outcome: p.outcome, classification: p.classification, reviewerId: review.decision.reviewerId, acceptedDigest: review.decision.acceptedDigest!, evidenceIds: ids.sort(), limitations: [...p.limits.untestedScope, ...p.limits.failedAssumptions, ...p.limits.risks] });
  }
  const findings: FindingRecord[] = [];
  for (const review of options.findings) {
    assertFindingReview(review, options.vault);
    requireEvidence(checkTime(review.evaluatedAt) <= generated && (!review.finding || review.finding.runId === run.runId), 'report-identity', 'Finding review is foreign or future-dated');
    if (review.status !== 'accepted' || !review.finding) {
      returned.push({ category: 'finding', identity: review.finding?.findingId ?? 'invalid-finding', codes: review.issues.map(i => i.code), questions: [...review.unansweredQuestions] });
      continue;
    }
    const finding = review.finding, admitted = acceptedByTask.get(finding.taskId);
    const fresh = validateFinding(options.vault, finding, { reviewerId: review.reviewerId, now: options.generatedAt });
    requireEvidence(fresh.status === 'accepted' && !findings.some(f => f.findingId === finding.findingId), 'finding-integrity', 'Finding proof is stale, conflicting or no longer valid');
    requireEvidence(admitted && options.handoffs.some(h => h.decision.status === 'accepted' && h.packet?.taskId === finding.taskId && h.packet.producer.id === finding.producerId), 'finding-not-admitted', 'Finding has no accepted producing handoff');
    const ids = [...finding.evidenceIds, ...finding.negativeControlEvidenceIds, ...(finding.verifier?.evidenceIds ?? [])];
    for (const id of ids) {
      requireEvidence(admitted.has(id) || finding.verifier?.evidenceIds.includes(id), 'finding-not-admitted', 'Finding uses evidence absent from its accepted packet or independent verification');
      evidenceIds.add(id);
    }
    findings.push(finding);
  }
  const ledger = new CoverageLedger(options.vault, run.runId, options.coveragePlan);
  for (const review of options.coverage) {
    if (review.status !== 'accepted') {
      // Authenticate even rejected input: a worker cannot forge report diagnostics or hide a cell.
      assertCoverageReview(review, options.vault);
      returned.push({ category: 'coverage', identity: review.coverage?.coverageId ?? 'invalid-coverage', codes: review.issues.map(i => i.code), questions: review.issues.map(i => i.question) });
      continue;
    }
    requireEvidence(checkTime(review.evaluatedAt) <= generated, 'report-time', 'Coverage review postdates report');
    ledger.accept(review);
  }
  const coverage = ledger.snapshot();
  // Planner coverage gate: a report cannot finalize over an open/needs_follow_up planned cell that was not
  // explicitly carried as untested or blocked. The accepted coverage universe above stays as it is.
  if (options.planCoverage) assertPlanCoverageFinalizable(options.planCoverage, run.runId);
  for (const record of coverage.records) for (const id of record.evidenceIds) evidenceIds.add(id);
  const remediation = [...(options.remediation ?? [])], retests = [...(options.retests ?? [])];
  for (const record of remediation) {
    assertRemediation(record, options.vault);
    requireEvidence(record.runId === run.runId && findings.some(f => f.findingId === record.findingId) && packetIds.has(record.packetId) && checkTime(record.recordedAt) <= generated, 'remediation-binding', 'Remediation is not bound to reported accepted data');
    record.evidenceIds.forEach(id => evidenceIds.add(id));
  }
  for (const record of retests) {
    assertRetest(record, options.vault);
    requireEvidence(record.runId === run.runId && remediation.some(r => r.remediationId === record.remediationId) && packetIds.has(record.packetId) && checkTime(record.recordedAt) <= generated, 'retest-binding', 'Retest is not bound to accepted remediation/H6 data');
    record.evidenceIds.forEach(id => evidenceIds.add(id));
  }
  requireEvidence(new Set(remediation.map(r => r.remediationId)).size === remediation.length && new Set(retests.map(r => r.retestId)).size === retests.length, 'report-identity', 'Remediation/retest identities must be unique');
  const processes: ReportProcess[] = attempts.map(a => {
    const observed = a.observedRuntime;
    let verified = !!observed && observed.receiptEvidenceIds.length > 0;
    for (const id of observed?.receiptEvidenceIds ?? []) {
      // Vault receipts and independently controller-attested store receipts count; worker receipts never do.
      const e = options.vault.get(id) ?? controllerById.get(id);
      if (!e || e.runId !== run.runId || e.attemptId !== a.attemptId || e.kind !== 'runtime' || e.provenance.trust !== 'collector' || checkTime(e.provenance.collectedAt) > generated) verified = false;
      else evidenceIds.add(id);
    }
    return { taskId: a.taskId, attemptId: a.attemptId, state: a.lifecycleState, ...(a.exit ? { exit: a.exit } : {}), requestedRuntime: a.requestedRuntime, ...(observed ? { observedRuntime: observed } : {}), runtimeEvidenceVerified: verified, runtimeDiscrepancies: observed ? compareRuntime(a.requestedRuntime, observed).discrepancies : ['selection-unavailable'] };
  });
  const evidence: ReportEvidence[] = [...evidenceIds].sort().map(id => {
    const e = options.vault.get(id), record = options.vault.inspect(id);
    if (!e) {
      const controllerReceipt = controllerById.get(id);
      requireEvidence(controllerReceipt && controllerReceipt.runId === run.runId && checkTime(controllerReceipt.provenance.collectedAt) <= generated, 'report-evidence', 'Report references missing, foreign, future or modified evidence');
      return { evidenceId: id, digest: controllerReceipt.digest, byteLength: controllerReceipt.byteLength, kind: controllerReceipt.kind, classification: controllerReceipt.classification,
        summary: controllerReceipt.summary, redacted: true, attestation: 'controller', collectorId: controllerReceipt.provenance.collectorId, collectorRole: 'collector', collectedAt: controllerReceipt.provenance.collectedAt,
        tool: { name: controllerReceipt.provenance.tool.name, version: controllerReceipt.provenance.tool.version }, inputDigests: controllerReceipt.provenance.inputDigests,
        environmentId: controllerReceipt.provenance.environmentId, configurationDigest: controllerReceipt.provenance.configurationDigest, originalEnvironment: controllerReceipt.provenance.originalEnvironment, modifications: controllerReceipt.provenance.modifications,
        ...(controllerReceipt.test ? { test: controllerReceipt.test } : {}), ...(controllerReceipt.analysis ? { analysis: controllerReceipt.analysis } : {}) };
    }
    requireEvidence(record && e.runId === run.runId && checkTime(e.provenance.collectedAt) <= generated, 'report-evidence', 'Report references missing, foreign, future or modified evidence');
    return { evidenceId: id, digest: e.digest, originalDigest: record.originalDigest, byteLength: e.byteLength, kind: e.kind, classification: e.classification,
      summary: e.summary, redacted: true, attestation: 'vault', collectorId: e.provenance.collectorId, collectorRole: record.collector.role, collectedAt: e.provenance.collectedAt,
      tool: { name: e.provenance.tool.name, version: e.provenance.tool.version, implementationDigest: record.collector.toolImplementationDigest }, operationInputDigest: record.collector.operationInputDigest, inputDigests: e.provenance.inputDigests,
      environmentId: e.provenance.environmentId, configurationDigest: e.provenance.configurationDigest, originalEnvironment: e.provenance.originalEnvironment, modifications: e.provenance.modifications,
      ...(e.test ? { test: e.test } : {}), ...(e.analysis ? { analysis: e.analysis } : {}) };
  });
  const failures = processes.filter(p => ['failed', 'timed-out', 'cancelled', 'reconciling'].includes(p.state) || (p.exit && p.exit.code !== 0));
  const incomplete = !coverage.completeWithinPlan || !packets.length || returned.length > 0 || failures.length > 0 || processes.some(p => !isTerminalLifecycle(p.state) || p.runtimeDiscrepancies.length > 0) || packets.some(p => p.outcome !== 'supported') || findings.some(f => ['candidate', 'unresolved', 'supported-static'].includes(f.state)) || retests.some(r => r.closure !== 'repaired');
  const report: AssessmentReport = options.vault.redactor.json({ schemaVersion: 1, runId: run.runId, generatedAt: options.generatedAt, runState: run.state,
    assessmentStatus: incomplete ? 'incomplete' : 'bounded-complete', scope: { authorizationValidFrom: run.authorization.validFrom, authorizationExpiresAt: run.authorization.expiresAt, targetIds: run.authorization.targets.map(t => t.id).sort(), excludedIdentities: run.authorization.exclusions },
    packets: packets.sort((a, b) => a.packetId.localeCompare(b.packetId)), findings: findings.sort((a, b) => a.findingId.localeCompare(b.findingId)), coverage,
    processes: processes.sort((a, b) => a.attemptId.localeCompare(b.attemptId)), returned: returned.sort((a, b) => `${a.category}:${a.identity}`.localeCompare(`${b.category}:${b.identity}`)), evidence,
    remediation: remediation.sort((a, b) => a.remediationId.localeCompare(b.remediationId)), retests: retests.sort((a, b) => a.retestId.localeCompare(b.retestId)),
    limitations: [...new Set([...coverage.limitations, 'Process, packet and finding states are separate; exit status, artifact freshness and prompt consensus are not proof.',
      ...(failures.length ? [`${failures.length} execution failure/unknown termination record(s) remain visible.`] : []),
      ...(returned.length ? [`${returned.length} packet/finding/coverage record(s) were returned for evidence and excluded from accepted facts.`] : []),
      ...(options.planCoverage ? [`Planned coverage reconciled: ${options.planCoverage.resolved.length} resolved, ${options.planCoverage.carried.length} explicitly carried, 0 unresolved.`, ...options.planCoverage.limitations] : []),
      ...packets.flatMap(p => p.limitations), ...findings.flatMap(f => f.limitations)])],
  } as AssessmentReport);
  freeze(report); reports.add(report); return report;
}
