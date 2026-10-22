import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, populate } from './helpers/report-fixture.js';

/** Chain capability: an owner rating may carry the ordered links actually built, bounded by the last step whose claim ran. Inert sandbox, real store. */
const OBJECTIVE = 'Reach the fixture object of another actor through the recorded selector and the recorded read primitive';
const rate = (h: any, built: any, extra: Record<string, unknown> = {}) => h.call('p2o_case', {
  action: 'rate', id: built.accepted.id, revision: built.accepted.revision,
  finding: { severity: 'medium', basis: 'Confirmed boundary deviation reaching only the tested identity’s own object in the fixture', ...extra },
});
const step = (order: number, text: string, extra: Record<string, unknown> = {}) => ({ order, step: text, ...extra });

describe('case finding chain', () => {
  it('records the ordered links, bounds severity by the executed depth and exports both renderings', async () => fixture(async h => {
    const built = await populate(h);
    const second = (await h.call('p2o_candidate', { candidate: 'chain-second-link', surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', evidenceRefs: [built.observation.evidenceId], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', provides: 'a resolved object reference owned by another fixture actor', requires: 'a selected object identity from the first link' })).details;
    const chain = { objective: OBJECTIVE, demonstratedThrough: 2, steps: [
      step(1, 'Select an object identity the request does not own through the recorded parameter', { claimRef: built.claim.id, provides: 'a selected object identity the caller does not own' }),
      step(2, 'Read the selected object through the recorded endpoint', { claimRef: second.id, requires: 'a selected object identity the caller does not own', provides: 'the other actor’s fixture field value' }),
      step(3, 'Write to the selected object with the same primitive', { requires: 'a write-capable selector the fixture does not expose' }),
    ] };
    const rated = (await rate(h, built, { chain })).details;
    expect(rated.finding.chain).toEqual(chain);
    const view = (await h.call('p2o_case', { action: 'view', id: built.accepted.id })).details;
    expect(view.finding.chain).toEqual(chain);
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const { 'REPORT.md': report, 'findings.json': findings } = await h.read(join(h.root, 'out'));
    const section = report.slice(report.indexOf('- Chain —'), report.indexOf('- Chain —') + 700);
    expect(section).toContain('executed through step 2 of 3'); expect(section).toContain(`claim \`${second.id}\``); expect(section).toContain('requires: a selected object identity');
    const row = JSON.parse(findings).findings.find((item: any) => item.caseId === built.accepted.id);
    expect(row.chain).toMatchObject({ objective: OBJECTIVE, demonstratedThrough: 2 });
    expect(row.chain.steps[2]).toMatchObject({ order: 3, claimRef: null, provides: null }); // an unexecuted link carries no claim
  }));

  it('accepts a reasoned chain with nothing executed and says so instead of implying depth', async () => fixture(async h => {
    const built = await populate(h);
    const chain = { objective: OBJECTIVE, steps: [step(1, 'Reach the selector that chooses the object identity', { provides: 'a selected foreign object identity' }), step(2, 'Consume the identity through the read endpoint', { requires: 'a selected foreign object identity' })] };
    expect((await rate(h, built, { chain })).details.finding.chain).toEqual(chain);
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    expect((await h.read(join(h.root, 'out')))['REPORT.md']).toContain('no step executed — reasoned only');
  }));

  it('refuses a chain whose numbering, size, depth or claim references do not hold, writing nothing', async () => fixture(async h => {
    const built = await populate(h), reject = (extra: Record<string, unknown>, pattern: RegExp) => expect(rate(h, built, extra)).rejects.toThrow(pattern);
    const one = (extra: Record<string, unknown> = {}) => ({ chain: { objective: OBJECTIVE, steps: [step(1, 'Reach the selector that chooses the object identity', extra)] } });
    await reject({ chain: { objective: OBJECTIVE, steps: [step(2, 'Reach the selector that chooses the object identity')] } }, /numbered 1..n/);
    await reject({ chain: { objective: OBJECTIVE, steps: Array.from({ length: 9 }, (_, index) => step(index + 1, 'Reach the selector that chooses the object identity')) } }, /1\.\.8/);
    await reject({ chain: { objective: OBJECTIVE, steps: [] } }, /1\.\.8/);
    await reject({ chain: { objective: 'short', steps: [step(1, 'Reach the selector that chooses the object identity')] } }, /objective/);
    await reject({ chain: { objective: OBJECTIVE, demonstratedThrough: 3, steps: [step(1, 'Reach the selector that chooses the object identity', { claimRef: built.claim.id })] } }, /must name one of its steps/);
    await reject({ chain: { objective: OBJECTIVE, demonstratedThrough: 1, steps: [step(1, 'Reach the selector that chooses the object identity')] } }, /needs the claim that ran it/);
    await reject({ ...one({ claimRef: 'claim-that-does-not-exist' }), chain: { objective: OBJECTIVE, demonstratedThrough: 1, steps: [step(1, 'Reach the selector that chooses the object identity', { claimRef: 'claim-that-does-not-exist' })] } }, /Unknown same-run chain claim/);
    await reject(one({ extra: 1 }), /Finding chain step|exact|unknown/i);
    await reject({ chain: { objective: OBJECTIVE, steps: [step(1, 'Reach the selector that chooses the object identity')], plan: 'x' } }, /Finding chain|exact|unknown/i);
    const unproven = (await h.call('p2o_candidate', { candidate: 'chain-unproven-link', surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', evidenceRefs: [], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', requirement: 'A write-capable selector the fixture does not expose', limitations: 'Never executed in the fixture' })).details;
    await reject({ chain: { objective: OBJECTIVE, demonstratedThrough: 1, steps: [step(1, 'Reach the selector that chooses the object identity', { claimRef: unproven.id })] } }, /not a confirmed tested result/);
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRating).length).toBe(0); } finally { store.close(); }
  }));

  it('validates the provided capability on a candidate claim so a later step can consume it', async () => fixture(async h => {
    const built = await populate(h);
    const claim = (extra: Record<string, unknown> = {}) => h.call('p2o_candidate', { candidate: 'chain-edge', surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', evidenceRefs: [built.observation.evidenceId], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', ...extra });
    expect((await claim({ provides: 'a selected foreign object identity', requires: 'a selector the request controls' })).details.id).toBeTruthy();
    expect((await claim({ candidate: 'chain-edge-open', provides: undefined })).details.id).toBeTruthy(); // the edge is optional
    await expect(claim({ candidate: 'chain-edge-short', provides: 'a' })).rejects.toThrow(/provides/);
    await expect(claim({ candidate: 'chain-edge-long', requires: 'x'.repeat(301) })).rejects.toThrow(/requires/);
  }));
});

