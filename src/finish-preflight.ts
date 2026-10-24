import { isConfirmedClaim } from './claims.js';
import { caseViews, needsCaseReview, type CaseContext } from './cases.js';
import { coverageViews, type CoverageContext } from './coverage.js';
import { chainObligations } from './obligations.js';
import { claimHeadClaims } from './chain-view.js';
import { isOpenGap, type AssessmentRecord, type LedgerIndex } from './records.js';
import { planFrontier } from './planning.js';
import { awaitingReview, taskFrontier } from './tasks.js';
import { sha256Hex } from './validate.js';
import { WSTG_MAP, isWstgKey, wstgKey } from './wstg-map.js';
import type { WorkerWrites } from './write-back.js';
import { leadFrontier } from './cve.js';
import { routeMonoculture } from './routes.js';

/**
 * Deterministic pre-finish check over committed state. Pure: no model, no clock, no target access, no write. It names unfinished
 * owner work (unreviewed tasks and claims, pending or stale cases, an absent or unfinished coverage denominator); it never decides
 * that the target is safe and it never changes a task, case or cell. It only informs the report: p2o has no finish gate.
 * asks the lead to look once more before finishing (`confirm`).
 */
export type PreflightCode = 'UNREVIEWED_TASK' | 'UNREVIEWED_CLAIM' | 'PENDING_CASE' | 'STALE_CASE' | 'STALE_CELL' | 'NO_COVERAGE_PLAN' | 'NONTERMINAL_CELLS'
  | 'UNRATED_ACCEPTED_CASE' | 'WSTG_APPLICABLE_UNPLANNED' | 'HIGH_WITHOUT_INDEPENDENCE' | 'FOREIGN_EVIDENCE' | 'CONTRACT_GAP' | 'STALE_RATING' | 'OPEN_GAP_UNREFERENCED' | 'ORPHAN_TASK' | 'UNPLANNED_ASSETS'
  | 'UNPROMOTED_COVERAGE_NOTE' | 'NO_GOAL_RECORDED' | 'NEGATIVE_MAY_BE_BLOCKED' | 'INTERRUPTED_CELL' | 'PRIMITIVE_UNCHAINED' | 'ADMISSION_REFUSALS' | 'NO_GRAPH_WRITE' | 'LEAD_UNTRIAGED' | 'ROUTE_MONOCULTURE';
export interface PreflightItem { code: PreflightCode; level: 'obligation' | 'advisory'; count: number; ids: string[]; message: string }
export interface FinishPreflight {
  /** M3: the former `blocking` list. It is a report fact now, not a refusal predicate: nothing refuses a finish. */
  obligations: PreflightItem[]; advisory: PreflightItem[];
  /** Stable digest of the obligation set, so a reader can tell a re-export from new work arriving. */
  signature: string;
  complete: boolean;
}
export interface PreflightContext {
  cases?: CaseContext; coverage?: CoverageContext; integrity?: 'off' | 'annotate' | 'enforce'; statedObjective?: string;
  /** P16.8: host-computed write-back counts; a worker with zero writes and no `no-new` note is an advisory, never a refusal. */
  wrote?: readonly WorkerWrites[];
}

