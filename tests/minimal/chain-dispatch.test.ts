import { describe, expect, it } from 'vitest';
import { chainLinkGap, type ChainClaim, type ChainLinkTask } from '../../src/chain-view.js';
import { fixture, seedClaim, seedImpactGoal } from './helpers/report-fixture.js';

/**
 * P24/A (C2-fix-3): run-11badbea dispatched its chain successor at 12:19:08Z while its link was authored at 12:30:04Z, so the
 * successor brief had no chain to carry and the step was walled 16 s after it was finally written. The order is a host refusal
 * now: in exploit mode a discovery/exploit intent that stands on a demonstrated claim waits for the open plan row that names
 * the chain step. The rule is pure over plans and claims so it cannot drift from the board the brief reads.
 */
const claim = (candidate: string, recordId: string, patch: Partial<ChainClaim> & Record<string, unknown> = {}): ChainClaim => ({
  candidate, closure: 'confirmed', execution: 'tested', recordId, recordIds: [recordId], ...patch } as unknown as ChainClaim);
const openClaim = (candidate: string, recordId: string): ChainClaim => ({
  candidate, closure: 'open_proof_gap', execution: 'not_tested', recordId, recordIds: [recordId] } as unknown as ChainClaim);
const task = (patch: Partial<ChainLinkTask> = {}): ChainLinkTask => ({ role: 'discovery', work: { claimRefs: ['rec-head'] }, ...patch });
const link = (status: string, claimRefs: string[] = ['rec-head'], patch: Record<string, unknown> = {}) => ({ kind: 'todo', status, chainOf: 'chain-a', step: 2, claimRefs, ...patch });

describe('chain dispatch order rule (P24/A)', () => {
  // The claim was recorded twice (C2-fix-1): a plan row may cite the earlier row, the task the head. One claim, two ids.
  const primitive = claim('login-bypass', 'rec-head', { recordIds: ['rec-old', 'rec-head'] });

  it('refuses a discovery dispatch that stands on a demonstrated claim with no open link', () => {
    expect(chainLinkGap({ mode: 'exploit', task: task(), plans: [], claims: [primitive] }))
      .toEqual({ claim: 'login-bypass', cited: ['rec-head'] });
  });

  it('admits the dispatch once an open link names the claim, through any record id of the same slug', () => {
    expect(chainLinkGap({ mode: 'exploit', task: task(), plans: [link('open', ['rec-old'])], claims: [primitive] })).toBeUndefined();
    expect(chainLinkGap({ mode: 'exploit', task: task({ work: { claimRefs: ['rec-old'] } }), plans: [link('open', ['rec-head'])], claims: [primitive] })).toBeUndefined();
  });

  it('does not read a settled, cancelled or walled row as the link that admits a dispatch', () => {
    for (const status of ['done', 'cancelled', 'blocked', 'deferred']) {
      expect(chainLinkGap({ mode: 'exploit', task: task(), plans: [link(status)], claims: [primitive] }), status).toBeDefined();
    }
    expect(chainLinkGap({ mode: 'exploit', task: task(), plans: [link('open', ['rec-head'], { chainOf: undefined })], claims: [primitive] })).toBeDefined();
    expect(chainLinkGap({ mode: 'exploit', task: task(), plans: [link('open', ['rec-other'])], claims: [primitive] })).toBeDefined();
  });

  it('exempts validation, retest, non-chain roles and a task with nothing demonstrated to stand on', () => {
    for (const patch of [{ role: 'validation' }, { role: 'general' }, { role: 'discovery', retestOf: 'task-1' }, { role: 'discovery', work: { claimRefs: [] } }]) {
      expect(chainLinkGap({ mode: 'exploit', task: task(patch as Partial<ChainLinkTask>), plans: [], claims: [primitive] })).toBeUndefined();
    }
    // A lone open claim is not a chain step: nothing demonstrated is being stood on, so breadth stays dispatchable.
    expect(chainLinkGap({ mode: 'exploit', task: task({ work: { claimRefs: ['rec-open'] } }), plans: [], claims: [primitive, openClaim('next-step', 'rec-open')] })).toBeUndefined();
  });

  it('is inert in assess mode, which produces exposure proof and takes no chain step', () => {
    expect(chainLinkGap({ mode: 'assess', task: task(), plans: [], claims: [primitive] })).toBeUndefined();
  });
});

/**
 * The same rule at the dispatch boundary: `p2o_task_dispatch` is where run-11badbea got the order wrong, so the refusal has to
 * be observed through the tool, not only through the pure function. A settled row for the provider is not the successor's link.
 */