// P13(a): the chain view prints a candidate's slug and its ledger record id; a rating must accept either one, or the two halves of the
// feature cannot speak to each other. The round trip below is the gate: read what the frontier printed, then cite it verbatim.
describe('chain identities agree (P13a)', () => {
  it('accepts the record id the frontier prints and the slug the join keys on', async () => fixture(async h => {
    const built = await populate(h);
    const primitive = (await h.call('p2o_candidate', { candidate: 'identity-primitive', surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', evidenceRefs: [built.observation.evidenceId], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', provides: 'an authenticated fixture session as the tested actor' })).details;
    await h.call('p2o_candidate', { candidate: 'identity-consumer', surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', evidenceRefs: [built.observation.evidenceId], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Nothing executed yet', requires: 'an authenticated fixture session as the tested actor', requirement: 'Reach the consumer with an authenticated fixture session' });
    const join = (await h.call('p2o_graph', { action: 'chain' })).details;
    const consumer = join.frontier.find((entry: any) => entry.claimId === 'identity-consumer');
    expect(consumer).toMatchObject({ claimId: 'identity-consumer', depth: 1, path: ['identity-primitive', 'identity-consumer'] });
    expect(typeof consumer.recordId, 'the frontier states the record id a rating cites').toBe('string');
    expect(join.primitives).toContain('identity-primitive');
    // Cite exactly what the frontier printed (record id) and then the slug the join keys on: both are the same primitive.
    const withRecordId = (await rate(h, built, { chain: { objective: OBJECTIVE, steps: [step(1, 'Open the consumer with the recorded session', { claimRef: consumer.recordId, requires: 'an authenticated fixture session as the tested actor' })] } })).details;
    expect(withRecordId.finding.chain.steps[0].claimRef).toBe(consumer.recordId);
    const withSlug = (await rate(h, built, { chain: { objective: OBJECTIVE, steps: [step(1, 'Open the consumer with the recorded session', { claimRef: 'identity-consumer', requires: 'an authenticated fixture session as the tested actor' })] } })).details;
    expect(withSlug.finding.chain.steps[0].claimRef).toBe('identity-consumer');
    // A demonstrated step still needs a confirmed tested claim, whichever identity names it.
    await expect(rate(h, built, { chain: { objective: OBJECTIVE, demonstratedThrough: 1, steps: [step(1, 'Claim the open consumer ran', { claimRef: 'identity-consumer' })] } })).rejects.toThrow(/not a confirmed tested result/);
    const proven = (await rate(h, built, { chain: { objective: OBJECTIVE, demonstratedThrough: 1, steps: [step(1, 'Read the fixture object with the recorded session', { claimRef: primitive.id })] } })).details;
    expect(proven.finding.chain.demonstratedThrough).toBe(1);
  }));
});
