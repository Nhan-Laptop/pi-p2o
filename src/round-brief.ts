/**
 * planning_update.md P18.2/D46: the round briefing is deterministic, bounded and derived.
 *
 * A round starts in a fresh session (D45), so the briefing — not the transcript — is the unit of continuity. It is a
 * projection of records the run already owns: no model call, no second store, no authority, no clock. The caller assembles
 * the same plain values its round progress reads (`deriveCompletion`, `completionDemand`, `planFrontier`, `taskFrontier`,
 * `runDebt`, `coverageViews`, the worker view, the scheduled revisits), so the brief and the engine cannot disagree about
 * what is owed. Old material is folded by `buildRoundDigest` rather than vanishing; every section has a byte cap with an
 * explicit truncation marker, and the whole brief is capped at {@link ROUND_BRIEF_MAX_BYTES}.
 *
 * Nothing here writes target prose: every sentence is a label plus a value the host supplied. A missing input says so
 * ("unknown, not clean") instead of being read as zero.
 */
import { describeCapability, type Capability } from './capabilities.js';
import { isConfirmedClaim } from './claims.js';
import type { CaseChainProjection } from './case-chain-view.js';
import { needsCaseReview } from './cases.js';
import { completionDemand, completionLine, type Completion } from './completion.js';
import { debtDischarge, debtSummary, type DebtReport } from './debt.js';
import { goalProofRefusal, proofLabel, type ProofCase, type ProofCoverage } from './goal-proof.js';
import { chainObligations } from './obligations.js';
import { chainBoard } from './chain-board.js';
import { chainJoin } from './chain-view.js';
import { routeMonoculture } from './routes.js';
import { judgeRound, type RoundBudget, type RoundFacts } from './round-budget.js';
import { situationLine, type SituationSnapshot } from './situation.js';
import { awaitingReview, type AssessmentTask } from './tasks.js';
import type { CampaignRecord } from './campaign.js';
import type { ChainClaim } from './chain-view.js';
import type { PlanEntry } from './planning.js';

/** P18.2/D46: hard ceiling for the complete brief, markers and section titles included. */
export const ROUND_BRIEF_MAX_BYTES = 8 * 1024;

export type BriefSectionId =
  | 'frame' | 'completion' | 'goals' | 'ready' | 'unchained' | 'coverage' | 'breadth' | 'review'
  | 'workers' | 'delta' | 'learned' | 'debt' | 'revisits' | 'round' | 'digest';

/**
 * Per-section caps. The sum deliberately exceeds the total cap: the aggregate guard has a real job, and it names the
 * sections it drops instead of silently truncating the tail of the brief.
 */
export const ROUND_BRIEF_SECTION_CAPS = {
  // P22/A3: `ready` carries the accepted case chains (labelled derived, bounded at CASE_CHAIN_MAX_CHAINS chains x 2 executed
  // links). Re-measured: the two-full-chain fixture renders 1,745 bytes, so 2,560 leaves the round's own ready/waiting/unmet
  // rows their old headroom instead of making the chain block crowd them out.
  frame: 1024, completion: 1024, goals: 1024, ready: 2560, unchained: 640, coverage: 768, breadth: 768, review: 768,
  workers: 768, delta: 640, learned: 900, debt: 1152, revisits: 448, round: 512, digest: 900,
} as const satisfies Record<BriefSectionId, number>;

const SECTION_TITLES: Readonly<Record<BriefSectionId, string>> = {
  frame: 'Campaign frame', completion: 'Completion and demand', goals: 'Goals and proof',
  ready: 'Ready chain steps', unchained: 'Unchained primitives', coverage: 'Coverage and route', breadth: 'Unplanned work',
  review: 'Awaiting review', workers: 'Workers', delta: 'Delta since the last round', learned: 'Learned this round',
  debt: 'Research debt', revisits: 'Revisit conditions', round: 'Round facts', digest: 'Older material',
};

/** Display order is D46's list; omission order drops history and pacing detail before obligations. */
const SECTION_ORDER: readonly BriefSectionId[] = [
  'frame', 'completion', 'goals', 'ready', 'unchained', 'coverage', 'breadth', 'review',
  'workers', 'delta', 'learned', 'debt', 'revisits', 'round', 'digest',
];
const OMIT_ORDER: readonly Exclude<BriefSectionId, 'frame'>[] =
  ['digest', 'revisits', 'delta', 'workers', 'learned', 'debt', 'review', 'coverage', 'round', 'unchained', 'ready', 'breadth', 'goals', 'completion'];

/** The campaign fields the frame renders; `CampaignRecord` satisfies this structurally. */
export type BriefCampaign = Pick<CampaignRecord, 'objective' | 'constraints' | 'mode'>;

/**
 * One round's monotone counters, structurally compatible with `RoundProgress`. `remaining` is read only from `previous`:
 * the current value is always `completion.remaining`, so the brief cannot print two different numbers.
 */
export interface BriefProgress {
  closures: number; testedCells: number; assets: number; chainDepth: number;
  remaining?: number; debt?: { gateable: number; total: number };
}

/** The `operatorWorkers` view, reduced to what the brief renders; `WorkerView` satisfies it. */
export interface BriefWorker {
  id: string; role?: string; taskId?: string; state: string; commandsUsed?: number;
  quiet?: boolean; reported?: boolean; stopped?: boolean;
}

/** A case as the round read it; `CaseView` satisfies it. */
export interface BriefCase {
  id: string; reviewStatus: string; verdict: string; currentness?: string; claimRefs?: readonly string[];
}

