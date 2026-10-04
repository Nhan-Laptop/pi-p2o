import { describe, expect, it } from 'vitest';
import {
  runSchema, taskSchema, attemptSchema, evidenceSchema, handoffSchema, coverageSchema, findingSchema,
  authorizationSchema, observedRuntimeSchema, validateTaskScope, compareRuntime, canonicalJson,
  digestJson, ValidationError, assertLifecycleTransition, assertPacketTransition, assertFindingTransition,
  validateFindingEvidence, validateCoverageEvidence,
} from '../../src/contracts/index.js';
import { NOW, HASH, runFixture, taskFixture, attemptFixture, evidenceFixture, h2Fixture, findingFixture, coverageFixture } from './fixtures.js';

describe('strict runtime schemas', () => {
  it('parses every primary contract and publishes JSON schemas', () => {
    for (const [schema, value] of [[runSchema, runFixture()], [taskSchema, taskFixture()], [attemptSchema, attemptFixture()], [evidenceSchema, evidenceFixture()], [handoffSchema, h2Fixture()], [coverageSchema, coverageFixture()], [findingSchema, findingFixture()]] as const) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(schema.jsonSchema.$schema).toContain('2020-12');
      expect(schema.validate(value)).toBe(true);
    }
  });
  it('rejects unknown fields, empty authorization, wildcard targets and malformed timestamps', () => {
    expect(runSchema.safeParse({ ...runFixture(), rootBash: true }).success).toBe(false);
    const run = runFixture(); run.authorization.reference = ' '; expect(runSchema.safeParse(run).success).toBe(false);
    const a = runFixture().authorization; a.targets[0].locator = 'https://*.example.invalid/'; expect(authorizationSchema.safeParse(a).success).toBe(false);
    const b = runFixture(); b.createdAt = '2026-02-30T10:00:00.000Z'; expect(runSchema.safeParse(b).success).toBe(false);
    expect(() => runSchema.parse({})).toThrow(ValidationError);
    expect(taskSchema.safeParse({ ...taskFixture(), workspace: '/tmp/a/../b' }).success).toBe(false);
  });
  it('rejects target URLs with userinfo, query/fragment or non-canonical origin', () => {
    for (const locator of ['https://name:pass@example.invalid/', 'https://example.invalid/?token=x', 'https://example.invalid/#private', 'https://EXAMPLE.invalid/']) {
      const a = runFixture().authorization; a.targets = [{ id: 'web', kind: 'web', locator }]; expect(authorizationSchema.safeParse(a).success).toBe(false);
    }
    const a = runFixture().authorization; a.targets = [{ id: 'web', kind: 'web', locator: 'http://127.0.0.1:8080/' }]; expect(authorizationSchema.validate(a)).toBe(true);
  });
  it('does not execute getters or accept non-JSON values, and detaches validated data', () => {
    let touched = false;
    const input = { ...runFixture() }; Object.defineProperty(input, 'authorization', { enumerable: true, get() { touched = true; throw new Error('must not execute'); } });
    expect(runSchema.safeParse(input).success).toBe(false); expect(touched).toBe(false);
    const e = evidenceFixture(); e.metadata = { invalid: undefined } as never; expect(evidenceSchema.safeParse(e).success).toBe(false);
    const original = runFixture(); const parsed = runSchema.parse(original); parsed.authorization.targets[0].digest = 'd'.repeat(64); expect(original.authorization.targets[0].digest).toBe(HASH);
    const bounded = evidenceFixture(); bounded.metadata = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field-${i}`, 'x'.repeat(60_000)])); expect(evidenceSchema.safeParse(bounded).success).toBe(false);
    expect(() => canonicalJson({ a: undefined })).toThrow(ValidationError);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle; expect(() => canonicalJson(cycle)).toThrow(ValidationError);
    expect(digestJson({ b: 1, a: 2 })).toBe(digestJson({ a: 2, b: 1 }));
  });
  it('requires denominator, modification disclosure and analyzer coverage limits', () => {
    const e = evidenceFixture('baseline-1', 'baseline'); e.test!.attempts = 0; expect(evidenceSchema.validate(e)).toBe(false);
    const modified = evidenceFixture(); modified.provenance.originalEnvironment = false; expect(evidenceSchema.validate(modified)).toBe(false);
    const analysis = evidenceFixture(); analysis.analysis = { requestedRanges: ['handler'], recoveredRanges: [], truncated: true, errors: [], unresolvedCoverage: [] }; expect(evidenceSchema.validate(analysis)).toBe(false);
    analysis.analysis.unresolvedCoverage = ['handler not recovered']; expect(evidenceSchema.validate(analysis)).toBe(true);
  });
});

describe('authorization, budgets and runtime selection', () => {
  it('accepts a contained task and rejects invalid scope/grants/inputs', () => {
    expect(validateTaskScope(taskFixture(), runFixture(), NOW)).toEqual([]);
    for (const mutate of [
      (t: ReturnType<typeof taskFixture>) => { t.scope.targetIds = ['outside']; },
      (t: ReturnType<typeof taskFixture>) => { t.scope.authorizationRef = 'wrong-owner'; },
      (t: ReturnType<typeof taskFixture>) => { t.scope.inputs[0].digest = 'd'.repeat(64); },
      (t: ReturnType<typeof taskFixture>) => { t.requiredCapabilities = ['host.bash']; },
      (t: ReturnType<typeof taskFixture>) => { t.allowedActions = ['unapproved-network']; },
      (t: ReturnType<typeof taskFixture>) => { t.budgets.maxRequests = 999; },
      (t: ReturnType<typeof taskFixture>) => { t.budgets.deadlineAt = '2026-10-02T11:30:00.000Z'; },
    ]) { const t = taskFixture(); mutate(t); expect(validateTaskScope(t, runFixture(), NOW).length).toBeGreaterThan(0); }
    expect(validateTaskScope(taskFixture(), runFixture(), '2026-10-02T12:00:00.000Z').map(i => i.code)).toContain('authorization-expired');
  });
  it('distinguishes runtime report from attestation and detects provider/model/thinking substitution', () => {
    const packet = h2Fixture(); expect(compareRuntime(packet.requestedRuntime, packet.observedRuntime)).toEqual({ matches: true, verification: 'reported', discrepancies: [] });
    packet.observedRuntime.selection = { provider: 'other-provider', model: 'other-model', thinking: 'off' };
    expect(compareRuntime(packet.requestedRuntime, packet.observedRuntime).discrepancies).toEqual(['provider', 'model', 'thinking']);
    packet.observedRuntime.capabilities.ownsLifecycle = false; expect(observedRuntimeSchema.validate(packet.observedRuntime)).toBe(false);
    const invalid = h2Fixture().observedRuntime; invalid.attestation = 'attested'; expect(observedRuntimeSchema.validate(invalid)).toBe(false);
  });
});

describe('independent state machines and evidence promotion', () => {
  it('rejects process-to-packet and packet-to-finding false completion', () => {
    expect(() => assertLifecycleTransition('running', 'exited')).not.toThrow();
    expect(() => assertPacketTransition('ready', 'accepted')).toThrow();
    expect(() => assertLifecycleTransition('exited', 'running')).toThrow();
    expect(() => assertFindingTransition('candidate', 'independently-validated')).toThrow();
    expect(() => assertFindingTransition('supported-static', 'reproduced')).not.toThrow();
    expect(coverageSchema.validate({ ...coverageFixture(), state: 'tested' })).toBe(false);
    expect(findingSchema.validate({ ...findingFixture(), state: 'reproduced' })).toBe(false);
  });
  it('keeps static findings static and requires genuine independent reproduction', () => {
    const f = findingFixture(); expect(validateFindingEvidence(f, [evidenceFixture()])).toEqual([]);
    f.state = 'reproduced'; f.classification = 'independently-observed'; f.evidenceIds = ['repro-1']; f.negativeControlEvidenceIds = ['control-1'];
    const repro = evidenceFixture('repro-1', 'reproduction'); const control = evidenceFixture('control-1', 'negative-control');
    expect(validateFindingEvidence(f, [repro, control])).toEqual([]);
    f.state = 'independently-validated'; f.verifier = { identity: 'verifier-1', attemptId: 'verify-1', environmentId: 'clean-lab', evidenceIds: ['verify-repro'] };
    expect(validateFindingEvidence(f, [repro, control]).length).toBeGreaterThan(0);
    const verified = evidenceFixture('verify-repro', 'reproduction', 'verify-1'); verified.provenance.collectorId = 'verifier-1'; verified.provenance.environmentId = 'clean-lab';
    expect(validateFindingEvidence(f, [repro, control, verified])).toEqual([]);
    verified.test!.invariant = 'unrelated fault'; expect(validateFindingEvidence(f, [repro, control, verified]).length).toBeGreaterThan(0); verified.test!.invariant = repro.test!.invariant;
    verified.provenance.environmentId = repro.provenance.environmentId; expect(validateFindingEvidence(f, [repro, control, verified]).length).toBeGreaterThan(0);
  });
  it('does not turn source-only coverage into runtime observation', () => {
    const c = { ...coverageFixture(), state: 'tested' as const, basis: 'runtime-observed' as const, evidenceIds: ['source-1'] };
    expect(validateCoverageEvidence(c, [evidenceFixture()]).length).toBeGreaterThan(0);
  });
});
