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
import { debtDischarge, OBLIGATION_KINDS, type DebtKind, type DebtReport } from './debt.js';

/**
 * Deterministic pre-finish check over committed state. Pure: no model, no clock, no target access, no write. It names unfinished
 * owner work (unreviewed tasks and claims, pending or stale cases, an absent or unfinished coverage denominator); it never decides
 * that the target is safe and it never changes a task, case or cell. It only informs the report: p2o has no finish gate.
 * asks the lead to look once more before finishing (`confirm`).
 */
export type PreflightCode = 'UNREVIEWED_TASK' | 'UNREVIEWED_CLAIM' | 'PENDING_CASE' | 'STALE_CASE' | 'STALE_CELL' | 'NO_COVERAGE_PLAN' | 'NONTERMINAL_CELLS'
  | 'UNRATED_ACCEPTED_CASE' | 'WSTG_APPLICABLE_UNPLANNED' | 'HIGH_WITHOUT_INDEPENDENCE' | 'FOREIGN_EVIDENCE' | 'CONTRACT_GAP' | 'STALE_RATING' | 'OPEN_GAP_UNREFERENCED' | 'ORPHAN_TASK' | 'UNPLANNED_ASSETS'
  | 'UNPROMOTED_COVERAGE_NOTE' | 'UNMAPPED_TASK' | 'NO_GOAL_RECORDED' | 'NEGATIVE_MAY_BE_BLOCKED' | 'INTERRUPTED_CELL' | 'PRIMITIVE_UNCHAINED' | 'ADMISSION_REFUSALS' | 'NO_GRAPH_WRITE' | 'LEAD_UNTRIAGED' | 'ROUTE_MONOCULTURE' | 'RESEARCH_DEBT'
  | 'HELD_WITHOUT_SUCCESSOR' | 'IMPACT_UNATTEMPTED';
export interface PreflightItem { code: PreflightCode; level: 'obligation' | 'advisory'; count: number; ids: string[]; message: string }
/** P21/C4: one owed research-debt kind with the disposition a settlement record has to give it before the run stops. */
export interface SettlementItem { kind: DebtKind; count: number; ids: string[]; disposition: string }
export interface FinishPreflight {
  /** M3: the former `blocking` list. It is a report fact now, not a refusal predicate: nothing refuses a finish. */
  obligations: PreflightItem[]; advisory: PreflightItem[];
  /** P21/C4: the gateable debt kinds still outstanding, each with its discharge. Empty when the run owes no gateable kind. */
  settlement: SettlementItem[];
  /** Stable digest of the obligation set, so a reader can tell a re-export from new work arriving. */
  signature: string;
  complete: boolean;
}
export interface PreflightContext {
  cases?: CaseContext; coverage?: CoverageContext; integrity?: 'off' | 'annotate' | 'enforce'; statedObjective?: string;
  /** P16.8: host-computed write-back counts; a worker with zero writes and no `no-new` note is an advisory, never a refusal. */
  wrote?: readonly WorkerWrites[];
  /** A6.2: the same derived report completion counts; listed here so the two checks name the same work. */
  debt?: DebtReport;
  /** A7.5/D19: workers still holding a ticket, pane and session for one successor when the run ends without dispatching it. */
  heldWorkers?: readonly { workerId: string; brief?: string }[];
  /** A17.2/D32: the engagement mode the operator confirmed, so the impact-attempt advisory only fires for a run that wanted effects. */
  engagement?: 'assess' | 'exploit';
}