/** A coverage cell as the round read it; `CoverageCellView` satisfies it. */
export interface BriefCoverageCell {
  id: string; effectiveExecution: string; effectiveAssessment?: string; currentness?: string; retired?: boolean;
}
/** A coverage plan as the round read it; `CoveragePlanView` satisfies it. */
export interface BriefCoveragePlan {
  id: string; cells: readonly BriefCoverageCell[]; omittedCells?: number;
  discoveredUnplannedAssets?: number; unmappedCount?: number;
}

/** An engine-scheduled revisit (`scheduleRevisit`'s return shape). */
export interface BriefRevisit { condition: string; at: string }

/**
 * P21/C1+C6: the breadth projection the round's own reads already produced. Each row carries the exact count plus at most the
 * three samples the caller read, so a large backlog cannot grow the brief or the prompt. `unmetNeeds` is C6: needed
 * capabilities no demonstrated claim gains, as `capability <- claim` lines the planner can act on.
 */
export interface BriefBreadthRow { count: number; samples?: readonly string[] }
export interface BriefBreadth {
  unplannedAssets?: BriefBreadthRow;
  wstgUnplanned?: BriefBreadthRow;
  untriagedGaps?: BriefBreadthRow;
  unmetNeeds?: BriefBreadthRow;
}

export interface BriefRound {
  number: number;
  /** The model routed for this round; absent means the caller recorded none. */
  model?: string;
  /** Current step/time/context facts, including the budget; `judgeRound` renders the budget state. */
  facts?: RoundFacts;
  /** The configured budget when the caller has no current facts (for example at round admission). */
  budget?: RoundBudget;
}

/**
 * Plain data the extension assembles from its existing reads. No ledger handle, no clock, no I/O: the module cannot
 * fetch a value the caller did not already derive for the engine's progress.
 */
export interface RoundBriefInput {
  campaign?: BriefCampaign;
  /** The completion the engine consumed this round (`deriveCompletion`); its `remaining` is the brief's `remaining`. */
  completion: Completion;
  /** The demand the wake carried; defaults to `completionDemand(completion, plans)` when omitted. */
  demand?: string;
  plans: readonly PlanEntry[];
  claims: readonly ChainClaim[];
  tasks: readonly AssessmentTask[];
  cases?: readonly BriefCase[];
  /** P22/A3: the accepted case chains, projected read-only; omitted means the caller supplied none (unknown, not zero). */
  caseChains?: CaseChainProjection;
  coverage?: readonly BriefCoveragePlan[];
  debt?: DebtReport;
  /** P21/C1+C6: unplanned work and unmet capability needs; omitted means the caller supplied no projection (unknown, not zero). */
  breadth?: BriefBreadth;
  workers?: readonly BriefWorker[];
  revisits?: readonly BriefRevisit[];
  progress?: BriefProgress;
  previous?: BriefProgress;
  digest?: RoundDigest;
  /** R1.7: the graph's movement since the previous round opened, so the brief names it instead of leaving it to the tool. */
  graph?: BriefGraphDelta;
  /** P20/A3: what the run recorded in this window; omitted means the projection was not supplied and the brief says unknown. */
  learned?: BriefLearned;
  round: BriefRound;
  /** The same situation snapshot `/p2o status` reads; rendered as one line under the title when supplied. */
  situation?: SituationSnapshot;
}

export interface BriefSection { id: BriefSectionId; title: string; bytes: number; truncated: boolean; omitted: boolean }

/**
 * R1.7: the graph delta the round opening prints, reduced by the caller from the store's own read (`graphChanges` plus the
 * coverage/claim joins it already has). Rows are plain strings, so this module still cannot fetch a value the caller did not
 * derive. Absent means the graph was not read this round — the brief then says nothing rather than claiming zero movement.
 */
export interface BriefGraphDelta {
  /** The committed sequence the delta starts at (the previous round's opening). */
  since: number;
  /** How many current assets were first recorded after `since`, and how many heads changed. */
  counts: { newAssets: number; changedAssets: number; openHypotheses: number; inferredRelations: number };
  /** Recorded kind and key of the new assets, bounded by the caller. */
  newAssets?: readonly { kind: string; key: string }[];
  /** The current-scope asset count that no claim cites: recorded surface still without even a claim. */
  assetsWithoutClaim?: number;
  /** Accepted (current) findings per asset, busiest first; a finding is reviewed evidence, not proof of safety elsewhere. */
  acceptedFindingsByAsset?: readonly { assetId: string; findings: number }[];
  /** Open hypotheses recorded by a worker, waiting for owner review. */
  openHypotheses?: readonly { statement: string }[];
}

/**
 * P20/A3: what the run recorded in this window, reduced by the caller from `recentLearnings` (`src/exploration-view.ts`). Rows are
 * plain values with their record ids, so the section still cannot fetch a value the caller did not derive, and nothing here is
 * promoted: a learned claim is read back as background, not proof. Absent means the caller supplied no projection — the brief then
 * says unknown rather than zero.
 */
export interface BriefLearnedClaim {
  recordId?: string; candidate: string; closure?: string; execution?: string; proof?: string;
  taskId?: string; assetIds?: readonly string[]; surface?: string;
}
export interface BriefLearnedCase { recordId?: string; caseId: string; verdict?: string; reviewStatus?: string; assetIds?: readonly string[] }
export interface BriefLearnedWall { planId: string; recordId?: string; title?: string; status?: string; debtRefs?: readonly string[] }
/** P20/A5: the run-start reference counts; context from a prior run, never same-run evidence. */
export interface BriefLearnedPriorRun { runs: number; covered: number; leftOpen: number; stale: number; neverReached: number; unknown: number }

