// Regression for the report-finalization coverage gate (workstream P2, deliverable 2).
//
// A report cannot finalize while a planned coverage cell is open or `needs_follow_up` and was not explicitly
// carried into the report as untested/blocked with a reason. The gate is exercised through the real
// `buildReport` path, not only through the reconciliation helper.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { reconcileCoverage, type PlanCoverageCell, type PlanCoverageResolution, type CoverageReconciliation } from '../../src/contracts/index.js';
import { reviewHandoff, validateFinding } from '../../src/evidence/index.js';
import { assertPlanCoverageFinalizable, buildReport } from '../../src/reporting/index.js';
import { collectContractEvidence, createHarness, findingFixture, packetFixture, reviewContext, type Harness } from '../evidence/fixtures.js';
import { runtimeReceipt, terminalAttempt } from '../reporting/fixtures.js';

const QUESTION = 'Is the local handler gate enforced for the tested actor?';
const NOW = '2026-10-02T10:00:00.000Z';

function cell(overrides: Partial<PlanCoverageCell> = {}): PlanCoverageCell {
  return { cellId: 'cell-1', taskId: 'task-1', surfaceId: 'handler', actorId: 'local-reader', question: QUESTION, ...overrides };
}

function resolution(overrides: Partial<PlanCoverageResolution> = {}): PlanCoverageResolution {
  return {
    runId: 'run-1', cellId: 'cell-1', outcome: 'resolved', basis: 'runtime-observed', evidenceIds: ['evidence-1'],
    reason: 'Accepted runtime evidence closes this planned cell', carried: false, authorAttemptId: 'attempt-1', at: NOW,
    ...overrides,
  };
}

function baseReport(h: Harness, planCoverage?: CoverageReconciliation) {
  collectContractEvidence(h);
  runtimeReceipt(h);
  const handoff = reviewHandoff(h.vault, packetFixture(h), reviewContext(h));
  assert.equal(handoff.decision.status, 'accepted', handoff.decision.reasons.map(reason => reason.code).join(', '));
  const finding = validateFinding(h.vault, findingFixture(h, 'reproduced'), { reviewerId: 'reviewer-1', now: h.task.createdAt });
  assert.equal(finding.status, 'accepted', finding.issues.map(issue => issue.code).join(', '));
  return buildReport({
    vault: h.vault, run: h.run, tasks: [h.task],
    attempts: [terminalAttempt(h, { runtimeEvidenceId: 'runtime-receipt' })],
    handoffs: [handoff], findings: [finding],
    coveragePlan: [], coverage: [], generatedAt: h.task.createdAt,
    ...(planCoverage ? { planCoverage } : {}),
  });
}

test('an open planned cell blocks report finalization with the explicit coverage gate code', () => {
  const h = createHarness();
  try {
    const open = reconcileCoverage([cell()], [], { runId: h.run.runId });
    assert.equal(open.canFinalize, false);
    assert.deepEqual(open.unresolved, ['cell-1']);
    assert.throws(() => assertPlanCoverageFinalizable(open, h.run.runId), /coverage-unresolved-cell/);
    assert.throws(() => assertPlanCoverageFinalizable(open, 'another-run'), /plan-coverage-run/);
    assert.throws(() => baseReport(h, open), /coverage-unresolved-cell/);
  } finally { h.dispose(); }
});

test('needs_follow_up is not carried implicitly: only untested/blocked with carried:true closes the gate', () => {
  const h = createHarness();
  try {
    const openFollowUp = reconcileCoverage([cell()], [resolution({ outcome: 'needs_follow_up', carried: false, evidenceIds: [], reason: 'Credentials for the second branch are missing' })], { runId: h.run.runId });
    assert.equal(openFollowUp.canFinalize, false);
    assert.deepEqual(openFollowUp.unresolved, ['cell-1']);
    assert.throws(() => baseReport(h, openFollowUp), /coverage-unresolved-cell/);

    const falselyCarried = reconcileCoverage([cell()], [resolution({ outcome: 'needs_follow_up', carried: true, evidenceIds: [], reason: 'Still open but marked carried' })], { runId: h.run.runId });
    assert.equal(falselyCarried.canFinalize, false, 'needs_follow_up is never carried as a report state');

    const carriedUntested = reconcileCoverage([cell()], [resolution({ outcome: 'untested', carried: true, evidenceIds: [], basis: 'worker-asserted', reason: 'The branch needs credentials this run does not hold' })], { runId: h.run.runId });
    assert.equal(carriedUntested.canFinalize, true);
    const report = baseReport(h, carriedUntested);
    assert.equal(report.coverage.records.length, 0);
    assert.ok(report.limitations.some(line => line.includes('Carried as untested: cell-1')));
    assert.ok(report.limitations.some(line => line.includes('Planned coverage reconciled: 0 resolved, 1 explicitly carried, 0 unresolved')));
  } finally { h.dispose(); }
});

test('resolved and not_applicable cells close the gate and stay visible in the report context', () => {
  const h = createHarness();
  try {
    const resolved = reconcileCoverage([cell()], [resolution()], { runId: h.run.runId });
    assert.equal(resolved.canFinalize, true);
    assert.deepEqual(resolved.resolved, ['cell-1']);
    const report = baseReport(h, resolved);
    assert.ok(report.limitations.some(line => line.includes('Planned coverage reconciled: 1 resolved')));
    assert.ok(report.limitations.some(line => line.includes('bounded to the planned cell universe')));

    const notApplicable = reconcileCoverage([cell()], [resolution({ outcome: 'not_applicable', evidenceIds: [], reason: 'Surface is outside the declared assessment universe' })], { runId: h.run.runId });
    assert.equal(notApplicable.canFinalize, true);
    assert.equal(notApplicable.cells[0]?.reportState, 'not-applicable');
  } finally { h.dispose(); }
});
