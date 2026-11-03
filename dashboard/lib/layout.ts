/**
 * planning_update.md P2: the deterministic layered graph layout the client renders. Pure and framework-free — no DOM, no
 * measurement, no iteration over object keys — so `dashboard/test/layout.test.ts` can pin the same geometry the canvas uses.
 *
 * Column order is the plan's: guidance and start (origin/hint), goals, links and intents, facts and findings, then digests.
 * Digest rows are folded by default into one super-node; unfolding draws them again with their `covers` membership edges.
 */
import type { DashboardEdge, DashboardGraph, DashboardNode } from './model';
import { kindColumn, KIND_ORDER } from './vocabulary';

export const GRAPH_NODE_WIDTH = 190;
export const GRAPH_NODE_HEIGHT = 58;
export const GRAPH_COLUMN_GAP = 52;
export const GRAPH_ROW_GAP = 16;
export const GRAPH_MAX_NODES = 400;
export const GRAPH_FOCUS_DEPTH = 2;
export const FOLDED_DIGEST_ID = 'folded-digests';

const COLUMN_STRIDE = GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP;
const ROW_STRIDE = GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP;

export interface GraphLayoutOptions {
  maxNodes?: number;
  foldDigest?: boolean;
  /** Kinds to keep; empty or absent means every kind. */
  kinds?: readonly string[] | null;
  /** States to keep; empty or absent means every state. */
  states?: readonly string[] | null;
  /** Window the view around this node (two hops) instead of the first page of the ordered graph. */
  focusNodeId?: string | null;
}

export interface LayoutTotals {
  all: number;
  afterFilters: number;
  filteredOut: number;
  drawn: number;
  hiddenByBounds: number;
  foldedDigests: number;
  foldedCovered: number;
}

export interface LayoutNode {
  id: string; kind: string; state: string; column: number; row: number; x: number; y: number;
  node: DashboardNode;
  foldedDigest?: { rounds: number; covered: number };
}

export interface LayoutEdge { srcId: string; dstId: string; rel: string; inherited: boolean }

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  columns: number;
  totals: LayoutTotals;
  vocabulary: { kinds: string[]; states: string[] };
  unresolved: number;
  overflow: number;
  chainOrderTruncated: number;
  truncated: boolean;
}

const kindRank = (kind: string): number => {
  const index = (KIND_ORDER as readonly string[]).indexOf(kind);
  return index < 0 ? KIND_ORDER.length : index;
};

interface Candidate { node: DashboardNode; index: number }

