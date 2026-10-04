import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestJson, type EvidenceKind, type EvidenceReceipt, type FindingRecord, type HandoffPacket } from '../../src/contracts/index.js';
import { openEvidenceVault, sha256, type CollectorGrant, type EvidenceLimits, type EvidenceSubmission, type EvidenceVault } from '../../src/evidence/index.js';
import { attemptFixture, runFixture, taskFixture, NOW } from '../contracts/fixtures.js';

export { NOW };
export const SOURCE = 'export function handler(actor, record) { return record; }\n';
export const INPUT = sha256(SOURCE), BUILD = sha256('fixture-build-v2');
export const CLAIM = 'A foreign actor can read another account record';
export const CONFIG = 'c'.repeat(64), IMPLEMENTATION = sha256('fixed-inert-fixture-collector-v1');
/** Demonstrated literal source property; security hypothesis remains explicitly unverified. */
export const STATIC_SOURCE_PROOF = Object.freeze({ path: 'fixtures/input.ts', fileHash: INPUT, startLine: 1, endLine: 1,
  excerpt: 'return record;', hypothesis: 'A missing actor guard may permit a foreign read; runtime reachability and enforcement are untested.' });
export const STATIC_CLAIM = `Source ${STATIC_SOURCE_PROOF.path} lines 1-1 contains ${JSON.stringify(STATIC_SOURCE_PROOF.excerpt)}`;
export function collectStaticPropertyEvidence(h: Harness, id = 'source'): EvidenceReceipt {
  return h.collect(id, 'source', { artifactIdentity: { digest: INPUT, revision: 'r1' },
    metadata: { claimDigest: digestJson(STATIC_CLAIM), sourceClaim: { ...STATIC_SOURCE_PROOF }, surfaceId: 'handler', actorId: h.task.scope.actor.id } }, {}, SOURCE);
}
export interface Harness {
  base: string; staging: string; worker: string; vaultRoot: string; vault: EvidenceVault;
  run: ReturnType<typeof runFixture>; task: ReturnType<typeof taskFixture>; attempt: ReturnType<typeof attemptFixture>;
  grant(overrides?: Partial<CollectorGrant>): CollectorGrant;
  submission(id: string, kind?: EvidenceKind, overrides?: Partial<EvidenceSubmission>, content?: string): EvidenceSubmission;
  collect(id: string, kind?: EvidenceKind, overrides?: Partial<EvidenceSubmission>, binding?: Partial<CollectorGrant>, content?: string): EvidenceReceipt;
  dispose(): void;
}
export function createHarness(options: { limits?: Partial<EvidenceLimits>; secrets?: string[]; clock?: () => string } = {}): Harness {
  const base = mkdtempSync(join(tmpdir(), 'p2o-evidence-fixture-')), staging = join(base, 'staging'), worker = join(base, 'worker'), vaultRoot = join(base, 'vault');
  for (const path of [base, staging, worker]) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
  const clock = options.clock ?? (() => NOW), now = clock();
  const run = runFixture(), task = taskFixture('task-1', worker), attempt = attemptFixture();
  run.createdAt = now; run.authorization.validFrom = new Date(Date.parse(now) - 300_000).toISOString(); run.authorization.expiresAt = new Date(Date.parse(now) + 3_600_000).toISOString();
  run.authorization.allowedActions.push('read', 'analyze'); run.authorization.targets[0].digest = INPUT;
  run.budgets.deadlineAt = new Date(Date.parse(now) + 3_000_000).toISOString();
  task.createdAt = now; task.allowedActions.push('read', 'analyze'); task.budgets.deadlineAt = new Date(Date.parse(now) + 1_800_000).toISOString(); task.scope.inputs[0].digest = INPUT;
  attempt.createdAt = now; attempt.updatedAt = now; attempt.heartbeatAt = now; attempt.deadlineAt = task.budgets.deadlineAt;
  const vault = openEvidenceVault({ root: vaultRoot, artifactRoots: { staging }, workerWriteRoots: [worker], knownSecrets: options.secrets, limits: options.limits, clock });
  const grant = (overrides: Partial<CollectorGrant> = {}): CollectorGrant => ({ collectorId: 'collector-1', role: 'collector', runId: run.runId, taskId: task.taskId, attemptId: attempt.attemptId,
    authorizationRef: run.authorization.reference, environmentId: task.scope.environmentId, configurationDigest: task.scope.configurationDigest, scopeDigest: sha256('explicit-fixture-policy'), inputDigests: [INPUT],
    tool: { name: 'inert-collector', version: '1', implementationDigest: IMPLEMENTATION }, toolGrantId: 'fixture-grant-1', artifactRootIds: ['staging'],
    allowedKinds: ['source', 'observation', 'baseline', 'negative-control', 'reproduction', 'test', 'build', 'deployment', 'enforcement', 'runtime', 'trace', 'seed', 'coverage', 'sanitizer', 'log'],
    allowedClassifications: ['independently-observed', 'static-inference', 'unresolved', 'hypothesis'], validFrom: run.authorization.validFrom, expiresAt: run.authorization.expiresAt,
    originalEnvironment: true, modifications: [], ...overrides });
  const submission = (id: string, kind: EvidenceKind = 'source', overrides: Partial<EvidenceSubmission> = {}, content = kind === 'source' ? SOURCE : JSON.stringify({ fixture: id, inert: true })): EvidenceSubmission => {
    const path = `${id}.${kind === 'source' ? 'txt' : 'json'}`;
    writeFileSync(join(staging, path), content, { mode: 0o600 });
    return { evidenceId: id, idempotencyKey: id, artifact: { rootId: 'staging', path, expectedDigest: sha256(content), expectedBytes: Buffer.byteLength(content), mediaType: kind === 'source' ? 'text/plain' : 'application/json' },
      operationInputDigest: digestJson({ fixture: id }), kind, classification: kind === 'source' ? 'static-inference' : 'independently-observed', summary: 'Inert authorized local fixture collector', collectedAt: clock(), method: 'fixed local fixture collector', toolOptions: [], originalEnvironment: true, modifications: [], metadata: { claimDigest: digestJson(CLAIM), surfaceId: 'handler', actorId: task.scope.actor.id },
      ...(kind === 'baseline' || kind === 'negative-control' || kind === 'reproduction' ? { test: { purpose: kind, outcome: 'passed', successes: 1, attempts: 1, invariant: CLAIM, originalPolicy: true, targetId: 'fixture', artifactDigest: BUILD } } : {}), ...overrides };
  };
  return { base, staging, worker, vaultRoot, vault, run, task, attempt, grant, submission,
    collect(id, kind = 'source', overrides = {}, binding = {}, content) { return vault.admit(vault.issueCollector(grant(binding)), submission(id, kind, overrides, content)).receipt; },
    dispose() { try { vault.close(); } finally { rmSync(base, { recursive: true, force: true }); } },
  };
}
export function packetFixture(h: Harness, contract: HandoffPacket['contract'] = 'H4'): HandoffPacket {
  const envelope = { schemaVersion: 1 as const, packetId: `packet-${contract}`, runId: h.run.runId, taskId: h.task.taskId, attemptId: h.attempt.attemptId,
    producer: { id: h.attempt.ownerId, role: 'specialist' }, consumer: { id: 'reviewer-1', role: 'verifier' }, createdAt: h.task.createdAt, inputRevision: h.task.inputRevision, scope: h.task.scope, question: h.task.question,
    classification: 'independently-observed' as const, outcome: 'supported' as const, evidenceIds: ['source', 'repro', 'negative'],
    limits: { negativeControlEvidenceIds: ['negative'], failedAssumptions: [], untestedScope: ['other routes/versions are not tested'], risks: ['inert local fixture only'], reproduction: { successes: 1, attempts: 1 } },
    nextAction: { action: 'Review the one bounded fixture question', stopCondition: 'Stop after this fixture', allowedActions: ['review'] }, requestedRuntime: h.task.requestedRuntime,
    observedRuntime: { adapter: 'inert-fixture', selection: h.task.requestedRuntime.selection, capabilities: { ownsLifecycle: true, canHardStop: true, canResume: false, streamsEvents: true, attestsRuntime: false }, attestation: 'reported' as const, observedAt: h.task.createdAt, receiptEvidenceIds: [] },
  };
  switch (contract) {
    case 'H1': return { ...envelope, contract, evidenceIds: ['observation'], details: { interfaces: [{ surfaceId: 'handler', registration: 'fixture#router', handler: 'fixture#handler', actorId: h.task.scope.actor.id, gate: 'original-policy actor check', processIdentity: 'trusted inert fixture', formats: ['JSON'], benignOperations: ['read own record'], priority: 1, priorityReason: 'Boundary under review', evidenceIds: ['observation'], reachability: 'observed' }], unresolvedRoutes: ['other handlers'] } };
    case 'H2': return { ...envelope, contract, evidenceIds: ['source', 'baseline'], details: { minimalSlice: 'fixture#handler', invariant: CLAIM, controllableFields: ['record id'], constraints: ['read-only local fixture'], unknown: 'actor check branch', predictions: { ifTrue: 'foreign read accepted', ifFalse: 'foreign read rejected', observableIfTrue: 'status 200 with foreign marker', observableIfFalse: 'status 403' }, observationPoints: ['local HTTP response'], instrumentation: [], prerequisites: ['original fixture state'], prerequisitesKnown: true, baseline: { status: 'observed', evidenceIds: ['baseline'] }, lab: { safety: 'inert local lab', isolation: h.task.scope.isolation, authorized: true }, modifiedBuild: false } };
    case 'H3': return { ...envelope, contract, evidenceIds: ['seed', 'minimized', 'comparison', 'build', 'coverage', 'rejection', 'trace', 'repro'], details: { seedEvidenceIds: ['seed'], minimizedInputEvidenceIds: ['minimized'], initialization: 'reset fixture state', reset: 'fresh inert input', harnessComparisonEvidenceIds: ['comparison'], buildEvidenceIds: ['build'], coverageEvidenceIds: ['coverage'], rejectionEvidenceIds: ['rejection'], faultEvidenceIds: ['trace'], firstInvalidOperation: CLAIM, context: 'bounded logic transition', reproductionEvidenceIds: ['repro'], deduplicationRationale: 'same invariant and seed', harnessIsSoleFailure: false, originalAndModifiedSeparated: true } };
    case 'H4': return { ...envelope, contract, details: { invariant: CLAIM, earliestViolation: 'foreign marker returned', primitive: { operation: 'bounded fixture record read', direction: 'read', width: 'one JSON fixture record', controllability: 'record identifier only', repetition: 'one request', addressSpace: 'fixture service', lifetime: 'request', constraints: ['only approved local fixture record'] }, gates: ['fixture read-only actor'], mitigations: ['no external data'], damageRecovery: 'reset inert fixture', missingCapabilities: ['production impact not assessed'], reachabilityEvidenceIds: ['repro'], capabilityEdges: [], setupDisclosures: [] } };
    case 'H5': return { ...envelope, contract, evidenceIds: ['source', 'normal', 'forbidden'], details: { invariant: CLAIM, enforcementPoint: 'trusted handler actor check', affectedConsumers: ['JSON API', 'same policy consumer'], variants: ['direct', 'equivalent API path'], impact: 'inert local record only', emergencyMitigation: 'disable affected fixture feature', acceptedControlEvidenceIds: ['normal'], rejectedCaseEvidenceIds: ['forbidden'], matrix: [{ role: 'reader', feature: 'record', state: 'fresh', runtime: 'fixture', expected: 'own accepted / foreign forbidden' }], regressionProperties: ['all equivalent foreign reads reject while legitimate reads work'], equivalentPathsReviewed: true, repairKind: 'root-cause', sourceShippedGap: 'fixture source/build only; operations inventory must be checked', loggingRedaction: 'no record content/credentials in logs' } };
    case 'H6': return { ...envelope, contract, evidenceIds: ['source', 'build', 'deployment', 'enforcement', 'normal', 'forbidden'], details: { sourceChangeEvidenceIds: ['source'], buildEvidenceIds: ['build'], deploymentEvidenceIds: ['deployment'], enforcementEvidenceIds: ['enforcement'], acceptedControlEvidenceIds: ['normal'], forbiddenClassEvidenceIds: ['forbidden'], deploymentInventory: [{ targetId: 'fixture', artifactDigest: BUILD, revision: 'r2', active: true }], originalPolicy: true, rollout: 'inert fixture qualification only', activationRequirements: ['enable original-policy guard'], listenerMembershipChanges: [], detectionTransportCoverage: ['local immutable receipt'], compatibilityTradeoffs: ['normal fixture reads retained'], secretRotationScope: 'not applicable: inert fixture', residualRisks: ['not a production deployment'], closure: 'repaired' } };
  }
}
export function collectContractEvidence(h: Harness): void {
  collectStaticPropertyEvidence(h);
  h.collect('observation', 'observation'); h.collect('baseline', 'baseline'); h.collect('repro', 'reproduction'); h.collect('negative', 'negative-control');
  for (const id of ['seed', 'minimized']) h.collect(id, 'seed');
  h.collect('comparison', 'observation'); h.collect('coverage', 'coverage'); h.collect('rejection', 'coverage'); h.collect('trace', 'trace');
  h.collect('build', 'build', { artifactIdentity: { digest: BUILD, revision: 'r2', sourceDigest: INPUT } });
  const deployment = { targetId: 'fixture', artifactDigest: BUILD, sourceDigest: INPUT, containsAssessedFix: true, activeEnforcement: false, originalPolicy: true };
  h.collect('deployment', 'deployment', { deployment }); h.collect('enforcement', 'enforcement', { deployment: { ...deployment, activeEnforcement: true } });
  h.collect('normal', 'baseline'); h.collect('forbidden', 'test', { test: { purpose: 'forbidden', outcome: 'passed', successes: 1, attempts: 1, invariant: CLAIM, originalPolicy: true, targetId: 'fixture', artifactDigest: BUILD } });
}
export function findingFixture(h: Harness, state: FindingRecord['state'] = 'reproduced'): FindingRecord {
  return { schemaVersion: 1, findingId: 'finding-1', runId: h.run.runId, taskId: h.task.taskId, producerId: h.attempt.ownerId,
    title: state === 'supported-static' ? 'Demonstrated source property (unverified runtime hypothesis)' : 'Local record boundary',
    claim: state === 'supported-static' ? STATIC_CLAIM : CLAIM,
    classification: state === 'supported-static' ? 'static-inference' : state === 'unresolved' ? 'unresolved' : 'independently-observed', state,
    evidenceIds: state === 'supported-static' ? ['source'] : ['repro'], negativeControlEvidenceIds: state === 'supported-static' ? [] : ['negative'], limitations: ['bounded fixture only; no production inference'] };
}
export function reviewContext(h: Harness) { return { authorization: h.run.authorization, task: h.task, attempt: h.attempt, reviewerId: 'reviewer-1', now: h.task.createdAt }; }
