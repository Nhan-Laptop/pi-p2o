import { describe, expect, it } from 'vitest';
import { edgePath, FOLDED_DIGEST_ID, GRAPH_COLUMN_GAP, GRAPH_MAX_NODES, GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, GRAPH_ROW_GAP, layoutGraph } from '../lib/layout';
import type { DashboardGraph, DashboardNode } from '../lib/model';

const node = (id: string, kind: string, patch: Partial<DashboardNode> = {}): DashboardNode =>
  ({ id, kind, state: 'active', entityId: id, text: `${kind} ${id}`, ...patch });

const graph = (nodes: DashboardNode[], edges: Array<[string, string, string]> = [], patch: Partial<DashboardGraph> = {}): DashboardGraph => ({
  label: 'derived projection', runId: 'run-x', asOfSequence: 10, graphVersion: 3,
  nodes,
  edges: edges.map(([srcId, rel, dstId]) => ({ srcId, rel, dstId })),
  anchors: [], counts: { nodes: nodes.length, edges: edges.length, anchors: 0 },
  unresolved: 0, overflow: 0, chainOrderTruncated: 0, truncated: false,
  ...patch,
});

const basic = (): DashboardGraph => graph(
  [
    node('origin-x', 'origin', { state: 'current' }),
    node('hint-a', 'hint'),
    node('goal-a', 'goal'),
    node('intent-a', 'intent'),
    node('link-a', 'link'),
    node('fact-a', 'fact'),
    node('finding-a', 'finding'),
  ],
  [
    ['origin-x', 'spawns', 'goal-a'],
    ['goal-a', 'derived_from', 'intent-a'],
    ['intent-a', 'yields', 'fact-a'],
    ['fact-a', 'proves', 'goal-a'],
  ],
);

describe('layered layout', () => {
  it('places each kind in the plan column order and never overlaps two rows in a column', () => {
    const layout = layoutGraph(basic());
    const columnOf = new Map(layout.nodes.map(item => [item.id, item.column]));
    expect(columnOf.get('origin-x')).toBe(0);
    expect(columnOf.get('hint-a')).toBe(0);
    expect(columnOf.get('goal-a')).toBe(1);
    expect(columnOf.get('intent-a')).toBe(2);
    expect(columnOf.get('link-a')).toBe(2);
    expect(columnOf.get('fact-a')).toBe(3);
    expect(columnOf.get('finding-a')).toBe(3);
    for (const item of layout.nodes) {
      expect(item.x).toBe(item.column * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP));
      expect(item.y).toBe(item.row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP));
    }
    const slots = new Set(layout.nodes.map(item => `${item.column}:${item.row}`));
    expect(slots.size).toBe(layout.nodes.length);
    expect(layout.columns).toBe(4);
    expect(layout.width).toBe(3 * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP) + GRAPH_NODE_WIDTH);
  });

  it('is deterministic: the same graph and options draw the same geometry in the same order', () => {
    const first = layoutGraph(basic(), { foldDigest: true });
    const second = layoutGraph(basic(), { foldDigest: true });
    expect(second).toEqual(first);
    expect(layoutGraph(basic(), { foldDigest: true, kinds: ['goal', 'fact'] })).toEqual(layoutGraph(basic(), { foldDigest: true, kinds: ['goal', 'fact'] }));
  });

  it('keeps only edges whose ends are both drawn', () => {
    const layout = layoutGraph(basic(), { kinds: ['goal'] });
    expect(layout.totals.drawn).toBe(1);
    expect(layout.edges).toEqual([]);
  });
});

