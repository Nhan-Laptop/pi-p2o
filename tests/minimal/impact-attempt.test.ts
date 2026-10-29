import { describe, expect, it } from 'vitest';
import { fixture, seedClaim, seedImpactGoal } from './helpers/report-fixture.js';

/**
 * A17.2/D32 (owner decision 2026-10-27): an exploit run records an impact goal before its first target-executing intent. The
 * advisory here is the honest other half of that rule — the goal is a promise about the target, and a run that never admitted a
 * step toward it attempted nothing. Advisory only, like every other preflight item: it never refuses a finish and never turns
 * into a safety claim.
 */
const codes = (exported: any, level: 'advisory' | 'obligations'): string[] => exported.details.preflight[level].map((item: { code: string }) => item.code);

describe('A17.2/D32 impact goal versus attempt', () => {
  it('names an exploit run whose capability-proof goal was never attempted, as an advisory', async () => fixture(async h => {
    await h.command('--target ./source');
    await seedImpactGoal(h);
    const exported = await h.call('p2o_finish', { export: true });
    expect(codes(exported, 'advisory')).toContain('IMPACT_UNATTEMPTED');
    // It names unfinished work; it is never an obligation and never a refusal.
    expect(codes(exported, 'obligations')).not.toContain('IMPACT_UNATTEMPTED');
  }));

  it('stays silent in assess mode, where an effect was never wanted', async () => fixture(async h => {
    await h.command('--target ./source --mode assess');
    await seedImpactGoal(h);
    const exported = await h.call('p2o_finish', { export: true });
    expect(codes(exported, 'advisory')).not.toContain('IMPACT_UNATTEMPTED');
  }));

  it('stays silent once an exploitation intent was admitted, even before it runs', async () => fixture(async h => {
    await h.command('--target ./source');
    await seedImpactGoal(h);
    // The exploitation anchor rule (P7.1) needs a recon intent before the run can cite a primitive.
    await h.call('p2o_task_author', { draft: { question: 'Which surfaces does the fixture expose?', surface: '/fixture', risk: 'mapping', role: 'recon', evidenceIds: [], prerequisites: [] } });
    const claim = await seedClaim(h, { candidate: 'impact-attempt-primitive', surface: '/fixture', risk: 'authorization',
      closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
      evidenceRefs: [(await h.call('p2o_shell', { command: 'printf impact-attempt' })).details.evidenceId],
      negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture boundary', limitations: 'Nothing executed yet' });
    const asset = (await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /impact-attempt' } }] } })).details.acks[0];
    await h.call('p2o_task_author', { draft: {
      question: 'Does the recorded primitive reach the effect the goal names?', surface: '/impact-fixture', risk: 'authorization', role: 'exploit',
      roleReason: 'A17.2 fixture takes the recorded primitive one rung further', expectedTrue: 'The bounded effect is demonstrated',
      expectedFalse: 'The effect is not demonstrated and the wall is recorded', stopCondition: 'Stop after one bounded attempt',
      evidenceIds: [], prerequisites: [], methodReason: 'One bounded effect against the recorded fixture',
      work: { assetRefs: [{ id: asset.entityId, revision: 1 }], questionKey: 'impact:fixture', policyKey: 'policy:fixture',
        actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'chain-step', purpose: 'exploitation', claimRefs: [claim.id] },
      decision: { disposition: 'new', reason: 'First task that executes this bounded step' } } });
    const exported = await h.call('p2o_finish', { export: true });
    expect(codes(exported, 'advisory')).not.toContain('IMPACT_UNATTEMPTED');
  }));
});
