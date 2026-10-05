import { isAbsolute } from 'node:path';
import { canonicalJson, digestJson, ID_PATTERN, isTimestamp, runSchema, taskSchema, requestedRuntimeSchema, thinkingLevels, validateTaskScope, type Budget, type Question, type RuntimeSelection, type RunManifest, type TaskManifest } from '../contracts/index.js';
import { CAPABILITIES } from '../policy/index.js';
import type { ToolPolicy } from '../runtime/types.js';
import type { Approval, ModelSwitchApproval, ModelSwitchProposal, RunAdmission, TaskProposal, TaskApproval, Role } from './types.js';

export class SupervisorError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SupervisorError'; }
}
export function assert(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new SupervisorError(code, message);
}
export function json<T>(value: unknown): T { return JSON.parse(canonicalJson(value)) as T; }
export function immutable<T>(value: T): Readonly<T> {
  const copy = json<T>(value);
  const freeze = (v: unknown): void => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(copy); return copy;
}
export function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const v = json<unknown>(value);
  assert(v && typeof v === 'object' && !Array.isArray(v), 'invalid-input', `${label} must be an object`);
  assert(Object.keys(v).every(k => keys.includes(k)), 'invalid-input', `Unknown ${label} field`);
  return v as Record<string, unknown>;
}
export function identifier(v: unknown, label: string): string {
  assert(typeof v === 'string' && ID_PATTERN.test(v), 'invalid-input', `Invalid ${label}`); return v;
}
export function text(v: unknown, label: string, max = 4096): string {
  assert(typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v), 'invalid-input', `Invalid ${label}`); return v;
}
export function list(v: unknown, label: string, max = 128): string[] {
  assert(Array.isArray(v) && v.length <= max, 'invalid-input', `Invalid ${label}`);
  const out = v.map(x => text(x, label, 256));
  assert(new Set(out).size === out.length, 'invalid-input', `Duplicate ${label}`); return out;
}
/** Policy tool capability names: the only labels that can bind a broker tool adapter. */
export const TOOL_CAPABILITIES: ReadonlySet<string> = new Set(CAPABILITIES);
/** Control-plane capability labels per role; target-tool capabilities are gated separately. */
export const ROLE_PROFILES: Readonly<Record<Role, readonly string[]>> = Object.freeze({
  orchestrator: Object.freeze(['tasks.propose', 'accepted.read', 'review.request']),
  worker: Object.freeze([]),
  verifier: Object.freeze([]),
  reporter: Object.freeze(['accepted.read', 'report.render']),
});
export function parseRun(value: unknown, now: number): RunAdmission {
  const o = object(value, ['manifest', 'mode', 'perTargetConcurrency'], 'run proposal');
  const manifest = runSchema.parse(o.manifest);
  assert(manifest.state === 'created' || manifest.state === 'active', 'run-state', 'New run must be created or active');
  assert(o.mode === 'managed' || o.mode === 'plan', 'invalid-input', 'Explicit managed or plan mode required');
  const keys = manifest.authorization.targets.map(t => t.id);
  const limits = object(o.perTargetConcurrency, keys, 'per-target limits');
  assert(Object.keys(limits).length === keys.length, 'target-concurrency', 'Supply exactly every target concurrency limit');
  for (const key of keys) assert(Number.isSafeInteger(limits[key]) && (limits[key] as number) >= 1 && (limits[key] as number) <= manifest.budgets.maxConcurrency, 'target-concurrency', 'Target concurrency must be bounded by global concurrency');
  assert(now >= Date.parse(manifest.authorization.validFrom) && now < Date.parse(manifest.authorization.expiresAt), 'authorization-expired', 'Owner authorization is not current');
  assert(now < Date.parse(manifest.budgets.deadlineAt) - manifest.budgets.reportReserveMs, 'deadline', 'No execution budget remains outside reporting reserve');
  requestedRuntimeSchema.parse(manifest.requestedRuntime);
  return { manifest, mode: o.mode, perTargetConcurrency: limits as Record<string, number> };
}
export function parseTask(value: unknown, run: RunManifest, now: number): TaskProposal {
  const o = object(value, ['manifest', 'role', 'exclusiveKeys'], 'task proposal');
  const manifest = taskSchema.parse(o.manifest);
  assert(typeof o.role === 'string' && Object.hasOwn(ROLE_PROFILES, o.role), 'role', 'Explicit supported role required');
  const role = o.role as Role;
  assert(manifest.lifecycleState === 'queued' && manifest.packetState === 'draft', 'task-state', 'New tasks must be queued drafts');
  assert(!validateTaskScope(manifest, run, new Date(now).toISOString()).length, 'scope-rejected', 'Task scope, deadline, capability, depth or budget exceeds admission');
  assert(Date.parse(manifest.budgets.deadlineAt) <= Date.parse(run.authorization.expiresAt), 'deadline', 'A task cannot outlive authorization');
  if (role === 'orchestrator' || role === 'reporter') {
    assert(!manifest.requiredCapabilities.some(capability => TOOL_CAPABILITIES.has(capability)), 'role-escalation', 'Control/report roles cannot receive target-tool capabilities');
  }
  assert(manifest.question.ifTrue !== manifest.question.ifFalse, 'question', 'Question requires contrasting predictions');
  const exclusiveKeys = list(o.exclusiveKeys ?? [], 'exclusive keys');
  assert(!manifest.allowedActions.includes('mutate') || exclusiveKeys.length > 0, 'serialization-required', 'State-changing tasks require owner-approved account/fixture serialization keys');
  return { manifest, role, exclusiveKeys };
}
export function validateApproval(approval: Approval, value: unknown, run: RunManifest, now: number, deadlineAt: number): void {
  const a = json<Approval>(approval);
  assert(a.allowed === true && a.digest === digestJson(value), 'permission-denied', 'Owner did not approve the exact proposal');
  assert(a.authorizationRef === run.authorization.reference && a.approvedBy === run.authorization.authorizedBy, 'permission-denied', 'Owner approval does not match authorization provenance');
  text(a.reference, 'approval reference');
  assert(isTimestamp(a.expiresAt) && Date.parse(a.expiresAt) > now && Date.parse(a.expiresAt) <= Date.parse(run.authorization.expiresAt) && Date.parse(a.expiresAt) >= deadlineAt, 'permission-expired', 'Approval must cover, but cannot extend, the original execution budget');
}
/** Owner approval for one model switch: bound to the exact attempt, selections, reason and execution window. */
export function validateModelSwitchApproval(value: unknown, proposal: ModelSwitchProposal, run: RunManifest, now: number): ModelSwitchApproval {
  const a = json<ModelSwitchApproval>(value);
  assert(a.allowed === true && a.digest === digestJson(proposal), 'permission-denied', 'Owner did not approve the exact model switch');
  assert(a.authorizationRef === run.authorization.reference && a.approvedBy === run.authorization.authorizedBy, 'permission-denied', 'Switch approval does not match authorization provenance');
  assert(a.attemptId === proposal.attemptId, 'permission-denied', 'Switch approval is bound to a different attempt');
  text(a.reference, 'switch approval reference');
  assert(isTimestamp(a.expiresAt) && Date.parse(a.expiresAt) > now && Date.parse(a.expiresAt) <= Date.parse(run.authorization.expiresAt) && Date.parse(a.expiresAt) >= proposal.deadlineAt, 'permission-expired', 'Switch approval must cover, but cannot extend, the execution window');
  return a;
}
export function validateTools(value: unknown, task: TaskManifest, role: Role): ToolPolicy {
  const o = object(value, ['mode', 'allowUnsandboxedHostTools', 'tools', 'extension', 'boundaryId'], 'tool policy');
  const tools = list(o.tools, 'tools');
  // Removing unrestricted host tools is mandatory, including fixtures. No aliases/fallback.
  const builtins = new Set(['bash', 'read', 'write', 'edit', 'find', 'grep', 'ls', 'exec', 'shell', 'terminal']);
  assert(!tools.some(t => builtins.has(t.toLowerCase())), 'host-tools-denied', 'Unrestricted host execution/filesystem tools are forbidden');
  if (o.mode === 'trusted-fixture') {
    assert(o.allowUnsandboxedHostTools === true && tools.length === 0 && !o.extension && !o.boundaryId, 'host-tools-denied', 'Trusted inert fixture mode permits no host tools');
    return { mode: 'trusted-fixture', allowUnsandboxedHostTools: true, tools: [] };
  }
  assert(o.mode === 'sandbox-extension' && o.allowUnsandboxedHostTools === undefined, 'tool-policy', 'A pinned sandbox-bound extension is required');
  const e = object(o.extension, ['path', 'sha256', 'approval'], 'extension');
  const entry = text(e.path, 'extension path');
  assert(isAbsolute(entry) && /^[a-f0-9]{64}$/.test(String(e.sha256)), 'tool-policy', 'Extension requires an absolute path and SHA-256');
  assert((role === 'worker' || role === 'verifier') || tools.length === 0, 'role-escalation', 'Control/report runtimes cannot execute target tools');
  assert(task.requiredCapabilities.length === 0 || tools.length > 0 || role === 'reporter' || role === 'orchestrator', 'tool-policy', 'Execution tasks require explicit sandbox tools');
  return { mode: 'sandbox-extension', boundaryId: text(o.boundaryId, 'boundary identity'), extension: { path: entry, sha256: String(e.sha256), approval: text(e.approval, 'extension approval') }, tools };
}
export function taskApproval(value: TaskApproval, proposal: TaskProposal, run: RunManifest, now: number): TaskApproval {
  validateApproval(value, proposal, run, now, Date.parse(proposal.manifest.budgets.deadlineAt));
  const approval = json<TaskApproval>(value);
  approval.toolPolicy = validateTools(approval.toolPolicy, proposal.manifest, proposal.role);
  text(approval.boundaryReceipt, 'boundary receipt'); return approval;
}
export function fingerprints(task: TaskManifest, run: RunManifest, role: Role): { scopeDigest: string; inputDigest: string } {
  return {
    scopeDigest: digestJson({ authorization: run.authorization, scope: task.scope, actions: task.allowedActions, capabilities: task.requiredCapabilities, role }),
    inputDigest: digestJson({ revision: task.inputRevision, inputs: task.scope.inputs, environment: task.scope.environmentId, configuration: task.scope.configurationDigest }),
  };
}
export function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code.slice(0, 128) : 'adapter-error';
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown failure';
}

