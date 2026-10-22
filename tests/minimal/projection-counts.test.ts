import { describe, expect, it } from 'vitest';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * planning_update.md P11 (E5): every capped projection states what it shows against what exists, so a short or empty page is
 * never read as an empty board. ARTEX's in-code reason is the same one (`agent/tools.go:429-431`): two keys side by side are
 * self-describing, and the planner must not mistake "not displayed" for "never dispatched". Caps are unchanged by this step.
 */
const details = (result: any) => result.details;
const pair = (value: any, label: string) => {
  expect(Number.isInteger(value.total), `${label} total`).toBe(true);
  expect(Number.isInteger(value.shown), `${label} shown`).toBe(true);
  expect(value.shown, `${label} shown ≤ total`).toBeLessThanOrEqual(value.total);
  if ('omitted' in value) expect(value.omitted, `${label} omitted`).toBe(value.total - value.shown);
  return value as { total: number; shown: number };
};

describe('capped projections state shown against total (P11)', () => {
  it('answers with a denominator on every list the lead reads', async () => fixture(async h => {
    await populate(h);
    pair(details(await h.call('p2o_task', { action: 'list' })), 'p2o_task list');
    pair(details(await h.call('p2o_case', { action: 'list' })), 'p2o_case list');
    pair(details(await h.call('p2o_plan', { action: 'list' })), 'p2o_plan list');
    pair(details(await h.call('p2o_coverage', { action: 'list' })), 'p2o_coverage list');
    pair(details(await h.call('p2o_ledger', {})), 'p2o_ledger');
    // The graph has two shapes: a current-head export (counts + shown per kind) and a sequence page (total/shown/omitted).
    const view: any = details(await h.call('p2o_graph', { action: 'export' }));
    for (const kind of ['assets', 'assertions', 'relations', 'anchors'] as const) {
      expect(Number.isInteger(view.counts[kind]), `graph view counts.${kind}`).toBe(true);
      expect(view.shown[kind], `graph view shown.${kind}`).toBeLessThanOrEqual(view.counts[kind]);
    }
    pair(details(await h.call('p2o_graph', { action: 'page', limit: 1 })), 'p2o_graph page');
    const chain: any = details(await h.call('p2o_graph', { action: 'chain', limit: 1 }));
    for (const kind of ['primitives', 'ready', 'unmet', 'frontier'] as const) {
      expect(chain.shown[kind], `chain shown.${kind}`).toBeLessThanOrEqual(chain.counts[kind]);
      expect(Number.isInteger(chain.counts[kind]), `chain counts.${kind}`).toBe(true);
    }
    // The planning suggestion page used to name its denominator `matched`, which made it unreadable as a page.
    pair(details(await h.call('p2o_coverage', { action: 'suggest', features: ['login'] })), 'p2o_coverage suggest');
    // p2o_workers carries two lists (recent changes, the task tail) plus a separate reconciliation omission count.
    const state: any = details(await h.call('p2o_workers', { action: 'list' }));
    pair(state.navigation.changes, 'p2o_workers changes');
    pair(state.navigation.tasks, 'p2o_workers tasks');
    expect(state.navigation.tasks.shown).toBeLessThanOrEqual(10);
    expect(state.navigation.reconciliation.omitted, 'reconciliation omissions stay a separate meaning').toBeGreaterThanOrEqual(0);
  }));

  it('builds every page through one constructor, so a new page cannot pick its own names', async () => {
    const { counted, countedTail, assertCounted } = await import('../../src/counts.js');
    const items = ['a', 'b', 'c'];
    expect(counted(items, { cursor: 1, limit: 1 })).toMatchObject({ total: 3, shown: 1, omitted: 2, cursor: 1, nextCursor: 2, entries: ['b'] });
    expect(counted(items)).toMatchObject({ total: 3, shown: 3, omitted: 0 });
    expect(counted(items, { cursor: 3 })).toMatchObject({ total: 3, shown: 0, omitted: 3 });
    expect(() => counted(items, { cursor: 4 })).toThrow(/Invalid page cursor/);
    expect(() => counted(items, { limit: 0 })).toThrow(/Invalid page cursor\/limit/);
    expect(countedTail(items, items.slice(-2))).toMatchObject({ total: 3, shown: 2, omitted: 1, cursor: 1 });
    expect(assertCounted({ total: 0, shown: 0, omitted: 0, cursor: 0 })).toMatchObject({ total: 0 });
  });

  it('keeps a truncated page navigable instead of silently dropping the remainder', async () => fixture(async h => {
    await populate(h); // one accepted case and one pending case
    // Two cases against a one-item cap: the second page must be reachable, and both pages must agree on the denominator.
    const first: any = details(await h.call('p2o_case', { action: 'list', limit: 1 }));
    expect(first).toMatchObject({ total: 2, shown: 1, omitted: 1, nextCursor: 1 });
    const second: any = details(await h.call('p2o_case', { action: 'list', limit: 1, cursor: first.nextCursor }));
    expect(second).toMatchObject({ total: 2, shown: 1 });
    expect(second.entries[0].id).not.toBe(first.entries[0].id);
    // An empty page still carries the denominator, so "nothing on this page" cannot be read as "nothing exists".
    const empty: any = details(await h.call('p2o_case', { action: 'list', cursor: 2 }));
    expect(empty).toMatchObject({ total: 2, shown: 0, omitted: 2 });
  }));
});

