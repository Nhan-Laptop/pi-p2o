import { describe, expect, it } from 'vitest';
import { stixBundle, type InteropFinding, type InteropInput } from '../../src/report-interop.js';

/** R3.8: the STIX builder is pure, deterministic and structurally valid. No network, no store, no clock. */
const CVSS = { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', baseScore: 9.1, severity: 'critical' };
const findings: readonly InteropFinding[] = [
  {
    ref: 'F-1', caseId: 'case-02', revision: 3, title: 'Object identifier accepted without an ownership check',
    severity: 'critical', verdict: 'confirmed', policyKey: 'authz-idor', rootCauseKey: 'missing-ownership-check', cvss: CVSS,
    cwe: ['CWE-639'], wstg: ['wstg-athz-04'], techniques: ['T1190', 'T1078'],
    assets: [{ id: 'asset-2', kind: 'service', key: 'https://app.example.test' }, { id: 'asset-1', kind: 'host', key: 'app.example.test' }],
    findingId: 'a'.repeat(32), evidenceRefs: ['evidence-1', 'evidence-2'],
  },
  {
    ref: 'F-2', caseId: 'case-01', revision: 1, title: 'TLS configuration review was not completed',
    severity: null, verdict: 'inconclusive', policyKey: 'tls-config', cvss: null,
    cwe: [], wstg: [], techniques: [], assets: [{ id: 'asset-1', kind: 'host', key: 'app.example.test' }, { id: 'asset-3', kind: 'account', key: 'svc-reporting' }],
    findingId: 'b'.repeat(32), evidenceRefs: ['evidence-3'],
  },
];
const input: InteropInput = {
  runId: 'run-fixture', target: 'https://app.example.test', asOfSequence: 42, complete: true,
  generatedAt: '2026-10-28T00:00:00.000Z', findings, toolVersion: '0.5.0-test',
};
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const stix = (value: InteropInput = input) => stixBundle(value) as any;
const objects = (value: InteropInput = input) => stix(value).objects as any[];
const ofType = (type: string, value: InteropInput = input) => objects(value).filter(object => object.type === type);

describe('STIX 2.1 export', () => {
  it('is a bundle with one deterministic object set for the same input', () => {
    const bundle = stix();
    expect(bundle).toMatchObject({ type: 'bundle', spec_version: '2.1' });
    expect(bundle.id).toMatch(new RegExp(`^bundle--${UUID}$`));
    expect(JSON.stringify(stix())).toBe(JSON.stringify(bundle));
    const reordered = {
      ...input,
      findings: [...input.findings].reverse().map(finding => ({
        ...finding, cwe: [...finding.cwe].reverse(), wstg: [...finding.wstg].reverse(), techniques: [...finding.techniques].reverse(), assets: [...finding.assets].reverse(),
      })),
    };
    expect(JSON.stringify(stix(reordered))).toBe(JSON.stringify(bundle));
    const ids = objects().map(object => object.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(objects().every(object => object.spec_version === '2.1')).toBe(true);
  });

  it('emits one vulnerability per finding with the recorded fields and no confidence or CVSS score of its own', () => {
    const [rated, unrated] = ofType('vulnerability');
    expect(ofType('vulnerability')).toHaveLength(2);
    expect(rated.id).toMatch(new RegExp(`^vulnerability--${UUID}$`));
    expect(rated.name).toBe('Object identifier accepted without an ownership check');
    expect(rated.description).toContain('policy authz-idor');
    expect(rated.description).toContain('root cause missing-ownership-check');
    expect(rated.description).toContain('attributed owner rating, not host verification');
    expect(rated.labels).toEqual(['critical']);
    expect(rated.created).toBe(input.generatedAt); expect(rated.modified).toBe(input.generatedAt);
    expect(rated.x_p2o_finding_id).toBe('a'.repeat(32));
    expect(rated).not.toHaveProperty('confidence'); expect(rated).not.toHaveProperty('cvss');
    expect(rated.x_p2o_cvss).toEqual({ vector: CVSS.vector, base_score: 9.1, severity: 'critical' });
    expect(rated.external_references).toEqual([
      { source_name: 'cwe', external_id: 'CWE-639' }, { source_name: 'owasp-wstg', external_id: 'WSTG-ATHZ-04' },
      { source_name: 'mitre-attack', external_id: 'T1078' }, { source_name: 'mitre-attack', external_id: 'T1190' },
    ]);
    expect(unrated.description).toContain('not rated');
    expect(unrated.labels).toEqual([]);
    expect(unrated).not.toHaveProperty('x_p2o_cvss');
    expect(unrated.external_references).toEqual([]);
  });

  it('derives the vulnerability id from findingId only, so reruns and case revisions keep it stable', () => {
    const vulnerability = (finding: InteropFinding) => ofType('vulnerability', { ...input, findings: [finding] })[0];
    const original = vulnerability(findings[0]);
    expect(original.id).toBe(ofType('vulnerability')[0].id);
    expect(vulnerability({ ...findings[0], caseId: 'case-99', revision: 7 }).id).toBe(original.id);
    expect(vulnerability({ ...findings[0], findingId: 'c'.repeat(32) }).id).not.toBe(original.id);
    expect(vulnerability({ ...findings[0], findingId: 'c'.repeat(32) }).id).toMatch(new RegExp(`^vulnerability--${UUID}$`));
  });

  it('emits one identity per distinct asset and targets the right identity from each vulnerability', () => {
    const identities = ofType('identity'), vulnerabilities = ofType('vulnerability');
    expect(identities).toHaveLength(3);
    expect(identities.map(identity => identity.name)).toEqual(['account svc-reporting', 'host app.example.test', 'service https://app.example.test']);
    expect(identities.map(identity => identity.identity_class)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(identities.every(identity => new RegExp(`^identity--${UUID}$`).test(identity.id))).toBe(true);
    expect(identities[1]).toMatchObject({ x_p2o_asset_kind: 'host', x_p2o_asset_key: 'app.example.test', x_p2o_asset_id: 'asset-1' });

    const identityIds = new Set(identities.map(identity => identity.id));
    const targets = ofType('relationship').filter(relationship => relationship.relationship_type === 'targets');
    expect(targets).toHaveLength(4);
    expect(targets.every(relationship => identityIds.has(relationship.target_ref))).toBe(true);
    const host = identities.find(identity => identity.name === 'host app.example.test').id;
    const account = identities.find(identity => identity.name === 'account svc-reporting').id;
    const service = identities.find(identity => identity.name === 'service https://app.example.test').id;
    const targetsOf = (source: string) => new Set(targets.filter(relationship => relationship.source_ref === source).map(relationship => relationship.target_ref));
    expect(targetsOf(vulnerabilities[0].id)).toEqual(new Set([host, service]));
    expect(targetsOf(vulnerabilities[1].id)).toEqual(new Set([host, account]));
  });

  it('emits one attack-pattern per technique and links each vulnerability with an indicated behaviour', () => {
    const patterns = ofType('attack-pattern'), vulnerabilities = ofType('vulnerability');
    expect(patterns.map(pattern => pattern.name)).toEqual(['T1078', 'T1190']);
    expect(patterns.map(pattern => pattern.id)).toEqual([...patterns.map(pattern => pattern.id)].sort());
    for (const pattern of patterns) {
      expect(pattern.id).toMatch(new RegExp(`^attack-pattern--${UUID}$`));
      expect(pattern.external_references).toEqual([{ source_name: 'mitre-attack', external_id: pattern.name }]);
    }
    const patternIds = new Set(patterns.map(pattern => pattern.id));
    const indicates = ofType('relationship').filter(relationship => relationship.relationship_type === 'indicates');
    expect(indicates).toHaveLength(2);
    expect(indicates.every(relationship => relationship.source_ref === vulnerabilities[0].id)).toBe(true);
    expect(new Set(indicates.map(relationship => relationship.target_ref))).toEqual(patternIds);
  });

  it('orders vulnerabilities, identities, attack-patterns and relationships deterministically', () => {
    const vulnerabilities = ofType('vulnerability');
    expect(vulnerabilities.map(vulnerability => vulnerability.x_p2o_finding_id)).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
    expect(ofType('identity').map(identity => identity.name)).toEqual(['account svc-reporting', 'host app.example.test', 'service https://app.example.test']);
    expect(ofType('attack-pattern').map(pattern => pattern.id)).toEqual([...ofType('attack-pattern').map(pattern => pattern.id)].sort());
    expect(ofType('relationship').map(relationship => relationship.id)).toEqual([...ofType('relationship').map(relationship => relationship.id)].sort());
    const types = objects().map(object => object.type);
    expect(types.indexOf('vulnerability')).toBeLessThan(types.indexOf('identity'));
    expect(types.indexOf('identity')).toBeLessThan(types.indexOf('attack-pattern'));
    expect(types.indexOf('attack-pattern')).toBeLessThan(types.indexOf('relationship'));
  });

  it('is a valid empty bundle when there are no findings', () => {
    const bundle = stix({ ...input, findings: [] });
    expect(bundle).toMatchObject({ type: 'bundle', spec_version: '2.1', objects: [] });
    expect(bundle.id).toMatch(new RegExp(`^bundle--${UUID}$`));
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
  });
});