async function dispatchFixture(h: any) {
  await h.command('--target ./source --max-depth 1');
  await seedImpactGoal(h);
  const asset = (await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /dispatch-rule' } }] } })).details.acks[0];
  // A2: the first intent of a run is recon/mapping, so the fixture records that anchor before any claim exists on the surface.
  await h.call('p2o_task_author', { entry: { question: 'Which bounded surface does the dispatch fixture observe?', surface: '/dispatch-rule', risk: 'mapping',
    role: 'recon', roleReason: 'First intent of the fixture: name the bounded surface the chain step runs against', expectedTrue: 'The bounded surface is named',
    expectedFalse: 'No bounded surface is named', stopCondition: 'Stop after naming the surface the chain step runs against', evidenceIds: [], prerequisites: [] } });
  const receipt = (await h.call('p2o_shell', { command: 'printf dispatch-rule-receipt' })).details.evidenceId;
  const primitive = await seedClaim(h, { candidate: 'dispatch-primitive', surface: '/dispatch-rule', risk: 'authorization', closure: 'confirmed', execution: 'tested',
    proof: 'offline_reproduction', evidenceRefs: [receipt], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture boundary',
    limitations: 'One inert fixture primitive', gained: [{ kind: 'data.read', subject: 'dispatch-fixture' }] });
  const step = await seedClaim(h, { candidate: 'dispatch-step', surface: '/dispatch-rule', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested',
    proof: 'static_trace', evidenceRefs: [receipt], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture boundary',
    limitations: 'Nothing executed yet', needs: [{ kind: 'data.read', subject: 'dispatch-fixture' }], gained: [{ kind: 'exec.code', subject: 'dispatch-host' }] });
  // The shape `p2o_graph_plan plan:true` drafts for a ready step: role exploit, purpose exploitation, the primitive and the claim
  // the step is extending both cited. A discovery draft would need a recon/mapping anchor this fixture does not hold.
  const draft = {
    question: 'Does the recorded primitive carry the chain one step further?', surface: '/dispatch-rule', risk: 'authorization', role: 'exploit' as const,
    roleReason: 'Bounded chain successor that stands on the recorded primitive', expectedTrue: 'The step acts through the recorded primitive', expectedFalse: 'The step records the mismatch',
    stopCondition: 'Stop after one bounded step', evidenceIds: [], prerequisites: [], skills: [], methodReason: 'One inert step that consumes the recorded primitive',
    work: { assetRefs: [{ id: asset.entityId, revision: 1 }], questionKey: 'chain:dispatch-step', methodFamily: 'chain-step', purpose: 'exploitation' as const,
      claimRefs: [primitive.id, step.id], needs: [{ kind: 'data.read', subject: 'dispatch-fixture' }] },
    decision: { disposition: 'new' as const, reason: 'Chain successor step for the recorded primitive' },
    outputContract: { kind: 'validation' as const, required: ['evidence', 'candidates'] as const, partialAllowed: false, artifactPolicy: 'ids-only' as const },
  };
  return { primitive, step, draft };
}

describe('chain dispatch boundary (P24/A)', () => {
  it('refuses the dispatch until the successor link is open, and admits it once the link exists', async () => fixture(async h => {
    const { primitive, step, draft } = await dispatchFixture(h);
    const successor = (await h.call('p2o_task_author', { entry: draft })).details;
    // Refusal: the message names the demonstrated claim, the remedy and the wall alternative.
    await expect(h.call('p2o_task_dispatch', { ids: [successor.id] })).rejects.toThrow(/CHAIN_LINK_REQUIRED/);
    await expect(h.call('p2o_task_dispatch', { ids: [successor.id] })).rejects.toThrow(/open plan row names the chain step/);
    // A settled row for the primitive this step stands on is a predecessor link, not the successor's link.
    await h.call('p2o_goal_author', { entry: { kind: 'todo', title: '1/2 dispatch-primitive', status: 'done', reason: 'The demonstrated primitive this step stands on',
      chainOf: 'chain-dispatch', step: 1, claimRefs: [primitive.id] } });
    await expect(h.call('p2o_task_dispatch', { ids: [successor.id] })).rejects.toThrow(/CHAIN_LINK_REQUIRED/);
    // The open link that names the step is what admits it.
    await h.call('p2o_goal_author', { entry: { kind: 'todo', title: '2/2 dispatch-step', status: 'open', reason: 'Recorded successor step that consumes the demonstrated primitive',
      chainOf: 'chain-dispatch', step: 2, claimRefs: [step.id], needs: [{ kind: 'data.read', subject: 'dispatch-fixture' }] } });
    await expect(h.call('p2o_task_dispatch', { ids: [successor.id] })).resolves.toBeDefined();
  }), 20000);
});
