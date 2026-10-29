import { describeCapability } from './capabilities.js';
import { caseViews, needsCaseReview, type CaseView } from './cases.js';
import { goalProofRefusal, proofLabel, proofViews } from './goal-proof.js';
import { writeBackLine, type WorkerWrites } from './write-back.js';
import { leadFrontier } from './cve.js';
import { routeCounts } from './routes.js';
import { cvssScore, type CaseEffect } from './cvss.js';
import { campaignFromRecords, engagementLine, type CampaignRecord, type EngagementMode } from './campaign.js';
import { policySourceLabel, type PolicyArtifact } from './policy-artifact.js';
import { deriveLadder, type LadderCaseInput, type LadderView } from './ladder.js';
import { policyAudit } from './policy.js';
import { FINDING_SEVERITIES } from './case-types.js';
import { completionLine, deriveCompletion } from './completion.js';
import { DEBT_KINDS, debtFor, type DebtReport } from './debt.js';
import { claimHeadClaims } from './chain-view.js';
import { planFrontier } from './planning.js';
import { coverageViews, type CoverageCellView, type CoverageContext, type CoveragePlanView } from './coverage.js';
import { safeText } from './evidence.js';
import type { LedgerIndex } from './records.js';
import type { FinishPreflight } from './finish-preflight.js';
import { reportProjection, type ReportAssetBrief, type ReportProjectionContext } from './report.js';
import type { AuthorityMode } from './authority.js';
import { awaitingReview, taskFrontier, taskRevisionAt } from './tasks.js';
import { sha256Hex } from './validate.js';
import { WSTG_BY_KEY, WSTG_COMMIT, WSTG_MAP, isWstgKey, wstgEvidence, wstgKey, wstgPageUrl, type WstgEvidence } from './wstg-map.js';
import { attackForWstg } from './attack-map.js';
import { findingId, findingScope } from './finding-fingerprint.js';
import { sarifLog, stixBundle, type InteropFinding, type InteropInput } from './report-interop.js';
import { ProjectKnowledge, type ProjectKnowledgeView } from './project-knowledge-db.js';

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
  /** W3: a draft export is not the final snapshot. */
  kind?: 'draft' | 'final';
  /** Stored run outcome; printed next to the derived completion so a mismatch is visible, never hidden. */
  outcome?: Record<string, unknown>;
  /** Preflight at finish: items still unresolved when the lead finished. Printed as a section, never counted as findings. */
  unresolved?: FinishPreflight;
  /** Lead-written executive text (p2o_finish narrative). Printed under an "unverified" label. */
  narrative?: string;
  /** Operator-supplied labels from settings p2o.report; printed as given after neutralization. */
  operator?: Partial<Record<OperatorField, string>>;
  /** Package-relative paths of the catalog's wstg-source pages, used only to print the pinned upstream address of a test. */
  wstgPages?: readonly string[];
  /** P16.3: host-computed write-back counts per worker, printed next to each handoff so the report counts what was written. */
  wrote?: ReadonlyMap<string, WorkerWrites>;
  /** A4: the loop/executor mode that produced the run, printed next to the authority counters and role matrix. */
  mode?: AuthorityMode;
  /** R3.8: emit the opt-in STIX 2.1 bundle beside the SARIF log. Never part of the default bundle. */
  stix?: boolean;
  /** R3.9: project-level history read back after merging this run; printed as suggested context, never evidence. */
  prior?: ProjectKnowledgeView;
  /** D15/P7.1: the engagement mode and authorized effect classes; absent on a run recorded before the mode existed. */
  engagement?: { mode: EngagementMode; effectClasses: readonly CaseEffect[] };
  /** A7.6: the facts the access ladder prints beside its rungs. Recorded by P7.4 (sessions), P7.5 (secrets by id) and P7.7 (callback). */
  ladderFacts?: { sessions?: string; secrets?: string; callback?: string };
  /** A7.8/P7.7: the ingress path the operator configured, so the scope section states it instead of claiming no inbound ever exists. */
  ingress?: { callback?: string; labNetwork?: string };
  /** A7.4/P7.5: the sealed identity this run started with (count and digest only; a value is never a report input). */
  identity?: { count: number; sha256?: string };
  /** A6.2/A6.6: the derived research debt, so the report's completion cannot disagree with the finish result's. */
  debt?: DebtReport;
  /** A6.6: the campaign frame and how the run continued, printed as recorded facts (never re-verified here). */
  campaign?: {
    objective: string; mode?: EngagementMode; effectClasses?: readonly CaseEffect[]; constraints: number; deny: number; allow: number; heartbeatSeconds: number;
    rounds: number; wakeReasons: { event: number; debt: number; heartbeat: number };
    /** P1: ledger counts of human `/p2o resume` records and recorded stall escalations, printed with the campaign frame. */
    humanResumes: number; stallEscalations: number;
    /** P21/B1: the policy baseline the operator recorded at start; the report prints its source, never its body. */
    policy?: PolicyArtifact;
    startedAt: string; endedAt?: string; partialReason?: string;
  };
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
/**
 * R1.6: one cited asset rendered as its recorded identity instead of a bare id. A pin that no longer matches the head is
 * stated as stale, and an id the current graph scope cannot resolve says so rather than silently reading as a valid asset.
 */
export function assetText(ref: { id: string; revision?: number }, assets: Readonly<Record<string, ReportAssetBrief>>): string {
  const brief = assets[ref.id];
  if (!brief) return `${mdText(ref.id, 80)} (unresolved in the current graph scope)`;
  const stale = ref.revision !== undefined && ref.revision !== brief.revision;
  return `${mdText(brief.kind, 24)} ${mdText(brief.key, 80)}${brief.label ? ` “${mdText(brief.label, 40)}”` : ''} (${mdText(brief.id, 60)}${ref.revision !== undefined ? `@r${ref.revision}` : ''}${stale ? `, stale; current r${brief.revision}` : ''})`;
}
const assetIds = (refs: readonly { id: string; revision?: number }[] | undefined, assets: Readonly<Record<string, ReportAssetBrief>> | undefined, limit = 6): string =>
  !refs?.length ? 'none' : `${refs.slice(0, limit).map(ref => assets ? assetText(ref, assets) : mdText(ref.id, 80)).join(', ')}${refs.length > limit ? `, … +${refs.length - limit}` : ''}`;


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

