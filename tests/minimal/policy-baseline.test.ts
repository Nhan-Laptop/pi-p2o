import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/target.js';
import { campaignFrom, campaignPromptBlock, campaignStartLine, parseCampaign } from '../../src/campaign.js';
import { loadPolicyArtifact } from '../../src/policy-artifact.js';
import { isDemonstrated } from '../../src/claims.js';
import { evidenceFor, fixture, seedClaim } from './helpers/report-fixture.js';

/**
 * P21/B — the operator policy baseline (planning_update.md §6, D-P21-4/D-P21-9): a run records one policy artifact at start,
 * a claim cites it under `operator_contract`, and a case can then land on recorded policy instead of an inference. Hermetic:
 * pure parsers, a real SQLite store and the in-process extension on a fake Pi; no model, no target traffic.
 */
const PROMPT_SECTION = 'p2o_assessment';
const plannerPrompt = async (h: any): Promise<string> => {
  const event = { systemPromptOptions: { sections: {} as Record<string, string> }, prompt: '' };
  for (const handler of h.pi.events.get('before_agent_start') ?? []) await handler(event);
  return event.systemPromptOptions.sections[PROMPT_SECTION];
};
const reportDirectory = async (h: any) => join(h.root, '.p2o-reports', `report-${await h.runId()}-final`);
const CLI = (extra = '') => `--target ./source${extra}`;
/** The exact case draft the fixture uses; the only varying part is which claim it cites. */
const caseDraft = (assetId: string, claimId: string, extra: Record<string, unknown> = {}) => ({
  title: 'Policy fixture object boundary case', policyKey: 'policy:fixture-gate', rootCauseKey: 'root:policy-fixture',
  assetRefs: [{ id: assetId, revision: 1 }], claimRefs: [claimId], independentEvidenceRefs: [], taskRefs: [], reportRefs: [], contradictions: [], affectedVariants: [], relatedCaseIds: [],
  verdict: 'confirmed', reviewStatus: 'pending', reviewReason: 'Owner review of the recorded policy and the bounded inert receipt', limitations: 'Only the retained inert fixture receipt and the recorded policy are covered',
  remediation: { status: 'unplanned', reason: 'No remediation was reviewed in this fixture', evidenceRefs: [] }, ...extra,
});
const boundedClaim = (overrides: Record<string, unknown>) => ({
  candidate: 'policy-claim', surface: '/policy-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction',
  negativeControls: [], expectedPolicy: 'The recorded operator policy forbids an unauthenticated read across this boundary', limitations: 'One bounded inert fixture observation only', ...overrides,
});