/** Bounded single-value prose: same control-character and length rules as the contract schemas. */
export function prose(v: unknown, label: string, max = 4096): string {
  assert(typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v), 'invalid-input', `Invalid ${label}`);
  return v;
}
/** One explicit runtime selection, shared by replacement and model switching. */
export function selectionOf(value: unknown, label = 'runtime selection'): RuntimeSelection {
  const raw = object(value, ['provider', 'model', 'thinking'], label);
  const provider = text(raw.provider, 'provider', 128);
  const model = text(raw.model, 'model', 256);
  const thinking = raw.thinking;
  assert(typeof thinking === 'string' && thinkingLevels.includes(thinking as RuntimeSelection['thinking']), 'invalid-input', 'An explicit supported thinking level is required');
  return { provider, model, thinking: thinking as RuntimeSelection['thinking'] };
}
export function thinkingRank(level: RuntimeSelection['thinking']): number { return thinkingLevels.indexOf(level); }
/**
 * Deterministic model-switch profile: provider and thinking ceiling come from the admitted run; allowed model
 * identities are the run model plus every model already approved by a durable switch decision for this run.
 */
export function modelProfile(run: RunManifest, approvedModels: readonly string[]): { adapter: string; providers: string[]; models: string[]; thinkingCeiling: RuntimeSelection['thinking']; requiredCapabilities: string[] } {
  const models = [...new Set([run.requestedRuntime.selection.model, ...approvedModels])].sort();
  return {
    adapter: run.requestedRuntime.adapter,
    providers: [run.requestedRuntime.selection.provider],
    models,
    thinkingCeiling: run.requestedRuntime.selection.thinking,
    requiredCapabilities: [...run.requestedRuntime.requiredCapabilities].sort(),
  };
}

