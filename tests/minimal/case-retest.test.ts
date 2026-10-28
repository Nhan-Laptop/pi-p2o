import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, populate } from './helpers/report-fixture.js';

/** R3.5: an owner retest is its own note against one accepted case revision. Hermetic: inert sandbox, real SQLite store. */
const retest = (h: any, built: any, value: Record<string, unknown>) => h.call('p2o_case_retest', { id: built.accepted.id, revision: built.accepted.revision, ...value });
const evidence = (built: any) => built.observation.evidenceId as string;

describe('case retest', () => {
  it('records the verdict against the exact case revision without changing the verdict, review, revision or coverage cells', async () => fixture(async h => {
    const built = await populate(h);
    const recorded = (await retest(h, built, { verdict: 'fixed', reason: 'The remediation was applied and the boundary under test no longer deviates', evidenceRefs: [evidence(built)] })).details;
    expect(recorded).toMatchObject({ caseId: built.accepted.id, caseRevision: built.accepted.revision, verdict: 'fixed' });
    expect(recorded.recordId).toMatch(/^[a-z0-9-]{8,}/);
    const view = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    expect(view).toMatchObject({ revision: built.accepted.revision, verdict: 'confirmed', reviewStatus: 'accepted', currentness: 'current', acceptedFinding: true, retestCurrent: true });
    expect(view.retest).toMatchObject({ caseRevision: built.accepted.revision, verdict: 'fixed', evidenceRefs: [evidence(built)] });
    // A retest is a note like a rating: the cells that pin the case revision stay current, and nothing is re-rated or re-accepted.
    expect((await h.call('p2o_board', { board: 'coverage' })).details.plans[0].counts.stale).toBe(0);
    expect(view).not.toHaveProperty('finding');
    const list = (await h.call('p2o_board', { board: 'cases' })).details.entries;
    expect(list.find((entry: any) => entry.id === built.accepted.id)).toMatchObject({ verdict: 'confirmed', reviewStatus: 'accepted' });
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRetest).length).toBe(1); } finally { store.close(); }
  }));

  it('answers one revision once: a second retest is refused, and revising the case opens the next slot', async () => fixture(async h => {
    const built = await populate(h);
    await retest(h, built, { verdict: 'fixed', reason: 'The remediation was applied and the boundary no longer deviates', evidenceRefs: [evidence(built)] });
    await expect(retest(h, built, { verdict: 'still_reproducible', reason: 'The same effect was reproduced again after the remediation', evidenceRefs: [evidence(built)] })).rejects.toThrow(/already retested/);
    const before = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    const { currentness, staleReasons, independentCurrent, independenceReason, acceptedFinding, readyToRate, canonicalCaseId, recordId, runId, revision, retest: _retest, retestCurrent, ...draft } = before;
    const revised = (await h.call('p2o_case_author', { id: built.accepted.id, revision, entry: { ...draft, reviewReason: 'Owner re-read the exact current claim, task, asset and limitations' } })).details;
    const moved = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    expect(moved).toMatchObject({ revision: revised.revision, retest: { caseRevision: built.accepted.revision, verdict: 'fixed' }, retestCurrent: false });
    await h.call('p2o_case_retest', { id: built.accepted.id, revision: revised.revision, verdict: 'still_reproducible', reason: 'The effect reproduced again on the revised case', evidenceRefs: [evidence(built)] });
    const after = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    expect(after).toMatchObject({ retestCurrent: true, retest: { caseRevision: revised.revision, verdict: 'still_reproducible' } });
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRetest).length).toBe(2); } finally { store.close(); }
  }));

  it('refuses a retest that is not an observation: unknown verdict, short reason, missing or foreign evidence, a stale revision and a case that is not an accepted current finding', async () => fixture(async h => {
    const built = await populate(h), reject = (value: Record<string, unknown>, pattern: RegExp) => expect(retest(h, built, value)).rejects.toThrow(pattern);
    await reject({ verdict: 'looks-fixed', reason: 'A verdict outside the recorded vocabulary is refused', evidenceRefs: [evidence(built)] }, /verdict/);
    await reject({ verdict: 'fixed', reason: 'short', evidenceRefs: [evidence(built)] }, /reason/);
    // The two evidentiary verdicts rest on a same-run receipt; cannot_confirm may honestly cite none.
    await reject({ verdict: 'fixed', reason: 'The remediation was applied and the boundary no longer deviates', evidenceRefs: [] }, /same-run evidence/);
    await reject({ verdict: 'still_reproducible', reason: 'The same effect was reproduced again after the remediation', evidenceRefs: ['evidence-that-does-not-exist'] }, /same-run retest evidence/);
    await reject({ verdict: 'cannot_confirm', reason: 'The fixture environment was rebuilt and the old receipt no longer applies', evidenceRefs: ['evidence-that-does-not-exist'] }, /same-run retest evidence/);
    await reject({ verdict: 'fixed', reason: 'The remediation was applied and the boundary no longer deviates', evidenceRefs: [evidence(built)], unexpected: true }, /unknown|exact|host-owned/i);
    await expect(h.call('p2o_case_retest', { id: built.accepted.id, revision: built.accepted.revision + 5, verdict: 'fixed', reason: 'A stale revision is refused before anything is written', evidenceRefs: [evidence(built)] })).rejects.toThrow(/stale case revision/);
    await expect(h.call('p2o_case_retest', { id: built.pending.id, revision: built.pending.revision, verdict: 'fixed', reason: 'A pending case is not an accepted current finding yet', evidenceRefs: [evidence(built)] })).rejects.toThrow(/accepted confirmed|not a current accepted finding/);
    await expect(h.call('p2o_case_retest', { id: built.accepted.id, revision: built.accepted.revision })).rejects.toThrow(/verdict and a reason/);
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRetest).length).toBe(0); } finally { store.close(); }
  }));

  it('honours cannot_confirm with no evidence and replays a retried request without writing a second note', async () => fixture(async h => {
    const built = await populate(h), request = { requestId: 'retest-once' };
    const uncertain = (await h.call('p2o_case_retest', { id: built.accepted.id, revision: built.accepted.revision, verdict: 'cannot_confirm', reason: 'The fixture environment was rebuilt and the old receipt no longer applies', evidenceRefs: [], ...request })).details;
    expect(uncertain).toMatchObject({ verdict: 'cannot_confirm', evidenceRefs: [] });
    // A retry answers from the retained ACK; only the first write exists.
    const again = (await h.call('p2o_case_retest', { id: built.accepted.id, revision: built.accepted.revision, verdict: 'cannot_confirm', reason: 'The fixture environment was rebuilt and the old receipt no longer applies', evidenceRefs: [], ...request })).details;
    expect(again.recordId).toBe(uncertain.recordId);
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRetest).length).toBe(1); } finally { store.close(); }
  }));

  it('prints the latest retest in REPORT.md and findings.json without changing the finding itself', async () => fixture(async h => {
    const built = await populate(h);
    await retest(h, built, { verdict: 'fixed', reason: 'The remediation was applied and the boundary under test no longer deviates', evidenceRefs: [evidence(built)] });
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'retest-out')}`);
    const files = await h.read(join(h.root, 'retest-out'));
    const report = files['REPORT.md'];
    expect(report).toContain('- Retest (owner-attributed): **fixed** — The remediation was applied and the boundary under test no longer deviates');
    expect(report).toContain(`evidence ${evidence(built)}`);
    expect(report).toContain('A retest says whether the effect still reproduced; it never re-rates or re-accepts the finding.');
    const finding = JSON.parse(files['findings.json']).findings[0];
    expect(finding.retest).toMatchObject({ verdict: 'fixed', caseRevision: built.accepted.revision, current: true, evidenceRefs: [evidence(built)] });
    expect(finding.severity).toBeNull(); // a retest is not a rating
    expect(files['findings.csv'].split('\n')[0]).toContain('"retest_verdict"');
  }));
});
