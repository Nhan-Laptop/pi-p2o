import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assetText, renderReport } from '../../src/report-export.js';
import type { ReportAssetBrief } from '../../src/report.js';
import { indexRecords } from '../../src/records.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * R1.6: the report resolves the asset ids it cites to the identity the graph recorded, marks a pin that no longer matches the
 * head as stale, and prints a bounded inventory of the current scope. The inventory is a scope statement — it is not a test,
 * not a finding and never a claim about the target — and an unreachable graph keeps the raw-id rendering the report had before.
 */
const brief = (id: string, revision: number, extra: Partial<ReportAssetBrief> = {}): ReportAssetBrief => ({ id, kind: 'endpoint', key: 'GET /login', revision, ...extra });
const meta = { runId: 'run-r1', target: 'inert', retention: 'durable-local', historical: false, asOfSequence: 1, storeSchema: 7, runtime: { hash: 'inert' }, complete: true, format: 2 } as const;

describe('the report resolves a cited asset to its recorded identity (R1.6)', () => {
  it('renders the cited id as kind, key, label and revision instead of a bare id', () => {
    const id = `asset-${'a'.repeat(24)}`, text = assetText({ id, revision: 2 }, { [id]: brief(id, 2, { key: 'POST /admin/login', label: 'Login form' }) });
    expect(text).toBe('endpoint POST /admin/login “Login form” (asset-aaaaaaaaaaaaaaaaaaaaaaaa@r2)');
  });

  it('marks a stale pin and states the current revision, and says an unresolved id is unresolved', () => {
    const id = `asset-${'b'.repeat(24)}`;
    expect(assetText({ id, revision: 1 }, { [id]: brief(id, 3) })).toContain('stale; current r3');
    expect(assetText({ id }, { [id]: brief(id, 3) })).not.toContain('stale');
    const unknown = `asset-${'c'.repeat(24)}`;
    expect(assetText({ id: unknown }, {})).toBe(`${unknown} (unresolved in the current graph scope)`);
  });

  it('neutralizes hostile and credential-shaped recorded text instead of printing it as active markup', () => {
    const id = `asset-${'d'.repeat(24)}`, text = assetText({ id, revision: 1 },
      { [id]: brief(id, 1, { key: '[x](https://evil.example) <script>1</script> | pipe', label: 'Authorization: Bearer sk-live-abcdef1234567890' }) });
    expect(text).not.toMatch(/(?<!\\)\]\(/); expect(text).not.toMatch(/<(?:script|img)/i); expect(text).not.toContain('https://');
    expect(text).not.toContain('sk-live-abcdef1234567890'); expect(text).not.toContain('\n'); expect(text).toContain('REDACTED');
  });
});

describe('the report inventories the recorded surface (R1.6)', () => {
  it('resolves the cited asset in the coverage table and prints the bounded inventory with its true total', async () => fixture(async h => {
    const built = await populate(h); h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
    const accepted = report.slice(report.indexOf('## Accepted current cases'), report.indexOf('## Other cases'));
    expect(accepted).toContain(`- Assets: endpoint GET /report-fixture (${built.asset.entityId}@r1)`);
    expect(report).toContain('## Asset inventory — the surface as recorded');
    expect(report).toContain('Current-scope assets: **1**');
    expect(report).toMatch(/\| endpoint \| GET \/report-fixture \| — \| r1 \| asset-[a-f0-9]{24} \|/);
    // The inventory is scope, not a result: it is printed before the coverage denominator and says what it is not.
    expect(report.indexOf('## Asset inventory')).toBeLessThan(report.indexOf('## Coverage and gaps'));
    expect(report).toContain('not a test, not a finding and not a statement about its safety');
    expect(report).not.toMatch(/no vulnerabilit|is secure|all clear|fully covered/i);
  }));

  it('marks the cited pin stale when the recorded asset moved on, and only when the graph moved', async () => fixture(async h => {
    await populate(h);
    const again = await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /report-fixture', label: 'Report fixture login form', expectedRevision: 1 } }] } });
    expect(again.details.acks[0].revision).toBe(2);
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
    expect(report).toMatch(/stale; current r2/);
    expect(report).toContain('| endpoint | GET /report-fixture | Report fixture login form | r2 |');
  }));

  it('prints no inventory section for a run whose graph holds nothing, and keeps the rendering without a resolution map', () => {
    const empty = renderReport(indexRecords([], 'run-r1'), {}, meta).files.find(file => file.name === 'REPORT.md')!.body;
    expect(empty).not.toContain('Asset inventory');
    const resolved = renderReport(indexRecords([], 'run-r1'), { inventory: { rows: [], total: 0 } }, meta).files.find(file => file.name === 'REPORT.md')!.body;
    expect(resolved).toContain('Current-scope assets: **0**'); expect(resolved).toContain('No asset is recorded in the current scope'); // an empty scope is stated, never left to be read as "nothing to report"
    const withRows = renderReport(indexRecords([], 'run-r1'), { inventory: { rows: [brief('asset-' + 'e'.repeat(24), 2)], total: 9 } }, meta).files.find(file => file.name === 'REPORT.md')!.body;
    expect(withRows).toContain('Current-scope assets: **9**'); expect(withRows).toContain('… 8 more asset(s) in this scope');
    expect(withRows.split('\n').filter(line => line.startsWith('| endpoint |'))).toHaveLength(1);
  });
});
