/**
 * planning_update.md P20/A2: what the run learned, and why a row is owed, as a projection of records it already owns.
 *
 * A round starts in a fresh session (P18.1/D45), so the planner sees an obligation-shaped brief and not the exploration history
 * behind it. The ledger already holds that history: a claim names its source task and pinned assets, an accepted case names the
 * claims and tasks it answers, a wall names the debt ids it discharges, and the rebuildable knowledge index already derives the
 * typed links between them. This module reads those, and nothing else: no I/O, no model call, no second store, no authority and
 * no truth upgrade. A learned row is background a later decision may cite; it can never satisfy a claim or a coverage cell.
 */
import { caseFrontier } from './cases.js';
import { claimAssetRefs, type ClaimFields } from './claims.js';
import { describeKnowledgeRecord } from './context.js';
import { wallRows } from './debt.js';
import { planFrontier, type PlanEntry } from './planning.js';
import type { AssessmentRecord, LedgerIndex } from './records.js';
import { GRAPH_RESPONSE_BYTES } from './state/graph.js';
import { validId } from './validate.js';

/** A claim recorded in the window, with the intent and the surface it came from. Reading it is not accepting it. */
export interface LearningClaim {
  recordId: string;
  candidate: string;
  /** `CANDIDATE_CLOSURES` value, or `unknown` for a record that did not carry one. */
  closure: string;
  execution?: string;
  /** `CANDIDATE_PROOFS` label when the author recorded one; never inferred here. */
  proof?: string;
  /** The host-stamped source task; absent on a claim recorded outside a task. */
  taskId?: string;
  /** The host-stamped pinned assets, never model input (R1.2). */
  assetIds: string[];
  /** Same-run ledger records the claim cited as support. */
  evidenceIds: string[];
  surface?: string;
  risk?: string;
}

/** An owner-accepted case in the window: a reviewed conclusion, still not goal proof. */
export interface LearningCase {
  recordId: string;
  caseId: string;
  verdict: string;
  reviewStatus: string;
  assetIds: string[];
  taskIds: string[];
  claimRefs: string[];
}

/** A deferred/blocked todo that walls work by naming the research-debt ids it answers (P19/C). */
export interface LearningWall {
  planId: string;
  recordId: string;
  title: string;
  status: string;
  debtRefs: string[];
}

export interface LearningsCounts { claims: number; cases: number; walls: number }

export interface RecentLearnings {
  /** The ledger position the window starts at: records `0 .. since-1` are history, not "this round". */
  since: number;
  /** Records the window covers (`records.length - since`), so a quiet window is measurable. */
  window: number;
  claims: LearningClaim[];
  cases: LearningCase[];
  walls: LearningWall[];
  /** True totals, including rows the page omits. */
  counts: LearningsCounts;
  /** `counts - shown`, per category, so "short" is never read as "none". */
  omitted: LearningsCounts;
}

export interface LearningsOptions {
  /** Ledger position, the same value the round window records (`roundWindow.records`). Defaults to 0: the whole run. */
  since?: number;
  /** Per-category page size. Defaults to 5; the true totals stay in `counts`. */
  limit?: number;
}

const clampLimit = (value: number | undefined): number => Number.isFinite(value) ? Math.max(1, Math.min(50, Math.floor(value!))) : 5;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined;

/** The claim fields this projection reads; the record is untyped ledger JSON, so each one is checked, never asserted. */
function learningClaim(record: AssessmentRecord): LearningClaim | undefined {
  const data = (record.data ?? {}) as ClaimFields & { candidate?: unknown; surface?: unknown; risk?: unknown };
  if (typeof data.candidate !== 'string' || !record.id) return undefined;
  const execution = text(data.execution), proof = text(data.proof), taskId = text(data.taskRef);
  return {
    recordId: record.id,
    candidate: data.candidate,
    closure: text(data.closure) ?? 'unknown',
    ...(execution ? { execution } : {}),
    ...(proof ? { proof } : {}),
    ...(taskId && validId(taskId) ? { taskId } : {}),
    assetIds: claimAssetRefs(data).map(ref => ref.id),
    evidenceIds: (record.refs ?? []).filter(validId),
    ...(text(data.surface) ? { surface: text(data.surface)! } : {}),
    ...(text(data.risk) ? { risk: text(data.risk)! } : {}),
  };
}