export interface BriefLearned {
  /** Ledger position the window starts at, and how many records it covers; absent means the caller did not say. */
  since?: number;
  window?: number;
  claims: readonly BriefLearnedClaim[];
  cases: readonly BriefLearnedCase[];
  walls: readonly BriefLearnedWall[];
  /** True totals; the section renders a bounded page and reports the difference. */
  counts?: { claims: number; cases: number; walls: number };
  priorRun?: BriefLearnedPriorRun;
}

export interface RoundBrief {
  text: string;
  /** `Buffer.byteLength(text)`, so the caller can assert the cap without parsing sections. */
  bytes: number;
  sections: BriefSection[];
  /** Always `input.completion.remaining`; the field exists so a test can compare it with the engine's derivation. */
  remaining: number;
  /** A per-section cap fired or the aggregate guard dropped a section; the text carries an explicit marker either way. */
  truncated: boolean;
  omitted: BriefSectionId[];
}

/** P18.2/D46: a digest record is any committed row; `AssessmentRecord` satisfies it structurally. */
export interface RoundDigestRecord { at?: string; by?: string; kind: string; text?: string }

export interface RoundDigest {
  text: string; bytes: number;
  /** Rows folded: positions `0 .. since-1`. */
  folded: number;
  /** Rows left in the current window: `records.length - folded`. */
  kept: number;
  kinds: ReadonlyArray<{ kind: string; count: number }>;
  span?: { earliest: string; latest: string };
  truncated: boolean;
}

/** One digest is a section of one brief; its own cap keeps a single summary line from dominating the projection. */
export const ROUND_DIGEST_MAX_BYTES = 900;

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

/** Single-line, control-free ledger prose; never composed, only clipped. */
function oneLine(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const clean = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

/**
 * Byte-capped UTF-8 clip with an explicit marker. The full text stays in the ledger; only this projection is cut, and the
 * marker says how many bytes were removed so "short" cannot be read as "absent".
 */
function clipToBytes(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const total = byteLength(value);
  if (total <= maxBytes) return { text: value, truncated: false };
  const marker = (removed: number) => `\n[... truncated ${removed} bytes]`;
  const reserve = byteLength(marker(total));
  const budget = Math.max(0, maxBytes - reserve);
  let prefix = '', used = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (used + size > budget) break;
    prefix += character; used += size;
  }
  return { text: `${prefix}${marker(total - used)}`, truncated: true };
}

interface Rendered extends BriefSection { text: string }

function finish(id: BriefSectionId, raw: string): Rendered {
  const clipped = clipToBytes(raw, ROUND_BRIEF_SECTION_CAPS[id]);
  return { id, title: SECTION_TITLES[id], text: clipped.text, bytes: byteLength(clipped.text), truncated: clipped.truncated, omitted: false };
}

const body = (id: BriefSectionId, lines: readonly string[]): Rendered => finish(id, `## ${SECTION_TITLES[id]}\n${lines.join('\n')}`);

const ids = (values: readonly string[], limit = 8): string =>
  values.length ? `${values.slice(0, limit).join(', ')}${values.length > limit ? `, ... (+${values.length - limit})` : ''}` : 'none';

/** P22/A3: typed capability descriptions, capped per line so one link cannot crowd out the rest of its section. */
const capabilityText = (capabilities: readonly Capability[], limit: number): string =>
  `${capabilities.slice(0, limit).map(capability => oneLine(describeCapability(capability), 40)).join(', ')}`
  + `${capabilities.length > limit ? `, +${capabilities.length - limit} more` : ''}`;

const signed = (before: number, after: number): string => before === after ? `${before} (no change)` : `${before}->${after} (${after > before ? '+' : ''}${after - before})`;
const delta = (label: string, before: number, after: number): string => `${label} ${signed(before, after)}`;

const budgetText = (budget: RoundBudget): string =>
  `${budget.steps > 0 ? `${budget.steps} steps` : 'unbounded steps'} / ${budget.seconds > 0 ? `${budget.seconds}s` : 'unbounded time'} / `
  + `context ${budget.contextWrapPercent > 0 ? `${budget.contextWrapPercent}% wrap` : 'wrap off'}, ${budget.contextHardPercent > 0 ? `${budget.contextHardPercent}% hard` : 'hard off'}`;

/** The campaign frame: what the operator asked for, never a target sentence the host did not record. */
function frameSection(input: RoundBriefInput): Rendered {
  const lines = [`P2O round brief: round ${input.round.number}`];
  if (input.situation) lines.push(situationLine(input.situation));
  lines.push(`## ${SECTION_TITLES.frame}`);
  const campaign = input.campaign;
  if (!campaign) lines.push('No campaign record on this run: objective, constraints and mode are unknown.');
  else {
    lines.push(`Objective: ${oneLine(campaign.objective, 400) || '(empty objective)'}`);
    const constraints = campaign.constraints.map(item => `${item.rule}: ${oneLine(item.text, 160)}`);
    lines.push(`Constraints: ${constraints.length ? constraints.join(' | ') : 'none recorded'}`);
    lines.push(`Mode: ${oneLine(campaign.mode, 24)}`);
  }
  return finish('frame', lines.join('\n'));
}

/** The completion line and the named demand are the engine's own words, never a second rule. */
function completionSection(completion: Completion, demand: string | undefined): Rendered {
  const lines = [completionLine(completion)];
  lines.push(demand ? `Demand: ${oneLine(demand, 400)}` : 'Demand: none; the completion derives no obligation for this round.');
  if (completion.items.length) lines.push(`Obligations: ${completion.items.map(item => `${item.code} ${item.count}`).join('; ')}`);
  return body('completion', lines);
}

