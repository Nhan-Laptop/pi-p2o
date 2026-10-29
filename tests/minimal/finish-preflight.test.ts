import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockedNegatives, finishPreflight, receiptLooksBlocked } from '../../src/finish-preflight.js';
import { indexRecords, type AssessmentRecord } from '../../src/records.js';
import { fixture, populate } from './helpers/report-fixture.js';

/** P1: a host check at p2o_finish. Hermetic: inert sandbox, real SQLite store, no model, no target. */
const settings = (h: any, p2o: Record<string, unknown>) => writeFile(join(h.root, 'settings.json'), JSON.stringify({ p2o }));
const finishText = (result: any) => result.content[0].text as string;
const rating = { severity: 'medium', basis: 'Confirmed boundary deviation reaching only the tested identity’s own object in the fixture' };
/** P18/A9: every run records a default campaign, so a finish without a plan goal records why the campaign stops. */
const PARTIAL = 'Fixture run stops before any plan goal was recorded, so the campaign ends incomplete.';

describe('finish preflight', () => {
  it('always appends the unfinished items after the existing text and never refuses a finish', async () => fixture(async h => {
    await populate(h);
    const text = finishText(await h.call('p2o_finish', {}));
    expect(text).toContain('FINISH PREFLIGHT (host check)'); expect(text).toMatch(/- PENDING_CASE \(1\)/); expect(text).toMatch(/- UNRATED_ACCEPTED_CASE \(1\)/);
    expect(text.indexOf('Coverage:')).toBeLessThan(text.indexOf('Write the final report now')); expect(text.indexOf('Write the final report now')).toBeLessThan(text.indexOf('FINISH PREFLIGHT')); // appended, never prepended
    expect(text).toMatch(/not findings and not a safety verdict/);
  }));

  it('keeps the items for the report under REMAINING WORK, with no gate setting to flip', async () => fixture(async h => {
    await populate(h);
    // A stale settings file that still carries the removed key must not change anything: there is no finish gate any more.
    await settings(h, { finishGate: 'confirm' });
    const text = finishText(await h.call('p2o_finish', {}));
    expect(text).toContain('Container removal verified'); expect(text).toContain('FINISH PREFLIGHT (host check)');
    const report = await readFile(join(h.root, '.p2o-reports', `report-${await h.runId()}-final`, 'REPORT.md'), 'utf8');
    expect(report).toContain('## REMAINING WORK'); expect(report).toMatch(/- Completion: \*\*incomplete\*\*/); expect(report).toMatch(/\| PENDING_CASE \| obligation \| 1 \|/); expect(report).toMatch(/\| UNRATED_ACCEPTED_CASE \| obligation \| 1 \|/);
  }));

  it('reports a clean block once every item is resolved', async () => fixture(async h => {
    const built = await populate(h);
    await h.call('p2o_case_rate', {id: built.accepted.id, revision: built.accepted.revision, finding: rating });
    const pending = (await h.call('p2o_board', { board: 'cases', id: built.pending.id })).details;
    const { currentness, staleReasons, independentCurrent, independenceReason, acceptedFinding, readyToRate, canonicalCaseId, recordId, runId, revision, ...draft } = pending;
    await h.call('p2o_case_author', {id: built.pending.id, revision, entry: { ...draft, reviewStatus: 'withdrawn', reviewReason: 'Withdrawn: duplicate of the accepted fixture case' } });
    const text = finishText(await h.call('p2o_finish', {}));
    // M4: the fixture's one demonstrated claim has no successor and no wall, so the block lists it — as an advisory, because p2o
    // has no finish gate. Nothing is blocking, which is what "clean" now means. A3 adds two honest advisory facts no owner action
    // resolves here: a derived cell carries no gapRefs, so the fixture's open gap stays unreferenced, and its blocked work identity
    // was settled without a handoff.
    // A6.2: the derived research-debt report now has an aggregate advisory row, so the fixture has four advisories.
    // 2026-10-27 (A3/D32): the A3-settled impact goal adds IMPACT_UNATTEMPTED, because the fixture's work is investigation and
    // no exploitation/chaining step was ever admitted; the goal alone is not an attempt, so this is an honest fifth advisory.
    expect(text).toMatch(/0 open obligation\(s\), 5 advisory/);
    expect(text).toMatch(/IMPACT_UNATTEMPTED \(1\):/);
    expect(text).toMatch(/RESEARCH_DEBT \(4\):/);
    expect(text).toMatch(/OPEN_GAP_UNREFERENCED \(1\):/);
    expect(text).toMatch(/ORPHAN_TASK \(1\):/);
    expect(text).toMatch(/PRIMITIVE_UNCHAINED \(1\):/);
    expect(text).toContain('not a safety verdict');
  }));

  it('names a missing coverage plan and an unreviewed handoff in the same block', async () => fixture(async h => {
    await h.command('--target ./source');
    expect(finishText(await h.call('p2o_finish', { partial: PARTIAL }))).toMatch(/NO_COVERAGE_PLAN/);
  }));

  it('lists a High finding with no independent validation as advisory, and drops it once a waiver is recorded', async () => fixture(async h => {
    const built = await populate(h), high = { severity: 'high', basis: 'Confirmed boundary deviation reaching beyond the tested identity’s own object in the fixture' };
    await h.call('p2o_case_rate', {id: built.accepted.id, revision: built.accepted.revision, finding: high });
    const block = (text: string) => text.slice(text.indexOf('FINISH PREFLIGHT'));
    expect(block(finishText(await h.call('p2o_finish', {})))).toMatch(/- HIGH_WITHOUT_INDEPENDENCE \(1\)/);
  }));
  it('does not list it when the rating carries an independence waiver', async () => fixture(async h => {
    const built = await populate(h);
    await h.call('p2o_case_rate', {id: built.accepted.id, revision: built.accepted.revision, finding: { severity: 'high', basis: 'Confirmed boundary deviation reaching beyond the tested identity’s own object in the fixture', independenceWaiver: 'Solo run: no second actor was available to repeat it' } });
    expect(finishText(await h.call('p2o_finish', {}))).not.toContain('HIGH_WITHOUT_INDEPENDENCE');
  }));

  it('names the always-applicable WSTG tests with no cell, but only for a run that addresses WSTG tests at all', async () => {
    await fixture(async h => { await populate(h, undefined, { tested: 'wstg-athz-04', blocked: 'wstg-sess-05' }); const text = finishText(await h.call('p2o_finish', {})); expect(text).toMatch(/- WSTG_APPLICABLE_UNPLANNED \(\d+\): wstg-/); });
    await fixture(async h => { await populate(h); expect(finishText(await h.call('p2o_finish', {}))).not.toContain('WSTG_APPLICABLE_UNPLANNED'); });
  });

  it('flags a surface/coverage note that never became a counted cell, advisory only', async () => fixture(async h => {
    await h.command('--target ./source');
    await h.call('p2o_coverage_plan', {plan: { title: 'Denominator not yet built', status: 'active', reason: 'Plan created before any cell exists', exclusions: [], unknownScope: ['Full surface not yet enumerated'] } });
    await h.call('p2o_note', { kind: 'coverage', text: 'Looked at the login surface informally', surface: '/login', risk: 'authz', outcome: 'clean' });
    await h.call('p2o_surface', { component: 'login-api', entryPoint: 'POST /login' });
    const result = await h.call('p2o_finish', { partial: PARTIAL });
    expect(finishText(result)).toMatch(/- UNPROMOTED_COVERAGE_NOTE \(2\)/);
    expect(result.details.preflight.advisory.map((item: any) => item.code)).toContain('UNPROMOTED_COVERAGE_NOTE');
    expect(result.details.preflight.obligations.map((item: any) => item.code)).not.toContain('UNPROMOTED_COVERAGE_NOTE');
  }));
  it('does not flag it once the plan has at least one cell', async () => fixture(async h => {
    await populate(h);
    expect(finishText(await h.call('p2o_finish', {}))).not.toContain('UNPROMOTED_COVERAGE_NOTE');
  }));

  it('flags a stated --goal that never became a recorded plan goal', async () => fixture(async h => {
    await h.command('--target ./source --goal "Assess the login boundary for IDOR"');
    // A6.6 (D9): a stated --goal records a campaign frame, so the final path carries the partial reason; the preflight
    // advisory is still rendered and still names the missing goal.
    const text = finishText(await h.call('p2o_finish', { partial: 'Fixture records a stated objective without a plan goal.' }));
    expect(text).toMatch(/- NO_GOAL_RECORDED \(1\)/);
  }));
  it('does not flag it once the stated objective is recorded as a goal', async () => fixture(async h => {
    await h.command('--target ./source --goal "Assess the login boundary for IDOR"');
    await h.call('p2o_goal_author', {entry: { kind: 'goal', title: 'Assess the login boundary for IDOR', status: 'proposed', reason: 'Operator-stated objective turned into a tracked goal', criteria: ['Login IDOR surface enumerated'], exclusions: ['Out of scope: payment flows'], proof: { kind: 'capability', capability: { kind: 'http.request', subject: 'login' } } } });
    expect(finishText(await h.call('p2o_finish', {}))).not.toContain('NO_GOAL_RECORDED');
  }));
  it('does not flag a run with no stated --goal at all', async () => fixture(async h => {
    await h.command('--target ./source');
    expect(finishText(await h.call('p2o_finish', { partial: PARTIAL }))).not.toContain('NO_GOAL_RECORDED');
  }));
});

