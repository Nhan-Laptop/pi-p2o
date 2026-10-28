import { describe, expect, it } from 'vitest';
import { assetDossier, type DossierInput } from '../../src/graph-dossier.js';

/**
 * R1.1/W7: the dossier is a bounded, derived projection. The fixture carries every section the plan names — fact, hypothesis,
 * demonstrated and stale claim, accepted case, coverage cell, task — plus a target-shaped secret, and it pins the parts that
 * could quietly lie: stale flags, gap flags, omission counters, deterministic order and redaction.
 */
const assetId = 'asset-' + 'a'.repeat(24);
const input = (overrides: Partial<DossierInput> = {}): DossierInput => ({
  asset: { entityId: assetId, kind: 'endpoint', key: 'GET https://example.com/admin', label: 'admin gate', revision: 2 },
  counts: { revisions: 2, assertions: 3, relations: 1, anchors: 0 },
  facts: [{ entityId: 'assertion-f1', kind: 'fact:observed', statement: 'the gate runs server-side', confidence: 'high', evidenceRefs: ['receipt-1'] }],
  hypotheses: [
    { entityId: 'assertion-h1', statement: 'the admin gate trusts a forwarded header', status: 'open', producerRole: 'recon', unverified: true },
    { entityId: 'assertion-h2', statement: 'the gate rejects unauthenticated requests', status: 'supported', producerRole: 'owner' },
  ],
  relations: [{ entityId: 'relation-r1', kind: 'exposes', direction: 'outgoing', otherId: 'asset-b', basis: 'inferred', unverified: true, note: 'same router' }],
  claims: [
    { recordId: 'record-claim-1', candidate: 'admin-header-trust', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', taskRef: 'task-1', assetRevisions: [2], stale: false },
    { recordId: 'record-claim-2', candidate: 'stale-pin', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', assetRevisions: [1], stale: true },
  ],
  cases: [{ id: 'case-1', title: 'Admin gate trusts X-Forwarded-For', severity: 'high', reviewStatus: 'reviewed', acceptedFinding: true, currentness: 'current' }],
  cells: [{ planId: 'coverage-plan-1', questionKey: 'authz:admin', execution: 'tested', assessment: 'unsafe', currentness: 'current' }],
  tasks: [{ id: 'task-1', status: 'closed', question: 'Does the admin gate trust the header?' }],
  ...overrides,
});

describe('asset dossier (R1.1)', () => {
  it('answers the asset question in one bounded read with every section present', () => {
    const dossier = assetDossier(input());
    expect(dossier.asset).toMatchObject({ entityId: assetId, kind: 'endpoint', revision: 2 });
    expect(dossier.counts).toEqual({ revisions: 2, assertions: 3, relations: 1, anchors: 0 });
    expect(dossier.facts).toEqual([expect.objectContaining({ kind: 'fact:observed', statement: 'the gate runs server-side' })]);
    expect(dossier.hypotheses).toMatchObject({ open: 1, supported: 1, refuted: 0, inconclusive: 0 });
    expect(dossier.hypotheses.rows.map(row => row.entityId)).toEqual(['assertion-h1', 'assertion-h2']);
    expect(dossier.relations).toEqual([expect.objectContaining({ kind: 'exposes', direction: 'outgoing', otherId: 'asset-b', basis: 'inferred' })]);
    // The demonstrated claim is the only thing the dossier may call demonstrated; the stale pin stays visible as stale.
    expect(dossier.demonstrated).toEqual(['record-claim-1']);
    expect(dossier.claims.map(claim => [claim.recordId, claim.stale])).toEqual([['record-claim-1', false], ['record-claim-2', true]]);
    expect(dossier.cases).toEqual([expect.objectContaining({ id: 'case-1', severity: 'high', acceptedFinding: true })]);
    expect(dossier.coverage).toEqual({ cells: [expect.objectContaining({ planId: 'coverage-plan-1', questionKey: 'authz:admin' })], noCell: false });
    expect(dossier.tasks).toEqual([expect.objectContaining({ id: 'task-1', status: 'closed' })]);
    expect(dossier.gaps).toEqual({ noClaim: false, noDemonstratedClaim: false, noCoverageCell: false, openHypotheses: 1, inferredRelations: 1 });
    expect(dossier.text.join('\n')).toContain('admin gate');
  });

  it('states the gaps explicitly instead of leaving an empty section to be read as safe', () => {
    const dossier = assetDossier(input({ claims: [], cases: [], cells: [], tasks: [] }));
    expect(dossier.gaps).toEqual({ noClaim: true, noDemonstratedClaim: true, noCoverageCell: true, openHypotheses: 1, inferredRelations: 1 });
    expect(dossier.coverage.noCell).toBe(true);
    expect(dossier.text.join('\n')).toContain('no claim is attached');
    expect(dossier.text.join('\n')).toContain('no coverage cell');
  });

  it('caps every section and reports what it omitted instead of silently truncating', () => {
    const many = input({ facts: Array.from({ length: 12 }, (_, i) => ({ entityId: `assertion-f${i}`, kind: 'fact:observed', statement: `fact ${i}` })),
      claims: Array.from({ length: 12 }, (_, i) => ({ recordId: `record-claim-${i}`, candidate: `claim-${i}`, assetRevisions: [2], stale: false })) });
    const dossier = assetDossier(many);
    expect(dossier.facts).toHaveLength(10);
    expect(dossier.claims).toHaveLength(10);
    expect(dossier.omitted).toMatchObject({ facts: 2, claims: 2, cases: 0 });
    expect(assetDossier(input({ limits: { facts: 0, claims: 0 } })).omitted).toMatchObject({ facts: 1, claims: 2 });
  });

  it('orders deterministically and redacts credential-shaped text from target-derived rows', () => {
    const secret = assetDossier(input({ facts: [{ entityId: 'assertion-secret', kind: 'fact:observed', statement: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret.token' }] }));
    expect(secret.facts[0]!.statement).toContain('[REDACTED]');
    expect(secret.facts[0]!.statement).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    const reordered = assetDossier(input({ claims: [...input().claims].reverse() }));
    expect(reordered.claims.map(claim => claim.recordId)).toEqual(['record-claim-1', 'record-claim-2']);
  });
});
