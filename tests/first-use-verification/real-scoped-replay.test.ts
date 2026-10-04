import { it, expect } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { digestJson, attemptSchema } from '../../src/contracts/index.js';
import { admitToolResult, replayFinding } from '../../src/evidence/index.js';
import { createPolicy, TargetBudget } from '../../src/policy/index.js';
import { createDefaultRegistry, createLocalFixtureSandbox, createToolBroker } from '../../src/tools/index.js';
import { createScopedVerificationPolicy, synthesizeFirstUseVerification, createFirstUseReplayEnvironment } from '../../src/application/first-use-verification/index.js';
import type { VerificationServices } from '../../src/application/verification.js';
import type { ObservationCheck } from '../../src/application/types.js';
import { fixtureScope } from '../policy/fixture.js';
import { createHarness, findingFixture, CLAIM } from '../evidence/fixtures.js';
import { startLabFixture } from './lab-fixture.js';

it('replays an approved external-shaped hostname through the REAL broker and qualified independent session (controlled loopback fixture, not a live third-party scan)', async () => {
  const lab = await startLabFixture();
  const clock = () => new Date().toISOString();
  const h = createHarness({ clock });
  try {
    const origin = lab.origin.replace('127.0.0.1', 'approved.test');
    const locator = `${origin}/lab`, targetId = 'fixture-target';
    h.run.authorization.targets = [{ id: targetId, kind: 'web', locator }];
    h.run.allowedCapabilities = ['http.request'];
    Object.assign(h.run.budgets, { maxRequests: 20, maxToolCalls: 20, maxTokens: 50000, targetRequestLimits: { [targetId]: 20 } });
    h.task.scope.targetIds = [targetId]; h.task.allowedActions = ['read'];
    const inputRoot = join(h.worker, 'inputs'); mkdirSync(inputRoot, { mode: 0o700 });
    const sandbox = createLocalFixtureSandbox({ inputRoot, outputRoot: h.staging, trustedInputSnapshot: true, acknowledgement: 'local-fixtures-only-not-hostile-code-isolation' });
    h.task.scope.configurationDigest = sandbox.configurationDigest;
    const context = { runId: h.run.runId, taskId: h.task.taskId, attemptId: h.attempt.attemptId, grantId: 'producer-grant' };
    const scope = fixtureScope(origin);
    scope.runId = h.run.runId;
    scope.authorization = { reference: h.run.authorization.reference, approvedBy: 'fixture-owner', expiresAt: h.run.authorization.expiresAt };
    scope.targets[0]!.pathPrefixes = ['/lab'];
    scope.exclusions = [];
    scope.accounts.forEach(a => { a.expiresAt = h.run.authorization.expiresAt; });
    Object.assign(scope.grants[0]!, { id: context.grantId, taskId: context.taskId, attemptId: context.attemptId, expiresAt: h.run.authorization.expiresAt });
    const registry = createDefaultRegistry();
    const descriptor = registry.get('http.request');
    const tool = { name: 'http.request' as const, version: descriptor.version, implementationDigest: descriptor.implementationDigest };
    const producerPolicy = createPolicy(scope);
    const budgets = new TargetBudget(producerPolicy.scope.targets);
    let resolutions = 0;
    const resolver = async (host: string) => { expect(host).toBe('approved.test'); resolutions++; return ['127.0.0.1']; };
    const producerBroker = createToolBroker({ policy: producerPolicy, budgets, sandbox, registry, resolver });
    const checks: ObservationCheck[] = [
      ['observation', 'id=i-100&tenant=alpha', 200, 'alpha-value'],
      ['negative-control', 'id=i-100&tenant=beta', 403, 'tenant_mismatch'],
      ['reproduction', 'id=i-200&tenant=beta', 200, 'beta-secret'],
    ].map(([kind, query, status, body], i) => ({ checkId: `check-${i}`, observationId: `obs-${i}`, taskId: h.task.taskId,
      tool: 'http.request', input: { url: `${locator}/item?${query}`, method: 'GET', accountId: 'anonymous', action: 'read', maxRedirects: 0 },
      kind: kind as ObservationCheck['kind'], classification: 'independently-observed', summary: `${kind}`, expectation: { type: 'http', status: status as number, bodyIncludes: body as string } }));
    for (const [i, check] of checks.entries()) {
      const result = await producerBroker.execute({ context, tool: 'http.request', input: check.input });
      const handle = h.vault.issueCollector(h.grant({ scopeDigest: producerPolicy.digest, toolGrantId: context.grantId, tool }));
      const id = ['baseline', 'negative', 'repro'][i]!;
      admitToolResult(h.vault, handle, { result, operationInput: check.input, artifactRootId: 'staging', evidence: {
        evidenceId: id, idempotencyKey: id, kind: check.kind, classification: check.classification, summary: check.summary,
        ...(i === 0 ? {} : { test: { purpose: check.kind as 'negative-control' | 'reproduction', outcome: 'passed' as const, successes: 1, attempts: 1, invariant: CLAIM, originalPolicy: true, targetId } }),
        metadata: { observationId: check.observationId, claimDigest: digestJson(CLAIM) },
      } });
    }
    const synthesis = synthesizeFirstUseVerification({ run: h.run, producerTask: h.task, targetId, targetLocator: locator, checks, workspaceRoot: h.worker,
      candidate: { finding: findingFixture(h), baselineEvidenceIds: ['baseline'], requiresTargetReset: false }, vault: h.vault,
      verificationPolicy: createScopedVerificationPolicy(h.run, scope), policyContext: context,
      verifierBudget: { maxRequests: 4, maxToolCalls: 4, maxTokens: 1000, maxCostUsd: 0 }, now: clock() });
    expect(synthesis.supported, JSON.stringify(synthesis)).toBe(true);
    if (!synthesis.supported) return;
    const { leg } = synthesis;
    leg.verifierTask.lifecycleState = 'running';
    const attempt = attemptSchema.parse({ ...h.attempt, taskId: leg.verifierTask.taskId, attemptId: 'independent-attempt', ownerId: 'independent-verifier', lifecycleState: 'running' });
    const verifierContext = { runId: h.run.runId, taskId: attempt.taskId, attemptId: attempt.attemptId, grantId: 'verifier-grant' };
    scope.grants = [{ ...scope.grants[0]!, id: verifierContext.grantId, taskId: attempt.taskId, attemptId: attempt.attemptId, role: 'verifier' }];
    const verifierPolicy = createPolicy(scope);
    const verifierBroker = createToolBroker({ policy: verifierPolicy, budgets, sandbox, registry, resolver });
    const binding = { role: 'verifier' as const, collectorId: attempt.ownerId, taskId: attempt.taskId, attemptId: attempt.attemptId,
      environmentId: leg.verifierTask.scope.environmentId, scopeDigest: verifierPolicy.digest, toolGrantId: verifierContext.grantId, tool };
    const baseline = await verifierBroker.execute({ context: verifierContext, tool: 'http.request', input: leg.verifierCheck.input });
    const handle = h.vault.issueCollector(h.grant(binding));
    admitToolResult(h.vault, handle, { result: baseline, operationInput: leg.verifierCheck.input, artifactRootId: 'staging', evidence: {
      evidenceId: 'verifier-baseline', idempotencyKey: 'verifier-baseline', kind: 'observation', classification: 'independently-observed', summary: 'Observable verifier baseline (no reset)', metadata: { observationId: leg.verifierCheck.observationId },
    } });
    const services = {
      vault: h.vault, store: { listEvidence: (runId: string) => h.vault.list(runId) },
      task: (id: string) => id === attempt.taskId ? leg.verifierTask : undefined,
      attempt: (id: string) => id === attempt.attemptId ? attempt : undefined,
      brokerFor: () => verifierBroker, grantIdFor: () => verifierContext.grantId, artifactRootId: 'staging', httpTool: tool,
      collector: { admitDocument: (_attempt: unknown, admission: any) => h.collect(admission.evidenceId, admission.kind, { metadata: admission.metadata }, binding, JSON.stringify(admission.document)) },
    } as unknown as VerificationServices;
    const environment = createFirstUseReplayEnvironment(services, { replay: leg.replay, claim: CLAIM, now: clock, verificationPolicy: createScopedVerificationPolicy(h.run, scope) });
    const outcome = await replayFinding({ vault: h.vault, broker: environment, finding: leg.candidate, recipe: leg.verification.recipe, replayId: 'real-scoped-replay', verifierId: attempt.ownerId,
      verifierTask: leg.verifierTask, verifierAttempt: attempt, authorization: h.run.authorization, clock });
    expect(outcome.status, JSON.stringify(outcome.issues)).toBe('accepted');
    expect(outcome.review.finding?.state).toBe('independently-validated');
    expect(lab.requests).toHaveLength(7);
    expect(resolutions).toBe(14);
    const receipt = h.vault.get('real-scoped-replay.environment')!;
    expect(receipt.metadata?.targetReset).toBe(false);
    expect(receipt.metadata?.cleanEnvironment).toBeUndefined();
  } finally { h.dispose(); await lab.close(); }
});
