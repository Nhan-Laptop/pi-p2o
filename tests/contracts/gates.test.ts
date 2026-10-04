import { describe, expect, it } from 'vitest';
import { evaluateHandoff, digestJson, type HandoffPacket, type EvidenceReceipt, type AttemptRecord } from '../../src/contracts/index.js';
import { NOW, HASH, runFixture, taskFixture, attemptFixture, evidenceFixture, h2Fixture, staticH2Fixture, h6Fixture, h6Evidence, envelopeFixture } from './fixtures.js';
const check = (p: HandoffPacket, evidence: EvidenceReceipt[] = [evidenceFixture(), evidenceFixture('baseline-1', 'baseline')]) => evaluateHandoff(p, { authorization: runFixture().authorization, evidence, reviewerId: 'reviewer-1', now: NOW });
const codes = (p: HandoffPacket, evidence?: EvidenceReceipt[]) => check(p, evidence).reasons.map(i => i.code);

describe('H2 acceptance and explicit limits', () => {
  it('accepts distinguishable experiment with saved known-good baseline', () => {
    const p = h2Fixture(); const decision = check(p); expect(decision.status).toBe('accepted'); expect(decision.acceptedDigest).toBe(digestJson(p));
  });
  it('returns insufficient baseline, identical observables and unsafe/unknown prerequisites', () => {
    const p = h2Fixture(); p.details.baseline.evidenceIds = []; expect(codes(p)).toContain('H2-baseline');
    p.details.predictions.observableIfFalse = p.details.predictions.observableIfTrue; expect(codes(p)).toContain('H2-indistinguishable');
    const unknown = h2Fixture(); unknown.details.prerequisitesKnown = false; unknown.details.lab.authorized = false; expect(codes(unknown)).toEqual(expect.arrayContaining(['H2-prerequisites', 'H2-safe-lab']));
    const workerBaseline = evidenceFixture('baseline-1', 'baseline'); workerBaseline.provenance.trust = 'worker'; expect(codes(h2Fixture(), [evidenceFixture(), workerBaseline])).toContain('H2-baseline');
  });
  it('returns undisclosed modified builds and wrong baseline configuration', () => {
    const p = h2Fixture(); p.details.modifiedBuild = true; expect(codes(p)).toContain('H2-hidden-modification');
    p.details.modificationDisclosure = 'instrumented local guard, original behavior not established';
    const baseline = evidenceFixture('baseline-1', 'baseline'); baseline.provenance.configurationDigest = 'd'.repeat(64); expect(codes(p, [evidenceFixture(), baseline])).toContain('H2-safe-lab');
  });
  it('accepts evidence-backed static/unresolved outcomes without inventing runtime success', () => {
    const p = staticH2Fixture(); expect(check(p, [evidenceFixture()]).status).toBe('accepted');
    p.outcome = 'unresolved'; p.classification = 'unresolved'; p.limits.failedAssumptions = ['No original runtime available']; expect(check(p, [evidenceFixture()]).status).toBe('accepted');
    p.limits.untestedScope = []; expect(codes(p, [evidenceFixture()])).toContain('unresolved-limits');
    const falseStatic = staticH2Fixture(); falseStatic.classification = 'independently-observed'; expect(codes(falseStatic, [evidenceFixture()])).toContain('static-limits');
  });
  it('rejects missing/foreign evidence, expired scope and runtime substitution', () => {
    const p = h2Fixture(); expect(codes(p, [evidenceFixture()])).toContain('missing-reference');
    const foreign = evidenceFixture('baseline-1', 'baseline'); foreign.runId = 'run-2'; expect(codes(p, [evidenceFixture(), foreign])).toContain('foreign-evidence');
    const expired = evaluateHandoff(p, { authorization: runFixture().authorization, evidence: [], reviewerId: 'reviewer-1', now: '2026-10-02T12:00:00.000Z' }); expect(expired.reasons.map(i => i.code)).toContain('authorization-expired');
    p.observedRuntime.selection!.thinking = 'off'; expect(codes(p)).toContain('runtime-mismatch');
    expect(check(p).unansweredQuestions.join(' ')).toContain('provider/model/thinking');
  });
});

