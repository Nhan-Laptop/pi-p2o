import { describeCapability } from './capabilities.js';
import { caseViews, needsCaseReview, type CaseView } from './cases.js';
import { cvssScore } from './cvss.js';
import { FINDING_SEVERITIES } from './case-types.js';
import { completionLine, deriveCompletion } from './completion.js';
import { claimHeadClaims } from './chain-view.js';
import { planFrontier } from './planning.js';
import { coverageViews, type CoverageCellView, type CoverageContext, type CoveragePlanView } from './coverage.js';
import { safeText } from './evidence.js';
import type { LedgerIndex } from './records.js';
import type { FinishPreflight } from './finish-preflight.js';
import { reportProjection, type ReportProjectionContext } from './report.js';
import { awaitingReview, taskFrontier, taskRevisionAt } from './tasks.js';
import { sha256Hex } from './validate.js';
import { WSTG_BY_KEY, WSTG_COMMIT, WSTG_MAP, isWstgKey, wstgEvidence, wstgKey, wstgPageUrl, type WstgEvidence } from './wstg-map.js';

/**
 * Deterministic human report rendered from committed state. No model, no clock, no random values: the same state at the same
 * sequence yields the same bytes. Every target- or model-derived string passes through `mdText`/`csvCell`, so a hostile value cannot
 * become a link, image, HTML, fence, table break, spreadsheet formula or terminal escape. The report is an attributed index, never a verdict.
 */
export const REPORT_FORMAT_VERSION = 2;
const ROWS = 200, CASE_ROWS = 500, TEXT = 300, CSV_TEXT = 500;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export interface ReportMeta {
  runId: string; target: string; retention: string; historical: boolean; asOfSequence: number; storeSchema: number;
  runtime: { hash: string; version?: string }; complete: boolean;
  /** 1 renders the original file set, 2 adds the OWASP-shaped sections and findings files. Default 2. */
  format?: 1 | 2;
  /** Why this report was written: finished, stopped, shutdown, session-change, storage-failed, failed, or manual (a human export). */
  endReason?: string;
  /** Preflight at finish: items still unresolved when the lead finished. Printed as a section, never counted as findings. */
  unresolved?: FinishPreflight;
  /** Lead-written executive text (p2o_finish narrative). Printed under an "unverified" label. */
  narrative?: string;
  /** Operator-supplied labels from settings p2o.report; printed as given after neutralization. */
  operator?: Partial<Record<OperatorField, string>>;
  /** Package-relative paths of the catalog's wstg-source pages, used only to print the pinned upstream address of a test. */
  wstgPages?: readonly string[];
}
export const OPERATOR_FIELDS = ['author', 'organization', 'team', 'classification', 'disclaimer'] as const;
export type OperatorField = typeof OPERATOR_FIELDS[number];
export interface ReportFile { name: string; body: string }
export interface RenderedReport { files: ReportFile[]; counts: { acceptedCurrent: number; cases: number; coverageCells: number; openGaps: number; claims: number; unrated?: number } }

