import type { AssessmentTask } from './tasks.js';
import type { CaseView } from './cases.js';
import type { CoveragePlanView } from './coverage.js';
import { chainJoin } from './chain-view.js';
import { chainBoard } from './chain-board.js';
import type { PlanEntry } from './planning.js';
import type { ClaimFields } from './claims.js';
import { isTestedCell } from './claims.js';
import { isExecutingTask, isSatisfiedTask, isSettledTask, terminalCounts } from './tasks.js';
import { purposeFromRole, type WorkPurpose } from './duties.js';
import { suggestPriority } from './priority.js';
import { routeCounts } from './routes.js';

/**
 * planning_update.md P3: the lead sees one computed line about the run instead of inferring the frontier from an empty list.
 * The snapshot is pure data so the counters can be tested without an engine, and every segment names the field it renders
 * (`SEGMENT_FIELDS`) so the renderer cannot invent a counter the snapshot does not produce.
 */
export interface SituationClaim extends ClaimFields { candidate?: string; closure: string }

export interface SituationSnapshot {
  /** Tasks that are not settled: proposed, reserved, running, reported, reviewed or blocked. */
  open: number;
  running: number;
  runningRoles: string[];
  /** Proposed tasks whose reviewed prerequisites are already satisfied, so a dispatch can start now. */
  ready: number;
  blocked: number;
  openContradictions: number;
  /** Open claims whose every need an existing confirmed+tested claim gains (P5 `chainJoin.ready`): dispatchable now. */
  chainReady: number;
  /** Open claims with a need nothing recorded gains (P5 `chainJoin.unmet`). */
  chainUnmet: number;
  /** M1: live chain steps on the plan board, and how many of them the board derives as ready or waiting. */
  chainSteps: number; chainReadySteps: number; chainWaitingSteps: number;
  /** Accepted cases with no current rating. */
  pendingRating: number;
  coverageTested: number;
  coverageCells: number;
  /** M3 backlog pair: cells no attempt reached yet, and cells the plan view omits for size. */
  coveragePlanned: number; coverageOmitted: number;
  /** P10: settled tasks whose lease expired before an answer. Split from `done` so the line cannot read as covered. */
  exhausted: number;
  /** P16.4: CVE leads written by `p2o_research action=cve`, and how many are rated critical: pointers to test, not findings. */
  leadsUntriaged: number; leadsCritical: number;
  /** P16.5: route diversity — distinct mechanism families among open todo steps, among done ones, and their names. */
  routesOpen: number; routesDone: number; routeNames: string[];
  /** P16.6: a `ruled_out` claim recorded without tested execution is a negation nobody checked. */
  unprovenNegations: number;
  /** P4: the highest suggested priority among the dispatchable work, with the purpose that scored it. A suggestion only. */
  suggested: { purpose: WorkPurpose; score: number } | null;
}

export const SITUATION_LIMIT = 240;
// Status vocabulary is owned by src/tasks.ts (P13c); this file only decides how to count it.
const SETTLED = { has: isSettledTask }, SATISFIED = { has: isSatisfiedTask }, EXECUTING = { has: isExecutingTask };
/** A coverage assessment that answered its question rather than leaving it open. */
const ANSWERED = new Set(['confirmed_claim', 'ruled_out_bounded', 'accepted']);

// Capabilities are typed (P14.1) and `chainJoin` owns the match, so the same join answers the graph view and this line.

