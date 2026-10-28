import { describe, expect, it } from 'vitest';
import { ESCALATION_DEMANDS, routeRound } from '../../src/round-model.js';
import { parseSettings, plannerModelCatalogue } from '../../src/roles.js';

/** P18.6/D50: the routing decision is pure, so the rule table and every escalation trigger are pinned here. */
describe('round model routing (P18.6/D50)', () => {
  const plannerModels = { base: 'fixture/base-model', escalate: 'fixture/escalation-model', thinkingBase: 'medium', thinkingEscalate: 'high' } as const;

  it('takes the base loadout for review, mapping and validation demands', () => {
    for (const demand of ['review', 'mapping', 'validation']) {
      expect(routeRound({ demand, plannerModels })).toEqual({
        modelId: 'fixture/base-model', thinking: 'medium', reason: expect.stringContaining('base loadout'), escalated: false,
      });
    }
  });

  it('takes the escalation loadout for exploitation and chaining demands', () => {
    for (const demand of ESCALATION_DEMANDS) {
      expect(routeRound({ demand, plannerModels })).toEqual({
        modelId: 'fixture/escalation-model', thinking: 'high', reason: expect.stringContaining(`demand ${demand}`), escalated: true,
      });
    }
  });

  it('takes the base loadout for the other named demands and for no demand at all', () => {
    for (const demand of ['discovery', 'investigation', 'refinement', 'retest', 'reporting']) {
      expect(routeRound({ demand, plannerModels })).toMatchObject({ modelId: 'fixture/base-model', thinking: 'medium', escalated: false });
    }
    expect(routeRound({ plannerModels })).toMatchObject({ modelId: 'fixture/base-model', thinking: 'medium', escalated: false, reason: expect.stringContaining('no escalation trigger') });
    // The field is the classified demand, not the brief's sentence: free text is not promoted into an escalation class.
    expect(routeRound({ demand: '  Exploitation ', plannerModels }).escalated).toBe(true);
    expect(routeRound({ demand: '2 demonstrated primitive(s) with no successor step', plannerModels }).escalated).toBe(false);
  });

  it('escalates after two consecutive rounds that closed nothing', () => {
    const rounds = (closed: number[]) => closed.map(value => ({ closed: value }));
    const route = routeRound({ demand: 'validation', plannerModels, previousRounds: rounds([3, 0, 0]) });
    expect(route).toMatchObject({ modelId: 'fixture/escalation-model', thinking: 'high', escalated: true });
    expect(route.reason).toContain('last two rounds closed nothing');
    // One closing-less round is not a streak; a round that closed something resets it.
    expect(routeRound({ demand: 'validation', plannerModels, previousRounds: rounds([0]) }).escalated).toBe(false);
    expect(routeRound({ demand: 'validation', plannerModels, previousRounds: rounds([0, 0]) }).escalated).toBe(true);
    expect(routeRound({ demand: 'validation', plannerModels, previousRounds: rounds([0, 0, 2]) }).escalated).toBe(false);
    // A malformed count cannot prove a closing-less round.
    expect(routeRound({ demand: 'validation', plannerModels, previousRounds: [{ closed: 0 }, { closed: '0' as unknown as number }] }).escalated).toBe(false);
  });

  it('escalates when the brief carries an unchained primitive or a ready chain step', () => {
    const primitive = routeRound({ demand: 'mapping', plannerModels, unchainedPrimitive: true });
    expect(primitive).toMatchObject({ modelId: 'fixture/escalation-model', thinking: 'high', escalated: true });
    expect(primitive.reason).toContain('unchained primitive');
    expect(routeRound({ demand: 'mapping', plannerModels, unchainedPrimitive: 2 }).reason).toContain('2 unchained primitives');
    const ready = routeRound({ demand: 'validation', plannerModels, readyChainStep: 1 });
    expect(ready).toMatchObject({ escalated: true, reason: expect.stringContaining('chain step is ready') });
    // Counts are facts: zero, false and malformed values carry nothing.
    for (const value of [false, 0, -3, Number.NaN] as const) {
      expect(routeRound({ demand: 'review', plannerModels, unchainedPrimitive: value, readyChainStep: value }).escalated).toBe(false);
    }
    // Every trigger that fired appears in the reason, not only the first.
    const all = routeRound({ demand: 'chaining', plannerModels, unchainedPrimitive: 2, readyChainStep: 3, previousRounds: [{ closed: 0 }, { closed: 0 }] });
    for (const phrase of ['demand chaining is exploitation/chaining', 'last two rounds closed nothing', '2 unchained primitives', '3 chain steps are ready']) expect(all.reason).toContain(phrase);
  });

  it('keeps the current model when p2o.plannerModels is absent (A12: routing is opt-in)', () => {
    const off = routeRound({ demand: 'exploitation', unchainedPrimitive: 2, readyChainStep: 1, previousRounds: [{ closed: 0 }, { closed: 0 }], currentModel: 'session/model', currentThinking: 'low' });
    expect(off.modelId).toBeUndefined();
    expect(off.thinking).toBeUndefined();
    expect(off.escalated).toBe(false);
    expect(off.reason).toContain('no p2o.plannerModels configured');
    expect(off.reason).toContain('session/model');
    expect(routeRound({ demand: 'validation', plannerModels: {}, currentModel: 'session/model' }).modelId).toBeUndefined();
    expect(routeRound({ demand: 'validation', plannerModels: null }).reason).toContain('no p2o.plannerModels configured');
  });

  it('does not substitute the other loadout when the selected one is not configured', () => {
    const baseOnly = routeRound({ demand: 'exploitation', plannerModels: { base: 'fixture/base-model' } });
    expect(baseOnly.modelId).toBeUndefined();
    expect(baseOnly.escalated).toBe(false);
    expect(baseOnly.reason).toContain('no escalation model');
    const escalateOnly = routeRound({ demand: 'validation', plannerModels: { escalate: 'fixture/escalation-model' } });
    expect(escalateOnly.modelId).toBeUndefined();
    expect(escalateOnly.reason).toContain('no base model');
  });

  it('routes one axis without inventing the other', () => {
    const thinkingOnly = routeRound({ demand: 'exploitation', plannerModels: { thinkingEscalate: 'max' } });
    expect(thinkingOnly.modelId).toBeUndefined();
    expect(thinkingOnly).toMatchObject({ thinking: 'max', escalated: true });
    const modelOnly = routeRound({ demand: 'validation', plannerModels: { base: 'fixture/base-model' } });
    expect(modelOnly).toMatchObject({ modelId: 'fixture/base-model', escalated: false });
    expect(modelOnly.thinking).toBeUndefined();
  });
});