/** Inline Markdown-safe text: one line, bounded, HTML and Markdown syntax neutralized, autolinks broken. */
export function mdText(value: unknown, limit = TEXT): string {
  let text = safeText(String(value ?? '')).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const cut = text.length > limit; if (cut) text = text.slice(0, limit);
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]()!|~#@]/g, match => `\\${match}`)
    .replace(/:\/\//g, '\\://').replace(/\bwww\./gi, match => `${match.slice(0, 3)}\\.`);
  return cut ? `${text}…` : text;
}
/** One quoted CSV field; a leading formula character is defused and line breaks cannot add rows. */
export function csvCell(value: unknown, limit = CSV_TEXT): string {
  let text = safeText(String(value ?? '')).replace(INVISIBLE, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
const csvRow = (cells: unknown[]) => cells.map(cell => csvCell(cell)).join(',');
const ids = (values: readonly string[] | undefined, limit = 6) => !values?.length ? 'none' : `${values.slice(0, limit).map(id => mdText(id, 80)).join(', ')}${values.length > limit ? `, … +${values.length - limit}` : ''}`;
const list = (values: readonly string[] | undefined, limit = 6) => !values?.length ? 'none' : `${values.slice(0, limit).join('; ')}${values.length > limit ? `; … +${values.length - limit}` : ''}`;
const rows = <T>(items: T[], limit: number) => ({ shown: items.slice(0, limit), omitted: Math.max(0, items.length - limit) });


/** Plain bounded text for JSON/CSV/fenced blocks: redacted, control and invisible characters removed, line breaks kept. Not Markdown-safe on its own. */
const plainText = (value: unknown, limit = 2000) => { const text = safeText(String(value ?? '')).replace(INVISIBLE, '').trim(); return text.length > limit ? `${text.slice(0, limit)}…` : text; };
/** Fenced block that its own content cannot close: the fence is longer than any backtick run inside. */
export function safeFence(value: unknown, limit = 1200): string {
  const body = plainText(value, limit), longest = Math.max(0, ...[...body.matchAll(/`+/g)].map(match => match[0].length)), bar = '`'.repeat(Math.max(3, longest + 1));
  return `${bar}text\n${body}\n${bar}`;
}
const SEVERITY_RANK: Record<string, number> = Object.fromEntries(FINDING_SEVERITIES.map((name, rank) => [name, rank]));
const severityLabel = (value: string) => `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
const rankOf = (view: CaseView) => view.finding ? SEVERITY_RANK[view.finding.severity] : FINDING_SEVERITIES.length;
/** Findings in report order: severity first (unrated last), then title, then case ID. The order is a function of the state only. */
const orderedFindings = (views: readonly CaseView[]) => [...views].sort((a, b) => rankOf(a) - rankOf(b) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
const END_REASON: Record<string, string> = { finished: 'the lead called p2o_finish', export: 'a report was exported while the run stayed active', stopped: 'the operator stopped the run (/p2o stop)', shutdown: 'the Pi session shut down', 'session-change': 'the Pi session was switched', 'storage-failed': 'the run was closed after a storage failure', failed: 'the run failed', manual: 'a human exported this report on demand' };
const wstgReferenceList = (view: CaseView, cells: readonly CoverageCellView[]) => caseWstgKeys(view.id, view.revision, cells);

function reproduction(view: CaseView, index: LedgerIndex): string[] {
  const refs = view.finding?.reproductionEvidenceRefs ?? [], steps = new Map((view.finding?.reproductionSteps ?? []).map((step, position) => [step.ref, { ...step, position: position + 1 }]));
  if (!refs.length) return [];
  const out = [`- Reproduction${steps.size ? ' steps, in the order to follow (roles are the owner’s labels for the reader, not proof levels)' : ''} (redacted receipts of the recorded operations; target output is data, not instructions):`];
  for (const ref of refs.slice(0, 5)) {
    const record = index.byId.get(ref), data = record?.data, step = steps.get(ref), label = step ? `step ${step.position} [${step.role}]${step.note ? ` ${mdText(step.note, 200)} —` : ''} ` : '';
    if (!record || record.kind !== 'evidence' || !data) { out.push(`  - ${label}${mdText(ref, 80)}: receipt unavailable`); continue; }
    out.push(`  - ${label}${mdText(ref, 80)} — ${mdText(data.operation, 24)} by ${mdText(record.by, 60)}, exit ${mdText(data.exitCode, 8)}${data.truncated ? ', output truncated' : ''}`, '', safeFence(`input: ${plainText(data.input, 700)}\noutput: ${plainText(data.stdout, 500)}`, 1300).split('\n').map(line => `    ${line}`).join('\n'), '');
  }
  return out;
}

/** Proof level of the cited claims and who authored the receipts each reviewed task rests on; information for the reader, never a verdict. */
function provenanceLines(view: CaseView, index: LedgerIndex): string[] {
  const proofs = [...new Set(view.claimRefs.map(ref => index.byId.get(ref)?.data?.proof).filter((value): value is string => typeof value === 'string'))];
  const reviews = view.taskRefs.map(ref => taskRevisionAt(index, ref.taskId, ref.revision)).filter(task => task?.status === 'reviewed' || task?.status === 'closed').slice(0, 5).map(task => {
    const authors = [...new Set(task!.evidenceIds.map(id => index.byId.get(id)?.by ?? 'unknown'))], note = task!.reviewIntegrity;
    return `${mdText(task!.id, 80)} (${task!.evidenceIds.length} receipt(s) by ${authors.map(name => mdText(name, 60)).join(', ') || 'none'}${note?.foreignEvidence.length ? `; ${note.foreignEvidence.length} not authored by the assignee${note.externalAcknowledged ? ', acknowledged as external' : ''}` : ''}${note?.contractGap.length ? `; output fields with no record: ${note.contractGap.join(', ')}` : ''})`;
  });
  return [`- Proof level of the cited claims: ${proofs.length ? proofs.map(item => mdText(item, 40)).join(', ') : 'not recorded'}${proofs.every(item => item === 'static_trace') && proofs.length ? ' (static trace only; no runtime reproduction)' : ''}`,
    ...(reviews.length ? [`- Review receipts: ${reviews.join('; ')}`] : [])];
}

function findingLines(view: CaseView, cells: readonly CoverageCellView[], index: LedgerIndex, pages: readonly string[]): string[] {
  const finding = view.finding;
  if (!finding) return ['- Severity: **not rated** — the owner has not recorded a rating for this case, so it cannot be ranked.'];
  const score = cvssScore(finding.cvssVector), keys = wstgReferenceList(view, cells);
  return [`- Severity **${severityLabel(finding.severity)}** (owner-attributed, p2o scale) — basis: ${mdText(finding.basis, 1000)}${view.ratingCurrent === false ? ` (rating recorded against r${view.ratedRevision}; the case is now r${view.revision}, so check that it still applies)` : ''}`,
    ...(finding.likelihood ? [`- Likelihood: ${mdText(finding.likelihood, 800)}`] : []), ...(finding.impact ? [`- Impact: ${mdText(finding.impact, 800)}`] : []),
    ...(finding.chain ? [`- Chain — ${mdText(finding.chain.objective, 600)}: ${finding.chain.demonstratedThrough ? `executed through step ${finding.chain.demonstratedThrough}` : 'no step executed — reasoned only'} of ${finding.chain.steps.length} (ordered; each step cites the claim that ran it).`,
      ...finding.chain.steps.map(step => `  ${step.order}. ${mdText(step.step, 400)}${step.claimRef ? ` — claim \`${mdText(step.claimRef, 80)}\`` : ''}${step.needs.length ? `; needs: ${step.needs.map(item => mdText(describeCapability(item), 300)).join(', ')}` : ''}${step.gained.length ? `; gained: ${step.gained.map(item => mdText(describeCapability(item), 300)).join(', ')}` : ''}${step.effect ? `; effect: ${step.effect}` : ''}`),
      ...(finding.chain.impact ? [`  - Demonstrated impact \`${finding.chain.impact.vector}\` = **${finding.chain.impact.score.toFixed(1)}** (${finding.chain.impact.severity}) from the ${finding.chain.impact.effect} the executed chain showed. Computed by the host, not chosen; the p2o severity above cannot exceed it.`] : [])] : []),
    ...(score ? [`- CVSS 3.1 base \`${score.vector}\` = **${score.score.toFixed(1)}** (${score.severity}); vector recorded by the owner, score computed by the host. It may differ from the p2o rating.`] : []),
    ...(finding.cwe.length ? [`- Weakness classes recorded by the owner (not checked against MITRE): ${finding.cwe.map(item => `\`${item}\``).join(', ')}`] : []),
    ...(finding.remediationSteps ? [`- Recommended remediation: ${mdText(finding.remediationSteps, 2000)}`] : []),
    ...(finding.references.length || keys.length ? [`- References: ${[...new Set([...finding.references, ...keys])].slice(0, 8).map(ref => {
      const url = isWstgKey(ref) ? wstgPageUrl(ref, pages) : undefined; return url ? `\`${ref}\` (pinned page: \`${url}\`)` : `\`${mdText(ref, 120)}\``; }).join('; ')}`] : []),
    ...(finding.independenceWaiver ? [`- Independence waiver: ${mdText(finding.independenceWaiver, 300)}`] : []),
    ...reproduction(view, index)];
}

function caseSection(view: CaseView, cells: readonly CoverageCellView[], index?: LedgerIndex, pages: readonly string[] = [], ordinal?: number): string {
  const wstg = caseWstgKeys(view.id, view.revision, cells);
  const v2 = ordinal !== undefined;
  return [`### ${v2 ? `F-${ordinal} ` : ''}${mdText(view.title, 160)} — case ${mdText(view.id, 80)} r${view.revision}`,
    `- Verdict **${mdText(view.verdict)}**; review **${mdText(view.reviewStatus)}**; currentness **${mdText(view.currentness)}**; independent validation current: ${view.independentCurrent ? 'yes' : 'no'}`,
    `- Policy: ${mdText(view.policyKey, 160)}${view.rootCauseKey ? `; root cause: ${mdText(view.rootCauseKey, 160)}` : ''}`,
    `- Assets: ${ids(view.assetRefs.map(ref => ref.id))}; claims: ${ids(view.claimRefs)}; independent evidence: ${ids(view.independentEvidenceRefs)}; tasks: ${ids(view.taskRefs.map(ref => `${ref.taskId}@r${ref.revision ?? '?'}`))}`,
    `- Contradictions: ${view.contradictions.length ? view.contradictions.slice(0, 6).map(item => `${mdText(item.evidenceRef, 80)} (${mdText(item.status)})`).join(', ') : 'none recorded'}; affected variants: ${list(view.affectedVariants.map(item => mdText(item, 120)))}`,
    ...(wstg.length ? [`- WSTG tests this case addresses (see the WSTG checklist for level): ${wstg.map(key => mdText(key, 40)).join(', ')}`] : []),
    ...(v2 && index ? [...provenanceLines(view, index), ...findingLines(view, cells, index, pages)] : []),
    `- Remediation: ${mdText(view.remediation.status)} — ${mdText(view.remediation.reason, 200)}`,
    `- Reviewer reasoning: ${mdText(view.reviewReason)}`, `- Limitations: ${mdText(view.limitations)}`].join('\n');
}

