import { describe, expect, it } from 'vitest';
import { chainBoard, chainLines } from '../../src/chain-board.js';
import { situationLine, summarizeSituation } from '../../src/situation.js';
import type { ChainClaim } from '../../src/chain-view.js';
import type { PlanEntry } from '../../src/planning.js';
import { fixture } from './helpers/report-fixture.js';

/**
 * M1: the chain lives on the plan board and its edges are derived. Two links make that checkable — a plan row that names the claims it
 * stands on and the capabilities it consumes, and a pure reader that calls a step ready only when an earlier step's *demonstrated* claim
 * gains every need it declares. The acceptance the plan asks for is the third test: closing step 1 moves only step 2.
 */
const plan = (step: number, overrides: Partial<PlanEntry> = {}): PlanEntry => ({
  id: `todo-step-${step}`, runId: 'run-chain', revision: 1, recordId: `rec-plan-${step}`, kind: 'todo',
  title: `Chain step ${step}`, status: 'open', reason: 'Fixture chain step with an explicit lineage', chainOf: 'chain-x', step,
  claimRefs: [`rec-claim-${step}`], ...overrides,
});
const claim = (recordId: string, overrides: Partial<ChainClaim> = {}): ChainClaim => ({
  candidate: recordId, recordId, closure: 'open_proof_gap', execution: 'not_tested', ...overrides,
} as ChainClaim);
const demonstrated = (recordId: string, gained: ChainClaim['gained']): ChainClaim =>
  claim(recordId, { closure: 'confirmed', execution: 'tested', gained } as Partial<ChainClaim>);

const READ = { kind: 'http.request', subject: 'internal-api' } as const;
const ADMIN = { kind: 'cred.session', subject: 'internal-api' } as const;