describe('planner models setting (P18.6/D50)', () => {
  it('defaults to no routing and round-trips a complete configuration', () => {
    expect(parseSettings(undefined).plannerModels).toEqual({});
    expect(parseSettings({}).plannerModels).toEqual({});
    const parsed = parseSettings({ p2o: { plannerModels: { base: 'a/base', escalate: 'b/escalate', thinkingBase: 'medium', thinkingEscalate: 'xhigh' } } });
    expect(parsed.plannerModels).toEqual({ base: 'a/base', escalate: 'b/escalate', thinkingBase: 'medium', thinkingEscalate: 'xhigh' });
    expect(routeRound({ demand: 'validation', plannerModels: parsed.plannerModels })).toMatchObject({ modelId: 'a/base', thinking: 'medium', escalated: false });
    expect(routeRound({ demand: 'chaining', plannerModels: parsed.plannerModels })).toMatchObject({ modelId: 'b/escalate', thinking: 'xhigh', escalated: true });
  });

  it('drops malformed fields instead of guessing a model or a thinking level', () => {
    for (const raw of [null, 'nope', 42, ['a/base']]) expect(parseSettings({ p2o: { plannerModels: raw } }).plannerModels).toEqual({});
    for (const value of [42, '', '   ', 'x'.repeat(201), 'bad\u0000/model']) {
      expect(parseSettings({ p2o: { plannerModels: { base: value } } }).plannerModels).toEqual({});
    }
    for (const value of ['MAXIMUM', 'maximum', 'extreme', 'turbo', 7, '']) {
      expect(parseSettings({ p2o: { plannerModels: { thinkingEscalate: value } } }).plannerModels).toEqual({});
    }
    // A valid field survives its malformed neighbours, and unknown keys are ignored.
    const mixed = parseSettings({ p2o: { plannerModels: { base: '  a/base  ', escalate: 42, thinkingBase: 'turbo', thinkingEscalate: 'high', extra: 'x' } } });
    expect(mixed.plannerModels).toEqual({ base: 'a/base', thinkingEscalate: 'high' });
  });

  it('enumerates configured planner models for registry validation and never includes worker models', () => {
    expect(plannerModelCatalogue(parseSettings(undefined))).toEqual([]);
    expect(plannerModelCatalogue(parseSettings({ p2o: { roles: { general: { model: 'worker/model' } } } }))).toEqual([]);
    const configured = parseSettings({ p2o: { plannerModels: { base: 'zeta/base', escalate: 'alpha/escalate' } } });
    expect(plannerModelCatalogue(configured)).toEqual(['alpha/escalate', 'zeta/base']);
    expect(plannerModelCatalogue(parseSettings({ p2o: { plannerModels: { base: 'same/model', escalate: 'same/model' } } }))).toEqual(['same/model']);
  });
});