/** Goal rows with their proof status, read through the same resolver a plan revision and completion use. */
function goalsSection(input: RoundBriefInput): Rendered {
  const goals = input.plans.filter(plan => plan.kind === 'goal');
  if (!goals.length) return body('goals', ['No goal recorded on the plan board; the campaign objective is not tracked as a goal.']);
  const proofCases: ProofCase[] = (input.cases ?? []).map(view => ({
    id: view.id, verdict: view.verdict, reviewStatus: view.reviewStatus,
    ...(view.currentness !== undefined ? { currentness: view.currentness } : {}),
  }));
  const proofCoverage: ProofCoverage[] = (input.coverage ?? []).map(plan => ({
    planId: plan.id,
    cells: plan.cells.map(cell => ({ id: cell.id, execution: cell.effectiveExecution, retired: cell.retired === true || cell.currentness === 'retired' })),
  }));
  const data = { claims: input.claims, cases: proofCases, coverage: proofCoverage };
  const lines = [`Goals: ${goals.length}.`];
  for (const goal of goals) {
    // P19/E: a goal settled blocked is not silently open, and its proof refusal is no longer the whole story.
    let status: string;
    if (goal.status === 'blocked') status = `settled with debt: ${oneLine(goal.reason, 200)}`;
    else if (!goal.proof) status = 'no proof recorded (cannot be settled)';
    else {
      const refusal = goalProofRefusal(goal.proof, data);
      status = refusal ? `UNPROVEN: ${oneLine(refusal.replace(/^GOAL_UNPROVEN:\s*/, ''), 200)}` : `proof holds: ${proofLabel(goal.proof)}`;
    }
    lines.push(`- ${goal.id} [${goal.status}] ${oneLine(goal.title, 140)} — ${status}`);
  }
  return body('goals', lines);
}

/**
 * P22/A3: the accepted case chains, projected read-only. Every row is labelled derived and "a rating record, not a plan", so a
 * rated chain can never be read as a readiness fact or as evidence for a new finding; the shown/total pair keeps the bounded
 * page honest. Absent means the caller supplied no projection: the brief says unknown rather than zero.
 */
function caseChainLines(projection: CaseChainProjection | undefined): string[] {
  if (!projection) return ['Case chains (derived): no projection was supplied this round; whether an accepted case records a current rated chain is unknown, not zero.'];
  if (!projection.total) return ['Case chains (derived): no accepted, current-rated case records a chain.'];
  const lines = [`Case chains (derived): ${projection.chains.length} of ${projection.total} accepted rated chain(s) shown.`];
  for (const chain of projection.chains) {
    const depth = chain.demonstratedThrough !== undefined
      ? `executed through step ${chain.demonstratedThrough} of ${chain.totalSteps}`
      : `no step executed — reasoned only (${chain.totalSteps} step(s) recorded)`;
    lines.push(`- derived from case ${oneLine(chain.caseId, 80)} r${chain.revision} (a rating record, not a plan): ${oneLine(chain.objective, 80)} — ${depth}.`);
    // The actionable line comes before the evidence lines: if the section cap fires, it cuts link detail, never the capability
    // left hanging that the next row has to answer.
    lines.push(chain.demonstratedThrough === undefined
      ? '  left to chain: nothing — no link executed, so no capability was demonstrated; the chain is reasoned only.'
      : chain.leftover.length
        ? `  left to chain: ${capabilityText(chain.leftover, 3)} — gained by an executed link, consumed by no later executed link; author the successor row or wall it.`
        : '  left to chain: nothing typed — every capability the executed links gained is consumed by a later executed link.');
    for (const link of chain.links) {
      lines.push(`  ${link.order}. ${oneLine(link.step, 60)}${link.claim ? ` — claim ${oneLine(link.claim, 40)}` : ''}${link.effect ? `; effect ${link.effect}` : ''}`
        + `${link.gained.length ? `; gained ${capabilityText(link.gained, 2)}` : ''}${link.needs.length ? `; needs ${capabilityText(link.needs, 2)}` : ''}`);
    }
    if (chain.omittedLinks) lines.push(`  (+${chain.omittedLinks} earlier executed link(s) not shown)`);
  }
  if (projection.total > projection.chains.length) lines.push(`  ... +${projection.total - projection.chains.length} more accepted rated chain(s) not shown; the case board holds the full chain.`);
  return lines;
}

/** M2: the ready step is what a dispatch can take today, with the provider it must cite. P21/C6 adds the waiting frontier
 * and the unmet capability needs, so a demonstrated primitive either advances the chain or becomes a named capability task.
 * P22/A3 adds the accepted case chains read-only: a rated chain names the capability it left hanging, so the lead authors the
 * successor row (or walls it) instead of re-planning links the run already demonstrated. */
