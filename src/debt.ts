/**
 * planning_update.md P5/A6.2: research debt is a derived record, not a hint.
 *
 * A campaign continues because work is owed. This module turns the projections the host already has — plan board, task
 * frontier, chain obligations, coverage projection, WSTG map and write-back counts — into a bounded list of named items
 * with stable ids. It is a pure read: no clock, no I/O, no ledger write, no model, no target.
 *
 * An item is discharged by the record that answers it (a tested cell, a satisfied mapping task, an accepted case, a goal
 * proof — all of which simply stop the derivation from producing the item) or by a plan **todo** that is `deferred`/
 * `blocked`, gives a reason, and cites the id in `debtRefs`. A `decision` row and free text do not discharge: the observed
 * run at 04:00:41 tried exactly that and its obligation stayed open.
 *
 * The report never refuses anything. It is what completion, the finish preflight and the report read to say what is still
 * owed; the engine's debt wake (A6.3) reads the same numbers.
 */
import { caseViews, type CaseContext } from './cases.js';
import { claimHeadClaims } from './chain-view.js';
import { coverageViews, type CoverageContext, type CoveragePlanView } from './coverage.js';
import { chainObligations } from './obligations.js';
import { planFrontier, type PlanEntry } from './planning.js';
import { isOpenGap, type LedgerIndex } from './records.js';
import { isSatisfiedTask, taskFrontier, type AssessmentTask } from './tasks.js';
import { sha256Hex } from './validate.js';
import { featuresFromAttributeValues, isWstgKey, unplannedTests, wstgSuggest } from './wstg-map.js';
import type { WorkerWrites } from './write-back.js';

/** Every debt kind, in report order. The list is the vocabulary: no caller invents a kind. */
export const DEBT_KINDS = [
  'CAMPAIGN_MISSING', 'GOAL_MISSING', 'GOAL_OPEN', 'PLAN_MISSING', 'SCOPE_UNPLANNED_ASSET', 'CELL_NOT_RUN',
  'GAP_UNTRIAGED', 'WSTG_UNPLANNED', 'FEATURES_MISSING', 'TASK_UNMAPPED', 'MAPPING_UNRECORDED', 'PRIMITIVE_UNCHAINED',
  'CLAIM_UNTRIAGED',
] as const;
export type DebtKind = typeof DEBT_KINDS[number];
/** Kinds that inform the report but never make a run incomplete: a missing feature tag is a prompt gap, not owed work. */
const ADVISORY: ReadonlySet<DebtKind> = new Set<DebtKind>(['FEATURES_MISSING']);

export interface DebtItem { id: string; kind: DebtKind; subject: string; detail: string; gateable: boolean }
export interface DebtReport {
  /** The capped display page, sorted by kind order then subject. */
  items: DebtItem[];
  /** Every id the report produced before the per-kind cap, including advisory ones; `debtRefs` membership is checked here. */
  ids: string[];
  /** Gateable ids only, in report order; a wall may cite any of them. */
  gateableIds: string[];
  totals: Record<DebtKind, number>;
  /** All items, including advisory. */
  total: number;
  /** Items that make a run incomplete. */
  gateable: number;
  /** Items a deferral/blocked record answered this report; they are not in `items` or `total`. */
  discharged: number;
}
/** The campaign record the goal kinds read. `src/campaign.ts` (A6.1) satisfies this structurally. */
export interface CampaignLike { objective: string }
export interface DebtInput {
  /** A6.1: present when the run recorded a campaign; `expectCampaign` says the mode promised one. */
  campaign?: CampaignLike;
  expectCampaign?: boolean;
  /** The live coverage context; without it the coverage-derived kinds are skipped rather than guessed. */
  coverage?: CoverageContext;
  cases?: CaseContext;
  /** Raw `attributes.feature` values as recorded (`featuresFromAttributeValues` normalises them). */
  features?: readonly string[];
  /** A6.4: per-asset recorded feature values; when present the applicable-test matrix is the one that derives WSTG_UNPLANNED. */
  featureAssets?: readonly { assetId: string; features: readonly string[] }[];
  /** Host-computed write-back counts (`writeBack`), used for the mapping kinds. */
  wrote?: readonly WorkerWrites[];
  /** WSTG `modes` filter, and the capabilities the run actually has. Absent means "not available", which filters those rows. */
  modes?: string;
  browser?: boolean;
  identity?: boolean;
  limits?: { perKind?: number };
}

