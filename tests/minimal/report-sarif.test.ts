import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { sarifLog, type InteropFinding, type InteropInput } from '../../src/report-interop.js';

/** R3.7: the SARIF builder is pure, deterministic and structurally valid. No network, no store, no clock. */
const CVSS = { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', baseScore: 9.1, severity: 'critical' };
const findings: readonly InteropFinding[] = [
  {
    ref: 'F-1', caseId: 'case-02', revision: 3, title: 'Object identifier accepted without an ownership check',
    severity: 'critical', verdict: 'confirmed', policyKey: 'authz-idor', rootCauseKey: 'missing-ownership-check', cvss: CVSS,
    cwe: ['CWE-639'], wstg: ['wstg-athz-04'], techniques: ['T1190', 'T1078'],
    assets: [{ id: 'asset-2', kind: 'service', key: 'https://app.example.test' }, { id: 'asset-1', kind: 'host', key: 'app.example.test' }],
    findingId: 'a'.repeat(32),
    locations: [
      { kind: 'symbol', value: 'OrdersController.show' }, { kind: 'url', value: 'https://app.example.test/orders/42' },
      { kind: 'commit', value: 'deadbeef' }, { kind: 'path', value: 'src/orders.ts' }, { kind: 'header', value: 'X-Tenant' },
    ],
    evidenceRefs: ['evidence-1', 'evidence-2'],
  },
  {
    ref: 'F-2', caseId: 'case-01', revision: 1, title: 'TLS configuration review was not completed',
    severity: null, verdict: 'inconclusive', policyKey: 'tls-config', cvss: null,
    cwe: [], wstg: [], techniques: [], assets: [{ id: 'asset-1', kind: 'host', key: 'app.example.test' }, { id: 'asset-3', kind: 'account', key: 'svc-reporting' }],
    findingId: 'b'.repeat(32), locations: [], evidenceRefs: ['evidence-3'],
  },
];
const input: InteropInput = {
  runId: 'run-fixture', target: 'https://app.example.test', asOfSequence: 42, complete: true,
  generatedAt: '2026-10-28T00:00:00.000Z', findings, toolVersion: '0.5.0-test',
};
const sarif = (value: InteropInput = input) => sarifLog(value) as any;
const results = (value: InteropInput = input) => sarif(value).runs[0].results;
const rules = (value: InteropInput = input) => sarif(value).runs[0].tool.driver.rules;

describe('SARIF 2.1.0 export', () => {
  it('emits one run with the pinned schema, version, tool metadata and source root', () => {
    const log = sarif();
    expect(log.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json');
    expect(log.version).toBe('2.1.0');
    expect(log.runs).toHaveLength(1);
    const run = log.runs[0];
    expect(run.tool.driver).toMatchObject({ name: 'pi-p2o', version: '0.5.0-test', informationUri: 'https://github.com/' });
    expect(run.tool.driver.rules.map((rule: any) => rule.id)).toEqual(['authz-idor', 'tls-config']);
    expect(run.originalUriBaseIds).toEqual({ SRCROOT: { uri: 'file:///' } });
    expect(() => JSON.parse(JSON.stringify(log))).not.toThrow();
    expect(JSON.stringify(log)).not.toMatch(/[\u0000\u202e]/);
  });

  it('is byte-identical for the same input and independent of finding and location order', () => {
    const first = JSON.stringify(sarif());
    expect(JSON.stringify(sarif())).toBe(first);
    const reordered = {
      ...input,
      findings: [...input.findings].reverse().map(finding => ({ ...finding, locations: finding.locations ? [...finding.locations].reverse() : finding.locations })),
    };
    expect(JSON.stringify(sarif(reordered))).toBe(first);
  });

  it('creates one rule per policyKey and every result points at an existing rule', () => {
    const run = sarif().runs[0];
    expect(run.tool.driver.rules).toHaveLength(2);
    expect(new Set(run.tool.driver.rules.map((rule: any) => rule.id)).size).toBe(run.tool.driver.rules.length);
    for (const result of run.results) expect(run.tool.driver.rules.some((rule: any) => rule.id === result.ruleId), result.ruleId).toBe(true);
    const authz = run.tool.driver.rules.find((rule: any) => rule.id === 'authz-idor');
    expect(authz.name).toBe('Attributed policy finding');
    expect(authz.shortDescription.text).toContain('not host verification');
    expect(authz.properties).toEqual({ tags: ['security', 'wstg-athz-04', 'CWE-639'], precision: 'high' });
    expect(authz.properties.tags[0]).toBe('security');
    expect(run.results.find((result: any) => result.ruleId === 'authz-idor').properties.policyKey).toBe('authz-idor');
  });

  it('maps every recorded severity onto a SARIF level and omits the level when nothing was rated', () => {
    const severities = ['critical', 'high', 'medium', 'low', 'informational', null] as const;
    const rated = severities.map((severity, index): InteropFinding => ({
      ...findings[0], findingId: String(index).padStart(32, '0'), policyKey: `policy-${index}`, title: `${severity ?? 'unrated'} finding`, severity,
    }));
    const mapped = results({ ...input, findings: rated }).map((result: any) => result.level);
    expect(mapped).toEqual(['error', 'error', 'warning', 'note', 'note', undefined]);
    expect(results()[0].level).toBe('error');
    expect(results()[1]).not.toHaveProperty('level');
  });

  it('carries the finding fingerprint and its recorded properties, including a null rating and null CVSS', () => {
    const [rated, unrated] = results();
    expect(rated.partialFingerprints).toEqual({ 'p2oFindingId/v1': 'a'.repeat(32) });
    expect(rated.message.text).toBe('Object identifier accepted without an ownership check (case case-02@r3) — attributed owner rating, not host verification');
    expect(rated.properties).toMatchObject({
      findingId: 'a'.repeat(32), caseId: 'case-02', caseRevision: 3, policyKey: 'authz-idor', rootCauseKey: 'missing-ownership-check',
      cwe: ['CWE-639'], wstg: ['wstg-athz-04'], techniques: ['T1190', 'T1078'], cvss: CVSS, severity: 'critical', evidenceRefs: ['evidence-1', 'evidence-2'],
    });
    expect(unrated.properties).toMatchObject({ findingId: 'b'.repeat(32), caseId: 'case-01', caseRevision: 1, policyKey: 'tls-config', rootCauseKey: null, cvss: null, severity: null });
    expect(unrated.partialFingerprints).toEqual({ 'p2oFindingId/v1': 'b'.repeat(32) });
    expect(unrated.message.text).toBe('TLS configuration review was not completed (case case-01@r1) — attributed owner rating, not host verification');
  });

  it('takes at most three locations in a deterministic order and shapes url, path and logical locations', () => {
    const [rated, unrated] = results();
    expect(rated.locations).toHaveLength(3);
    expect(rated.locations[0]).toEqual({ physicalLocation: { artifactLocation: { uri: 'https://app.example.test/orders/42' } } });
    expect(rated.locations[1]).toEqual({ physicalLocation: { artifactLocation: { uri: 'src/orders.ts', uriBaseId: 'SRCROOT' } } });
    expect(rated.locations[2]).toEqual({ logicalLocations: [{ fullyQualifiedName: 'X-Tenant' }] });
    expect(unrated).not.toHaveProperty('locations');
    const reversed = { ...findings[0], locations: [...(findings[0].locations ?? [])].reverse() };
    expect(results({ ...input, findings: [reversed] })[0].locations).toEqual(rated.locations);
  });

  it('bounds titles, messages, location values and rule ids, and keeps hostile text as plain JSON', () => {
    const long = 'x'.repeat(2000);
    const hostile: InteropFinding = {
      ...findings[0], findingId: 'c'.repeat(32), policyKey: 'Pölicy Key\u0000with\nnewline', title: `A\n${long}`,
      locations: [{ kind: 'url', value: `https://example.test/${long}` }], rootCauseKey: long, evidenceRefs: [long],
    };
    const log = sarif({ ...input, findings: [hostile] });
    const result = log.runs[0].results[0], rule = log.runs[0].tool.driver.rules[0];
    expect(result.message.text.length).toBeLessThanOrEqual(1000); expect(result.message.text).toContain('…'); expect(result.message.text).not.toContain('\n');
    expect(result.locations[0].physicalLocation.artifactLocation.uri.length).toBeLessThanOrEqual(1000);
    expect(result.properties.rootCauseKey.length).toBeLessThanOrEqual(160); expect(result.properties.evidenceRefs[0].length).toBeLessThanOrEqual(80);
    expect(rule.id).toMatch(/^[\x20-\x7e]+$/); expect(rule.id.length).toBeLessThanOrEqual(160);
    expect(result.ruleId).toBe(rule.id);
  });

  it('is still a valid, empty SARIF run when there are no findings', () => {
    const log = sarif({ ...input, findings: [] });
    expect(log.version).toBe('2.1.0');
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0].tool.driver.rules).toEqual([]);
    expect(log.runs[0].results).toEqual([]);
    expect(log.runs[0].originalUriBaseIds).toEqual({ SRCROOT: { uri: 'file:///' } });
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
  });

  it('does not read a clock or a random source', async () => {
    const source = await readFile(new URL('../../src/report-interop.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bDate\b|Math\.random|randomUUID|performance\.now/);
  });
});
