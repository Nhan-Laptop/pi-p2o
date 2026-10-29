import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { completionLine, deriveCompletion } from '../../src/completion.js';
import { goalProofRefusal, type ProofData } from '../../src/goal-proof.js';
import { chainObligations } from '../../src/obligations.js';
import { situationLine, summarizeSituation, type SituationSnapshot } from '../../src/situation.js';
import type { ChainClaim } from '../../src/chain-view.js';
import type { PlanEntry } from '../../src/planning.js';
import type { AssessmentTask } from '../../src/tasks.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * M3: completion is derived, exporting a report is not termination, and stopping records what the run still owes. The unit tests
 * pin the derivation and the situation backlog pair; the fixture tests pin the three verbs — export writes and ends nothing, a
 * settled obligation turns the same ledger `complete`, and stop carries the obligation into the recorded outcome.
 */
const text = (result: any) => result.content[0].text as string;
const READ = { kind: 'http.request', subject: 'internal-api' } as const;
const claim = (recordId: string, overrides: Partial<ChainClaim> = {}): ChainClaim => ({
  candidate: recordId, recordId, closure: 'open_proof_gap', execution: 'not_tested', surface: '/x', ...overrides,
} as ChainClaim);
const demonstrated = (recordId: string): ChainClaim =>
  claim(recordId, { closure: 'confirmed', execution: 'tested', gained: [READ] } as Partial<ChainClaim>);
const plan = (overrides: Partial<PlanEntry>): PlanEntry => ({
  id: 'plan-x', runId: 'run', revision: 1, recordId: 'rec-plan-x', kind: 'todo', title: 'Fixture row', status: 'open',
  reason: 'Fixture plan row written for the completion test', ...overrides,
} as PlanEntry);

