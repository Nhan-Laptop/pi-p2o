import { isAbsolute, resolve } from 'node:path';
import { rules as r, makeSchema, type Rule, type ValidationIssue } from './validation.js';
import {
  SCHEMA_VERSION, lifecycleStates, packetStates, findingStates, runStates, classifications,
  runtimeCapabilityNames, thinkingLevels, evidenceKinds,
  type RunManifest, type TaskManifest, type AttemptRecord, type EvidenceReceipt,
  type HandoffPacket, type CoverageRecord, type FindingRecord, type Authorization,
  type Scope, type RequestedRuntime, type ObservedRuntime, type BudgetUsage, type GateDecision,
} from './types.js';

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const text = r.string();
const id = r.string({ pattern: ID_PATTERN, maxLength: 128 });
const digest = r.string({ pattern: /^[a-f0-9]{64}$/, maxLength: 64 });
const date = r.string({ format: 'date-time', maxLength: 24 });
const uint = r.number(true);
const positive = r.number(true, 1);
const bool = r.boolean();
const opt = r.optional;
const obj = r.object;
const en = r.enum;
const ids = r.array(id, 0, true);
const texts = r.array(text, 0, true);
const version = r.literal(SCHEMA_VERSION);
const classification = en(classifications);
const artifact = obj({ id, digest, locator: text, revision: text });
const runtimeSelection = obj({ provider: text, model: text, thinking: en(thinkingLevels) });
const capabilities = obj(Object.fromEntries(runtimeCapabilityNames.map(k => [k, bool])));
const processIdentity = obj({ pid: positive, hostId: id, startToken: text });
const requestedRuntime = obj({ adapter: text, selection: runtimeSelection, requiredCapabilities: r.array(en(runtimeCapabilityNames), 0, true) });
const observedRuntime = obj({ adapter: text, selection: opt(runtimeSelection), capabilities, attestation: en(['attested', 'reported', 'unavailable']), observedAt: date, receiptEvidenceIds: ids, processIdentity: opt(processIdentity) });
const target = obj({ id, kind: en(['artifact', 'web', 'service', 'lab']), locator: text, digest: opt(digest), revision: opt(text) });
const authorization = obj({ reference: text, authorizedBy: text, validFrom: date, expiresAt: date, targets: r.array(target, 1), exclusions: texts, allowedActions: r.array(text, 1, true) });
const scope = obj({ authorizationRef: text, targetIds: r.array(id, 1, true), actor: obj({ id, privileges: texts }), boundary: text, isolation: text, recovery: text, environmentId: id, configurationDigest: digest, inputs: r.array(artifact) });
const question = obj({ text, ifTrue: text, ifFalse: text });
const budgetFields = { deadlineAt: date, maxRequests: uint, maxBytes: uint, maxToolCalls: uint, maxTokens: uint, maxCostUsd: r.number(), maxAttempts: positive };
const budget = obj(budgetFields);
const runBudget = obj({ ...budgetFields, maxTasks: positive, maxDepth: uint, maxConcurrency: positive, reportReserveMs: uint, targetRequestLimits: r.record(uint, ID_PATTERN) });
const usage = obj({ requests: uint, bytes: uint, toolCalls: uint, tokens: uint, costUsd: r.number() });
const exit = obj({ code: r.union(r.number(true, -2_147_483_648, 2_147_483_647), r.literal(null)), signal: opt(text), observedAt: date });
const add = (e: ValidationIssue[], path: string, code: string, message: string) => e.push({ path, code, message });
const uniqueIds = (values: { id: string }[], e: ValidationIssue[], path: string) => { if (new Set(values.map(v => v.id)).size !== values.length) add(e, path, 'duplicate', 'Identities must be unique'); };
function checkAuthorization(a: Authorization, e: ValidationIssue[], path = '$'): void {
  if (Date.parse(a.expiresAt) <= Date.parse(a.validFrom)) add(e, path, 'authorization-window', 'Authorization expiry must follow its start');
  uniqueIds(a.targets, e, `${path}/targets`);
  if (new Set(a.targets.map(t => t.locator)).size !== a.targets.length) add(e, `${path}/targets`, 'duplicate', 'Target locators must be unique');
  for (const [i, t] of a.targets.entries()) {
    const p = `${path}/targets/${i}`;
    if (t.locator.includes('*')) add(e, p, 'wildcard-target', 'Targets must be exact identities, not wildcards');
    if (t.kind === 'artifact' && (!t.digest || !t.revision)) add(e, p, 'artifact-identity', 'An artifact target needs a digest and revision');
    if (t.kind === 'web' || t.kind === 'service') {
      try {
        const u = new URL(t.locator);
        const schemes = t.kind === 'web' ? ['http:', 'https:'] : ['http:', 'https:', 'tcp:', 'udp:'];
        if (!schemes.includes(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash || t.locator !== u.href) add(e, p, 'target-url', 'Use a canonical exact URL without credentials/query/fragment');
      } catch { add(e, p, 'target-url', 'Target URL is invalid'); }
    }
    if (a.exclusions.some(x => t.id === x || t.locator === x || t.locator.startsWith(x.endsWith('/') ? x : `${x}/`))) add(e, p, 'excluded-target', 'An approved target overlaps an explicit exclusion');
  }
}
function checkObserved(v: ObservedRuntime, e: ValidationIssue[], path = '$'): void {
  if ((v.capabilities.canHardStop || v.capabilities.canResume) && !v.capabilities.ownsLifecycle) add(e, path, 'capability-ownership', 'Stop/resume requires lifecycle ownership');
  if (v.attestation === 'attested' && (!v.selection || !v.capabilities.attestsRuntime || v.receiptEvidenceIds.length === 0)) add(e, path, 'runtime-attestation', 'Attestation needs a selection, capability and receipt');
  if (v.attestation === 'reported' && !v.selection) add(e, path, 'runtime-selection', 'Reported runtime must report its selection');
  if (v.attestation === 'unavailable' && v.selection) add(e, path, 'runtime-selection', 'Unavailable runtime cannot claim a selection');
}
function checkScope(s: Scope, e: ValidationIssue[], path = '$'): void { uniqueIds(s.inputs, e, `${path}/inputs`); }
export const authorizationSchema = makeSchema<Authorization>('authorization', authorization, checkAuthorization);
export const scopeSchema = makeSchema<Scope>('scope', scope, checkScope);
export const requestedRuntimeSchema = makeSchema<RequestedRuntime>('requested-runtime', requestedRuntime);
export const observedRuntimeSchema = makeSchema<ObservedRuntime>('observed-runtime', observedRuntime, checkObserved);
export const budgetUsageSchema = makeSchema<BudgetUsage>('budget-usage', usage);
export const runSchema = makeSchema<RunManifest>('run', obj({ schemaVersion: version, runId: id, createdAt: date, state: en(runStates), authorization, budgets: runBudget, requestedRuntime, allowedCapabilities: texts }), (v, e) => {
  checkAuthorization(v.authorization, e, '$/authorization');
  const end = Date.parse(v.budgets.deadlineAt);
  if (end <= Date.parse(v.createdAt) || end > Date.parse(v.authorization.expiresAt)) add(e, '$/budgets/deadlineAt', 'deadline', 'Run deadline must follow creation and fit authorization');
  if (Date.parse(v.createdAt) < Date.parse(v.authorization.validFrom)) add(e, '$/createdAt', 'authorization-window', 'Run creation predates authorization');
  if (v.budgets.reportReserveMs >= end - Date.parse(v.createdAt)) add(e, '$/budgets/reportReserveMs', 'report-reserve', 'Reporting reserve consumes the whole run');
  if (v.budgets.maxConcurrency > v.budgets.maxTasks) add(e, '$/budgets', 'concurrency', 'Concurrency exceeds task count');
  const targets = new Set(v.authorization.targets.map(t => t.id));
  for (const key of Object.keys(v.budgets.targetRequestLimits)) if (!targets.has(key)) add(e, '$/budgets/targetRequestLimits', 'target-budget', 'Budget names an unauthorized target');
  for (const t of targets) if (!Object.hasOwn(v.budgets.targetRequestLimits, t)) add(e, '$/budgets/targetRequestLimits', 'target-budget', 'Every target requires a request limit');
});
export const taskSchema = makeSchema<TaskManifest>('task', obj({ schemaVersion: version, runId: id, taskId: id, parentTaskId: opt(id), dependencyTaskIds: ids, depth: uint, createdAt: date, inputRevision: text, question, scope, skills: texts, allowedActions: texts, requiredCapabilities: texts, budgets: budget, requestedRuntime, workspace: text, lifecycleState: en(lifecycleStates), packetState: en(packetStates) }), (v, e) => {
  checkScope(v.scope, e, '$/scope');
  if (!isAbsolute(v.workspace) || resolve(v.workspace) !== v.workspace || v.workspace === resolve('/')) add(e, '$/workspace', 'workspace', 'Workspace must be a normalized private absolute path');
  if (v.parentTaskId === v.taskId || v.dependencyTaskIds.includes(v.taskId)) add(e, '$/dependencyTaskIds', 'self-dependency', 'A task cannot depend on itself');
  if (Date.parse(v.budgets.deadlineAt) <= Date.parse(v.createdAt)) add(e, '$/budgets/deadlineAt', 'deadline', 'Task deadline must follow creation');
});
export const attemptSchema = makeSchema<AttemptRecord>('attempt', obj({ schemaVersion: version, runId: id, taskId: id, attemptId: id, sequence: positive, ownerId: id, leaseToken: r.string({ minLength: 16, maxLength: 128 }), createdAt: date, updatedAt: date, lifecycleState: en(lifecycleStates), requestedRuntime, observedRuntime: opt(observedRuntime), heartbeatAt: date, deadlineAt: date, checkpoint: opt(artifact), exit: opt(exit), usage }), (v, e) => {
  if (v.observedRuntime) checkObserved(v.observedRuntime, e, '$/observedRuntime');
  if (Date.parse(v.updatedAt) < Date.parse(v.createdAt) || Date.parse(v.heartbeatAt) < Date.parse(v.createdAt) || Date.parse(v.deadlineAt) <= Date.parse(v.createdAt)) add(e, '$', 'attempt-time', 'Attempt timestamps are inconsistent');
});
const testReceipt = obj({ purpose: en(['baseline', 'negative-control', 'reproduction', 'regression', 'forbidden']), outcome: en(['passed', 'failed', 'inconclusive']), successes: uint, attempts: uint, invariant: opt(text), originalPolicy: bool, targetId: opt(id), artifactDigest: opt(digest) });
export const evidenceSchema = makeSchema<EvidenceReceipt>('evidence', obj({
  schemaVersion: version, evidenceId: id, runId: id, taskId: id, attemptId: id, kind: en(evidenceKinds), classification,
  digest, locator: text, mediaType: text, byteLength: uint, summary: text, redacted: bool,
  provenance: obj({ collectorId: id, trust: en(['collector', 'worker']), method: text, collectedAt: date, tool: obj({ name: text, version: text, options: texts }), environmentId: id, configurationDigest: digest, inputDigests: r.array(digest, 0, true), originalEnvironment: bool, modifications: texts }),
  test: opt(testReceipt), artifact: opt(obj({ digest, revision: text, sourceDigest: opt(digest) })),
  deployment: opt(obj({ targetId: id, artifactDigest: digest, sourceDigest: digest, containsAssessedFix: bool, activeEnforcement: bool, originalPolicy: bool })),
  analysis: opt(obj({ requestedRanges: texts, recoveredRanges: texts, truncated: bool, errors: texts, unresolvedCoverage: texts })), metadata: opt(r.jsonObject()),
}), (v, e) => {
  if (!v.provenance.originalEnvironment && !v.provenance.modifications.length) add(e, '$/provenance/modifications', 'undisclosed-modification', 'Modified environment needs explicit modifications');
  if (v.test && (v.test.successes > v.test.attempts || (v.test.outcome === 'passed' && (v.test.attempts === 0 || v.test.successes === 0)))) add(e, '$/test', 'denominator', 'Test outcome must agree with a non-empty reproduction denominator');
  if (v.analysis && (v.analysis.truncated || v.analysis.errors.length) && !v.analysis.unresolvedCoverage.length) add(e, '$/analysis', 'analysis-limits', 'Truncation/errors require unresolved coverage');
});
export const coverageSchema = makeSchema<CoverageRecord>('coverage', obj({ schemaVersion: version, coverageId: id, runId: id, taskId: opt(id), surfaceId: id, actorId: id, question: text, state: en(['tested', 'ruled-out', 'blocked', 'untested', 'not-applicable']), basis: en(['worker-asserted', 'runtime-observed', 'reviewer-validated']), evidenceIds: ids, reason: text }), (v, e) => {
  if (['tested', 'ruled-out'].includes(v.state) && !v.evidenceIds.length) add(e, '$/evidenceIds', 'coverage-evidence', 'Tested/ruled-out coverage needs evidence');
});
export const findingSchema = makeSchema<FindingRecord>('finding', obj({ schemaVersion: version, findingId: id, runId: id, taskId: id, producerId: id, title: text, claim: text, classification, state: en(findingStates), evidenceIds: ids, negativeControlEvidenceIds: ids, limitations: texts, impact: opt(text), verifier: opt(obj({ identity: id, attemptId: id, environmentId: id, evidenceIds: r.array(id, 1, true) })) }), (v, e) => {
  if (['supported-static', 'reproduced', 'independently-validated'].includes(v.state) && !v.evidenceIds.length) add(e, '$/evidenceIds', 'finding-evidence', 'Supported findings need evidence');
  if (v.state === 'supported-static' && v.classification !== 'static-inference') add(e, '$/classification', 'finding-classification', 'Static findings must remain static inference');
  if (['reproduced', 'independently-validated'].includes(v.state) && (v.classification !== 'independently-observed' || !v.negativeControlEvidenceIds.length)) add(e, '$', 'finding-controls', 'Observed findings need observed classification and controls');
  if (v.state === 'independently-validated' && (!v.verifier || v.verifier.identity === v.producerId)) add(e, '$/verifier', 'independent-verifier', 'An independent verifier is required');
  if (v.state === 'unresolved' && v.classification !== 'unresolved') add(e, '$/classification', 'finding-classification', 'Unresolved findings must remain unresolved');
});
const commonHandoff = {
  schemaVersion: version, packetId: id, runId: id, taskId: id, attemptId: id,
  producer: obj({ id, role: text }), consumer: obj({ id, role: text }), createdAt: date, inputRevision: text,
  scope, question, classification, outcome: en(['supported', 'static-only', 'unresolved']), evidenceIds: ids,
  limits: obj({ negativeControlEvidenceIds: ids, failedAssumptions: texts, untestedScope: texts, risks: texts, reproduction: obj({ successes: uint, attempts: uint }) }),
  nextAction: obj({ action: text, stopCondition: text, allowedActions: texts }), requestedRuntime, observedRuntime,
};
const details: Record<HandoffPacket['contract'], Rule> = {
  H1: obj({ interfaces: r.array(obj({ surfaceId: id, registration: text, handler: text, actorId: id, gate: text, processIdentity: text, formats: texts, benignOperations: texts, priority: positive, priorityReason: text, evidenceIds: ids, reachability: en(['observed', 'inferred']), proposedCheck: opt(text) })), architecture: opt(text), unresolvedRoutes: texts, peerTopology: opt(r.array(obj({ peer: text, identityOrigin: text, membershipEvidenceIds: ids, authorityEvidenceIds: ids }))) }),
  H2: obj({ minimalSlice: text, invariant: text, controllableFields: texts, constraints: texts, unknown: text, predictions: obj({ ifTrue: text, ifFalse: text, observableIfTrue: text, observableIfFalse: text }), observationPoints: texts, instrumentation: texts, prerequisites: texts, prerequisitesKnown: bool, baseline: obj({ status: en(['observed', 'unavailable']), evidenceIds: ids, reason: opt(text) }), lab: obj({ safety: text, isolation: text, authorized: bool }), modifiedBuild: bool, modificationDisclosure: opt(text), composition: opt(obj({ representationChanges: texts, writersReaders: texts, encoding: text, phaseGuards: texts, inferredEdges: texts, terminalStateEvidenceIds: ids })) }),
  H3: obj({ seedEvidenceIds: ids, minimizedInputEvidenceIds: ids, initialization: text, reset: text, harnessComparisonEvidenceIds: ids, buildEvidenceIds: ids, coverageEvidenceIds: ids, rejectionEvidenceIds: ids, faultEvidenceIds: ids, firstInvalidOperation: text, context: text, reproductionEvidenceIds: ids, deduplicationRationale: text, harnessIsSoleFailure: bool, originalAndModifiedSeparated: bool }),
  H4: obj({ invariant: text, earliestViolation: text, primitive: obj({ operation: text, direction: en(['read', 'write', 'state', 'logic', 'other']), width: text, controllability: text, repetition: text, addressSpace: text, lifetime: text, constraints: texts }), gates: texts, mitigations: texts, damageRecovery: text, missingCapabilities: texts, reachabilityEvidenceIds: ids, capabilityEdges: r.array(obj({ from: text, to: text, preconditions: texts, evidenceIds: ids })), setupDisclosures: texts }),
  H5: obj({ invariant: text, enforcementPoint: text, affectedConsumers: texts, variants: texts, impact: text, emergencyMitigation: text, acceptedControlEvidenceIds: ids, rejectedCaseEvidenceIds: ids, matrix: r.array(obj({ role: text, feature: text, state: text, runtime: text, expected: text })), regressionProperties: texts, equivalentPathsReviewed: bool, repairKind: en(['root-cause', 'exposure-mitigation', 'unresolved']), sourceShippedGap: text, loggingRedaction: text }),
  H6: obj({ sourceChangeEvidenceIds: ids, buildEvidenceIds: ids, deploymentEvidenceIds: ids, enforcementEvidenceIds: ids, acceptedControlEvidenceIds: ids, forbiddenClassEvidenceIds: ids, deploymentInventory: r.array(obj({ targetId: id, artifactDigest: digest, revision: text, active: bool })), originalPolicy: bool, rollout: text, activationRequirements: texts, listenerMembershipChanges: texts, detectionTransportCoverage: texts, compatibilityTradeoffs: texts, secretRotationScope: text, residualRisks: texts, closure: en(['repaired', 'exposure-mitigated', 'partially-repaired', 'unverified']) }),
};
export const handoffSchema = makeSchema<HandoffPacket>('handoff', r.union(...Object.entries(details).map(([contract, d]) => obj({ ...commonHandoff, contract: r.literal(contract), details: d }))), (v, e) => {
  checkScope(v.scope, e, '$/scope'); checkObserved(v.observedRuntime, e, '$/observedRuntime');
  if (v.limits.reproduction.successes > v.limits.reproduction.attempts) add(e, '$/limits/reproduction', 'denominator', 'Successes exceed attempts');
});
export const gateDecisionSchema = makeSchema<GateDecision>('gate-decision', obj({
  status: en(['accepted', 'returned-for-evidence']), contract: opt(en(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])),
  outcome: opt(en(['supported', 'static-only', 'unresolved'])), reviewerId: id, evaluatedAt: date,
  reasons: r.array(obj({ code: text, path: text, message: text, question: text })), unansweredQuestions: texts, acceptedDigest: opt(digest),
}), (v, e) => {
  if (v.status === 'accepted' && (!v.contract || !v.outcome || !v.acceptedDigest || v.reasons.length || v.unansweredQuestions.length)) add(e, '$', 'gate-decision', 'Acceptance requires an output digest, outcome and no unresolved gate reasons');
  if (v.status === 'returned-for-evidence' && (!v.reasons.length || v.acceptedDigest)) add(e, '$', 'gate-decision', 'Returned packets require reasons and must not carry an accepted digest');
});