describe('P21/B operator policy baseline', () => {
  it('parses one --policy source and refuses a duplicate, a relative path and an unknown standard', () => {
    expect(parseCommand(CLI(' --policy /tmp/policy.json'))).toMatchObject({ action: 'start', options: { policy: '/tmp/policy.json' } });
    expect(parseCommand(CLI(' --policy standard:OWASP-WSTG'))).toMatchObject({ action: 'start', options: { policy: 'standard:OWASP-WSTG' } });
    expect(() => parseCommand(CLI(' --policy relative/policy.json'))).toThrow(/absolute path/);
    expect(() => parseCommand(CLI(' --policy standard:PCI-DSS'))).toThrow(/standard must be one of/);
    expect(() => parseCommand(CLI(' --policy standard:OWASP-WSTG --policy standard:OWASP-Top10'))).toThrow(/only once/);
    // A missing value is refused at the parser, not read as "no policy".
    expect(() => parseCommand(CLI(' --policy'))).toThrow(/--policy needs/);
  });

  it('loads a bounded file artifact with its exact digest and gives a standard one stable identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-policy-'));
    try {
      const path = join(root, 'policy.json');
      const body = '{"policy":"operator baseline fixture"}\n';
      await writeFile(path, body);
      const file = await loadPolicyArtifact(path);
      expect(file).toMatchObject({ kind: 'file', id: path, bytes: Buffer.byteLength(body) });
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await loadPolicyArtifact(path)).toEqual(file);
      // A standard has no file body: its digest is derived from the standard name and is stable across runs.
      const standard = await loadPolicyArtifact('standard:OWASP-WSTG'), again = await loadPolicyArtifact('standard:OWASP-WSTG');
      expect(standard).toEqual(again);
      expect(standard).toMatchObject({ kind: 'standard', id: 'OWASP-WSTG', standard: 'OWASP-WSTG', bytes: 0 });
      // The bound is checked before the bytes are read, and a relative source never reaches the loader.
      const oversized = join(root, 'oversized.txt');
      await writeFile(oversized, 'x'.repeat(256 * 1024 + 1));
      await expect(loadPolicyArtifact(oversized)).rejects.toThrow(/at most 262144 bytes/);
      await expect(loadPolicyArtifact('relative/policy.json')).rejects.toThrow(/absolute path/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('records the policy source in the campaign frame and prints the source, never the body, in the confirmation and the prompt', async () => fixture(async h => {
    const path = join(h.root, 'policy.txt'), marker = 'POLICY-BODY-MARKER-9f2c';
    await writeFile(path, `# operator baseline\n${marker}: a body sentence no model may read\n`);
    await h.command(CLI(` --policy ${path}`));
    const confirmation = h.ctx.confirmBodies.at(-1) as string;
    expect(confirmation).toContain('policy: file');
    expect(confirmation).toContain(path);
    expect(confirmation).not.toContain(marker);
    const store = await h.reader();
    try {
      const campaign = store.campaign()!;
      expect(campaign.policy).toMatchObject({ kind: 'file', id: path, bytes: Buffer.byteLength(await readFile(path, 'utf8')) });
      expect(campaign.policy!.sha256).toMatch(/^[a-f0-9]{64}$/);
      // The role of the frame is data: it round-trips through the same parser every reader uses.
      expect(parseCampaign(campaign)).toEqual(campaign);
    } finally { store.close(); }
    const prompt = await plannerPrompt(h);
    expect(prompt).toContain('operator_contract');
    expect(prompt).toContain(`policyRef=${path}`);
    expect(prompt).not.toContain(marker);
    // The goal economy's proof rule rides the campaign frame; the block stays one bounded paragraph.
    expect(prompt).toContain('GOAL PROOF:');
    expect(prompt).toContain('without one the measurable proof is mapping');
    const block = campaignPromptBlock(campaignFrom({ target: '/fixture', at: '2026-10-29T00:00:00.000Z', policy: (await loadPolicyArtifact(path)) }));
    expect(block.length).toBeLessThan(1000);
  }));

  it('keeps a run without --policy unchanged: no policy wording in the confirmation or the frame', async () => fixture(async h => {
    await h.command(CLI());
    const confirmation = h.ctx.confirmBodies.at(-1) as string;
    expect(confirmation).not.toContain('policy: file');
    expect(confirmation).not.toContain('operator_contract');
    const store = await h.reader();
    try { expect(store.campaign()!.policy).toBeUndefined(); } finally { store.close(); }
    // The coverage-proof rule is a goal-economy statement every run reads, so it is present even with no policy.
    const prompt = await plannerPrompt(h);
    expect(prompt).toContain('GOAL PROOF:');
    expect(prompt).toContain('mapping');
  }));

  it('admits an operator_contract claim only with the recorded artifact id, and names the legal id when it is wrong', async () => fixture(async h => {
    await h.command(CLI(' --policy standard:OWASP-WSTG'));
    const observation = await h.call('p2o_shell', { command: 'printf bounded-policy-observation' });
    const claim = await evidenceFor(h);
    const accepted = await claim.candidate('worker-a', boundedClaim({ evidenceRefs: [observation.details.evidenceId], policyBasis: 'operator_contract', policyRef: 'OWASP-WSTG' }) as never);
    expect(accepted.data).toMatchObject({ policyBasis: 'operator_contract', policyRef: 'OWASP-WSTG', closure: 'confirmed', execution: 'tested' });
    expect(isDemonstrated(accepted.data ?? {})).toBe(true);
    await expect(claim.candidate('worker-a', boundedClaim({ candidate: 'policy-claim-wrong', evidenceRefs: [observation.details.evidenceId], policyBasis: 'operator_contract', policyRef: 'OWASP-ASVS-L2' }) as never)).rejects.toThrow(/POLICY_REFERENCE_UNKNOWN.*OWASP-WSTG/s);
    await expect(claim.candidate('worker-a', boundedClaim({ candidate: 'policy-claim-missing', evidenceRefs: [observation.details.evidenceId], policyBasis: 'operator_contract' }) as never)).rejects.toThrow(/POLICY_UNRECORDED/);
    // policyRef is operator-policy provenance only; it cannot be attached to another basis.
    await expect(claim.candidate('worker-a', boundedClaim({ candidate: 'policy-claim-mixed', evidenceRefs: [observation.details.evidenceId], policyBasis: 'boundary_invariant', policyRef: 'OWASP-WSTG' }) as never)).rejects.toThrow(/must be operator_contract/);
  }));

  it('refuses operator_contract on a run with no policy and leaves the inferred rules untouched', async () => fixture(async h => {
    await h.command(CLI());
    const observation = await h.call('p2o_shell', { command: 'printf no-policy-observation' });
    const claim = await evidenceFor(h);
    await expect(claim.candidate('worker-a', boundedClaim({ evidenceRefs: [observation.details.evidenceId], policyBasis: 'operator_contract', policyRef: 'OWASP-WSTG' }) as never)).rejects.toThrow(/POLICY_UNRECORDED.*--policy/s);
    // The pre-existing inference rule is unchanged: a confirmed, untested, static trace still cannot be a hypothesis settled by assertion.
    await expect(claim.candidate('worker-a', boundedClaim({ candidate: 'policy-claim-inferred', closure: 'confirmed', execution: 'not_tested', proof: 'static_trace', evidenceRefs: [], policyBasis: 'inferred' }) as never)).rejects.toThrow(/Inferred policy is a hypothesis/);
  }));

  it('accepts a case backed by an operator_contract claim and refuses one whose policyRef is not the run policy', async () => fixture(async h => {
    await h.command(CLI(' --policy standard:OWASP-WSTG'));
    const asset = (await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /policy-fixture' } }] } })).details.acks[0];
    const observation = await h.call('p2o_shell', { command: 'printf policy-case-observation' });
    const claim = await evidenceFor(h);
    const supported = await claim.candidate('worker-a', boundedClaim({ evidenceRefs: [observation.details.evidenceId], policyBasis: 'operator_contract', policyRef: 'OWASP-WSTG' }) as never);
    const pending = (await h.call('p2o_case_author', { entry: caseDraft(asset.entityId, supported.id!) })).details;
    const accepted = (await h.call('p2o_case_author', { id: pending.id, revision: 1, entry: caseDraft(asset.entityId, supported.id!, { reviewStatus: 'accepted', reviewReason: 'Owner accepted the current demonstrated claim and its recorded policy source' }) })).details;
    expect(accepted.reviewStatus).toBe('accepted');
    // A claim that names a different artifact than the run recorded cannot carry a confirmed case (seeded directly, so the
    // write-time refusal is bypassed on purpose: acceptance must not trust a stored policyRef by itself).
    const stale = await seedClaim(h, boundedClaim({ candidate: 'policy-claim-stale', evidenceRefs: [], policyBasis: 'operator_contract', policyRef: 'OWASP-ASVS-L2' }));
    const pendingStale = (await h.call('p2o_case_author', { entry: caseDraft(asset.entityId, stale.id!, { title: 'Stale policy source case', rootCauseKey: 'root:policy-stale', policyKey: 'policy:fixture-stale' }) })).details;
    await expect(h.call('p2o_case_author', { id: pendingStale.id, revision: 1, entry: caseDraft(asset.entityId, stale.id!, { title: 'Stale policy source case', rootCauseKey: 'root:policy-stale', policyKey: 'policy:fixture-stale', reviewStatus: 'accepted', reviewReason: 'Owner accepted a claim whose policyRef is not the run policy' }) })).rejects.toThrow(/confirmed-verdict-lacks-current-tested-claim/);
  }));

  it('refuses a confirmed case supported only by an inferred demonstrated claim', async () => fixture(async h => {
    await h.command(CLI());
    const asset = (await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /policy-inferred' } }] } })).details.acks[0];
    const observation = await h.call('p2o_shell', { command: 'printf inferred-case-observation' });
    const claim = await evidenceFor(h);
    const inferred = await claim.candidate('worker-a', boundedClaim({ candidate: 'policy-claim-inferred-made', evidenceRefs: [observation.details.evidenceId], policyBasis: 'inferred', expectedPolicy: 'The sibling route suggests the boundary, but no operator policy was recorded' }) as never);
    const pending = (await h.call('p2o_case_author', { entry: caseDraft(asset.entityId, inferred.id!, { policyKey: 'policy:fixture-inferred' }) })).details;
    await expect(h.call('p2o_case_author', { id: pending.id, revision: 1, entry: caseDraft(asset.entityId, inferred.id!, { policyKey: 'policy:fixture-inferred', reviewStatus: 'accepted', reviewReason: 'Owner accepted an inferred-policy claim as a confirmed finding' }) })).rejects.toThrow(/confirmed-verdict-lacks-current-tested-claim/);
  }));

  it('prints the policy source in the campaign section and in the case provenance of the report', async () => fixture(async h => {
    await h.command(CLI(' --policy standard:OWASP-WSTG'));
    const asset = (await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /policy-report' } }] } })).details.acks[0];
    const observation = await h.call('p2o_shell', { command: 'printf policy-report-observation' });
    const claim = await evidenceFor(h);
    const supported = await claim.candidate('worker-a', boundedClaim({ candidate: 'policy-report-claim', evidenceRefs: [observation.details.evidenceId], policyBasis: 'operator_contract', policyRef: 'OWASP-WSTG' }) as never);
    const pending = (await h.call('p2o_case_author', { entry: caseDraft(asset.entityId, supported.id!) })).details;
    await h.call('p2o_case_author', { id: pending.id, revision: 1, entry: caseDraft(asset.entityId, supported.id!, { reviewStatus: 'accepted', reviewReason: 'Owner accepted the current demonstrated claim and its recorded policy source' }) });
    await h.call('p2o_finish', { partial: 'Fixture stops after the policy provenance demonstration; no plan goal was recorded.' });
    const report = await readFile(join(await reportDirectory(h), 'REPORT.md'), 'utf8');
    expect(report).toContain('Operator policy: standard OWASP-WSTG');
    expect(report).toContain('Operator policy provenance: standard OWASP-WSTG');
  }));
});