export function summarizeSituation(input: { tasks: readonly AssessmentTask[]; cases: readonly CaseView[]; coverage: readonly CoveragePlanView[]; claims: readonly SituationClaim[]; plans?: readonly PlanEntry[]; leads?: ReadonlyArray<{ state?: string; severity?: string }> }): SituationSnapshot {
  const terminal = terminalCounts(input.tasks);
  const byId = new Map(input.tasks.map(task => [task.id, task]));
  const running = input.tasks.filter(task => EXECUTING.has(task.status));
  const ready = input.tasks.filter(task => task.status === 'proposed' && (task.prerequisites ?? []).every(link => SATISFIED.has(byId.get(link.taskId)?.status ?? '')));
  const claims = input.claims.map((claim, index) => ({ ...claim, candidate: claim.candidate ?? `claim-${index}` }));
  const join = chainJoin(claims);
  // M1: the board is the plan's own frontier; the join above stays the candidate-level answer, so each number has one owner.
  const board = chainBoard(input.plans ?? [], claims);
  const cells = input.coverage.flatMap(plan => plan.cells);
  // P16.5/P16.6: routes are counted from the plan board; a negation counts as unproven when its execution never ran.
  const routes = routeCounts(input.plans ?? []);
  const unprovenNegations = input.claims.filter(claim => claim.closure === 'ruled_out' && claim.execution !== 'tested').length;
  return {
    open: input.tasks.filter(task => !SETTLED.has(task.status)).length,
    running: running.length,
    runningRoles: [...new Set(running.map(task => task.role))].slice(0, 3),
    ready: ready.length,
    exhausted: terminal.exhausted,
    // A lease that expired before the worker reported: it needs another angle, not an unblock.
    blocked: input.tasks.filter(task => task.status === 'blocked').length,
    openContradictions: input.cases.reduce((total, item) => total + item.contradictions.filter(contradiction => contradiction.status === 'open').length, 0),
    chainReady: join.ready.length,
    chainUnmet: join.unmet.length,
    // A settled step (done/cancelled) is not open work, so it does not count toward the live board.
    chainSteps: board.reduce((total, chain) => total + chain.ready.length + chain.waiting.length, 0),
    chainReadySteps: board.reduce((total, chain) => total + chain.ready.length, 0),
    chainWaitingSteps: board.reduce((total, chain) => total + chain.waiting.length, 0),
    routesOpen: routes.open.length, routesDone: routes.done.length, routeNames: routes.open,
    unprovenNegations,
    leadsUntriaged: (input.leads ?? []).filter(lead => (lead.state ?? 'untriaged') === 'untriaged').length,
    leadsCritical: (input.leads ?? []).filter(lead => (lead.state ?? 'untriaged') === 'untriaged' && lead.severity?.toUpperCase() === 'CRITICAL').length,
    pendingRating: input.cases.filter(item => item.reviewStatus === 'accepted' && !item.finding).length,
    coverageTested: cells.filter(cell => isTestedCell(cell)).length,
    coverageCells: cells.length,
    coveragePlanned: cells.filter(cell => ['planned', 'unplanned'].includes(cell.effectiveExecution)).length,
    coverageOmitted: input.coverage.reduce((total, plan) => total + (plan.omittedCells ?? 0), 0),
    suggested: suggestNext(input, ready, cells, join.ready.length),
  };
}

/**
 * P4's surfacing: the suggestion is derived for the work that can start now — the ready tasks and, separately, a ready
 * chain step. It stays a suggestion: the lead's explicit `priority` decides dispatch order, and nothing reads this back.
 *
 * `requiresSatisfiedByConfirmed` is false for a task by construction, because a task record carries no link to the claim
 * it will produce; a ready chain step *is* the claim whose every needed capability a confirmed+tested claim gains, so the
 * fact is true there instead (P9's lineage gate is what would let a task inherit it).
 */
function suggestNext(input: { tasks: readonly AssessmentTask[]; cases: readonly CaseView[]; coverage: readonly CoveragePlanView[] }, ready: readonly AssessmentTask[], cells: readonly { questionKey: string; currentness: string; effectiveAssessment: string }[], chainReady: number): SituationSnapshot['suggested'] {
  const scored = input.cases.filter(item => item.acceptedFinding).flatMap(item => item.assetRefs.map(ref => ref.id));
  const productive = new Set(scored);
  const answered = new Set(cells.filter(cell => cell.currentness === 'current' && ANSWERED.has(cell.effectiveAssessment)).map(cell => cell.questionKey));
  const candidates = ready.map(task => {
    const purpose = task.work?.purpose ?? purposeFromRole(task.role);
    return { purpose, score: suggestPriority({
      prerequisitesUnmet: false,
      purpose,
      requiresSatisfiedByConfirmed: false,
      targetAssetHasAcceptedFinding: (task.work?.assetRefs ?? []).some(ref => productive.has(ref.id)),
      questionCoveredByFreshCell: task.work?.questionKey !== undefined && answered.has(task.work.questionKey),
    }) };
  });
  if (chainReady) candidates.push({ purpose: 'validation', score: suggestPriority({ prerequisitesUnmet: false, purpose: 'validation', requiresSatisfiedByConfirmed: true, targetAssetHasAcceptedFinding: false, questionCoveredByFreshCell: false }) });
  return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
}

