import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendRecord } from '../../src/records.js';
import { fixture, populate, seedEvidence } from './helpers/report-fixture.js';

/**
 * R3.5 retest note + W-AA/B independence: a still_reproducible/fixed verdict must cite a same-run receipt a worker other than the
 * finding's claim author recorded. The owner note itself is never a second pair of eyes, the host derives the provenance and stores
 * it, and the report says which kind of retest a reader is looking at.
 */
const retest = (h: any, built: any, value: Record<string, unknown>) => h.call('p2o_case_retest', { id: built.accepted.id, revision: built.accepted.revision, ...value });
/** The owner receipt the fixture already has: same-run, but recorded by the owner — accepted by the old rule, refused by W-AA. */
const ownerEvidence = (built: any) => built.observation.evidenceId as string;

/** A retest note written before the independence fields existed: no independentReplay/retesters, so the report must not imply one. */
async function legacyRetest(h: any, built: any, evidenceRefs: string[]): Promise<string> {
  const [run] = (await readdir(join(h.root, 'control'))).filter((name: string) => name.startsWith('p2o-run-'));
  if (!run) throw new Error('legacyRetest needs the active run control directory');
  const id = randomUUID();
  await appendRecord(join(h.root, 'control', run, 'records.sqlite'), { id, version: 2, runId: await h.runId(), at: new Date().toISOString(),
    by: 'owner', kind: 'note', text: `case ${built.accepted.id} retest fixed; legacy owner retest`,
    data: { caseRetest: { caseId: built.accepted.id, caseRevision: built.accepted.revision, verdict: 'fixed', reason: 'Legacy owner retest recorded before the independence check', evidenceRefs } } });
  return id;
}

