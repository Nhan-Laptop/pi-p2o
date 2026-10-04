import { contractIssue, coverageSchema, digestJson, makeSchema, rules as r, validateCoverageEvidence, type ContractIssue, type CoverageRecord, type CoverageReconciliation } from '../contracts/index.js';
import { checkId, checkTime, EvidenceError, freeze, idRule, receiptSupportsClaim, type EvidenceVault } from '../evidence/index.js';

export interface CoverageItem { surfaceId: string; actorId: string; question: string; taskId?: string }
export interface CoverageReview {
  readonly status: 'accepted' | 'returned-for-evidence'; readonly coverage?: CoverageRecord;
  readonly reviewerId: string; readonly evaluatedAt: string; readonly issues: readonly ContractIssue[];
}
export interface CoverageSummary {
  readonly records: readonly CoverageRecord[];
  readonly counts: Readonly<Record<CoverageRecord['state'], number>>;
  readonly completeWithinPlan: boolean;
  readonly limitations: readonly string[];
}
const reviews = new WeakMap<object, EvidenceVault>();
const itemSchema = makeSchema<CoverageItem>('coverage-plan-item', r.object({ surfaceId: idRule, actorId: idRule, question: r.string(), taskId: r.optional(idRule) }));
export function coverageKey(value: CoverageItem): string { return digestJson({ surfaceId: value.surfaceId, actorId: value.actorId, question: value.question }); }
export function assertCoverageReview(value: CoverageReview, vault: EvidenceVault): void {
  if (!value || reviews.get(value) !== vault) throw new EvidenceError('untrusted-coverage', 'Coverage must come from a receipt-backed reviewer decision');
}
export function reviewCoverage(vault: EvidenceVault, input: unknown, context: { reviewerId: string; now: string }): CoverageReview {
  checkId(context.reviewerId); checkTime(context.now);
  const parsed = coverageSchema.safeParse(input), issues: ContractIssue[] = [];
  const coverage = parsed.success ? parsed.data : undefined;
  if (!parsed.success) for (const i of parsed.issues) issues.push(contractIssue(`schema:${i.code}`, i.path, i.message, `Supply a valid coverage field at ${i.path}.`));
  if (coverage) {
    const receipts = [];
    for (const id of coverage.evidenceIds) {
      try {
        const e = vault.get(id);
        if (!e || e.runId !== coverage.runId || checkTime(e.provenance.collectedAt) > checkTime(context.now)) throw new Error('Missing/foreign/future receipt');
        receipts.push(e);
      } catch { issues.push(contractIssue('coverage-reference', '$/evidenceIds', 'Coverage receipt is missing, foreign or failed integrity checks', 'Collect evidence for this exact surface/actor/question.')); }
    }
    issues.push(...validateCoverageEvidence(coverage, receipts));
    const observed = ['tested', 'ruled-out'].includes(coverage.state);
    if (observed && (coverage.basis === 'worker-asserted' || !receipts.some(e => e.test && e.test.attempts > 0 && e.kind !== 'source' && receiptSupportsClaim(e, coverage.question)))) issues.push(contractIssue('coverage-test', '$/basis', 'Assertions or generic tool success do not establish tested coverage', 'Record a test receipt tied to this surface/actor/question; otherwise retain untested/blocked.'));
    if (coverage.state === 'ruled-out' && (!receipts.length || receipts.some(e => e.test && (e.test.outcome !== 'passed' || !e.test.originalPolicy || !e.provenance.originalEnvironment || e.test.successes !== e.test.attempts)) || !receipts.some(e => e.test && ['negative-control', 'forbidden'].includes(e.test.purpose) && e.test.outcome === 'passed' && e.test.originalPolicy && receiptSupportsClaim(e, coverage.question)))) issues.push(contractIssue('coverage-negative', '$/state', 'Ruled-out needs passing comparable original-policy negative evidence', 'Resolve failed/inconclusive controls or mark the bounded question blocked/untested.'));
    if (coverage.state === 'not-applicable' && coverage.basis !== 'reviewer-validated') issues.push(contractIssue('coverage-applicability', '$/basis', 'Not-applicable requires an explicit reviewer-approved reason', 'Review applicability; do not turn unknown/unavailable tests into not-applicable.'));
    for (const e of receipts) {
      if (e.metadata?.surfaceId !== coverage.surfaceId || e.metadata?.actorId !== coverage.actorId || !receiptSupportsClaim(e, coverage.question)) issues.push(contractIssue('coverage-identity', '$/evidenceIds', 'Receipt does not identify this surface/actor/question', 'Collect controls/observations for the declared surface and actor.'));
    }
  }
  const review: CoverageReview = freeze({ status: issues.length ? 'returned-for-evidence' : 'accepted', ...(coverage ? { coverage } : {}), reviewerId: context.reviewerId, evaluatedAt: context.now, issues });
  reviews.set(review, vault); return review;
}
/** Explicit planned universe; omitted cells become untested, never disappear from the report. */
export class CoverageLedger {
  private readonly plan = new Map<string, CoverageItem>();
  private readonly accepted = new Map<string, CoverageRecord>();
  private readonly ids = new Map<string, string>();
  private readonly history: CoverageRecord[] = [];
  constructor(private readonly vault: EvidenceVault, readonly runId: string, items: readonly CoverageItem[]) {
    checkId(runId);
    if (items.length > 10_000) throw new EvidenceError('coverage-limit', 'Coverage plan exceeds its bound');
    for (const input of items) {
      const item = freeze(itemSchema.parse(input)), key = coverageKey(item);
      if (this.plan.has(key)) throw new EvidenceError('coverage-conflict', 'Planned surface/actor/question is duplicated');
      this.plan.set(key, item);
    }
  }
  accept(review: CoverageReview, options: { supersedes?: string } = {}): void {
    assertCoverageReview(review, this.vault);
    if (review.status !== 'accepted' || !review.coverage || review.coverage.runId !== this.runId) throw new EvidenceError('coverage-returned', 'Only accepted coverage for this run can enter the ledger');
    const coverage = review.coverage, key = coverageKey(coverage), planned = this.plan.get(key), prior = this.accepted.get(key);
    if (!planned || coverage.taskId !== planned.taskId) throw new EvidenceError('coverage-plan', 'Coverage is outside the planned surface/actor/question/task');
    const priorKey = this.ids.get(coverage.coverageId);
    if (priorKey && (priorKey !== key || digestJson(prior) !== digestJson(coverage))) throw new EvidenceError('coverage-conflict', 'Coverage identity is immutable');
    if (prior && digestJson(prior) !== digestJson(coverage)) {
      if (options.supersedes !== prior.coverageId) throw new EvidenceError('coverage-conflict', 'Changing coverage requires explicit reviewer-backed supersession');
      this.history.push(prior);
    }
    this.ids.set(coverage.coverageId, key); this.accepted.set(key, coverage);
  }
  snapshot(): CoverageSummary {
    const records = [...this.plan.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => this.accepted.get(key) ?? coverageSchema.parse({ schemaVersion: 1, coverageId: `gap-${key.slice(0, 24)}`, runId: this.runId, ...item, state: 'untested', basis: 'reviewer-validated', evidenceIds: [], reason: 'Planned question has no accepted test/applicability record' }));
    const counts: Record<CoverageRecord['state'], number> = { tested: 0, 'ruled-out': 0, blocked: 0, untested: 0, 'not-applicable': 0 };
    for (const record of records) counts[record.state]++;
    return freeze({ records, counts, completeWithinPlan: records.length > 0 && counts.blocked === 0 && counts.untested === 0, limitations: [
      'Coverage is bounded to the declared surface/actor/question plan, not a comprehensive assessment.',
      ...(records.length ? [] : ['No planned coverage universe was supplied.']),
      ...(!this.history.length ? [] : [`${this.history.length} coverage record(s) were explicitly superseded; history remains in the ledger.`]),
    ] });
  }
  superseded(): readonly CoverageRecord[] { return freeze([...this.history]); }
}

/**
 * Report-finalization gate for the planner's planned coverage universe. A cell that is open or needs_follow_up
 * blocks finalization unless the plan ledger recorded a resolution or an explicit carry as untested/blocked with a
 * reason; nothing is filtered out and no cell silently disappears. A report built without a plan reconciliation is
 * unaffected, so the gate cannot be bypassed by omitting an empty universe.
 */
export function assertPlanCoverageFinalizable(reconciliation: CoverageReconciliation, runId: string): void {
  if (reconciliation.runId !== runId) throw new EvidenceError('plan-coverage-run', 'Plan coverage reconciliation belongs to another run');
  if (reconciliation.canFinalize) return;
  const unresolved = reconciliation.unresolved.slice(0, 20).join(', ');
  const issue = reconciliation.issues.find(candidate => candidate.code === 'coverage-unresolved-cell');
  throw new EvidenceError('coverage-unresolved-cell',
    `Report cannot finalize: ${reconciliation.unresolved.length} planned coverage cell(s) are open or needs_follow_up and are not explicitly carried as untested/blocked (${unresolved})${issue ? `; ${issue.message}` : ''}`);
}
