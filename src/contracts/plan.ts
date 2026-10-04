import type { Classification, CoverageRecord, Digest, EvidenceKind, Id, JsonObject, Question, RunManifest, RuntimeSelection, Scope, Timestamp } from './types.js';
import { ID_PATTERN } from './schemas.js';
import { classifications, evidenceKinds, thinkingLevels } from './types.js';
import { digestJson, makeSchema, rules as r } from './validation.js';
import { normalizeTargetKey, threatModelCapsDefaults } from './threat-model.js';

/**
 * Planner contract. A bounded planner attempt (scripted fixture or a real worker packet) proposes a
 * target-driven plan: tasks, owner-approved observations bound to concrete URLs/accounts, self-declared
 * caps and provenance. Design is deliberately target-typed: nothing here grants authority; the owner
 * approves the exact canonical proposal digest and only then are tasks admitted.
 */

export type PlanIssue = { code: string; path: string; message: string };
export const planIssue = (code: string, path: string, message: string): PlanIssue => ({ code, path, message });

export const planPriorities = ['critical', 'high', 'normal', 'low'] as const;
export type PlanPriority = typeof planPriorities[number];
export const planCoverageOutcomes = ['resolved', 'needs_follow_up', 'not_applicable', 'untested', 'blocked'] as const;
export type PlanCoverageOutcome = typeof planCoverageOutcomes[number];
export const planCoverageBases = ['worker-asserted', 'runtime-observed', 'reviewer-validated'] as const;
export type PlanCoverageBasis = typeof planCoverageBases[number];

export interface PlanTarget { id: Id; kind: 'artifact' | 'web' | 'service' | 'lab'; locator: string }

export interface PlanRequestBudget {
  deadlineAt: Timestamp;
  maxRequests: number;
  maxBytes: number;
  maxToolCalls: number;
  maxTokens: number;
  maxCostUsd: number;
  maxAttempts: number;
  maxTasks: number;
  maxDepth: number;
  maxConcurrency: number;
}

export interface PlanRunRequest {
  runId: Id;
  /** Bounded statement of what this plan is for; never used as authority. */
  purpose: string;
  inputRevision: string;
  scope: Scope;
  /** Exact target identities this plan binds observations to; must agree with the run authorization. */
  targets: PlanTarget[];
  /** Owner-approved account ids an observation input may name. */
  accounts: Id[];
  allowedCapabilities: string[];
  allowedActions: string[];
  budgets: PlanRequestBudget;
}

export interface PlanTask {
  taskId: Id;
  question: Question;
  /** Bounded surface identity (ID-safe) used for coverage records and checks. */
  surfaceId: Id;
  /** Human-readable surface label, e.g. an endpoint or file path. */
  surface: string;
  actor: { id: Id; privileges: string[] };
  targetIds: Id[];
  skills: string[];
  allowedActions: string[];
  requiredCapabilities: string[];
  /** Proposal-local task dependencies; resolved to admitted task ids on materialization. */
  dependencies: Id[];
  priority: PlanPriority;
  /** Zero-based graph depth; must stay within caps.maxDepth and the run's approved depth. */
  depth: number;
  /** Optional owner serialization domains copied onto the materialized task. */
  exclusiveKeys?: string[];
}

export type PlanObservationExpectation =
  | { type: 'http'; status: number; bodyIncludes?: string; mustMatch?: boolean }
  | { type: 'source'; contains?: string };

export interface PlanObservation {
  observationId: Id;
  taskId: Id;
  /** Capability the controller will execute; must be inside `allowedCapabilities`. */
  tool: string;
  /** Concrete binding (url / accountId / path). Workers may only select the observationId, never supply input. */
  input: JsonObject;
  expectation?: PlanObservationExpectation;
  kind: EvidenceKind;
  classification: Classification;
  summary: string;
  /** Owner-visible request cost of this observation; summed against caps.maxRequests. */
  requests: number;
}

