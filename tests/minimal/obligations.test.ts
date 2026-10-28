import { describe, expect, it } from 'vitest';
import { chainObligations, dispatchRefusal } from '../../src/obligations.js';
import type { ChainClaim } from '../../src/chain-view.js';
import type { PlanEntry } from '../../src/planning.js';
import type { AssessmentTask, TaskDraft } from '../../src/tasks.js';
import { fixture, seedClaim, seedImpactGoal } from './helpers/report-fixture.js';

/**
 * Phase D acceptance (M2 + M4). M2: a ready chain step on a surface refuses a new task there unless the draft cites the provider or a
 * plan row records why the link is not taken. M4: a demonstrated primitive nothing consumes is listed as remaining work and refuses
 * breadth on its surface until a successor consumes it, a task stands on it, or a wall names it. Both rules are per surface, never
 * global, and neither refuses a finish — p2o has no finish gate.
 */
const READ = { kind: 'http.request', subject: 'internal-api' } as const;
const claim = (recordId: string, overrides: Partial<ChainClaim> = {}): ChainClaim => ({
  candidate: recordId, recordId, closure: 'open_proof_gap', execution: 'not_tested', surface: '/x', ...overrides,
} as ChainClaim);
const demonstrated = (recordId: string, overrides: Partial<ChainClaim> = {}): ChainClaim =>
  claim(recordId, { closure: 'confirmed', execution: 'tested', gained: [READ], ...overrides } as Partial<ChainClaim>);
const todo = (overrides: Partial<PlanEntry>): PlanEntry => ({
  id: 'todo-x', runId: 'run', revision: 1, recordId: 'rec-plan-x', kind: 'todo', title: 'Fixture row', status: 'open',
  reason: 'Fixture chain row written for the obligation test', ...overrides,
} as PlanEntry);
const draft = (surface: string, claimRefs?: string[], assetId = 'asset-000000000000000000000000'): Record<string, unknown> => ({
  question: `Does the ${surface} surface respond to the bounded fixture?`, surface, risk: 'authorization', role: 'general',
  roleReason: 'Obligation fixture task', expectedTrue: 'The bounded observation is recorded', expectedFalse: 'The bounded control is recorded',
  stopCondition: 'Stop after one inert observation', evidenceIds: [], prerequisites: [], skills: [], methodReason: 'One inert observation with no external target',
  ...(claimRefs ? { work: { assetRefs: [{ id: assetId, revision: 1 }], questionKey: 'q:obligation', methodFamily: 'fixture',
    purpose: 'exploitation' as const, claimRefs }, decision: { disposition: 'new' as const, reason: 'Obligation fixture takes the ready step' },
    outputContract: { kind: 'validation' as const, required: ['evidence', 'candidates'] as const, partialAllowed: false, artifactPolicy: 'ids-only' as const } } : {}),
});

