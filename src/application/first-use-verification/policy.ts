import { createPolicy } from '../../policy/scope.js';
import type { Scope, ToolContext } from '../../policy/types.js';
import { runSchema, type RunManifest } from '../../contracts/index.js';
import type { HttpInput } from '../../tools/types.js';

/** In-process controller capability, never a worker-authored JSON grant. Transport remains the normal broker. */
export interface ScopedVerificationPolicy {
  readonly runId: string;
  readonly scopeDigest: string;
  assertRequest(context: ToolContext, targetId: string, input: HttpInput): void;
  assertVerifier(context: ToolContext): void;
}
const issued = new WeakSet<object>();
export function assertScopedVerificationPolicy(policy: ScopedVerificationPolicy): void {
  if (!policy || !issued.has(policy)) throw new Error('controller-authorized verification policy required');
}

/** Call only from controller approval code using the actual broker scope and the approved run. */
export function createScopedVerificationPolicy(run: RunManifest, scope: Scope, now: () => number = Date.now): ScopedVerificationPolicy {
  const brokerPolicy = createPolicy(scope, { now });
  // Snapshot run authority too; caller mutation cannot expand an issued capability.
  const authority = runSchema.parse(structuredClone(run));
  if (scope.runId !== authority.runId || scope.authorization.reference !== authority.authorization.reference
    || Date.parse(scope.authorization.expiresAt) > Date.parse(authority.authorization.expiresAt)) throw new Error('verification scope differs from approved run');
  let highWater = -Infinity;
  const policy: ScopedVerificationPolicy = Object.freeze({
    runId: authority.runId,
    scopeDigest: brokerPolicy.digest,
    assertVerifier(context: ToolContext) {
      if (brokerPolicy.assertActive(context).role !== 'verifier') throw new Error('replay requires the verifier-role broker grant');
    },
    assertRequest(context: ToolContext, targetId: string, input: HttpInput) {
      const observedTime = now();
      if (!Number.isFinite(observedTime)) throw new Error('verification clock unavailable');
      const time = highWater = Math.max(highWater, observedTime);
      if (!Number.isFinite(time) || time < Date.parse(authority.authorization.validFrom)
        || time >= Math.min(Date.parse(authority.authorization.expiresAt), Date.parse(authority.budgets.deadlineAt))) throw new Error('verification run expired or inactive');
      const method = input.method ?? 'GET';
      if (!['GET', 'HEAD'].includes(method) || (input.action ?? 'read') !== 'read'
        || input.body !== undefined || input.headers !== undefined || (input.maxRedirects ?? 0) !== 0) throw new Error('verification permits only approved fixed read-only requests without headers/body/redirects');
      if (!authority.authorization.allowedActions.includes('read') || !authority.allowedCapabilities.includes('http.request')) throw new Error('run has no HTTP read authority');
      const target = authority.authorization.targets.find(t => t.id === targetId);
      if (!target || authority.authorization.exclusions.includes(targetId) || !['web', 'lab'].includes(target.kind)) throw new Error('unapproved verification target');
      const url = new URL(input.url), approved = new URL(target.locator);
      const prefix = approved.pathname.replace(/\/+$/u, '');
      if (url.origin !== approved.origin || (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) throw new Error('verification URL leaves approved run target');
      const decision = brokerPolicy.authorize({ context, capability: 'http.request', action: 'read', url: input.url, method, accountId: input.accountId });
      if (decision.target?.id !== targetId || decision.grant.role === 'reporter' || decision.grant.role === 'orchestrator') throw new Error('verification target/grant mismatch');
      if (decision.grant.maxCalls < 3 || decision.target.limits.maxRequests < 3 || authority.budgets.maxRequests < 3
        || authority.budgets.maxToolCalls < 3 || (authority.budgets.targetRequestLimits[targetId] ?? 0) < 3
        || decision.grant.maxArtifactBytes < 1 || decision.target.limits.maxBytes < 1) throw new Error('verification caps cannot accommodate bounded replay');
      // No DNS resolution, TLS bypass or credentials here: broker rechecks policy and pinned transport per request.
    },
  });
  issued.add(policy);
  return policy;
}
