import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { completionLine, deriveCompletion } from '../../src/completion.js';
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
    const reviewedGoal = deriveCompletion({ plans: [plan({ kind: 'goal', status: 'reviewed', supportRefs: ['ev-1'] })], claims: [], tasks: [] });
    expect(reviewedGoal.state).toBe('complete');
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
    expect(first.details).toMatchObject({ state: 'incomplete', remaining: 1 });
    expect(first.details.completion.items[0].code).toBe('PRIMITIVE_UNCHAINED');
    expect(text(first)).toContain('STATE: incomplete');
    expect(text(first)).toContain('Nothing was torn down or ended');
    const files = await readdir(first.details.reportPath);
    expect(files).toContain('REPORT.md');
    // The run is still active: a second export is allowed and writes a new directory rather than overwriting.
    const second = await h.call('p2o_finish', { export: true });
    expect(second.details.reportPath).not.toBe(first.details.reportPath);
    expect((await h.call('p2o_task', { action: 'list' })).details.total).toBeGreaterThan(0);
  }));

  it('reaches complete only once the primitive is walled, and says so in the report', async () => fixture(async h => {
    const built = await populate(h);
    const exported = await h.call('p2o_finish', { export: true });
    expect(exported.details).toMatchObject({ state: 'incomplete', remaining: 1 });
    const report = await readFile(join(exported.details.reportPath, 'REPORT.md'), 'utf8');
    expect(report).toContain('## REMAINING WORK');
    expect(report).toContain('PRIMITIVE_UNCHAINED');
    expect(report).toMatch(/- Completion: \*\*incomplete\*\* — 1 obligation\(s\)/);
    // A deferred row naming the claim is the wall M4 asks for; nothing else changed.
    await h.call('p2o_plan', { action: 'create', entry: { kind: 'todo', title: 'Wall for the fixture claim', status: 'deferred',
      reason: 'Ruled-out successor: the next step needs an actor this fixture does not model', claimRefs: [built.claim.id] } });
    const settled = await h.call('p2o_finish', { export: true });
    expect(settled.details).toMatchObject({ state: 'complete', remaining: 0 });
    expect(text(settled)).toContain('STATE: complete');
    const after = await readFile(join(settled.details.reportPath, 'REPORT.md'), 'utf8');
    expect(after).toMatch(/- Completion: \*\*complete\*\* — 0 obligation\(s\)/);
  }));

  it('records the outstanding obligation in the stopped outcome', async () => fixture(async h => {
    await populate(h);
    await h.command('stop');
    const store = await h.reader();
    try {
      const outcome = store.outcome() as { assessmentOutcome: string; remaining?: string };
      expect(outcome.assessmentOutcome).toBe('cancelled');
      expect(outcome.remaining).toContain('incomplete: 1 obligation(s)');
      expect(outcome.remaining).toContain('PRIMITIVE_UNCHAINED');
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
