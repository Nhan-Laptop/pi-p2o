import { describe, expect, it } from 'vitest';
import { WSTG_FEATURES, WSTG_MAP, applicableTests, featuresFromAttributeValues, unplannedTests, wstgKey, wstgSuggest } from '../../src/wstg-map.js';

/**
 * planning_update.md A6.4: `applicableTests` is the denominator of tests a recorded run could plan, and `unplannedTests` is the WSTG_UNPLANNED projection debt
 * reads. Hermetic and pure: no model, no target, no store. Assertions about which tests exist use prefixes or data-derived expectations, so catalog growth does
 * not break them. The `any` trigger is the vocabulary's always-match value (docs/WSTG_MAP.md), pinned here through wstgSuggest.
 */
const assets = [
  { assetId: 'asset-api', features: ['api'] },
  { assetId: 'asset-login', features: ['login'] },
  { assetId: 'asset-cors', features: ['cors'] },
];
const all = { browser: true, identity: true }, none = { browser: false, identity: false };

describe('A6.4 feature vocabulary round-trip', () => {
  it('normalises a raw attribute value to vocabulary features and reports unknown tokens without refusing', () => {
    const parsed = featuresFromAttributeValues(['API, cors ; jwt', 'telepathy  login|api', 'any']);
    expect(parsed.features).toEqual(['login', 'jwt', 'api', 'cors']); // WSTG_FEATURES order, never the input order
    expect(parsed.features.every(feature => (WSTG_FEATURES as readonly string[]).includes(feature))).toBe(true);
    expect(parsed.ignored).toEqual(['telepathy']);
    // Unknown tokens stay advisory: they are reported, not thrown and not silently promoted to a feature.
    expect(featuresFromAttributeValues(['not-a-feature'])).toEqual({ features: [], ignored: ['not-a-feature'] });
    // A test normalises raw tokens exactly the same way as a pre-split list, so callers do not have to split first.
    expect(applicableTests([{ assetId: 'a', features: ['API, cors ; jwt'] }], all)).toEqual(applicableTests([{ assetId: 'a', features: ['api', 'cors', 'jwt'] }], all));
  });
});

describe('A6.4 applicableTests', () => {
  it('drops exactly the browser and identity rows when no oracle or grant exists', () => {
    const withAll = applicableTests(assets, all), without = applicableTests(assets, none);
    expect(without.every(row => !row.test.browser && !row.test.identity)).toBe(true);
    // The un-flagged rows are identical; only B/I rows appear or disappear with the options.
    expect(without.map(row => row.test.id)).toEqual(withAll.filter(row => !row.test.browser && !row.test.identity).map(row => row.test.id));
    expect(withAll.some(row => row.test.browser)).toBe(true);
    expect(withAll.some(row => row.test.identity)).toBe(true);
    expect(without.find(row => row.test.id === 'WSTG-CLNT-07')).toBeUndefined();
    expect(withAll.find(row => row.test.id === 'WSTG-CLNT-07')).toBeDefined();
  });

  it('attaches the triggering asset ids sorted and unique, with B and I rows tied to the asset that triggered them', () => {
    const withAll = applicableTests(assets, all);
    for (const row of withAll) { expect(row.assets).toEqual([...new Set(row.assets)].sort()); expect(row.assets.length).toBeGreaterThan(0); }
    expect(withAll.find(row => row.test.id === 'WSTG-CLNT-07')!.assets).toEqual(['asset-cors']); // the only B row the cors asset triggers
    expect(withAll.find(row => row.test.id === 'WSTG-ATHN-02')!.assets).toEqual(['asset-login']); // an I row the login asset triggers
    expect(withAll.find(row => row.test.id === 'WSTG-APIT-02')!.assets).toEqual(['asset-api']); // an I row the api asset triggers
    expect(withAll.some(row => row.test.browser && row.assets.includes('asset-cors'))).toBe(true);
    expect(withAll.some(row => row.test.identity && row.assets.includes('asset-login'))).toBe(true);
    // Out-of-scope rows have no trigger and can never be applicable.
    expect(withAll.every(row => row.test.trigger.length > 0)).toBe(true);
  });

  it('merges repeated asset ids, excludes out-of-scope and untouched assets, and yields one row per test in map order', () => {
    const merged = applicableTests([{ assetId: 'a', features: ['cors'] }, { assetId: 'a', features: ['API'] }], all);
    expect(merged.find(row => row.test.id === 'WSTG-CLNT-07')!.assets).toEqual(['a']);
    expect(merged.find(row => row.test.id === 'WSTG-APIT-01')!.assets).toEqual(['a']);
    expect(applicableTests([], all)).toEqual([]);
    // No recognised feature means no trigger, so no test is applicable (an unknown-only asset stays an advisory, per featuresFromAttributeValues).
    expect(applicableTests([{ assetId: 'untouched', features: [] }], all)).toEqual([]);
    expect(applicableTests([{ assetId: 'unknown', features: ['telepathy'] }], all)).toEqual([]);
    const rows = applicableTests(assets, all), ids = rows.map(row => row.test.id);
    expect(new Set(ids).size).toBe(ids.length); // never two rows for one test
    expect(ids).toEqual(WSTG_MAP.filter(test => ids.includes(test.id)).map(test => test.id)); // WSTG_MAP order, the module's stable order
  });
});