function readySection(input: RoundBriefInput): Rendered {
  const obligations = chainObligations({ plans: input.plans, claims: input.claims, tasks: input.tasks });
  const board = chainBoard(input.plans, input.claims), join = chainJoin(input.claims);
  const waiting = board.flatMap(chain => chain.waiting.map(step => ({ chain: chain.chainOf, step: step.step, title: step.title, waitingOn: step.waitingOn })));
  const lines = [`Ready chain steps: ${obligations.ready.length}.`];
  if (!obligations.ready.length) lines.push('No chain step is ready.');
  const byId = new Map(input.plans.map(plan => [plan.id, plan]));
  for (const step of obligations.ready) {
    const row = byId.get(step.planId);
    lines.push(`- chain ${step.chainOf} step ${step.step}${row ? `: ${oneLine(row.title, 120)}` : ''} — consumes ${describeCapability(step.need)} already gained by ${step.provider}`
      + `${step.surface ? ` on ${oneLine(step.surface, 80)}` : ''}`);
  }
  if (waiting.length) {
    lines.push(`Waiting chain steps: ${waiting.length}. ${waiting.slice(0, 3).map(step => `step ${step.step} of chain ${step.chain} (${oneLine(step.title, 80)}) waits on ${step.waitingOn.map(describeCapability).join(', ')}`).join('; ')}`
      + `${waiting.length > 3 ? `; … +${waiting.length - 3}` : ''}.`);
  }
  if (join.unmet.length) {
    lines.push(`Unmet capability needs: ${join.unmet.length} open claim(s) need a capability nothing demonstrated gains `
      + `(${join.unmet.slice(0, 3).map(claim => `${claim} needs ${(join.uncovered[claim] ?? []).map(describeCapability).join(', ')}`).join('; ')}). `
      + 'Take the ready step above, or plan the capability task the need names — not another asset.');
  }
  lines.push(...caseChainLines(input.caseChains));
  return body('ready', lines);
}

/** M4: a demonstrated primitive with no successor and no recorded wall. */
function unchainedSection(completion: Completion): Rendered {
  const primitives = completion.unchained;
  if (!primitives.length) return body('unchained', ['No demonstrated primitive is left unchained.']);
  const lines = [`Unchained primitives: ${primitives.length}.`];
  for (const primitive of primitives) {
    lines.push(`- claim ${primitive.recordId}${primitive.capability ? ` gains ${primitive.capability}` : ' (no typed capability)'}`
      + `${primitive.surface ? ` on ${oneLine(primitive.surface, 100)}` : ''} — no successor step and no recorded wall`);
  }
  return body('unchained', lines);
}

/** P16.5: coverage counts and the one-route hint; a missing projection is unknown, never clean. */
function coverageSection(input: RoundBriefInput): Rendered {
  const lines: string[] = [];
  const plans = input.coverage;
  if (!plans) lines.push('Coverage: no projection was supplied this round; coverage is unknown, not clean.');
  else if (!plans.length) lines.push('Coverage: no live coverage plan; there is no denominator, so nothing can be called covered.');
  else {
    const cells = plans.flatMap(plan => plan.cells).filter(cell => cell.currentness !== 'retired');
    const count = (predicate: (cell: BriefCoverageCell) => boolean) => cells.filter(predicate).length;
    const omitted = plans.reduce((total, plan) => total + (plan.omittedCells ?? 0), 0);
    const unplanned = plans.reduce((total, plan) => total + (plan.discoveredUnplannedAssets ?? 0), 0);
    const unmapped = plans.reduce((total, plan) => total + (plan.unmappedCount ?? 0), 0);
    lines.push(`Coverage: ${count(cell => cell.effectiveExecution === 'tested')}/${cells.length} cell(s) tested; `
      + `unreached ${count(cell => cell.effectiveExecution === 'planned' || cell.effectiveExecution === 'unplanned')}; `
      + `attempted ${count(cell => cell.effectiveExecution === 'attempted' || cell.effectiveExecution === 'running')}; `
      + `stale ${count(cell => cell.currentness === 'stale')}; open-gap assessments ${count(cell => cell.effectiveAssessment === 'open_gap')}.`);
    if (omitted || unplanned || unmapped) lines.push(`Denominator backlog: ${omitted} omitted cell(s); ${unplanned} discovered unplanned asset(s); ${unmapped} unmapped task(s).`);
  }
  if (input.debt && input.debt.totals.GAP_UNTRIAGED > 0) lines.push(`Gaps: ${input.debt.totals.GAP_UNTRIAGED} untriaged open gap(s) named by research debt.`);
  const mono = routeMonoculture(input.plans, input.claims);
  if (mono) lines.push(`Route monoculture hint: every open step is on route ${mono.route}; plausible elsewhere: ${mono.alternatives.slice(0, 5).join(', ')}. A hint only; the lead decides scope.`);
  return body('coverage', lines);
}

/** P21/C1: the unplanned work the never-idle rule reads, with its disposition spelled out so a count is actionable. */
function breadthSection(input: RoundBriefInput): Rendered {
  const breadth = input.breadth;
  if (!breadth) return body('breadth', ['No breadth projection was supplied this round; unplanned work is unknown, not zero.']);
  const rows = [
    { id: 'unplanned asset', row: breadth.unplannedAssets, lead: 'Unplanned assets (no coverage cell)' },
    { id: 'uncovered WSTG question', row: breadth.wstgUnplanned, lead: 'Uncovered WSTG questions (recorded feature applies, no live cell)' },
    { id: 'unmet capability need', row: breadth.unmetNeeds, lead: 'Unmet capability needs (nothing demonstrated gains them)' },
    { id: 'untriaged gap', row: breadth.untriagedGaps, lead: 'Untriaged gaps (no coverage cell or case cites them)' },
  ].filter(entry => (entry.row?.count ?? 0) > 0);
  if (!rows.length) return body('breadth', ['Breadth: no unplanned asset, uncovered WSTG question, untriaged gap or unmet capability need is recorded.']);
  const lines = rows.map(entry => `- ${entry.lead}: ${entry.row!.count}; ${ids(entry.row!.samples ?? [], 3)}.`);
  lines.push('Disposition per row: revise the coverage plan, create the intent whose question asks it, or record why it is out of scope. '
    + 'A non-zero row with none of those is the stalled round the host records.');
  return body('breadth', lines);
}

