import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { validationDraft } from '../../src/validation.js';
import { evidenceFor, fixture, populate, seedClaim } from './helpers/report-fixture.js';

/**
 * planning_update.md P21/A4: a negative observation needs a discriminating control, and the host validation brief carries the
 * claim's own replay facts so the replay is semantic, not only byte-identical. Both are admission/teaching changes: the
 * evidence ladder, the rating ceiling and the case gates do not move.
 */
const CONFIRMED = { closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', negativeControls: [],
  policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor boundary', limitations: 'One inert fixture request only' } as const;

describe('P21/A4 negative-claim control warning (admission)', () => {
  it('warns on a confirmed negative-class claim with no control, and stays quiet for a control or a positive claim', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const shell = (await h.call('p2o_shell', { command: 'printf fixture-baseline' })).details;
      const evidence = await evidenceFor(h);
      const negative = await evidence.candidate('worker-a', { ...CONFIRMED, candidate: 'nextauth-credentials-no-throttle-bounded',
        surface: '/api/auth/callback/credentials', risk: 'authorization', evidenceRefs: [shell.evidenceId] } as never);
      expect(negative.data?.admissionWarnings).toEqual(expect.arrayContaining([expect.stringContaining('negative claim without a discriminating control')]));
      // A warning is not a refusal: the claim keeps its closure and its host replay stamp.
      expect(negative.data?.closure).toBe('confirmed');
      expect(negative.data?.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
      const controlled = await evidence.candidate('worker-a', { ...CONFIRMED, candidate: 'strapi-admin-login-limiter-not-engaged',
        surface: '/admin/login', risk: 'authorization', evidenceRefs: [shell.evidenceId], negativeControls: [shell.evidenceId] } as never);
      expect(controlled.data?.admissionWarnings).toBeUndefined();
      const positive = await evidence.candidate('worker-a', { ...CONFIRMED, candidate: 'strapi-documentation-openapi-anon-exposure',
        surface: '/documentation', risk: 'authorization', evidenceRefs: [shell.evidenceId] } as never);
      expect(positive.data?.admissionWarnings).toBeUndefined();
    });
  });
});

describe('P21/A4 validation brief carries the replay facts', () => {
  const claim = { id: 'claim-1234', refs: ['receipt-author-1', 'receipt-author-2'], data: { candidate: 'nextauth-credentials-no-throttle-bounded',
    replayUnits: [{ payloadRef: 'payload-11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64), bytes: 120, kind: 'request' }],
    payloadRef: 'payload-11111111-1111-4111-8111-111111111111', payloadSha256: 'a'.repeat(64) } } as never;
  const candidate = { candidate: 'nextauth-credentials-no-throttle-bounded', expectedPolicy: 'The declared login boundary rejects every credential attempt', surface: '/api/auth/callback/credentials', risk: 'authorization' } as never;
  const discovery = { id: 'task-discovery-1', revision: 2, runId: 'run-fixture', surface: '/api/auth/callback/credentials', risk: 'authorization' } as never;

  it('names the claim, its receipts and the replay unit, and asks the mechanism question inside every field bound', () => {
    const draft = validationDraft(claim, candidate, discovery);
    expect(draft.question).toContain('claim-1234');
    expect(draft.question).toContain('receipt-author-1');
    expect(draft.question).toContain('payload-11111111-1111-4111-8111-111111111111');
    expect(draft.question).toContain('sha256 aaaaaaaaaaaaaaaa');
    expect(draft.question).toContain('materialize=true');
    expect(draft.question).toContain('exercises the claimed mechanism or a short-circuit before it');
    expect(draft.question).toContain('reproduces=claim-1234');
    expect(draft.expectedTrue).toContain('reproduces=claim-1234');
    expect(Buffer.byteLength(draft.question)).toBeLessThanOrEqual(1500);
    expect(Buffer.byteLength(draft.expectedTrue)).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(draft.expectedFalse)).toBeLessThanOrEqual(1000);
  });

  it('says a claim with no host replay unit has none instead of inventing a payload', () => {
    const draft = validationDraft({ id: 'claim-5678', refs: [], data: { candidate: 'legacy-claim' } } as never,
      { candidate: 'legacy-claim', expectedPolicy: 'declared boundary' } as never, discovery);
    expect(draft.question).toContain('no host replay unit was recorded for it');
    expect(draft.question).not.toContain('materialize=true');
  });
});

describe('P21/A4 report surfaces the warning', () => {
  it('prints the claim admission warning next to the claims table', async () => {
    await fixture(async h => {
      const built = await populate(h);
      await seedClaim(h, { candidate: 'no-throttle-warning-fixture', surface: '/api/login', risk: 'authorization', closure: 'confirmed',
        execution: 'tested', proof: 'offline_reproduction', evidenceRefs: [built.observation.evidenceId], negativeControls: [],
        policyBasis: 'boundary_invariant', expectedPolicy: 'Declared login boundary', limitations: 'One inert fixture request only',
        admissionWarnings: ['negative claim without a discriminating control: name the positive control that proves the request reached the claimed mechanism, not a short-circuit before it'] } as never);
      h.ctx.setConfirm(true);
      await h.command(`report export ${join(h.root, 'out')}`);
      const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
      expect(report).toContain('Admission warnings:');
      expect(report).toContain('negative claim without a discriminating control');
    });
  });
});
