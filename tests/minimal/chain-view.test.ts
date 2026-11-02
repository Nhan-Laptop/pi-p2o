import { describe, expect, it } from 'vitest';
import { chainJoin, fitChainPage } from '../../src/chain-view.js';
import { fixture, populate, seedClaim } from './helpers/report-fixture.js';
import type { Capability, CapabilityKind } from '../../src/capabilities.js';
import type { PlanEntry } from '../../src/planning.js';

// planning_update.md P5 + P14.1: a claim's gained/needs pair is the only chain edge, and the pair is typed, so "which step is
// next" is a deterministic match — no new persistence, no candidate→candidate edge store, no new authority.
const cap = (kind: CapabilityKind, subject?: string): Capability => subject ? { kind, subject } : { kind };
const tested = (candidate: string, gained?: Capability[], needs?: Capability[]) => ({ candidate, closure: 'confirmed', execution: 'tested', gained, needs });
const open = (candidate: string, needs?: Capability[], gained?: Capability[]) => ({ candidate, closure: 'open_proof_gap', execution: 'not_tested', gained, needs });

describe('chain join (P5, typed by P14.1)', () => {
  it('marks an open claim ready only when a confirmed+tested claim gains every capability it needs', () => {
    const join = chainJoin([tested('first', [cap('data.read', 'object-identity')]),
      open('second', [cap('data.read', 'object-identity')]), open('third', [cap('cred.session')])]);
    expect(join.ready).toEqual(['second']);
    expect(join.unmet).toEqual(['third']);
    // A gap is a capability, so the lead reads the kind it is missing rather than a word that happened to be absent.
    expect(join.uncovered).toEqual({ third: [{ kind: 'cred.session' }] });
    expect(join.primitives).toEqual(['first']);
    expect(join.legacy).toEqual([]);
  });

  it('joins on kind and treats an unnamed subject as any, but a named one has to agree', () => {
    const generic = chainJoin([tested('any-session', [cap('cred.session')]), open('as-alice', [cap('cred.session', 'alice')])]);
    expect(generic.ready).toEqual(['as-alice']);
    const wrongSubject = chainJoin([tested('as-bob', [cap('cred.session', 'bob')]), open('as-alice', [cap('cred.session', 'alice')])]);
    expect(wrongSubject.unmet).toEqual(['as-alice']);
    expect(wrongSubject.uncovered).toEqual({ 'as-alice': [{ kind: 'cred.session', subject: 'alice' }] });
    const wrongKind = chainJoin([tested('reader', [cap('file.read')]), open('shell', [cap('host.shell')])]);
    expect(wrongKind.unmet).toEqual(['shell']);
  });

  it('never lets a claim satisfy its own need, nor a claim that is not confirmed and tested', () => {
    const selfOnly = chainJoin([open('loop', [cap('cred.session')], [cap('cred.session')])]);
    expect([selfOnly.ready, selfOnly.unmet]).toEqual([[], ['loop']]);
    const untested = chainJoin([{ candidate: 'recorded', closure: 'confirmed', execution: 'blocked', gained: [cap('cred.session')] }, open('next', [cap('cred.session')])]);
    expect([untested.ready, untested.unmet, untested.primitives]).toEqual([[], ['next'], []]);
    const ruledOut = chainJoin([{ candidate: 'closed', closure: 'ruled_out', gained: [cap('cred.session')] }, open('next', [cap('cred.session')])]);
    expect(ruledOut.unmet).toEqual(['next']);
  });

  it('reports pre-P14 text as legacy: readable, reported once, and joined to nothing', () => {
    // W-F/F1: these exact phrases don't match classifyLegacyKind's keyword table (checked), so they still join to
    // nothing here — a future expansion of that table could change that; re-run this fixture if it does.
    // A record written before this vocabulary: `provides` text instead of `gained`.
    const legacyProvider = { candidate: 'old', closure: 'confirmed', execution: 'tested', provides: 'a selected object identity' };
    const join = chainJoin([legacyProvider, open('next', [cap('data.read', 'object-identity')])]);
    expect(join.legacy).toEqual(['old']);
    expect(join.unmet).toEqual(['next']);
    expect(join.ready).toEqual([]);
    expect(join.primitives).toEqual(['old']); // still a starting point, just not a typed one
    // The same text on the consumer side is legacy too, and it cannot be satisfied by a typed provider either.
    const consumerSide = chainJoin([tested('typed', [cap('data.read')]), { candidate: 'old-need', closure: 'open_proof_gap', requires: 'an object identity' }]);
    expect(consumerSide.legacy).toEqual(['old-need']);
    expect(consumerSide.uncovered['old-need']).toEqual([{ legacy: 'an object identity' }]);
  });

  it('reports the deepest ready path as the frontier and survives a provider cycle', () => {
    const join = chainJoin([tested('primitive', [cap('http.request')]),
      tested('second', [cap('deserialize')], [cap('http.request')]),
      open('third', [cap('deserialize')])]);
    expect(join.depth).toEqual({ primitive: 0, second: 1, third: 2 });
    // P14.10: a frontier step carries what it consumes, which recorded claims provide it, and where it was demonstrated.
    expect(join.frontier).toEqual([{ claimId: 'third', depth: 2, path: ['primitive', 'second', 'third'], needs: [{ kind: 'deserialize' }], providers: [] }]);
    // Shortest route wins: `primitive` already gains what `third` needs, so the frontier path skips `second`.
    const direct = chainJoin([tested('primitive', [cap('deserialize')]), tested('second', [cap('deserialize')], [cap('http.request')]),
      open('third', [cap('deserialize')])]);
    expect(direct.frontier).toEqual([{ claimId: 'third', depth: 1, path: ['primitive', 'third'], needs: [{ kind: 'deserialize' }], providers: [] }]);
    const cycle = chainJoin([tested('a', [cap('exec.code')], [cap('host.shell')]), tested('b', [cap('host.shell')], [cap('exec.code')])]);
    expect(cycle.frontier).toEqual([]);
  });

  it('is order-independent and bounded', () => {
    const claims = [tested('p', [cap('cred.session')]), open('q', [cap('cred.session')]), open('r', [cap('file.write')]),
      ...Array.from({ length: 14 }, (_, index) => open(`s${index}`, [cap('cred.session')]))];
    expect(chainJoin(claims)).toEqual(chainJoin([...claims].reverse()));
    expect(chainJoin(claims).frontier).toHaveLength(10);
    const wide = chainJoin([open('wide', ['net.egress', 'http.request', 'auth.bypass', 'cred.session', 'cred.secret', 'file.read', 'file.write', 'exec.code', 'db.query', 'deserialize']
      .map(kind => ({ kind } as Capability)))]);
    expect(wide.uncovered.wide).toHaveLength(8);
  });

  it('reads the run’s own claims through the graph view, bounded by limit', async () => fixture(async h => {
    const built = await populate(h);
    // A2: the claims are worker-authored; the fixture seeds the records the broker would commit.
    const claim = (params: Record<string, unknown>) => seedClaim(h, { surface: '/report-fixture', risk: 'authorization', evidenceRefs: [built.observation.evidenceId],
      negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', ...params });
    await claim({ candidate: 'chain-primitive', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', gained: [{ kind: 'data.read', subject: 'object-identity' }] });
    await claim({ candidate: 'chain-consumer', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', needs: [{ kind: 'data.read', subject: 'object-identity' }] });
    const view = (await h.call('p2o_graph_plan', { action: 'chain' })).details;
    expect(view.counts.ready).toBe(1);
    expect(view.primitives).toContain('chain-primitive');
    expect(view.ready).toEqual(['chain-consumer']);
    expect(view.frontier[0]).toMatchObject({ claimId: 'chain-consumer', depth: 1 });
    expect(view.frontier[0].path).toEqual(['chain-primitive', 'chain-consumer']);
    expect((await h.call('p2o_graph_plan', { action: 'chain', limit: 1 })).details.ready).toHaveLength(1);
    await expect(h.call('p2o_graph_plan', { action: 'chain', cursor: 1 })).rejects.toThrow(/Graph plan action/);
  }));
});

/**
 * W-W/F17/H14: two readiness truths become one per owner. With the plan board supplied, a claim a plan row cites is answered by
 * that row's own link (the board's readiness) and its frontier path follows the citations the board resolved, so a printed
 * plan chain cannot mix chains; a claim no row cites keeps the capability answer, because a new branch still has to be plannable.
 */
describe('chain join scoped by the plan board (W-W/F17)', () => {
  const withRecord = <T extends object>(claim: T, recordId: string): T & { recordId: string; recordIds: string[] } =>
    ({ ...claim, recordId, recordIds: [recordId] });
  const row = (id: string, chainOf: string, step: number, patch: Record<string, unknown> = {}): PlanEntry => ({
    id, runId: 'run', revision: 1, recordId: `rec-${id}`, kind: 'todo', title: id, status: 'open', reason: 'F17 fixture chain row', chainOf, step, ...patch,
  } as PlanEntry);
  it('answers a planned claim from its own row and keeps the unplanned capability answer', () => {
    const claims = [withRecord(tested('provider-z', [cap('data.read')]), 'rec-z'), withRecord(tested('provider-a', [cap('data.read')]), 'rec-a'),
      withRecord(open('step-b', [cap('data.read')]), 'rec-b'), withRecord(open('step-c', [cap('data.read')]), 'rec-c'),
      withRecord(open('step-d', [cap('data.read')]), 'rec-d')];
    const plans = [row('plan-x1', 'chain-x', 1, { status: 'done', claimRefs: ['rec-a'] }),
      row('plan-x2', 'chain-x', 2, { claimRefs: ['rec-b'], needs: [{ kind: 'data.read' }] }),
      // The plan says this step waits on a capability nothing demonstrated; the global pool would call the claim ready anyway.
      row('plan-w1', 'chain-w', 1, { claimRefs: ['rec-c'], needs: [{ kind: 'host.shell' }] })];
    const global = chainJoin(claims), scoped = chainJoin(claims, plans);
    // The global answer is the capability join: one demonstrated provider anywhere makes both claims ready.
    expect(global).not.toHaveProperty('planScoped');
    expect(global.ready).toEqual(['step-b', 'step-c', 'step-d']);
    expect(global.frontier.find(path => path.claimId === 'step-b')!.path).toEqual(['provider-z', 'step-b']);
    // The scoped answer: step-b is ready through its own chain's cited provider, and its path is that chain's lineage.
    expect(scoped.planScoped).toBe(true);
    expect(scoped.ready).toEqual(['step-b', 'step-d']);
    expect(scoped.unmet).toEqual(['step-c']);
    expect(scoped.uncovered['step-c']).toEqual([{ kind: 'host.shell' }]);
    expect(scoped.frontier.find(path => path.claimId === 'step-b')).toMatchObject({
      path: ['provider-a', 'step-b'], planChain: 'chain-x', depth: 1, providers: ['rec-a'], needs: [{ kind: 'data.read' }] });
    expect(scoped.frontier.find(path => path.claimId === 'step-c')).toBeUndefined();
    // A claim no plan row cites keeps the capability answer, so a branch the lead has not written into a chain can still be planned.
    const unplanned = scoped.frontier.find(path => path.claimId === 'step-d')!;
    expect(unplanned.path).toEqual(['provider-z', 'step-d']);
    expect(unplanned).not.toHaveProperty('planChain');
  });
});

describe('chain page bound (S1/C2, F-42)', () => {
  const page = (overrides: Record<string, unknown> = {}) => ({ primitives: ['p1', 'p2'], ready: ['r1', 'r2'], unmet: ['u1', 'u2'],
    frontier: [{ claimId: 'f1', depth: 1, path: ['a', 'b'] }, { claimId: 'f2', depth: 2, path: ['a', 'c'] }],
    counts: { primitives: 5, ready: 5, unmet: 5, frontier: 5 }, shown: { primitives: 2, ready: 2, unmet: 2, frontier: 2 },
    next: 'f1', ...overrides });

  it('trims listed rows tail-first, keeps the true counts and lowers only shown', () => {
    const whole = page();
    const total = Buffer.byteLength(JSON.stringify(whole));
    const fitted = fitChainPage(whole, total - 20);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(total - 20);
    expect(fitted.counts).toEqual(whole.counts);
    expect(fitted.frontier).toEqual([whole.frontier[0]]);
    expect(fitted.shown.frontier).toBe(1);
  });

  it('leaves a page that already fits untouched, and keeps at least one frontier row before refusing', () => {
    const whole = page();
    expect(fitChainPage(whole)).toEqual(whole);
    const crowded = page({ primitives: Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, pad: 'x'.repeat(400) })),
      ready: Array.from({ length: 6 }, (_, index) => ({ id: `r${index}`, pad: 'x'.repeat(400) })) });
    const fitted = fitChainPage(crowded, 1_200);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(1_200);
    expect(fitted.counts).toEqual(crowded.counts);
    expect(fitted.frontier).toHaveLength(1);
    expect(fitted.shown.ready).toBeLessThanOrEqual(crowded.shown.ready);
    expect(() => fitChainPage(page({ frontier: [{ claimId: 'x'.repeat(400) }] }), 120)).toThrow(/cannot fit/);
  });
});