const PER_KIND = 5;
const DEBT_ID = /^debt-[a-z][a-z0-9-]*-[a-f0-9]{12}$/;
/** The one id rule: `debt-<kind-kebab>-<12 hex of the subject>`. Stable across reads, changes with the subject. */
export const debtId = (kind: DebtKind, subject: string): string => `debt-${kind.toLowerCase().replaceAll('_', '-')}-${sha256Hex(subject).slice(0, 12)}`;
export const isDebtId = (value: unknown): value is string => typeof value === 'string' && DEBT_ID.test(value);

const KIND_ORDER = new Map<DebtKind, number>(DEBT_KINDS.map((kind, index) => [kind, index]));
const OPEN_CELL_ASSESSMENTS: ReadonlySet<string> = new Set(['open_gap', 'unreviewed', 'stale']);
const OPEN_CELL_EXECUTIONS: ReadonlySet<string> = new Set(['unplanned', 'planned', 'running', 'attempted']);

/**
 * Derive the campaign's outstanding research debt from committed state.
 *
 * Bounded by construction: the projection is over frontiers and cells, never over history. `items` is capped to
 * `perKind` per kind so a prompt or a report line stays small; `totals`, `total` and `ids` keep the true numbers.
 */
export function deriveDebt(index: LedgerIndex, input: DebtInput = {}): DebtReport {
  const plans = planFrontier(index), tasks = taskFrontier(index), claims = claimHeadClaims(index);
  const found: DebtItem[] = [];
  const add = (kind: DebtKind, subject: string, detail: string): void => {
    found.push({ id: debtId(kind, subject), kind, subject, detail, gateable: !ADVISORY.has(kind) });
  };
  const order = new Map<string, number>();
  index.records.forEach((row, position) => { if (row.id) order.set(row.id, position); });
  const replaced = new Set(index.records.flatMap(row => row.supersedes ? [row.supersedes] : []));
  const retired = new Set([...replaced, ...index.records.flatMap(row => row.resolves ?? [])]);
  const cases = caseViews(index, input.cases ?? {});
  const citedClaims = new Set(cases.flatMap(view => view.claimRefs));

  // --- campaign frame and goals (D9/A6.1 read these; the kinds exist now so the frame has somewhere to land) ---
  if (input.expectCampaign && !input.campaign) add('CAMPAIGN_MISSING', 'campaign', 'no campaign record: the objective, operator constraints and heartbeat are unknown');
  const goals = plans.filter(plan => plan.kind === 'goal');
  if (input.campaign && !goals.length) add('GOAL_MISSING', 'no-goal', `campaign objective "${input.campaign.objective.slice(0, 160)}" has no goal on the plan board`);
  for (const goal of goals) if (goal.status !== 'reviewed' && goal.status !== 'closed') add('GOAL_OPEN', goal.id, `goal "${goal.title.slice(0, 160)}" is ${goal.status}`);

  // --- denominator and derived cells ---
  let coverage: CoveragePlanView[] = [];
  if (input.coverage) {
    coverage = coverageViews(index, input.coverage);
    const cells = coverage.flatMap(plan => plan.cells).filter(cell => cell.currentness !== 'retired');
    const live = coverage.filter(plan => plan.status !== 'closed' && plan.status !== 'cancelled');
    if (!live.length) add('PLAN_MISSING', 'no-plan', 'no live coverage plan: the run has no denominator, so nothing can be called covered');
    else {
      // The observed failure: the plan was recorded after every task had closed. A post-hoc denominator is a plan revision,
      // not a record of what was planned, so it is named as debt rather than accepted silently.
      const lastSatisfied = tasks.filter(task => isSatisfiedTask(task.status)).reduce((max, task) => Math.max(max, order.get(task.recordId) ?? -1), -1);
      const earliest = live.reduce((min, plan) => Math.min(min, order.get(plan.recordId) ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
      // Later record = larger order. The plan is post-hoc when it arrived after every task it claims to have planned for.
      if (lastSatisfied >= 0 && earliest > lastSatisfied) add('PLAN_MISSING', `post-hoc:${live[0]!.id}`, 'the coverage plan was recorded after the last reviewed task, so the denominator was written after the work it claims to plan');
    }
    const assets = input.coverage.assetIds?.() ?? [], plannedAssets = new Set(cells.map(cell => cell.assetRef.id));
    for (const asset of assets) if (!plannedAssets.has(asset)) add('SCOPE_UNPLANNED_ASSET', asset, 'graph asset with no derived coverage cell');
    for (const cell of cells) {
      if (OPEN_CELL_ASSESSMENTS.has(cell.effectiveAssessment) || OPEN_CELL_EXECUTIONS.has(cell.effectiveExecution)) {
        add('CELL_NOT_RUN', cell.id, `${cell.questionKey} is ${cell.effectiveAssessment}/${cell.effectiveExecution}`);
      }
    }
    // A gap nobody references is a finding nobody will read: it is named, and a plan row or a case quoting it discharges it.
    const referenced = new Set(cells.flatMap(cell => [...cell.gapRefs, ...cell.claimRefs]));
    for (const view of cases) for (const contradiction of view.contradictions) referenced.add(contradiction.evidenceRef);
    for (const row of index.records) {
      if (row.id && row.kind === 'open' && isOpenGap(row, retired) && !referenced.has(row.id) && !citedClaims.has(row.id)) {
        add('GAP_UNTRIAGED', row.id, 'open gap referenced by no coverage cell and no case');
      }
    }
    // WSTG: only where a recorded feature or a cell makes a row applicable. Browser/identity rows need an oracle/grant.
    const { features, ignored } = featuresFromAttributeValues(input.features ?? []);
    const covered = new Set(cells.filter(cell => isWstgKey(cell.questionKey)).map(cell => cell.questionKey));
    if (input.featureAssets?.length) {
      // A6.4: the per-asset matrix is the denominator — an applicable test names the assets whose recorded features trigger it,
      // and the browser/identity filters are the matrix's own (a row needing an oracle or grant this run does not have is out).
      for (const test of unplannedTests(input.featureAssets, { covered, browser: Boolean(input.browser), identity: Boolean(input.identity) })) {
        add('WSTG_UNPLANNED', test.key, test.detail);
      }
    } else if (features.length) {
      const suggestion = wstgSuggest(features, { covered, ...(input.modes ? { modes: input.modes } : {}), limit: 20 });
      for (const test of suggestion.suggestions) {
        if (test.flags.includes('B') && !input.browser) continue;
        if (test.flags.includes('I') && !input.identity) continue;
        add('WSTG_UNPLANNED', test.key, `${test.title} (${test.support}${test.flags ? `, ${test.flags}` : ''}) applies to the recorded feature(s)`);
      }
    } else if (cells.length && !(input.featureAssets?.length)) {
      add('FEATURES_MISSING', 'features', `mapped assets record no \`feature\` attribute, so applicable WSTG tests cannot be derived (advisory)${ignored.length ? `; unrecognised token(s) recorded: ${ignored.slice(0, 5).join(', ')}` : ''}`);
    }
    for (const plan of coverage) for (const item of plan.unmapped) add('TASK_UNMAPPED', item.taskId, `${item.role} task "${item.question.slice(0, 120)}" names no asset reference, so the host reports an unmapped gap instead of a cell`);
  }

  // --- graph write-back: a mapping task that left nothing behind is owed work ---
  for (const writes of input.wrote ?? []) {
    if (writes.assets + writes.facts + writes.evidence + writes.findings !== 0 || writes.noNew) continue;
    for (const task of tasks) {
      if (task.role !== 'recon' || !isSatisfiedTask(task.status) || task.assignee !== writes.workerId) continue;
      add('MAPPING_UNRECORDED', task.id, `mapping task ${task.id} was reviewed with no graph write and no no-new note`);
    }
  }

  // --- depth: a demonstrated primitive nobody consumes ---
  for (const primitive of chainObligations({ plans, claims, tasks }).unchained) {
    add('PRIMITIVE_UNCHAINED', primitive.recordId, `${primitive.capability ?? 'a demonstrated primitive'} on ${primitive.surface ?? 'its surface'} has no successor step and no recorded wall`);
  }

  // --- triage: an open claim whose task already closed ---
  const taskById = new Map(tasks.map(task => [task.id, task]));
  for (const row of index.records) {
    if (row.kind !== 'candidate' || !row.id || replaced.has(row.id) || citedClaims.has(row.id)) continue;
    const data = (row.data ?? {}) as { closure?: unknown; taskRef?: unknown };
    if (data.closure !== 'open' || typeof data.taskRef !== 'string') continue;
    const task = taskById.get(data.taskRef);
    if (task && isSatisfiedTask(task.status)) add('CLAIM_UNTRIAGED', row.id, `open claim on ${task.surface} was accepted with the task review and never confirmed, ruled out or walled`);
  }

  // --- discharge: a deferred/blocked todo with a reason is the only prose wall ---
  const walls = new Set<string>();
  for (const plan of plans) {
    if (plan.kind !== 'todo' || (plan.status !== 'deferred' && plan.status !== 'blocked')) continue;
    for (const ref of plan.debtRefs ?? []) walls.add(ref);
  }
  const discharged = found.filter(item => !walls.has(item.id));
  const totals = Object.fromEntries(DEBT_KINDS.map(kind => [kind, 0])) as Record<DebtKind, number>;
  for (const item of discharged) totals[item.kind] += 1;
  const sorted = [...discharged].sort((a, b) => (KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)!) || a.subject.localeCompare(b.subject));
  const shown: DebtItem[] = [], seen = new Map<DebtKind, number>(), perKind = input.limits?.perKind ?? PER_KIND;
  for (const item of sorted) {
    const count = seen.get(item.kind) ?? 0;
    if (count >= perKind) continue;
    seen.set(item.kind, count + 1);
    shown.push(item);
  }
  return {
    items: shown,
    ids: sorted.map(item => item.id),
    gateableIds: sorted.filter(item => item.gateable).map(item => item.id),
    totals,
    total: sorted.length,
    gateable: sorted.filter(item => item.gateable).length,
    discharged: found.length - sorted.length,
  };
}

/** One sentence for a status line, a demand wake or a report header. Empty when nothing is owed. */
export function debtSummary(report: DebtReport): string | undefined {
  if (!report.gateable) return report.total ? `${report.total} advisory research item(s)` : undefined;
  const parts = DEBT_KINDS.filter(kind => report.totals[kind] > 0 && !ADVISORY.has(kind)).map(kind => `${kind} ${report.totals[kind]}`);
  return `${report.gateable} research debt item(s): ${parts.join(', ')}`;
}

/** The shape completion and the finish preflight need; keeps them from depending on the whole report. */
export interface DebtSummary { gateable: number; ids: readonly string[]; text?: string }
export function debtFor(report: DebtReport): DebtSummary | undefined {
  if (!report.gateable) return undefined;
  return { gateable: report.gateable, ids: report.gateableIds, ...(debtSummary(report) ? { text: debtSummary(report)! } : {}) };
}

// Kept local: a helper the callers above share when they need the mapped asset set without re-reading the projection.
export const projectedAssetIds = (plans: readonly CoveragePlanView[]): string[] => [...new Set(plans.flatMap(plan => plan.cells.map(cell => cell.assetRef.id)))];