export interface PlanCoverageCell {
  cellId: Id;
  taskId: Id;
  surfaceId: Id;
  actorId: Id;
  question: string;
  riskArea?: string;
}

export interface PlanThreatModelDraft { targetKey: string; body: string }

export interface PlanCaps {
  maxTasks: number;
  maxDepth: number;
  maxObservations: number;
  maxRequests: number;
}

export interface PlanProvenance {
  plannerAttemptId: Id;
  /** 'scripted' is the deterministic inert planner used by tests; 'worker' is a real runtime proposal packet. */
  plannerKind: 'scripted' | 'worker';
  /** The planner attempt's own requested selection; informational, never a runtime grant. */
  requestedSelection: RuntimeSelection;
  inputDigests: Digest[];
  producedAt: Timestamp;
  /** Digest of the exact raw packet the plan was derived from; injected by the ledger when absent. */
  packetDigest?: Digest;
}

export interface PlanProposal {
  schemaVersion: 1;
  proposalId: Id;
  run: PlanRunRequest;
  tasks: PlanTask[];
  observations: PlanObservation[];
  coverage: PlanCoverageCell[];
  caps: PlanCaps;
  provenance: PlanProvenance;
  /** Optional baseline threat-model draft bounded to this run and one normalized target key. */
  threatModel?: PlanThreatModelDraft;
}

/** A stored proposal: the exact proposal plus its content digest. */
export interface StoredPlanProposal {
  proposalId: Id;
  digest: Digest;
  runId: Id;
  proposal: PlanProposal;
  storedAt: Timestamp;
  plannerAttemptId: Id;
}

/**
 * Owner-authored batch approval. Everything is bound into one document digest: proposal id + canonical
 * digest, exact task/observation counts, run id, approval window. An altered proposal or a document for
 * another proposal cannot match.
 */
export interface PlanApprovalDocument {
  version: 1;
  approvalId: Id;
  proposalId: Id;
  proposalDigest: Digest;
  runId: Id;
  approvedBy: string;
  reference: string;
  approvedAt: Timestamp;
  expiresAt: Timestamp;
  taskCount: number;
  observationCount: number;
  note?: string;
}

export interface PlanApproval {
  allowed: true;
  digest: Digest;
  proposalId: Id;
  proposalDigest: Digest;
  approvalId: Id;
  approvalDocumentDigest: Digest;
  authorizationRef: string;
  approvedBy: string;
  reference: string;
  expiresAt: Timestamp;
}

export interface PlanCoverageResolution {
  runId: Id;
  cellId: Id;
  outcome: PlanCoverageOutcome;
  basis: PlanCoverageBasis;
  evidenceIds: Id[];
  reason: string;
  /** Explicit carry-forward into the report as untested/blocked; never implied. */
  carried: boolean;
  authorAttemptId: Id;
  at: Timestamp;
}

export interface ReconciledCoverageCell {
  cellId: Id;
  taskId: Id;
  surfaceId: Id;
  actorId: Id;
  question: string;
  riskArea?: string;
  outcome: PlanCoverageOutcome | 'open';
  carried: boolean;
  reportState: CoverageRecord['state'];
  reason: string;
  evidenceIds: Id[];
  authorAttemptId?: Id;
  at?: Timestamp;
}

export interface CoverageReconciliation {
  runId: Id;
  cells: ReconciledCoverageCell[];
  resolved: Id[];
  carried: Id[];
  unresolved: Id[];
  issues: PlanIssue[];
  canFinalize: boolean;
  limitations: string[];
}

// ---------------------------------------------------------------------------------------------
// Runtime validators (shape + semantics). Codes are stable and explicit.
// ---------------------------------------------------------------------------------------------

const id = r.string({ pattern: ID_PATTERN, maxLength: 128 });
const digest = r.string({ pattern: /^[a-f0-9]{64}$/, maxLength: 64 });
const date = r.string({ format: 'date-time', maxLength: 24 });
const prose = r.string({ maxLength: 8_192 });
const uint = r.number(true);
const positive = r.number(true, 1);
const texts = r.array(r.string({ maxLength: 256 }), 0, true);
const ids = r.array(id, 0, true);

