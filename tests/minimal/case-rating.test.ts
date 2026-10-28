import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evidenceFor, fixture, populate, seedClaim } from './helpers/report-fixture.js';

/** P3: an owner rating is its own note against an exact case revision. Hermetic: inert sandbox, real SQLite store. */
const finding = (extra: Record<string, unknown> = {}) => ({ severity: 'medium', basis: 'Confirmed boundary deviation reaching only the tested identity’s own object in the fixture', ...extra });
const rate = (h: any, built: any, value: unknown, extra: Record<string, unknown> = {}) => h.call('p2o_case_rate', {id: built.accepted.id, revision: built.accepted.revision, finding: value, ...extra });

describe('case rating', () => {
  it('records a rating without touching the verdict, the review status, the revision or the coverage cells that pin the case', async () => fixture(async h => {
    const built = await populate(h);
    const rated = (await rate(h, built, finding({ likelihood: 'Reachable by any authenticated fixture actor', impact: 'Read of one fixture object', cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N', cwe: ['CWE-639'], remediationSteps: 'Check ownership before returning the object', references: ['wstg-athz-04'], reproductionEvidenceRefs: [built.observation.evidenceId] }))).details;
    expect(rated).toMatchObject({ caseId: built.accepted.id, caseRevision: built.accepted.revision });
    const view = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    expect(view).toMatchObject({ revision: built.accepted.revision, verdict: 'confirmed', reviewStatus: 'accepted', currentness: 'current', acceptedFinding: true, ratedRevision: built.accepted.revision, ratingCurrent: true });
    expect(view.finding).toMatchObject({ severity: 'medium', cwe: ['CWE-639'], cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N' });
    const list = (await h.call('p2o_board', { board: 'cases' })).details.entries; expect(list.find((entry: any) => entry.id === built.accepted.id).severity).toBe('medium'); expect(list.find((entry: any) => entry.id === built.pending.id).severity).toBeUndefined();
    // P8: the list projection carries rate-readiness so the lead reads it instead of judging from the verdict alone.
    // This fixture accepted and rated a case without an independent receipt, so the honest reading is "not ready".
    expect(list.find((entry: any) => entry.id === built.accepted.id)).toMatchObject({ readyToRate: false, currentness: 'current', independentCurrent: false });
    expect(list.find((entry: any) => entry.id === built.pending.id)).toMatchObject({ readyToRate: false, currentness: 'current', independentCurrent: false });
    expect((await h.call('p2o_board', { board: 'coverage' })).details.plans[0].counts.stale).toBe(0); // the cells keep pinning the same case revision
  }));

  it('re-rating replaces the earlier rating and a replayed request adds nothing', async () => fixture(async h => {
    const built = await populate(h), request = { requestId: 'rate-once' };
    const first = (await rate(h, built, finding(), request)).details, again = (await rate(h, built, finding(), request)).details;
    expect(again.recordId).toBe(first.recordId);
    await rate(h, built, finding({ severity: 'low', basis: 'Downgraded after the owner re-read the fixture policy' }));
    expect((await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details.finding.severity).toBe('low');
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRating).length).toBe(2); } finally { store.close(); }
  }));

  it('refuses malformed ratings, unknown evidence, a stale revision and a withdrawn case, writing nothing', async () => fixture(async h => {
    const built = await populate(h), reject = (value: unknown, pattern: RegExp, extra: Record<string, unknown> = {}) => expect(rate(h, built, value, extra)).rejects.toThrow(pattern);
    await reject(finding({ severity: 'severe' }), /severity/); await reject(finding({ cwe: ['CWE-0'] }), /CWE/); await reject(finding({ cwe: ['cwe-79'] }), /CWE/); await reject(finding({ cvssVector: 'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }), /CVSS/);
    await reject(finding({ references: ['javascript:alert(1)'] }), /references/); await reject(finding({ references: ['http://plain.example/x'] }), /references/); await reject(finding({ basis: 'short' }), /basis/);
    await reject(finding({ unexpected: true }), /Case finding|unknown|exact/i); await reject(finding({ reproductionEvidenceRefs: ['evidence-that-does-not-exist'] }), /reproduction evidence/);
    await expect(h.call('p2o_case_rate', {id: built.accepted.id, revision: built.accepted.revision + 5, finding: finding() })).rejects.toThrow(/stale case revision/);
    await expect(h.call('p2o_case_rate', {id: built.accepted.id, revision: 1 })).rejects.toThrow(/needs a finding/);
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRating).length).toBe(0); } finally { store.close(); }
  }));

  it('accepts ordered reproduction steps with roles, keeps the plain id list valid, and refuses inconsistent or unknown steps (U8)', async () => fixture(async h => {
    const built = await populate(h), second = (await h.call('p2o_shell', { command: 'printf second-step' })).details.evidenceId, first = built.observation.evidenceId;
    const plain = (await rate(h, built, finding({ reproductionEvidenceRefs: [first, second] }))).details;
    expect(plain.finding.reproductionEvidenceRefs).toEqual([first, second]); expect(plain.finding.reproductionSteps).toBeUndefined();
    const steps = [{ ref: second, role: 'baseline', note: 'Control request without the session' }, { ref: first, role: 'proof' }];
    const rated = (await rate(h, built, finding({ reproductionSteps: steps }))).details;
    expect(rated.finding.reproductionSteps).toEqual(steps); expect(rated.finding.reproductionEvidenceRefs).toEqual([second, first]); // list order is the order to follow
    expect((await rate(h, built, finding({ reproductionSteps: steps, reproductionEvidenceRefs: [second, first] }))).details.finding.reproductionSteps).toEqual(steps);
    const reject = (value: unknown, pattern: RegExp) => expect(rate(h, built, value)).rejects.toThrow(pattern);
    await reject(finding({ reproductionSteps: steps, reproductionEvidenceRefs: [first, second] }), /must match/);
    await reject(finding({ reproductionSteps: [{ ref: first, role: 'winner' }] }), /role/); await reject(finding({ reproductionSteps: [{ ref: first, role: 'proof' }, { ref: first, role: 'baseline' }] }), /Duplicate/);
    await reject(finding({ reproductionSteps: [] }), /reproduction steps/); await reject(finding({ reproductionSteps: [{ ref: first, role: 'proof', extra: 1 }] }), /step|unknown|exact/i);
    await reject(finding({ reproductionSteps: [{ ref: 'evidence-that-does-not-exist', role: 'proof' }] }), /reproduction evidence/);
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRating).length).toBe(3); } finally { store.close(); }
  }));

  it('keeps a case whose inferred-policy claims were never tested or observed capped at medium', async () => fixture(async h => {
    const built = await populate(h);
    const claim = await seedClaim(h, { candidate: 'inferred-claim', surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', evidenceRefs: [], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Policy inferred from names only', limitations: 'No declared policy was found for this fixture' });
    const draft = { title: 'Inferred policy hypothesis case', policyKey: 'policy:inferred', assetRefs: [{ id: built.asset.entityId, revision: 1 }], claimRefs: [claim.id], independentEvidenceRefs: [], taskRefs: [], reportRefs: [], contradictions: [], affectedVariants: [], relatedCaseIds: [], verdict: 'open', reviewStatus: 'pending', reviewReason: 'Pending: policy is only inferred', limitations: 'Policy was inferred, not declared', remediation: { status: 'unplanned', reason: 'No remediation was reviewed for the inferred case', evidenceRefs: [] } };
    const created = (await h.call('p2o_case_author', {entry: draft })).details;
    await expect(h.call('p2o_case_rate', {id: created.id, revision: created.revision, finding: finding({ severity: 'critical' }) })).rejects.toThrow(/inferred policy basis cannot be rated above medium/);
    await expect(h.call('p2o_case_rate', {id: created.id, revision: created.revision, finding: finding({ severity: 'high' }) })).rejects.toThrow(/inferred/);
    expect((await h.call('p2o_case_rate', {id: created.id, revision: created.revision, finding: finding({ severity: 'medium' }) })).details.finding.severity).toBe('medium');
  }));

  it('rates a tested and observed cross-tenant effect high on inferred provenance with the INFERRED_POLICY flag and a required limitation', async () => fixture(async h => {
    const built = await populate(h);
    const evidence = await evidenceFor(h);
    // D35: the policy basis is provenance. The production writer accepts it because the effect ran and was observed; a static or
    // untested inference would still be refused, which is what keeps the medium ceiling meaningful.
    const inferred = await evidence.candidate('worker-a', { candidate: 'inferred-observed-claim', surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction',
      evidenceRefs: [built.observation.evidenceId], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Cross-tenant object ownership inferred from the sibling route; no tenant contract is published', limitations: 'No declared tenant ownership contract for the sibling route' } as never);
    await expect(evidence.candidate('worker-a', { candidate: 'inferred-untested-claim', surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'not_tested', proof: 'static_trace',
      evidenceRefs: [built.observation.evidenceId], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Cross-tenant object ownership inferred from a name only', limitations: 'Nothing executed yet' } as never)).rejects.toThrow(/open_proof_gap/);
    const draft = { title: 'Observed cross-tenant read on inferred policy provenance', policyKey: 'policy:inferred-observed', assetRefs: [{ id: built.asset.entityId, revision: 1 }], claimRefs: [built.claim.id, inferred.id], independentEvidenceRefs: [], taskRefs: [], reportRefs: [], contradictions: [], affectedVariants: ['variant:read'], relatedCaseIds: [], verdict: 'confirmed', reviewStatus: 'pending', reviewReason: 'Pending: the effect was observed, the policy basis is inferred', limitations: 'Only the fixture object and the sibling route were observed', remediation: { status: 'unplanned', reason: 'No remediation was reviewed for the observed cross-tenant case', evidenceRefs: [] } };
    const created = (await h.call('p2o_case_author', { entry: draft })).details;
    const accepted = (await h.call('p2o_case_author', { id: created.id, revision: created.revision, entry: { ...draft, reviewStatus: 'accepted', reviewReason: 'Owner reviewed the observed cross-tenant effect and the inferred policy provenance' } })).details;
    const limitations = 'Policy basis is inferred from the sibling route; the cross-tenant read was reproduced live, but the tenant ownership contract remains unverified';
    const rated = (await h.call('p2o_case_rate', { id: accepted.id, revision: accepted.revision, finding: finding({ severity: 'high', limitations }) })).details;
    expect(rated).toMatchObject({ caseId: accepted.id, caseRevision: accepted.revision, provenance: 'INFERRED_POLICY' });
    expect(rated.finding).toMatchObject({ severity: 'high', limitations });
    const view = (await h.call('p2o_board', { board: 'cases', id: accepted.id })).details;
    expect(view).toMatchObject({ ratingProvenance: 'INFERRED_POLICY', ratingCurrent: true, finding: { severity: 'high', limitations } });
    const store = await h.reader(); try { const row = store.records().filter((item: any) => item.data?.caseRating?.caseId === accepted.id).at(-1); expect(row.data.caseRating).toMatchObject({ provenance: 'INFERRED_POLICY' }); } finally { store.close(); }
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'inferred-out')}`);
    const report = (await h.read(join(h.root, 'inferred-out')))['REPORT.md'];
    expect(report).toContain('provenance **INFERRED_POLICY**'); expect(report).toContain(`- Rating limitation: ${limitations}`);
    // The flag is not a waiver: without the required limitation the same rating is refused and nothing is written.
    await expect(h.call('p2o_case_rate', { id: accepted.id, revision: accepted.revision, finding: finding({ severity: 'high', limitations: '   ' }) })).rejects.toThrow(/INFERRED_POLICY/);
    await expect(h.call('p2o_case_rate', { id: accepted.id, revision: accepted.revision, finding: finding({ severity: 'high' }) })).rejects.toThrow(/INFERRED_POLICY/);
    const after = await h.reader(); try { expect(after.records().filter((item: any) => item.data?.caseRating).length).toBe(1); } finally { after.close(); }
  }));

  it('flags a rating recorded against an older revision once the case is revised', async () => fixture(async h => {
    const built = await populate(h); await rate(h, built, finding());
    const { currentness, staleReasons, independentCurrent, independenceReason, acceptedFinding, readyToRate, canonicalCaseId, recordId, runId, revision, finding: _f, ratedRevision, ratingCurrent, ...draft } = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    await h.call('p2o_case_author', {id: built.accepted.id, revision, entry: { ...draft, reviewReason: 'Owner re-read the exact current claim, task, asset and limitations' } });
    const view = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    expect(view).toMatchObject({ revision: revision + 1, ratedRevision: revision, ratingCurrent: false });
  }));

  it('leaves a case that was never rated exactly as before: no finding field at all', async () => fixture(async h => {
    const built = await populate(h);
    const view = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    expect(view).not.toHaveProperty('finding'); expect(view).not.toHaveProperty('ratedRevision');
  }));
});