export interface SubtaskRequestValue {
  question: Question;
  targetIds: string[];
  actor: { id: string; privileges: string[] };
  inputRevision: string;
  role: 'worker' | 'verifier';
  reason: string;
  budgets?: Partial<Budget>;
  skills?: string[];
  allowedActions?: string[];
  requiredCapabilities?: string[];
  dependencyTaskIds?: string[];
}
export interface NarrowingReason { code: string; path: string; message: string }
const BUDGET_FIELDS = ['deadlineAt', 'maxRequests', 'maxBytes', 'maxToolCalls', 'maxTokens', 'maxCostUsd', 'maxAttempts'] as const;

/** Bounded, strict parse of a worker-submitted discovery request. Unknown fields are refused, never ignored. */
export function parseSubtaskRequest(value: unknown): SubtaskRequestValue {
  const o = object(value, ['question', 'targetIds', 'actor', 'inputRevision', 'role', 'reason', 'budgets', 'skills', 'allowedActions', 'requiredCapabilities', 'dependencyTaskIds'], 'subtask request');
  const q = object(o.question, ['text', 'ifTrue', 'ifFalse'], 'subtask question');
  const question: Question = { text: prose(q.text, 'question text'), ifTrue: prose(q.ifTrue, 'ifTrue'), ifFalse: prose(q.ifFalse, 'ifFalse') };
  assert(question.ifTrue !== question.ifFalse, 'invalid-input', 'A discovery question requires contrasting predictions');
  const actor = object(o.actor, ['id', 'privileges'], 'subtask actor');
  assert(o.role === 'worker' || o.role === 'verifier', 'role', 'A discovered subtask may only be requested for a worker or verifier role');
  const result: SubtaskRequestValue = {
    question,
    targetIds: list(o.targetIds, 'targetIds'),
    actor: { id: identifier(actor.id, 'actor id'), privileges: list(actor.privileges ?? [], 'actor privileges') },
    inputRevision: prose(o.inputRevision, 'input revision', 256),
    role: o.role,
    reason: prose(o.reason, 'reason'),
  };
  if (o.budgets !== undefined) {
    const raw = object(o.budgets, BUDGET_FIELDS, 'subtask budget');
    const budgets: Partial<Budget> = {};
    for (const field of BUDGET_FIELDS) {
      const entry = raw[field];
      if (entry === undefined) continue;
      if (field === 'deadlineAt') {
        assert(typeof entry === 'string' && isTimestamp(entry), 'invalid-input', 'Subtask deadline must be a real UTC timestamp');
        budgets.deadlineAt = entry as string;
      } else {
        assert(typeof entry === 'number' && Number.isFinite(entry) && entry >= 0, 'invalid-input', `Invalid subtask ${field}`);
        budgets[field] = entry as number;
      }
    }
    result.budgets = budgets;
  }
  if (o.skills !== undefined) result.skills = list(o.skills, 'skills');
  if (o.allowedActions !== undefined) result.allowedActions = list(o.allowedActions, 'allowed actions');
  if (o.requiredCapabilities !== undefined) result.requiredCapabilities = list(o.requiredCapabilities, 'required capabilities');
  if (o.dependencyTaskIds !== undefined) result.dependencyTaskIds = list(o.dependencyTaskIds, 'dependency tasks');
  return result;
}
/** Narrowing budgets only: every supplied field must be at or below the parent's approved value. */
export function subtaskBudgets(request: SubtaskRequestValue, parent: TaskManifest): Budget {
  const budgets: Budget = { ...parent.budgets };
  const supplied = request.budgets;
  if (!supplied) return budgets;
  const deadline = supplied.deadlineAt;
  if (deadline !== undefined) budgets.deadlineAt = Date.parse(deadline) <= Date.parse(parent.budgets.deadlineAt) ? deadline : parent.budgets.deadlineAt;
  budgets.maxRequests = Math.min(supplied.maxRequests ?? parent.budgets.maxRequests, parent.budgets.maxRequests);
  budgets.maxBytes = Math.min(supplied.maxBytes ?? parent.budgets.maxBytes, parent.budgets.maxBytes);
  budgets.maxToolCalls = Math.min(supplied.maxToolCalls ?? parent.budgets.maxToolCalls, parent.budgets.maxToolCalls);
  budgets.maxTokens = parent.budgets.maxTokens === null ? null : Math.min(supplied.maxTokens ?? parent.budgets.maxTokens, parent.budgets.maxTokens);
  budgets.maxCostUsd = parent.budgets.maxCostUsd === null ? null : Math.min(supplied.maxCostUsd ?? parent.budgets.maxCostUsd, parent.budgets.maxCostUsd);
  budgets.maxAttempts = Math.min(supplied.maxAttempts ?? parent.budgets.maxAttempts, parent.budgets.maxAttempts);
  return budgets;
}
/**
 * A discovered subtask may only narrow its parent: same authorization/actor/environment/inputs, a subset of
 * targets, actions, capabilities, skills and dependencies, and no larger budget. Widening is an explicit reason.
 */