/**
 * What the run recorded in a ledger window: claims (one row per claim slug, its latest record), owner-accepted cases and walls.
 * Newest first, bounded per category. An empty window reads as zero recorded rows, which is a fact; it is not "nothing was
 * learned", because a round can also learn without recording (and that is exactly what the brief asks the planner to fix).
 */
export function recentLearnings(index: LedgerIndex, options: LearningsOptions = {}): RecentLearnings {
  const total = index.records.length;
  const since = Number.isFinite(options.since) ? Math.max(0, Math.min(total, Math.floor(options.since!))) : 0;
  const limit = clampLimit(options.limit);
  const position = new Map<string, number>();
  index.records.forEach((record, at) => { if (record.id) position.set(record.id, at); });

  // One row per claim slug: a later revision is the claim's current statement, so it replaces the earlier row in the window.
  const claims = new Map<string, { row: LearningClaim; at: number }>();
  index.records.forEach((record, at) => {
    if (record.kind !== 'candidate' || at < since) return;
    const row = learningClaim(record);
    if (row) claims.set(row.candidate, { row, at });
  });
  const claimRows = [...claims.values()].sort((left, right) => right.at - left.at);

  const cases = caseFrontier(index)
    .filter(entry => entry.reviewStatus === 'accepted')
    .flatMap(entry => {
      const at = position.get(entry.recordId);
      if (at === undefined || at < since) return [];
      const row: LearningCase = {
        recordId: entry.recordId, caseId: entry.id, verdict: entry.verdict, reviewStatus: entry.reviewStatus,
        assetIds: entry.assetRefs.map(ref => ref.id), taskIds: entry.taskRefs.map(ref => ref.taskId), claimRefs: entry.claimRefs,
      };
      return [{ row, at }];
    })
    .sort((left, right) => right.at - left.at)
    .map(item => item.row);

  const walls = wallRows(planFrontier(index))
    .flatMap(plan => {
      const at = position.get(plan.recordId);
      if (at === undefined || at < since) return [];
      const row: LearningWall = { planId: plan.id, recordId: plan.recordId, title: plan.title, status: plan.status, debtRefs: [...(plan.debtRefs ?? [])] };
      return [{ row, at }];
    })
    .sort((left, right) => right.at - left.at)
    .map(item => item.row);

  const counts: LearningsCounts = { claims: claimRows.length, cases: cases.length, walls: walls.length };
  const shown = { claims: claimRows.slice(0, limit), cases: cases.slice(0, limit), walls: walls.slice(0, limit) };
  return {
    since, window: total - since,
    claims: shown.claims.map(item => item.row), cases: shown.cases, walls: shown.walls, counts,
    omitted: { claims: counts.claims - shown.claims.length, cases: counts.cases - shown.cases.length, walls: counts.walls - shown.walls.length },
  };
}