describe('chain board: readiness is derived from earlier steps (M1)', () => {
  it('calls a step with no needs ready, and a step whose needs nothing gains yet waiting', () => {
    const board = chainBoard([plan(1), plan(2, { needs: [READ] })], [claim('rec-claim-1'), claim('rec-claim-2')]);
    expect(board).toHaveLength(1);
    expect(board[0]!.steps.map(step => step.state)).toEqual(['ready', 'waiting']);
    expect(board[0]!.waiting[0]!.waitingOn).toEqual([READ]);
    expect(board[0]!.line).toBe('chain chain-x 0/2 · next: step 1 (ready) · waiting on: http.request (internal-api)');
  });

  it('moves readiness to step 2 only when step 1 cites a demonstrated claim that gains the need', () => {
    const waiting = chainBoard([plan(1), plan(2, { needs: [READ] })], [claim('rec-claim-1')]);
    expect(waiting[0]!.ready.map(step => step.step)).toEqual([1]);
    // A cited but untested claim is not a provider: `isDemonstrated` is the one rule, so the step stays waiting.
    const cited = chainBoard([plan(1), plan(2, { needs: [READ] })], [claim('rec-claim-1', { gained: [READ] } as Partial<ChainClaim>)]);
    expect(cited[0]!.waiting.map(step => step.step)).toEqual([2]);
    const ready = chainBoard([plan(1), plan(2, { needs: [READ] })], [demonstrated('rec-claim-1', [READ])]);
    expect(ready[0]!.ready.map(step => step.step)).toEqual([1, 2]);
    expect(ready[0]!.next!.step).toBe(1);
    // Provenance travels with the state: a reader can name which earlier record made the step ready.
    expect(ready[0]!.steps[1]!.satisfiedBy).toEqual({ 'http.request\u0000internal-api\u0000': 'rec-claim-1' });
  });

  it('takes a need from any earlier step, not only the one immediately before it', () => {
    const board = chainBoard([plan(1), plan(2, { needs: [ADMIN] }), plan(3, { needs: [READ] })], [demonstrated('rec-claim-1', [READ])]);
    expect(board[0]!.steps.map(step => step.state)).toEqual(['ready', 'waiting', 'ready']);
    expect(board[0]!.next!.step).toBe(1);
    expect(board[0]!.line).toBe('chain chain-x 0/3 · next: step 1 (ready) · waiting on: cred.session (internal-api)');
  });

  it('keeps a settled row settled: readiness cannot reopen a done, blocked, deferred or cancelled step', () => {
    const board = chainBoard([plan(1, { status: 'done' }), plan(2, { status: 'blocked', needs: [READ] }), plan(3, { status: 'deferred' }), plan(4, { status: 'cancelled' })], [demonstrated('rec-claim-1', [READ])]);
    expect(board[0]!.steps.map(step => step.state)).toEqual(['done', 'blocked', 'deferred', 'cancelled']);
    expect(board[0]!.ready).toEqual([]);
    expect(board[0]!.done).toBe(1);
    expect(board[0]!.line).toBe('chain chain-x 1/4 · blocked: step 2');
  });

  it('renders one sentence per chain for the plan view, capped and ordered', () => {
    const board = chainBoard([plan(1, { chainOf: 'chain-b' }), plan(1, { chainOf: 'chain-a', status: 'done' })], []);
    expect(chainLines(board)).toEqual(['chain chain-a 1/1 · settled', 'chain chain-b 0/1 · next: step 1 (ready)']);
  });

  it('feeds the situation line from the board instead of a second counting rule', () => {
    const plans = [plan(1), plan(2, { needs: [READ] }), plan(3, { needs: [ADMIN] })];
    const snapshot = summarizeSituation({ tasks: [], cases: [], coverage: [], claims: [], plans });
    expect(snapshot).toMatchObject({ chainSteps: 3, chainReadySteps: 1, chainWaitingSteps: 2 });
    expect(situationLine(snapshot)).toContain('chain: 1 step ready, 2 waiting');
    // With no planned chain the candidate-level join still answers, so the segment never goes silent about a real frontier.
    const joinOnly = summarizeSituation({ tasks: [], cases: [], coverage: [], claims: [{ ...demonstrated('rec-primitive', [READ]), closure: 'confirmed' }] });
    expect(joinOnly.chainSteps).toBe(0);
  });
});