describe('digest folding', () => {
  const withDigest = (): DashboardGraph => graph(
    [
      node('origin-x', 'origin', { state: 'current' }),
      node('goal-a', 'goal'),
      node('digest-1', 'digest'),
      node('digest-2', 'digest', { state: 'superseded' }),
    ],
    [
      ['origin-x', 'spawns', 'goal-a'],
      ['digest-1', 'covers', 'origin-x'],
      ['digest-1', 'covers', 'goal-a'],
      ['digest-2', 'covers', 'goal-a'],
    ],
  );

  it('folds digest rows into one super-node by default and drops the membership edges', () => {
    const layout = layoutGraph(withDigest());
    expect(layout.nodes.some(item => item.kind === 'digest' && item.id !== FOLDED_DIGEST_ID)).toBe(false);
    const folded = layout.nodes.find(item => item.id === FOLDED_DIGEST_ID)!;
    expect(folded.foldedDigest).toEqual({ rounds: 2, covered: 2 });
    expect(folded.column).toBe(4);
    expect(layout.edges.some(edge => edge.rel === 'covers')).toBe(false);
    expect(layout.totals.foldedDigests).toBe(2);
    expect(layout.totals.foldedCovered).toBe(2);
  });

  it('draws digest rows and their covers edges when unfolding, with a stable order', () => {
    const layout = layoutGraph(withDigest(), { foldDigest: false });
    const digests = layout.nodes.filter(item => item.kind === 'digest');
    expect(digests.map(item => item.id)).toEqual(['digest-1', 'digest-2']);
    expect(digests.every(item => item.column === 4)).toBe(true);
    expect(layout.edges.filter(edge => edge.rel === 'covers').map(edge => edge.dstId)).toEqual(['origin-x', 'goal-a', 'goal-a']);
    expect(layout.nodes.some(item => item.id === FOLDED_DIGEST_ID)).toBe(false);
  });

  it('hides the super-node when the kind filter excludes digests', () => {
    const layout = layoutGraph(withDigest(), { kinds: ['origin', 'goal'] });
    expect(layout.nodes.map(item => item.id)).toEqual(['origin-x', 'goal-a']);
    expect(layout.totals.foldedDigests).toBe(2);
  });
});

describe('filters, bounds and focus', () => {
  it('counts filter-hidden rows without pretending folding is a filter', () => {
    const layout = layoutGraph(basic(), { kinds: ['goal', 'fact'], states: ['active'] });
    expect(layout.totals.all).toBe(7);
    expect(layout.totals.filteredOut).toBe(5);
    expect(layout.nodes.map(item => item.kind)).toEqual(['goal', 'fact']);
  });

  it('bounds the drawn page at 400 nodes and reports what fell outside it', () => {
    const nodes = Array.from({ length: 420 }, (_, index) => node(`fact-${String(index).padStart(3, '0')}`, 'fact'));
    const layout = layoutGraph(graph(nodes));
    expect(GRAPH_MAX_NODES).toBe(400);
    expect(layout.totals.drawn).toBe(GRAPH_MAX_NODES);
    expect(layout.totals.hiddenByBounds).toBe(20);
    expect(layout.nodes[0]!.id).toBe('fact-000');
    expect(layout.nodes.at(-1)!.id).toBe('fact-399');
  });

  it('honours a smaller maxNodes option', () => {
    const layout = layoutGraph(basic(), { maxNodes: 2 });
    expect(layout.totals.drawn).toBe(2);
    expect(layout.totals.hiddenByBounds).toBe(5);
  });

  it('windows two hops around a focus node and keeps the focus itself', () => {
    const chain = graph(
      [node('a', 'goal'), node('b', 'intent'), node('c', 'intent'), node('d', 'fact')],
      [['a', 'derived_from', 'b'], ['b', 'derived_from', 'c'], ['c', 'yields', 'd']],
    );
    const layout = layoutGraph(chain, { focusNodeId: 'a' });
    expect(layout.nodes.map(item => item.id).sort()).toEqual(['a', 'b', 'c']);
    expect(layout.totals.hiddenByBounds).toBe(1);
    expect(layoutGraph(chain, { focusNodeId: 'missing' }).totals.drawn).toBe(4);
  });

  it('marks inherited rows and edges so the canvas can draw them apart', () => {
    const inheritedGraph = graph(
      [node('origin-x', 'origin'), node('finding-a', 'finding', { inherited: 'run-prev' })],
      [['origin-x', 'yields', 'finding-a']],
    );
    const layout = layoutGraph(inheritedGraph);
    expect(layout.nodes.find(item => item.id === 'finding-a')!.node.inherited).toBe('run-prev');
    expect(layout.edges[0]!.inherited).toBe(false);
  });

  it('surfaces the derivation counters the data carries', () => {
    const layout = layoutGraph(graph([node('a', 'goal')], [], { unresolved: 3, overflow: 5, chainOrderTruncated: 2, truncated: true }));
    expect([layout.unresolved, layout.overflow, layout.chainOrderTruncated, layout.truncated]).toEqual([3, 5, 2, true]);
  });
});

describe('edge geometry', () => {
  it('draws a cubic between node edges and nothing for a missing end', () => {
    const layout = layoutGraph(basic());
    const edge = layout.edges.find(candidate => candidate.srcId === 'origin-x')!;
    expect(edgePath(layout, edge)).toMatch(/^M \d+ \d+ C /);
    expect(edgePath(layout, { srcId: 'nope', dstId: 'goal-a', rel: 'spawns', inherited: false })).toBe('');
  });
});