/** The prior-run reference the run start recorded (`--refer-workspace`), reduced to counts. Context only, never evidence. */
export interface PriorRunContext {
  recordId: string;
  runs: Array<{ runId: string; currency?: string }>;
  gaps: { covered: number; leftOpen: number; stale: number; neverReached: number; unknown: number };
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * P20/A5: the most recent reference lifecycle record, as one bounded projection. Project knowledge from a prior run is a lookup
 * hint: it cannot satisfy this run's claim, cell or completion, so the caller renders the context-only label next to it.
 */
export function priorRunContext(index: LedgerIndex): PriorRunContext | undefined {
  for (let at = index.records.length - 1; at >= 0; at--) {
    const record = index.records[at]!;
    if (record.kind !== 'lifecycle' || !record.id) continue;
    const reference = object(record.data?.reference);
    if (!reference) continue;
    const runs = (Array.isArray(reference.runs) ? reference.runs : []).flatMap(item => {
      const row = object(item);
      const runId = row?.runId;
      if (!validId(runId)) return [];
      return [{ runId, ...(typeof row?.currency === 'string' ? { currency: row.currency } : {}) }];
    });
    const gaps = object(reference.gaps);
    const count = (value: unknown): number => Array.isArray(value) ? value.length : 0;
    const prior: PriorRunContext = {
      recordId: record.id, runs,
      gaps: { covered: count(gaps?.covered), leftOpen: count(gaps?.leftOpen), stale: count(gaps?.stale),
        neverReached: count(gaps?.neverReached), unknown: count(gaps?.unknown) },
    };
    if (!runs.length && !Object.values(prior.gaps).some(value => value > 0)) return undefined;
    return prior;
  }
  return undefined;
}

/** One reachable row of the lineage walk; `resolved: false` means the target id is not a projected knowledge head. */
export interface LineageRow {
  relation: string;
  domain: string;
  entityId: string;
  recordId?: string;
  depth: number;
  resolved: boolean;
}

export interface LineageNode { domain: string; entityId: string; recordId?: string; status?: string }

export interface LineageView {
  root: LineageNode;
  /** What the root stands on: the rows it cites (upstream). */
  upstream: LineageRow[];
  /** What stands on the root: rows that cite it (downstream). */
  downstream: LineageRow[];
  /** Rows discovered beyond `limit` in either direction, so a short list is not read as a complete one. */
  omitted: number;
}

export interface LineageOptions { depth?: number; limit?: number }

interface Node { recordId: string; at: number; domain: string; entityId: string; status: string; links: Array<[string, string]> }
interface Edge { relation: string; target?: Node; targetId?: string }
const nodeKey = (node: { domain: string; entityId: string }): string => `${node.domain}:${node.entityId}`;

/** Relation → target domain, for the links whose relation names a different vocabulary than the target's entity id. */
const RELATION_DOMAIN: Readonly<Record<string, string>> = {
  task: 'task', goal: 'goal', todo: 'todo', decision: 'decision', case: 'case', claim: 'candidate',
  'coverage-plan': 'coverage-plan', 'coverage-cell': 'coverage-cell', gap: 'gap', phase: 'phase', report: 'report',
  evidence: 'evidence', reference: 'reference', prerequisite: 'task', ref: 'gap',
};

/**
 * Upstream and downstream from one projected record, bounded by depth and row count. The edges are the same ones
 * `describeKnowledgeRecord` derives for the rebuildable index — task prerequisites/parent/validation/retest, plan task/goal
 * refs, claim task/asset refs, case claim/task/asset refs, coverage cell refs — so this read cannot disagree with the index
 * about what a row is connected to. A target that is not a knowledge head (a graph asset, an assertion) is reported
 * `resolved: false` instead of being dropped, because a missing target and an absent edge are different facts.
 */
export function lineageOf(index: LedgerIndex, id: string, options: LineageOptions = {}): LineageView | undefined {
  const nodes = new Map<string, Node>(), entities = new Map<string, Node>(), byEntityId = new Map<string, Node[]>();
  index.records.forEach((record, at) => {
    if (!record.id) return;
    const descriptor = describeKnowledgeRecord(record);
    if (!descriptor) return;
    const node: Node = { recordId: record.id, at, domain: descriptor.domain, entityId: descriptor.entityId, status: descriptor.status, links: descriptor.links };
    nodes.set(record.id, node);
    entities.set(nodeKey(node), node);
    const sameId = byEntityId.get(node.entityId);
    if (sameId) sameId.push(node); else byEntityId.set(node.entityId, [node]);
  });
  const resolve = (relation: string, targetId: string): Node | undefined => {
    const direct = nodes.get(targetId);
    if (direct) return direct;
    const domain = RELATION_DOMAIN[relation];
    const named = domain ? entities.get(`${domain}:${targetId}`) : undefined;
    if (named) return named;
    return byEntityId.get(targetId)?.at(-1);
  };
  const reverse = new Map<string, Edge[]>();
  for (const node of nodes.values()) for (const [relation, targetId] of node.links) {
    const target = resolve(relation, targetId);
    if (!target) continue;
    const edges = reverse.get(nodeKey(target));
    if (edges) edges.push({ relation, target: node }); else reverse.set(nodeKey(target), [{ relation, target: node }]);
  }
  const root = nodes.get(id) ?? (id.includes(':') ? entities.get(id) : undefined) ?? byEntityId.get(id)?.at(-1);
  if (!root) return undefined;

  const depth = Number.isFinite(options.depth) ? Math.max(1, Math.min(4, Math.floor(options.depth!))) : 2;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(80, Math.floor(options.limit!))) : 24;
  let omitted = 0;
  const walk = (direction: 'upstream' | 'downstream'): LineageRow[] => {
    const rows: LineageRow[] = [], seen = new Set<string>([nodeKey(root)]);
    let frontier: Node[] = [root];
    for (let at = 1; at <= depth && frontier.length; at++) {
      const next: Node[] = [];
      for (const node of frontier) {
        const edges: Edge[] = direction === 'upstream'
          ? node.links.map(([relation, targetId]) => {
            const target = resolve(relation, targetId);
            return target ? { relation, target } : { relation, targetId };
          })
          : reverse.get(nodeKey(node)) ?? [];
        for (const edge of edges) {
          const target = edge.target;
          const key = target ? nodeKey(target) : `?:${edge.relation}:${edge.targetId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const row: LineageRow = target
            ? { relation: edge.relation, domain: target.domain, entityId: target.entityId, recordId: target.recordId, depth: at, resolved: true }
            : { relation: edge.relation, domain: 'unknown', entityId: edge.targetId ?? '', depth: at, resolved: false };
          if (rows.length < limit) rows.push(row); else omitted++;
          if (target) next.push(target);
        }
      }
      frontier = next;
    }
    return rows;
  };
  return { root: { domain: root.domain, entityId: root.entityId, recordId: root.recordId, status: root.status },
    upstream: walk('upstream'), downstream: walk('downstream'), omitted };
}

/** Why a plan row is owed: the row itself, the claims it cites, the tasks those claims came from, and its lineage. */
export interface PlanWhy {
  plan: PlanEntry;
  goals: string[];
  claims: LearningClaim[];
  tasks: string[];
  upstream: LineageView;
}

/**
 * Answer "why is this plan row here?" from the same projections the brief uses: the claim refs resolve to the claims' recorded
 * closure/proof/task/asset identity, the goals it serves are named, and the walk names what those claims stand on. The row's own
 * reason and criteria stay on `plan`; this adds the links, not a second justification.
 */
export function whyPlanRow(index: LedgerIndex, planId: string): PlanWhy | undefined {
  const plan = planFrontier(index).find(entry => entry.id === planId);
  if (!plan) return undefined;
  const claims = (plan.claimRefs ?? []).flatMap(ref => {
    const record = index.byId.get(ref);
    if (!record || record.kind !== 'candidate') return [];
    const claim = learningClaim(record);
    return claim ? [claim] : [];
  });
  const tasks = [...new Set([...(plan.taskIds ?? []), ...claims.flatMap(claim => claim.taskId ? [claim.taskId] : [])])].sort();
  const upstream = lineageOf(index, plan.recordId, { depth: 2, limit: 16 });
  if (!upstream) return undefined;
  return { plan, goals: [...(plan.goalIds ?? [])], claims, tasks, upstream };
}

/** P20/A4: the bounded page a read verb returns, so a lineage walk cannot grow past the declared graph bound. */
export interface LineagePage {
  id: string;
  /** Always present: a projection is background, never a truth or authority upgrade. */
  label: string;
  /** Present when the id is a plan row id: the row itself, its goals, the claims it cites and the tasks behind them. */
  plan?: PlanEntry;
  goals?: string[];
  claims?: LearningClaim[];
  tasks?: string[];
  lineage: LineageView;
  /** True when the page was trimmed to fit {@link GRAPH_RESPONSE_BYTES}; the ledger still holds the untrimmed walk. */
  truncated: boolean;
}

export const LINEAGE_LABEL = 'background projection from this run records; not evidence, not coverage, not authority';

/**
 * P20/A4: one bounded read for "why does this intent exist". A plan id answers with the row, its goals, claims and tasks plus its
 * upstream walk; any other knowledge record id answers with its upstream and downstream walk. Rows are trimmed tail-first until
 * the page fits the graph response bound, and the page says it was trimmed instead of silently returning a shorter walk. No I/O,
 * no model, no write: the caller passes the index it already read.
 */
export function lineagePage(index: LedgerIndex, id: string, options: LineageOptions & { budget?: number } = {}): LineagePage | undefined {
  const depth = options.depth, limit = options.limit;
  const plan = whyPlanRow(index, id);
  const lineage = plan ? plan.upstream : lineageOf(index, id, { ...(depth !== undefined ? { depth } : {}), ...(limit !== undefined ? { limit } : {}) });
  if (!lineage) return undefined;
  const page: LineagePage = {
    id, label: LINEAGE_LABEL, lineage, truncated: false,
    ...(plan ? { plan: plan.plan, goals: plan.goals, claims: plan.claims, tasks: plan.tasks } : {}),
  };
  const budget = Number.isFinite(options.budget) ? Math.max(1024, Math.floor(options.budget!)) : GRAPH_RESPONSE_BYTES;
  while (Buffer.byteLength(JSON.stringify(page)) > budget) {
    if (page.lineage.downstream.length) page.lineage.downstream.pop();
    else if (page.lineage.upstream.length) page.lineage.upstream.pop();
    else if (page.claims?.length) page.claims.pop();
    else break;
    page.truncated = true;
  }
  return page;
}
