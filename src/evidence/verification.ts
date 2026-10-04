import {
  contractIssue, digestJson, evaluateHandoff, evidenceSchema, findingSchema, handoffEvidenceIds, handoffSchema,
  validateFindingEvidence, type AttemptRecord, type Authorization, type ContractIssue, type EvidenceReceipt,
  type FindingRecord, type GateDecision, type HandoffPacket, type TaskManifest,
} from '../contracts/index.js';
import { checkId, checkTime, EvidenceError, freeze, normalized, sameSet } from './common.js';
import type { EvidenceVault } from './vault.js';

export interface HandoffReview { readonly packet?: HandoffPacket; readonly decision: GateDecision }
export interface FindingReview {
  readonly status: 'accepted' | 'returned-for-evidence';
  readonly finding?: FindingRecord;
  readonly reviewerId: string; readonly evaluatedAt: string;
  readonly issues: readonly ContractIssue[]; readonly unansweredQuestions: readonly string[];
}
export interface ReviewContext {
  authorization: Authorization; task: TaskManifest; attempt: AttemptRecord; reviewerId: string; now: string; upstreamEvidenceIds?: readonly string[];
  /** Supervisor controller runtime receipts, independently attested outside the vault. Never worker JSON or `trust: 'worker'`. */
  controllerReceipts?: readonly EvidenceReceipt[];
}
const handoffReviews = new WeakMap<object, EvidenceVault>();
const findingReviews = new WeakMap<object, EvidenceVault>();
export function assertHandoffReview(value: HandoffReview, vault: EvidenceVault): void {
  if (!value || handoffReviews.get(value) !== vault) throw new EvidenceError('untrusted-review', 'A worker-authored accepted flag/digest is not an authenticated handoff review');
}
export function assertFindingReview(value: FindingReview, vault: EvidenceVault): void {
  if (!value || findingReviews.get(value) !== vault) throw new EvidenceError('untrusted-review', 'Only receipt-backed reviewer decisions may be reported');
}
function evidenceFor(vault: EvidenceVault, ids: readonly string[], runId: string, now: string, issues: ContractIssue[], controller?: ReadonlyMap<string, EvidenceReceipt>): EvidenceReceipt[] {
  const receipts: EvidenceReceipt[] = [];
  for (const id of new Set(ids)) {
    try {
      const e = vault.get(id);
      if (e) {
        if (e.runId !== runId) issues.push(contractIssue('trusted-reference', '$/evidenceIds', 'Receipt is absent from this run\'s trusted vault', 'Collect the referenced bytes with an authenticated collector.'));
        else if (checkTime(e.provenance.collectedAt) > checkTime(now)) issues.push(contractIssue('future-evidence', '$/evidenceIds', 'Receipt postdates this review', 'Review only evidence collected by the evaluation time.'));
        else receipts.push(e);
        continue;
      }
    } catch { issues.push(contractIssue('evidence-integrity', '$/evidenceIds', 'Receipt or preserved bytes failed integrity validation', 'Recollect the artifact; do not trust stale or modified worker files.')); continue; }
    const controllerReceipt = controller?.get(id);
    if (controllerReceipt) { receipts.push(controllerReceipt); continue; }
    issues.push(contractIssue('trusted-reference', '$/evidenceIds', 'Receipt is absent from this run\'s trusted vault', 'Collect the referenced bytes with an authenticated collector.'));
  }
  return receipts;
}
/** Fence controller receipts to supervisor-minted runtime observations listed by the durable attempt. */
function controllerReceiptsFor(context: ReviewContext, issues: ContractIssue[]): Map<string, EvidenceReceipt> {
  const attested = new Set(context.attempt.observedRuntime?.receiptEvidenceIds ?? []);
  const receipts = new Map<string, EvidenceReceipt>();
  for (const candidate of context.controllerReceipts ?? []) {
    const parsed = evidenceSchema.safeParse(candidate);
    if (!parsed.success) { issues.push(contractIssue('controller-receipt', '$/observedRuntime/receiptEvidenceIds', 'Controller receipt is invalid', 'Use the supervisor controller observation document.')); continue; }
    const e = parsed.data;
    if (e.provenance.trust !== 'collector' || e.kind !== 'runtime' || e.runId !== context.attempt.runId || e.taskId !== context.attempt.taskId || e.attemptId !== context.attempt.attemptId || !attested.has(e.evidenceId)) {
      issues.push(contractIssue('controller-receipt', '$/observedRuntime/receiptEvidenceIds', 'Runtime receipt is not an independently controller-attested observation for this attempt', 'Attach the supervisor controller receipt listed in the durable attempt observation; worker-trust receipts are never promoted.'));
      continue;
    }
    receipts.set(e.evidenceId, e);
  }
  return receipts;
}
/** Executable H1–H6 admission using the shared gates and authenticated byte-level receipts. */
export function reviewHandoff(vault: EvidenceVault, input: unknown, context: ReviewContext): HandoffReview {
  checkId(context.reviewerId); checkTime(context.now);
  const parsed = handoffSchema.safeParse(input), extra: ContractIssue[] = [];
  const packet = parsed.success ? parsed.data : undefined;
  const controller = controllerReceiptsFor(context, extra);
  const evidence = packet ? evidenceFor(vault, handoffEvidenceIds(packet), packet.runId, context.now, extra, controller) : [];
  const decision = evaluateHandoff(input, { ...context, evidence });
  if (packet) {
    if (context.reviewerId === packet.producer.id) extra.push(contractIssue('reviewer-identity', '$/producer', 'Producer cannot self-accept its packet', 'Use a distinct authorized reviewer.'));
    if (['failed', 'timed-out', 'cancelled', 'reconciling', 'queued'].includes(context.attempt.lifecycleState) || checkTime(context.now) >= checkTime(context.attempt.deadlineAt) || checkTime(context.now) >= checkTime(context.task.budgets.deadlineAt)) extra.push(contractIssue('stale-attempt', '$/attemptId', 'Unknown, stopped, unstarted or expired attempts cannot publish new results', 'Reconcile execution and collect a fresh authorized attempt.'));
    const inputDigests = packet.scope.inputs.map(a => a.digest);
    for (const e of evidence) {
      const record = vault.inspect(e.evidenceId);
      if ((e.taskId !== packet.taskId || e.attemptId !== packet.attemptId) && !context.upstreamEvidenceIds?.includes(e.evidenceId)) extra.push(contractIssue('receipt-attempt', '$/evidenceIds', 'Receipt is not from this attempt or an explicitly admitted dependency', 'Use current-attempt receipts or supervisor-approved upstream evidence.'));
      // Vault receipts carry an admission record; controller receipts are bound by the attempt observation and the caller's attestation.
      if (record && (!sameSet(e.provenance.inputDigests, inputDigests) || record.collector.authorizationDigest !== digestJson(packet.scope.authorizationRef))) extra.push(contractIssue('receipt-input-scope', '$/scope/inputs', 'Receipt input revision or authorization identity differs', 'Recollect against the exact assigned inputs and authorization.'));
      if (checkTime(e.provenance.collectedAt) < checkTime(context.authorization.validFrom) || checkTime(e.provenance.collectedAt) >= checkTime(context.authorization.expiresAt)) extra.push(contractIssue('receipt-authorization-window', '$/evidenceIds', 'Evidence was collected outside authorization', 'Collect only inside the owner-approved authorization window.'));
    }
  }
  const reasons = [...decision.reasons, ...extra];
  const final: GateDecision = reasons.length ? { status: 'returned-for-evidence', ...(packet ? { contract: packet.contract, outcome: packet.outcome } : {}), reviewerId: context.reviewerId, evaluatedAt: context.now, reasons, unansweredQuestions: [...new Set(reasons.map(i => i.question))] } : decision;
  const review = freeze({ ...(packet ? { packet } : {}), decision: final });
  handoffReviews.set(review, vault);
  return review;
}
function fullPass(e: EvidenceReceipt): boolean {
  return !!e.test && e.test.outcome === 'passed' && e.test.originalPolicy && e.test.attempts > 0 && e.test.successes === e.test.attempts && e.provenance.originalEnvironment;
}
/** A claim must be explicitly linked by its collector, never inferred from a nearby tool success. */
export function receiptSupportsClaim(e: EvidenceReceipt, claim: string): boolean {
  return (typeof e.metadata?.claimDigest === 'string' && e.metadata.claimDigest === digestJson(claim)) || (!!e.test?.invariant && normalized(e.test.invariant) === normalized(claim));
}
/** Deliberately narrow static proof: preserved UTF-8 source range contains the exact cited excerpt.
 * A hypothesis about exploitability is not demonstrated by this check. Hash is of preserved redacted bytes. */