export function subtaskNarrowing(parent: TaskManifest, child: TaskManifest, request: SubtaskRequestValue): NarrowingReason[] {
  const reasons: NarrowingReason[] = [];
  const add = (code: string, path: string, message: string) => reasons.push({ code, path, message });
  const subset = (values: readonly string[], allowed: readonly string[]) => values.every(value => allowed.includes(value));
  if (child.depth !== parent.depth + 1) add('task-depth', '$/depth', 'A discovered subtask must be exactly one level below its parent');
  if (!subset(child.scope.targetIds, parent.scope.targetIds) || !child.scope.targetIds.length) add('targets', '$/scope/targetIds', 'Subtask targets must be a non-empty subset of the parent target set');
  if (child.scope.authorizationRef !== parent.scope.authorizationRef) add('authorization', '$/scope/authorizationRef', 'Subtask must keep the parent authorization reference');
  if (child.scope.actor.id !== parent.scope.actor.id || !subset(child.scope.actor.privileges, parent.scope.actor.privileges)) add('actor', '$/scope/actor', 'Subtask actor identity and privileges must narrow the parent actor');
  for (const key of ['boundary', 'isolation', 'recovery', 'environmentId', 'configurationDigest'] as const) {
    if (child.scope[key] !== parent.scope[key]) add('boundary', `$/scope/${key}`, 'Subtask must inherit the parent boundary, isolation, recovery and environment identity');
  }
  if (canonicalJson(child.scope.inputs) !== canonicalJson(parent.scope.inputs)) add('inputs', '$/scope/inputs', 'Subtask must inherit the parent approved inputs exactly');
  if (child.inputRevision !== parent.inputRevision || request.inputRevision !== parent.inputRevision) add('input-revision', '$/inputRevision', 'Subtask must be requested against the parent input revision');
  if (!subset(child.allowedActions, parent.allowedActions)) add('actions', '$/allowedActions', 'Subtask actions must be a subset of the parent actions');
  if (!subset(child.requiredCapabilities, parent.requiredCapabilities)) add('capabilities', '$/requiredCapabilities', 'Subtask capabilities must be a subset of the parent capabilities');
  if (!subset(child.skills, parent.skills)) add('skills', '$/skills', 'Subtask skills must be a subset of the parent skills');
  if (!subset(child.dependencyTaskIds, [...parent.dependencyTaskIds, parent.taskId])) add('dependencies', '$/dependencyTaskIds', 'Subtask dependencies must come from the parent dependency set');
  // A budget over-request is refused, never silently granted: the child budget is clamped only as defence in depth.
  const requested = request.budgets;
  if (requested) {
    const deadline = requested.deadlineAt;
    if (deadline !== undefined && Date.parse(deadline) > Date.parse(parent.budgets.deadlineAt)) add('budget', '$/budgets/deadlineAt', 'Subtask deadline may not outlive the parent deadline');
    const over = (field: 'maxRequests' | 'maxBytes' | 'maxToolCalls' | 'maxTokens' | 'maxCostUsd' | 'maxAttempts', value: number | null | undefined) => {
      if (value !== undefined && value !== null && parent.budgets[field] !== null && value > parent.budgets[field]!) add('budget', `$/budgets/${field}`, 'Subtask budget may not exceed the parent budget');
    };
    over('maxRequests', requested.maxRequests);
    over('maxBytes', requested.maxBytes);
    over('maxToolCalls', requested.maxToolCalls);
    over('maxTokens', requested.maxTokens);
    over('maxCostUsd', requested.maxCostUsd);
    over('maxAttempts', requested.maxAttempts);
  }
  if (Date.parse(child.budgets.deadlineAt) > Date.parse(parent.budgets.deadlineAt)) add('budget', '$/budgets/deadlineAt', 'Subtask deadline may not outlive the parent deadline');
  return reasons;
}
