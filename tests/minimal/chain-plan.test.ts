import { describe, expect, it } from 'vitest';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * P14.10: the chain frontier is turned into the next owner decision, never into a dispatch. The draft must be exactly the argument
 * `p2o_task create` takes, the chain must land as one plan todo per step, and neither of those may start work.
 */
const OBJECTIVE = 'Take the demonstrated request capability to code execution through the recorded chain' as const;

async function chainFixture(h: any) {
  const built = await populate(h);
  const environment = (await h.call('p2o_lab', { action: 'env', name: 'chain-app', services: [{ name: 'web', command: 'python3 app.py', port: 8080 }], seed: ['curl -sf http://127.0.0.1:8080/'] })).details;
  const claim = (extra: Record<string, unknown>) => h.call('p2o_candidate', {
    surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
    negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Nothing executed in this step yet',
    evidenceRefs: [built.observation.evidenceId], ...extra,
  });
  // The primitive that hands out the capability, recorded against the environment it was demonstrated in.
  const primitive = (await claim({ candidate: 'chain-primitive', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction',
    policyBasis: 'boundary_invariant', gained: [{ kind: 'http.request', subject: 'internal-api' }], environmentRef: environment.id })).details;
  const consumer = (await claim({ candidate: 'chain-consumer', needs: [{ kind: 'http.request', subject: 'internal-api' }], gained: [{ kind: 'exec.code', subject: 'app-host' }] })).details;
  return { built, environment, primitive, consumer };
}

describe('chain frontier to task draft (P14.10)', () => {
  it('drafts the exact p2o_task create argument for the deepest ready step and records one todo per step', async () => fixture(async h => {
    const { built, environment, primitive, consumer } = await chainFixture(h);
    const join = (await h.call('p2o_graph', { action: 'chain' })).details;
    const next = join.frontier.find((entry: any) => entry.claimId === 'chain-consumer');
    // The frontier states what the step consumes, which recorded claims provide it, and where it was demonstrated.
    expect(next).toMatchObject({ claimId: 'chain-consumer', depth: 1, path: ['chain-primitive', 'chain-consumer'], providers: [primitive.id], needs: [{ kind: 'http.request', subject: 'internal-api' }], environmentRef: environment.id });

    const planned = (await h.call('p2o_graph', { action: 'chain', plan: true, assetRefs: [{ id: built.asset.entityId, revision: 1 }], requestId: 'chain-plan-1' })).details;
    expect(planned.draft).toMatchObject({
      role: 'exploit', surface: '/report-fixture', risk: 'authorization',
      work: { purpose: 'exploitation', methodFamily: 'chain-step', questionKey: 'chain:chain-consumer', needs: [{ kind: 'http.request', subject: 'internal-api' }],
        environmentRef: environment.id, claimRefs: [next.providers[0], consumer.id].sort(), assetRefs: [{ id: built.asset.entityId, revision: 1 }] },
    });
    expect(planned.todos.map((todo: any) => todo.title)).toEqual(['1/2 chain-primitive', '2/2 chain-consumer']);

    // Nothing was dispatched: the run still has exactly the fixture's task, and the plan exists as navigation only.
    expect((await h.call('p2o_task', { action: 'list' })).details.total).toBe(1);
    const todos = (await h.call('p2o_plan', { action: 'list', kind: 'todo', limit: 20 })).details;
    expect(todos.total).toBe(2);
    expect(todos.entries.map((entry: any) => entry.status)).toEqual(['open', 'open']);

    // The draft is accepted unchanged, and the work identity it carries names what the step stands on and where it runs.
    const created = (await h.call('p2o_task', { action: 'create', draft: planned.draft })).details;
    expect(created).toMatchObject({ status: 'proposed', role: 'exploit' });
    expect(created.work).toMatchObject({ purpose: 'exploitation', needs: [{ kind: 'http.request', subject: 'internal-api' }], environmentRef: environment.id });
    expect(created.work.claimRefs).toEqual([next.providers[0], consumer.id].sort());
  }));

  it('replays a plan request into the same todos instead of duplicating them', async () => fixture(async h => {
    const { built } = await chainFixture(h);
    const call = () => h.call('p2o_graph', { action: 'chain', plan: true, assetRefs: [{ id: built.asset.entityId, revision: 1 }], requestId: 'chain-plan-replay' });
    const first = (await call()).details, again = (await call()).details;
    expect(again.todos.map((todo: any) => todo.id)).toEqual(first.todos.map((todo: any) => todo.id));
    expect((await h.call('p2o_plan', { action: 'list', kind: 'todo', limit: 20 })).details.total).toBe(2);
  }));

  it('refuses to plan when nothing is ready, instead of drafting a step with no demonstrated support', async () => fixture(async h => {
    const built = await populate(h);
    const blocked = (await h.call('p2o_candidate', { candidate: 'chain-blocked', surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
      negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Nothing executed yet',
      evidenceRefs: [built.observation.evidenceId], needs: [{ kind: 'host.shell' }] })).details;
    const join = (await h.call('p2o_graph', { action: 'chain' })).details;
    expect(join.frontier).toEqual([]); expect(join.unmet).toContain('chain-blocked');
    expect(join.uncovered['chain-blocked']).toEqual([{ kind: 'host.shell' }]);
    await expect(h.call('p2o_graph', { action: 'chain', plan: true, requestId: 'chain-plan-none' })).rejects.toThrow(/Nothing ready to plan/);
    expect((await h.call('p2o_plan', { action: 'list', kind: 'todo', limit: 20 })).details.total).toBe(0);
    expect(blocked.id).toBeDefined();
  }));

  it('says why a draft has no work identity instead of inventing an asset', async () => fixture(async h => {
    await chainFixture(h);
    const planned = (await h.call('p2o_graph', { action: 'chain', plan: true, requestId: 'chain-plan-bare' })).details;
    expect(planned.draft.work).toBeUndefined();
    expect(planned.planNote).toMatch(/no asset refs were supplied/);
    // The draft still passes create unchanged: a task without a work identity is a legacy task, not a broken one.
    expect((await h.call('p2o_task', { action: 'create', draft: planned.draft })).details.status).toBe('proposed');
  }));
});