/** The three review queues the finish preflight also names: tasks, confirmed claims without a case, pending cases. */
function reviewSection(input: RoundBriefInput): Rendered {
  const tasks = input.tasks.filter(awaitingReview).map(task => task.id);
  const cited = new Set((input.cases ?? []).flatMap(view => view.claimRefs ?? []));
  const claims = input.claims.flatMap(claim => claim.recordId && isConfirmedClaim(claim) && !cited.has(claim.recordId) ? [claim.recordId] : []);
  const cases = (input.cases ?? []).filter(needsCaseReview).map(view => view.id);
  if (!tasks.length && !claims.length && !cases.length) return body('review', ['No task, confirmed claim or case is awaiting owner review.']);
  return body('review', [
    `Tasks awaiting review: ${tasks.length}; ${ids(tasks)}.`,
    `Confirmed claims with no case: ${claims.length}; ${ids(claims)}.`,
    `Cases pending or disputed: ${cases.length}; ${ids(cases)}.`,
  ]);
}

/** Local observation of workers, with quiet explicitly not a failure. */
function workersSection(workers: readonly BriefWorker[] | undefined): Rendered {
  const all = workers ?? [];
  if (!all.length) return body('workers', ['No worker has been launched; a solo run has none.']);
  const live = all.filter(worker => !worker.reported && !worker.stopped);
  const lines = [`Workers: ${all.length} total; ${live.length} live (${live.filter(worker => worker.quiet).length} quiet); `
    + `${all.filter(worker => worker.reported).length} reported; ${all.filter(worker => worker.stopped && !worker.reported).length} stopped.`];
  for (const worker of all) {
    lines.push(`- ${oneLine(worker.id, 80)} ${oneLine(worker.role ?? 'role unknown', 40)} [${oneLine(worker.state, 40)}]`
      + `${worker.taskId ? ` task ${oneLine(worker.taskId, 80)}` : ''}${worker.commandsUsed !== undefined ? ` ${worker.commandsUsed} cmds` : ''}`
      + `${worker.quiet ? ' QUIET' : ''}${worker.reported && worker.state !== 'reported' ? ' reported' : ''}${worker.stopped && worker.state !== 'stopped' ? ' stopped' : ''}`);
  }
  return body('workers', lines);
}

/** R1.7: the graph lines the delta section carries, bounded so a busy graph cannot crowd out the counters above them. */
function graphDeltaLines(graph: BriefGraphDelta): string[] {
  const lines = [`Graph since ${graph.since}: ${graph.counts.newAssets} new asset(s), ${graph.counts.changedAssets} changed; `
    + `${graph.assetsWithoutClaim === undefined ? 'assets without a claim unknown' : `${graph.assetsWithoutClaim} with no claim`}; `
    + `${graph.counts.openHypotheses} open hypothesis(es), ${graph.counts.inferredRelations} inferred relation(s) awaiting review.`];
  const newAssets = (graph.newAssets ?? []).slice(0, 3).map(row => `${oneLine(row.kind, 16)} ${oneLine(row.key, 60)}`);
  if (newAssets.length) lines.push(`New assets: ${newAssets.join(', ')}${graph.counts.newAssets > newAssets.length ? `, ... (+${graph.counts.newAssets - newAssets.length})` : ''}.`);
  const findings = (graph.acceptedFindingsByAsset ?? []).slice(0, 3);
  if (findings.length) lines.push(`Accepted findings on the busiest assets: ${findings.map(row => `${oneLine(row.assetId, 80)} ${row.findings}`).join(', ')}.`);
  const hypotheses = (graph.openHypotheses ?? []).slice(0, 2).map(row => oneLine(row.statement, 60)).filter(Boolean);
  if (hypotheses.length) lines.push(`Open hypotheses: ${hypotheses.join(' | ')}.`);
  return lines;
}

/** What changed since the previous round's counters; `remaining` always comes from the completion, not a second counter. */
function deltaSection(input: RoundBriefInput, completion: Completion): Rendered {
  const progress = input.progress, graph = input.graph ? graphDeltaLines(input.graph) : [];
  if (!progress) return body('delta', ['No round counters were supplied; the delta since the last round is unavailable.', ...graph]);
  const currentDebt = input.debt ? { gateable: input.debt.gateable, total: input.debt.total } : progress.debt;
  const previous = input.previous;
  if (!previous) {
    return body('delta', [`First round: closures ${progress.closures}; tested cells ${progress.testedCells}; assets ${progress.assets}; `
      + `chain depth ${progress.chainDepth}; remaining ${completion.remaining}${currentDebt ? `; debt ${currentDebt.gateable} gateable` : ''}.`, ...graph]);
  }
  const parts = [
    delta('closures', previous.closures, progress.closures),
    delta('tested cells', previous.testedCells, progress.testedCells),
    delta('assets', previous.assets, progress.assets),
    delta('chain depth', previous.chainDepth, progress.chainDepth),
    previous.remaining !== undefined ? delta('remaining', previous.remaining, completion.remaining) : `remaining ${completion.remaining} (previous not recorded)`,
  ];
  if (currentDebt) parts.push(previous.debt ? delta('debt (gateable)', previous.debt.gateable, currentDebt.gateable) : `debt (gateable) ${currentDebt.gateable}`);
  return body('delta', [`Since the last round: ${parts.join('; ')}.`, ...graph]);
}

