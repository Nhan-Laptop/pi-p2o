import type { RunManifest, TaskManifest } from '../../src/contracts/index.js';
import type { Scope, ToolContext } from '../../src/policy/types.js';
import { createScopedVerificationPolicy } from '../../src/application/first-use-verification/policy.js';

/** PURE controller policy fixture, not transport/sandbox/TLS qualification or a live assessment.
 * Authority comes from the test's explicitly approved run and exact durable verifier identity.
 * No casts or worker-authored policy objects: this invokes the production capability issuer.
 */
export function scopedReplayPolicyFixture(input: {
  run: RunManifest;
  task: TaskManifest;
  attempt: { runId: string; taskId: string; attemptId: string };
  targetId: string;
  accountId: string;
  grantId: string;
  now: () => number;
}) {
  const { run, task, attempt, targetId, accountId, grantId, now } = input;
  const target = run.authorization.targets.find(t => t.id === targetId);
  if (!target || !['web', 'lab'].includes(target.kind)) throw new Error('fixture must explicitly approve the replay target');
  if (task.runId !== run.runId || attempt.runId !== run.runId || attempt.taskId !== task.taskId
    || !task.scope.targetIds.includes(targetId) || task.scope.authorizationRef !== run.authorization.reference) throw new Error('fixture verifier identity/scope must match explicit run approval');
  const url = new URL(target.locator);
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('pure replay response fixture approval must name its controlled loopback-shaped origin');
  const context: ToolContext = { runId: run.runId, taskId: task.taskId, attemptId: attempt.attemptId, grantId };
  const scope: Scope = {
    version: 1, runId: run.runId,
    authorization: { reference: run.authorization.reference, approvedBy: run.authorization.authorizedBy, notBefore: run.authorization.validFrom, expiresAt: run.authorization.expiresAt },
    targets: [{ id: targetId, origins: [url.origin], pathPrefixes: [url.pathname], allowedCidrs: ['127.0.0.1/32', '::1/128'],
      methods: ['GET', 'HEAD'], actions: ['read'], accounts: [accountId], limits: { maxRequests: run.budgets.targetRequestLimits[targetId] ?? 0,
        maxBytes: Math.min(run.budgets.maxBytes, task.budgets.maxBytes), maxConcurrent: 1, rate: { requests: 3, windowMs: 1000 } } }],
    exclusions: [],
    accounts: [{ id: accountId, kind: 'anonymous', targetIds: [targetId], actions: ['read'], expiresAt: run.authorization.expiresAt }],
    grants: [{ id: grantId, taskId: task.taskId, attemptId: attempt.attemptId, role: 'verifier', capabilities: ['http.request'], targetIds: [targetId],
      actions: ['read'], accountIds: [accountId], expiresAt: task.budgets.deadlineAt, maxCalls: task.budgets.maxToolCalls, maxArtifactBytes: task.budgets.maxBytes }],
  };
  return { context, scope, policy: createScopedVerificationPolicy(run, scope, now) };
}