const EVIDENCE_LABEL: Record<WstgEvidence, string> = { L3: 'proven', L2: 'checked', L1: 'attempted, blocked or stale', L0: 'not checked', 'n/a': 'not applicable' };

/**
 * Fixed, documented scale (skills/remediation/references/risk-rating-criteria.md); never computed from a field the host validates and
 * never a substitute for a case's own verdict or review status. Printed once per report when at least one accepted case exists.
 */
const RISK_LEVELS: ReadonlyArray<readonly [name: string, criteria: string]> = [
  ['Critical', 'exploitable with no prior access and no operator-supplied identity, reaching data or control beyond the tested object’s own owner'],
  ['High', 'exploitable with no prior access reaching only the tested object’s own owner, or exploitable only with an identity but reaching beyond it'],
  ['Medium', 'exploitable only with an operator-supplied identity and confined to that identity’s own data, or a confirmed structural weakness whose further reach is an open proof gap'],
  ['Low', 'a confirmed policy deviation with no demonstrated protected effect beyond the deviation itself'],
  ['Informational', 'a bounded ruled-out result, a gap whose cause is known, or an observation with no policy to measure it against yet'],
];

/** Lower-case WSTG keys of non-retired cells that cite this exact case revision, for a one-line cross-reference in a case section. */
function caseWstgKeys(caseId: string, revision: number, cells: readonly CoverageCellView[]): string[] {
  const keys = new Set<string>();
  for (const cell of cells) if (cell.currentness !== 'retired' && isWstgKey(cell.questionKey) && cell.caseRefs.some(ref => ref.caseId === caseId && ref.revision === revision)) keys.add(cell.questionKey);
  return [...keys].sort();
}

/**
 * Checklist for runs that address OWASP WSTG tests: one level per test over the recorded cells, and every test with no cell listed as the denominator.
 * Returns nothing (the report is unchanged) unless a coverage cell uses a wstg- question key. The text names no tool and quotes no target data.
 */