/** P20/A3: the round's recorded learning, with the intent and asset behind each row, plus the prior-run context line (A5). */
function learnedSection(learned: BriefLearned | undefined): Rendered {
  if (!learned) return body('learned', ['No learned projection was supplied this round; what the run recorded is unknown, not zero.']);
  const counts = learned.counts ?? { claims: learned.claims.length, cases: learned.cases.length, walls: learned.walls.length };
  const claims = learned.claims.slice(0, 5), cases = learned.cases.slice(0, 3), walls = learned.walls.slice(0, 3);
  const window = `${learned.since !== undefined ? ` since ledger position ${learned.since}` : ''}${learned.window !== undefined ? ` (${learned.window} record(s) in the window)` : ''}`;
  const first = (values: readonly string[] | undefined, max: number): string => values?.length
    ? `${oneLine(values[0], max)}${values.length > 1 ? ` (+${values.length - 1})` : ''}` : '';
  const recorded = counts.claims + counts.cases + counts.walls;
  const lines: string[] = [];
  if (!recorded) lines.push(`Nothing recorded${window}: no claim, accepted case or wall is in the window.`);
  else lines.push(`Recorded${window}: ${counts.claims} claim(s) (showing ${claims.length}), ${counts.cases} accepted case(s) (showing ${cases.length}), `
    + `${counts.walls} wall(s) (showing ${walls.length}). Background only: never proof, never a coverage cell.`);
  for (const claim of claims) {
    const asset = first(claim.assetIds, 30);
    lines.push(`- claim ${oneLine(claim.recordId ?? claim.candidate, 80)} ${oneLine(claim.candidate, 56)} `
      + `${oneLine(claim.closure ?? 'unknown', 24)}/${oneLine(claim.execution ?? 'unknown', 24)}`
      + `${claim.proof ? `, proof ${oneLine(claim.proof, 24)}` : ''}`
      + `${claim.taskId ? `, via task ${oneLine(claim.taskId, 32)}` : ', no recorded task'}`
      + `${asset ? `, on ${asset}` : ', no pinned asset'}`);
  }
  for (const item of cases) {
    const asset = first(item.assetIds, 30);
    lines.push(`- accepted case ${oneLine(item.caseId, 60)}${item.verdict ? ` (${oneLine(item.verdict, 24)})` : ''}${asset ? ` on ${asset}` : ''}`);
  }
  for (const wall of walls) {
    const debt = first(wall.debtRefs, 40);
    lines.push(`- wall ${oneLine(wall.planId, 60)} [${oneLine(wall.status ?? 'unknown', 24)}] answers ${debt || 'no recorded debt id'}`);
  }
  const omitted = { claims: counts.claims - claims.length, cases: counts.cases - cases.length, walls: counts.walls - walls.length };
  if (omitted.claims > 0 || omitted.cases > 0 || omitted.walls > 0) {
    lines.push(`Omitted beyond this page: ${omitted.claims} claim(s), ${omitted.cases} case(s), ${omitted.walls} wall(s).`);
  }
  // P20/A5: a prior run's project knowledge is a lookup hint; this line can never be read as same-run evidence.
  if (learned.priorRun) {
    const prior = learned.priorRun;
    lines.push(`Prior run (context only, never evidence): ${prior.runs} run(s); covered ${prior.covered}, left open ${prior.leftOpen}, `
      + `stale ${prior.stale}, never reached ${prior.neverReached}, unknown ${prior.unknown}.`);
  }
  return body('learned', lines);
}

/** A6.2: the derived report's own summary, the citable ids a later plan row can wall, and P19/D: how each owed item is discharged. */
function debtSection(debt: DebtReport | undefined): Rendered {
  if (!debt) return body('debt', ['No research-debt report was supplied; outstanding research is unknown, not zero.']);
  const summary = debtSummary(debt);
  const lines = [summary ?? 'No research debt is recorded.'];
  for (const item of debt.items.slice(0, 6)) {
    const guidance = item.gateable ? debtDischarge(item.kind) : undefined;
    lines.push(`- ${item.id} ${item.kind}: ${oneLine(item.subject, 120)}${guidance ? ` — discharge: ${oneLine(guidance, 140)}` : ''}`);
  }
  if (debt.items.length > 6) lines.push(`... ${debt.items.length - 6} more displayed item(s).`);
  if (summary) lines.push(`Citable debt ids: ${ids(debt.gateableIds)}.`);
  // P19/C: the wall is a legal end to a round, so the brief that lists the debt also names the record that answers it.
  if (summary) lines.push('A deferred/blocked todo citing these ids is the wall; a round that records one is progress, not a stall.');
  return body('debt', lines);
}

function revisitsSection(revisits: readonly BriefRevisit[] | undefined): Rendered {
  const all = revisits ?? [];
  if (!all.length) return body('revisits', ['No revisit is scheduled.']);
  return body('revisits', [`Revisits: ${all.length}.`, ...all.map(item => `- ${oneLine(item.condition, 80)} at ${oneLine(item.at, 40)}`)]);
}

/** D44: the round's own bound, judged by the same function the engine uses. */
function roundSection(round: BriefRound): Rendered {
  const lines = [`Round: ${round.number} of an uncapped campaign.`, `Model: ${round.model ? oneLine(round.model, 120) : 'not recorded for this round'}.`];
  if (round.facts) {
    const judged = judgeRound(round.facts);
    lines.push(`Budget: ${budgetText(round.facts.budget)}.`);
    lines.push(`State: ${judged.state}${judged.reason ? ` (${judged.reason})` : ''}; steps ${round.facts.steps}${round.facts.budget.steps > 0 ? `/${round.facts.budget.steps}` : ''}`
      + `${round.facts.contextPercent !== undefined && round.facts.contextPercent !== null ? `; context ${Math.round(round.facts.contextPercent)}%` : ''}.`);
  } else if (round.budget) lines.push(`Budget: ${budgetText(round.budget)}. State not judged (no step/time facts supplied).`);
  else lines.push('Budget: not recorded for this round.');
  return body('round', lines);
}

