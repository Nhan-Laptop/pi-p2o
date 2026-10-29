import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNGS, claimRung, deriveLadder, rungRank, stepRung, type LadderCaseInput, type LadderClaimInput } from '../../src/ladder.js';
import { chainImpact, type CaseEffect, type ChainImpactStep, type ChainReach } from '../../src/cvss.js';
import { evidenceFor, fixture, populate, seedClaim } from './helpers/report-fixture.js';

/**
 * A7.6 (planning_update.md P7.2): the access ladder is derived, never stored. One test per rung, the "cannot pass a rung without the evidence"
 * rule, the deterministic headline chain, the recorded walls above it, and the report section it renders — including the Q18 assess-mode line.
 */
const LOCAL: ChainReach = { AV: 'L', AC: 'L', AT: 'N', PR: 'L', UI: 'N' };
const NETWORK: ChainReach = { AV: 'N', AC: 'L', AT: 'N', PR: 'L', UI: 'N' };
const claim = (extra: Record<string, unknown> = {}) => ({ closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', evidenceRefs: ['receipt'], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture boundary', limitations: 'One inert fixture actor only', ...extra });
const OBJECTIVE = 'Reach the fixture service through the recorded primitive and execute code on it';
const step = (order: number, extra: Record<string, unknown> = {}) => ({ order, step: `Recorded fixture step ${order}`, gained: [], needs: [], ...extra });

