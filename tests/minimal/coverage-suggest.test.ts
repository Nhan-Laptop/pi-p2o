import { describe, expect, it } from 'vitest';
import { WSTG_FEATURES, WSTG_MAP, featuresFromAttributeValues, wstgKey, wstgSuggest } from '../../src/wstg-map.js';
import { fixture, populate } from './helpers/report-fixture.js';

/** P6a: a read-only planning aid over the shipped WSTG map. Hermetic: no model, no target, no write. */
describe('wstgSuggest', () => {
  it('matches a test by any of its trigger features, always includes the any-trigger tests, and never returns an out-of-scope test', () => {
    const none = wstgSuggest(['any'], { covered: new Set() });
    expect(none.matched).toBe(WSTG_MAP.filter(test => test.trigger.includes('any')).length);
    const login = wstgSuggest(['login'], { covered: new Set(), limit: 200 });
    expect(login.suggestions.map(item => item.key)).toEqual(expect.arrayContaining(WSTG_MAP.filter(test => test.trigger.includes('login')).map(test => wstgKey(test.id))));
    expect(wstgSuggest(WSTG_FEATURES, { covered: new Set(), limit: 200 }).suggestions.every(item => item.support !== 'O' || false)).toBe(true);
    expect(WSTG_MAP.filter(test => test.trigger.length === 0).every(test => test.support === 'O')).toBe(true);
  });
  it('skips covered keys, filters by transport mode, pages, and is deterministic', () => {
    const first = wstgSuggest(['login', 'api'], { covered: new Set(), limit: 3 }), again = wstgSuggest(['login', 'api'], { covered: new Set(), limit: 3 });
    expect(first).toEqual(again); expect(first.suggestions).toHaveLength(3);
    const rest = wstgSuggest(['login', 'api'], { covered: new Set([first.suggestions[0].key]), limit: 3 });
    expect(rest.matched).toBe(first.matched - 1); expect(rest.suggestions.map(item => item.key)).not.toContain(first.suggestions[0].key);
    const browserOnly = wstgSuggest(['client-js'], { modes: 'B', covered: new Set(), limit: 100 }); expect(browserOnly.suggestions.every(item => item.flags.includes('B'))).toBe(true);
    expect(wstgSuggest(['login'], { covered: new Set(), offset: 1000 }).suggestions).toEqual([]);
  });
  it('carries the map related methods beside the owner so a non-owner skill is discoverable', () => {
    const all = wstgSuggest(WSTG_FEATURES, { covered: new Set(), limit: 500 }).suggestions;
    expect(all.length).toBeGreaterThan(0);
    for (const item of all) {
      const test = WSTG_MAP.find(candidate => wstgKey(candidate.id) === item.key)!;
      // The column is surfaced without changing the owner+card contract: relatedSkills is the skills column minus the owner.
      expect(item.relatedSkills, item.key).toEqual(test.skills.filter(name => name !== test.owner));
      expect(item.relatedSkills, item.key).not.toContain(item.owner);
      expect(item.owner).toBe(test.owner);
    }
    // data-flow-analysis owns no test, so the rendered skills column was its only trace; it must now reach a caller.
    expect(WSTG_MAP.some(test => test.owner === 'data-flow-analysis')).toBe(false);
    const related = all.filter(item => item.relatedSkills.includes('data-flow-analysis')).map(item => item.key);
    expect(related).toEqual(WSTG_MAP.filter(test => test.skills.includes('data-flow-analysis')).map(test => wstgKey(test.id)));
    expect(related.length).toBe(20);
    expect(related).toContain('wstg-injt-05');
  });
});

describe('p2o_wstg_suggest', () => {
  it('lists uncovered tests without writing a record, and drops a test once a cell uses its key', async () => fixture(async h => {
    await populate(h, undefined, { tested: 'wstg-athz-04', blocked: 'wstg-sess-05' });
    const before = await h.reader(); let count: number; try { count = before.records().length; } finally { before.close(); }
    const result = (await h.call('p2o_wstg_suggest', {features: ['object-id', 'login'], limit: 50 })).details;
    const keys = result.suggestions.map((item: any) => item.key);
    expect(keys).not.toContain('wstg-athz-04'); expect(keys).not.toContain('wstg-sess-05'); expect(result.total).toBeGreaterThan(0); expect(result.warning).toMatch(/Not a finding, not permission and not coverage/);
    // The tool passes wstgSuggest's suggestions through, so the related methods are part of the read-only planning aid.
    expect(result.suggestions.every((item: any) => Array.isArray(item.relatedSkills))).toBe(true);
    expect(result.suggestions.some((item: any) => item.relatedSkills.length > 0)).toBe(true);
    const after = await h.reader(); try { expect(after.records().length).toBe(count); } finally { after.close(); }
  }));
  it('refuses unknown features and malformed modes or limits', async () => fixture(async h => {
    await h.command('--target ./source');
    await expect(h.call('p2o_wstg_suggest', {features: ['telepathy'] })).rejects.toThrow(/Unknown recon feature/);
    await expect(h.call('p2o_wstg_suggest', {modes: 'XYZ' })).rejects.toThrow(/modes/);
    await expect(h.call('p2o_wstg_suggest', {limit: 99 })).rejects.toThrow(/limit/);
    expect((await h.call('p2o_wstg_suggest', { })).details.features).toEqual(['any']);
  }));
});

describe('recon features derived from the graph (U4)', () => {
  it('reads only known feature words from attribute values, in map order, and reports the rest', () => {
    expect(featuresFromAttributeValues(['Login, JWT', 'client-js; client-js', 'any', 'telepathy  login|api'])).toEqual({ features: ['login', 'jwt', 'client-js', 'api'], ignored: ['telepathy'] });
    expect(featuresFromAttributeValues([])).toEqual({ features: [], ignored: [] });
    expect(featuresFromAttributeValues(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10', 'x11']).ignored).toHaveLength(10);
  });
  it('uses the feature attributes of current assets when the call names none, lets an explicit list win, and drops a feature once its asset is revised away', async () => fixture(async h => {
    await h.command('--target ./source');
    const suggest = async (extra: Record<string, unknown> = {}) => (await h.call('p2o_wstg_suggest', {limit: 50, ...extra })).details;
    expect(await suggest()).toMatchObject({ features: ['any'], featureSource: 'default' });
    const baseline = (await suggest()).total;
    await (h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'POST /session', attributes: { feature: 'Login, jwt' } } }, { asset: { kind: 'endpoint', key: 'GET /app.js', attributes: { feature: 'client-js telepathy', status: '200' } } }] } }));
    const derived = await suggest();
    expect(derived).toMatchObject({ features: ['login', 'jwt', 'client-js'], featureSource: 'graph', ignoredFeatureWords: ['telepathy'] });
    expect(derived.total).toBeGreaterThan(baseline);
    expect(derived.suggestions.map((item: any) => item.key)).toEqual(expect.arrayContaining(WSTG_MAP.filter(test => test.trigger.includes('login')).slice(0, 3).map(test => wstgKey(test.id))));
    expect(await suggest({ features: ['api'] })).toMatchObject({ features: ['api'], featureSource: 'explicit' });
    expect((await suggest({ features: ['api'] })).ignoredFeatureWords).toBeUndefined();
    await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'POST /session', attributes: { status: '200' }, expectedRevision: 1 } }, { asset: { kind: 'endpoint', key: 'GET /app.js', attributes: { status: '200' }, expectedRevision: 1 } }] } });
    expect(await suggest()).toMatchObject({ features: ['any'], featureSource: 'default', total: baseline });
  }));
});
