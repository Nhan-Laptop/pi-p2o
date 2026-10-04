import type { RunManifest, TaskManifest, EvidenceReceipt, HandoffEnvelope, HandoffPacket, H6Details, FindingRecord, CoverageRecord, AttemptRecord } from '../../src/contracts/index.js';

export const NOW = '2026-10-02T10:00:00.000Z';
export const HASH = 'a'.repeat(64);
export const BUILD_HASH = 'b'.repeat(64);
export const CONFIG_HASH = 'c'.repeat(64);
export function runFixture(): RunManifest {
  return {
    schemaVersion: 1, runId: 'run-1', createdAt: NOW, state: 'active',
    authorization: { reference: 'owner-approved-local-fixture', authorizedBy: 'fixture-owner', validFrom: '2026-10-02T09:00:00.000Z', expiresAt: '2026-10-02T12:00:00.000Z', targets: [{ id: 'fixture', kind: 'artifact', locator: 'fixtures/input.ts', digest: HASH, revision: 'r1' }], exclusions: ['excluded-fixture'], allowedActions: ['review', 'local-test'] },
    budgets: { deadlineAt: '2026-10-02T11:30:00.000Z', maxRequests: 10, maxBytes: 1_000_000, maxToolCalls: 100, maxTokens: 10_000, maxCostUsd: 10, maxAttempts: 3, maxTasks: 10, maxDepth: 3, maxConcurrency: 3, reportReserveMs: 60_000, targetRequestLimits: { fixture: 5 } },
    requestedRuntime: { adapter: 'inert-fixture', selection: { provider: 'fixture-provider', model: 'fixture-model', thinking: 'max' }, requiredCapabilities: ['ownsLifecycle'] },
    allowedCapabilities: ['source.read', 'local.test'],
  };
}
export function taskFixture(taskId = 'task-1', workspace = '/tmp/p2o-fixture/task-1'): TaskManifest {
  const run = runFixture();
  return {
    schemaVersion: 1, runId: run.runId, taskId, dependencyTaskIds: [], depth: 0, createdAt: NOW, inputRevision: 'r1',
    question: { text: 'Does the local handler enforce its input invariant?', ifTrue: 'Malformed local input is rejected', ifFalse: 'Malformed local input reaches the handler' },
    scope: { authorizationRef: run.authorization.reference, targetIds: ['fixture'], actor: { id: 'local-reader', privileges: ['read-only'] }, boundary: 'local fixture only', isolation: 'inert local lab', recovery: 'discard generated outputs', environmentId: 'lab-1', configurationDigest: CONFIG_HASH, inputs: [{ id: 'fixture', digest: HASH, locator: 'fixtures/input.ts', revision: 'r1' }] },
    skills: ['static-review'], allowedActions: ['review', 'local-test'], requiredCapabilities: ['source.read'],
    budgets: { deadlineAt: '2026-10-02T11:00:00.000Z', maxRequests: 5, maxBytes: 100_000, maxToolCalls: 20, maxTokens: 2_000, maxCostUsd: 2, maxAttempts: 3 },
    requestedRuntime: run.requestedRuntime, workspace, lifecycleState: 'queued', packetState: 'draft',
  };
}
export function evidenceFixture(evidenceId = 'source-1', kind: EvidenceReceipt['kind'] = 'source', attemptId = 'attempt-1', taskId = 'task-1', collectedAt = NOW): EvidenceReceipt {
  return {
    schemaVersion: 1, evidenceId, runId: 'run-1', taskId, attemptId, kind, classification: kind === 'source' ? 'static-inference' : 'independently-observed', digest: HASH, locator: `receipts/${evidenceId}.json`, mediaType: 'application/json', byteLength: 100, summary: 'Local fixture evidence only', redacted: true,
    provenance: { collectorId: 'collector-1', trust: 'collector', method: 'local fixture collector', collectedAt, tool: { name: 'inert-collector', version: '1', options: [] }, environmentId: 'lab-1', configurationDigest: CONFIG_HASH, inputDigests: [HASH], originalEnvironment: true, modifications: [] },
    ...(kind === 'baseline' || kind === 'reproduction' || kind === 'negative-control' ? { test: { purpose: kind, outcome: 'passed', successes: 1, attempts: 1, invariant: 'local input invariant', originalPolicy: true } } : {}),
  };
}
export function envelopeFixture(): HandoffEnvelope {
  const task = taskFixture();
  return {
    schemaVersion: 1, packetId: 'packet-1', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', producer: { id: 'worker-1', role: 'specialist' }, consumer: { id: 'reviewer-1', role: 'verifier' }, createdAt: NOW, inputRevision: task.inputRevision, scope: task.scope, question: task.question,
    classification: 'static-inference', outcome: 'supported', evidenceIds: ['source-1', 'baseline-1'],
    limits: { negativeControlEvidenceIds: [], failedAssumptions: [], untestedScope: [], risks: ['bounded local fixture only'], reproduction: { successes: 1, attempts: 1 } },
    nextAction: { action: 'Review the local invariant and its bounded test', stopCondition: 'Stop after this fixture question', allowedActions: ['review'] },
    requestedRuntime: task.requestedRuntime,
    observedRuntime: { adapter: 'inert-fixture', selection: { ...task.requestedRuntime.selection }, capabilities: { ownsLifecycle: true, canHardStop: true, canResume: false, streamsEvents: true, attestsRuntime: false }, attestation: 'reported', observedAt: NOW, receiptEvidenceIds: [] },
  };
}
export function h2Fixture(): Extract<HandoffPacket, { contract: 'H2' }> {
  return {
    ...envelopeFixture(), contract: 'H2',
    details: { minimalSlice: 'fixtures/input.ts#handler', invariant: 'Only accepted local input reaches the handler', controllableFields: ['input kind'], constraints: ['read-only local fixture'], unknown: 'receiver guard branch', predictions: { ifTrue: 'guard rejects', ifFalse: 'guard accepts', observableIfTrue: 'rejection receipt', observableIfFalse: 'handler receipt' }, observationPoints: ['local handler return value'], instrumentation: [], prerequisites: ['original fixture build'], prerequisitesKnown: true, baseline: { status: 'observed', evidenceIds: ['baseline-1'] }, lab: { safety: 'no traffic, local pure fixture', isolation: 'inert local lab', authorized: true }, modifiedBuild: false },
  };
}
export function staticH2Fixture(): Extract<HandoffPacket, { contract: 'H2' }> {
  const packet = h2Fixture(); packet.outcome = 'static-only'; packet.evidenceIds = ['source-1']; packet.limits.untestedScope = ['dynamic baseline unavailable']; packet.limits.reproduction = { successes: 0, attempts: 0 }; packet.details.baseline = { status: 'unavailable', evidenceIds: [], reason: 'Static-only review has no runtime environment' }; return packet;
}
export function h6Fixture(): Extract<HandoffPacket, { contract: 'H6' }> {
  const details: H6Details = {
    sourceChangeEvidenceIds: ['source-1'], buildEvidenceIds: ['build-1'], deploymentEvidenceIds: ['deployment-1'], enforcementEvidenceIds: ['enforcement-1'], acceptedControlEvidenceIds: ['baseline-1'], forbiddenClassEvidenceIds: ['forbidden-1'], deploymentInventory: [{ targetId: 'fixture', artifactDigest: BUILD_HASH, revision: 'r2', active: true }], originalPolicy: true, rollout: 'local fixture deployment', activationRequirements: ['enable the original policy guard'], listenerMembershipChanges: [], detectionTransportCoverage: ['local receipt'], compatibilityTradeoffs: [], secretRotationScope: 'not applicable: no exposed secrets', residualRisks: [], closure: 'repaired',
  };
  return { ...envelopeFixture(), contract: 'H6', classification: 'independently-observed', evidenceIds: ['source-1', 'baseline-1', 'build-1', 'deployment-1', 'enforcement-1', 'forbidden-1'], details };
}
export function h6Evidence(): EvidenceReceipt[] {
  const build = evidenceFixture('build-1', 'build'); build.artifact = { digest: BUILD_HASH, revision: 'r2', sourceDigest: HASH };
  const deployed = evidenceFixture('deployment-1', 'deployment'); deployed.deployment = { targetId: 'fixture', artifactDigest: BUILD_HASH, sourceDigest: HASH, containsAssessedFix: true, activeEnforcement: false, originalPolicy: true };
  const active = evidenceFixture('enforcement-1', 'enforcement'); active.deployment = { ...deployed.deployment, activeEnforcement: true };
  const forbidden = evidenceFixture('forbidden-1', 'test'); forbidden.test = { purpose: 'forbidden', outcome: 'passed', successes: 1, attempts: 1, originalPolicy: true };
  const baseline = evidenceFixture('baseline-1', 'baseline');
  baseline.test!.targetId = 'fixture'; baseline.test!.artifactDigest = BUILD_HASH;
  forbidden.test!.targetId = 'fixture'; forbidden.test!.artifactDigest = BUILD_HASH;
  return [evidenceFixture(), baseline, build, deployed, active, forbidden];
}
export function attemptFixture(): AttemptRecord {
  return { schemaVersion: 1, runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', sequence: 1, ownerId: 'worker-1', leaseToken: 'fixture-fencing-token', createdAt: NOW, updatedAt: NOW, lifecycleState: 'running', requestedRuntime: runFixture().requestedRuntime, heartbeatAt: NOW, deadlineAt: taskFixture().budgets.deadlineAt, usage: { requests: 0, bytes: 0, toolCalls: 0, tokens: 0, costUsd: 0 } };
}
export function findingFixture(): FindingRecord { return { schemaVersion: 1, findingId: 'finding-1', runId: 'run-1', taskId: 'task-1', producerId: 'worker-1', title: 'Local invariant inference', claim: 'Static local inference only', classification: 'static-inference', state: 'supported-static', evidenceIds: ['source-1'], negativeControlEvidenceIds: [], limitations: ['not dynamically reproduced'] }; }
export function coverageFixture(): CoverageRecord { return { schemaVersion: 1, coverageId: 'coverage-1', runId: 'run-1', taskId: 'task-1', surfaceId: 'fixture-handler', actorId: 'local-reader', question: 'Is the local invariant enforced?', state: 'untested', basis: 'worker-asserted', evidenceIds: [], reason: 'Runtime test not performed' }; }