const artifactRule = r.object({ id, digest, locator: r.string({ maxLength: 4_096 }), revision: r.string({ maxLength: 256 }) });
const scopeRule = r.object({
  authorizationRef: r.string({ maxLength: 512 }), targetIds: r.array(id, 1, true),
  actor: r.object({ id, privileges: texts }),
  boundary: r.string({ maxLength: 4_096 }), isolation: r.string({ maxLength: 4_096 }), recovery: r.string({ maxLength: 4_096 }),
  environmentId: id, configurationDigest: digest, inputs: r.array(artifactRule),
});
const questionRule = r.object({ text: prose, ifTrue: prose, ifFalse: prose });
const targetRule = r.object({ id, kind: r.enum(['artifact', 'web', 'service', 'lab']), locator: r.string({ maxLength: 4_096 }) });
const selectionRule = r.object({ provider: r.string({ maxLength: 160 }), model: r.string({ maxLength: 240 }), thinking: r.enum(thinkingLevels) });

export const planCapsRule = r.object({
  maxTasks: r.number(true, 1, 4_096), maxDepth: r.number(true, 0, 64),
  maxObservations: r.number(true, 1, 16_384), maxRequests: r.number(true, 1, 1_000_000),
});
export const planCapsSchema = makeSchema<PlanCaps>('plan-caps', planCapsRule);

export const planRequestBudgetRule = r.object({
  deadlineAt: date, maxRequests: uint, maxBytes: uint, maxToolCalls: uint, maxTokens: uint,
  maxCostUsd: r.number(), maxAttempts: positive, maxTasks: positive, maxDepth: uint, maxConcurrency: positive,
});
export const planRunRequestRule = r.object({
  runId: id, purpose: prose, inputRevision: r.string({ maxLength: 512 }), scope: scopeRule,
  targets: r.array(targetRule, 1), accounts: ids,
  allowedCapabilities: texts, allowedActions: texts, budgets: planRequestBudgetRule,
});
export const planRunRequestSchema = makeSchema<PlanRunRequest>('plan-run-request', planRunRequestRule);

export const planTaskRule = r.object({
  taskId: id, question: questionRule, surfaceId: id, surface: r.string({ maxLength: 512 }),
  actor: r.object({ id, privileges: texts }), targetIds: r.array(id, 1, true),
  skills: texts, allowedActions: texts, requiredCapabilities: texts, dependencies: ids,
  priority: r.enum(planPriorities), depth: r.number(true, 0, 64), exclusiveKeys: r.optional(texts),
});
export const planTaskSchema = makeSchema<PlanTask>('plan-task', planTaskRule);

export const planObservationRule = r.object({
  observationId: id, taskId: id, tool: r.string({ maxLength: 64 }), input: r.jsonObject(),
  expectation: r.optional(r.union(
    r.object({ type: r.literal('http'), status: r.number(true, 100, 599), bodyIncludes: r.optional(r.string({ maxLength: 4_096 })), mustMatch: r.optional(r.boolean()) }),
    r.object({ type: r.literal('source'), contains: r.optional(r.string({ maxLength: 4_096 })) }),
  )),
  kind: r.enum(evidenceKinds), classification: r.enum(classifications), summary: r.string({ maxLength: 2_048 }),
  requests: r.number(true, 1, 1_000_000),
});
export const planObservationSchema = makeSchema<PlanObservation>('plan-observation', planObservationRule);

export const planCoverageCellRule = r.object({
  cellId: id, taskId: id, surfaceId: id, actorId: id, question: prose, riskArea: r.optional(r.string({ maxLength: 512 })),
});
export const planCoverageCellSchema = makeSchema<PlanCoverageCell>('plan-coverage-cell', planCoverageCellRule);

