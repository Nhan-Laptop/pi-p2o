import { describe, it, expect } from 'vitest';
import { digestJson } from '../../src/contracts/index.js';
import type { ObservationCheck } from '../../src/application/types.js';
import { createScopedVerificationPolicy, synthesizeFirstUseVerification } from '../../src/application/first-use-verification/index.js';
import { createHarness, findingFixture, CLAIM, NOW } from '../evidence/fixtures.js';
import type { Scope } from '../../src/policy/types.js';

// Controller-receipt fixtures only. External-shaped .test URLs are NOT live third-party scans.
export function setup(origin = 'https://approved.test') {
  const h = createHarness();
  const targetId = 'fixture';
  h.run.authorization.targets = [{ id: targetId, kind: 'web', locator: `${origin}/lab` }];
  h.run.allowedCapabilities = ['http.request'];
  Object.assign(h.run.budgets, { maxRequests: 20, maxToolCalls: 20, targetRequestLimits: { fixture: 20 } });
  h.task.scope.targetIds = [targetId];
  h.task.allowedActions = ['read'];
  const context = { runId: h.run.runId, taskId: h.task.taskId, attemptId: h.attempt.attemptId, grantId: 'producer-grant' };
  const scope: Scope = {
    version: 1, runId: h.run.runId,
    authorization: { reference: h.run.authorization.reference, approvedBy: 'owner', expiresAt: h.run.authorization.expiresAt },
    targets: [{ id: targetId, origins: [origin], pathPrefixes: ['/lab'], allowedCidrs: ['127.0.0.0/8'], methods: ['GET', 'HEAD'], actions: ['read'], accounts: ['anonymous'], limits: { maxRequests: 20, maxBytes: 1048576, maxConcurrent: 1, rate: { requests: 20, windowMs: 1000 } } }],
    exclusions: [{ origin, pathPrefixes: ['/lab/excluded'] }],
    accounts: [{ id: 'anonymous', kind: 'anonymous', targetIds: [targetId], actions: ['read'], expiresAt: h.run.authorization.expiresAt }],
    grants: [{ id: context.grantId, taskId: context.taskId, attemptId: context.attemptId, role: 'worker', targetIds: [targetId], actions: ['read'], capabilities: ['http.request'], accountIds: ['anonymous'], expiresAt: h.run.authorization.expiresAt, maxCalls: 20, maxArtifactBytes: 1048576 }],
  };
  const verificationPolicy = createScopedVerificationPolicy(h.run, scope, () => Date.parse(NOW));
  const checks: ObservationCheck[] = ['observation', 'negative-control', 'reproduction'].map((kind, i) => ({
    checkId: `check-${i}`, observationId: `obs-${i}`, taskId: h.task.taskId, tool: 'http.request',
    input: { url: `${origin}/lab/${i}`, method: 'GET', accountId: 'anonymous', action: 'read' },
    kind: kind as ObservationCheck['kind'], classification: 'independently-observed', summary: `${kind} fixture`,
    expectation: { type: 'http', status: i === 1 ? 403 : 200, bodyIncludes: i === 1 ? 'denied' : i === 2 ? 'foreign' : 'own' },
  }));
  checks.forEach((check, i) => h.collect(['baseline', 'negative', 'repro'][i]!, check.kind, {
    operationInputDigest: digestJson(check.input), metadata: { claimDigest: digestJson(CLAIM), observationId: check.observationId },
  }, { scopeDigest: verificationPolicy.scopeDigest }, JSON.stringify({ kind: 'http', status: i === 1 ? 403 : 200, body: i === 1 ? 'denied' : i === 2 ? 'foreign' : 'own' })));
  const candidate = { finding: findingFixture(h), baselineEvidenceIds: ['baseline'], requiresTargetReset: false };
  const input = { run: h.run, producerTask: h.task, targetId, targetLocator: `${origin}/lab`, checks,
    workspaceRoot: h.worker, verifierBudget: { maxRequests: 4, maxToolCalls: 4, maxTokens: 8192, maxCostUsd: 0 }, now: NOW,
    candidate, vault: h.vault, verificationPolicy, policyContext: context };
  return { h, input, scope, context };
}

describe('evidence-bound scoped synthesis', () => {
  for (const origin of ['http://127.0.0.1:8123', 'https://approved.test']) it(`supports explicitly approved anonymous scope ${origin}`, () => {
    const s = setup(origin);
    try {
      const result = synthesizeFirstUseVerification(s.input);
      expect(result.supported, JSON.stringify(result)).toBe(true);
      if (!result.supported) return;
      expect(result.leg.finding.claim).toBe(CLAIM);
      expect(result.leg.finding.claim).not.toBe(s.h.task.question.text);
      expect(result.leg.verification.recipe.probe.input.url).toBe(`${origin}/lab/2`);
      expect(result.leg.verifierTask.scope.environmentId).not.toBe(s.h.task.scope.environmentId);
    } finally { s.h.dispose(); }
  });
  it.each(['candidate', 'vault', 'verificationPolicy', 'policyContext'] as const)('refuses missing %s', key => {
    const s = setup();
    try { expect(synthesizeFirstUseVerification({ ...s.input, [key]: undefined }).supported).toBe(false); }
    finally { s.h.dispose(); }
  });
  it.each(['question', 'reset', 'receipt', 'baseline', 'host', 'path', 'account', 'mutation', 'budget'] as const)('refuses %s without inventing authority', variant => {
    const s = setup();
    try {
      if (variant === 'question') s.input.candidate.finding.claim = s.h.task.question.text;
      if (variant === 'reset') s.input.candidate.requiresTargetReset = true;
      if (variant === 'receipt') s.input.candidate.finding.evidenceIds = ['forged'];
      if (variant === 'baseline') s.input.candidate.baselineEvidenceIds = [];
      if (variant === 'budget') s.input.verifierBudget.maxRequests = 3;
      const probe = s.input.checks[2]!;
      if (variant === 'host') probe.input = { ...probe.input as object, url: 'https://unapproved.test/lab/2' };
      if (variant === 'path') probe.input = { ...probe.input as object, url: 'https://approved.test/lab/excluded/2' };
      if (variant === 'account') probe.input = { ...probe.input as object, accountId: 'admin' };
      if (variant === 'mutation') probe.input = { ...probe.input as object, method: 'POST' };
      expect(synthesizeFirstUseVerification(s.input).supported).toBe(false);
    } finally { s.h.dispose(); }
  });
  it('does not authenticate worker-authored policy objects', () => {
    const s = setup();
    try {
      s.input.verificationPolicy = { runId: s.h.run.runId, scopeDigest: 'a'.repeat(64), assertRequest() {}, assertVerifier() {} };
      expect(synthesizeFirstUseVerification(s.input).supported).toBe(false);
    } finally { s.h.dispose(); }
  });
});