describe('H6 shipped and active verification', () => {
  it('accepts agreed source/build/deployed/active hashes and original-policy controls', () => {
    expect(check(h6Fixture(), h6Evidence()).status).toBe('accepted');
  });
  it('does not close based on source merge, timeout, shipped-but-inactive code, or mismatched hash', () => {
    const p = h6Fixture(); expect(codes(p, [evidenceFixture()])).toEqual(expect.arrayContaining(['H6-build', 'H6-deployment', 'H6-enforcement', 'H6-controls']));
    const inactive = h6Evidence(); inactive.find(e => e.kind === 'enforcement')!.deployment!.activeEnforcement = false; expect(codes(p, inactive)).toContain('H6-shipped-active');
    p.details.deploymentInventory[0].artifactDigest = HASH; expect(codes(p, h6Evidence())).toContain('H6-shipped-active');
    const noPolicy = h6Fixture(); noPolicy.details.originalPolicy = false; expect(codes(noPolicy, h6Evidence())).toContain('H6-controls');
  });
  it('does not hide a failed/inconclusive forbidden control behind a passing sample', () => {
    const p = h6Fixture(); const evidence = h6Evidence();
    const failed = structuredClone(evidence.find(e => e.evidenceId === 'forbidden-1')!); failed.evidenceId = 'forbidden-failed'; failed.test!.outcome = 'failed'; failed.test!.successes = 0;
    evidence.push(failed); p.evidenceIds.push(failed.evidenceId); p.details.forbiddenClassEvidenceIds.push(failed.evidenceId);
    expect(codes(p, evidence)).toContain('H6-shipped-active');
    failed.test!.outcome = 'inconclusive'; expect(codes(p, evidence)).toContain('H6-shipped-active');
  });
  it('binds passing controls to the actual deployed target and artifact, not an old baseline', () => {
    const evidence = h6Evidence(); evidence.find(e => e.kind === 'baseline')!.test!.artifactDigest = HASH;
    expect(codes(h6Fixture(), evidence)).toContain('H6-shipped-active');
  });
  it('accepts source-only evidence as unverified and rejects static closure upgrades', () => {
    const p = h6Fixture(); p.outcome = 'static-only'; p.classification = 'static-inference'; p.evidenceIds = ['source-1']; p.details.buildEvidenceIds = []; p.details.deploymentEvidenceIds = []; p.details.enforcementEvidenceIds = []; p.details.acceptedControlEvidenceIds = []; p.details.forbiddenClassEvidenceIds = []; p.details.deploymentInventory = []; p.details.closure = 'unverified'; p.limits.untestedScope = ['actual package, deployment and activation'];
    expect(check(p, [evidenceFixture()]).status).toBe('accepted'); p.details.closure = 'repaired'; expect(codes(p, [evidenceFixture()])).toContain('H6-closure');
    p.details.closure = 'unverified'; p.outcome = 'unresolved'; p.classification = 'unresolved'; p.limits.failedAssumptions = ['Deployment unavailable']; expect(check(p, [evidenceFixture()]).status).toBe('accepted');
  });
  it('requires a verified subset and residual risks for partial repair', () => {
    const p = h6Fixture(); p.details.closure = 'partially-repaired'; expect(codes(p, h6Evidence())).toContain('H6-partial');
    p.details.residualRisks = ['another rollout not activated']; p.limits.untestedScope = ['remaining rollout']; expect(check(p, h6Evidence()).status).toBe('accepted');
    p.details.deploymentInventory[0].artifactDigest = 'd'.repeat(64); expect(codes(p, h6Evidence())).toContain('H6-partial');
  });
});