export const planProvenanceRule = r.object({
  plannerAttemptId: id, plannerKind: r.enum(['scripted', 'worker']), requestedSelection: selectionRule,
  inputDigests: r.array(digest, 0, true), producedAt: date, packetDigest: r.optional(digest),
});
export const planProposalRule = r.object({
  schemaVersion: r.literal(1), proposalId: id, run: planRunRequestRule,
  tasks: r.array(planTaskRule, 0), observations: r.array(planObservationRule, 0),
  coverage: r.array(planCoverageCellRule, 0), caps: planCapsRule, provenance: planProvenanceRule,
  threatModel: r.optional(r.object({ targetKey: r.string({ maxLength: 2_048 }), body: r.string({ maxLength: threatModelCapsDefaults.maxBodyChars }) })),
});
export const planProposalSchema = makeSchema<PlanProposal>('plan-proposal', planProposalRule);

export const planApprovalDocumentSchema = makeSchema<PlanApprovalDocument>('plan-approval', r.object({
  version: r.literal(1), approvalId: id, proposalId: id, proposalDigest: digest, runId: id,
  approvedBy: r.string({ maxLength: 512 }), reference: r.string({ maxLength: 512 }), approvedAt: date, expiresAt: date,
  taskCount: r.number(true, 0, 4_096), observationCount: r.number(true, 0, 16_384), note: r.optional(r.string({ maxLength: 4_096 })),
}));

export const planCoverageResolutionSchema = makeSchema<PlanCoverageResolution>('plan-coverage-resolution', r.object({
  runId: id, cellId: id, outcome: r.enum(planCoverageOutcomes), basis: r.enum(planCoverageBases),
  evidenceIds: ids, reason: r.string({ maxLength: 2_048 }), carried: r.boolean(), authorAttemptId: id, at: date,
}), (resolution, issues) => {
  if (resolution.outcome === 'resolved' && resolution.evidenceIds.length === 0) {
    issues.push({ path: '$/evidenceIds', code: 'coverage-missing-evidence', message: 'Resolved coverage needs at least one receipt-backed evidence id' });
  }
  if (resolution.outcome !== 'resolved' && resolution.reason.trim().length < 8) {
    issues.push({ path: '$/reason', code: 'coverage-missing-reason', message: 'Open, carried or not-applicable coverage needs a bounded reason' });
  }
});

export interface PlanValidationOptions {
  /** Owner-visible hard ceiling; the stricter of the declared and supplied caps always wins. */
  caps?: Partial<PlanCaps>;
  /** Admitted run the proposal binds to; when supplied, run-level widening is refused. */
  run?: RunManifest;
}

export function effectivePlanCaps(proposal: PlanProposal, ceiling: Partial<PlanCaps> = {}): PlanCaps {
  return {
    maxTasks: Math.min(proposal.caps.maxTasks, ceiling.maxTasks ?? proposal.caps.maxTasks),
    maxDepth: Math.min(proposal.caps.maxDepth, ceiling.maxDepth ?? proposal.caps.maxDepth),
    maxObservations: Math.min(proposal.caps.maxObservations, ceiling.maxObservations ?? proposal.caps.maxObservations),
    maxRequests: Math.min(proposal.caps.maxRequests, ceiling.maxRequests ?? proposal.caps.maxRequests),
  };
}

export function planProposalDigest(proposal: PlanProposal): Digest { return digestJson(proposal); }