/** Which snapshot field each rendered segment comes from; the drift test walks this map. */
export const SEGMENT_FIELDS = {
  stall: ['open'],
  running: ['running', 'runningRoles'],
  ready: ['ready'],
  next: ['suggested'],
  exhausted: ['exhausted'],
  blocked: ['blocked'],
  contradictions: ['openContradictions'],
  chain: ['chainReady', 'chainUnmet', 'chainSteps', 'chainReadySteps', 'chainWaitingSteps'],
  rating: ['pendingRating'],
  coverage: ['coverageTested', 'coverageCells', 'coveragePlanned', 'coverageOmitted'],
  leads: ['leadsUntriaged', 'leadsCritical'],
  routes: ['routesOpen', 'routesDone', 'routeNames'],
  negation: ['unprovenNegations'],
} as const satisfies Record<string, readonly (keyof SituationSnapshot)[]>;

export type SituationSegment = keyof typeof SEGMENT_FIELDS;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Ordered segments; the tail ones are dropped first when the line would exceed SITUATION_LIMIT. */
export function situationSegments(snapshot: SituationSnapshot): Array<{ id: SituationSegment; text: string }> {
  const segments: Array<{ id: SituationSegment; text: string }> = [];
  if (!snapshot.open) segments.push({ id: 'stall', text: '0 open' });
  else {
    if (snapshot.running) segments.push({ id: 'running', text: `${snapshot.running} running (${snapshot.runningRoles.join(', ')})` });
    segments.push({ id: 'ready', text: `${snapshot.ready} ready` });
    if (snapshot.suggested) segments.push({ id: 'next', text: `next: ${snapshot.suggested.purpose} ${snapshot.suggested.score}` });
    // P10: "exhausted" sits next to the work, not in the droppable tail: it changes what the lead should do next.
    if (snapshot.exhausted) segments.push({ id: 'exhausted', text: `${snapshot.exhausted} exhausted` });
    if (snapshot.blocked) segments.push({ id: 'blocked', text: `${snapshot.blocked} blocked on evidence` });
  }
  if (snapshot.openContradictions) segments.push({ id: 'contradictions', text: plural(snapshot.openContradictions, 'open contradiction') });
  // M1: when the plan carries a chain, the board decides the sentence; the candidate-level join answers only when no step is planned.
  if (snapshot.chainSteps) segments.push({ id: 'chain', text: `chain: ${plural(snapshot.chainReadySteps, 'step')} ready, ${snapshot.chainWaitingSteps} waiting` });
  else if (snapshot.chainReady || snapshot.chainUnmet) segments.push({ id: 'chain', text: `chain: ${plural(snapshot.chainReady, 'step')} ready, ${snapshot.chainUnmet} unmet needs` });
  // P16.5: the route sentence makes concentration visible; P16.6 names a negation nobody tested.
  if (snapshot.routesOpen || snapshot.routesDone) segments.push({ id: 'routes', text: `routes: ${snapshot.routesOpen} open${snapshot.routeNames.length ? ` (${snapshot.routeNames.join(', ')})` : ''}, ${snapshot.routesDone} done` });
  if (snapshot.unprovenNegations) segments.push({ id: 'negation', text: `${snapshot.unprovenNegations} unproven-negation` });
  // P16.4: a lead is the one segment that says "there is published work you have not considered yet".
  if (snapshot.leadsUntriaged) segments.push({ id: 'leads', text: `leads: ${snapshot.leadsUntriaged} untriaged${snapshot.leadsCritical ? ` (${snapshot.leadsCritical} critical)` : ''}` });
  if (snapshot.pendingRating) segments.push({ id: 'rating', text: `${plural(snapshot.pendingRating, 'case')} pending rating` });
  // M3: the backlog pair keeps "not shown" from reading as "not planned" (ARTEX agent/tools.go:436-440).
  if (snapshot.coverageCells) segments.push({ id: 'coverage', text: `coverage ${snapshot.coverageTested}/${snapshot.coverageCells}${snapshot.coveragePlanned || snapshot.coverageOmitted ? ` (planned ${snapshot.coveragePlanned} unreached, ${snapshot.coverageOmitted} omitted)` : ''}` });
  return segments;
}

/** One line, hard-capped: optional tail segments go before the length is allowed to exceed the cap. */
export function situationLine(snapshot: SituationSnapshot): string {
  const optional: SituationSegment[] = ['coverage', 'rating', 'chain', 'contradictions', 'blocked', 'next'];
  let segments = situationSegments(snapshot);
  const render = () => `Situation: ${segments.map(segment => segment.text).join(' · ')}.`;
  for (const id of optional) {
    if (render().length <= SITUATION_LIMIT) break;
    const kept = segments.filter(segment => segment.id !== id);
    if (kept.length && kept.length < segments.length) segments = kept;
  }
  return render().length <= SITUATION_LIMIT ? render() : `${render().slice(0, SITUATION_LIMIT - 1)}…`;
}