describe('completion is derived, never called (M3)', () => {
  it('is complete only when no goal, primitive or ready step is left open', () => {
    const done = deriveCompletion({ plans: [], claims: [], tasks: [] });
    expect(done).toMatchObject({ state: 'complete', remaining: 0, items: [] });
    expect(completionLine(done)).toBe('complete: no goal, primitive or ready step is left open');

    const primitive = deriveCompletion({ plans: [], claims: [demonstrated('rec-a')], tasks: [] });
    expect(primitive).toMatchObject({ state: 'incomplete', remaining: 1 });
    expect(primitive.items[0]).toMatchObject({ code: 'PRIMITIVE_UNCHAINED', count: 1, ids: ['rec-a'] });
    expect(completionLine(primitive)).toContain('PRIMITIVE_UNCHAINED 1');

    const openGoal = deriveCompletion({ plans: [plan({ kind: 'goal', status: 'active', criteria: ['bounded'] })], claims: [], tasks: [] });
    expect(openGoal.items.map(item => item.code)).toEqual(['GOAL_UNSETTLED']);
    // P16.1: a reviewed goal is settled only while its proof holds — the capability the run actually gained.
    const proof = { kind: 'capability', capability: READ } as const;
    const reviewedGoal = deriveCompletion({ plans: [plan({ kind: 'goal', status: 'reviewed', supportRefs: ['ev-1'], proof })], claims: [demonstrated('rec-a')], tasks: [] });
    // The goal itself is settled; the demonstrated claim is still owed a successor (M4), so the run is not complete yet.
    expect(reviewedGoal.items.map(item => item.code)).toEqual(['PRIMITIVE_UNCHAINED']);
    const settled = deriveCompletion({ plans: [plan({ kind: 'goal', status: 'reviewed', supportRefs: ['ev-1'], proof: { kind: 'case', ref: 'case-1' } })], claims: [], tasks: [],
      cases: [{ id: 'case-1', verdict: 'confirmed', reviewStatus: 'accepted', currentness: 'current' }] });
    expect(settled.state).toBe('complete');
    const unproven = deriveCompletion({ plans: [plan({ kind: 'goal', status: 'reviewed', supportRefs: ['ev-1'], proof })], claims: [claim('rec-a')], tasks: [] });
    expect(unproven.state).toBe('incomplete');
    expect(unproven.items.map(item => [item.code, item.ids])).toEqual([['GOAL_UNPROVEN', ['plan-x']]]);
    expect(completionLine(unproven)).toContain('a status is not a demonstration');
    // A goal with no proof cannot be trusted as settled: legacy rows and status-only revisions land here.
    const legacy = deriveCompletion({ plans: [plan({ kind: 'goal', status: 'closed', supportRefs: ['ev-1'] })], claims: [], tasks: [] });
    expect(legacy.items.map(item => item.code)).toEqual(['GOAL_UNPROVEN']);
    const coverage = deriveCompletion({ plans: [plan({ kind: 'goal', status: 'reviewed', supportRefs: ['ev-1'], proof: { kind: 'coverage', ref: 'cov-1' } })], claims: [], tasks: [],
      coverage: [{ planId: 'cov-1', cells: [{ id: 'cell-1', execution: 'tested' }, { id: 'cell-2', execution: 'blocked' }] }] });
    expect(coverage.state).toBe('complete');
  });

  it('counts a ready chain step as remaining work, and stops counting it once dispatched', () => {
    const plans = [plan({ id: 'todo-1', step: 1, chainOf: 'chain-c', claimRefs: ['rec-a'] }),
      plan({ id: 'todo-2', step: 2, chainOf: 'chain-c', claimRefs: ['rec-b'], needs: [READ] })];
    const claims = [demonstrated('rec-a'), claim('rec-b')];
    const ready = deriveCompletion({ plans, claims, tasks: [] });
    expect(ready.items.map(item => [item.code, item.ids])).toEqual([['CHAIN_READY', ['todo-2']]]);
    // A live task that cites the provider is taking the step: the obligation clears without anything being claimed done.
    const dispatched = [{ id: 'task-1', status: 'running', work: { claimRefs: ['rec-a'] } } as unknown as AssessmentTask];
    expect(chainObligations({ plans, claims, tasks: dispatched }).ready).toEqual([]);
    expect(deriveCompletion({ plans, claims, tasks: dispatched }).remaining).toBe(0);
  });

  it('renders the backlog pair so "not shown" is not read as "not planned"', () => {
    const cell = (execution: string) => ({ effectiveExecution: execution, effectiveAssessment: 'open_gap' });
    const snapshot = summarizeSituation({ tasks: [], cases: [], coverage: [{ cells: [cell('tested'), cell('planned'), cell('planned')], omittedCells: 2 }] as unknown as SituationSnapshot extends never ? never : any, claims: [] });
    expect(snapshot).toMatchObject({ coverageTested: 1, coverageCells: 3, coveragePlanned: 2, coverageOmitted: 2 });
    expect(situationLine(snapshot)).toContain('coverage 1/3 (planned 2 unreached, 2 omitted)');
    // With nothing unreached and nothing omitted the pair is noise and is left out.
    const quiet = summarizeSituation({ tasks: [], cases: [], coverage: [{ cells: [cell('tested')], omittedCells: 0 }] as unknown as any, claims: [] });
    expect(situationLine(quiet)).toContain('coverage 1/1.');
  });
});

