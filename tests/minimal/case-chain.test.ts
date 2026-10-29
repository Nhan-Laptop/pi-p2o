import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, populate, seedClaim, evidenceFor } from './helpers/report-fixture.js';

/** Chain capability: an owner rating may carry the ordered links actually built, bounded by the last step whose claim ran. Inert sandbox, real store. */
const OBJECTIVE = 'Reach the fixture object of another actor through the recorded selector and the recorded read primitive';
const rate = (h: any, built: any, extra: Record<string, unknown> = {}) => h.call('p2o_case_rate', {id: built.accepted.id, revision: built.accepted.revision,
  finding: { severity: 'medium', basis: 'Confirmed boundary deviation reaching only the tested identity’s own object in the fixture', ...extra },
});
const step = (order: number, text: string, extra: Record<string, unknown> = {}) => ({ order, step: text, ...extra });

describe('case finding chain', () => {
  it('records the ordered links, bounds severity by the executed depth and exports both renderings', async () => fixture(async h => {
    const built = await populate(h);
    const second = await seedClaim(h, { candidate: 'chain-second-link', surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', evidenceRefs: [built.observation.evidenceId], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', gained: [{ kind: 'data.read', subject: 'foreign-object' }], needs: [{ kind: 'data.read', subject: 'selected-object' }] });
    const chain = { objective: OBJECTIVE, demonstratedThrough: 2, steps: [
      step(1, 'Select an object identity the request does not own through the recorded parameter', { claimRef: built.claim.id, gained: [{ kind: 'data.read', subject: 'selected-object' }] }),
      step(2, 'Read the selected object through the recorded endpoint', { claimRef: second.id, needs: [{ kind: 'data.read', subject: 'selected-object' }], gained: [{ kind: 'data.read', subject: 'foreign-field' }], effect: 'confidentiality-read', reach: { AV: 'N', AC: 'L', AT: 'N', PR: 'L', UI: 'N' } }),
      step(3, 'Write to the selected object with the same primitive', { needs: [{ kind: 'file.write', subject: 'selected-object' }] }),
    ] };
    const rated = (await rate(h, built, { chain })).details;
    // The rating may sit below what the chain demonstrated (medium ≤ high); the impact itself is the host's arithmetic.
    expect(rated.finding.chain).toMatchObject({ objective: OBJECTIVE, demonstratedThrough: 2, impact: { score: 7.1, severity: 'high', effect: 'confidentiality-read' } });
    expect(rated.finding.chain.steps[1]).toMatchObject({ order: 2, claimRef: second.id, effect: 'confidentiality-read', reach: { AV: 'N', AC: 'L', AT: 'N', PR: 'L', UI: 'N' } });
    const view = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    expect(view.finding.chain.impact).toMatchObject({ score: 7.1, severity: 'high' });
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const { 'REPORT.md': report, 'findings.json': findings } = await h.read(join(h.root, 'out'));
    const section = report.slice(report.indexOf('- Chain —'), report.indexOf('- Chain —') + 1400);
    expect(section).toContain('executed through step 2 of 3'); expect(section).toContain(`claim \`${second.id}\``); expect(section).toContain('needs: data.read \\(selected-object\\)');
    expect(section).toContain('effect: confidentiality-read'); expect(section).toContain('Demonstrated impact `CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N` = **7.1** (high)');
    const row = JSON.parse(findings).findings.find((item: any) => item.caseId === built.accepted.id);
    expect(row.chain).toMatchObject({ objective: OBJECTIVE, demonstratedThrough: 2, impact: { score: 7.1, severity: 'high', effect: 'confidentiality-read' } });
    expect(row.chain.steps[2]).toMatchObject({ order: 3, claimRef: null, gained: [], needs: ['file.write (selected-object)'], effect: null }); // an unexecuted link carries no claim
  }));

  it('reads a pre-P14 prose chain back as untyped text, and refuses a rating it demonstrated nothing for', async () => fixture(async h => {
    const built = await populate(h);
    const chain = { objective: OBJECTIVE, steps: [step(1, 'Reach the selector that chooses the object identity', { provides: 'a selected foreign object identity' }), step(2, 'Consume the identity through the read endpoint', { requires: 'a selected foreign object identity' })] };
    const reported = (await rate(h, built, { severity: 'informational', chain })).details.finding.chain;
    expect(reported?.impact).toBeUndefined();
    // Old prose is kept, marked, and never joined: nothing about it can score a case.
    expect(reported?.steps[0].gained).toEqual([{ legacy: 'a selected foreign object identity' }]);
    expect(reported?.steps[1].needs).toEqual([{ legacy: 'a selected foreign object identity' }]);
    expect(JSON.stringify(reported)).toBe(JSON.stringify((await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details.finding.chain));
    // The report says the chain is reasoned, and prints old prose as untyped instead of joining it.
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const reasoned = (await h.read(join(h.root, 'out')))['REPORT.md'];
    expect(reasoned).toContain('no step executed — reasoned only');
    expect(reasoned).toContain('untyped text'); expect(reasoned).toContain('a selected foreign object identity');
    // No executed depth means nothing was demonstrated, so a medium rating is refused rather than recorded.
    await expect(rate(h, built, { chain })).rejects.toThrow(/needs a demonstrated effect/);
    // An executed step that names no effect is the same refusal, and says which recording is missing.
    await expect(rate(h, built, { chain: { objective: OBJECTIVE, demonstratedThrough: 1, steps: [step(1, 'Reach the selector that chooses the object identity', { claimRef: built.claim.id })] } })).rejects.toThrow(/names no effect/);
    // A rating above what the chain demonstrated is refused; the same case at the demonstrated band is accepted.
    const demonstrated = { objective: OBJECTIVE, demonstratedThrough: 1, steps: [step(1, 'Reach the selector that chooses the object identity', { claimRef: built.claim.id, effect: 'confidentiality-read' })] };
    await expect(rate(h, built, { severity: 'high', chain: demonstrated })).rejects.toThrow(/exceeds what step 1 demonstrated: confidentiality-read scores medium \(CVSS:4.0\/AV:P\/AC:H\/AT:P\/PR:H\/UI:A\/VC:H\/VI:N\/VA:N\/SC:N\/SI:N\/SA:N = 4.1\)/);
    expect((await rate(h, built, { severity: 'medium', chain: demonstrated })).details.finding.chain).toMatchObject({ impact: { score: 4.1, severity: 'medium' } });
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out-2')}`);
    expect((await h.read(join(h.root, 'out-2')))['REPORT.md']).toContain('Demonstrated impact `CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N` = **4.1** (medium)');
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
    const unproven = await seedClaim(h, { candidate: 'chain-unproven-link', surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', evidenceRefs: [], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', requirement: 'A write-capable selector the fixture does not expose', limitations: 'Never executed in the fixture' });
    await reject({ chain: { objective: OBJECTIVE, demonstratedThrough: 1, steps: [step(1, 'Reach the selector that chooses the object identity', { claimRef: unproven.id })] } }, /not a confirmed tested result/);
    const store = await h.reader(); try { expect(store.records().filter((row: any) => row.data?.caseRating).length).toBe(0); } finally { store.close(); }
  }));

  it('validates the provided capability on a candidate claim so a later step can consume it', async () => fixture(async h => {
    const built = await populate(h);
    // A2: the worker-side claim service (same validator the broker uses) is the only claim-authoring surface left for a fixture.
    const evidence = await evidenceFor(h);
    const claim = (extra: Record<string, unknown> = {}) => evidence.candidate('worker-a', { candidate: 'chain-edge', surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', evidenceRefs: [built.observation.evidenceId], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', ...extra } as never);
    expect((await claim({ gained: [{ kind: 'data.read', subject: 'foreign-object' }], needs: [{ kind: 'auth.bypass' }] })).id).toBeTruthy();
    expect((await claim({ candidate: 'chain-edge-open', gained: undefined })).id).toBeTruthy(); // the edge is optional
    // P14.1: the pair is typed and closed, so a kind outside the vocabulary or an over-long subject is refused rather than stored
    // as text nothing can ever join to.
    await expect(claim({ candidate: 'chain-edge-unknown-kind', gained: [{ kind: 'made-up-kind' }] })).rejects.toThrow(/kind|made-up-kind/);
    await expect(claim({ candidate: 'chain-edge-long-subject', needs: [{ kind: 'host.shell', subject: 'x'.repeat(81) }] })).rejects.toThrow(/subject|length/);
  }));
});

// P13(a): the chain view prints a candidate's slug and its ledger record id; a rating must accept either one, or the two halves of the
// feature cannot speak to each other. The round trip below is the gate: read what the frontier printed, then cite it verbatim.
describe('chain identities agree (P13a)', () => {
  it('accepts the record id the frontier prints and the slug the join keys on', async () => fixture(async h => {
    const built = await populate(h);
    const primitive = await seedClaim(h, { candidate: 'identity-primitive', surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', evidenceRefs: [built.observation.evidenceId], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only', gained: [{ kind: 'cred.session', subject: 'fixture-actor' }] });
    await seedClaim(h, { candidate: 'identity-consumer', surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', evidenceRefs: [built.observation.evidenceId], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'Nothing executed yet', needs: [{ kind: 'cred.session', subject: 'fixture-actor' }], requirement: 'Reach the consumer with an authenticated fixture session' });
    const join = (await h.call('p2o_graph_plan', { action: 'chain' })).details;
    const consumer = join.frontier.find((entry: any) => entry.claimId === 'identity-consumer');
    expect(consumer).toMatchObject({ claimId: 'identity-consumer', depth: 1, path: ['identity-primitive', 'identity-consumer'] });
    expect(typeof consumer.recordId, 'the frontier states the record id a rating cites').toBe('string');
    expect(join.primitives).toContain('identity-primitive');
    // Cite exactly what the frontier printed (record id) and then the slug the join keys on: both are the same primitive.
    const withRecordId = (await rate(h, built, { severity: 'informational', chain: { objective: OBJECTIVE, steps: [step(1, 'Open the consumer with the recorded session', { claimRef: consumer.recordId, needs: [{ kind: 'cred.session', subject: 'fixture-actor' }] })] } })).details;
    expect(withRecordId.finding.chain.steps[0].claimRef).toBe(consumer.recordId);
    const withSlug = (await rate(h, built, { severity: 'informational', chain: { objective: OBJECTIVE, steps: [step(1, 'Open the consumer with the recorded session', { claimRef: 'identity-consumer', needs: [{ kind: 'cred.session', subject: 'fixture-actor' }] })] } })).details;
    expect(withSlug.finding.chain.steps[0].claimRef).toBe('identity-consumer');
    // A demonstrated step still needs a confirmed tested claim, whichever identity names it.
    await expect(rate(h, built, { chain: { objective: OBJECTIVE, demonstratedThrough: 1, steps: [step(1, 'Claim the open consumer ran', { claimRef: 'identity-consumer' })] } })).rejects.toThrow(/not a confirmed tested result/);
    const proven = (await rate(h, built, { chain: { objective: OBJECTIVE, demonstratedThrough: 1, steps: [step(1, 'Read the fixture object with the recorded session', { claimRef: primitive.id, effect: 'authentication-bypass', reach: { AV: 'N', AC: 'L', AT: 'N', PR: 'N', UI: 'N' } })] } })).details;
    expect(proven.finding.chain.demonstratedThrough).toBe(1);
    expect(proven.finding.chain.impact).toMatchObject({ score: 9.3, severity: 'critical' });
  }));
});