// P13(e): the action → allowed-parameter map used to be a nested ternary ending in a default branch, so a new action silently
// inherited whatever the last branch accepted. Each table is now exhaustive over its declared actions; this test pins that.
describe('action parameter tables are exhaustive (P13e)', () => {
  it('declares exactly one row per action and never a wildcard', async () => {
    const { TASK_ACTIONS, TASK_ACTION_PARAMETERS } = await import('../../src/tool-schemas.js');
    const { CASE_ACTIONS, CASE_ACTION_PARAMETERS, COVERAGE_ACTIONS, COVERAGE_ACTION_PARAMETERS } = await import('../../src/case-tool.js');
    const { PLAN_ACTIONS, PLAN_ACTION_PARAMETERS } = await import('../../src/work-tool.js');
    const { GRAPH_ACTIONS, GRAPH_ACTION_PARAMETERS } = await import('../../src/state/graph-tool.js');
    for (const [actions, table] of [[TASK_ACTIONS, TASK_ACTION_PARAMETERS], [CASE_ACTIONS, CASE_ACTION_PARAMETERS], [COVERAGE_ACTIONS, COVERAGE_ACTION_PARAMETERS], [PLAN_ACTIONS, PLAN_ACTION_PARAMETERS], [GRAPH_ACTIONS, GRAPH_ACTION_PARAMETERS]] as const) {
      expect(Object.keys(table).sort()).toEqual([...actions].sort());
      for (const action of actions) {
        const allowed = (table as Record<string, readonly string[]>)[action];
        expect(allowed.length, action).toBeGreaterThan(0);
        expect(allowed, `${action} must allow its own action field`).toContain('action');
        expect(new Set(allowed).size, `${action} duplicates`).toBe(allowed.length);
      }
    }
    // The two behaviours the old default branch used to hide, stated explicitly.
    expect(TASK_ACTION_PARAMETERS.dispatch).toContain('ids');
    expect(TASK_ACTION_PARAMETERS.list).toContain('cursor');
    expect(GRAPH_ACTION_PARAMETERS.chain).not.toContain('cursor');
  });
});

/**
 * planning_update.md P13(h): the payload shapes are declared in `src/tool-results.ts`, so a dropped field is a type error rather
 * than a silent gap. The runtime half of that contract is that the declared keys are the ones actually sent.
 */
describe('declared result shapes match what the tools send (P13h)', () => {
  it('keeps every declared field present in the live payloads', async () => fixture(async h => {
    await populate(h);
    const chain: any = details(await h.call('p2o_graph', { action: 'chain' }));
    for (const key of ['primitives', 'ready', 'unmet', 'uncovered', 'frontier', 'depth', 'counts', 'shown', 'next']) expect(chain).toHaveProperty(key);
    expect(Object.keys(chain.counts).sort()).toEqual(Object.keys(chain.shown).sort());
    const workers: any = details(await h.call('p2o_workers', {}));
    const navigation = workers.navigation;
    // The two lists keep separate denominators, and reconciliation omissions are not one of them.
    expect(navigation.changes).toEqual(expect.objectContaining({ total: expect.any(Number), shown: expect.any(Number), omitted: expect.any(Number) }));
    expect(navigation.tasks).toEqual(expect.objectContaining({ total: expect.any(Number), shown: expect.any(Number) }));
    expect(navigation.reconciliation.omitted).toEqual(expect.any(Number));
    expect(navigation.progress).toEqual(expect.any(Array));
  }));
});