describe('access ladder derivation (A7.6)', () => {
  it('cannot pass a rung without the evidence that rung names', () => {
    expect(RUNGS).toEqual(['observed', 'executed', 'controlled', 'crossed', 'impact']);
    expect(rungRank('impact')).toBeGreaterThan(rungRank('crossed'));
    // An assertion with nothing behind it is not even observed; a claim citing a receipt is observed but not demonstrated.
    expect(claimRung({ closure: 'open_proof_gap', execution: 'not_tested', evidenceRefs: [] })).toBeUndefined();
    expect(claimRung({ closure: 'open_proof_gap', execution: 'not_tested', evidenceRefs: ['receipt'] })).toBe('observed');
    // Demonstration needs confirmed closure AND tested execution: a source trace is not runtime proof.
    expect(claimRung({ closure: 'confirmed', execution: 'not_tested', evidenceRefs: ['receipt'] })).toBe('observed');
    expect(claimRung({ closure: 'confirmed', execution: 'tested', evidenceRefs: ['receipt'] })).toBe('executed');
    // A negative control is what makes it controlled, and a scoped capability is what makes it crossed (crossed outranks controlled).
    expect(claimRung(claim({ negativeControls: ['control-receipt'] }))).toBe('controlled');
    expect(claimRung(claim({ gained: [{ kind: 'exec.code', scope: 'container' }] }))).toBe('crossed');
    expect(claimRung(claim({ negativeControls: ['control-receipt'], gained: [{ kind: 'exec.code', scope: 'container' }] }))).toBe('crossed');
    // A legacy free-text capability is displayed and never matched, so it cannot raise a rung.
    expect(claimRung(claim({ gained: ['a shell inside the container'] }))).toBe('executed');
    // A claim cannot reach the impact rung on its own: that one belongs to a demonstrated chain step with effect and reach.
    expect(claimRung(claim({ gained: [{ kind: 'host.shell' }] }))).toBe('executed');
  });

  it('raises a step only for the effect and reach the chain actually recorded', () => {
    expect(stepRung(undefined, {})).toBeUndefined();
    expect(stepRung({ closure: 'open_proof_gap', execution: 'not_tested', evidenceRefs: ['receipt'] }, {})).toBe('observed');
    // A step effect needs its own demonstrated claim; an undemonstrated step stays where the claim left it.
    expect(stepRung({ closure: 'open_proof_gap', execution: 'not_tested', evidenceRefs: ['receipt'] }, { effect: 'code-execution', reach: LOCAL })).toBe('observed');
    expect(stepRung(claim(), { effect: 'authentication-bypass' })).toBe('crossed');
    expect(stepRung(claim(), { effect: 'cross-tenant-read' })).toBe('crossed');
    expect(stepRung(claim(), { effect: 'sandbox-escape' })).toBe('crossed');
    // Code execution at local or adjacent access is the impact rung; over the network it is not, and a missing reach cannot claim it.
    expect(stepRung(claim(), { effect: 'code-execution', reach: LOCAL })).toBe('impact');
    expect(stepRung(claim(), { effect: 'code-execution', reach: { ...LOCAL, AV: 'A' } })).toBe('impact');
    expect(stepRung(claim(), { effect: 'code-execution', reach: NETWORK })).toBe('executed');
    expect(stepRung(claim(), { effect: 'code-execution' })).toBe('executed');
    expect(stepRung(claim(), { effect: 'integrity-write', reach: LOCAL })).toBe('impact');
    expect(stepRung(claim(), { effect: 'confidentiality-read', reach: LOCAL })).toBe('executed');
  });

  it('picks the deepest chain deterministically and prints the severity the owner rated and the walls the record shows', () => {
    const claims: LadderClaimInput[] = [
      { id: 'claim-open', data: { closure: 'open_proof_gap', execution: 'blocked', evidenceRefs: [], requirement: 'A service the fixture does not expose', negativeControls: [] } },
      { id: 'claim-run', data: claim() },
    ];
    const shallow: LadderCaseInput = { id: 'case-b', revision: 1, accepted: false, claimRefs: ['claim-run'], chain: { objective: OBJECTIVE, demonstratedThrough: 1, steps: [step(1, { claimRef: 'claim-run', effect: 'confidentiality-read' })] } };
    const deep: LadderCaseInput = { id: 'case-a', revision: 2, accepted: true, severity: 'high', claimRefs: ['claim-run'], chain: { objective: OBJECTIVE, demonstratedThrough: 2, steps: [step(1, { claimRef: 'claim-run' }), step(2, { claimRef: 'claim-run', effect: 'sandbox-escape' })] } };
    const ladder = deriveLadder({ mode: 'exploit', start: './source', claims, cases: [shallow, deep] });
    expect(ladder.chain).toMatchObject({ caseId: 'case-a', revision: 2, accepted: true, demonstratedThrough: 2 });
    expect(ladder.chain!.steps.map(item => item.rung)).toEqual(['executed', 'crossed']);
    expect(ladder.furthest).toBe('crossed');
    expect(ladder).toMatchObject({ severity: 'high', ratedCase: 'case-a' });
    // Above the demonstrated depth the walls quote what the record says, including a blocked prerequisite.
    expect(ladder.walls.map(item => item.rung)).toEqual(['impact']);
    expect(ladder.walls[0].wall).toContain('the deepest demonstrated step (2) shows sandbox-escape with no recorded reach');
    const noDepth = deriveLadder({ mode: 'exploit', start: './source', claims, cases: [] });
    expect(noDepth.chain).toBeUndefined();
    expect(noDepth.furthest).toBe('executed');
    expect(noDepth.walls.map(item => `${item.rung}: ${item.wall}`)).toEqual([
      'controlled: claim claim-run cites no negative control',
      'crossed: claim claim-run gained no capability with no scope, and no demonstrated step effect crosses a principal, tenant or sandbox boundary',
      'impact: no demonstrated chain step shows code execution or an integrity write at local or adjacent access',
    ]);
    // No claim and no chain: no rung, and every rung is listed as not reached rather than silently omitted.
    const empty = deriveLadder({ mode: 'exploit', start: './source', claims: [], cases: [] });
    expect(empty.furthest).toBeUndefined();
    expect(empty.walls.map(item => item.rung)).toEqual([...RUNGS]);
    // Ties are broken by case ID, so two equal states render the same bytes.
    const tie = deriveLadder({ mode: 'exploit', start: './source', claims: [claims[1]], cases: [shallow, { ...shallow, id: 'case-a' }] });
    expect(tie.chain!.caseId).toBe('case-a');
  });
});