function bindingIssues(observation: PlanObservation, task: PlanTask, run: PlanRunRequest, add: (code: string, path: string, message: string) => void): void {
  const input = observation.input as Record<string, unknown>;
  const url = typeof input.url === 'string' ? input.url : undefined;
  const accountId = typeof input.accountId === 'string' ? input.accountId : undefined;
  const filePath = typeof input.path === 'string' ? input.path : undefined;
  if (!url && !accountId && !filePath) {
    add('plan-observation-bound', `$/observations/${observation.observationId}/input`, 'Observation input must bind a concrete url, accountId or path');
    return;
  }
  if (url !== undefined) {
    if (url.includes('*')) { add('plan-observation-bound', `$/observations/${observation.observationId}/input/url`, 'Observation input may not be a wildcard'); return; }
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { add('plan-observation-bound', `$/observations/${observation.observationId}/input/url`, 'Observation url is not an absolute URL'); return; }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      add('plan-observation-bound', `$/observations/${observation.observationId}/input/url`, 'Observation url may not carry credentials, query or fragment');
      return;
    }
    const target = run.targets.find(candidate => {
      try { return normalizeTargetKey(candidate.locator) === normalizeTargetKey(url); }
      catch { return false; }
    });
    if (!target) { add('plan-observation-target', `$/observations/${observation.observationId}/input/url`, 'Observation url is outside the proposal target set'); return; }
    if (!task.targetIds.includes(target.id)) add('plan-observation-target', `$/observations/${observation.observationId}/input/url`, 'Observation url belongs to a target its task does not scope');
  }
  if (accountId !== undefined && !run.accounts.includes(accountId)) {
    add('plan-observation-account', `$/observations/${observation.observationId}/input/accountId`, 'Observation account is not in the owner-approved account set');
  }
}