const SHOWN = 5;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const MESSAGES: Record<PreflightCode, string> = {
  UNREVIEWED_TASK: 'worker handoff not reviewed (review the task with its receipts, or cancel it)',
  UNREVIEWED_CLAIM: 'confirmed worker claim without any owner case (open a case or record why not)',
  PENDING_CASE: 'case still pending or disputed (accept, dispute with a reason, or withdraw)',
  STALE_CASE: 'case went stale after its pinned claim, task or asset changed (revise or withdraw)',
  STALE_CELL: 'coverage cell went stale (revise or retire it)',
  NO_COVERAGE_PLAN: 'no coverage plan: without a denominator nothing can be called covered (state what was not examined)',
  NONTERMINAL_CELLS: 'coverage cell planned, running or attempted but never tested or blocked (finish it or mark blocked with a gap)',
  UNRATED_ACCEPTED_CASE: 'accepted case has no severity rating (rate it so the report can rank it)',
  WSTG_APPLICABLE_UNPLANNED: 'WSTG test that applies to every target has no coverage cell although this run addresses WSTG tests (add a cell, or retire the plan’s claim to follow the guide)',
  HIGH_WITHOUT_INDEPENDENCE: 'High or Critical finding with no current independent validation and no recorded waiver (validate it separately, or record why not)',
  FOREIGN_EVIDENCE: 'task reviewed on receipts its assignee did not author (cite the assignee’s own receipts, or acknowledge external evidence)',
  CONTRACT_GAP: 'task reviewed although the assignee left a required output field empty (check the handoff before relying on it)',
  STALE_RATING: 'rating recorded against an older case revision (re-rate if the change affects it)',
  OPEN_GAP_UNREFERENCED: 'open gap that no coverage cell or case refers to (it will show only as a bare gap)',
  ORPHAN_TASK: 'task blocked or expired without a handoff (re-plan it or record the limit)',
  UNPLANNED_ASSETS: 'asset discovered but absent from every coverage plan (add a cell or list it as out of scope)',
  UNPROMOTED_COVERAGE_NOTE: 'surface/coverage note recorded but the plan still has no cell (free-text observation never became a counted denominator entry)',
  NEGATIVE_MAY_BE_BLOCKED: 'a ruled-out result rests only on HTTP receipts that ended in 401, 403 or 429, or never got a response (that may be an access control or rate limit, not proof the weakness is absent; add a control that reached the code under test)',
  NO_GOAL_RECORDED: 'the run was given an operator objective but no goal was ever recorded in the plan (the objective did not become a tracked goal)',
  INTERRUPTED_CELL: 'coverage cell cites a task that ended without a verdict, so it stays attempted and its assessment open_gap (re-dispatch it, or retire it with the reason)',
  PRIMITIVE_UNCHAINED: 'a confirmed and tested claim has no successor step and no recorded wall (M4: take it further or record which successors were ruled out and why)',
  ADMISSION_REFUSALS: 'a task create was refused and recorded (the admission tax is visible here instead of only in the transcript)',
  NO_GRAPH_WRITE: 'worker wrote no asset, fact, evidence or finding and left no no-new note (the graph is how a finding becomes reusable; a surface that added nothing says so with one note)',
  LEAD_UNTRIAGED: 'CVE lead recorded but never triaged (task it, execute it, or mark it ruled_out with the reason; a published CVE is a pointer, not a finding)',
  ROUTE_MONOCULTURE: 'every open chain step tries the same mechanism family although the recorded capabilities make another family plausible (spread one route there, or record why it is ruled out; concentration is fine once a route showed an effect)',
};
const OPEN_OBLIGATION: ReadonlySet<PreflightCode> = new Set<PreflightCode>(['UNREVIEWED_TASK', 'UNREVIEWED_CLAIM', 'PENDING_CASE', 'STALE_CASE', 'STALE_CELL', 'NO_COVERAGE_PLAN', 'NONTERMINAL_CELLS', 'UNRATED_ACCEPTED_CASE']);

const BLOCKED_STATUS: ReadonlySet<number> = new Set([401, 403, 429]);
/**
 * True for a p2o_http receipt whose final response was 401, 403 or 429, or that never produced a response (transport error). Everything else is unknown, never
 * blocked: shell and network receipts carry no structured status, 2xx and 404 are answers, and a hop list at its cap of 6 hides the final response.
 */
export function receiptLooksBlocked(record: AssessmentRecord | undefined): boolean {
  const data = record?.data;
  if (!record || record.kind !== 'evidence' || !data || data.operation !== 'http') return false;
  const raw = (data.http as { hops?: unknown } | undefined)?.hops, hops = Array.isArray(raw) ? raw.filter((hop): hop is string => typeof hop === 'string') : [];
  if (hops.length >= 6) return false;
  const status = hops.length ? /^(\d{3})\s/.exec(hops[hops.length - 1])?.[1] : undefined;
  if (status) return BLOCKED_STATUS.has(Number(status));
  return typeof data.exitCode === 'number' && data.exitCode !== 0;
}
/** Ruled-out items whose every cited receipt looks blocked. An item that cites nothing, or any receipt that is not an HTTP block, is left alone. */
export function blockedNegatives(items: ReadonlyArray<{ id: string; refs: readonly string[] }>, byId: ReadonlyMap<string, AssessmentRecord>): string[] {
  return items.filter(item => item.refs.length > 0 && item.refs.every(ref => receiptLooksBlocked(byId.get(ref)))).map(item => item.id);
}