describe('chain plan rows: one lineage, one position (M1)', () => {
  it('refuses a chain row with no lineage and a half-declared position', async () => fixture(async h => {
    await h.command('--target ./source');
    const base = { kind: 'todo', title: 'Chain step without lineage', status: 'open', reason: 'Owner wrote the step before the claim it stands on' };
    await expect(h.call('p2o_plan_create', {entry: { ...base, chainOf: 'chain-x', step: 1 } }))
      .rejects.toThrow(/CHAIN_LINEAGE: a chain step must cite the claim it consumes \(claimRefs\); a plan row with no lineage cannot hold a link/);
    await expect(h.call('p2o_plan_create', {entry: { ...base, chainOf: 'chain-x' } })).rejects.toThrow(/needs both chainOf and step/);
    await expect(h.call('p2o_plan_create', {entry: { ...base, step: 2 } })).rejects.toThrow(/needs both chainOf and step/);
    // A goal may not carry a link at all: the fields belong to the todo that the work hangs from.
    await expect(h.call('p2o_plan_create', {entry: { kind: 'goal', title: 'A goal with a chain link', status: 'active', reason: 'Owner put a link on the wrong kind', criteria: ['bounded'], chainOf: 'chain-x', step: 1 } }))
      .rejects.toThrow(/Only a todo holds a chain link/);
    // A claim reference must resolve to a same-run candidate record, so the board can read what it gains.
    await expect(h.call('p2o_plan_create', {entry: { ...base, chainOf: 'chain-x', step: 1, claimRefs: ['rec-missing'] } }))
      .rejects.toThrow(/Unknown plan claim rec-missing/);
  }));

  it('closing step 1 with a demonstrated claim makes step 2 ready and leaves step 3 waiting', async () => fixture(async h => {
    await h.command('--target ./source');
    const observation = (await h.call('p2o_shell', { command: 'printf chain-board-observation' })).details;
    const record = (candidate: string, extra: Record<string, unknown> = {}) => h.call('p2o_candidate', {
      candidate, surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
      negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Nothing executed in this step yet',
      evidenceRefs: [observation.evidenceId], ...extra,
    });
    const first = (await record('chain-a')).details;
    const second = (await record('chain-b', { needs: [READ], gained: [ADMIN] })).details;
    const third = (await record('chain-c', { needs: [ADMIN] })).details;
    const create = (step: number, claimRef: string, extra: Record<string, unknown> = {}) => h.call('p2o_plan_create', {entry: {
      kind: 'todo', title: `Chain step ${step}`, status: 'open', reason: `Chain step ${step} of 3, written for the M1 acceptance fixture`,
      chainOf: 'chain-m1', step, claimRefs: [claimRef], ...extra } });
    const steps = [await create(1, first.id), await create(2, second.id, { needs: [READ] }), await create(3, third.id, { needs: [ADMIN] })].map(result => result.details);

    const before = (await h.call('p2o_board', { board: 'plans', kind: 'todo', limit: 20 })).details;
    expect(before.chains).toEqual(['chain chain-m1 0/3 · next: step 1 (ready) · waiting on: http.request (internal-api), cred.session (internal-api)']);

    // Step 1 now stands on a claim that actually ran and gains the capability step 2 consumes.
    const demonstratedFirst = (await record('chain-a', { supersedes: first.id, closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', policyBasis: 'boundary_invariant', gained: [READ] })).details;
    await h.call('p2o_plan_revise', {id: steps[0]!.id, revision: steps[0]!.revision, entry: {
      kind: 'todo', title: 'Chain step 1', status: 'done', reason: 'Step 1 ran against the recorded surface and now hands out the request capability',
      chainOf: 'chain-m1', step: 1, claimRefs: [demonstratedFirst.id] } });

    const after = (await h.call('p2o_board', { board: 'plans', kind: 'todo', limit: 20 })).details;
    // Only step 2 moved: step 3 still waits on a capability nothing demonstrated gains yet.
    expect(after.chains).toEqual(['chain chain-m1 1/3 · next: step 2 (ready) · waiting on: cred.session (internal-api)']);
    const stepRows = after.entries.filter((entry: any) => entry.chainOf === 'chain-m1').sort((left: any, right: any) => left.step - right.step);
    expect(stepRows.map((entry: any) => [entry.step, entry.status, entry.claimRefs])).toEqual([[1, 'done', [demonstratedFirst.id]], [2, 'open', [second.id]], [3, 'open', [third.id]]]);
  }));

  it('refuses a second row for the same chain position', async () => fixture(async h => {
    await h.command('--target ./source');
    const observation = (await h.call('p2o_shell', { command: 'printf chain-duplicate-observation' })).details;
    const record = (candidate: string) => h.call('p2o_candidate', { candidate, surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested',
      proof: 'static_trace', negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Nothing executed in this step yet', evidenceRefs: [observation.evidenceId] });
    const first = (await record('chain-a')).details, second = (await record('chain-b')).details;
    await h.call('p2o_plan_create', {entry: { kind: 'todo', title: 'Chain step one', status: 'open', reason: 'First row at this position in the fixture chain', chainOf: 'chain-dup', step: 1, claimRefs: [first.id] } });
    await expect(h.call('p2o_plan_create', {entry: { kind: 'todo', title: 'Chain step one again', status: 'open', reason: 'Second row at the same position in the fixture chain', chainOf: 'chain-dup', step: 1, claimRefs: [second.id] } }))
      .rejects.toThrow(/Duplicate chain step 1 in chain-dup/);
  }));
});