describe('export writes, ends nothing; stop records the obligation (M3)', () => {
  it('exports a report with one unchained primitive, leaves the run incomplete and still active', async () => fixture(async h => {
    await populate(h);
    const first = await h.call('p2o_finish', { export: true });
    // A6.2: the one unchained primitive is joined by the three gateable research-debt items the fixture's shape earns
    // (post-hoc plan, unreferenced gap, and the same primitive named as debt); the unrun cell is P19/D planning signal, so 1 + 3.
    expect(first.details).toMatchObject({ state: 'incomplete', remaining: 4 });
    expect(first.details.completion.items[0].code).toBe('PRIMITIVE_UNCHAINED');
    expect(first.details.completion.items.map((item: { code: string }) => item.code)).toContain('RESEARCH_DEBT');
    expect(text(first)).toContain('STATE: incomplete');
    expect(text(first)).toContain('Nothing was torn down or ended');
    const files = await readdir(first.details.reportPath);
    expect(files).toContain('REPORT.md');
    // The run is still active: a second export is allowed and writes a new directory rather than overwriting.
    const second = await h.call('p2o_finish', { export: true });
    expect(second.details.reportPath).not.toBe(first.details.reportPath);
    expect((await h.call('p2o_board', { board: 'tasks' })).details.total).toBeGreaterThan(0);
  }));

  it('reaches complete only once the primitive is walled and every named debt item is discharged', async () => fixture(async h => {
    const built = await populate(h);
    const exported = await h.call('p2o_finish', { export: true });
    expect(exported.details).toMatchObject({ state: 'incomplete', remaining: 4 });
    const report = await readFile(join(exported.details.reportPath, 'REPORT.md'), 'utf8');
    expect(report).toContain('## REMAINING WORK');
    expect(report).toContain('PRIMITIVE_UNCHAINED');
    expect(report).toMatch(/- Completion: \*\*incomplete\*\* — 4 obligation\(s\)/);
    const debtItem = exported.details.completion.items.find((item: { code: string }) => item.code === 'RESEARCH_DEBT');
    expect(debtItem.count).toBe(3);
    const ids: string[] = [...debtItem.ids];
    // A deferred row naming the claim is the wall M4 asks for; the same row names the debt item it answers.
    const primitive = ids.find(id => id.startsWith('debt-primitive-unchained-'))!;
    await h.call('p2o_goal_author', {entry: { kind: 'todo', title: 'Wall for the fixture claim', status: 'deferred',
      reason: 'Ruled-out successor: the next step needs an actor this fixture does not model', claimRefs: [built.claim.id], debtRefs: [primitive] } });
    const walled = await h.call('p2o_finish', { export: true });
    // One wall answers one named item: the other two are still owed and still printed by id.
    expect(walled.details).toMatchObject({ state: 'incomplete', remaining: 2 });
    for (const id of ids.filter(id => id !== primitive)) {
      await h.call('p2o_goal_author', {entry: { kind: 'todo', title: `Discharge ${id}`, status: 'deferred',
        reason: 'Bounded discharge recorded for the fixture: the item is answered by a wall, not by declaring the run done', debtRefs: [id] } });
    }
    const settled = await h.call('p2o_finish', { export: true });
    expect(settled.details).toMatchObject({ state: 'complete', remaining: 0 });
    expect(text(settled)).toContain('STATE: complete');
    const after = await readFile(join(settled.details.reportPath, 'REPORT.md'), 'utf8');
    expect(after).toMatch(/- Completion: \*\*complete\*\* — 0 obligation\(s\)/);
  }));

  it('renders the stored outcome next to the derived completion and flags the mismatch in the final snapshot', async () => fixture(async h => {
    const built = await populate(h);
    // A6.2: derived completion needs every named item discharged before it can read "complete"; only the stored outcome can lag.
    const exported = await h.call('p2o_finish', { export: true });
    const ids: string[] = exported.details.completion.items.find((item: { code: string }) => item.code === 'RESEARCH_DEBT').ids;
    const primitive = ids.find(id => id.startsWith('debt-primitive-unchained-'))!;
    await h.call('p2o_goal_author', {entry: { kind: 'todo', title: 'Wall for the final-snapshot mismatch', status: 'deferred',
      reason: 'Ruled-out successor: the next step needs an actor this fixture does not model', claimRefs: [built.claim.id], debtRefs: [primitive] } });
    for (const id of ids.filter(id => id !== primitive)) {
      await h.call('p2o_goal_author', {entry: { kind: 'todo', title: `Discharge ${id}`, status: 'deferred',
        reason: 'Bounded discharge recorded for the fixture: the item is answered by a wall, not by declaring the run done', debtRefs: [id] } });
    }
    const result = await h.call('p2o_finish', {});
    expect(result.details.reportPath).toMatch(/-final$/);
    const report = await readFile(join(result.details.reportPath, 'REPORT.md'), 'utf8');
    expect(report).toContain('Derived completion: **complete**');
    expect(report).toContain('stored outcome: **incomplete**');
    expect(report).toContain('**MISMATCH**');
    const manifest = JSON.parse(await readFile(join(result.details.reportPath, 'report-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ kind: 'final', completion: 'complete', outcome: { assessmentOutcome: 'incomplete' } });
  }));

  it('prints each goal proof and whether it holds (P16.1)', async () => fixture(async h => {
    await populate(h);
    await h.call('p2o_goal_author', {entry: { kind: 'goal', title: 'Demonstrate one inert read on the fixture surface', status: 'active',
      reason: 'Bounded goal whose proof is a capability this fixture does not gain', criteria: ['A confirmed and tested claim gains the read'],
      proof: { kind: 'capability', capability: { kind: 'file.read', subject: 'inert-file' } } } });
    const exported = await h.call('p2o_finish', { export: true });
    const report = await readFile(join(exported.details.reportPath, 'REPORT.md'), 'utf8');
    expect(report).toContain('| Goal | Status | Proof | Settled |');
    expect(report).toContain('file.read');expect(report).toContain('inert-file');
    // The proof does not hold here, and the report says so rather than letting the row's status speak for it.
    expect(report).toContain('no — GOAL');expect(report).toContain('UNPROVEN');
    expect(exported.details.completion.items.map((item: { code: string }) => item.code)).toContain('GOAL_UNSETTLED');
  }));

  it('records the outstanding obligation in the stopped outcome', async () => fixture(async h => {
    await populate(h);
    await h.command('stop');
    const store = await h.reader();
    try {
      const outcome = store.outcome() as { assessmentOutcome: string; remaining?: string };
      expect(outcome.assessmentOutcome).toBe('cancelled');
      expect(outcome.remaining).toContain('incomplete: 4 obligation(s)');
      expect(outcome.remaining).toContain('PRIMITIVE_UNCHAINED');
      // A6.2: the stopped outcome carries the derived debt too, so a resume reads the same obligation list the round saw.
      expect(outcome.remaining).toContain('RESEARCH_DEBT');
    } finally { store.close(); }
  }));
});

describe('no finish-gate symbol survives (M3)', () => {
  it('has no FinishGate, DEFAULT_FINISH_GATE or settings.finishGate anywhere in the runtime', async () => {
    const root = join(import.meta.dirname, '..', '..');
    const offenders: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { if (!['node_modules', 'dist', 'tmp'].includes(entry.name)) await walk(path); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const text = await readFile(path, 'utf8');
        if (/FinishGate|DEFAULT_FINISH_GATE|finishGate/.test(text)) offenders.push(path.slice(root.length + 1));
      }
    };
    await walk(join(root, 'src'));
    await walk(join(root, 'extensions'));
    expect(offenders).toEqual([]);
  });
});
describe('P19/E: a goal that cannot be proved settles with debt', () => {
  const blockedGoal = (overrides: Partial<PlanEntry> = {}) => plan({ kind: 'goal', status: 'blocked', title: 'Reach the never-modeled read',
    criteria: ['A confirmed and tested claim gains the never-modeled read'], exclusions: ['No actor in this run holds the read'],
    proof: { kind: 'capability', capability: READ }, reason: 'The executed branch cannot gain the read; no actor provides it', ...overrides } as Partial<PlanEntry>);

  it('counts a blocked goal as settled with debt instead of open work, and keeps the debt visible', () => {
    const settled = deriveCompletion({ plans: [blockedGoal()], claims: [], tasks: [] });
    // The goal is no longer owed work: completion moves on, and the run still prints what it settled without proving.
    expect(settled).toMatchObject({ state: 'complete', remaining: 0 });
    expect(settled.items.map(item => item.code)).not.toContain('GOAL_UNSETTLED');
    expect(settled.settledBlocked).toEqual([{ id: 'plan-x', reason: 'The executed branch cannot gain the read; no actor provides it' }]);
    expect(completionLine(settled)).toContain('settled with debt: plan-x blocked');
    expect(completionLine(settled)).toContain('no actor provides it');
    // A blocked settle is not a demonstration: the proof is still what reviewed/closed must show.
    const reviewed = deriveCompletion({ plans: [blockedGoal({ status: 'reviewed', exclusions: ['none'] })], claims: [], tasks: [] });
    expect(reviewed.items.map(item => item.code)).toEqual(['GOAL_UNPROVEN']);
    // An active goal with the same unprovable proof stays open work.
    expect(deriveCompletion({ plans: [blockedGoal({ status: 'active' })], claims: [], tasks: [] }).items.map(item => item.code)).toEqual(['GOAL_UNSETTLED']);
  });

  it('refuses an empty coverage denominator as a measurable proof (P19/E)', () => {
    const empty: ProofData = { claims: [], cases: [], coverage: [{ planId: 'cov-empty', cells: [] }] };
    expect(goalProofRefusal({ kind: 'coverage', ref: 'cov-empty' }, empty)).toContain('an empty denominator cannot settle a goal');
    expect(goalProofRefusal({ kind: 'coverage', ref: 'cov-empty' }, { ...empty, coverage: [{ planId: 'cov-empty', cells: [{ id: 'c-1', execution: 'blocked' }] }] })).toBeUndefined();
  });

  it('settles an unreachable goal blocked with its reason, and a partial finish records it as settled with debt', async () => fixture(async h => {
    await populate(h);
    const proof = { kind: 'capability' as const, capability: { kind: 'data.read' as const, subject: 'never-modeled' } };
    const goal = (await h.call('p2o_goal_author', { entry: { kind: 'goal', title: 'Read a principal the fixture never modeled', status: 'active',
      criteria: ['A confirmed and tested claim gains the never-modeled read'], proof,
      reason: 'P19/E fixture: a goal whose proof this run cannot reach' } })).details;
    // A blocked settle must state what made the proof unreachable; the reason names the observation, the exclusions the condition.
    await expect(h.call('p2o_goal_author', { id: goal.id, revision: goal.revision, entry: { kind: 'goal', title: goal.title, status: 'blocked',
      criteria: goal.criteria, proof, reason: 'The executed fixture branch cannot gain the never-modeled read' } }))
      .rejects.toThrow(/GOAL_UNREACHABLE/);
    const blocked = (await h.call('p2o_goal_author', { id: goal.id, revision: goal.revision, entry: { kind: 'goal', title: goal.title, status: 'blocked',
      criteria: goal.criteria, exclusions: ['No fixture actor holds the never-modeled read'], proof,
      reason: 'The executed fixture branch cannot gain the never-modeled read; no fixture actor provides it' } })).details;
    expect(blocked.status).toBe('blocked');
    const finished = await h.call('p2o_finish', { partial: 'The unreachable goal is settled with debt; the remaining obligation is bounded research work' });
    expect(finished.details.campaignPartial).toContain('unreachable goal');
    expect(finished.details.completion.settledBlocked).toContainEqual({ id: blocked.id, reason: blocked.reason });
    expect(finished.details.completion.items.map((item: { code: string }) => item.code)).not.toContain('GOAL_UNSETTLED');
    expect(text(finished)).toContain('settled with debt');
    expect(text(finished)).toContain('PARTIAL:');
  }));
});