function digestSection(digest: RoundDigest | undefined): Rendered {
  const section = body('digest', [digest ? digest.text : 'No older material was folded for this round.']);
  // The digest's own cap may have fired while its text still fits this brief's section cap; the marker travels with it.
  if (digest?.truncated) section.truncated = true;
  return section;
}

function omittedMarker(omitted: readonly BriefSectionId[]): string {
  return `[... omitted ${omitted.length} section(s) to keep this round brief within ${ROUND_BRIEF_MAX_BYTES} bytes: `
    + `${omitted.map(id => SECTION_TITLES[id]).join(', ')}; the ledger still holds the material]`;
}

/**
 * P18.2/D46: build the bounded briefing from the caller's plain read. Deterministic: no clock, no model, no I/O, no write.
 * `remaining` is copied from `input.completion`, so a test can compare it with `deriveCompletion` for the same read.
 */
export function buildRoundBrief(input: RoundBriefInput): RoundBrief {
  const demand = input.demand ?? completionDemand(input.completion, input.plans);
  const rendered: Record<BriefSectionId, Rendered> = {
    frame: frameSection(input),
    completion: completionSection(input.completion, demand),
    goals: goalsSection(input),
    ready: readySection(input),
    unchained: unchainedSection(input.completion),
    coverage: coverageSection(input),
    breadth: breadthSection(input),
    review: reviewSection(input),
    workers: workersSection(input.workers),
    delta: deltaSection(input, input.completion),
    learned: learnedSection(input.learned),
    debt: debtSection(input.debt),
    revisits: revisitsSection(input.revisits),
    round: roundSection(input.round),
    digest: digestSection(input.digest),
  };
  const sections = SECTION_ORDER.map(id => rendered[id]);
  const omitted: BriefSectionId[] = [];
  const compose = (): string => {
    const kept = sections.filter(section => !section.omitted).map(section => section.text).join('\n\n');
    return omitted.length ? `${kept}\n\n${omittedMarker(omitted)}` : kept;
  };
  let text = compose();
  for (const id of OMIT_ORDER) {
    if (byteLength(text) <= ROUND_BRIEF_MAX_BYTES) break;
    const section = rendered[id];
    if (section.omitted) continue;
    section.omitted = true; section.bytes = 0; omitted.push(id);
    text = compose();
  }
  // The caps make this unreachable (frame plus the omission marker is far under the cap); kept as the hard guarantee.
  if (byteLength(text) > ROUND_BRIEF_MAX_BYTES) text = clipToBytes(text, ROUND_BRIEF_MAX_BYTES).text;
  return {
    text, bytes: byteLength(text),
    sections: sections.map(section => ({ id: section.id, title: section.title, bytes: section.bytes, truncated: section.truncated, omitted: section.omitted })),
    remaining: input.completion.remaining,
    truncated: sections.some(section => section.truncated) || omitted.length > 0,
    omitted,
  };
}

/**
 * P18.2/D46: fold material older than the round window into one bounded digest instead of truncating it silently.
 * `since` is a ledger position: records `0 .. since-1` are folded and the rest stay current. `AssessmentRecord`
 * satisfies {@link RoundDigestRecord}, so the caller passes the same `index.records` its other reads use.
 */
export function buildRoundDigest(records: readonly RoundDigestRecord[], since: number): RoundDigest {
  const limit = Number.isFinite(since) ? Math.max(0, Math.min(records.length, Math.floor(since))) : 0;
  const foldedRecords = records.slice(0, limit), kept = records.length - limit;
  const kinds = new Map<string, number>();
  for (const record of foldedRecords) kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1);
  const orderedKinds = [...kinds].sort(([leftKind, leftCount], [rightKind, rightCount]) => rightCount - leftCount || leftKind.localeCompare(rightKind))
    .map(([kind, count]) => ({ kind, count }));
  const times = foldedRecords.map(record => record.at).filter((at): at is string => typeof at === 'string' && at.length > 0).sort();
  const span = times.length ? { earliest: times[0]!, latest: times[times.length - 1]! } : undefined;
  const lines: string[] = [];
  if (!records.length) lines.push('No older records folded; the ledger is empty.');
  else if (!foldedRecords.length) lines.push(`No older records folded; the round window covers all ${kept} record(s).`);
  else {
    lines.push(`Folded ${foldedRecords.length} older record(s); window starts at ${limit}, ${kept} kept.`);
    lines.push(`Kinds: ${orderedKinds.map(item => `${oneLine(item.kind, 24)} ${item.count}`).join(', ')}. Actors: ${new Set(foldedRecords.map(record => record.by).filter(by => typeof by === 'string' && by.length > 0)).size}.`);
    if (span) lines.push(`Span: ${oneLine(span.earliest, 40)} .. ${oneLine(span.latest, 40)}.`);
    for (const record of foldedRecords.slice(-3)) {
      const summary = oneLine(record.text, 120);
      if (summary) lines.push(`- ${oneLine(record.kind, 24)}${record.by ? ` by ${oneLine(record.by, 60)}` : ''}: ${summary}`);
    }
  }
  const clipped = clipToBytes(lines.join('\n'), ROUND_DIGEST_MAX_BYTES);
  return { text: clipped.text, bytes: byteLength(clipped.text), folded: foldedRecords.length, kept,
    kinds: orderedKinds, ...(span ? { span } : {}), truncated: clipped.truncated };
}