describe('dispatch obligations are derived, per surface (M2 + M4)', () => {
  it('refuses a breadth draft on a surface with a ready step, and accepts it once the provider is cited', () => {
    const plans = [todo({ id: 'todo-1', step: 1, chainOf: 'chain-m2', claimRefs: ['rec-primitive'] }), todo({ id: 'todo-2', step: 2, chainOf: 'chain-m2', claimRefs: ['rec-ready'], needs: [READ] })];
    const claims = [demonstrated('rec-primitive'), claim('rec-ready')];
    const obligations = chainObligations({ plans, claims, tasks: [] });
    expect(obligations.ready).toEqual([expect.objectContaining({ chainOf: 'chain-m2', step: 2, provider: 'rec-primitive', need: READ, surface: '/x' })]);
    expect(dispatchRefusal({ draft: draft('/x') as unknown as TaskDraft, obligations, plans }))
      .toBe('CHAIN_READY_UNDISPATCHED: step 2 of chain chain-m2 consumes http.request (internal-api) that claim rec-primitive already gains; dispatch it, cite it as a parent, or defer it with a reason');
    // Citing the provider is taking the step: the refusal names exactly the record to cite.
    expect(dispatchRefusal({ draft: draft('/x', ['rec-primitive']) as unknown as TaskDraft, obligations, plans })).toBeUndefined();
    // Another surface is untouched: breadth elsewhere stays allowed, so the rule cannot freeze the run.
    expect(dispatchRefusal({ draft: draft('/y') as unknown as TaskDraft, obligations, plans })).toBeUndefined();
  });

  it('accepts the breadth draft when a deferred row records why the link is not taken', () => {
    const plans = [todo({ id: 'todo-1', step: 1, chainOf: 'chain-m2', claimRefs: ['rec-primitive'] }), todo({ id: 'todo-2', step: 2, chainOf: 'chain-m2', claimRefs: ['rec-ready'], needs: [READ] })];
    const claims = [demonstrated('rec-primitive'), claim('rec-ready')];
    const withWall = [...plans, todo({ id: 'todo-wall', status: 'deferred', claimRefs: ['rec-primitive'], reason: 'The successor needs an actor the fixture does not model' })];
    expect(dispatchRefusal({ draft: draft('/x') as unknown as TaskDraft, obligations: chainObligations({ plans: withWall, claims, tasks: [] }), plans: withWall })).toBeUndefined();
  });

  it('lists an unconsumed primitive and refuses breadth on its surface until it is taken further or walled', () => {
    const claims = [demonstrated('rec-primitive')];
    const bare = chainObligations({ plans: [], claims, tasks: [] });
    expect(bare.unchained).toEqual([{ claimId: 'rec-primitive', recordId: 'rec-primitive', surface: '/x', capability: 'http.request (internal-api)' }]);
    expect(dispatchRefusal({ draft: draft('/x') as unknown as TaskDraft, obligations: bare, plans: [] }))
      .toBe('PRIMITIVE_UNCHAINED: claim rec-primitive (http.request (internal-api)) is confirmed and tested on /x and nothing consumes it; take the next step or record which successors were ruled out and why');
    // A successor row that consumes the capability clears it, even before anything runs.
    const consumed = chainObligations({ plans: [todo({ id: 'todo-3', step: 3, chainOf: 'chain-m4', claimRefs: ['rec-next'], needs: [READ] })], claims, tasks: [] });
    expect(consumed.unchained).toEqual([]);
    // A wall naming the primitive clears it too, and a live task that stands on it is the dispatch case.
    expect(chainObligations({ plans: [todo({ id: 'todo-wall', status: 'blocked', claimRefs: ['rec-primitive'] })], claims, tasks: [] }).unchained).toEqual([]);
    const standing: AssessmentTask[] = [{ id: 'task-1', status: 'running', work: { claimRefs: ['rec-primitive'] } } as unknown as AssessmentTask];
    expect(chainObligations({ plans: [], claims, tasks: standing }).unchained).toEqual([]);
    // A cancelled task stands on nothing: the obligation must come back rather than be cleared by a dead attempt.
    const dead: AssessmentTask[] = [{ id: 'task-1', status: 'cancelled', work: { claimRefs: ['rec-primitive'] } } as unknown as AssessmentTask];
    expect(chainObligations({ plans: [], claims, tasks: dead }).unchained).toHaveLength(1);
  });
});

