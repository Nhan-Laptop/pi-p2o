import { caseViews, type CaseView } from './cases.js';
import { coverageViews, type CoverageContext, type CoveragePlanView } from './coverage.js';
import { redact } from './evidence.js';
import { cleanText } from './process.js';
import type { LedgerIndex } from './records.js';
import { reportProjection, type ReportProjectionContext } from './report.js';
import { taskFrontier } from './tasks.js';
import { sha256Hex } from './validate.js';

/**
 * Deterministic human report rendered from committed state. No model, no clock, no random values: the same state at the same
 * sequence yields the same bytes. Every target- or model-derived string passes through `mdText`/`csvCell`, so a hostile value cannot
 * become a link, image, HTML, fence, table break, spreadsheet formula or terminal escape. The report is an attributed index, never a verdict.
 */
export const REPORT_FORMAT_VERSION = 1;
const ROWS = 200, CASE_ROWS = 500, TEXT = 300, CSV_TEXT = 500;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export interface ReportMeta {
  runId: string; target: string; retention: string; historical: boolean; asOfSequence: number; storeSchema: number;
  runtime: { hash: string; version?: string }; complete: boolean;
}
export interface ReportFile { name: string; body: string }
export interface RenderedReport { files: ReportFile[]; counts: { acceptedCurrent: number; cases: number; coverageCells: number; openGaps: number; claims: number } }

