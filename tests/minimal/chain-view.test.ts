import { describe, expect, it } from 'vitest';
import { chainJoin, chainTokens } from '../../src/chain-view.js';
import { fixture, populate } from './helpers/report-fixture.js';

// planning_update.md P5: the recorded provides/requires pair is the only chain edge, so "which step is next" is a
// deterministic join over claim text — no new persistence, no candidate→candidate edge store, no new authority.
const tested = (candidate: string, provides?: string, requires?: string) => ({ candidate, closure: 'confirmed', execution: 'tested', provides, requires });
const open = (candidate: string, requires?: string, provides?: string) => ({ candidate, closure: 'open_proof_gap', execution: 'not_tested', provides, requires });

describe('chain join (P5)', () => {
  it('normalizes prose into comparable tokens and drops stopwords, case and order', () => {
    expect(chainTokens('An authenticated session as Alice, the tenant owner')).toEqual(['alice', 'authenticated', 'owner', 'session', 'tenant']);
    expect(chainTokens('SELECTED object-identity')).toEqual(['identity', 'object', 'selected']);
    expect(chainTokens(undefined)).toEqual([]);
    expect(chainTokens('as of the to')).toEqual([]);
  });

  it('marks an open claim ready only when a confirmed+tested claim provides every token it requires', () => {
    const join = chainJoin([tested('first', 'a selected object identity the caller does not own'),
      open('second', 'a selected object identity'), open('third', 'a signed admin session for another tenant')]);
    expect(join.ready).toEqual(['second']);
    expect(join.unmet).toEqual(['third']);
    expect(join.uncovered).toEqual({ third: ['admin', 'another', 'session', 'signed', 'tenant'] });
    expect(join.primitives).toEqual(['first']);
  });

  it('never lets a claim satisfy its own requirement, nor a claim that is not confirmed and tested', () => {
    const selfOnly = chainJoin([open('loop', 'a selected object identity', 'a selected object identity')]);
    expect([selfOnly.ready, selfOnly.unmet]).toEqual([[], ['loop']]);
    const untested = chainJoin([{ candidate: 'recorded', closure: 'confirmed', execution: 'blocked', provides: 'a selected object identity' }, open('next', 'a selected object identity')]);
    expect([untested.ready, untested.unmet, untested.primitives]).toEqual([[], ['next'], []]);
    const ruledOut = chainJoin([{ candidate: 'closed', closure: 'ruled_out', provides: 'a selected object identity' }, open('next', 'a selected object identity')]);
    expect(ruledOut.unmet).toEqual(['next']);
  });

  it('reports the deepest ready path as the frontier and survives a provider cycle', () => {
    const join = chainJoin([tested('primitive', 'a parser that accepts a trailer'),
      tested('second', 'a type confusion in the trailer decoder', 'a parser that accepts a trailer'),
      open('third', 'a type confusion in the trailer decoder')]);
    expect(join.depth).toEqual({ primitive: 0, second: 1, third: 1 });
    // Shortest route wins: `primitive` already hands out what `third` needs, so the frontier path skips `second`.
    expect(join.frontier).toEqual([{ claimId: 'third', depth: 1, path: ['primitive', 'third'] }]);
    const cycle = chainJoin([tested('a', 'token b', 'token a'), tested('b', 'token a', 'token b')]);
    expect(cycle.frontier).toEqual([]);
  });

  it('is order-independent and bounded', () => {
    const claims = [tested('p', 'a session'), open('q', 'a session'), open('r', 'missing token'),
      ...Array.from({ length: 14 }, (_, index) => open(`s${index}`, 'a session'))];
    expect(chainJoin(claims)).toEqual(chainJoin([...claims].reverse()));
    expect(chainJoin(claims).frontier).toHaveLength(10);
    const wide = chainJoin([open('wide', 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo')]);
    expect(wide.uncovered.wide).toHaveLength(8);
  });

  it('reads the run’s own claims through the graph view, bounded by limit', async () => fixture(async h => {
    const built = await populate(h);
    const claim = (params: Record<string, unknown>) => h.call('p2o_candidate', { surface: '/report-fixture', risk: 'authorization', evidenceRefs: [built.observation.evidenceId],
      negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', ...params });
    await claim({ candidate: 'chain-primitive', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', provides: 'a selected object identity the caller does not own' });
    await claim({ candidate: 'chain-consumer', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', requires: 'a selected object identity' });
    const view = (await h.call('p2o_graph', { action: 'chain' })).details;
    expect(view.counts.ready).toBe(1);
    expect(view.primitives).toContain('chain-primitive');
    expect(view.ready).toEqual(['chain-consumer']);
    expect(view.frontier[0]).toMatchObject({ claimId: 'chain-consumer', depth: 1 });
    expect(view.frontier[0].path).toEqual(['chain-primitive', 'chain-consumer']);
    expect((await h.call('p2o_graph', { action: 'chain', limit: 1 })).details.ready).toHaveLength(1);
    await expect(h.call('p2o_graph', { action: 'chain', cursor: 1 })).rejects.toThrow(/Graph action/);
  }));
});