export function finishPreflight(index: LedgerIndex, context: PreflightContext = {}): FinishPreflight {
  const tasks = taskFrontier(index), cases = caseViews(index, context.cases ?? {});
  const plans = context.coverage ? coverageViews(index, context.coverage) : [];
  const cells = plans.flatMap(plan => plan.cells).filter(cell => cell.currentness !== 'retired');
  const replaced = new Set(index.records.flatMap(row => row.supersedes ? [row.supersedes] : [])), retired = new Set([...replaced, ...index.records.flatMap(row => row.resolves ?? [])]);
  const cited = new Set(cases.flatMap(view => view.claimRefs));
  const found = new Map<PreflightCode, string[]>();
  const add = (code: PreflightCode, id: string) => { const list = found.get(code) ?? []; list.push(id); found.set(code, list); };

  for (const task of tasks) {
    if (awaitingReview(task)) add('UNREVIEWED_TASK', task.id);
    else if (task.status === 'expired' || (task.status === 'blocked' && !task.handoffId)) add('ORPHAN_TASK', task.id);
  }
  for (const row of index.records) if (row.kind === 'candidate' && row.id && !replaced.has(row.id) && isConfirmedClaim(row.data ?? {}) && !cited.has(row.id)) add('UNREVIEWED_CLAIM', row.id);
  for (const view of cases) {
    if (needsCaseReview(view)) add('PENDING_CASE', view.id);
    else if (view.currentness === 'stale' && view.reviewStatus !== 'withdrawn') add('STALE_CASE', view.id);
  }
  if (!plans.length) add('NO_COVERAGE_PLAN', 'no-plan');
  // M6: every refused create left a lifecycle record, so the cost of the rules is a number a reader can see.
  for (const row of index.records) if (row.kind === 'lifecycle' && typeof row.text === 'string' && row.text.startsWith('admission refused') && row.id) add('ADMISSION_REFUSALS', row.id);
  // M4: the depth obligation, listed rather than enforced — a finish is not a gate, but the report and Phase E completion read this.
  for (const primitive of chainObligations({ plans: planFrontier(index), claims: claimHeadClaims(index), tasks: taskFrontier(index) }).unchained) add('PRIMITIVE_UNCHAINED', primitive.recordId);
  for (const cell of cells) {
    // M5: a cell downgraded by an interrupted task is named separately from generic staleness, because the next action differs:
    // re-dispatch the same question rather than re-establish the evidence.
    if (cell.staleReasons.some(reason => reason.startsWith('interrupted-task:'))) add('INTERRUPTED_CELL', cell.id);
    else if (cell.currentness === 'stale') add('STALE_CELL', cell.id);
    else if (['unplanned', 'planned', 'running', 'attempted'].includes(cell.effectiveExecution)) add('NONTERMINAL_CELLS', cell.id);
  }
  const referenced = new Set([...cells.flatMap(cell => [...cell.gapRefs, ...cell.claimRefs]), ...cases.flatMap(view => view.contradictions.map(item => item.evidenceRef))]);
  for (const row of index.records) {
    if (row.id && isOpenGap(row, retired) && !referenced.has(row.id) && !cited.has(row.id)) add('OPEN_GAP_UNREFERENCED', row.id);
  }
  const wstgCells = cells.filter(cell => isWstgKey(cell.questionKey));
  if (wstgCells.length) { // only for runs that address WSTG tests; the always-applicable tests are the part of the guide no recon feature can switch off
    const covered = new Set(wstgCells.map(cell => cell.questionKey));
    for (const test of WSTG_MAP) if (test.trigger.includes('any') && !covered.has(wstgKey(test.id))) add('WSTG_APPLICABLE_UNPLANNED', wstgKey(test.id));
  }
  const unplanned = Math.max(0, ...plans.map(plan => plan.discoveredUnplannedAssets));
  if (unplanned > 0) add('UNPLANNED_ASSETS', `${unplanned} asset(s)`);
  // Free-text surface/coverage notes and the structured CoverageBoard live in disjoint identifier spaces (asset hashes vs.
  // free text), so this cannot match individual entries; it only catches the coarse case the report actually depends on:
  // recon activity was recorded but never became even one counted denominator cell.
  if (plans.length && !cells.length) for (const row of index.records) if (row.id && (row.kind === 'coverage' || row.kind === 'surface')) add('UNPROMOTED_COVERAGE_NOTE', row.id);
  if (context.statedObjective && !planFrontier(index).some(plan => plan.kind === 'goal')) add('NO_GOAL_RECORDED', 'no-goal');
  for (const view of cases) {
    if (view.acceptedFinding && view.finding === undefined) add('UNRATED_ACCEPTED_CASE', view.id);
    else if (view.acceptedFinding && view.ratingCurrent === false) add('STALE_RATING', view.id);
    if (view.acceptedFinding && view.finding && ['critical', 'high'].includes(view.finding.severity) && !view.independentCurrent && !view.finding.independenceWaiver) add('HIGH_WITHOUT_INDEPENDENCE', view.id);
  }
  if (context.integrity !== 'off') {
    const ruledOut = [
      ...index.records.filter(row => row.kind === 'candidate' && row.id && !replaced.has(row.id) && row.data?.closure === 'ruled_out')
        .map(row => ({ id: row.id!, refs: [...strings(row.data?.negativeControls), ...strings(row.data?.evidenceRefs)] })),
      ...cells.filter(cell => cell.assessment === 'ruled_out_bounded').map(cell => ({ id: cell.id, refs: [...cell.negativeControlRefs, ...cell.evidenceRefs] })),
    ];
    for (const id of blockedNegatives(ruledOut, index.byId)) add('NEGATIVE_MAY_BE_BLOCKED', id);
  }
  if (context.integrity !== 'off') for (const task of tasks) {
    if (!['reviewed', 'closed'].includes(task.status) || !task.reviewIntegrity) continue;
    if (task.reviewIntegrity.foreignEvidence.length && !task.reviewIntegrity.externalAcknowledged) add('FOREIGN_EVIDENCE', task.id);
    if (task.reviewIntegrity.contractGap.length) add('CONTRACT_GAP', task.id);
  }

  // P16.5: one open route with a plausible alternative is an advisory, never a refusal — the model judges plausibility.
  const monoculture = routeMonoculture(planFrontier(index), claimHeadClaims(index));
  if (monoculture) add('ROUTE_MONOCULTURE', monoculture.route);
  // P16.4: a lead that nobody triaged is unfinished reading, not a finding and not a gate.
  for (const lead of leadFrontier(index)) if (lead.state === 'untriaged') add('LEAD_UNTRIAGED', lead.id);
  // P16.3/P16.8: the host counts what each worker persisted. Zero writes is printed for the lead and the human; it never
  // refuses a review, because "learned nothing" is a legitimate result that deserves a note, not a gate.
  for (const writes of context.wrote ?? []) if (writes.assets + writes.facts + writes.evidence + writes.findings === 0 && !writes.noNew) add('NO_GRAPH_WRITE', writes.workerId);
  const blocks = (code: PreflightCode) => OPEN_OBLIGATION.has(code) || (code === 'HIGH_WITHOUT_INDEPENDENCE' && context.integrity === 'enforce');
  const items = [...found.entries()].map(([code, ids]): PreflightItem => ({ code, level: blocks(code) ? 'obligation' : 'advisory', count: ids.length, ids: ids.slice(0, SHOWN), message: MESSAGES[code] }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const obligations = items.filter(item => item.level === 'obligation'), advisory = items.filter(item => item.level === 'advisory');
  return { obligations, advisory, signature: sha256Hex(obligations.map(item => `${item.code}:${item.count}`).join('|')).slice(0, 16), complete: index.complete };
}

/** Block appended to the finish result. Terse by design: at most one line per code, at most five IDs per line. It reports, it never refuses. */
export function renderPreflight(result: FinishPreflight): string {
  const line = (item: PreflightItem) => `- ${item.code} (${item.count}): ${item.ids.join(', ')}${item.count > item.ids.length ? ', …' : ''} — ${item.message}`;
  if (!result.obligations.length && !result.advisory.length) return `FINISH PREFLIGHT (host check): nothing unfinished found in committed state. This is not a statement that the target is safe.`;
  return [`FINISH PREFLIGHT (host check): ${result.obligations.length} open obligation(s), ${result.advisory.length} advisory. These are unfinished review or coverage items, not findings and not a safety verdict. List any that remain in your report.`,
    ...result.obligations.map(line), ...result.advisory.map(line), ...(result.complete ? [] : ['- INCOMPLETE ledger scan: no completeness claim.'])].join('\n');
}