describe('the frontier obligation refuses at create, not at finish (M2 + M4)', () => {
  // A2: claims are worker-authored; the fixture seeds the record the broker would commit.
  const record = (h: any, observation: any) => async (candidate: string, extra: Record<string, unknown> = {}) => seedClaim(h, {
    candidate, surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
    negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Nothing executed in this step yet',
    evidenceRefs: [observation.evidenceId], ...extra });

  it('refuses a mapping task on a surface with a ready step and accepts it once the provider is cited or the link is deferred', async () => fixture(async h => {
    await h.command('--target ./source');
    const asset = (await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /report-fixture' } }] } })).details.acks[0];
    const observation = (await h.call('p2o_shell', { command: 'printf obligation-observation' })).details;
    const put = record(h, observation);
    const primitive = await put('obligation-primitive', { closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', policyBasis: 'boundary_invariant', gained: [READ] });
    const ready = await put('obligation-ready', { needs: [READ] });
    await h.call('p2o_plan_author', {entry: { kind: 'todo', title: 'Chain step 1 demonstrated', status: 'done', reason: 'First step of the fixture chain, demonstrated by the recorded primitive', chainOf: 'chain-obligation', step: 1, claimRefs: [primitive.id] } });
    await h.call('p2o_plan_author', {entry: { kind: 'todo', title: 'Chain step 2 ready', status: 'open', reason: 'Second step of the fixture chain, ready on the demonstrated capability', chainOf: 'chain-obligation', step: 2, claimRefs: [ready.id], needs: [READ] } });

    // P7.1: exploit mode (the default) admits the exploitation-purpose drafts below only under a capability-proof goal.
    await h.call('p2o_plan_author', {entry: {kind: 'goal', title: 'Reach the fixture effect under an impact goal', status: 'active',
      proof: {kind: 'capability', capability: {kind: 'file.read'}}, criteria: ['The cited ready step runs'],
      reason: 'P7.1 exploit-mode admission fixture: the goal these chain-step drafts are settled against'}});
    const breadth = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ ...draft('/report-fixture'), ...overrides });
    await expect(h.call('p2o_task_author', {draft: breadth() }))
      .rejects.toThrow(/CHAIN_READY_UNDISPATCHED: step 2 of chain chain-obligation consumes http\.request \(internal-api\) that claim .* already gains; dispatch it, cite it as a parent, or defer it with a reason/);
    // Breadth elsewhere is still admitted.
    expect((await h.call('p2o_task_author', {draft: breadth({ surface: '/elsewhere' }) as unknown as TaskDraft })).details.status).toBe('proposed');
    // Citing the provider is taking the step.
    const cited = await h.call('p2o_task_author', {draft: draft('/report-fixture', [primitive.id], asset.entityId) as unknown as TaskDraft });
    expect(cited.details.work.claimRefs).toEqual([primitive.id]);
    // And the refusal is a create-time obligation, not a finish gate: the run can still finish with the step open.
    expect(JSON.stringify(await h.call('p2o_finish', {}))).not.toMatch(/CHAIN_READY_UNDISPATCHED/);
  }));

  it('lists an unconsumed primitive and clears it when a wall names it', async () => fixture(async h => {
    await h.command('--target ./source');
    // A3/D32: the frontier refusal is now reached only once the impact goal admits the intent at all.
    await seedImpactGoal(h);
    const observation = (await h.call('p2o_shell', { command: 'printf primitive-observation' })).details;
    const put = record(h, observation);
    const primitive = await put('walled-primitive', { closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', policyBasis: 'boundary_invariant', gained: [READ] });
    const breadth: Record<string, unknown> = draft('/report-fixture');
    await expect(h.call('p2o_task_author', {draft: breadth as unknown as TaskDraft }))
      .rejects.toThrow(new RegExp(`PRIMITIVE_UNCHAINED: claim ${primitive.id} \\(http\\.request \\(internal-api\\)\\) is confirmed and tested on /report-fixture and nothing consumes it`));
    // The same obligation is what the finish preflight lists and what Phase E keeps `complete` false (covered in finish-preflight.test.ts).
    // A deferred row naming the primitive and its ruled-out successor is the wall M4 asks for.
    await h.call('p2o_plan_author', {entry: { kind: 'todo', title: 'Wall for the fixture primitive', status: 'deferred',
      reason: 'Recorded ruled-out successor: the next step needs a second actor the fixture does not model', claimRefs: [primitive.id] } });
    expect((await h.call('p2o_task_author', {draft: breadth as unknown as TaskDraft })).details.status).toBe('proposed');
  }));
});