describe('A6.4 unplannedTests', () => {
  it('projects the tests a cors and an api asset trigger, with wstgSuggest key/title/support/flags semantics', () => {
    const rows = unplannedTests(assets, all), corsKeys = rows.filter(row => row.assetIds.includes('asset-cors')).map(row => row.key), apiKeys = rows.filter(row => row.assetIds.includes('asset-api')).map(row => row.key);
    expect(corsKeys.some(key => key.startsWith('wstg-clnt-'))).toBe(true); // cors is a client-side trigger
    expect(corsKeys).toContain('wstg-clnt-07');
    expect(apiKeys.some(key => key.startsWith('wstg-apit-'))).toBe(true); // api is an APIT trigger
    expect(apiKeys).toContain('wstg-apit-01');
    // The same selection wstgSuggest makes for the union of recorded features, with the same fields.
    const union = featuresFromAttributeValues(assets.flatMap(asset => asset.features)).features;
    const expected = wstgSuggest(union, { covered: new Set(), limit: 500 }).suggestions;
    expect(rows.map(row => ({ key: row.key, title: row.title, support: row.support, flags: row.flags }))).toEqual(expected.map(item => ({ key: item.key, title: item.title, support: item.support, flags: item.flags })));
    // wstgSuggest also carries relatedSkills; the debt projection stays four fields + assets + one detail sentence.
    expect(rows.every(row => !('relatedSkills' in row))).toBe(true);
  });

  it('drops a test whose wstgKey is covered and leaves every other row untouched', () => {
    const before = unplannedTests(assets, all), after = unplannedTests(assets, { ...all, covered: new Set([wstgKey('WSTG-CLNT-07')]) });
    expect(after.map(row => row.key)).not.toContain('wstg-clnt-07');
    expect(after.map(row => row.key)).toEqual(before.map(row => row.key).filter(key => key !== 'wstg-clnt-07'));
    expect(unplannedTests(assets, all).length).toBe(before.length); // covered is optional and defaults to empty
    // A key that is not applicable changes nothing.
    expect(unplannedTests(assets, { ...all, covered: new Set(['wstg-conf-10']) }).map(row => row.key)).toEqual(before.map(row => row.key));
  });

  it('writes one deterministic ASCII detail sentence under 300 characters and carries the triggering assets', () => {
    const rows = unplannedTests(assets, all);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const test = WSTG_MAP.find(item => wstgKey(item.id) === row.key)!;
      expect(row.detail.length).toBeLessThan(300);
      expect(/^[\x20-\x7e]+$/.test(row.detail)).toBe(true);
      expect(row.detail).not.toMatch(/[*_`#\[\]]/);
      expect(row.detail).toContain(`${test.title} (${test.support}${test.browser || test.identity ? `, ${row.flags}` : ''})`);
      expect(row.detail.endsWith(`on ${row.assetIds.length} asset${row.assetIds.length === 1 ? '' : 's'}`)).toBe(true);
      expect(row.assetIds).toEqual([...new Set(row.assetIds)].sort());
      expect({ title: row.title, support: row.support, flags: row.flags }).toEqual({ title: test.title, support: test.support, flags: `${test.browser ? 'B' : ''}${test.identity ? 'I' : ''}` });
    }
  });

  it('reaches every in-scope row when the whole vocabulary is recorded, keeping the detail bounds', () => {
    const rows = unplannedTests([{ assetId: 'everything', features: WSTG_FEATURES }], all);
    expect(rows.map(row => row.key)).toEqual(WSTG_MAP.filter(test => test.trigger.length > 0).map(test => wstgKey(test.id))); // no trigger is unreachable, in map order
    for (const row of rows) { expect(row.detail.length).toBeLessThan(300); expect(/^[\x20-\x7e]+$/.test(row.detail)).toBe(true); }
  });

  it('is deterministic and never emits a duplicate test row', () => {
    expect(applicableTests(assets, all)).toEqual(applicableTests(assets, all));
    expect(applicableTests(assets, none)).toEqual(applicableTests(assets, none));
    expect(unplannedTests(assets, all)).toEqual(unplannedTests(assets, all));
    expect(unplannedTests(assets, none)).toEqual(unplannedTests(assets, none));
    const rows = unplannedTests(assets, all), keys = rows.map(row => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(unplannedTests(assets, all).map(row => row.assetIds)).toEqual(applicableTests(assets, all).map(row => row.assets)); // same projection, same assets
  });
});

describe('A6.4 prompt contract', () => {
  it('states the feature vocabulary in the recon contract and the three depth lines in the planner policy', async () => {
    const { plannerInstructions, reconInstructions } = await import('../../src/prompts.js');
    const recon = reconInstructions('url', false, false);
    for (const feature of ['login', 'cors', 'api', 'jwt', 'upload']) expect(recon).toContain(feature);
    expect(recon).toContain('unrecognised token is advisory');
    const planner = plannerInstructions({ runId: 'run-wstg', targetLabel: 'https://fixture.invalid', targetKind: 'url', sourceSkipped: 0,
      delegation: { enabled: true, maxWorkers: 3, maxDepth: 2 }, phase: 'active', loopMode: 'event-driven', executorMode: 'shared' });
    // Three lines translated from ARTEX agent/planner.go:304-331; no new tool is introduced by stating them.
    expect(planner).toContain('DEPTH OVER BREADTH');
    expect(planner).toContain('prefer depth on a live finding over breadth on a new asset');
    expect(planner).toContain('MECHANISM FAMILIES');
    expect(planner).toContain('keep 2-3 families open');
    expect(planner).toContain('CHAIN OR WALL');
    expect(planner).toContain('confirmed and tested primitive');
  });
});