export function wstgAppendix(cells: readonly CoverageCellView[], cases: readonly CaseView[]): string[] {
  const used = cells.filter(cell => cell.currentness !== 'retired' && isWstgKey(cell.questionKey));
  if (!used.length) return [];
  const byKey = new Map<string, CoverageCellView[]>();
  for (const cell of used) byKey.set(cell.questionKey, [...(byKey.get(cell.questionKey) ?? []), cell]);
  const tests = WSTG_MAP.map(test => { const own = [...(byKey.get(wstgKey(test.id)) ?? [])].sort((a, b) => a.id.localeCompare(b.id)); return { test, own, level: wstgEvidence(own, cases) }; });
  const tally = new Map<WstgEvidence, number>(); for (const item of tests) tally.set(item.level, (tally.get(item.level) ?? 0) + 1);
  const out = ['## WSTG checklist', '',
    `Tests are the OWASP WSTG tests pinned at commit ${WSTG_COMMIT.slice(0, 12)} (${WSTG_MAP.length} tests). A coverage cell addresses one test by using its lower-case ID as its question key. Level summarizes only the cells recorded in this run: L0 not checked, L1 attempted, blocked or stale, L2 checked (a current tested cell), L3 proven (that cell cites an accepted, current, confirmed case). A level is not a statement about the target, and L2 does not mean the target is protected. Support describes the shipped skill library, never the target: D a skill names the test, T only general techniques apply, N no skill, O outside the scope of this tool. Flag B marks a test whose effect needs a browser (proof stops at offline reproduction); flag I marks a test that needs operator-supplied identities.`, '',
    '| Level | Tests |', '|---|---|', ...(['L3', 'L2', 'L1', 'L0', 'n/a'] as const).map(level => `| ${level} ${EVIDENCE_LABEL[level]} | ${tally.get(level) ?? 0} |`), ''];
  const touched = rows(tests.filter(item => item.own.length), ROWS);
  out.push('### Tests with a recorded cell', '');
  if (!touched.shown.length) out.push('No recorded cell matches a test of the pinned map.', '');
  else {
    out.push('| Test | Support | Flags | Level | Cells |', '|---|---|---|---|---|');
    for (const { test, own, level } of touched.shown) out.push(`| ${mdText(wstgKey(test.id), 40)} ${mdText(test.title, 100)} | ${test.support} | ${`${test.browser ? 'B' : ''}${test.identity ? 'I' : ''}` || '-'} | ${level} | ${ids(own.map(cell => cell.id))} |`);
    if (touched.omitted) out.push('', `… ${touched.omitted} more tests with a recorded cell; see coverage.csv.`);
    out.push('');
  }
  out.push('### Tests without a recorded cell (L0)', '', 'These were not checked in this run. Support N and O mean the shipped library has no skill for the test or the test is outside the scope of this tool, so an empty row can be a limit of the tool and not a result.', '');
  const groups = new Map<string, string[]>();
  for (const { test, own } of tests) if (!own.length) groups.set(test.id.split('-')[1], [...(groups.get(test.id.split('-')[1]) ?? []), `${wstgKey(test.id)} (${test.support})`]);
  for (const [group, names] of groups) out.push(`- ${group}: ${names.join(', ')}`);
  const unknown = [...byKey.keys()].filter(key => !WSTG_BY_KEY.has(key)).sort();
  if (unknown.length) out.push('', '### Cells with a wstg- key that is not in the pinned map', '', ...unknown.slice(0, 20).map(key => `- ${mdText(key, 80)}: ${byKey.get(key)!.length} cell(s)`), ...(unknown.length > 20 ? [`- … ${unknown.length - 20} more keys`] : []));
  out.push('');
  return out;
}


/** Scope, limitations and executive summary (OWASP WSTG reporting: scope, limitations, executive summary). Counts only; it adds no judgement of its own. */
function scopeAndSummary(meta: ReportMeta, index: LedgerIndex, plans: readonly CoveragePlanView[], cells: ReadonlyArray<{ plan: CoveragePlanView; cell: CoverageCellView }>, notClean: ReadonlyArray<{ cell: CoverageCellView }>,
  accepted: readonly CaseView[], rated: readonly CaseView[], unrated: readonly CaseView[], others: readonly CaseView[], openGaps: number, awaiting: number, cases: readonly CaseView[]): string[] {
  const live = cells.filter(({ cell }) => cell.currentness !== 'retired'), notTested = live.filter(({ cell }) => cell.execution !== 'tested').length, stale = live.filter(({ cell }) => cell.currentness === 'stale').length;
  const exclusions = [...new Set(plans.flatMap(plan => plan.exclusions))], unknown = [...new Set(plans.flatMap(plan => plan.unknownScope))], unplanned = Math.max(0, ...plans.map(plan => plan.discoveredUnplannedAssets));
  const pending = cases.filter(needsCaseReview).length;
  const bySeverity = FINDING_SEVERITIES.map(name => `${severityLabel(name)} ${rated.filter(view => view.finding!.severity === name).length}`).join(', ');
  const usesWstg = live.some(({ cell }) => isWstgKey(cell.questionKey)), untouched = usesWstg ? WSTG_MAP.filter(test => !live.some(({ cell }) => cell.questionKey === wstgKey(test.id))).length : 0;
  const paragraphs = (meta.narrative ?? '').split(/\n{2,}/).map(part => part.trim()).filter(Boolean).slice(0, 6);
  return ['## Scope and limitations', '',
    `- Assessed target: ${mdText(meta.target, 400)}, as authorized by the operator when the run started. The tool never widened this scope.`,
    `- Coverage denominator: ${plans.length ? `${plans.length} plan(s), ${live.length} live cell(s)` : 'none recorded, so nothing can be called covered'}. Exclusions recorded: ${list(exclusions.map(item => mdText(item, 200)))}. Unknown scope: ${list(unknown.map(item => mdText(item, 200)))}.`,
    `- Not examined or not confirmed: ${notClean.length} cell(s) (${notTested} not tested, ${stale} stale), ${unplanned} discovered asset(s) outside every plan, ${openGaps} open gap(s)${usesWstg ? `, ${untouched} WSTG test(s) with no cell` : ''}. Each is listed in the coverage section below; none of them is a result.`,
    '- Tool limits: commands and HTTP requests run from an isolated sandbox against the authorized target only. There is no browser, so an effect that happens only in a browser stops at offline reproduction; a check that needs a credential ran only if the operator supplied that identity; third-party origins and DNS are outside the tool’s scope.',
    '- The severity of a finding is an attributed rating recorded by the lead, with its stated basis. It is not computed from exploit evidence and it never changes a case’s verdict or review status.', '',
    '## Executive summary', '',
    `- Accepted, current findings: **${accepted.length}** (${bySeverity}${unrated.length ? `, not rated ${unrated.length}` : ''}).`,
    `- Cases not accepted-current: ${others.length} (${pending} awaiting a review decision). Tasks awaiting owner review: ${awaiting}.`,
    `- Coverage: ${live.length} live cell(s) of which ${live.length - notTested} tested; ${notTested} not tested; ${stale} stale. Open gaps: ${openGaps}.`,
    `- Records examined: ${index.records.length}${index.complete ? '' : ' (INCOMPLETE scan, no completeness claim)'}.`,
    ...(paragraphs.length ? ['', '> **Lead narrative — written by the lead agent, not verified by the host:**', '>', ...paragraphs.flatMap(part => [`> ${mdText(part, 1500)}`, '>']).slice(0, -1)] : ['', 'No lead narrative was supplied.']),
    '', 'These counts describe attributed state at one sequence number. They are not a business-impact rating and not a statement that the target is safe.', ''];
}