describe('composable H1/H3/H4/H5 rules', () => {
  it('accepts H1 inferred handler only with an explicit bounded reachability check', () => {
    const p: HandoffPacket = { ...envelopeFixture(), contract: 'H1', outcome: 'static-only', evidenceIds: ['source-1'], details: { interfaces: [{ surfaceId: 'handler', registration: 'routes.ts#register', handler: 'handler.ts#accept', actorId: 'local-reader', gate: 'read-only guard', processIdentity: 'fixture process', formats: ['json'], benignOperations: ['local read'], priority: 1, priorityReason: 'lowest actor input', evidenceIds: ['source-1'], reachability: 'inferred', proposedCheck: 'inspect handler registration' }], unresolvedRoutes: [] } };
    p.limits.untestedScope = ['runtime reachability']; expect(check(p, [evidenceFixture()]).status).toBe('accepted'); delete p.details.interfaces[0].proposedCheck; expect(codes(p, [evidenceFixture()])).toContain('H1-prioritized-entry');
  });
  it('requires H3 saved-seed reproduction and real-target comparison, not a crash address', () => {
    const p: HandoffPacket = { ...envelopeFixture(), contract: 'H3', classification: 'independently-observed', evidenceIds: ['seed', 'build', 'coverage', 'fault', 'repro', 'comparison'], details: { seedEvidenceIds: ['seed'], minimizedInputEvidenceIds: ['seed'], initialization: 'fresh local state', reset: 'new fixture', harnessComparisonEvidenceIds: ['comparison'], buildEvidenceIds: ['build'], coverageEvidenceIds: ['coverage'], rejectionEvidenceIds: ['coverage'], faultEvidenceIds: ['fault'], firstInvalidOperation: 'invalid local transition', context: 'before state commit', reproductionEvidenceIds: ['repro'], deduplicationRationale: 'same invariant and input hash', harnessIsSoleFailure: false, originalAndModifiedSeparated: true } };
    const evidence = [evidenceFixture('seed', 'seed'), evidenceFixture('build', 'build'), evidenceFixture('coverage', 'coverage'), evidenceFixture('fault', 'sanitizer'), evidenceFixture('repro', 'reproduction'), evidenceFixture('comparison', 'observation')]; evidence.find(e => e.kind === 'reproduction')!.test!.invariant = p.details.firstInvalidOperation;
    expect(check(p, evidence).status).toBe('accepted'); p.details.harnessIsSoleFailure = true; p.details.reproductionEvidenceIds = []; expect(codes(p, evidence)).toEqual(expect.arrayContaining(['H3-harness', 'H3-reproduction']));
  });
  it('accepts H4 bounded static inference and rejects blanket primitive claims/unsupported edges', () => {
    const p: HandoffPacket = { ...envelopeFixture(), contract: 'H4', outcome: 'static-only', evidenceIds: ['source-1'], details: { invariant: 'input length before read', earliestViolation: 'local guard', primitive: { operation: 'bounded local read', direction: 'read', width: 'one field', controllability: 'input only', repetition: 'once', addressSpace: 'fixture process', lifetime: 'call duration', constraints: ['fixed buffer'] }, gates: ['read-only actor'], mitigations: ['bounds check'], damageRecovery: 'discard local state', missingCapabilities: ['runtime environment'], reachabilityEvidenceIds: [], capabilityEdges: [], setupDisclosures: [] } };
    p.limits.untestedScope = ['dynamic reachability']; expect(check(p, [evidenceFixture()]).status).toBe('accepted'); p.details.primitive.operation = 'arbitrary write'; expect(codes(p, [evidenceFixture()])).toContain('H4-constraints');
  });
  it('requires H5 variant-level repair properties and normal controls, with separate mitigation classification', () => {
    const p: HandoffPacket = { ...envelopeFixture(), contract: 'H5', outcome: 'static-only', evidenceIds: ['source-1'], details: { invariant: 'reject malformed type before consumer', enforcementPoint: 'trusted parser', affectedConsumers: ['handler'], variants: ['alternate local representation'], impact: 'bounded inference, no demonstrated impact', emergencyMitigation: 'disable affected local feature', acceptedControlEvidenceIds: [], rejectedCaseEvidenceIds: [], matrix: [{ role: 'reader', feature: 'local parse', state: 'fresh', runtime: 'fixture', expected: 'normal accepted' }], regressionProperties: ['all equivalent malformed types rejected'], equivalentPathsReviewed: false, repairKind: 'exposure-mitigation', sourceShippedGap: 'no package or deployment receipt', loggingRedaction: 'omit input secrets' } };
    p.limits.untestedScope = ['regression execution']; expect(check(p, [evidenceFixture()]).status).toBe('accepted'); p.outcome = 'supported'; expect(codes(p, [evidenceFixture()])).toEqual(expect.arrayContaining(['H5-variant-review', 'H5-controls']));
    p.details.enforcementPoint = 'trigger-only blacklist'; expect(codes(p, [evidenceFixture()])).toContain('H5-trigger-only');
  });
});

describe('managed handoff runtime request binding', () => {
  const replacementSelection = { provider: 'replacement-provider', model: 'replacement-model', thinking: 'high' } as const;
  const replacementRuntime = () => ({ ...runFixture().requestedRuntime, selection: { ...replacementSelection } });
  const evidence = () => [evidenceFixture(), evidenceFixture('baseline-1', 'baseline')];
  const attemptContext = (): AttemptRecord => ({ ...attemptFixture(), requestedRuntime: replacementRuntime() });

  it('binds a replacement packet to the attempt request instead of the initial task request', () => {
    const p = h2Fixture(); p.requestedRuntime = replacementRuntime(); p.observedRuntime.selection = { ...replacementSelection };
    const decision = evaluateHandoff(p, { authorization: runFixture().authorization, evidence: evidence(), reviewerId: 'reviewer-1', now: NOW, task: taskFixture(), attempt: attemptContext() });
    expect(decision.status).toBe('accepted'); expect(decision.reasons.map(r => r.code)).not.toContain('runtime-request');
  });

  it('produces exactly one runtime-request issue when a packet diverges from the attempt request', () => {
    const codes = evaluateHandoff(h2Fixture(), { authorization: runFixture().authorization, evidence: evidence(), reviewerId: 'reviewer-1', now: NOW, task: taskFixture(), attempt: attemptContext() }).reasons.map(r => r.code);
    expect(codes.filter(c => c === 'runtime-request')).toHaveLength(1);
  });

  it('still rejects a changed task runtime when no attempt context is supplied', () => {
    const p = h2Fixture(); p.requestedRuntime = replacementRuntime(); p.observedRuntime.selection = { ...replacementSelection };
    const decision = evaluateHandoff(p, { authorization: runFixture().authorization, evidence: evidence(), reviewerId: 'reviewer-1', now: NOW, task: taskFixture() });
    const codes = decision.reasons.map(r => r.code);
    expect(codes.filter(c => c === 'runtime-request')).toHaveLength(1); expect(decision.status).toBe('returned-for-evidence');
  });
});