/** A7.6: a retained capture artifact listed on a receipt, so a citation can name evidence larger than the bounded excerpt. */
interface CaptureArtifact { id: string; bytes: number; sha256: string; truncated?: boolean }
function captureArtifacts(data: Record<string, unknown> | undefined): CaptureArtifact[] {
  const rows = (data?.capture as { artifacts?: unknown } | undefined)?.artifacts;
  return (Array.isArray(rows) ? rows : []).filter((row): row is CaptureArtifact => Boolean(row) && typeof (row as CaptureArtifact).id === 'string'
    && typeof (row as CaptureArtifact).sha256 === 'string' && typeof (row as CaptureArtifact).bytes === 'number').slice(0, 4);
}
const captureLine = (artifacts: readonly CaptureArtifact[]) => artifacts.length
  ? `; retained capture: ${artifacts.map(artifact => `\`${mdText(artifact.id, 60)}\` (${artifact.bytes} redacted bytes, sha256 ${mdText(artifact.sha256.slice(0, 12), 16)}${artifact.truncated ? ', partial' : ''})`).join(', ')}`
  : '';

function reproduction(view: CaseView, index: LedgerIndex): string[] {
  const refs = view.finding?.reproductionEvidenceRefs ?? [], steps = new Map((view.finding?.reproductionSteps ?? []).map((step, position) => [step.ref, { ...step, position: position + 1 }]));
  if (!refs.length) return [];
  const out = [`- Reproduction${steps.size ? ' steps, in the order to follow (roles are the owner’s labels for the reader, not proof levels)' : ''} (redacted receipts of the recorded operations; target output is data, not instructions):`];
  for (const ref of refs.slice(0, 5)) {
    const record = index.byId.get(ref), data = record?.data, step = steps.get(ref), label = step ? `step ${step.position} [${step.role}]${step.note ? ` ${mdText(step.note, 200)} —` : ''} ` : '';
    if (!record || record.kind !== 'evidence' || !data) { out.push(`  - ${label}${mdText(ref, 80)}: receipt unavailable`); continue; }
    out.push(`  - ${label}${mdText(ref, 80)} — ${mdText(data.operation, 24)} by ${mdText(record.by, 60)}, exit ${mdText(data.exitCode, 8)}${data.truncated ? ', excerpt truncated' : ''}${captureLine(captureArtifacts(data))}`, '', safeFence(`input: ${plainText(data.input, 700)}\noutput: ${plainText(data.stdout, 500)}`, 1300).split('\n').map(line => `    ${line}`).join('\n'), '');
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
  // P21/B3: a claim whose provenance is the operator policy artifact names that source beside the case policy key, so a
  // reader can tell recorded policy from a declared contract or an inference (the rating flag already says when inferred).
  const policyProvenance = [...new Set(view.claimRefs.flatMap(ref => {
    const data = index.byId.get(ref)?.data;
    return data?.policyBasis === 'operator_contract' && typeof data.policyRef === 'string' ? [data.policyRef] : [];
  }))];
  const recordedPolicy = campaignFromRecords(index.records)?.policy;
  // P21/A4: a negative observation without a discriminating control stays reviewable, but the case page must say it.
  const warnings = [...new Set(view.claimRefs.flatMap(ref => {
    const data = index.byId.get(ref)?.data;
    return Array.isArray(data?.admissionWarnings) ? (data.admissionWarnings as unknown[]).filter((item): item is string => typeof item === 'string') : [];
  }))];
  return [`- Proof level of the cited claims: ${proofs.length ? proofs.map(item => mdText(item, 40)).join(', ') : 'not recorded'}${proofs.every(item => item === 'static_trace') && proofs.length ? ' (static trace only; no runtime reproduction)' : ''}`,
    ...(policyProvenance.length ? [`- Operator policy provenance: ${recordedPolicy ? mdText(policySourceLabel(recordedPolicy), 300) : `cited ${mdText(policyProvenance.join(', '), 200)}, but this run recorded no policy artifact`}`] : []),
    ...(reviews.length ? [`- Review receipts: ${reviews.join('; ')}`] : []),
    ...(warnings.length ? [`- Claim admission warnings: ${warnings.slice(0, 4).map(item => mdText(item, 240)).join('; ')}`] : [])];
}

function findingLines(view: CaseView, cells: readonly CoverageCellView[], index: LedgerIndex, pages: readonly string[]): string[] {
  const finding = view.finding;
  if (!finding) return ['- Severity: **not rated** — the owner has not recorded a rating for this case, so it cannot be ranked.'];
  const score = cvssScore(finding.cvssVector), keys = wstgReferenceList(view, cells);
  // D35: an accepted high/critical rating may rest on inferred policy provenance when the effect itself was tested and observed.
  const provenance = view.ratingProvenance ? ' — provenance **INFERRED_POLICY**: the effect was tested and observed, while the policy basis stays inferred; the rating limitation states what that leaves unproven' : '';
  return [`- Severity **${severityLabel(finding.severity)}** (owner-attributed, p2o scale) — basis: ${mdText(finding.basis, 1000)}${view.ratingCurrent === false ? ` (rating recorded against r${view.ratedRevision}; the case is now r${view.revision}, so check that it still applies)` : ''}${provenance}`,
    ...(finding.likelihood ? [`- Likelihood: ${mdText(finding.likelihood, 800)}`] : []), ...(finding.impact ? [`- Impact: ${mdText(finding.impact, 800)}`] : []),
    ...(finding.limitations ? [`- Rating limitation: ${mdText(finding.limitations, 2000)}`] : []),
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

function caseSection(view: CaseView, cells: readonly CoverageCellView[], index?: LedgerIndex, pages: readonly string[] = [], ordinal?: number, assets?: Readonly<Record<string, ReportAssetBrief>>): string {
  const wstg = caseWstgKeys(view.id, view.revision, cells), attack = attackForWstg(wstg);
  const v2 = ordinal !== undefined;
  return [`### ${v2 ? `F-${ordinal} ` : ''}${mdText(view.title, 160)} — case ${mdText(view.id, 80)} r${view.revision}`,
    `- Verdict **${mdText(view.verdict)}**; review **${mdText(view.reviewStatus)}**; currentness **${mdText(view.currentness)}**; independent validation current: ${view.independentCurrent ? 'yes' : 'no'}${!view.independentCurrent && view.independenceReason ? ` (${mdText(view.independenceReason, 300)})` : ''}`,
    `- Policy: ${mdText(view.policyKey, 160)}${view.rootCauseKey ? `; root cause: ${mdText(view.rootCauseKey, 160)}` : ''}`,
    `- Assets: ${assetIds(view.assetRefs, assets)}; claims: ${ids(view.claimRefs)}; independent evidence: ${ids(view.independentEvidenceRefs)}; tasks: ${ids(view.taskRefs.map(ref => `${ref.taskId}@r${ref.revision ?? '?'}`))}`,
    `- Contradictions: ${view.contradictions.length ? view.contradictions.slice(0, 6).map(item => `${mdText(item.evidenceRef, 80)} (${mdText(item.status)})`).join(', ') : 'none recorded'}; affected variants: ${list(view.affectedVariants.map(item => mdText(item, 120)))}`,
    ...(wstg.length ? [`- WSTG tests this case addresses (see the WSTG checklist for level): ${wstg.map(key => mdText(key, 40)).join(', ')}`] : []),
    ...(attack.length ? [`- ATT&CK techniques those tests point at (derived from the pinned crosswalk in docs/ATTACK_MAP.md; a mapping is judgement, not detection): ${attack.map(technique => `\`${mdText(technique.id, 20)}\``).join(', ')}`] : []),
    ...(v2 && index ? [...provenanceLines(view, index), ...findingLines(view, cells, index, pages)] : []),
    ...(view.retest ? [`- Retest (owner-attributed${view.retestCurrent === false ? `, recorded against r${view.retest.caseRevision} so it is history for this revision` : ''}): **${mdText(view.retest.verdict)}** — ${mdText(view.retest.reason, 1000)}${view.retest.evidenceRefs.length ? `; evidence ${ids(view.retest.evidenceRefs)}` : ''}. A retest says whether the effect still reproduced; it never re-rates or re-accepts the finding.`] : []),
    `- Remediation: ${mdText(view.remediation.status)} — ${mdText(view.remediation.reason, 200)}`,
    `- Reviewer reasoning: ${mdText(view.reviewReason)}`, `- Limitations: ${mdText(view.limitations)}`].join('\n');
}

const EVIDENCE_LABEL: Record<WstgEvidence, string> = { L3: 'proven', L2: 'checked', L1: 'attempted, blocked or stale', L0: 'not checked', 'n/a': 'not applicable' };

/**
 * Fixed, documented scale (skills/remediation/references/risk-rating-criteria.md); never computed from a field the host validates and
 * never a substitute for a case's own verdict or review status. Printed once per report when at least one accepted case exists.
 */
const RISK_LEVELS: ReadonlyArray<readonly [name: string, criteria: string]> = [
  ['Critical', 'exploitable with no prior access and no authenticated identity, reaching data or control beyond the tested object’s own owner'],
  ['High', 'exploitable with no prior access reaching only the tested object’s own owner, or exploitable only with an identity but reaching beyond it'],
  ['Medium', 'exploitable only with an authenticated identity (the operator’s sealed one or a self-provisioned principal) and confined to that identity’s own data, or a confirmed structural weakness whose further reach is an open proof gap'],
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
    `Tests are the OWASP WSTG tests pinned at commit ${WSTG_COMMIT.slice(0, 12)} (${WSTG_MAP.length} tests). A coverage cell addresses one test by using its lower-case ID as its question key. Level summarizes only the cells recorded in this run: L0 not checked, L1 attempted, blocked or stale, L2 checked (a current tested cell), L3 proven (that cell cites an accepted, current, confirmed case). A level is not a statement about the target, and L2 does not mean the target is protected. Support describes the shipped skill library, never the target: D a skill names the test, T only general techniques apply, N no skill, O outside the scope of this tool. Flag B marks a test carried by the browser transport and flag I one that needs an authenticated principal; the sandbox image provides the browser and a worker provisions its own principal, so neither flag is a limitation of this run.`, '',
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
  // A7.8/A7.10: the truth about inbound is configuration-dependent. A lab-network run really can be reached by a target on
  // that network, so the fixed "no inbound path" sentence would be false there; the default (no ingress) sentence stays absolute.
  const inbound = meta.ingress?.labNetwork
    ? `There is no inbound path from the internet and no host port is ever published; the sandbox joined the operator lab network "${mdText(meta.ingress.labNetwork, 100)}", so a target on that network can reach a session listener, and no tunnel or pivot exists.`
    : meta.ingress?.callback
      ? `There is no inbound path into the sandbox (no host port is published, no tunnel or pivot); the operator recorded the out-of-band callback destination "${mdText(meta.ingress.callback, 200)}" as a path the target reaches outward.`
      : 'There is no inbound path, so a target cannot call back to the sandbox.';
  return ['## Scope and limitations', '',
    `- Assessed target: ${mdText(meta.target, 400)}, as authorized by the operator when the run started. The tool never widened this scope.`,
    ...(meta.engagement ? [`- Engagement mode: ${mdText(engagementLine(meta.engagement.mode, meta.engagement.effectClasses), 400)}.`] : []),
    `- Coverage denominator: ${plans.length ? `${plans.length} plan(s), ${live.length} live cell(s), derived from reviewed worker work (no planner-authored cell exists)` : 'none recorded, so nothing can be called covered'}. Exclusions recorded: ${list(exclusions.map(item => mdText(item, 200)))}. Unknown scope: ${list(unknown.map(item => mdText(item, 200)))}.`,
    `- Not examined or not confirmed: ${notClean.length} cell(s) (${notTested} not tested, ${stale} stale), ${unplanned} discovered asset(s) outside every plan, ${openGaps} open gap(s)${usesWstg ? `, ${untouched} WSTG test(s) with no cell` : ''}. Each is listed in the coverage section below; none of them is a result.`,
    meta.identity
      ? `- Tool limits: commands and HTTP requests run from a sandbox with unrestricted bridge egress; the authorized target is the starting label, not a network boundary. The sandbox image carries a headless Chromium and the agent-browser CLI, so an effect that happens only in a browser is executed there and reported from its own receipt. The operator declared ${meta.identity.count} secret(s) and the host substituted each placeholder by id after the command policy allowed the operation; retained receipts, artifacts, reports and exports redact exact value bytes on a best-effort basis and every use was audited by id. A command that ran with a principal can still print or forward the substituted value, so an effect reached that way is reported as exposed to that scope. ${inbound}`
      : `- Tool limits: commands and HTTP requests run from a sandbox with unrestricted bridge egress; the authorized target is the starting label, not a network boundary. The sandbox image carries a headless Chromium and the agent-browser CLI, so a browser-only effect is executed there and reported from its own receipt; there is no host credential channel, so a check that needed a credential used one the worker created or wrote into the request (a self-provisioned principal is disposable). ${inbound}`,
    '- The severity of a finding is an attributed rating recorded by the lead, with its stated basis. It is bounded by the depth a chain actually demonstrated (a rating above that depth is refused) and it never changes a case’s verdict or review status.', '',
    '## Executive summary', '',
    `- Accepted, current findings: **${accepted.length}** (${bySeverity}${unrated.length ? `, not rated ${unrated.length}` : ''}).`,
    `- Cases not accepted-current: ${others.length} (${pending} awaiting a review decision). Tasks awaiting owner review: ${awaiting}.`,
    `- Coverage: ${live.length} live cell(s) of which ${live.length - notTested} tested; ${notTested} not tested; ${stale} stale. Open gaps: ${openGaps}.`,
    `- Records examined: ${index.records.length}${index.complete ? '' : ' (INCOMPLETE scan, no completeness claim)'}.`,
    ...(paragraphs.length ? ['', '> **Lead narrative — written by the lead agent, not verified by the host:**', '>', ...paragraphs.flatMap(part => [`> ${mdText(part, 1500)}`, '>']).slice(0, -1)] : ['', 'No lead narrative was supplied.']),
    '', 'These counts describe attributed state at one sequence number. They are not a business-impact rating and not a statement that the target is safe.', ''];
}


/**
 * One derivation of a finding's identity and its resolved asset identities, shared by every export surface (findings.json,
 * SARIF/STIX and the project database) so the same case cannot carry two ids. A store that cannot resolve an id keeps the raw id:
 * the finding id is then run-scoped, which is a limit the report must state rather than hide.
 */
export function findingIdentityFor(meta: ReportMeta, view: CaseView, assets?: Readonly<Record<string, ReportAssetBrief>>): { findingId: string; assets: Array<{ id: string; kind: string; key: string }> } {
  const resolved = view.assetRefs.map(ref => { const brief = assets?.[ref.id]; return { id: ref.id, kind: brief?.kind ?? 'other', key: brief?.key ?? ref.id }; });
  return { findingId: findingId({ scope: findingScope(meta.target), policyKey: view.policyKey, ...(view.rootCauseKey ? { rootCauseKey: view.rootCauseKey } : {}), assets: resolved }), assets: resolved };
}

/**
 * R3.6/R3.7: the host-derived identity, ATT&CK crosswalk and asset locations of one accepted-current finding. Everything is derived
 * from stored case, coverage and asset data: the model never writes a finding id or a technique, so the export cannot claim either.
 * A location is emitted only for asset kinds whose key is a real address (endpoint/route/file/config); other kinds stay identities.
 */
function interopFinding(meta: ReportMeta, view: CaseView, cells: readonly CoverageCellView[], position: number, assets?: Readonly<Record<string, ReportAssetBrief>>): InteropFinding {
  const wstg = caseWstgKeys(view.id, view.revision, cells), identity = findingIdentityFor(meta, view, assets), resolved = identity.assets;
  const score = cvssScore(view.finding?.cvssVector);
  const locations = resolved.flatMap((asset): NonNullable<InteropFinding['locations']> => asset.kind === 'endpoint' || asset.kind === 'route' ? [{ kind: 'url' as const, value: asset.key }]
    : asset.kind === 'file' ? [{ kind: 'path' as const, value: asset.key }] : asset.kind === 'config' ? [{ kind: 'config' as const, value: asset.key }] : []);
  return { ref: `F-${position}`, caseId: view.id, revision: view.revision, title: view.title, severity: view.finding?.severity ?? null, verdict: view.verdict,
    policyKey: view.policyKey, ...(view.rootCauseKey ? { rootCauseKey: view.rootCauseKey } : {}), cvss: score ? { vector: score.vector, baseScore: score.score, severity: score.severity } : null,
    cwe: view.finding?.cwe ?? [], wstg, techniques: attackForWstg(wstg).map(technique => technique.id), assets: resolved,
    findingId: identity.findingId,
    ...(locations.length ? { locations } : {}),
    evidenceRefs: [...new Set([...(view.finding?.reproductionEvidenceRefs ?? []), ...view.independentEvidenceRefs])].slice(0, 20) };
}

/** The deterministic input both interop builders share; `generatedAt` is the last committed record, never a clock read. */
function interopInput(meta: ReportMeta, index: LedgerIndex, ordered: readonly CaseView[], cells: readonly CoverageCellView[], assets?: Readonly<Record<string, ReportAssetBrief>>): InteropInput {
  return { runId: meta.runId, target: meta.target, asOfSequence: meta.asOfSequence, complete: meta.complete,
    generatedAt: index.records.at(-1)?.at ?? '1970-01-01T00:00:00.000Z', toolVersion: meta.runtime.version ?? 'unknown',
    findings: ordered.map((view, position) => interopFinding(meta, view, cells, position + 1, assets)) };
}

/**
 * R3.9: merge this run's accepted findings (and the cited assets an inventory resolved) into the project-scoped database, then read
 * the scope back. Only identity-bearing values the run already validated are stored, with provenance. The result is suggested
 * context: it never becomes a graph fact and never confirms a claim, a case or a coverage cell.
 */
export function mergeProjectKnowledge(file: string, meta: ReportMeta, index: LedgerIndex, context: ReportProjectionContext, assets?: Readonly<Record<string, ReportAssetBrief>>): ProjectKnowledgeView | undefined {
  const accepted = orderedFindings(caseViews(index, context.cases ?? {}).filter(view => view.acceptedFinding));
  const db = ProjectKnowledge.open(file);
  try {
    const findings = accepted.map(view => {
      const identity = findingIdentityFor(meta, view, assets), retest = view.retest;
      // The stored state is the disposition the run recorded, not a live verdict: a retest moves it, the case does not.
      const state = retest?.verdict === 'fixed' ? 'fixed' : retest?.verdict === 'still_reproducible' ? 'still_reproducible' : retest?.verdict === 'cannot_confirm' ? 'cannot_confirm' : 'accepted';
      return { findingId: identity.findingId, policyKey: view.policyKey, ...(view.rootCauseKey ? { rootCauseKey: view.rootCauseKey } : {}),
        ...(view.finding?.severity ? { severity: view.finding.severity } : {}), caseRef: view.id, state };
    });
    const cited = [...new Set(accepted.flatMap(view => view.assetRefs.map(ref => ref.id)))].map(id => assets?.[id])
      .filter((brief): brief is ReportAssetBrief => brief !== undefined).map(brief => ({ id: brief.id, kind: brief.kind, key: brief.key, ...(brief.label ? { label: brief.label } : {}) }));
    db.merge({ scope: { tenant: '', target: meta.target }, runId: meta.runId, retrievedAt: index.records.at(-1)?.at ?? '1970-01-01T00:00:00.000Z', findings, assets: cited });
    return db.read({ tenant: '', target: meta.target.toLowerCase().trim() })[0];
  } finally { db.close(); }
}

/** Machine-readable findings: every typed field of every accepted-current case, strings redacted and bounded but NOT Markdown-escaped (escape on display). */
function findingFiles(meta: ReportMeta, index: LedgerIndex, ordered: readonly CaseView[], cells: readonly CoverageCellView[], pages: readonly string[], assets?: Readonly<Record<string, ReportAssetBrief>>): ReportFile[] {
  const reproduce = (view: CaseView) => (view.finding?.reproductionEvidenceRefs ?? []).map(ref => { const record = index.byId.get(ref), data = record?.kind === 'evidence' ? record.data : undefined, step = view.finding?.reproductionSteps?.find(item => item.ref === ref);
    return { evidenceId: ref, ...(step ? { role: step.role, ...(step.note ? { note: plainText(step.note, 200) } : {}) } : {}), available: Boolean(data), operation: data ? plainText(data.operation, 24) : null, by: record ? plainText(record.by, 60) : null, exitCode: data?.exitCode ?? null, input: data ? plainText(data.input, 700) : null, output: data ? plainText(data.stdout, 500) : null, truncated: Boolean(data?.truncated),
      captures: captureArtifacts(data).map(artifact => ({ id: artifact.id, bytes: artifact.bytes, sha256: artifact.sha256, partial: artifact.truncated === true })) }; });
  const items = ordered.slice(0, CASE_ROWS).map((view, position) => {
    const score = cvssScore(view.finding?.cvssVector), wstg = caseWstgKeys(view.id, view.revision, cells), identity = interopFinding(meta, view, cells, position + 1, assets);
    return { ref: `F-${position + 1}`, caseId: view.id, revision: view.revision, title: plainText(view.title, 500), verdict: view.verdict, reviewStatus: view.reviewStatus, currentness: view.currentness, independentValidationCurrent: view.independentCurrent, independenceReason: view.independenceReason ?? null,
      findingId: identity.findingId, techniques: identity.techniques,
      retest: view.retest ? { verdict: view.retest.verdict, caseRevision: view.retest.caseRevision, current: view.retestCurrent === true, reason: plainText(view.retest.reason, 1000), evidenceRefs: view.retest.evidenceRefs } : null,
      severity: view.finding?.severity ?? null, severityBasis: view.finding ? plainText(view.finding.basis, 1000) : null, likelihood: view.finding?.likelihood ? plainText(view.finding.likelihood, 800) : null, impact: view.finding?.impact ? plainText(view.finding.impact, 800) : null,
      ratingLimitations: view.finding?.limitations ? plainText(view.finding.limitations, 2000) : null, ratingProvenance: view.ratingProvenance ?? null,
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
  const csv = [csvRow(['ref', 'case_id', 'revision', 'title', 'severity', 'cvss_vector', 'cvss_score', 'cwe', 'wstg', 'techniques', 'finding_id', 'retest_verdict', 'retest_evidence', 'verdict', 'review_status', 'currentness', 'independent_validation_current', 'policy_key', 'root_cause_key', 'remediation_status', 'remediation_steps', 'references', 'reproduction_evidence']),
    ...items.map(item => csvRow([item.ref, item.caseId, item.revision, item.title, item.severity ?? 'not rated', item.cvss?.vector ?? '', item.cvss?.baseScore ?? '', item.cwe.join(' '), item.wstg.map(entry => entry.key).join(' '), item.techniques.join(' '), item.findingId, item.retest?.verdict ?? '', item.retest?.evidenceRefs.join(' ') ?? '', item.verdict, item.reviewStatus, item.currentness, item.independentValidationCurrent, item.policyKey, item.rootCauseKey ?? '', item.remediation.status, item.remediation.steps ?? '', item.references.join(' '), item.reproduction.map(entry => entry.evidenceId).join(' ')]))];
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

/** A6.6: the campaign frame as recorded, printed above the summary. Nothing here is re-verified or re-derived. */
function campaignSection(campaign: NonNullable<ReportMeta['campaign']>): string[] {
  const reasons = `event ${campaign.wakeReasons.event}, debt ${campaign.wakeReasons.debt}, heartbeat ${campaign.wakeReasons.heartbeat}`;
  return ['## Campaign', '',
    `- Objective (operator-supplied, unverified; it neither widens nor narrows the authorized scope): ${mdText(campaign.objective, 600)}`,
    `- Recorded constraints: ${campaign.constraints} (${campaign.deny} deny = absolute, ${campaign.allow} allow = permission only). This report does not re-check them against the work below.`,
    `- Heartbeat: ${campaign.heartbeatSeconds === 0 ? 'disabled (0s)' : `${campaign.heartbeatSeconds}s`}; automatic rounds: ${campaign.rounds}; wake reasons: ${reasons}.`,
    ...(campaign.policy ? [`- Operator policy: ${mdText(policySourceLabel(campaign.policy), 300)}. A claim under operator_contract cites this artifact id; the body was hashed at start and never copied into the ledger or a prompt.`] : []),
    `- Human resumes: ${campaign.humanResumes}; stall escalations: ${campaign.stallEscalations}.`,
    `- Campaign started: ${mdText(campaign.startedAt, 64)}${campaign.endedAt ? `; last committed record: ${mdText(campaign.endedAt, 64)}` : ''}`,
    ...(campaign.partialReason ? ['', '### Why the run stopped', '',
      `- ${mdText(campaign.partialReason, 600)} — quoted as recorded by the lead at the final finish. A partial stop is not a completion and asserts nothing about coverage.`] : []),
    ''];
}

/** A7.6: what each derived rung means, printed once so the table below is readable without the source. It quotes no tool and no target data. */
const LADDER_RULE = 'Rungs are derived by the host from committed records and are never stored: observed = a receipt without a demonstrated claim; executed = a demonstrated claim (confirmed closure, tested execution); controlled = demonstrated with at least one negative control; crossed = a demonstrated capability that names its scope, or a demonstrated step effect that crosses a principal, tenant or sandbox boundary; impact = a demonstrated code execution or integrity write reached at local or adjacent access. A rung is printed only for the evidence that carries it.';

/** The ladder a committed state supports. Claims come from the ledger; cases supply the chain and the owner-attributed severity. */
function accessLadder(index: LedgerIndex, cases: readonly CaseView[], meta: ReportMeta): LadderView {
  const claims = index.records.filter(record => record.kind === 'candidate' && record.id).map(record => ({ id: record.id!, data: record.data }));
  const ladderCases: LadderCaseInput[] = cases.map(view => ({
    id: view.id, revision: view.revision, accepted: view.acceptedFinding, severity: view.finding?.severity, claimRefs: view.claimRefs,
    ...(view.finding?.chain ? { chain: { objective: view.finding.chain.objective,
      ...(view.finding.chain.demonstratedThrough === undefined ? {} : { demonstratedThrough: view.finding.chain.demonstratedThrough }),
      ...(view.finding.chain.impact ? { impactSeverity: view.finding.chain.impact.severity } : {}), steps: view.finding.chain.steps } } : {}),
  }));
  // A run recorded before the mode existed carries no engagement authorization; it reads as assess, the narrower label (Q18).
  return deriveLadder({ mode: meta.engagement?.mode ?? meta.campaign?.mode ?? 'assess', start: meta.target, claims, cases: ladderCases });
}

/** A7.6/Q18: the depths this run demonstrated, the walls above them, and nothing the record does not carry. */
function ladderSection(ladder: LadderView, facts?: ReportMeta['ladderFacts']): string[] {
  // These facts describe the instrument, not a rung: sessions and secrets print in both engagement modes, and the caller
  // supplies the ingress path only for a run whose engagement mode authorizes an effect.
  const factLines = [
    ...(facts?.sessions ? [`- Sessions: ${mdText(facts.sessions, 400)}`] : []),
    ...(facts?.secrets ? [`- Secrets used by id: ${mdText(facts.secrets, 400)}`] : []),
    ...(facts?.callback ? [`- Callback endpoint: ${mdText(facts.callback, 300)}`] : []),
  ];
  if (ladder.mode === 'assess') {
    return ['## Access ladder', '', 'No ladder: assess mode. This run recorded observations and claims without authorizing the exploitation steps a ladder measures. The claims and their evidence are unchanged above.', ...(factLines.length ? ['', ...factLines] : []), ''];
  }
  const out = ['## Access ladder', '', LADDER_RULE, '',
    `- Start surface: ${mdText(ladder.start, 400)} — the authorized starting point; the ladder measures only what this run demonstrated beyond it.`,
    ...(ladder.chain ? [`- Chain: ${mdText(ladder.chain.objective, 400)} — case ${mdText(ladder.chain.caseId, 80)} r${ladder.chain.revision}${ladder.chain.accepted ? '' : ' (not an accepted finding)'}${ladder.chain.demonstratedThrough ? `, demonstrated through step ${ladder.chain.demonstratedThrough} of ${ladder.chain.steps.length}` : ', no step demonstrated'}.`]
      : [`- Chain: none recorded; ${ladder.claims} claim(s) are the only evidence of depth.`])];
  if (ladder.chain) {
    out.push('', '| # | Step | Rung | Effect | Capability | Reach |', '|---|---|---|---|---|---|',
      ...ladder.chain.steps.map(step => `| ${step.order} | ${mdText(step.step, 400)}${step.claimRef ? ` — claim \`${mdText(step.claimRef, 80)}\`` : ''} | ${step.rung ?? 'none'} | ${step.effect ? mdText(step.effect, 40) : 'not recorded'} | ${mdText(step.capability, 300)} | ${step.reach ? mdText(step.reach, 120) : 'not recorded'} |`), '');
  }
  out.push(`- Furthest demonstrated rung: ${ladder.furthest ? `**${ladder.furthest}**` : '**none** — no rung was passed'}${ladder.severity ? `; owner-attributed severity **${severityLabel(ladder.severity)}** of case ${mdText(ladder.ratedCase ?? '', 80)}, bounded by the demonstrated depth as above` : '; no accepted case records a rating for it'}.`);
  out.push(ladder.walls.length
    ? `- Not reached: ${ladder.walls.map(wall => `**${wall.rung}** — ${mdText(wall.wall, 400)}`).join('; ')}.`
    : '- Every rung is backed by the recorded evidence.');
  if (facts?.sessions) out.push(`- Sessions: ${mdText(facts.sessions, 400)}`);
  if (facts?.secrets) out.push(`- Secrets used by id: ${mdText(facts.secrets, 400)}`);
  if (facts?.callback) out.push(`- Callback endpoint: ${mdText(facts.callback, 300)}`);
  out.push('');
  return out;
}

/** A6.2/A6.6: research debt at stop, by kind, with the record-discharged count. Owed work and planning signal are named apart (P19/D). */
function debtSection(debt: DebtReport): string[] {
  const kinds = DEBT_KINDS.filter(kind => debt.totals[kind] > 0);
  return ['## Research debt at stop', '',
    `- Remaining: **${debt.gateable}** gateable of **${debt.total}** named item(s); **${debt.discharged}** discharged by a deferred/blocked record. ${debt.backlog} item(s) are planning signal, not owed work. A named item is not a finding and not a safety claim.`,
    ...(kinds.length ? ['', '| Kind | Remaining |', '|---|---|', ...kinds.map(kind => `| ${kind} | ${debt.totals[kind]} |`)] : ['', 'The derivation produced no research-debt item from the committed state.']),
    ''];
}

/** R3.9: project history printed as SUGGESTED context. It is not evidence and cannot confirm a claim, a case or a coverage cell. */
function priorSection(prior: ProjectKnowledgeView, currentRunId: string): string[] {
  const rows = [
    ...prior.findings.slice(0, ROWS).map(row => ({ kind: 'finding' as const, identity: row.identity, state: row.state,
      detail: `${String(row.detail.policyKey ?? '')}${row.detail.rootCauseKey ? ` / ${String(row.detail.rootCauseKey)}` : ''}${row.detail.severity ? `, severity ${String(row.detail.severity)}` : ''}`,
      runId: row.runId, priorRunIds: row.priorRunIds, conflict: row.conflict, stale: row.stale })),
    ...prior.assets.slice(0, ROWS).map(row => ({ kind: 'asset' as const, identity: row.identity, state: row.state,
      detail: row.detail.label ? String(row.detail.label) : '', runId: row.runId, priorRunIds: row.priorRunIds, conflict: row.conflict, stale: row.stale })),
  ];
  return ['## Prior knowledge (suggested context, not evidence)', '',
    `- Project database schema ${prior.schema}; scope tenant ${mdText(prior.tenant || '(unrecorded)', 120)}, target ${mdText(prior.target, 400)}. ${mdText(prior.note, 400)}`,
    `- ${prior.conflicts} conflict(s), ${prior.staleRows} stale row(s). A conflict means another run recorded a different disposition for the same identity: both are kept, so read the history and not just the latest id.`,
    '', '| Kind | Identity | State | Detail | Recorded by | Earlier runs | Flag |', '|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${row.kind} | ${mdText(row.identity, 120)} | ${mdText(row.state, 40)} | ${mdText(row.detail, 240) || '—'} | ${row.runId === currentRunId ? 'this run' : mdText(row.runId, 80)} | ${row.priorRunIds.map(run => mdText(run, 80)).join(', ') || '—'} | ${row.conflict ? 'conflict' : row.stale ? 'stale' : '—'} |`),
    ...(prior.findings.length + prior.assets.length > rows.length ? [`| … ${prior.findings.length + prior.assets.length - rows.length} more row(s) | | | | | | |`] : []), ''];
}

