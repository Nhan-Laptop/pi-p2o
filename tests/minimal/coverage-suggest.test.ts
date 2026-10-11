import { describe, expect, it } from 'vitest';
import { WSTG_FEATURES, WSTG_MAP, wstgKey, wstgSuggest } from '../../src/wstg-map.js';
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
});

describe('p2o_coverage suggest', () => {
  it('lists uncovered tests without writing a record, and drops a test once a cell uses its key', async () => fixture(async h => {
    await populate(h, undefined, { tested: 'wstg-athz-04', blocked: 'wstg-sess-05' });
    const before = await h.reader(); let count: number; try { count = before.records().length; } finally { before.close(); }
    const result = (await h.call('p2o_coverage', { action: 'suggest', features: ['object-id', 'login'], limit: 50 })).details;
    const keys = result.suggestions.map((item: any) => item.key);
    expect(keys).not.toContain('wstg-athz-04'); expect(keys).not.toContain('wstg-sess-05'); expect(result.matched).toBeGreaterThan(0); expect(result.warning).toMatch(/Not a finding, not permission and not coverage/);
    const after = await h.reader(); try { expect(after.records().length).toBe(count); } finally { after.close(); }
  }));
  it('refuses unknown features and malformed modes or limits', async () => fixture(async h => {
    await h.command('--target ./source --solo');
    await expect(h.call('p2o_coverage', { action: 'suggest', features: ['telepathy'] })).rejects.toThrow(/Unknown recon feature/);
    await expect(h.call('p2o_coverage', { action: 'suggest', modes: 'XYZ' })).rejects.toThrow(/modes/);
    await expect(h.call('p2o_coverage', { action: 'suggest', limit: 99 })).rejects.toThrow(/limit/);
    expect((await h.call('p2o_coverage', { action: 'suggest' })).details.features).toEqual(['any']);
  }));
});