describe('access ladder in the report (A7.6/Q18)', () => {
  it('renders the synthetic chain, its severity and no wall it did not record; no rung is stored', async () => fixture(async h => {
    const built = await populate(h);
    const second = await seedClaim(h, { ...claim(), candidate: 'ladder-crossing', surface: '/report-fixture', risk: 'authorization', evidenceRefs: [built.observation.evidenceId], gained: [{ kind: 'exec.code', scope: 'container' }] });
    const third = await seedClaim(h, { ...claim(), candidate: 'ladder-impact', surface: '/report-fixture', risk: 'authorization', evidenceRefs: [built.observation.evidenceId], gained: [{ kind: 'host.shell' }] });
    const steps = [
      step(1, { claimRef: built.claim.id, gained: [{ kind: 'http.request', subject: 'internal-api' }] }),
      step(2, { claimRef: second.id, needs: [{ kind: 'http.request', subject: 'internal-api' }], gained: [{ kind: 'exec.code', scope: 'container' }], effect: 'sandbox-escape', reach: LOCAL }),
      step(3, { claimRef: third.id, needs: [{ kind: 'exec.code', scope: 'container' }], gained: [{ kind: 'host.shell' }], effect: 'code-execution' as CaseEffect, reach: LOCAL }),
    ];
    // The rating may not exceed what the chain demonstrated, so the fixture rates at exactly the demonstrated band.
    const demonstrated = chainImpact(steps as unknown as ChainImpactStep[], 3)!;
    const rated = (await h.call('p2o_case_rate', { id: built.accepted.id, revision: built.accepted.revision,
      entry: { severity: demonstrated.severity, basis: 'Confirmed boundary deviation reproduced on the inert fixture service', chain: { objective: OBJECTIVE, demonstratedThrough: 3, steps } } })).details;
    expect(rated.finding.chain.impact).toMatchObject({ effect: 'code-execution', severity: demonstrated.severity });
    h.ctx.setConfirm(true);
    await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
    const ladder = report.slice(report.indexOf('## Access ladder'), report.indexOf('## Scope and limitations'));
    expect(report.indexOf('## Access ladder')).toBeGreaterThan(report.indexOf('## Provenance'));
    expect(ladder).toContain('Rungs are derived by the host from committed records and are never stored');
    expect(ladder).toContain('- Start surface:');
    expect(ladder).toContain(`- Chain: ${OBJECTIVE} — case ${built.accepted.id} r${built.accepted.revision}, demonstrated through step 3 of 3.`);
    expect(ladder).toContain('| # | Step | Rung | Effect | Capability | Reach |');
    expect(ladder).toMatch(/\| 1 \| Recorded fixture step 1 — claim `[a-f0-9-]+` \| executed \| not recorded \|/);
    expect(ladder).toMatch(/\| 2 \| Recorded fixture step 2 — claim `[a-f0-9-]+` \| crossed \| sandbox-escape \|/);
    expect(ladder).toMatch(/\| 3 \| Recorded fixture step 3 — claim `[a-f0-9-]+` \| impact \| code-execution \|/);
    expect(ladder).toContain('AV:L AC:L AT:N PR:L UI:N');
    expect(ladder).toContain(`- Furthest demonstrated rung: **impact**; owner-attributed severity **${demonstrated.severity.charAt(0).toUpperCase()}${demonstrated.severity.slice(1)}** of case ${built.accepted.id}, bounded by the demonstrated depth as above.`);
    expect(ladder).toContain('- Every rung is backed by the recorded evidence.');
    // The rung is a reading of the record, not a field: no committed record carries one.
    const store = await h.reader();
    try {
      const records = store.records();
      expect(records.length).toBeGreaterThan(0);
      expect(records.some((record: any) => record.data && 'rung' in record.data)).toBe(false);
      expect(JSON.stringify(records)).not.toContain('"rung"');
    } finally { store.close(); }
  }));

  it('prints one line in assess mode instead of a ladder', async () => fixture(async h => {
    await h.command('--target ./source --mode assess');
    await seedClaim(h, { ...claim(), candidate: 'assess-observation', surface: '/source', risk: 'authorization', evidenceRefs: [] });
    h.ctx.setConfirm(true);
    await h.command(`report export ${join(h.root, 'assess-out')}`);
    const report = (await h.read(join(h.root, 'assess-out')))['REPORT.md'];
    const ladder = report.slice(report.indexOf('## Access ladder'), report.indexOf('## Scope and limitations'));
    expect(ladder.trim()).toBe('## Access ladder\n\nNo ladder: assess mode. This run recorded observations and claims without authorizing the exploitation steps a ladder measures. The claims and their evidence are unchanged above.');
    expect(report).not.toContain('| # | Step | Rung |');
  }));

  it('admits a capture artifact as reproduction evidence and prints its ID beside the receipt', async () => fixture(async h => {
    const built = await populate(h);
    const evidence = await evidenceFor(h);
    const artifact = { id: 'artifact-00000000-0000-4000-8000-000000000000', stream: 'stdout' as const, totalBytes: 64000, capturedInputBytes: 16384,
      bytes: 16384, sha256: 'c'.repeat(64), truncated: true, captureOutcome: 'returned' as const };
    const captureReceipt = await evidence.receipt('worker-a', 'capture', 'long-report.txt', { code: 0, stdout: 'RETAINED-PREFIX', stderr: '', truncated: true }, new Date().toISOString(),
      { available: true, maxBytes: 8 * 1024 * 1024, observedBytes: 64000, capturedBytes: 16384, artifacts: [artifact] });
    // The receipt for the retained capture is admissible where the case records its reproduction evidence.
    const rated = (await h.call('p2o_case_rate', { id: built.accepted.id, revision: built.accepted.revision,
      entry: { severity: 'medium', basis: 'Reproduced against the inert fixture with the retained capture as the reproduction record', reproductionEvidenceRefs: [captureReceipt] } })).details;
    expect(rated.finding.reproductionEvidenceRefs).toEqual([captureReceipt]);
    h.ctx.setConfirm(true);
    await h.command(`report export ${join(h.root, 'capture-out')}`);
    const files = await h.read(join(h.root, 'capture-out'));
    const line = files['REPORT.md'].split('\n').find((row: string) => row.includes(captureReceipt));
    expect(line).toContain('retained capture: `artifact-00000000-0000-4000-8000-000000000000` (16384 redacted bytes, sha256 cccccccccccc, partial)');
    const finding = JSON.parse(files['findings.json']).findings.find((item: any) => item.caseId === built.accepted.id);
    expect(finding.reproduction[0].captures).toEqual([{ id: artifact.id, bytes: 16384, sha256: artifact.sha256, partial: true }]);
  }));

  it('keeps the inferred-policy severity refusal for an untested claim, and a rung does not override it', async () => fixture(async h => {
    const built = await populate(h);
    const inferred = await seedClaim(h, { ...claim(), candidate: 'ladder-inferred', surface: '/report-fixture', risk: 'authorization', evidenceRefs: [built.observation.evidenceId], negativeControls: [built.observation.evidenceId],
      closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace', policyBasis: 'inferred', expectedPolicy: 'Policy inferred from route names only' });
    // An observed claim is observed whether or not its policy is established; the ladder never turns proof of depth into permission to rate.
    expect(claimRung(inferred.data)).toBe('observed');
    const draft = { title: 'Inferred policy ladder case', policyKey: 'policy:ladder-inferred', assetRefs: [{ id: built.asset.entityId, revision: 1 }], claimRefs: [inferred.id], independentEvidenceRefs: [], taskRefs: [], reportRefs: [], contradictions: [], affectedVariants: [], relatedCaseIds: [], verdict: 'open', reviewStatus: 'pending', reviewReason: 'Pending: policy is only inferred', limitations: 'Policy was inferred, not declared', remediation: { status: 'unplanned', reason: 'No remediation was reviewed for this fixture', evidenceRefs: [] } };
    const created = (await h.call('p2o_case_author', { entry: draft, requestId: 'ladder-inferred-case' })).details;
    await expect(h.call('p2o_case_rate', { id: created.id, revision: created.revision, entry: { severity: 'high', basis: 'Inferred policy only' } })).rejects.toThrow(/inferred policy basis cannot be rated above medium/);
  }));
});