/** Machine-readable findings: every typed field of every accepted-current case, strings redacted and bounded but NOT Markdown-escaped (escape on display). */
function findingFiles(meta: ReportMeta, index: LedgerIndex, ordered: readonly CaseView[], cells: readonly CoverageCellView[], pages: readonly string[]): ReportFile[] {
  const reproduce = (view: CaseView) => (view.finding?.reproductionEvidenceRefs ?? []).map(ref => { const record = index.byId.get(ref), data = record?.kind === 'evidence' ? record.data : undefined, step = view.finding?.reproductionSteps?.find(item => item.ref === ref);
    return { evidenceId: ref, ...(step ? { role: step.role, ...(step.note ? { note: plainText(step.note, 200) } : {}) } : {}), available: Boolean(data), operation: data ? plainText(data.operation, 24) : null, by: record ? plainText(record.by, 60) : null, exitCode: data?.exitCode ?? null, input: data ? plainText(data.input, 700) : null, output: data ? plainText(data.stdout, 500) : null, truncated: Boolean(data?.truncated) }; });
  const items = ordered.slice(0, CASE_ROWS).map((view, position) => {
    const score = cvssScore(view.finding?.cvssVector), wstg = caseWstgKeys(view.id, view.revision, cells);
    return { ref: `F-${position + 1}`, caseId: view.id, revision: view.revision, title: plainText(view.title, 500), verdict: view.verdict, reviewStatus: view.reviewStatus, currentness: view.currentness, independentValidationCurrent: view.independentCurrent,
      severity: view.finding?.severity ?? null, severityBasis: view.finding ? plainText(view.finding.basis, 1000) : null, likelihood: view.finding?.likelihood ? plainText(view.finding.likelihood, 800) : null, impact: view.finding?.impact ? plainText(view.finding.impact, 800) : null,
      cvss: score ? { vector: score.vector, baseScore: score.score, severity: score.severity } : null, cwe: view.finding?.cwe ?? [], wstg: wstg.map(key => ({ key, page: isWstgKey(key) ? wstgPageUrl(key, pages) ?? null : null })),
      policyKey: plainText(view.policyKey, 160), rootCauseKey: view.rootCauseKey ? plainText(view.rootCauseKey, 160) : null, assets: view.assetRefs.map(ref => ref.id), claims: view.claimRefs, independentEvidence: view.independentEvidenceRefs,
      remediation: { status: view.remediation.status, reason: plainText(view.remediation.reason, 1000), steps: view.finding?.remediationSteps ? plainText(view.finding.remediationSteps, 2000) : null },
      references: view.finding?.references ?? [], reproduction: reproduce(view), contradictions: view.contradictions.map(item => ({ evidenceRef: item.evidenceRef, status: item.status })), limitations: plainText(view.limitations, 2000), independenceWaiver: view.finding?.independenceWaiver ? plainText(view.finding.independenceWaiver, 300) : null,
      chain: view.finding?.chain ? { objective: plainText(view.finding.chain.objective, 600), demonstratedThrough: view.finding.chain.demonstratedThrough ?? null,
        impact: view.finding.chain.impact ? { vector: view.finding.chain.impact.vector, score: view.finding.chain.impact.score, severity: view.finding.chain.impact.severity, effect: view.finding.chain.impact.effect } : null,
        steps: view.finding.chain.steps.map(step => ({ order: step.order, step: plainText(step.step, 400), claimRef: step.claimRef ?? null, gained: step.gained.map(item => describeCapability(item)), needs: step.needs.map(item => describeCapability(item)), effect: step.effect ?? null, reach: step.reach ? { ...step.reach } : null })) } : null };
  });
  const body = { format: 'p2o-findings', version: 1, runId: meta.runId, asOfSequence: meta.asOfSequence, complete: meta.complete, endReason: meta.endReason ?? null,
    note: 'Accepted, current cases only. Severity is an attributed owner rating; CVSS scores are computed by the host from the owner-recorded vector. Strings are redacted and bounded but not Markdown-escaped; escape them before display.', findings: items };
  const csv = [csvRow(['ref', 'case_id', 'revision', 'title', 'severity', 'cvss_vector', 'cvss_score', 'cwe', 'wstg', 'verdict', 'review_status', 'currentness', 'independent_validation_current', 'policy_key', 'root_cause_key', 'remediation_status', 'remediation_steps', 'references', 'reproduction_evidence']),
    ...items.map(item => csvRow([item.ref, item.caseId, item.revision, item.title, item.severity ?? 'not rated', item.cvss?.vector ?? '', item.cvss?.baseScore ?? '', item.cwe.join(' '), item.wstg.map(entry => entry.key).join(' '), item.verdict, item.reviewStatus, item.currentness, item.independentValidationCurrent, item.policyKey, item.rootCauseKey ?? '', item.remediation.status, item.remediation.steps ?? '', item.references.join(' '), item.reproduction.map(entry => entry.evidenceId).join(' ')]))];
  return [{ name: 'findings.json', body: `${JSON.stringify(body, null, 2)}\n` }, { name: 'findings.csv', body: `${csv.join('\n')}\n` }];
}
/** One row per WSTG test with its level, only for runs that address WSTG tests (same condition as the Markdown checklist). */
function wstgChecklistFile(cells: readonly CoverageCellView[], cases: readonly CaseView[], pages: readonly string[]): ReportFile[] {
  const used = cells.filter(cell => cell.currentness !== 'retired' && isWstgKey(cell.questionKey));
  if (!used.length) return [];
  const byKey = new Map<string, CoverageCellView[]>(); for (const cell of used) byKey.set(cell.questionKey, [...(byKey.get(cell.questionKey) ?? []), cell]);
  const lines = [csvRow(['test_id', 'key', 'title', 'group', 'support', 'browser', 'identity', 'level', 'cells', 'pinned_page']),
    ...WSTG_MAP.map(test => { const own = [...(byKey.get(wstgKey(test.id)) ?? [])].sort((a, b) => a.id.localeCompare(b.id)); return csvRow([test.id, wstgKey(test.id), test.title, test.id.split('-')[1], test.support, test.browser, test.identity, wstgEvidence(own, cases), own.map(cell => cell.id).join(' '), wstgPageUrl(test.id, pages) ?? '']); })];
  return [{ name: 'wstg-checklist.csv', body: `${lines.join('\n')}\n` }];
}