describe('NEGATIVE_MAY_BE_BLOCKED (U6)', () => {
  const http = (id: string, hops: string[], exitCode = 0, operation = 'http'): AssessmentRecord => ({ id, runId: 'run-x', at: '2030', by: 'worker-a', workerId: 'worker-a', kind: 'evidence', text: 'receipt', data: { operation, exitCode, http: { hops } } });
  const hop = (status: string, url = 'https://example.invalid/x') => `${status} GET ${url} → 93.184.216.34 (public)`;
  it('treats only a final 401, 403 or 429, or no response at all, from p2o_http as blocked', () => {
    for (const status of ['401', '403', '429']) expect(receiptLooksBlocked(http('r', [hop(status)])), status).toBe(true);
    expect(receiptLooksBlocked(http('r', [hop('302'), hop('403')]))).toBe(true);
    expect(receiptLooksBlocked(http('r', [], 7))).toBe(true);
    expect(receiptLooksBlocked(http('r', [hop('no-status')], 28))).toBe(true);
    for (const status of ['200', '404', '500', '302']) expect(receiptLooksBlocked(http('r', [hop(status)])), status).toBe(false);
    expect(receiptLooksBlocked(http('r', [hop('403'), hop('200')]))).toBe(false); // the final response wins
    expect(receiptLooksBlocked(http('r', Array.from({ length: 6 }, () => hop('403'))))).toBe(false); // capped hop list hides the final response
    expect(receiptLooksBlocked(http('r', [hop('403')], 0, 'shell'))).toBe(false); // shell and net receipts carry no structured status
    expect(receiptLooksBlocked(http('r', [], 0))).toBe(false); expect(receiptLooksBlocked(undefined)).toBe(false);
  });
  it('flags a ruled-out item only when it cites receipts and every one of them looks blocked', () => {
    const byId = new Map<string, AssessmentRecord>(['b1', 'b2'].map(id => [id, http(id, [hop('403')])]).concat([['ok', http('ok', [hop('200')])]]) as Array<[string, AssessmentRecord]>);
    expect(blockedNegatives([{ id: 'all', refs: ['b1', 'b2'] }, { id: 'mixed', refs: ['b1', 'ok'] }, { id: 'none', refs: [] }, { id: 'unknown', refs: ['b1', 'missing'] }], byId)).toEqual(['all']);
  });
  it('adds an advisory code for a ruled_out claim resting on blocked receipts, stays silent when integrity is off, and never blocks', () => {
    const claim = (id: string, refs: string[]): AssessmentRecord => ({ id, runId: 'run-x', at: '2030', by: 'worker-a', kind: 'candidate', surface: '/admin', risk: 'authorization', text: id, refs, data: { candidate: id, closure: 'ruled_out', execution: 'tested', evidenceRefs: refs, negativeControls: [] } });
    const index = indexRecords([http('b1', [hop('403')]), http('ok', [hop('200')]), claim('c-blocked', ['b1']), claim('c-open', ['ok'])], 'run-x');
    const on = finishPreflight(index, { integrity: 'annotate' }), item = on.advisory.find(entry => entry.code === 'NEGATIVE_MAY_BE_BLOCKED');
    expect(item).toMatchObject({ level: 'advisory', count: 1, ids: ['c-blocked'] });
    expect(on.obligations.map((entry: any) => entry.code)).not.toContain('NEGATIVE_MAY_BE_BLOCKED');
    expect(on.signature).toBe(finishPreflight(indexRecords([http('b1', [hop('200')]), http('ok', [hop('200')]), claim('c-blocked', ['b1']), claim('c-open', ['ok'])], 'run-x'), { integrity: 'annotate' }).signature);
    expect(finishPreflight(index, { integrity: 'off' }).advisory.map(entry => entry.code)).not.toContain('NEGATIVE_MAY_BE_BLOCKED');
  });
  it('is silent in a run whose receipts are shell output', async () => fixture(async h => {
    await populate(h, undefined, { tested: 'wstg-athz-04' });
    expect(finishText(await h.call('p2o_finish', {}))).not.toContain('NEGATIVE_MAY_BE_BLOCKED');
  }));
});