const SHOWN = 20;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const MESSAGES: Record<PreflightCode, string> = {
  UNREVIEWED_TASK: 'worker handoff not reviewed (review the task with its receipts, or cancel it)',
  UNREVIEWED_CLAIM: 'confirmed worker claim without any owner case (open a case or record why not)',
  PENDING_CASE: 'case still pending or disputed (accept, dispute with a reason, or withdraw)',
  STALE_CASE: 'case went stale after its pinned claim, task or asset changed (revise or withdraw)',
  STALE_CELL: 'coverage cell went stale: the host derives cells from reviewed work, so revise or re-review the task/claim it projects from, or record why it cannot be refreshed',
  NO_COVERAGE_PLAN: 'no coverage plan: without a denominator nothing can be called covered (state what was not examined)',
  NONTERMINAL_CELLS: 'coverage cell planned, running or attempted but never tested or blocked (the cell follows its reviewed task: finish or block that task; a cell has no model-facing writer)',
  UNRATED_ACCEPTED_CASE: 'accepted case has no severity rating (rate it so the report can rank it)',
  WSTG_APPLICABLE_UNPLANNED: 'WSTG test that applies to every target has no coverage cell although this run addresses WSTG tests (plan and review a task whose question key is the test id, or record why the guide is not followed)',
  HIGH_WITHOUT_INDEPENDENCE: 'High or Critical finding with no current independent validation and no recorded waiver (validate it separately, or record why not)',
  FOREIGN_EVIDENCE: 'task reviewed on receipts its assignee did not author (cite the assignee’s own receipts, or acknowledge external evidence)',
  CONTRACT_GAP: 'task reviewed although the assignee left a required output field empty (check the handoff before relying on it)',
  STALE_RATING: 'rating recorded against an older case revision (re-rate if the change affects it)',
  OPEN_GAP_UNREFERENCED: 'open gap that no coverage cell or case refers to (it will show only as a bare gap)',
  ORPHAN_TASK: 'task blocked or expired without a handoff (re-plan it or record the limit)',
  UNPLANNED_ASSETS: 'asset discovered but absent from every coverage plan (add a cell or list it as out of scope)',
  UNPROMOTED_COVERAGE_NOTE: 'surface/coverage note recorded but the plan still has no derived cell (no task work identity ever became a counted denominator entry)',
  UNMAPPED_TASK: 'task work identity names no asset reference, so the host reports it as an unmapped gap instead of a coverage cell (record the asset or narrow the task)',
  NEGATIVE_MAY_BE_BLOCKED: 'a ruled-out result rests only on HTTP receipts that ended in 401, 403 or 429, or never got a response (that may be an access control or rate limit, not proof the weakness is absent; add a control that reached the code under test)',
  NO_GOAL_RECORDED: 'the run was given an operator objective but no goal was ever recorded in the plan (the objective did not become a tracked goal)',
  INTERRUPTED_CELL: 'coverage cell cites a task that ended without a verdict, so it stays attempted and its assessment open_gap (re-dispatch the task, or record why the cell stays open; the cell itself is host-derived)',
  PRIMITIVE_UNCHAINED: 'a confirmed and tested claim has no successor step and no recorded wall (M4: take it further or record which successors were ruled out and why)',
  ADMISSION_REFUSALS: 'a task create was refused and recorded (the admission tax is visible here instead of only in the transcript)',
  NO_GRAPH_WRITE: 'worker wrote no asset, fact, evidence or finding and left no no-new note (the graph is how a finding becomes reusable; a surface that added nothing says so with one note)',
  LEAD_UNTRIAGED: 'CVE lead recorded but never triaged (task it, execute it, or mark it ruled_out with the reason; a published CVE is a pointer, not a finding)',
  ROUTE_MONOCULTURE: 'every open chain step tries the same mechanism family although the recorded capabilities make another family plausible (spread one route there, or record why it is ruled out; concentration is fine once a route showed an effect)',
  RESEARCH_DEBT: 'host-derived research debt still outstanding (aggregate: the specific codes above name the same work where they exist); a gap nobody referenced, a mapping that recorded nothing, an unplanned asset, an unrun cell or a demonstrated primitive with no successor (take it, wall it with a deferred/blocked todo, or say why it is out of scope)',
  HELD_WITHOUT_SUCCESSOR: 'worker reported with a hold but no successor was dispatched onto that ticket, pane and session (dispatch the successor or stop the worker so the hold is released, never leave it held)',
  IMPACT_UNATTEMPTED: 'exploit run holds an impact goal whose proof is a capability or an accepted case, and no exploitation or chaining intent was ever admitted (dispatch the ladder step the goal names, or record why the goal is deferred; the goal alone is not an attempt)',
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
  // A7.5/D19: a hold is a cheap reuse of state, not a parking spot; when the run ends the forgotten one is named.
  for (const held of context.heldWorkers ?? []) add('HELD_WITHOUT_SUCCESSOR', held.workerId);
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
  // A3: a task without a work asset cannot be placed in the denominator; it is a named gap, never a clean cell.
  for (const plan of plans) for (const item of plan.unmapped) add('UNMAPPED_TASK', item.taskId);
  const unplanned = Math.max(0, ...plans.map(plan => plan.discoveredUnplannedAssets));
  if (unplanned > 0) add('UNPLANNED_ASSETS', `${unplanned} asset(s)`);
  // Free-text surface/coverage notes and the structured CoverageBoard live in disjoint identifier spaces (asset hashes vs.
  // free text), so this cannot match individual entries; it only catches the coarse case the report actually depends on:
  // recon activity was recorded but never became even one counted denominator cell.
  if (plans.length && !cells.length) for (const row of index.records) if (row.id && (row.kind === 'coverage' || row.kind === 'surface')) add('UNPROMOTED_COVERAGE_NOTE', row.id);
  if (context.statedObjective && !planFrontier(index).some(plan => plan.kind === 'goal')) add('NO_GOAL_RECORDED', 'no-goal');
  // A17.2/D32: an exploit run that recorded an impact goal and never admitted a step toward it wanted an effect and attempted
  // none. Advisory only, like every other item here: it names the unspent goal, it never refuses the finish or calls the target
  // safe. The task test is against every task revision, because a withdrawn attempt is still an attempt that happened.
  if (context.engagement === 'exploit') {
    const goal = planFrontier(index).find(plan => plan.kind === 'goal' && (plan.proof?.kind === 'capability' || plan.proof?.kind === 'case'));
    const attempted = index.records.some(row => row.kind === 'task' && ['exploitation', 'chaining'].includes((row.data as { task?: { work?: { purpose?: string } } } | undefined)?.task?.work?.purpose ?? ''));
    if (goal && !attempted) add('IMPACT_UNATTEMPTED', goal.id);
  }
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
  // A6.2: one derived debt report feeds both the completion count and this list, so the two sentences cannot disagree.
  for (const id of context.debt?.gateableIds ?? []) add('RESEARCH_DEBT', id);
  // P16.3/P16.8: the host counts what each worker persisted. Zero writes is printed for the lead and the human; it never
  // refuses a review, because "learned nothing" is a legitimate result that deserves a note, not a gate.
  for (const writes of context.wrote ?? []) if (writes.assets + writes.facts + writes.evidence + writes.findings === 0 && !writes.noNew) add('NO_GRAPH_WRITE', writes.workerId);
  const blocks = (code: PreflightCode) => OPEN_OBLIGATION.has(code) || (code === 'HIGH_WITHOUT_INDEPENDENCE' && context.integrity === 'enforce');
  const items = [...found.entries()].map(([code, ids]): PreflightItem => ({ code, level: blocks(code) ? 'obligation' : 'advisory', count: ids.length, ids: ids.slice(0, SHOWN), message: MESSAGES[code] }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const obligations = items.filter(item => item.level === 'obligation'), advisory = items.filter(item => item.level === 'advisory');
  // P21/C4: the same debt report completion reads, turned into the settlement record a stopping lead has to give each kind.
  // It is a report fact like the items above: nothing here refuses a finish or loosens completion.
  const settlement: SettlementItem[] = context.debt ? OBLIGATION_KINDS.filter(kind => (context.debt!.totals[kind] ?? 0) > 0).map(kind => ({
    kind, count: context.debt!.totals[kind],
    ids: context.debt!.items.filter(item => item.kind === kind).map(item => item.id).slice(0, SHOWN),
    disposition: debtDischarge(kind) ?? 'plan a task, record it out of scope, or defer it with a revisit condition and the debt ids it answers',
  })) : [];
  return { obligations, advisory, settlement, signature: sha256Hex(obligations.map(item => `${item.code}:${item.count}`).join('|')).slice(0, 16), complete: index.complete };
}

/** The settlement packet the closing turn reads: one line per owed debt kind, or the explicit statement that no kind is owed. */
function settlementLines(result: FinishPreflight): string[] {
  if (!result.obligations.length) return [];
  const lines = ['SETTLEMENT PACKET (P21/C4): before stopping, give each outstanding kind a disposition — plan a task, record it out of scope, or defer it with a revisit condition and debtRefs. A decision row or prose does not discharge one.'];
  if (!result.settlement.length) lines.push('- no gateable research-debt kind is outstanding; the obligations above are review items.');
  for (const item of result.settlement) lines.push(`- ${item.kind} (${item.count}): ${item.ids.join(', ')}${item.count > item.ids.length ? ', …' : ''} — ${item.disposition}`);
  return lines;
}

/** Block appended to the finish result. Terse by design: at most one line per code, at most five IDs per line. It reports, it never refuses. */
export function renderPreflight(result: FinishPreflight): string {
  const line = (item: PreflightItem) => `- ${item.code} (${item.count}): ${item.ids.join(', ')}${item.count > item.ids.length ? ', …' : ''} — ${item.message}`;
  if (!result.obligations.length && !result.advisory.length) return `FINISH PREFLIGHT (host check): nothing unfinished found in committed state. This is not a statement that the target is safe.`;
  return [`FINISH PREFLIGHT (host check): ${result.obligations.length} open obligation(s), ${result.advisory.length} advisory. These are unfinished review or coverage items, not findings and not a safety verdict. List any that remain in your report.`,
    ...result.obligations.map(line), ...result.advisory.map(line), ...settlementLines(result), ...(result.complete ? [] : ['- INCOMPLETE ledger scan: no completeness claim.'])].join('\n');
}