/** Inline Markdown-safe text: one line, bounded, HTML and Markdown syntax neutralized, autolinks broken. */
export function mdText(value: unknown, limit = TEXT): string {
  let text = cleanText(redact(String(value ?? ''))).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const cut = text.length > limit; if (cut) text = text.slice(0, limit);
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]()!|~#@]/g, match => `\\${match}`)
    .replace(/:\/\//g, '\\://').replace(/\bwww\./gi, match => `${match.slice(0, 3)}\\.`);
  return cut ? `${text}…` : text;
}
/** One quoted CSV field; a leading formula character is defused and line breaks cannot add rows. */
export function csvCell(value: unknown, limit = CSV_TEXT): string {
  let text = cleanText(redact(String(value ?? ''))).replace(INVISIBLE, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
const csvRow = (cells: unknown[]) => cells.map(cell => csvCell(cell)).join(',');
const ids = (values: readonly string[] | undefined, limit = 6) => !values?.length ? 'none' : `${values.slice(0, limit).map(id => mdText(id, 80)).join(', ')}${values.length > limit ? `, … +${values.length - limit}` : ''}`;
const list = (values: readonly string[] | undefined, limit = 6) => !values?.length ? 'none' : `${values.slice(0, limit).join('; ')}${values.length > limit ? `; … +${values.length - limit}` : ''}`;
const rows = <T>(items: T[], limit: number) => ({ shown: items.slice(0, limit), omitted: Math.max(0, items.length - limit) });

function caseSection(view: CaseView): string {
  return [`### ${mdText(view.title, 160)} — case ${mdText(view.id, 80)} r${view.revision}`,
    `- Verdict **${mdText(view.verdict)}**; review **${mdText(view.reviewStatus)}**; currentness **${mdText(view.currentness)}**; independent validation current: ${view.independentCurrent ? 'yes' : 'no'}`,
    `- Policy: ${mdText(view.policyKey, 160)}${view.rootCauseKey ? `; root cause: ${mdText(view.rootCauseKey, 160)}` : ''}`,
    `- Assets: ${ids(view.assetRefs.map(ref => ref.id))}; claims: ${ids(view.claimRefs)}; independent evidence: ${ids(view.independentEvidenceRefs)}; tasks: ${ids(view.taskRefs.map(ref => `${ref.taskId}@r${ref.revision ?? '?'}`))}`,
    `- Contradictions: ${view.contradictions.length ? view.contradictions.slice(0, 6).map(item => `${mdText(item.evidenceRef, 80)} (${mdText(item.status)})`).join(', ') : 'none recorded'}; affected variants: ${list(view.affectedVariants.map(item => mdText(item, 120)))}`,
    `- Remediation: ${mdText(view.remediation.status)} — ${mdText(view.remediation.reason, 200)}`,
    `- Reviewer reasoning: ${mdText(view.reviewReason)}`, `- Limitations: ${mdText(view.limitations)}`].join('\n');
}

export function renderReport(index: LedgerIndex, context: ReportProjectionContext & { coverage?: CoverageContext }, meta: ReportMeta): RenderedReport {
  const projection = reportProjection(index, context), tasks = taskFrontier(index);
  const cases = caseViews(index, context.cases ?? {}), plans: CoveragePlanView[] = context.coverage ? coverageViews(index, context.coverage) : [];
  const accepted = cases.filter(view => view.acceptedFinding), others = cases.filter(view => !view.acceptedFinding);
  const open = projection.openIds.map(id => ({ id, record: index.byId.get(id) }));
  const status: Record<string, number> = {}; for (const task of tasks) status[task.status] = (status[task.status] ?? 0) + 1;
  const awaiting = tasks.filter(task => task.status === 'reported' || (task.status === 'blocked' && task.handoffId));
  const cells = plans.flatMap(plan => plan.cells.map(cell => ({ plan, cell })));
  const notClean = cells.filter(({ cell }) => cell.currentness !== 'retired' && (cell.execution !== 'tested' || ['unreviewed', 'open_gap', 'stale'].includes(cell.effectiveAssessment)));
  const out: string[] = [];
  out.push(`# p2o assessment report — run ${mdText(meta.runId, 80)}`, '',
    '> **Read this first.** This is a deterministic index of committed, attributed state at one sequence number. It is **not** a verification, not a penetration-test conclusion and not a statement that the target is safe. A list with no accepted case, or a coverage cell that is blocked or untested, says nothing about the absence of problems. Redaction is best effort; review before sharing.', '',
    '## Provenance', '',
    `- Run: ${mdText(meta.runId, 80)}${meta.historical ? ' (historical, read-only store)' : ' (active run)'}; as of committed sequence **${meta.asOfSequence}**; ${index.records.length} records; store schema ${meta.storeSchema}`,
    `- Target: ${mdText(meta.target, 400)}; retention ${mdText(meta.retention)}`,
    `- Runtime that wrote this run: p2o ${mdText(meta.runtime.version || 'unknown version', 40)} · closure digest ${mdText(meta.runtime.hash.slice(0, 12), 16)}`,
    `- Reconciliation: ${meta.complete && projection.complete ? 'complete bounded record scan' : '**INCOMPLETE** — no completeness claim'}${projection.diagnostics.length ? `; diagnostics: ${projection.diagnostics.slice(0, 10).map(item => mdText(item, 200)).join('; ')}` : ''}`,
    `- Views below are bounded (${ROWS} rows per list, ${CASE_ROWS} cases); omitted rows are counted and the complete data is in the portable bundle (\`/p2o export\`).`, '',
    '## Summary', '', '| Item | Count |', '|---|---|',
    `| Accepted current cases | ${accepted.length} |`, `| Cases pending, disputed, stale, withdrawn or duplicate | ${others.length} |`,
    `| Coverage cells (all plans) | ${cells.length} |`, `| Cells not tested or not confirmed (listed first below) | ${notClean.length} |`,
    `| Open gaps | ${open.length} |`, `| Worker claims | ${projection.counts.candidates} |`, `| Worker handoffs | ${projection.counts.reports} |`,
    `| Tasks awaiting owner review | ${awaiting.length} |`, `| Tasks by status | ${Object.entries(status).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${mdText(name, 24)} ${count}`).join(', ') || 'none'} |`, '');

  out.push('## Coverage and gaps — read before the findings', '');
  if (!plans.length) out.push('No coverage plan was recorded. Without a denominator nothing can be called covered.', '');
  for (const plan of plans) {
    out.push(`### Plan ${mdText(plan.title, 160)} — ${mdText(plan.id, 80)} r${plan.revision} (${mdText(plan.status)})`,
      `- Cells ${plan.cells.length}; execution ${Object.entries(plan.counts.execution).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${mdText(name, 24)} ${count}`).join(', ') || 'none'}; assessment ${Object.entries(plan.counts.assessment).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${mdText(name, 24)} ${count}`).join(', ') || 'none'}; stale ${plan.counts.stale}; reviewed ${plan.counts.reviewed}`,
      `- Exclusions: ${list(plan.exclusions.map(item => mdText(item, 200)))}; unknown scope: ${list(plan.unknownScope.map(item => mdText(item, 200)))}; assets discovered but not in this plan: ${plan.discoveredUnplannedAssets}`);
    const listed = rows(notClean.filter(item => item.plan.id === plan.id), ROWS);
    if (listed.shown.length) {
      out.push('', '| Cell | Asset | Question | Actor / method | Execution | Assessment | Currentness |', '|---|---|---|---|---|---|---|');
      for (const { cell } of listed.shown) out.push(`| ${mdText(cell.id, 80)} | ${mdText(cell.assetRef.id, 80)} | ${mdText(cell.questionKey, 120)} | ${mdText(`${cell.actorContext} / ${cell.methodFamily}`, 160)} | ${mdText(cell.execution, 24)} | ${mdText(cell.effectiveAssessment, 24)} | ${mdText(cell.currentness, 24)}${cell.staleReasons.length ? ` (${mdText(cell.staleReasons.slice(0, 3).join('; '), 160)})` : ''} |`);
      if (listed.omitted) out.push('', `… ${listed.omitted} more cells that are not tested or not confirmed; see coverage.csv.`);
    } else out.push('', 'Every cell in this plan is tested and has a non-open assessment. That is a statement about the recorded plan only.');
    out.push('');
  }
  const gaps = rows(open, ROWS);
  out.push('### Open gaps', '');
  if (!gaps.shown.length) out.push('No open gap is recorded. This does not mean none exists.', '');
  else { for (const { id, record } of gaps.shown) out.push(`- ${mdText(id, 80)}${record ? ` (${mdText(record.kind, 24)}, ${mdText(record.by, 40)}): ${mdText(record.text)}` : ''}`); if (gaps.omitted) out.push(`- … ${gaps.omitted} more open gaps`); out.push(''); }

  out.push('## Accepted current cases', '');
  if (!accepted.length) out.push(`No case was accepted and current at sequence ${meta.asOfSequence}. This does not mean the target is safe; see the coverage and gaps above.`, '');
  else { const listed = rows(accepted, CASE_ROWS); for (const view of listed.shown) out.push(caseSection(view), ''); if (listed.omitted) out.push(`… ${listed.omitted} more accepted cases; see cases.csv.`, ''); }

  out.push('## Other cases', '');
  if (!others.length) out.push('None.', '');
  else {
    const listed = rows(others, CASE_ROWS);
    out.push('| Case | Title | Verdict | Review | Currentness | Why it is not accepted-current |', '|---|---|---|---|---|---|');
    for (const view of listed.shown) out.push(`| ${mdText(view.id, 80)} r${view.revision} | ${mdText(view.title, 160)} | ${mdText(view.verdict, 24)} | ${mdText(view.reviewStatus, 24)} | ${mdText(view.currentness, 24)} | ${mdText(view.duplicateOf ? `duplicate of ${view.duplicateOf}` : view.staleReasons.length ? view.staleReasons.slice(0, 4).join('; ') : view.reviewStatus !== 'accepted' ? `review ${view.reviewStatus}` : `verdict ${view.verdict}`, 240)} |`);
    if (listed.omitted) out.push('', `… ${listed.omitted} more cases; see cases.csv.`);
    out.push('');
  }

  out.push('## Worker claims', '', 'Attributed submissions. A claim becomes a finding only through an accepted current case above.', '');
  const claims = rows(projection.candidates, ROWS);
  if (!claims.shown.length) out.push('No claim is recorded.', '');
  else {
    out.push('| Claim | Candidate | Surface / risk | Closure | Execution | Proof | Independent validation current |', '|---|---|---|---|---|---|---|');
    for (const claim of claims.shown) out.push(`| ${mdText(claim.id, 80)} | ${mdText(claim.candidate, 160)} | ${mdText(`${claim.surface ?? ''} / ${claim.risk ?? ''}`, 160)} | ${mdText(claim.closure, 24)} | ${mdText(claim.execution, 24)} | ${mdText(claim.proof, 40)} | ${claim.independentCurrent === undefined ? 'not claimed' : claim.independentCurrent ? 'yes' : 'no'} |`);
    out.push('');
  }
  out.push('## Tasks and handoffs', '', `- Awaiting owner review: ${awaiting.length ? ids(awaiting.map(task => task.id), 20) : 'none'}`);
  const handoffs = rows(projection.reports, ROWS);
  for (const report of handoffs.shown) out.push(`- Handoff ${mdText(report.id, 80)} from ${mdText(report.workerId ?? 'unknown', 80)}: outcome ${mdText(report.outcome ?? 'unknown', 40)}, confidence ${mdText(report.confidence ?? 'unknown', 24)}, ${report.findings} claimed finding(s), ${report.openItems} open item(s)${report.blocked ? `, blocked: ${mdText(report.blocked, 200)}` : ''}`);
  if (handoffs.omitted) out.push(`- … ${handoffs.omitted} more handoffs`);
  out.push('', '## Limits of this report', '',
    '- Reported is not reviewed; a closed task is not a verified finding; resources cleaned is not assessment complete.',
    '- Captured output may be truncated or lossy; hashes identify retained redacted bytes, not the original output.',
    '- Target-derived text was neutralized (links, images, HTML, formulas and control characters), not re-verified.',
    `- No execution authority, ticket, token, cookie or budget is part of, or restored by, this report. Format version ${REPORT_FORMAT_VERSION}.`, '');

  const caseCsv = [csvRow(['case_id', 'revision', 'title', 'verdict', 'review_status', 'currentness', 'accepted_current', 'duplicate_of', 'independent_current', 'policy_key', 'claims', 'independent_evidence', 'stale_reasons', 'limitations']),
    ...rows(cases, 5000).shown.map(view => csvRow([view.id, view.revision, view.title, view.verdict, view.reviewStatus, view.currentness, view.acceptedFinding, view.duplicateOf ?? '', view.independentCurrent, view.policyKey, view.claimRefs.join(' '), view.independentEvidenceRefs.join(' '), view.staleReasons.join('; '), view.limitations]))];
  const coverageCsv = [csvRow(['plan_id', 'plan_revision', 'cell_id', 'asset_id', 'question_key', 'policy_key', 'actor_context', 'tenant_context', 'method_family', 'execution', 'assessment', 'effective_assessment', 'currentness', 'stale_reasons', 'reason', 'limitations']),
    ...rows(cells, 20000).shown.map(({ plan, cell }) => csvRow([plan.id, plan.revision, cell.id, cell.assetRef.id, cell.questionKey, cell.policyKey ?? '', cell.actorContext, cell.tenantContext, cell.methodFamily, cell.execution, cell.assessment, cell.effectiveAssessment, cell.currentness, cell.staleReasons.join('; '), cell.reason, cell.limitations]))];
  const files: ReportFile[] = [{ name: 'REPORT.md', body: `${out.join('\n')}\n` }, { name: 'cases.csv', body: `${caseCsv.join('\n')}\n` }, { name: 'coverage.csv', body: `${coverageCsv.join('\n')}\n` }];
  const manifest = { format: 'p2o-report', version: REPORT_FORMAT_VERSION, runId: meta.runId, asOfSequence: meta.asOfSequence, records: index.records.length, historical: meta.historical, complete: meta.complete && projection.complete,
    runtime: meta.runtime, counts: { acceptedCurrent: accepted.length, cases: cases.length, coverageCells: cells.length, openGaps: open.length, claims: projection.counts.candidates },
    files: files.map(file => ({ name: file.name, bytes: Buffer.byteLength(file.body), sha256: sha256Hex(file.body) })), authorityRestored: false,
    warning: 'Deterministic index of attributed committed state; not a verification or a safety statement. Redaction is best effort.' };
  files.push({ name: 'report-manifest.json', body: `${JSON.stringify(manifest, null, 2)}\n` });
  return { files, counts: manifest.counts };
}
