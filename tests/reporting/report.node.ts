import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestJson, type CoverageRecord } from '../../src/contracts/index.js';
import { reviewHandoff, validateFinding, type HandoffReview } from '../../src/evidence/index.js';
import { assertCoverageReview, assertRemediation, assertReport, assertRetest, buildReport, CoverageLedger, recordRemediation, recordRetest, renderJson, renderMarkdown, renderSarif, type AssessmentReport } from '../../src/reporting/index.js';
import { collectContractEvidence, createHarness, findingFixture, packetFixture, reviewContext, type Harness } from '../evidence/fixtures.js';
import { acceptedCoverage, coverReceipt, coverageRecord, QUESTIONS, runtimeReceipt, terminalAttempt } from './fixtures.js';

interface Built { report: AssessmentReport; handoff: HandoffReview }
function baseReport(h: Harness, options: { coverage?: boolean; runtime?: boolean; contract?: 'H4' | 'H5' | 'H6'; findingState?: 'reproduced' | 'supported-static'; finding?: 'default' | 'none' } = {}): Built {
  collectContractEvidence(h);
  if (options.runtime !== false) runtimeReceipt(h);
  const handoff = reviewHandoff(h.vault, packetFixture(h, options.contract ?? 'H4'), reviewContext(h));
  assert.equal(handoff.decision.status, 'accepted', handoff.decision.reasons.map(r => r.code).join(', '));
  const findingState = options.findingState ?? 'reproduced';
  if (findingState === 'supported-static') h.collect('static-source', 'source');
  const findingReview = options.finding === 'none' ? undefined : validateFinding(h.vault, findingFixture(h, findingState), { reviewerId: 'reviewer-1', now: h.task.createdAt });
  if (findingReview) assert.equal(findingReview.status, 'accepted', findingReview.issues.map(i => i.code).join(', '));
  const coverage = options.coverage === false ? [] : [
    acceptedCoverage(h, 'coverage-tested', QUESTIONS.tested, { state: 'tested', evidenceIds: [coverReceipt(h, 'cover-tested', QUESTIONS.tested, 'handler', 'local-reader', 'regression')] }),
    acceptedCoverage(h, 'coverage-ruled-out', QUESTIONS.ruledOut, { state: 'ruled-out', evidenceIds: [coverReceipt(h, 'cover-ruled-out', QUESTIONS.ruledOut)] }),
    acceptedCoverage(h, 'coverage-not-applicable', QUESTIONS.untested, { state: 'not-applicable', basis: 'reviewer-validated', reason: 'The blocked-actor path is outside the declared local fixture universe' }),
  ];
  const report = buildReport({ vault: h.vault, run: h.run, tasks: [h.task], attempts: [options.runtime === false ? h.attempt : terminalAttempt(h, { runtimeEvidenceId: 'runtime-receipt' })],
    handoffs: [handoff], findings: findingReview ? [findingReview] : [], coverage,
    coveragePlan: [
      { surfaceId: 'handler', actorId: 'local-reader', question: QUESTIONS.tested, taskId: h.task.taskId },
      { surfaceId: 'handler', actorId: 'local-reader', question: QUESTIONS.ruledOut, taskId: h.task.taskId },
      { surfaceId: 'handler', actorId: 'local-reader', question: QUESTIONS.untested, taskId: h.task.taskId },
    ], generatedAt: h.task.createdAt });
  return { report, handoff };
}
test('report renders accepted data as Markdown, JSON and SARIF without claiming completeness', () => {
  const h = createHarness();
  try {
    const { report } = baseReport(h);
    assert.equal(report.assessmentStatus, 'bounded-complete');
    assert.equal(report.coverage.completeWithinPlan, true);
    assert.equal(report.limitations.some(l => l.includes('not a comprehensive assessment')), true);
    assert.equal(report.findings.length, 1);
    assert.equal(report.coverage.counts.tested, 1);
    assert.equal(report.coverage.records.length, 3);
    const markdown = renderMarkdown(report), json = JSON.parse(renderJson(report)), sarif = JSON.parse(renderSarif(report));
    assert.match(markdown, /does not assert comprehensive testing/);
    assert.match(markdown, /\| handler \| local-reader \|/);
    assert.match(markdown, /not-a-test-receipt|test/);
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.runId, h.run.runId);
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs[0].results[0].ruleId, 'p2o/finding-1');
    assert.equal(sarif.runs[0].results[0].properties.verification, 'reproduced');
    assert.equal(sarif.runs[0].invocations[0].executionSuccessful, true);
    assert.doesNotThrow(() => assertReport(report));
  } finally { h.dispose(); }
});
test('untested, blocked and returned records stay visible; execution failures are not hidden', () => {
  const h = createHarness();
  try {
    const { report } = baseReport(h, { runtime: false, coverage: false });
    assert.equal(report.assessmentStatus, 'incomplete');
    assert.equal(report.processes[0].state, 'running');
    assert.equal(report.processes[0].runtimeEvidenceVerified, false);
    assert.equal(report.coverage.counts.untested, 3);
    assert.match(renderMarkdown(report), /untested/);
    assert.match(renderMarkdown(report), /Runtime selection/);
    assert.equal(report.limitations.some(l => l.includes('execution failure') || l.includes('Process, packet and finding states are separate')), true);
  } finally { h.dispose(); }
});
test('a planned question with no accepted record becomes an explicit untested gap', () => {
  const h = createHarness();
  try {
    const ledger = new CoverageLedger(h.vault, h.run.runId, [{ surfaceId: 'handler', actorId: 'local-reader', question: QUESTIONS.tested, taskId: h.task.taskId }]);
    const summary = ledger.snapshot();
    assert.equal(summary.records.length, 1);
    assert.equal(summary.records[0].state, 'untested');
    assert.equal(summary.completeWithinPlan, false);
    assert.equal(summary.limitations.some(l => l.includes('bounded to the declared')), true);
  } finally { h.dispose(); }
});
test('tested coverage requires a bound test receipt, and not-applicable requires review', () => {
  const h = createHarness();
  try {
    const unbound = acceptedCoverage(h, 'coverage-tested', QUESTIONS.tested, { state: 'tested', evidenceIds: [] });
    assert.equal(unbound.status, 'returned-for-evidence');
    const assertion = acceptedCoverage(h, 'coverage-worker', QUESTIONS.tested, { state: 'tested', basis: 'worker-asserted', evidenceIds: [coverReceipt(h, 'cover-assert', QUESTIONS.tested, 'handler', 'local-reader', 'regression')] });
    assert.equal(assertion.status, 'returned-for-evidence');
    assert.ok(assertion.issues.some(i => i.code === 'coverage-test'));
    const na = acceptedCoverage(h, 'coverage-na', QUESTIONS.untested, { state: 'not-applicable', basis: 'runtime-observed', reason: 'assumed irrelevant' });
    assert.equal(na.status, 'returned-for-evidence');
    assert.ok(na.issues.some(i => i.code === 'coverage-applicability'));
    const wrongIdentity = acceptedCoverage(h, 'coverage-identity', QUESTIONS.tested, { state: 'tested', evidenceIds: [coverReceipt(h, 'cover-other', QUESTIONS.tested, 'other-surface', 'local-reader', 'regression')] });
    assert.equal(wrongIdentity.status, 'returned-for-evidence');
    assert.ok(wrongIdentity.issues.some(i => i.code === 'coverage-identity'));
  } finally { h.dispose(); }
});
test('ruled-out coverage rejects failed controls instead of deleting the gap', () => {
  const h = createHarness();
  try {
    h.collect('cover-failed', 'test', { metadata: { claimDigest: digestJson(QUESTIONS.ruledOut), surfaceId: 'handler', actorId: 'local-reader' },
      test: { purpose: 'negative-control', outcome: 'failed', successes: 0, attempts: 1, invariant: QUESTIONS.ruledOut, originalPolicy: true } });
    const review = acceptedCoverage(h, 'coverage-ruled-out', QUESTIONS.ruledOut, { state: 'ruled-out', evidenceIds: ['cover-failed'] });
    assert.equal(review.status, 'returned-for-evidence');
    assert.ok(review.issues.some(i => i.code === 'coverage-negative'));
  } finally { h.dispose(); }
});
test('coverage outside the plan and silent replacement of a decision are refused', () => {
  const h = createHarness();
  try {
    const ledger = new CoverageLedger(h.vault, h.run.runId, [{ surfaceId: 'handler', actorId: 'local-reader', question: QUESTIONS.tested, taskId: h.task.taskId }]);
    const outOfPlan = acceptedCoverage(h, 'coverage-out', QUESTIONS.outOfPlan, { state: 'not-applicable', basis: 'reviewer-validated' });
    assert.equal(outOfPlan.status, 'accepted');
    assert.throws(() => ledger.accept(outOfPlan), /outside the planned/);
    const first = acceptedCoverage(h, 'coverage-1', QUESTIONS.tested, { state: 'not-applicable', basis: 'reviewer-validated' });
    ledger.accept(first);
    const changed = acceptedCoverage(h, 'coverage-2', QUESTIONS.tested, { state: 'blocked', basis: 'reviewer-validated', reason: 'fixture unavailable' });
    assert.throws(() => ledger.accept(changed), /explicit reviewer-backed supersession/);
    ledger.accept(changed, { supersedes: 'coverage-1' });
    assert.equal(ledger.superseded().length, 1);
    assert.equal(ledger.snapshot().records[0].state, 'blocked');
  } finally { h.dispose(); }
});
test('worker-authored accepted flags, digests and reviews are never trusted', () => {
  const h = createHarness();
  try {
    const { handoff, report } = baseReport(h);
    const forged = { ...handoff, decision: { ...handoff.decision, status: 'accepted' as const } };
    assert.throws(() => assertReport({ ...report, runId: 'other-run' }), /authenticated accepted data/);
    assert.throws(() => buildReport({ vault: h.vault, run: h.run, tasks: [h.task], attempts: [h.attempt], handoffs: [forged], findings: [], coverage: [], coveragePlan: [], generatedAt: h.task.createdAt }), /authenticated handoff review/);
    assert.throws(() => renderMarkdown({ ...report } as AssessmentReport), /authenticated accepted data/);
    assert.throws(() => assertReport(undefined as unknown as AssessmentReport), /authenticated accepted data/);
  } finally { h.dispose(); }
});
test('findings without an accepted producing packet or with stale proof are refused', () => {
  const h = createHarness();
  try {
    const { report } = baseReport(h);
    assert.equal(report.packets.length, 1);
    const findingReview = validateFinding(h.vault, findingFixture(h), { reviewerId: 'reviewer-1', now: h.task.createdAt });
    assert.equal(findingReview.status, 'accepted');
    assert.throws(() => buildReport({ vault: h.vault, run: h.run, tasks: [h.task], attempts: [h.attempt], handoffs: [], findings: [findingReview], coverage: [], coveragePlan: [], generatedAt: h.task.createdAt }), /no accepted producing handoff/);
  } finally { h.dispose(); }
});
test('remediation and retest records derive from accepted H5/H6 contracts only', () => {
  const h = createHarness();
  try {
    const { handoff, report } = baseReport(h, { contract: 'H5', finding: 'none' });
    const findingReview = validateFinding(h.vault, findingFixture(h), { reviewerId: 'reviewer-1', now: h.task.createdAt });
    const remediation = recordRemediation(h.vault, { remediationId: 'remediation-1', handoff, finding: findingReview });
    assert.equal(remediation.status, 'proposed');
    assert.equal(remediation.repairKind, 'root-cause');
    assert.equal(renderMarkdown(report).includes('H5'), true);
    const h6 = createHarness();
    try {
      collectContractEvidence(h6);
      const h6Handoff = reviewHandoff(h6.vault, packetFixture(h6, 'H6'), reviewContext(h6));
      assert.equal(h6Handoff.decision.status, 'accepted');
      const h6Finding = validateFinding(h6.vault, findingFixture(h6), { reviewerId: 'reviewer-1', now: h6.task.createdAt });
      const h5ForH6 = reviewHandoff(h6.vault, packetFixture(h6, 'H5'), reviewContext(h6));
      const linked = recordRemediation(h6.vault, { remediationId: 'remediation-2', handoff: h5ForH6, finding: h6Finding });
      const retest = recordRetest(h6.vault, { retestId: 'retest-1', handoff: h6Handoff, remediation: linked });
      assert.equal(retest.closure, 'repaired');
      assert.doesNotThrow(() => assertRemediation(linked, h6.vault));
      assert.doesNotThrow(() => assertRetest(retest, h6.vault));
      assert.throws(() => assertRetest({ ...retest }, h6.vault), /accepted H6 data/);
      const mitigationPacket = packetFixture(h6, 'H5') as Extract<ReturnType<typeof packetFixture>, { contract: 'H5' }>;
      mitigationPacket.packetId = 'packet-H5-mitigation'; mitigationPacket.details.repairKind = 'exposure-mitigation';
      const mitigationReview = reviewHandoff(h6.vault, mitigationPacket, reviewContext(h6));
      assert.equal(mitigationReview.decision.status, 'accepted', mitigationReview.decision.reasons.map(r => r.code).join(', '));
      const mitigation = recordRemediation(h6.vault, { remediationId: 'remediation-3', handoff: mitigationReview, finding: h6Finding });
      assert.equal(mitigation.repairKind, 'exposure-mitigation');
      assert.throws(() => recordRetest(h6.vault, { retestId: 'retest-2', handoff: h6Handoff, remediation: mitigation }), /retest-repair-kind/);
    } finally { h6.dispose(); }
  } finally { h.dispose(); }
});
test('a bounded-complete report requires terminal verified execution and full planned coverage', () => {
  const h = createHarness();
  try {
    const { report } = baseReport(h, { findingState: 'supported-static' });
    assert.equal(report.assessmentStatus, 'incomplete');
    const complete = buildReport({ vault: h.vault, run: h.run, tasks: [h.task], attempts: [terminalAttempt(h, { runtimeEvidenceId: 'runtime-receipt' })],
      handoffs: [reviewHandoff(h.vault, packetFixture(h, 'H4'), reviewContext(h))], findings: [validateFinding(h.vault, findingFixture(h), { reviewerId: 'reviewer-1', now: h.task.createdAt })],
      coverage: [acceptedCoverage(h, 'coverage-tested-2', QUESTIONS.tested, { state: 'tested', evidenceIds: [coverReceipt(h, 'cover-tested-2', QUESTIONS.tested, 'handler', 'local-reader', 'regression')] })],
      coveragePlan: [{ surfaceId: 'handler', actorId: 'local-reader', question: QUESTIONS.tested, taskId: h.task.taskId }], generatedAt: h.task.createdAt });
    assert.equal(complete.assessmentStatus, 'bounded-complete', JSON.stringify({ limitations: complete.limitations, returned: complete.returned }));
    assert.equal(complete.coverage.completeWithinPlan, true, JSON.stringify(complete.coverage));
    assert.equal(renderMarkdown(complete).includes('bounded-complete'), true);
  } finally { h.dispose(); }
});
test('markdown rendering neutralises injected markup from collected text', () => {
  const h = createHarness();
  try {
    collectContractEvidence(h);
    h.collect('injected', 'observation', { summary: '<script>alert(1)</script> | `code` [link](http://x) <!-- comment -->' },
      { allowedKinds: ['observation'] }, JSON.stringify({ note: 'injected fixture text' }));
    assert.equal(h.vault.get('source')!.kind, 'source');
    const injectedPacket = packetFixture(h, 'H4');
    (injectedPacket as { evidenceIds: string[] }).evidenceIds = ['source', 'injected'];
    const handoff = reviewHandoff(h.vault, injectedPacket, reviewContext(h));
    assert.equal(handoff.decision.status, 'accepted', handoff.decision.reasons.map(r => `${r.code}:${r.message}`).join(' | '));
    const report = buildReport({ vault: h.vault, run: h.run, tasks: [h.task], attempts: [h.attempt], handoffs: [handoff], findings: [], coverage: [], coveragePlan: [], generatedAt: h.task.createdAt });
    const markdown = renderMarkdown(report);
    assert.equal(markdown.includes('<script>'), false);
    assert.equal(markdown.includes('</script>'), false);
    assert.match(markdown, /&lt;script&gt;/);
    assert.equal(report.evidence.some(e => e.summary.includes('<script>')), true);
  } finally { h.dispose(); }
});
test('assertCoverageReview refuses fabricated coverage input', () => {
  const h = createHarness();
  try {
    const fabricated = { status: 'accepted', coverage: coverageRecord(h, 'c', QUESTIONS.tested, { state: 'not-applicable', basis: 'reviewer-validated' }), reviewerId: 'worker-1', evaluatedAt: h.task.createdAt, issues: [] } as unknown as CoverageRecord;
    assert.throws(() => assertCoverageReview(fabricated as never, h.vault), /receipt-backed/);
  } finally { h.dispose(); }
});