export function sourceEvidenceSupportsClaim(vault: EvidenceVault, e: EvidenceReceipt, claim: string): boolean {
  const proof = e.metadata?.sourceClaim as { path?: unknown; fileHash?: unknown; startLine?: unknown; endLine?: unknown; excerpt?: unknown; hypothesis?: unknown } | undefined;
  if (!proof || typeof proof.path !== 'string' || !proof.path || proof.fileHash !== e.digest
    || !Number.isSafeInteger(proof.startLine) || !Number.isSafeInteger(proof.endLine)
    || typeof proof.excerpt !== 'string' || !proof.excerpt || typeof proof.hypothesis !== 'string' || !proof.hypothesis.trim()) return false;
  const start = proof.startLine as number, end = proof.endLine as number;
  if (start < 1 || end < start || end - start > 200 || e.mediaType !== 'text/plain') return false;
  const bytes = vault.read(e.evidenceId), text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\u0000')) return false;
  const lines = text.split(/\r?\n/u);
  return end <= lines.length && lines.slice(start - 1, end).join('\n').includes(proof.excerpt)
    && claim === `Source ${proof.path} lines ${start}-${end} contains ${JSON.stringify(proof.excerpt)}`;
}
export function validateFinding(vault: EvidenceVault, input: unknown, context: { reviewerId: string; now: string }): FindingReview {
  checkId(context.reviewerId); checkTime(context.now);
  const parsed = findingSchema.safeParse(input), issues: ContractIssue[] = [];
  const finding = parsed.success ? parsed.data : undefined;
  if (!parsed.success) for (const issue of parsed.issues) issues.push(contractIssue(`schema:${issue.code}`, issue.path, issue.message, `Supply a valid finding field at ${issue.path}.`));
  if (finding) {
    const ids = [...finding.evidenceIds, ...finding.negativeControlEvidenceIds, ...(finding.verifier?.evidenceIds ?? [])];
    const receipts = evidenceFor(vault, ids, finding.runId, context.now, issues);
    issues.push(...validateFindingEvidence(finding, receipts));
    const add = (code: string, message: string, question: string) => issues.push(contractIssue(code, '$/evidenceIds', message, question));
    if (!finding.claim.trim() || finding.claim.trim().endsWith('?')) add('concrete-claim', 'A question is not an asserted finding', 'State a concrete bounded claim with collector evidence.');
    const primary = receipts.filter(e => finding.evidenceIds.includes(e.evidenceId));
    if (!primary.length || !primary.some(e => receiptSupportsClaim(e, finding.claim))) add('claim-binding', 'No collector receipt is tied to this exact claim/invariant', 'Collect a claim-bound source observation or invariant test; prompt agreement is not proof.');
    if (finding.state === 'supported-static') {
      let demonstrated = false;
      try { demonstrated = primary.some(e => e.kind === 'source' && e.classification === 'static-inference' && receiptSupportsClaim(e, finding.claim) && sourceEvidenceSupportsClaim(vault, e, finding.claim)); }
      catch { add('evidence-integrity', 'Source proof bytes failed integrity validation', 'Recollect the preserved source bytes.'); }
      if (!demonstrated) add('static-claim-binding', 'Static claim lacks a demonstrated preserved file hash/range/excerpt and explicit hypothesis', 'Preserve exact source bytes and a bounded static property; lexical suspicion is not a confirmed vulnerability.');
    }
    if (finding.state === 'supported-static' && !finding.limitations.length) add('static-limitations', 'Static-only inference hides its runtime gap', 'Name the unperformed dynamic/replay checks.');
    if (['reproduced', 'independently-validated'].includes(finding.state)) {
      const reproductions = primary.filter(e => e.kind === 'reproduction');
      if (!reproductions.length || reproductions.some(e => !fullPass(e) || !receiptSupportsClaim(e, finding.claim))) add('reproduction-denominator', 'Incomplete, failed or unrelated reproductions cannot be hidden by a passing sample', 'Preserve the full denominator and resolve conflicting observations.');
      const controls = receipts.filter(e => finding.negativeControlEvidenceIds.includes(e.evidenceId));
      if (!controls.length || controls.some(e => !fullPass(e) || e.test?.purpose !== 'negative-control' || !receiptSupportsClaim(e, finding.claim) || !reproductions.some(r => r.provenance.environmentId === e.provenance.environmentId && r.provenance.configurationDigest === e.provenance.configurationDigest && sameSet(r.provenance.inputDigests, e.provenance.inputDigests)))) add('control-comparability', 'All negative controls must fully pass for the same claim/input/configuration', 'Supply comparable original-policy negative controls; keep failed/inconclusive samples visible.');
      if (finding.state === 'independently-validated' && finding.verifier) {
        const verifier = finding.verifier;
        const independent = receipts.filter(e => verifier.evidenceIds.includes(e.evidenceId));
        const replay = independent.filter(e => e.kind === 'reproduction');
        const negative = independent.filter(e => e.test?.purpose === 'negative-control');
        if (!replay.length || !negative.length || replay.some(e => !fullPass(e) || !receiptSupportsClaim(e, finding.claim)) || negative.some(e => !fullPass(e) || !receiptSupportsClaim(e, finding.claim))) add('independent-controls', 'Independent replay needs its own passing negative controls and denominator', 'Replay the bounded claim and controls in the clean verifier environment.');
        if (independent.some(e => vault.inspect(e.evidenceId)?.collector.role !== 'verifier' || e.provenance.collectorId !== verifier.identity || e.attemptId !== verifier.attemptId || e.provenance.environmentId !== verifier.environmentId)) add('verifier-authentication', 'Independent evidence was not collected by this distinct verifier capability', 'Use an authenticated verifier collector, not a copied worker receipt.');
        const sameFixture = replay.every(e => reproductions.some(r => r.attemptId !== e.attemptId && r.provenance.environmentId !== e.provenance.environmentId && sameSet(r.provenance.inputDigests, e.provenance.inputDigests) && r.provenance.configurationDigest === e.provenance.configurationDigest));
        if (!sameFixture || negative.some(e => e.provenance.configurationDigest !== replay[0]?.provenance.configurationDigest)) add('clean-replay-identity', 'Replay did not preserve inputs/configuration in a distinct environment/attempt', 'Use a fresh environment with the same approved fixture/configuration.');
        const session = independent.some(e => e.kind === 'runtime' && e.metadata?.independentSession === true && e.metadata?.targetReset === false && e.provenance.originalEnvironment);
        if (!session) add('independent-session-receipt', 'Independent session identity is not receipt-backed (no target reset is claimed)', 'Collect the verifier session qualification receipt; reset-dependent claims need separate qualified reconstruction.');
      }
    }
    if (['candidate', 'unresolved', 'rejected'].includes(finding.state) && !finding.limitations.length) add('finding-limits', 'Nonconfirmed finding has no explicit reason/limits', 'Preserve why this claim is candidate, unresolved, or rejected.');
  }
  const review: FindingReview = freeze({ status: issues.length ? 'returned-for-evidence' : 'accepted', ...(finding ? { finding } : {}), reviewerId: context.reviewerId, evaluatedAt: context.now, issues, unansweredQuestions: [...new Set(issues.map(i => i.question))] });
  findingReviews.set(review, vault);
  return review;
}
