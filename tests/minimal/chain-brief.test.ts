import { describe, expect, it } from 'vitest';
import { chainBriefFor } from '../../src/chain-brief.js';
import type { ChainClaim } from '../../src/chain-view.js';
import type { PlanEntry } from '../../src/planning.js';

/**
 * P22/A2: the chain link a successor's exploit brief names. The derivation is a read over the plan board and the claim heads,
 * so these fixtures are the same two inputs `chainBoard` takes; the tests pin the three identities a task can be matched by,
 * the ambiguity rule, and the bound the brief block relies on.
 */
const READ = { kind: 'http.request', subject: 'internal-api' } as const;
const ADMIN = { kind: 'cred.session', subject: 'internal-api' } as const;
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
const task = (overrides: { id?: string; claimRefs?: string[] } = {}) => ({
  ...(overrides.id ? { id: overrides.id } : {}),
  work: { claimRefs: overrides.claimRefs ?? [], questionKey: 'chain:fixture', methodFamily: 'chain-step', purpose: 'exploitation' as const, assetRefs: [] },
});

describe('chain brief: which link this attempt is (P22/A2)', () => {
  it('matches a ready step through the providers the task cites, and names the next link it feeds', () => {
    const plans = [plan(1, { status: 'done' }), plan(2, { needs: [READ] }), plan(3, { needs: [ADMIN] })];
    const claims = [demonstrated('rec-claim-1', [READ])];
    const facts = chainBriefFor({ plans, claims, task: task({ claimRefs: ['rec-claim-1'] }) });
    expect(facts).toMatchObject({ chainOf: 'chain-x', step: 2, total: 3, state: 'ready' });
    // The path is a window, not the whole chain: the attempt is marked and its neighbours are named.
    expect(facts!.path).toBe('1. Chain step 1 (done) | 2. Chain step 2 (this attempt) | 3. Chain step 3 (waiting)');
    // P14.1 typed capabilities, described the way every other prompt line describes them.
    expect(facts!.nextLink).toBe('3. Chain step 3 consumes cred.session (internal-api)');
  });

  it('prefers the plan row that lists the task over any claim overlap', () => {
    const plans = [plan(1), plan(2, { needs: [READ], taskIds: ['task-1'] }), plan(3, { needs: [ADMIN] })];
    const claims = [demonstrated('rec-claim-1', [READ])];
    // The task cites step 1's claim only; the explicit taskIds link still identifies step 2.
    const facts = chainBriefFor({ plans, claims, task: task({ id: 'task-1', claimRefs: ['rec-claim-1'] }) });
    expect(facts).toMatchObject({ step: 2, state: 'ready', nextLink: '3. Chain step 3 consumes cred.session (internal-api)' });
  });

  it('falls back to the step whose claim the task stands on, so a continuation still knows what it feeds', () => {
    const plans = [plan(1, { status: 'done' }), plan(2), plan(3, { needs: [READ] })];
    const claims = [demonstrated('rec-claim-1', [READ]), claim('rec-claim-2')];
    const facts = chainBriefFor({ plans, claims, task: task({ claimRefs: ['rec-claim-2'] }) });
    expect(facts).toMatchObject({ step: 2 });
    expect(facts!.nextLink).toBe('3. Chain step 3 consumes http.request (internal-api)');
  });

  it('names a branch chain whose provider the task cites, so a branched link is briefed like any other (P22/A1)', () => {
    const plans = [plan(1, { chainOf: 'chain-branch', claimRefs: ['rec-primitive', 'rec-claim-1'], needs: [READ] })];
    const claims = [demonstrated('rec-primitive', [READ])];
    const facts = chainBriefFor({ plans, claims, task: task({ claimRefs: ['rec-primitive'] }) });
    expect(facts).toMatchObject({ chainOf: 'chain-branch', step: 1, total: 1, state: 'ready' });
    expect(facts!.path).toBe('1. Chain step 1 (this attempt)');
    expect(facts!.nextLink).toBeUndefined();
  });

  it('takes the lowest ready link when the task cites the provider for two of them', () => {
    const plans = [plan(1), plan(2, { needs: [READ] }), plan(3, { needs: [ADMIN] })];
    // One demonstrated primitive hands out both capabilities, so steps 2 and 3 are both ready off the same provider.
    const claims = [demonstrated('rec-claim-1', [READ, ADMIN])];
    expect(chainBriefFor({ plans, claims, task: task({ claimRefs: ['rec-claim-1'] }) })).toMatchObject({ step: 2, state: 'ready' });
  });

  it('returns nothing when the cited claims span two chains: a brief never names the wrong path', () => {
    const plans = [plan(1, { chainOf: 'chain-a' }), plan(1, { chainOf: 'chain-b', id: 'todo-b-1', claimRefs: ['rec-claim-b1'] })];
    const claims = [demonstrated('rec-claim-1', [READ]), demonstrated('rec-claim-b1', [ADMIN])];
    expect(chainBriefFor({ plans, claims, task: task({ claimRefs: ['rec-claim-1', 'rec-claim-b1'] }) })).toBeUndefined();
  });

  it('returns nothing when no chain row exists, instead of falling back to the claim join', () => {
    expect(chainBriefFor({ plans: [], claims: [demonstrated('rec-claim-1', [READ])], task: task({ claimRefs: ['rec-claim-1'] }) })).toBeUndefined();
    expect(chainBriefFor({ plans: [plan(1)], claims: [], task: task({ claimRefs: ['rec-claim-9'] }) })).toBeUndefined();
  });

  it('bounds a long chain to one link either side and marks the clipped ends', () => {
    const plans = [1, 2, 3, 4, 5, 6].map(step => plan(step, { status: step < 4 ? 'done' : 'open', ...(step === 4 ? { needs: [READ] } : {}) }));
    const claims = [demonstrated('rec-claim-3', [READ])];
    const facts = chainBriefFor({ plans, claims, task: task({ claimRefs: ['rec-claim-3'] }) });
    expect(facts).toMatchObject({ step: 4, total: 6 });
    expect(facts!.path.startsWith('… | 3. ')).toBe(true);
    expect(facts!.path.endsWith(' | …')).toBe(true);
    expect(facts!.path).toContain('4. Chain step 4 (this attempt)');
    expect(facts!.path.length).toBeLessThanOrEqual(180);
    expect(facts!.nextLink).toBe('5. Chain step 5 consumes no declared need');
  });

  it('collapses whitespace in a recorded title so the appendix cannot grow its own lines', () => {
    const plans = [plan(1, { title: 'Chain\nstep\tone' }), plan(2)];
    const facts = chainBriefFor({ plans, claims: [demonstrated('rec-claim-1', [READ])], task: task({ claimRefs: ['rec-claim-1'] }) });
    expect(facts!.path).toContain('1. Chain step one (this attempt)');
  });
});