/** Semantics only, after shape validation. Every failure carries a stable explicit code. */
export function validatePlanProposal(input: unknown, options: PlanValidationOptions = {}): PlanIssue[] {
  const parsed = planProposalSchema.safeParse(input);
  if (!parsed.success) return parsed.issues.map(issue => planIssue('plan-schema', issue.path, `${issue.code}: ${issue.message}`));
  const proposal = parsed.data;
  const issues: PlanIssue[] = [];
  const add = (code: string, path: string, message: string) => { if (issues.length < 100) issues.push(planIssue(code, path, message)); };
  const caps = effectivePlanCaps(proposal, options.caps);
  const run = options.run;
  const request = proposal.run;

  if (!proposal.tasks.length) add('plan-empty', '$/tasks', 'A plan proposal must contain at least one task');
  if (!proposal.observations.length) add('plan-empty', '$/observations', 'A plan proposal must contain at least one observation');
  if (!proposal.coverage.length) add('plan-empty', '$/coverage', 'A plan proposal must declare its coverage cells');
  if (proposal.tasks.length > caps.maxTasks) add('plan-task-count', '$/tasks', `Proposal has ${proposal.tasks.length} tasks; cap is ${caps.maxTasks}`);
  if (proposal.observations.length > caps.maxObservations) add('plan-observation-count', '$/observations', `Proposal has ${proposal.observations.length} observations; cap is ${caps.maxObservations}`);
  const requestSum = proposal.observations.reduce((sum, observation) => sum + observation.requests, 0);
  if (requestSum > caps.maxRequests) add('plan-request-budget', '$/observations', `Observations request ${requestSum} target requests; cap is ${caps.maxRequests}`);

  const taskIds = new Set<string>();
  for (const task of proposal.tasks) {
    if (taskIds.has(task.taskId)) add('plan-duplicate-task', `$/tasks/${task.taskId}`, 'Task identities must be unique');
    taskIds.add(task.taskId);
  }
  for (const task of proposal.tasks) {
    if (task.depth > caps.maxDepth) add('plan-depth', `$/tasks/${task.taskId}/depth`, `Task depth ${task.depth} exceeds cap ${caps.maxDepth}`);
    if (task.question.ifTrue === task.question.ifFalse) add('plan-task-question', `$/tasks/${task.taskId}/question`, 'Task predictions must be distinguishable');
    if (task.dependencies.includes(task.taskId)) add('plan-dependency', `$/tasks/${task.taskId}/dependencies`, 'Task cannot depend on itself');
    for (const dependency of task.dependencies) if (!taskIds.has(dependency)) add('plan-dependency', `$/tasks/${task.taskId}/dependencies`, `Unknown dependency ${dependency}`);
    if (!task.targetIds.length) add('plan-task-targets', `$/tasks/${task.taskId}/targetIds`, 'Task must scope at least one target');
    for (const targetId of task.targetIds) if (!request.scope.targetIds.includes(targetId)) add('plan-task-targets', `$/tasks/${task.taskId}/targetIds`, `Task target ${targetId} is outside the proposed scope`);
    for (const capability of task.requiredCapabilities) if (!request.allowedCapabilities.includes(capability)) add('plan-task-capabilities', `$/tasks/${task.taskId}/requiredCapabilities`, `Capability ${capability} is not in allowedCapabilities`);
    for (const action of task.allowedActions) if (!request.allowedActions.includes(action)) add('plan-task-actions', `$/tasks/${task.taskId}/allowedActions`, `Action ${action} is not in allowedActions`);
    if (task.actor.id !== request.scope.actor.id) add('plan-task-actor', `$/tasks/${task.taskId}/actor/id`, 'Task actor must be the proposed scope actor');
    for (const privilege of task.actor.privileges) if (!request.scope.actor.privileges.includes(privilege)) add('plan-task-actor', `$/tasks/${task.taskId}/actor/privileges`, `Privilege ${privilege} widens the proposed scope actor`);
  }
  // Dependency cycles.
  const byId = new Map(proposal.tasks.map(task => [task.taskId, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (taskId: string): void => {
    const current = state.get(taskId);
    if (current === 'done') return;
    if (current === 'visiting') { add('plan-dependency', `$/tasks/${taskId}/dependencies`, 'Task dependency graph contains a cycle'); return; }
    state.set(taskId, 'visiting');
    for (const dependency of byId.get(taskId)?.dependencies ?? []) if (byId.has(dependency)) visit(dependency);
    state.set(taskId, 'done');
  };
  for (const task of proposal.tasks) visit(task.taskId);

  const observationIds = new Set<string>();
  const taskById = new Map(proposal.tasks.map(task => [task.taskId, task]));
  for (const observation of proposal.observations) {
    if (observationIds.has(observation.observationId)) add('plan-duplicate-observation', `$/observations/${observation.observationId}`, 'Observation identities must be unique');
    observationIds.add(observation.observationId);
    const task = taskById.get(observation.taskId);
    if (!task) { add('plan-observation-task', `$/observations/${observation.observationId}/taskId`, `Unknown task ${observation.taskId}`); continue; }
    if (!request.allowedCapabilities.includes(observation.tool)) add('plan-observation-tool', `$/observations/${observation.observationId}/tool`, `Tool ${observation.tool} is not in allowedCapabilities`);
    bindingIssues(observation, task, request, add);
  }

  const cellIds = new Set<string>();
  const tasksWithCells = new Set<string>();
  for (const cell of proposal.coverage) {
    if (cellIds.has(cell.cellId)) add('plan-duplicate-cell', `$/coverage/${cell.cellId}`, 'Coverage cell identities must be unique');
    cellIds.add(cell.cellId);
    if (!taskById.has(cell.taskId)) add('plan-coverage-task', `$/coverage/${cell.cellId}/taskId`, `Unknown task ${cell.taskId}`);
    else tasksWithCells.add(cell.taskId);
    const task = taskById.get(cell.taskId);
    if (task && (cell.surfaceId !== task.surfaceId || cell.actorId !== task.actor.id || cell.question !== task.question.text)) {
      add('plan-coverage-cell', `$/coverage/${cell.cellId}`, 'Coverage cell must quote its task surface identity, actor and question');
    }
  }
  for (const task of proposal.tasks) if (!tasksWithCells.has(task.taskId)) add('plan-coverage-gap', `$/tasks/${task.taskId}`, 'Every task requires at least one planned coverage cell');

  if (proposal.threatModel) {
    let normalized: string | undefined;
    try { normalized = normalizeTargetKey(proposal.threatModel.targetKey); }
    catch { add('plan-threat-model', '$/threatModel/targetKey', 'Threat-model target key is not a normalizable target'); }
    if (normalized && proposal.threatModel.targetKey !== normalized) add('plan-threat-model', '$/threatModel/targetKey', 'Threat-model target key must already be normalized');
    if (proposal.threatModel.body.length > threatModelCapsDefaults.maxBodyChars) add('plan-threat-model-size', '$/threatModel/body', 'Threat-model draft exceeds its size cap');
    if (normalized && !request.targets.some(target => { try { return normalizeTargetKey(target.locator) === normalized; } catch { return false; } })) {
      add('plan-threat-model-target', '$/threatModel/targetKey', 'Threat-model draft must key one of the proposal targets');
    }
  }

  if (run) {
    const runCaps = { maxTasks: run.budgets.maxTasks, maxDepth: run.budgets.maxDepth, maxRequests: run.budgets.maxRequests };
    if (proposal.caps.maxTasks > runCaps.maxTasks || proposal.caps.maxDepth > runCaps.maxDepth || proposal.caps.maxRequests > runCaps.maxRequests) {
      add('plan-caps-wide', '$/caps', 'Declared caps exceed the admitted run budget');
    }
    const budgetFields = ['maxRequests', 'maxBytes', 'maxToolCalls', 'maxTokens', 'maxCostUsd', 'maxAttempts'] as const;
    for (const field of budgetFields) {
      if (request.budgets[field] > run.budgets[field]) add('plan-run-budget', `$/run/budgets/${field}`, `Plan budget ${field} exceeds the admitted run budget`);
    }
    if (request.budgets.maxTasks > run.budgets.maxTasks || request.budgets.maxDepth > run.budgets.maxDepth || request.budgets.maxConcurrency > run.budgets.maxConcurrency) {
      add('plan-run-budget', '$/run/budgets', 'Plan task/depth/concurrency budget exceeds the admitted run budget');
    }
    if (Date.parse(request.budgets.deadlineAt) > Date.parse(run.budgets.deadlineAt) - run.budgets.reportReserveMs) {
      add('plan-run-deadline', '$/run/budgets/deadlineAt', 'Plan deadline collides with the run deadline or its reporting reserve');
    }
    if (request.runId !== run.runId) add('plan-run-identity', '$/run/runId', 'Plan targets another run');
    if (request.scope.authorizationRef !== run.authorization.reference) add('plan-run-scope', '$/run/scope/authorizationRef', 'Plan scope references a different authorization');
    const approvedTargets = new Map(run.authorization.targets.map(target => [target.id, target]));
    for (const targetId of request.scope.targetIds) if (!approvedTargets.has(targetId)) add('plan-run-targets', '$/run/scope/targetIds', `Plan scope includes unapproved target ${targetId}`);
    const proposedTargets = new Set(request.targets.map(target => target.id));
    if (proposedTargets.size !== request.targets.length) add('plan-run-targets', '$/run/targets', 'Plan targets must be unique');
    for (const target of request.targets) {
      const approved = approvedTargets.get(target.id);
      if (!approved) { add('plan-run-targets', '$/run/targets', `Plan target ${target.id} is not approved by the run authorization`); continue; }
      if (approved.kind !== target.kind || approved.locator !== target.locator) add('plan-run-targets', `$/run/targets/${target.id}`, 'Plan target identity or locator differs from the approved target');
      if (!request.scope.targetIds.includes(target.id)) add('plan-run-targets', '$/run/targets', `Plan target ${target.id} is missing from the plan scope`);
    }
    for (const allowed of request.allowedCapabilities) if (!run.allowedCapabilities.includes(allowed)) add('plan-run-capabilities', '$/run/allowedCapabilities', `Capability ${allowed} is not granted to the run`);
    for (const action of request.allowedActions) if (!run.authorization.allowedActions.includes(action)) add('plan-run-actions', '$/run/allowedActions', `Action ${action} is not approved by the run authorization`);
  }
  return issues;
}

/** Pure batch-materialization gate: the exact proposal shape the owner approved, checked against an admitted run. */
export function assertPlanBatchMatchesProposal(proposal: PlanProposal, batchTaskIds: readonly Id[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const expected = proposal.tasks.map(task => task.taskId);
  const actual = [...batchTaskIds];
  if (expected.length !== actual.length) issues.push(planIssue('plan-batch-size', '$/tasks', 'Materialized task batch does not match the approved proposal task count'));
  for (const taskId of expected) if (!actual.includes(taskId)) issues.push(planIssue('plan-batch-task', '$/tasks', `Approved task ${taskId} is missing from the materialized batch`));
  for (const taskId of actual) if (!expected.includes(taskId)) issues.push(planIssue('plan-batch-task', '$/tasks', `Materialized task ${taskId} is not part of the approved proposal`));
  return issues;
}

const reportStateFor = (outcome: PlanCoverageOutcome | 'open'): CoverageRecord['state'] => {
  if (outcome === 'resolved') return 'tested';
  if (outcome === 'not_applicable') return 'not-applicable';
  if (outcome === 'blocked') return 'blocked';
  return 'untested';
};

/**
 * Coverage reconciliation gate. Every planned cell appears in the result; open / needs_follow_up cells block
 * finalization unless they are resolved or explicitly carried into the report as untested/blocked. Nothing
 * is silently dropped, and resolutions for unplanned cells are refused.
 */
export function reconcileCoverage(
  cells: readonly PlanCoverageCell[],
  resolutions: readonly PlanCoverageResolution[],
  options: { runId: Id },
): CoverageReconciliation {
  const issues: PlanIssue[] = [];
  const add = (code: string, path: string, message: string) => { if (issues.length < 100) issues.push(planIssue(code, path, message)); };
  const planned = new Map(cells.map(cell => [cell.cellId, cell]));
  const byCell = new Map<string, PlanCoverageResolution>();
  for (const resolution of resolutions) {
    if (!planned.has(resolution.cellId)) { add('coverage-unknown-cell', `$/resolutions/${resolution.cellId}`, 'Resolution targets a cell that was never planned'); continue; }
    if (resolution.runId !== options.runId) { add('coverage-foreign-run', `$/resolutions/${resolution.cellId}`, 'Resolution belongs to another run'); continue; }
    if (byCell.has(resolution.cellId)) { add('coverage-duplicate-resolution', `$/resolutions/${resolution.cellId}`, 'A cell may only have one accepted resolution'); continue; }
    byCell.set(resolution.cellId, resolution);
  }
  const reconciled: ReconciledCoverageCell[] = [];
  const resolved: Id[] = [];
  const carried: Id[] = [];
  const unresolved: Id[] = [];
  for (const cell of cells) {
    const resolution = byCell.get(cell.cellId);
    const outcome = resolution?.outcome ?? 'open';
    const carriedForward = resolution !== undefined && resolution.carried && (outcome === 'untested' || outcome === 'blocked');
    const closed = outcome === 'resolved' || outcome === 'not_applicable';
    if (!closed && !carriedForward) {
      unresolved.push(cell.cellId);
      add('coverage-unresolved-cell', `$/cells/${cell.cellId}`, `Coverage cell is ${outcome} and is neither resolved nor explicitly carried into the report`);
    } else if (closed) resolved.push(cell.cellId);
    else carried.push(cell.cellId);
    reconciled.push({
      ...cell,
      outcome,
      carried: carriedForward,
      reportState: reportStateFor(outcome),
      reason: resolution?.reason ?? 'Planned coverage cell has no resolution record',
      evidenceIds: resolution?.evidenceIds ?? [],
      ...(resolution ? { authorAttemptId: resolution.authorAttemptId, at: resolution.at } : {}),
    });
  }
  return {
    runId: options.runId,
    cells: reconciled,
    resolved,
    carried,
    unresolved,
    issues,
    canFinalize: unresolved.length === 0 && issues.length === 0,
    limitations: [
      'Coverage is bounded to the planned cell universe; an empty universe is not comprehensive coverage.',
      ...reconciled.filter(cell => cell.carried).map(cell => `Carried as ${cell.reportState}: ${cell.cellId} ${cell.surfaceId} — ${cell.reason}`),
    ],
  };
}
