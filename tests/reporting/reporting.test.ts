import { expect, test } from 'vitest';
import type { HandoffPacket } from '../../src/contracts/index.js';
import { reviewHandoff, validateFinding, type HandoffReview } from '../../src/evidence/index.js';
import { assertReport, buildReport, CoverageLedger, recordRemediation, recordRetest, renderJson, renderMarkdown, renderSarif } from '../../src/reporting/index.js';
import { collectContractEvidence, createHarness, findingFixture, packetFixture, reviewContext } from '../evidence/fixtures.js';
import { acceptedCoverage, coverReceipt, QUESTIONS, runtimeReceipt, terminalAttempt } from './fixtures.js';

function fixture(contract: 'H4' | 'H5' | 'H6' = 'H4', withFinding = true) {
  const h = createHarness();
  collectContractEvidence(h);
  runtimeReceipt(h);
  const handoff: HandoffReview = reviewHandoff(h.vault, packetFixture(h, contract), reviewContext(h));
  expect(handoff.decision.status).toBe('accepted');
  const finding = withFinding ? validateFinding(h.vault, findingFixture(h), { reviewerId: 'reviewer-1', now: h.task.createdAt }) : undefined;
  if (finding) expect(finding.status).toBe('accepted');
  const coverage = [
    acceptedCoverage(h, 'coverage-tested', QUESTIONS.tested, { state: 'tested', evidenceIds: [coverReceipt(h, 'cover-tested', QUESTIONS.tested, 'handler', 'local-reader', 'regression')] }),
    acceptedCoverage(h, 'coverage-ruled-out', QUESTIONS.ruledOut, { state: 'ruled-out', evidenceIds: [coverReceipt(h, 'cover-ruled-out', QUESTIONS.ruledOut)] }),
  ];
  return { h, handoff, finding, coverage };
}
test('accepted evidence renders as bounded Markdown, JSON and SARIF with explicit gaps', () => {
  const { h, handoff, finding, coverage } = fixture();
  try {
    const report = buildReport({ vault: h.vault, run: h.run, tasks: [h.task], attempts: [terminalAttempt(h, { runtimeEvidenceId: 'runtime-receipt' })],
      handoffs: [handoff], findings: finding ? [finding] : [], coverage,
      coveragePlan: [
        { surfaceId: 'handler', actorId: 'local-reader', question: QUESTIONS.tested, taskId: h.task.taskId },
        { surfaceId: 'handler', actorId: 'local-reader', question: QUESTIONS.ruledOut, taskId: h.task.taskId },
        { surfaceId: 'handler', actorId: 'local-reader', question: QUESTIONS.untested, taskId: h.task.taskId },
      ], generatedAt: h.task.createdAt });
    expect(report.assessmentStatus).toBe('incomplete');
    expect(report.coverage.counts).toMatchObject({ tested: 1, 'ruled-out': 1, untested: 1 });
    expect(() => assertReport(report)).not.toThrow();
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('does not assert comprehensive testing');
    expect(markdown).toContain('untested');
    expect(markdown).toContain(report.findings[0].findingId);
    const json = JSON.parse(renderJson(report));
    expect(json).toMatchObject({ schemaVersion: 1, runId: h.run.runId, assessmentStatus: 'incomplete' });
    expect(renderJson(report)).toBe(renderJson(report));
    const sarif = JSON.parse(renderSarif(report));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(1);
    expect(sarif.runs[0].results[0].properties.verification).toBe('reproduced');
    expect(sarif.runs[0].invocations[0].toolExecutionNotifications.some((n: { message: { text: string } }) => n.message.text.includes('untested'))).toBe(true);
  } finally { h.dispose(); }
});
test('only authenticated reviews, findings and reports are renderable', () => {
  const { h, handoff, finding } = fixture();
  try {
    const report = buildReport({ vault: h.vault, run: h.run, tasks: [h.task], attempts: [h.attempt], handoffs: [handoff], findings: finding ? [finding] : [], coverage: [], coveragePlan: [], generatedAt: h.task.createdAt });
    expect(() => renderMarkdown({ ...report })).toThrow(/authenticated accepted data/);
    const forged = { ...handoff, decision: { ...handoff.decision, status: 'accepted' as const } };
    expect(() => buildReport({ vault: h.vault, run: h.run, tasks: [h.task], attempts: [h.attempt], handoffs: [forged], findings: [], coverage: [], coveragePlan: [], generatedAt: h.task.createdAt })).toThrow(/authenticated handoff review/);
    expect(() => buildReport({ vault: h.vault, run: h.run, tasks: [h.task], attempts: [h.attempt], handoffs: [], findings: finding ? [finding] : [], coverage: [], coveragePlan: [], generatedAt: h.task.createdAt })).toThrow(/no accepted producing handoff/);
  } finally { h.dispose(); }
});
test('coverage ledger keeps unplanned cells untested and needs explicit supersession', () => {
  const h = createHarness();
  try {
    const ledger = new CoverageLedger(h.vault, h.run.runId, [{ surfaceId: 'handler', actorId: 'local-reader', question: QUESTIONS.tested, taskId: h.task.taskId }]);
    expect(ledger.snapshot().records[0].state).toBe('untested');
    expect(ledger.snapshot().completeWithinPlan).toBe(false);
    const first = acceptedCoverage(h, 'coverage-1', QUESTIONS.tested, { state: 'not-applicable', basis: 'reviewer-validated' });
    ledger.accept(first);
    expect(ledger.snapshot().completeWithinPlan).toBe(true);
    const changed = acceptedCoverage(h, 'coverage-2', QUESTIONS.tested, { state: 'blocked', basis: 'reviewer-validated', reason: 'fixture unavailable' });
    expect(() => ledger.accept(changed)).toThrow(/explicit reviewer-backed supersession/);
    ledger.accept(changed, { supersedes: 'coverage-1' });
    expect(ledger.superseded()).toHaveLength(1);
    expect(ledger.snapshot().records[0].state).toBe('blocked');
    expect(() => ledger.accept(acceptedCoverage(h, 'coverage-out', QUESTIONS.outOfPlan, { state: 'not-applicable', basis: 'reviewer-validated' }))).toThrow(/outside the planned/);
  } finally { h.dispose(); }
});
test('remediation and retest records are derived from accepted H5 and H6 data', () => {
  const h = createHarness();
  const h6 = createHarness();
  try {
    collectContractEvidence(h);
    const h5Packet = packetFixture(h, 'H5') as Extract<HandoffPacket, { contract: 'H5' }>;
    h5Packet.evidenceIds = [...h5Packet.evidenceIds, 'repro', 'negative'];
    const handoff = reviewHandoff(h.vault, h5Packet, reviewContext(h));
    expect(handoff.decision.status).toBe('accepted');
    const finding = validateFinding(h.vault, findingFixture(h), { reviewerId: 'reviewer-1', now: h.task.createdAt });
    expect(finding.status).toBe('accepted');
    const remediation = recordRemediation(h.vault, { remediationId: 'remediation-1', handoff, finding: finding! });
    expect(remediation).toMatchObject({ status: 'proposed', repairKind: 'root-cause', invariant: finding!.finding!.claim });
    const report = buildReport({ vault: h.vault, run: h.run, tasks: [h.task], attempts: [h.attempt], handoffs: [handoff], findings: [finding!], coverage: [], coveragePlan: [], remediation: [remediation], generatedAt: h.task.createdAt });
    expect(renderMarkdown(report)).toContain('remediation-1');
    collectContractEvidence(h6);
    const h6Handoff = reviewHandoff(h6.vault, packetFixture(h6, 'H6'), reviewContext(h6));
    const h5Handoff = reviewHandoff(h6.vault, packetFixture(h6, 'H5'), reviewContext(h6));
    expect(h6Handoff.decision.status).toBe('accepted');
    const h6Finding = validateFinding(h6.vault, findingFixture(h6), { reviewerId: 'reviewer-1', now: h6.task.createdAt });
    expect(h6Finding.status).toBe('accepted');
    const linked = recordRemediation(h6.vault, { remediationId: 'remediation-2', handoff: h5Handoff, finding: h6Finding });
    const retest = recordRetest(h6.vault, { retestId: 'retest-1', handoff: h6Handoff, remediation: linked });
    expect(retest.closure).toBe('repaired');
    const mitigationPacket = packetFixture(h6, 'H5') as Extract<HandoffPacket, { contract: 'H5' }>;
    mitigationPacket.packetId = 'packet-H5-mitigation';
    mitigationPacket.details.repairKind = 'exposure-mitigation';
    const mitigationReview = reviewHandoff(h6.vault, mitigationPacket, reviewContext(h6));
    expect(mitigationReview.decision.status).toBe('accepted');
    const mitigation = recordRemediation(h6.vault, { remediationId: 'remediation-3', handoff: mitigationReview, finding: h6Finding });
    expect(() => recordRetest(h6.vault, { retestId: 'retest-2', handoff: h6Handoff, remediation: mitigation })).toThrow(/cannot be relabelled root-cause closure/);
    expect(linked.limitations.some(l => l.includes('H5 proposes repair'))).toBe(true);
  } finally { h.dispose(); h6.dispose(); }
});
