import { canonicalJson } from '../contracts/index.js';
import { assertReport, type AssessmentReport } from './report.js';

/** Plain text only: target/worker text cannot inject HTML, report sections, links or fenced code. */
function md(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+|~]/g, '\\$&');
}
export function renderJson(report: AssessmentReport): string {
  assertReport(report);
  return `${JSON.stringify(JSON.parse(canonicalJson(report)), null, 2)}\n`;
}
export function renderMarkdown(report: AssessmentReport): string {
  assertReport(report);
  const rows = [`# Assessment ${md(report.runId)}`, '', `Status: **${md(report.assessmentStatus)}**. Run state: ${md(report.runState)}. Generated: ${md(report.generatedAt)}.`,
    '', 'This report is bounded to the declared scope and coverage plan; it does not assert comprehensive testing.', '',
    '## Accepted findings', ''];
  if (!report.findings.length) rows.push('No accepted findings. This is not evidence of absence.', '');
  for (const finding of report.findings) {
    rows.push(`### ${md(finding.findingId)} — ${md(finding.title)}`, '', `State: **${md(finding.state)}**; classification: ${md(finding.classification)}.`, '', md(finding.claim), '',
      `Receipts: ${finding.evidenceIds.map(md).join(', ')}.`, `Negative controls: ${finding.negativeControlEvidenceIds.map(md).join(', ') || 'none — do not infer verification'}.`);
    if (finding.verifier) rows.push(`Verifier: ${md(finding.verifier.identity)}; attempt: ${md(finding.verifier.attemptId)}; environment: ${md(finding.verifier.environmentId)}.`, `Verifier receipts: ${finding.verifier.evidenceIds.map(md).join(', ')}.`);
    if (finding.impact) rows.push(`Qualified impact: ${md(finding.impact)}.`);
    for (const limit of finding.limitations) rows.push(`- Limit: ${md(limit)}`);
    rows.push('');
  }
  rows.push('## Coverage and gaps', '', '| Surface | Actor | Question | State | Basis | Evidence / reason |', '|---|---|---|---|---|---|');
  for (const c of report.coverage.records) rows.push(`| ${md(c.surfaceId)} | ${md(c.actorId)} | ${md(c.question)} | ${md(c.state)} | ${md(c.basis)} | ${md(`${c.evidenceIds.join(', ')}; ${c.reason}`)} |`);
  if (!report.coverage.records.length) rows.push('| — | — | No coverage plan | untested | — | Universe not supplied |');
  rows.push('', '## Process and packet state (not finding proof)', '', '| Attempt | Process | Runtime selection | Receipt-backed runtime |', '|---|---|---|---|');
  for (const p of report.processes) rows.push(`| ${md(p.attemptId)} | ${md(p.state)}${p.exit ? `; exit ${md(String(p.exit.code))}` : ''} | requested ${md(`${p.requestedRuntime.selection.provider}/${p.requestedRuntime.selection.model}/${p.requestedRuntime.selection.thinking}`)}; observed ${md(p.observedRuntime?.selection ? `${p.observedRuntime.selection.provider}/${p.observedRuntime.selection.model}/${p.observedRuntime.selection.thinking}` : 'unavailable')} | ${p.runtimeEvidenceVerified ? 'yes (collector provenance)' : 'no'}; ${md(p.runtimeDiscrepancies.join(', '))} |`);
  rows.push('');
  for (const p of report.packets) rows.push(`- ${md(p.packetId)}: accepted ${md(p.contract)} / ${md(p.outcome)} / ${md(p.classification)} by ${md(p.reviewerId)}; digest ${md(p.acceptedDigest)}.`);
  rows.push('', '## Returned / rejected observations', '');
  if (!report.returned.length) rows.push('No returned records supplied.');
  for (const returned of report.returned) {
    rows.push(`- ${md(returned.category)} ${md(returned.identity)}: returned for evidence (${returned.codes.map(md).join(', ')}).`);
    for (const question of returned.questions) rows.push(`  - ${md(question)}`);
  }
  rows.push('', '## Remediation and retest', '');
  for (const r of report.remediation) {
    rows.push(`- ${md(r.remediationId)} for ${md(r.findingId)}: **${md(r.status)}**, ${md(r.repairKind)}.`, `  - Invariant: ${md(r.invariant)}. Enforcement: ${md(r.enforcementPoint)}.`,
      `  - Consumers/variants: ${[...r.affectedConsumers, ...r.variants].map(md).join(', ')}.`, `  - Regression properties: ${r.regressionProperties.map(md).join('; ')}.`, `  - Source/shipped gap: ${md(r.sourceShippedGap)}.`, `  - Evidence: ${r.evidenceIds.map(md).join(', ')}.`);
  }
  for (const r of report.retests) {
    rows.push(`- ${md(r.retestId)} for ${md(r.remediationId)}: **${md(r.closure)}**.`, `  - Accepted controls: ${r.acceptedControlEvidenceIds.map(md).join(', ')}. Forbidden classes: ${r.forbiddenClassEvidenceIds.map(md).join(', ')}.`, `  - Deployment receipts: ${r.evidenceIds.map(md).join(', ')}.`, `  - Activation/rollout: ${md(r.rollout)}; ${r.activationRequirements.map(md).join('; ')}.`);
    for (const risk of r.residualRisks) rows.push(`  - Residual: ${md(risk)}`);
  }
  if (!report.remediation.length && !report.retests.length) rows.push('No accepted remediation/retest records. No closure inferred.');
  rows.push('', '## Receipt integrity and denominators', '', '| Evidence | Kind / classification | SHA-256 (preserved) | Collector / environment | Test denominator | Summary |', '|---|---|---|---|---|---|');
  for (const e of report.evidence) rows.push(`| ${md(e.evidenceId)} | ${md(`${e.kind} / ${e.classification}`)} | ${md(e.digest)} | ${md(`${e.collectorId} (${e.collectorRole}; ${e.attestation === 'controller' ? 'controller-attested' : 'vault-preserved'}) / ${e.environmentId}`)} | ${e.test ? md(`${e.test.outcome}: ${e.test.successes}/${e.test.attempts}; original policy ${e.test.originalPolicy}`) : 'not a test receipt'} | ${md(e.summary)} |`);
  rows.push('', '## Limitations', '');
  for (const limit of report.limitations) rows.push(`- ${md(limit)}`);
  return `${rows.join('\n')}\n`;
}
export function renderSarif(report: AssessmentReport): string {
  assertReport(report);
  const rules = report.findings.map(f => ({ id: `p2o/${f.findingId}`, name: f.findingId, shortDescription: { text: f.title }, fullDescription: { text: f.claim }, properties: { verification: f.state, classification: f.classification } }));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0',
    runs: [{ tool: { driver: { name: 'pi-p2o', version: 'evidence-reporting-v1', rules } },
      invocations: [{ executionSuccessful: report.processes.every(p => p.state === 'exited' && p.exit?.code === 0),
        toolExecutionNotifications: [...report.returned.map(r => ({ level: 'warning', message: { text: `${r.category} ${r.identity}: returned for evidence; ${r.questions.join('; ')}` } })),
          ...report.coverage.records.filter(c => ['blocked', 'untested'].includes(c.state)).map(c => ({ level: 'note', message: { text: `${c.state}: ${c.surfaceId}/${c.actorId}: ${c.question}; ${c.reason}` } }))] }],
      results: report.findings.map((f, index) => ({ ruleId: `p2o/${f.findingId}`, ruleIndex: index,
        kind: f.state === 'rejected' ? 'notApplicable' : ['reproduced', 'independently-validated'].includes(f.state) ? 'fail' : 'review',
        level: f.state === 'rejected' ? 'none' : f.state === 'independently-validated' ? 'warning' : 'note',
        message: { text: `[${f.state}; ${f.classification}] ${f.claim}${f.limitations.length ? ` Limits: ${f.limitations.join('; ')}` : ''}` },
        partialFingerprints: { 'p2oFindingId/v1': f.findingId },
        properties: { verification: f.state, classification: f.classification, evidenceIds: f.evidenceIds, negativeControlEvidenceIds: f.negativeControlEvidenceIds, ...(f.verifier ? { verifier: f.verifier } : {}) },
      })),
      properties: { runId: report.runId, assessmentStatus: report.assessmentStatus, coverage: report.coverage, remediation: report.remediation, retests: report.retests, limitations: report.limitations },
    }],
  };
  return `${JSON.stringify(JSON.parse(canonicalJson(sarif)), null, 2)}\n`;
}