/** Operator words recorded at run start (U1). Quoted as unverified operator text; empty, so the report is unchanged, when no flag was given. */
function operatorBrief(index: LedgerIndex): string[] {
  const recorded = index.records.find(record => record.kind === 'lifecycle' && record.by === 'owner' && typeof record.data?.operator === 'object' && record.data.operator !== null)?.data?.operator as { objective?: unknown; avoid?: unknown } | undefined;
  if (!recorded) return [];
  const avoid = Array.isArray(recorded.avoid) ? recorded.avoid.filter((line): line is string => typeof line === 'string').slice(0, 5) : [];
  return [
    ...(typeof recorded.objective === 'string' ? [`- Stated objective (operator-supplied, unverified, does not change scope): ${mdText(recorded.objective, 600)}`] : []),
    ...avoid.map(line => `- Operator constraint (guidance given to workers, not enforcement): ${mdText(line, 300)}`),
  ];
}

export function renderReport(index: LedgerIndex, context: ReportProjectionContext & { coverage?: CoverageContext }, meta: ReportMeta): RenderedReport {
  const projection = reportProjection(index, context), tasks = taskFrontier(index);
  // M3: completion is derived here, from the same ledger the rest of the report is rendered from, so the report cannot claim a
  // state the situation line or the finish result would contradict.
  const completion = deriveCompletion({ plans: planFrontier(index), claims: claimHeadClaims(index), tasks });
  const cases = caseViews(index, context.cases ?? {}), plans: CoveragePlanView[] = context.coverage ? coverageViews(index, context.coverage) : [];
  const accepted = cases.filter(view => view.acceptedFinding), others = cases.filter(view => !view.acceptedFinding);
  const open = projection.openIds.map(id => ({ id, record: index.byId.get(id) }));
  const status: Record<string, number> = {}; for (const task of tasks) status[task.status] = (status[task.status] ?? 0) + 1;
  const awaiting = tasks.filter(awaitingReview);
  const cells = plans.flatMap(plan => plan.cells.map(cell => ({ plan, cell })));
  const notClean = cells.filter(({ cell }) => cell.currentness !== 'retired' && (cell.execution !== 'tested' || ['unreviewed', 'open_gap', 'stale'].includes(cell.effectiveAssessment)));
  const version = meta.format ?? REPORT_FORMAT_VERSION, v2 = version === 2, pages = meta.wstgPages ?? [], everyCell = cells.map(item => item.cell);
  const rated = accepted.filter(view => view.finding), unrated = accepted.filter(view => !view.finding);
  const out: string[] = [];
  out.push(`# p2o assessment report — run ${mdText(meta.runId, 80)}`, '',
    '> **Read this first.** This is a deterministic index of committed, attributed state at one sequence number. It is **not** a verification, not a penetration-test conclusion and not a statement that the target is safe. A list with no accepted case, or a coverage cell that is blocked or untested, says nothing about the absence of problems. Redaction is best effort; review before sharing.', '',
    ...(v2 && meta.endReason ? [['finished', 'manual', 'export'].includes(meta.endReason) ? `> **Run end:** ${(END_REASON[meta.endReason] ?? mdText(meta.endReason, 120))}.` : `> **INTERRUPTED RUN — ${(END_REASON[meta.endReason] ?? mdText(meta.endReason, 120))}.** The lead did not finish normally, so review, coverage and the final narrative may be incomplete. Everything below is what was committed before the end.`, ''] : []),
    '## Provenance', '',
    `- Run: ${mdText(meta.runId, 80)}${meta.historical ? ' (historical, read-only store)' : ' (active run)'}; as of committed sequence **${meta.asOfSequence}**; ${index.records.length} records; store schema ${meta.storeSchema}`,
    `- Target: ${mdText(meta.target, 400)}; retention ${mdText(meta.retention)}`,
    ...operatorBrief(index),
    `- Runtime that wrote this run: p2o ${mdText(meta.runtime.version || 'unknown version', 40)} · closure digest ${mdText(meta.runtime.hash.slice(0, 12), 16)}`,
    `- Reconciliation: ${meta.complete && projection.complete ? 'complete bounded record scan' : '**INCOMPLETE** — no completeness claim'}${projection.diagnostics.length ? `; diagnostics: ${projection.diagnostics.slice(0, 10).map(item => mdText(item, 200)).join('; ')}` : ''}`,
    `- Views below are bounded (${ROWS} rows per list, ${CASE_ROWS} cases); omitted rows are counted and the complete data is in the portable bundle (\`/p2o export\`).`,
    ...(v2 ? [`- Records: first at ${mdText(index.records[0]?.at ?? 'n/a', 40)}, last at ${mdText(index.records.at(-1)?.at ?? 'n/a', 40)} (timestamps as stored; this report reads no clock)`,
      ...(meta.operator ? (['author', 'organization', 'team', 'classification'] as const).filter(name => meta.operator![name]).map(name => `- ${severityLabel(name)} (operator-supplied, unverified): ${mdText(meta.operator![name], 200)}`) : [])] : []), '',
    ...(v2 ? scopeAndSummary(meta, index, plans, cells, notClean, accepted, rated, unrated, others, open.length, awaiting.length, cases) : []),
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

  out.push(...wstgAppendix(cells.map(item => item.cell), cases));

  if (accepted.length) out.push('## Risk rating criteria', '', 'A fixed, documented scale, named here for the cases below. It is attributed, not computed from any field the host validates, and it never changes a case’s own verdict or review status.', '',
    '| Level | Criteria |', '|---|---|', ...RISK_LEVELS.map(([name, criteria]) => `| ${name} | ${criteria} |`), '');

  const shownAccepted = v2 ? orderedFindings(accepted) : accepted;
  if (v2 && accepted.length) {
    const withWstg = shownAccepted.some(view => caseWstgKeys(view.id, view.revision, everyCell).length);
    out.push('## Findings summary', '', 'Accepted, current cases only, ordered by the owner-attributed severity (unrated last). One row per case; the details follow in the next section.', '',
      `| # | Case | Title | Severity | CVSS 3.1 | CWE |${withWstg ? ' WSTG |' : ''} Independent validation |`, `|---|---|---|---|---|---|${withWstg ? '---|' : ''}---|`);
    for (const [position, view] of rows(shownAccepted, CASE_ROWS).shown.entries()) {
      const score = cvssScore(view.finding?.cvssVector), keys = caseWstgKeys(view.id, view.revision, everyCell);
      out.push(`| F-${position + 1} | ${mdText(view.id, 80)} r${view.revision} | ${mdText(view.title, 160)} | ${view.finding ? severityLabel(view.finding.severity) : 'not rated'} | ${score ? score.score.toFixed(1) : '-'} | ${view.finding?.cwe.length ? view.finding.cwe.join(', ') : '-'} |${withWstg ? ` ${keys.length ? keys.map(key => mdText(key, 40)).join(', ') : '-'} |` : ''} ${view.independentCurrent ? 'current' : 'none'} |`);
    }
    out.push('');
  }
  out.push('## Accepted current cases', '');
  if (!accepted.length) out.push(`No case was accepted and current at sequence ${meta.asOfSequence}. This does not mean the target is safe; see the coverage and gaps above.`, '');
  else { const listed = rows(shownAccepted, CASE_ROWS); for (const [position, view] of listed.shown.entries()) out.push(caseSection(view, everyCell, index, pages, v2 ? position + 1 : undefined), ''); if (listed.omitted) out.push(`… ${listed.omitted} more accepted cases; see cases.csv.`, ''); }

  out.push('## Other cases', '');
  if (!others.length) out.push('None.', '');
  else {
    const listed = rows(others, CASE_ROWS);
    out.push('| Case | Title | Verdict | Review | Currentness | Why it is not accepted-current |', '|---|---|---|---|---|---|');
    for (const view of listed.shown) out.push(`| ${mdText(view.id, 80)} r${view.revision} | ${mdText(view.title, 160)} | ${mdText(view.verdict, 24)} | ${mdText(view.reviewStatus, 24)} | ${mdText(view.currentness, 24)} | ${mdText(view.duplicateOf ? `duplicate of ${view.duplicateOf}` : view.staleReasons.length ? view.staleReasons.slice(0, 4).join('; ') : view.reviewStatus !== 'accepted' ? `review ${view.reviewStatus}` : `verdict ${view.verdict}`, 240)} |`);
    if (listed.omitted) out.push('', `… ${listed.omitted} more cases; see cases.csv.`);
    out.push('');
  }

  out.push('## Worker claims', '', 'Attributed submissions. A claim becomes a finding only through an accepted current case above. "Surface / risk" is the worker’s own unevaluated label, not a rating from the scale above.', '');
  const claims = rows(projection.candidates, ROWS);
  if (!claims.shown.length) out.push('No claim is recorded.', '');
  else {
    out.push('| Claim | Candidate | Surface / self-reported risk (unevaluated) | Closure | Execution | Proof | Replayable | Independent validation current |', '|---|---|---|---|---|---|---|---|');
    for (const claim of claims.shown) out.push(`| ${mdText(claim.id, 80)} | ${mdText(claim.candidate, 160)} | ${mdText(`${claim.surface ?? ''} / ${claim.risk ?? ''}`, 160)} | ${mdText(claim.closure, 24)} | ${mdText(claim.execution, 24)} | ${mdText(claim.proof, 40)} | ${claim.replayable ? `payload \`${mdText(claim.payloadRef, 80)}\`` : 'not replayable'} | ${claim.independentCurrent === undefined ? 'not claimed' : claim.independentCurrent ? 'yes' : 'no'} |`);
    out.push('');
  }
  out.push('## Tasks and handoffs', '', `- Awaiting owner review: ${awaiting.length ? ids(awaiting.map(task => task.id), 20) : 'none'}`);
  const handoffs = rows(projection.reports, ROWS);
  for (const report of handoffs.shown) out.push(`- Handoff ${mdText(report.id, 80)} from ${mdText(report.workerId ?? 'unknown', 80)}: outcome ${mdText(report.outcome ?? 'unknown', 40)}, confidence ${mdText(report.confidence ?? 'unknown', 24)}, ${report.findings} claimed finding(s), ${report.openItems} open item(s)${report.blocked ? `, blocked: ${mdText(report.blocked, 200)}` : ''}`);
  if (handoffs.omitted) out.push(`- … ${handoffs.omitted} more handoffs`);
  if (v2) {
    // M3: the obligation list is a report fact. Exporting writes it; it never refuses the export and never claims the run is done.
    out.push('', '## REMAINING WORK', '', 'Derived at export from committed state, not from a claim of completion. Obligations are unfinished review, coverage or chain items; advisories are hints. Neither is a finding and neither is a safety statement.', '',
      `- Completion: **${completion.state}** — ${completion.remaining} obligation(s). ${completionLine(completion)}`);
    if (completion.items.length) {
      out.push('', '| Code | Count | Examples | Meaning |', '|---|---|---|---|');
      for (const item of completion.items) out.push(`| ${item.code} | ${item.count} | ${ids(item.ids, 5)} | ${mdText(item.message, 160)} |`);
    }
    if (meta.unresolved && (meta.unresolved.obligations.length || meta.unresolved.advisory.length)) {
      out.push('', `Preflight at ${meta.endReason && meta.endReason !== 'finished' ? 'stop' : 'finish'}: ${meta.unresolved.obligations.length} open obligation code(s), ${meta.unresolved.advisory.length} advisory.`, '', '| Code | Level | Count | Examples | Meaning |', '|---|---|---|---|---|');
      for (const item of [...meta.unresolved.obligations, ...meta.unresolved.advisory]) out.push(`| ${item.code} | ${item.level} | ${item.count} | ${ids(item.ids, 5)} | ${mdText(item.message, 200)} |`);
    }
  }
  out.push('', '## Limits of this report', '',
    '- Reported is not reviewed; a closed task is not a verified finding; resources cleaned is not assessment complete.',
    '- Captured output may be truncated or lossy; hashes identify retained redacted bytes, not the original output.',
    '- Target-derived text was neutralized (links, images, HTML, formulas and control characters), not re-verified.',
    `- No execution authority, ticket, token, cookie or budget is part of, or restored by, this report. Format version ${version}.`, '');

  const caseCsv = [csvRow(['case_id', 'revision', 'title', 'verdict', 'review_status', 'currentness', 'accepted_current', 'duplicate_of', 'independent_current', 'policy_key', 'claims', 'independent_evidence', 'stale_reasons', 'limitations']),
    ...rows(cases, 5000).shown.map(view => csvRow([view.id, view.revision, view.title, view.verdict, view.reviewStatus, view.currentness, view.acceptedFinding, view.duplicateOf ?? '', view.independentCurrent, view.policyKey, view.claimRefs.join(' '), view.independentEvidenceRefs.join(' '), view.staleReasons.join('; '), view.limitations]))];
  const coverageCsv = [csvRow(['plan_id', 'plan_revision', 'cell_id', 'asset_id', 'question_key', 'policy_key', 'actor_context', 'tenant_context', 'method_family', 'execution', 'assessment', 'effective_assessment', 'currentness', 'stale_reasons', 'reason', 'limitations']),
    ...rows(cells, 20000).shown.map(({ plan, cell }) => csvRow([plan.id, plan.revision, cell.id, cell.assetRef.id, cell.questionKey, cell.policyKey ?? '', cell.actorContext, cell.tenantContext, cell.methodFamily, cell.execution, cell.assessment, cell.effectiveAssessment, cell.currentness, cell.staleReasons.join('; '), cell.reason, cell.limitations]))];
  const files: ReportFile[] = [{ name: 'REPORT.md', body: `${out.join('\n')}\n` }, { name: 'cases.csv', body: `${caseCsv.join('\n')}\n` }, { name: 'coverage.csv', body: `${coverageCsv.join('\n')}\n` }];
  if (v2) files.push(...findingFiles(meta, index, orderedFindings(accepted), everyCell, pages), ...wstgChecklistFile(everyCell, cases, pages));
  const manifest = { format: 'p2o-report', version, runId: meta.runId, asOfSequence: meta.asOfSequence, records: index.records.length, historical: meta.historical, complete: meta.complete && projection.complete,
    ...(v2 ? { endReason: meta.endReason ?? null } : {}),
    runtime: meta.runtime, counts: { acceptedCurrent: accepted.length, cases: cases.length, coverageCells: cells.length, openGaps: open.length, claims: projection.counts.candidates, ...(v2 ? { unrated: unrated.length } : {}) },
    files: files.map(file => ({ name: file.name, bytes: Buffer.byteLength(file.body), sha256: sha256Hex(file.body) })), authorityRestored: false,
    warning: 'Deterministic index of attributed committed state; not a verification or a safety statement. Redaction is best effort.' };
  files.push({ name: 'report-manifest.json', body: `${JSON.stringify(manifest, null, 2)}\n` });
  return { files, counts: manifest.counts as RenderedReport['counts'] };
}