describe('case retest', () => {
  it('records the verdict against the exact case revision without changing the verdict, review, revision or coverage cells', async () => fixture(async h => {
    const built = await populate(h), replay = await seedEvidence(h, 'worker-b');
    const recorded = (await retest(h, built, { retestOutcome: 'fixed', reason: 'The remediation was applied and the boundary under test no longer deviates', evidenceRefs: [replay] })).details;
    expect(recorded).toMatchObject({ caseId: built.accepted.id, caseRevision: built.accepted.revision, verdict: 'fixed', independentReplay: true, retesters: ['worker-b'] });
    expect(recorded.recordId).toMatch(/^[a-z0-9-]{8,}/);
    const view = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    expect(view).toMatchObject({ revision: built.accepted.revision, verdict: 'confirmed', reviewStatus: 'accepted', currentness: 'current', acceptedFinding: true, retestCurrent: true });
    expect(view.retest).toMatchObject({ caseRevision: built.accepted.revision, verdict: 'fixed', evidenceRefs: [replay], independentReplay: true, retesters: ['worker-b'] });
    // A retest is a note like a rating: the cells that pin the case revision stay current, and nothing is re-rated or re-accepted.
    expect((await h.call('p2o_board', { board: 'coverage' })).details.plans[0].counts.stale).toBe(0);
    expect(view).not.toHaveProperty('finding');
    const list = (await h.call('p2o_board', { board: 'cases' })).details.entries;
    expect(list.find((entry: any) => entry.id === built.accepted.id)).toMatchObject({ verdict: 'confirmed', reviewStatus: 'accepted' });
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRetest).length).toBe(1); } finally { store.close(); }
  }));

  it('answers one revision once: a second retest is refused, and revising the case opens the next slot', async () => fixture(async h => {
    const built = await populate(h), first = await seedEvidence(h, 'worker-b'), second = await seedEvidence(h, 'worker-c');
    await retest(h, built, { retestOutcome: 'fixed', reason: 'The remediation was applied and the boundary no longer deviates', evidenceRefs: [first] });
    await expect(retest(h, built, { retestOutcome: 'still_reproducible', reason: 'The same effect was reproduced again after the remediation', evidenceRefs: [second] })).rejects.toThrow(/already retested/);
    const before = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    const { currentness, staleReasons, independentCurrent, independenceReason, acceptedFinding, readyToRate, canonicalCaseId, recordId, runId, revision, retest: _retest, retestCurrent, ...draft } = before;
    const revised = (await h.call('p2o_case_author', { id: built.accepted.id, revision, entry: { ...draft, reviewReason: 'Owner re-read the exact current claim, task, asset and limitations' } })).details;
    const moved = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    expect(moved).toMatchObject({ revision: revised.revision, retest: { caseRevision: built.accepted.revision, verdict: 'fixed' }, retestCurrent: false });
    await h.call('p2o_case_retest', { id: built.accepted.id, revision: revised.revision, retestOutcome: 'still_reproducible', reason: 'The effect reproduced again on the revised case', evidenceRefs: [second] });
    const after = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    expect(after).toMatchObject({ retestCurrent: true, retest: { caseRevision: revised.revision, verdict: 'still_reproducible', independentReplay: true, retesters: ['worker-c'] } });
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRetest).length).toBe(2); } finally { store.close(); }
  }));

  it('refuses a retest that is not an observation: unknown verdict, short reason, missing or foreign evidence, a stale revision and a case that is not an accepted current finding', async () => fixture(async h => {
    const built = await populate(h), owner = ownerEvidence(built), discovery = await seedEvidence(h, 'worker-a'),
      reject = (value: Record<string, unknown>, pattern: RegExp) => expect(retest(h, built, value)).rejects.toThrow(pattern);
    await reject({ retestOutcome: 'looks-fixed', reason: 'A verdict outside the recorded vocabulary is refused', evidenceRefs: [owner] }, /verdict/);
    await reject({ retestOutcome: 'fixed', reason: 'short', evidenceRefs: [owner] }, /reason/);
    // The two evidentiary verdicts rest on a same-run receipt; cannot_confirm may honestly cite none.
    await reject({ retestOutcome: 'fixed', reason: 'The remediation was applied and the boundary no longer deviates', evidenceRefs: [] }, /same-run evidence/);
    await reject({ retestOutcome: 'still_reproducible', reason: 'The same effect was reproduced again after the remediation', evidenceRefs: ['evidence-that-does-not-exist'] }, /same-run retest evidence/);
    await reject({ retestOutcome: 'cannot_confirm', reason: 'The fixture environment was rebuilt and the old receipt no longer applies', evidenceRefs: ['evidence-that-does-not-exist'] }, /same-run retest evidence/);
    // W-AA/B: the owner's own receipt is not a second pair of eyes, and the claim author cannot confirm its own finding.
    await reject({ retestOutcome: 'fixed', reason: 'The remediation was applied and the boundary under test no longer deviates', evidenceRefs: [owner] }, /RETEST_NEEDS_INDEPENDENT_REPLAY/);
    await reject({ retestOutcome: 'still_reproducible', reason: 'The same effect was reproduced again after the remediation', evidenceRefs: [discovery] }, /RETEST_NEEDS_INDEPENDENT_REPLAY/);
    await reject({ retestOutcome: 'fixed', reason: 'The remediation was applied and the boundary no longer deviates', evidenceRefs: [owner, discovery] }, /RETEST_NEEDS_INDEPENDENT_REPLAY/);
    await reject({ retestOutcome: 'fixed', reason: 'The remediation was applied and the boundary no longer deviates', evidenceRefs: [owner], unexpected: true }, /unknown|exact|host-owned/i);
    await expect(h.call('p2o_case_retest', { id: built.accepted.id, revision: built.accepted.revision + 5, retestOutcome: 'fixed', reason: 'A stale revision is refused before anything is written', evidenceRefs: [owner] })).rejects.toThrow(/stale case revision/);
    await expect(h.call('p2o_case_retest', { id: built.pending.id, revision: built.pending.revision, retestOutcome: 'fixed', reason: 'A pending case is not an accepted current finding yet', evidenceRefs: [owner] })).rejects.toThrow(/accepted confirmed|not a current accepted finding/);
    await expect(h.call('p2o_case_retest', { id: built.accepted.id, revision: built.accepted.revision })).rejects.toThrow(/retestOutcome and a reason/);
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRetest).length).toBe(0); } finally { store.close(); }
  }));

  it('honours cannot_confirm with no evidence and replays a retried request without writing a second note', async () => fixture(async h => {
    const built = await populate(h), request = { requestId: 'retest-once' };
    const uncertain = (await h.call('p2o_case_retest', { id: built.accepted.id, revision: built.accepted.revision, retestOutcome: 'cannot_confirm', reason: 'The fixture environment was rebuilt and the old receipt no longer applies', evidenceRefs: [], ...request })).details;
    expect(uncertain).toMatchObject({ verdict: 'cannot_confirm', evidenceRefs: [], independentReplay: false });
    // A retry answers from the retained ACK; only the first write exists.
    const again = (await h.call('p2o_case_retest', { id: built.accepted.id, revision: built.accepted.revision, retestOutcome: 'cannot_confirm', reason: 'The fixture environment was rebuilt and the old receipt no longer applies', evidenceRefs: [], ...request })).details;
    expect(again.recordId).toBe(uncertain.recordId);
    expect(again.independentReplay).toBe(false);
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRetest).length).toBe(1); } finally { store.close(); }
  }));

  it('prints the latest retest in REPORT.md and findings.json without changing the finding itself', async () => fixture(async h => {
    const built = await populate(h), replay = await seedEvidence(h, 'worker-b');
    await retest(h, built, { retestOutcome: 'fixed', reason: 'The remediation was applied and the boundary under test no longer deviates', evidenceRefs: [replay] });
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'retest-out')}`);
    const files = await h.read(join(h.root, 'retest-out'));
    const report = files['REPORT.md'];
    expect(report).toContain('- Retest (independent replay by worker-b): **fixed** — The remediation was applied and the boundary under test no longer deviates');
    expect(report).toContain(`evidence ${replay}`);
    expect(report).toContain('A retest says whether the effect still reproduced; it never re-rates or re-accepts the finding.');
    const finding = JSON.parse(files['findings.json']).findings[0];
    expect(finding.retest).toMatchObject({ verdict: 'fixed', caseRevision: built.accepted.revision, current: true, evidenceRefs: [replay], provenance: 'independent_replay', retesters: ['worker-b'] });
    expect(finding.severity).toBeNull(); // a retest is not a rating
    expect(files['findings.csv'].split('\n')[0]).toContain('"retest_verdict"');
  }));

  it('labels a legacy retest note as provenance unrecorded instead of implying an independent replay', async () => fixture(async h => {
    const built = await populate(h), noteId = await legacyRetest(h, built, [ownerEvidence(built)]);
    const view = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    expect(view.retest).toMatchObject({ recordId: noteId, verdict: 'fixed', caseRevision: built.accepted.revision });
    expect(view.retest).not.toHaveProperty('independentReplay');
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'legacy-out')}`);
    const files = await h.read(join(h.root, 'legacy-out'));
    expect(files['REPORT.md']).toContain('- Retest (owner-attributed; provenance not recorded before the independence check): **fixed**');
    expect(JSON.parse(files['findings.json']).findings[0].retest).toMatchObject({ provenance: 'unrecorded', retesters: [] });
  }));
});
