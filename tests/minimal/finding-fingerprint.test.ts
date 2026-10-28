import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FINDING_ID_PATTERN, findingId, findingScope } from '../../src/finding-fingerprint.js';
import { fixture, populate } from './helpers/report-fixture.js';

/** R3.6: a finding keeps one host-derived identity across runs. Pure helper plus the report wiring that prints it. */
const base = { scope: findingScope('https://hcmussh.edu.vn'), policyKey: 'policy:report-case', rootCauseKey: 'root:report-gate', assets: [{ kind: 'endpoint', key: 'GET /report-fixture' }] };

describe('finding fingerprint', () => {
  it('derives a stable 32-hex identity from scope, policy, root cause and asset identity', () => {
    const id = findingId(base);
    expect(id).toMatch(FINDING_ID_PATTERN);
    expect(findingId({ ...base })).toBe(id);
    // A re-rated, re-rated-at-another-revision or re-evidenced finding is the same finding: those inputs are not in the digest.
    expect(findingId({ ...base, assets: [{ kind: 'endpoint', key: 'GET /report-fixture' }] })).toBe(id);
  });

  it('ignores asset order and duplicate assets, but separates identity, place and policy', () => {
    const one = { kind: 'endpoint', key: 'GET /report-fixture' }, two = { kind: 'data', key: 'table:reports' };
    expect(findingId({ ...base, assets: [two, one] })).toBe(findingId({ ...base, assets: [one, two] }));
    expect(findingId({ ...base, assets: [one, two, one] })).toBe(findingId({ ...base, assets: [one, two] }));
    expect(findingId({ ...base, scope: findingScope('https://other.example') })).not.toBe(findingId(base));
    expect(findingId({ ...base, policyKey: 'policy:other' })).not.toBe(findingId(base));
    expect(findingId({ ...base, rootCauseKey: 'root:other' })).not.toBe(findingId(base));
    expect(findingId({ ...base, rootCauseKey: undefined })).not.toBe(findingId(base));
    expect(findingId({ ...base, assets: [{ kind: 'endpoint', key: 'GET /other' }] })).not.toBe(findingId(base));
  });

  it('normalizes the scope case and keeps a tenant in the scope, refusing an empty scope or policy', () => {
    expect(findingScope('https://HCMUSSH.edu.vn/')).toBe('https://hcmussh.edu.vn/');
    expect(findingScope('https://hcmussh.edu.vn/', 'Tenant-A')).not.toBe(findingScope('https://hcmussh.edu.vn/'));
    expect(findingScope('https://hcmussh.edu.vn/', 'Tenant-A')).toBe(findingScope('https://hcmussh.edu.vn/', 'tenant-a'));
    expect(() => findingScope('   ')).toThrow(/authorized target/);
    expect(() => findingId({ ...base, scope: '' })).toThrow(/scope and policy key/);
    expect(() => findingId({ ...base, policyKey: ' ' })).toThrow(/scope and policy key/);
  });
});

describe('finding fingerprint in the report', () => {
  it('prints the same host-derived id in findings.json and SARIF, and the id is not a per-run value', async () => fixture(async h => {
    const built = await populate(h);
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'fp-a')}`); await h.command(`report export ${join(h.root, 'fp-b')}`);
    const a = await h.read(join(h.root, 'fp-a')), b = await h.read(join(h.root, 'fp-b'));
    const finding = JSON.parse(a['findings.json']).findings[0], again = JSON.parse(b['findings.json']).findings[0];
    expect(finding.findingId).toMatch(FINDING_ID_PATTERN);
    expect(again.findingId).toBe(finding.findingId); // deterministic for the same committed state
    // Recompute from the stored inputs the report printed: the id is a derivation, not a value the model or the export stores.
    const target = /^- Target: (.+?); retention/m.exec(a['REPORT.md'])![1];
    expect(finding.findingId).toBe(findingId({ scope: findingScope(target), policyKey: 'policy:report-case', rootCauseKey: 'root:report-gate', assets: [{ kind: 'endpoint', key: 'GET /report-fixture' }] }));
    const sarif = JSON.parse(a['findings.sarif']);
    expect(sarif.runs[0].results[0].partialFingerprints['p2oFindingId/v1']).toBe(finding.findingId);
    expect(a['findings.csv'].split('\n')[0]).toContain('"finding_id"'); expect(a['findings.csv']).toContain(finding.findingId);
  }));

  it('carries the crosswalked techniques and prints the same set in findings.json and SARIF', async () => fixture(async h => {
    await populate(h, undefined, { tested: 'wstg-athz-04' });
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'fp-tech')}`);
    const files = await h.read(join(h.root, 'fp-tech')), json = JSON.parse(files['findings.json']).findings[0], sarif = JSON.parse(files['findings.sarif']);
    // The fixture case addresses wstg-athz-04 in its coverage cell; techniques are derived from that key, never authored.
    expect(json.wstg.map((entry: any) => entry.key)).toContain('wstg-athz-04');
    expect(json.techniques.length).toBeGreaterThan(0);
    expect(sarif.runs[0].results[0].properties.techniques).toEqual(json.techniques);
    expect(files['REPORT.md']).toContain('- ATT&CK techniques those tests point at');
  }));
});