export function renderReport(index: LedgerIndex, context: ReportProjectionContext & { coverage?: CoverageContext }, meta: ReportMeta): RenderedReport {
  const projection = reportProjection(index, meta.mode ? { ...context, mode: meta.mode } : context), tasks = taskFrontier(index);
  // A4: the authority facts are printed as provenance, never as a gate, permission or finding.
  const authority = projection.authority, roles = authority.roles;
  const cases = caseViews(index, context.cases ?? {}), plans: CoveragePlanView[] = context.coverage ? coverageViews(index, context.coverage) : [];
  // M3: completion is derived here, from the same ledger the rest of the report is rendered from, so the report cannot claim a
  // state the situation line or the finish result would contradict. P16.1: goal proofs read the same case/coverage views
  // the report prints, so a stale case cannot settle a goal in one place and fail in the other.
  const claimHeads = claimHeadClaims(index), proof = { ...proofViews(cases, plans), claims: claimHeads };
  const completion = deriveCompletion({ plans: planFrontier(index), claims: claimHeads, tasks, cases: proof.cases, coverage: proof.coverage,
    // A6.2: the report reads the same debt report the finish result did, so the two cannot print different obligation counts.
    ...(meta.debt ? { debt: debtFor(meta.debt) } : {}) });
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
    `- Authority: planner target operations ${authority.plannerTargetOps} (must be 0); worker target operations ${authority.workerTargetOps}; tasks created ${authority.tasksCreated}, dispatched ${authority.tasksDispatched}${authority.firstDispatchAt ? ` (first dispatch ${mdText(authority.firstDispatchAt, 40)})` : ''}; claims owner ${authority.ownerClaims} (must be 0) / worker ${authority.workerClaims}; validation tasks ${authority.validationTasks}; stalled rounds ${authority.stalledRounds}; automatic wakes ${authority.heartbeatWakes + authority.debtWakes} (debt ${authority.debtWakes}, heartbeat ${authority.heartbeatWakes}); campaign partial stops ${authority.campaignPartial}; human resumes ${authority.campaignResumes}; stall escalations ${authority.stallEscalations}`,
    `- Mode and role matrix: ${authority.mode ? `${mdText(authority.mode.loopMode ?? 'unknown', 24)} loop / ${mdText(authority.mode.executorMode ?? 'unknown', 24)} executor` : 'mode not recorded in this snapshot'}; planner ${roles.planner} tools (no target or claim tool), worker ${roles.worker}, validation ${roles.validation}, reporter ${roles.reporter} (read-only)`,
    ...(() => {
      // A7.7: the policy the run was started with (operator settings, never model text) and what it decided, by rule.
      const audit = policyAudit(index.records);
      if (!audit) return [];
      const decide = (action: 'deny' | 'ask' | 'allow') => {
        const rows = audit.decisions.filter(row => row.action === action);
        return rows.length ? `${action} ${rows.reduce((sum, row) => sum + row.count, 0)} (${rows.slice(0, 6).map(row => `${mdText(row.ruleId, 64)} ${row.count}`).join(', ')}${rows.length > 6 ? ', …' : ''})` : `${action} 0`;
      };
      return [`- Command policy: ${audit.operatorRules} operator rule(s), ${audit.enabledSeeds.length} seeded deny rule(s) enabled${audit.disabledSeeds.length ? `, disabled seeds: ${audit.disabledSeeds.map(id => mdText(id, 80)).join(', ')}` : ''}. Decisions: ${decide('deny')}, ${decide('ask')}, ${decide('allow')}. Allows are counted by rule in a digest record; every receipt already carries its own command text, and a deny or ask has its own record.`];
    })(),
    ...operatorBrief(index),
    `- Runtime that wrote this run: p2o ${mdText(meta.runtime.version || 'unknown version', 40)} · closure digest ${mdText(meta.runtime.hash.slice(0, 12), 16)}`,
    `- Reconciliation: ${meta.complete && projection.complete ? 'complete bounded record scan' : '**INCOMPLETE** — no completeness claim'}${projection.diagnostics.length ? `; diagnostics: ${projection.diagnostics.slice(0, 10).map(item => mdText(item, 200)).join('; ')}` : ''}`,
    ...(() => {
      const stored = typeof meta.outcome?.assessmentOutcome === 'string' ? meta.outcome.assessmentOutcome : undefined;
      const storedReason = typeof meta.outcome?.reason === 'string' ? meta.outcome.reason : undefined;
      const assessed = stored === 'complete' || stored === 'incomplete' ? stored : undefined;
      const mismatch = assessed !== undefined && assessed !== completion.state;
      return [`- Derived completion: **${completion.state}** — ${completion.remaining} obligation(s)${stored ? `; stored outcome: **${mdText(stored, 40)}**${storedReason ? ` (${mdText(storedReason, 80)})` : ''}${mismatch ? ' — **MISMATCH**: the stored completion differs from the derived completion; the stored value is not rewritten by this report.' : ''}` : ''}`];
    })(),
    `- Views below are bounded (${ROWS} rows per list, ${CASE_ROWS} cases); omitted rows are counted and the complete data is in the portable bundle (\`/p2o export\`).`,
    ...(v2 ? [`- Records: first at ${mdText(index.records[0]?.at ?? 'n/a', 40)}, last at ${mdText(index.records.at(-1)?.at ?? 'n/a', 40)} (timestamps as stored; this report reads no clock)`,
      ...(meta.operator ? (['author', 'organization', 'team', 'classification'] as const).filter(name => meta.operator![name]).map(name => `- ${severityLabel(name)} (operator-supplied, unverified): ${mdText(meta.operator![name], 200)}`) : [])] : []),
    ...(v2 && meta.campaign ? campaignSection(meta.campaign) : []),
    // A7.6/Q18: derived from the same committed state as the findings above; assess mode prints one line instead of a ladder.
    ...(v2 ? ladderSection(accessLadder(index, cases, meta), meta.ladderFacts) : []),
    ...(v2 ? scopeAndSummary(meta, index, plans, cells, notClean, accepted, rated, unrated, others, open.length, awaiting.length, cases) : []),
    ...(v2 && meta.prior ? priorSection(meta.prior, meta.runId) : []),
    '## Summary', '', '| Item | Count |', '|---|---|',
    `| Accepted current cases | ${accepted.length} |`, `| Cases pending, disputed, stale, withdrawn or duplicate | ${others.length} |`,
    `| Coverage cells (all plans) | ${cells.length} |`, `| Cells not tested or not confirmed (listed first below) | ${notClean.length} |`,
    `| Open gaps | ${open.length} |`, `| Worker claims | ${projection.counts.candidates} |`, `| Worker handoffs | ${projection.counts.reports} |`,
    `| Tasks awaiting owner review | ${awaiting.length} |`, `| Tasks by status | ${Object.entries(status).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${mdText(name, 24)} ${count}`).join(', ') || 'none'} |`, '');

  // R1.6: the recorded surface, printed only when the caller resolved it (a store with no graph read keeps the old report).
  // An inventory is a scope statement: it is not a test, not a finding, and its rows are a sample when the total is larger.
  if (context.inventory) {
    const inventory = context.inventory;
    out.push('## Asset inventory — the surface as recorded', '',
      `Current-scope assets: **${inventory.total}**. An asset is an address or object this run recorded; its presence is not a test, not a finding and not a statement about its safety.${inventory.total > inventory.rows.length ? ` The table lists the ${inventory.rows.length} most recently recorded, so it is a sample.` : ''}`, '');
    if (inventory.rows.length) {
      out.push('| Kind | Key | Label | Revision | Id |', '|---|---|---|---|---|');
      for (const row of inventory.rows) out.push(`| ${mdText(row.kind, 24)} | ${mdText(row.key, 80)} | ${row.label ? mdText(row.label, 60) : '—'} | r${row.revision} | ${mdText(row.id, 60)} |`);
      if (inventory.total > inventory.rows.length) out.push('', `… ${inventory.total - inventory.rows.length} more asset(s) in this scope; see the graph export.`);
    } else out.push('No asset is recorded in the current scope, so there is nothing to inventory. That is not a statement about the target.', '');
    out.push('');
  }

  out.push('## Coverage and gaps — read before the findings', '');
  if (!plans.length) out.push('No coverage plan was recorded. Without a denominator nothing can be called covered.', '');
  for (const plan of plans) {
    out.push(`### Plan ${mdText(plan.title, 160)} — ${mdText(plan.id, 80)} r${plan.revision} (${mdText(plan.status)})`,
      `- Cells ${plan.cells.length}; execution ${Object.entries(plan.counts.execution).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${mdText(name, 24)} ${count}`).join(', ') || 'none'}; assessment ${Object.entries(plan.counts.assessment).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${mdText(name, 24)} ${count}`).join(', ') || 'none'}; stale ${plan.counts.stale}; reviewed ${plan.counts.reviewed}`,
      `- Exclusions: ${list(plan.exclusions.map(item => mdText(item, 200)))}; unknown scope: ${list(plan.unknownScope.map(item => mdText(item, 200)))}; assets discovered but not in this plan: ${plan.discoveredUnplannedAssets}`);
    const listed = rows(notClean.filter(item => item.plan.id === plan.id), ROWS);
    if (listed.shown.length) {
      out.push('', '| Cell | Asset | Question | Actor / method | Execution | Assessment | Currentness |', '|---|---|---|---|---|---|---|');
      for (const { cell } of listed.shown) out.push(`| ${mdText(cell.id, 80)} | ${context.assets ? assetText(cell.assetRef, context.assets) : mdText(cell.assetRef.id, 80)} | ${mdText(cell.questionKey, 120)} | ${mdText(`${cell.actorContext} / ${cell.methodFamily}`, 160)} | ${mdText(cell.execution, 24)} | ${mdText(cell.effectiveAssessment, 24)} | ${mdText(cell.currentness, 24)}${cell.staleReasons.length ? ` (${mdText(cell.staleReasons.slice(0, 3).join('; '), 160)})` : ''} |`);
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
  else { const listed = rows(shownAccepted, CASE_ROWS); for (const [position, view] of listed.shown.entries()) out.push(caseSection(view, everyCell, index, pages, v2 ? position + 1 : undefined, context.assets), ''); if (listed.omitted) out.push(`… ${listed.omitted} more accepted cases; see cases.csv.`, ''); }

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
    for (const claim of claims.shown) out.push(`| ${mdText(claim.id, 80)} | ${mdText(claim.candidate, 160)} | ${mdText(`${claim.surface ?? ''} / ${claim.risk ?? ''}`, 160)} | ${mdText(claim.closure, 24)} | ${mdText(claim.execution, 24)} | ${mdText(claim.proof, 40)} | ${claim.replayable ? claim.replayUnits ? `host replay \`${mdText((claim.payloadRef ?? claim.replaySha256 ?? '').slice(0, 80), 80)}\`${claim.replayUnits > 1 ? ` (+${claim.replayUnits - 1} more units)` : ''}` : `payload \`${mdText(claim.payloadRef, 80)}\`` : 'not replayable'} | ${claim.independentCurrent === undefined ? 'not claimed' : claim.independentCurrent ? 'yes' : 'no'} |`);
    const warned = claims.shown.filter(claim => (claim.warnings ?? []).length);
    if (warned.length) out.push('', `Admission warnings: ${warned.slice(0, 6).map(claim => `\`${mdText(claim.candidate, 80)}\` — ${mdText(claim.warnings![0]!, 240)}`).join('; ')}.`);
    out.push('');
  }
  // P16.5: routes are a dimension of the report, so a single-route run is visible next to its advisory.
  const routes = routeCounts(planFrontier(index));
  if (routes.open.length || routes.done.length) {
    out.push('', '## ROUTES', '', 'Mechanism families the plan is trying. One open route is allowed; concentration should follow a demonstrated effect.', '');
    out.push('| Route | Open steps | Done steps |', '|---|---|---|');
    for (const route of [...new Set([...routes.open, ...routes.done])].sort()) out.push(`| ${mdText(route, 32)} | ${mdText(routes.open.includes(route) ? 'yes' : '', 4)} | ${mdText(routes.done.includes(route) ? 'yes' : '', 4)} |`);
  }
  // P16.4: a lead is printed with its provenance and state, never among findings: a published CVE is a pointer to test.
  // R2.5/R2.6: KEV then EPSS order the queue — context for triage that never changes the published severity — and the version
  // match is labelled as a suggestion, so "the range covers 2.5.0" cannot read as "this target is affected".
  const leads = leadFrontier(index);
  if (leads.length) {
    out.push('', '## LEADS', '', 'Published CVEs attached to observed versions. A lead is a pointer to test; it is never a finding, evidence or a confirmed claim. KEV/EPSS are exploitation context joined by CVE id, not proof about this target: their absence on a row means the feed did not answer, and the published severity is never re-rated here.', '');
    out.push('| Lead | Product | Version | CVE | Severity | Affected | Version match | KEV | EPSS | Source | State |', '|---|---|---|---|---|---|---|---|---|---|---|');
    const kevRank = (lead: (typeof leads)[number]) => lead.exploitability?.kev === true ? 2 : lead.exploitability?.kev === false ? 1 : 0;
    const epssScore = (lead: (typeof leads)[number]) => typeof lead.exploitability?.epss === 'number' ? lead.exploitability.epss : -1;
    const ordered = [...leads].sort((left, right) => kevRank(right) - kevRank(left) || epssScore(right) - epssScore(left) || left.cve.localeCompare(right.cve) || left.id.localeCompare(right.id));
    const shown = rows(ordered, ROWS);
    const kevText = (lead: (typeof leads)[number]) => lead.exploitability === undefined || lead.exploitability.kev === 'unknown' ? 'unknown' : lead.exploitability.kev ? 'listed' : 'not listed';
    const epssText = (lead: (typeof leads)[number]) => typeof lead.exploitability?.epss === 'number'
      ? `${lead.exploitability.epss.toFixed(3)}${lead.exploitability.percentile === undefined ? '' : ` (p${(lead.exploitability.percentile * 100).toFixed(1)})`}` : 'unknown';
    const matchText = (lead: (typeof leads)[number]) => lead.versionMatch === undefined ? 'not compared' : lead.versionMatch === 'in-range' ? 'suggestion: in range' : lead.versionMatch === 'out-of-range' ? 'suggestion: out of range' : 'unparsed';
    for (const lead of shown.shown) out.push(`| ${mdText(lead.id, 80)} | ${mdText(lead.product, 120)} | ${mdText(lead.version ?? '', 80)} | ${mdText(lead.cve, 24)} | ${mdText(lead.severity, 16)} | ${mdText(lead.affected, 200)} | ${matchText(lead)} | ${kevText(lead)} | ${epssText(lead)} | ${mdText(`${lead.source.url} sha256=${lead.source.sha256}`, 240)} | ${mdText(lead.state, 24)} |`);
    if (shown.omitted) out.push(`| … ${shown.omitted} more lead(s) | | | | | | | | | | |`);
  }
  out.push('## Tasks and handoffs', '', `- Awaiting owner review: ${awaiting.length ? ids(awaiting.map(task => task.id), 20) : 'none'}`);
  const handoffs = rows(projection.reports, ROWS);
  for (const report of handoffs.shown) out.push(`- Handoff ${mdText(report.id, 80)} from ${mdText(report.workerId ?? 'unknown', 80)}: outcome ${mdText(report.outcome ?? 'unknown', 40)}, confidence ${mdText(report.confidence ?? 'unknown', 24)}, ${report.findings} claimed finding(s), ${report.openItems} open item(s)${report.blocked ? `, blocked: ${mdText(report.blocked, 200)}` : ''}${report.workerId && meta.wrote?.get(report.workerId) ? `; ${mdText(writeBackLine(meta.wrote.get(report.workerId)!), 200)}` : ''}`);
  if (handoffs.omitted) out.push(`- … ${handoffs.omitted} more handoffs`);
  if (v2) {
    // A6.2/A6.6: debt is printed before the obligation list it feeds, so the reader sees why the completion says incomplete.
    if (meta.debt && (meta.debt.total || meta.debt.discharged)) out.push('', ...debtSection(meta.debt));
    // M3: the obligation list is a report fact. Exporting writes it; it never refuses the export and never claims the run is done.
    out.push('', '## REMAINING WORK', '', 'Derived at export from committed state, not from a claim of completion. Obligations are unfinished review, coverage or chain items; advisories are hints. Neither is a finding and neither is a safety statement.', '',
      `- Completion: **${completion.state}** — ${completion.remaining} obligation(s). ${completionLine(completion)}`);
    if (completion.items.length) {
      out.push('', '| Code | Count | Examples | Meaning |', '|---|---|---|---|');
      for (const item of completion.items) out.push(`| ${item.code} | ${item.count} | ${ids(item.ids, 5)} | ${mdText(item.message, 160)} |`);
    }
    // P19/E: a goal settled blocked is settled-with-debt; print the debt instead of leaving it to the reader to infer.
    if (completion.settledBlocked.length) out.push('', `- Settled with debt: ${completion.settledBlocked.map(item => `**${mdText(item.id, 80)}** — ${mdText(item.reason, 400)}`).join('; ')}.`);
    // P16.1: the proof each goal promised to show, and whether it holds, so a reader can tell a status from a demonstration.
    const goals = planFrontier(index).filter(entry => entry.kind === 'goal');
    if (goals.length) {
      out.push('', '| Goal | Status | Proof | Settled |', '|---|---|---|---|');
      for (const goal of goals) {
        const refusal = goal.proof ? goalProofRefusal(goal.proof, proof) : 'GOAL_UNPROVEN: no proof is recorded';
        const settled = goal.status === 'blocked' ? `settled with debt — ${mdText(goal.reason, 240)}` : refusal ? `no — ${mdText(refusal, 200)}` : 'yes';
        out.push(`| ${mdText(goal.id, 80)} ${mdText(goal.title, 160)} | ${mdText(goal.status, 24)} | ${goal.proof ? mdText(proofLabel(goal.proof), 120) : 'none'} | ${settled} |`);
      }
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

  const caseCsv = [csvRow(['case_id', 'revision', 'title', 'verdict', 'review_status', 'currentness', 'accepted_current', 'duplicate_of', 'independent_current', 'independence_reason', 'policy_key', 'claims', 'independent_evidence', 'stale_reasons', 'limitations']),
    ...rows(cases, 5000).shown.map(view => csvRow([view.id, view.revision, view.title, view.verdict, view.reviewStatus, view.currentness, view.acceptedFinding, view.duplicateOf ?? '', view.independentCurrent, view.independenceReason ?? '', view.policyKey, view.claimRefs.join(' '), view.independentEvidenceRefs.join(' '), view.staleReasons.join('; '), view.limitations]))];
  const coverageCsv = [csvRow(['plan_id', 'plan_revision', 'cell_id', 'asset_id', 'question_key', 'policy_key', 'actor_context', 'tenant_context', 'method_family', 'execution', 'assessment', 'effective_assessment', 'currentness', 'stale_reasons', 'reason', 'limitations']),
    ...rows(cells, 20000).shown.map(({ plan, cell }) => csvRow([plan.id, plan.revision, cell.id, cell.assetRef.id, cell.questionKey, cell.policyKey ?? '', cell.actorContext, cell.tenantContext, cell.methodFamily, cell.execution, cell.assessment, cell.effectiveAssessment, cell.currentness, cell.staleReasons.join('; '), cell.reason, cell.limitations]))];
  const files: ReportFile[] = [{ name: 'REPORT.md', body: `${out.join('\n')}\n` }, { name: 'cases.csv', body: `${caseCsv.join('\n')}\n` }, { name: 'coverage.csv', body: `${coverageCsv.join('\n')}\n` }];
  const orderedAccepted = orderedFindings(accepted);
  if (v2) files.push(...findingFiles(meta, index, orderedAccepted, everyCell, pages, context.assets));
  // R3.7/R3.8: the SARIF log always travels with a v2 report; the STIX bundle is opt-in only, because a STIX consumer needs an
  // explicit decision and the default bundle must not change shape. Both are pure functions of the same committed state.
  if (v2) {
    const interop = interopInput(meta, index, orderedAccepted, everyCell, context.assets);
    files.push({ name: 'findings.sarif', body: `${JSON.stringify(sarifLog(interop), null, 2)}\n` });
    if (meta.stix) files.push({ name: 'findings.stix.json', body: `${JSON.stringify(stixBundle(interop), null, 2)}\n` });
    if (meta.prior) files.push({ name: 'prior-knowledge.json', body: `${JSON.stringify({ format: 'p2o-prior-knowledge', version: 1, schema: meta.prior.schema,
      scope: { tenant: meta.prior.tenant, target: meta.prior.target }, suggestedOnly: true, note: meta.prior.note, conflicts: meta.prior.conflicts, staleRows: meta.prior.staleRows,
      rows: [...meta.prior.findings, ...meta.prior.assets] }, null, 2)}\n` });
    files.push(...wstgChecklistFile(everyCell, cases, pages));
  }
  const manifest = { format: 'p2o-report', version, runId: meta.runId, asOfSequence: meta.asOfSequence, records: index.records.length, historical: meta.historical, complete: meta.complete && projection.complete,
    ...(v2 ? { endReason: meta.endReason ?? null } : {}),
    ...(v2 ? { kind: meta.kind ?? null, completion: completion.state, remaining: completion.remaining, outcome: meta.outcome ?? null } : {}),
    runtime: meta.runtime, counts: { acceptedCurrent: accepted.length, cases: cases.length, coverageCells: cells.length, openGaps: open.length, claims: projection.counts.candidates, ...(v2 ? { unrated: unrated.length } : {}) },
    files: files.map(file => ({ name: file.name, bytes: Buffer.byteLength(file.body), sha256: sha256Hex(file.body) })), authorityRestored: false,
    warning: 'Deterministic index of attributed committed state; not a verification or a safety statement. Redaction is best effort.' };
  files.push({ name: 'report-manifest.json', body: `${JSON.stringify(manifest, null, 2)}\n` });
  return { files, counts: manifest.counts as RenderedReport['counts'] };
}