export function layoutGraph(graph: DashboardGraph, options: GraphLayoutOptions = {}): GraphLayout {
  const limit = Math.max(1, Math.min(GRAPH_MAX_NODES, Math.trunc(options.maxNodes ?? GRAPH_MAX_NODES)));
  const foldDigest = options.foldDigest ?? true;
  const kindFilter = options.kinds && options.kinds.length ? new Set(options.kinds) : null;
  const stateFilter = options.states && options.states.length ? new Set(options.states) : null;

  const digestNodes = graph.nodes.filter(node => node.kind === 'digest');
  const covered = new Set<string>();
  for (const edge of graph.edges) if (edge.rel === 'covers') covered.add(edge.dstId);

  const candidates: Candidate[] = [];
  let filteredOut = 0;
  for (const [index, node] of graph.nodes.entries()) {
    if (foldDigest && node.kind === 'digest') continue;
    if ((kindFilter && !kindFilter.has(node.kind)) || (stateFilter && !stateFilter.has(node.state))) { filteredOut += 1; continue; }
    candidates.push({ node, index });
  }
  candidates.sort((left, right) => (kindColumn(left.node.kind) - kindColumn(right.node.kind)) || (left.index - right.index));

  const digestWanted = !kindFilter || kindFilter.has('digest');
  const digestStateWanted = !stateFilter || stateFilter.has('active') || stateFilter.has('superseded');
  const foldActive = foldDigest && digestNodes.length > 0 && digestWanted && digestStateWanted;
  const synthetic: DashboardNode | null = foldActive
    ? {
      id: FOLDED_DIGEST_ID, kind: 'digest', state: 'active', entityId: 'digest-fold',
      text: `${digestNodes.length} ${digestNodes.length === 1 ? 'digest node' : 'digest nodes'} covering ${covered.size} ${covered.size === 1 ? 'row' : 'rows'}`,
    }
    : null;

  const ordered: DashboardNode[] = candidates.map(candidate => candidate.node);
  if (synthetic) ordered.push(synthetic);
  const orderIndex = new Map<string, number>();
  candidates.forEach(candidate => orderIndex.set(candidate.node.id, candidate.index));
  if (synthetic) orderIndex.set(synthetic.id, Number.MAX_SAFE_INTEGER);

  const allowed = new Set(ordered.map(node => node.id));
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (foldDigest && edge.rel === 'covers') continue;
    if (!allowed.has(edge.srcId) || !allowed.has(edge.dstId)) continue;
    const from = adjacency.get(edge.srcId) ?? [];
    from.push(edge.dstId);
    adjacency.set(edge.srcId, from);
    const back = adjacency.get(edge.dstId) ?? [];
    back.push(edge.srcId);
    adjacency.set(edge.dstId, back);
  }

  const focusId = options.focusNodeId && allowed.has(options.focusNodeId) ? options.focusNodeId : null;
  let shown = ordered;
  if (focusId) {
    const seen = new Set<string>([focusId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: focusId, depth: 0 }];
    const neighbourhood: string[] = [focusId];
    while (queue.length) {
      const current = queue.shift()!;
      if (current.depth >= GRAPH_FOCUS_DEPTH) continue;
      for (const next of adjacency.get(current.id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        neighbourhood.push(next);
        queue.push({ id: next, depth: current.depth + 1 });
      }
    }
    const byId = new Map(ordered.map(node => [node.id, node]));
    shown = neighbourhood.slice(0, limit).map(id => byId.get(id)!).filter(Boolean);
  } else {
    shown = ordered.slice(0, limit);
  }

  // Layout order is the column then source order, never focus order: the same graph draws the same rows in any state.
  const drawn = [...shown].sort((left, right) => (kindColumn(left.kind) - kindColumn(right.kind)) || ((orderIndex.get(left.id) ?? 0) - (orderIndex.get(right.id) ?? 0)));
  const nextRow = new Map<number, number>();
  const nodes: LayoutNode[] = drawn.map(node => {
    const column = kindColumn(node.kind);
    const row = nextRow.get(column) ?? 0;
    nextRow.set(column, row + 1);
    return {
      id: node.id, kind: node.kind, state: node.state, column, row,
      x: column * COLUMN_STRIDE, y: row * ROW_STRIDE, node,
      ...(node.id === FOLDED_DIGEST_ID ? { foldedDigest: { rounds: digestNodes.length, covered: covered.size } } : {}),
    };
  });

  const drawnIds = new Set(nodes.map(node => node.id));
  const edges: LayoutEdge[] = graph.edges
    .filter((edge: DashboardEdge) => (foldDigest ? edge.rel !== 'covers' : true) && drawnIds.has(edge.srcId) && drawnIds.has(edge.dstId))
    .map(edge => ({ srcId: edge.srcId, dstId: edge.dstId, rel: edge.rel, inherited: Boolean(edge.inherited) }));

  const columns = nodes.reduce((max, node) => Math.max(max, node.column + 1), 0);
  const rows = nodes.reduce((max, node) => Math.max(max, node.row + 1), 0);
  const kindSet = new Set(graph.nodes.map(node => node.kind));
  const stateSet = new Set(graph.nodes.map(node => node.state));

  return {
    nodes, edges,
    width: columns ? columns * COLUMN_STRIDE - GRAPH_COLUMN_GAP : 0,
    height: rows ? rows * ROW_STRIDE - GRAPH_ROW_GAP : 0,
    columns,
    totals: {
      all: graph.nodes.length,
      afterFilters: ordered.length,
      filteredOut,
      drawn: nodes.length,
      hiddenByBounds: Math.max(0, ordered.length - nodes.length),
      foldedDigests: foldDigest ? digestNodes.length : 0,
      foldedCovered: foldDigest ? covered.size : 0,
    },
    vocabulary: {
      kinds: [...kindSet].sort((left, right) => (kindRank(left) - kindRank(right)) || left.localeCompare(right)),
      states: [...stateSet].sort((left, right) => left.localeCompare(right)),
    },
    unresolved: graph.unresolved,
    overflow: graph.overflow,
    chainOrderTruncated: graph.chainOrderTruncated,
    truncated: graph.truncated,
  };
}

/** Edge geometry in layout coordinates. Forward edges leave the source's right edge and enter the target's left edge; a
 *  backward edge (a fact proving an earlier goal) arches over the band instead of looping through it, so the curve cannot run
 *  across unrelated cards or leave the canvas. */
export function edgePath(layout: GraphLayout, edge: LayoutEdge): string {
  const nodes = new Map(layout.nodes.map(node => [node.id, node]));
  const src = nodes.get(edge.srcId), dst = nodes.get(edge.dstId);
  if (!src || !dst) return '';
  const x1 = src.x + GRAPH_NODE_WIDTH, y1 = src.y + GRAPH_NODE_HEIGHT / 2;
  const x2 = dst.x, y2 = dst.y + GRAPH_NODE_HEIGHT / 2;
  if (x2 >= x1) {
    const bend = Math.max(26, Math.min(88, (x2 - x1) / 2));
    return `M ${x1} ${y1} C ${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
  }
  const fromX = src.x + GRAPH_NODE_WIDTH / 2, toX = dst.x + GRAPH_NODE_WIDTH / 2;
  const top = Math.min(src.y, dst.y) - GRAPH_ROW_GAP - 10;
  return `M ${fromX} ${src.y} C ${fromX} ${top} ${toX} ${top} ${toX} ${dst.y}`;
}
