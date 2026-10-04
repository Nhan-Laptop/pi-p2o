import type { Authorization, Scope, RunManifest, TaskManifest, ContractIssue, RequestedRuntime, ObservedRuntime } from './types.js';
import { authorizationSchema, scopeSchema, runSchema, taskSchema } from './schemas.js';
import { isTimestamp } from './validation.js';

export const contractIssue = (code: string, path: string, message: string, question: string): ContractIssue => ({ code, path, message, question });
export function validateScope(scope: Scope, authorization: Authorization, now: string, actions: readonly string[] = []): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const add = (code: string, path: string, message: string, question: string) => issues.push(contractIssue(code, path, message, question));
  for (const [name, parsed] of [['scope', scopeSchema.safeParse(scope)], ['authorization', authorizationSchema.safeParse(authorization)]] as const) {
    if (!parsed.success) for (const i of parsed.issues) add(`invalid-${name}`, i.path, i.message, `Supply valid ${name} and exact authorized identities.`);
  }
  if (issues.length) return issues;
  if (!isTimestamp(now) || Date.parse(now) < Date.parse(authorization.validFrom) || Date.parse(now) >= Date.parse(authorization.expiresAt)) add('authorization-expired', '$/scope/authorizationRef', 'Authorization is not currently valid', 'Obtain a current owner-approved authorization reference.');
  if (scope.authorizationRef !== authorization.reference) add('authorization-reference', '$/scope/authorizationRef', 'Authorization reference does not match', 'Which owner-approved authorization covers this task?');
  const targets = new Map(authorization.targets.map(t => [t.id, t]));
  for (const targetId of scope.targetIds) {
    const t = targets.get(targetId);
    if (!t || authorization.exclusions.includes(targetId)) { add('unauthorized-target', '$/scope/targetIds', 'Scope includes an unapproved target', 'Restrict the question to explicitly approved target identities.'); continue; }
    if (t.kind === 'artifact') {
      const input = scope.inputs.find(a => a.id === t.id);
      if (!input || input.digest !== t.digest || input.revision !== t.revision || input.locator !== t.locator) add('artifact-identity', '$/scope/inputs', 'Artifact provenance differs from the approved input', 'Supply the approved artifact hash, revision and locator.');
    }
  }
  for (const action of actions) if (!authorization.allowedActions.includes(action)) add('unauthorized-action', '$/allowedActions', 'Requested action is not approved', 'Remove the action or request explicit owner approval.');
  return issues;
}
export function validateTaskScope(task: TaskManifest, run: RunManifest, now: string): ContractIssue[] {
  const invalid: ContractIssue[] = [];
  for (const [name, parsed] of [['task', taskSchema.safeParse(task)], ['run', runSchema.safeParse(run)]] as const) {
    if (!parsed.success) for (const i of parsed.issues) invalid.push(contractIssue(`invalid-${name}`, i.path, i.message, `Supply a valid ${name} manifest.`));
  }
  if (invalid.length) return invalid;
  const issues = validateScope(task.scope, run.authorization, now, task.allowedActions);
  const add = (code: string, path: string, message: string, question: string) => issues.push(contractIssue(code, path, message, question));
  if (task.runId !== run.runId) add('run-identity', '$/runId', 'Task belongs to another run', 'Use the active run identity.');
  for (const capability of task.requiredCapabilities) if (!run.allowedCapabilities.includes(capability)) add('unauthorized-capability', '$/requiredCapabilities', 'Capability was not granted', 'Request an explicit capability grant or narrow the task.');
  for (const key of ['maxRequests', 'maxBytes', 'maxToolCalls', 'maxTokens', 'maxCostUsd', 'maxAttempts'] as const) if (task.budgets[key] > run.budgets[key]) add('budget-exceeds-run', `$/budgets/${key}`, 'Task budget exceeds run allowance', 'Reduce the task budget to the approved run limit.');
  const deadline = Date.parse(task.budgets.deadlineAt);
  if (deadline > Date.parse(run.budgets.deadlineAt) - run.budgets.reportReserveMs || deadline <= Date.parse(now)) add('task-deadline', '$/budgets/deadlineAt', 'Task deadline is expired or consumes reporting reserve', 'Choose a live deadline within the absolute run deadline and reserve.');
  if (task.depth > run.budgets.maxDepth) add('task-depth', '$/depth', 'Task exceeds graph depth', 'Use the approved task graph depth.');
  return issues;
}
export interface RuntimeComparison {
  matches: boolean;
  verification: ObservedRuntime['attestation'];
  discrepancies: string[];
}
export function compareRuntime(requested: RequestedRuntime, observed: ObservedRuntime): RuntimeComparison {
  const discrepancies: string[] = [];
  if (requested.adapter !== observed.adapter) discrepancies.push('adapter');
  if (!observed.selection) discrepancies.push('selection-unavailable');
  else for (const key of ['provider', 'model', 'thinking'] as const) if (requested.selection[key] !== observed.selection[key]) discrepancies.push(key);
  for (const capability of requested.requiredCapabilities) if (!observed.capabilities[capability]) discrepancies.push(`capability:${capability}`);
  return { matches: discrepancies.length === 0, verification: observed.attestation, discrepancies };
}
