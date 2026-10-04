import { describe, it, expect } from 'vitest';
import { writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attemptSchema, taskSchema, digestJson } from '../../src/contracts/index.js';
import { replayFinding, sha256, type LocalReplayRecipe, type CleanReplayBroker } from '../../src/evidence/index.js';
import { createScopedVerificationPolicy } from '../../src/application/first-use-verification/index.js';
import type { ToolReceipt } from '../../src/tools/types.js';
import { fixtureScope } from '../policy/fixture.js';
import { createHarness, findingFixture, CLAIM, INPUT, NOW } from '../evidence/fixtures.js';

// .test HTTPS is an in-process response fixture here, NOT a live scan or TLS transport qualification.
function setup(mode: 'violation' | 'safe' | 'inconclusive' | 'control' = 'violation', expiry?: 'grant' | 'account') {
  const h = createHarness();
  const origin = 'https://approved.test';
  h.run.authorization.targets = [{ id: 'fixture-target', kind: 'web', locator: `${origin}/` }];
  h.run.allowedCapabilities = ['http.request'];
  Object.assign(h.run.budgets, { maxRequests: 20, maxToolCalls: 20, targetRequestLimits: { 'fixture-target': 20 } });
  const task = taskSchema.parse({ ...h.task, taskId: 'verifier-task', scope: { ...h.task.scope, authorizationRef: h.run.authorization.reference, targetIds: ['fixture-target'], environmentId: 'verifier-session' }, allowedActions: ['read'], lifecycleState: 'running' });
  const attempt = attemptSchema.parse({ ...h.attempt, taskId: task.taskId, attemptId: 'verifier-attempt', ownerId: 'independent-verifier', lifecycleState: 'running' });
  const context = { runId: h.run.runId, taskId: task.taskId, attemptId: attempt.attemptId, grantId: 'verifier-grant' };
  const scope = fixtureScope(origin);
  scope.runId = h.run.runId;
  scope.authorization = { reference: h.run.authorization.reference, approvedBy: 'owner', expiresAt: h.run.authorization.expiresAt };
  scope.accounts.forEach(a => { a.expiresAt = h.run.authorization.expiresAt; });
  Object.assign(scope.grants[0]!, { id: context.grantId, taskId: context.taskId, attemptId: context.attemptId, role: 'verifier', expiresAt: h.run.authorization.expiresAt });
  const shortExpiry = new Date(Date.parse(NOW) + 1000).toISOString();
  if (expiry === 'grant') scope.grants[0]!.expiresAt = shortExpiry;
  if (expiry === 'account') scope.accounts[0]!.expiresAt = shortExpiry;
  let time = Date.parse(NOW);
  const policy = createScopedVerificationPolicy(h.run, scope, () => time);
  const binding = { role: 'verifier' as const, collectorId: attempt.ownerId, taskId: task.taskId, attemptId: attempt.attemptId,
    environmentId: task.scope.environmentId, scopeDigest: policy.scopeDigest, toolGrantId: context.grantId,
    tool: { name: 'http.request', version: '1', implementationDigest: sha256('controlled-response-fixture') } };
  const runtime = (id: string, metadata: Record<string, string | boolean>) => h.collect(id, 'runtime', { metadata }, binding).evidenceId;
  h.collect('repro', 'reproduction'); h.collect('negative', 'negative-control');
  let environmentReceiptId: string;
  const finding = findingFixture(h);
  const requests: string[] = [];
  let ordinal = 0;
  const broker: CleanReplayBroker = { async prepare() { return {
    verificationPolicy: policy, environmentReceiptId, context, artifactRootId: 'staging', httpTool: { ...binding.tool, name: 'http.request' as const },
    broker: { async execute(request) {
      const input = request.input as { url: string };
      const path = new URL(input.url).pathname;
      requests.push(path);
      const status = path === '/control' ? (mode === 'control' ? 200 : 403) : path === '/probe' && mode === 'safe' ? 403 : 200;
      const body = path === '/baseline' ? 'own' : path === '/control' || mode === 'safe' ? 'denied' : mode === 'inconclusive' ? 'unknown' : 'foreign';
      const data = { kind: 'http', status, body }, text = JSON.stringify(data), pathName = `response-${ordinal++}.json`;
      writeFileSync(join(h.staging, pathName), text, { mode: 0o600 });
      const artifact = { path: pathName, sha256: sha256(text), bytes: Buffer.byteLength(text), mediaType: 'application/json' as const, redacted: true as const };
      const receipt: ToolReceipt = { version: 1, context, tool: { id: 'http.request', version: '1', implementationDigest: binding.tool.implementationDigest },
        scopeDigest: policy.scopeDigest, configurationDigest: task.scope.configurationDigest, inputDigest: digestJson(request.input), startedAt: NOW, finishedAt: NOW,
        outcome: 'collected', targets: ['fixture-target'], budgets: {}, artifacts: [artifact], isolation: 'controlled-in-process-fixture-not-TLS-transport', classification: 'observation-not-verified-finding' };
      return { data, artifact, receipt };
    } },
    async close() { return { receiptEvidenceId: runtime('closed', { terminationConfirmed: true, fixtureReset: false }) }; },
  }; } };
  const input = (path: string) => ({ url: `${origin}${path}`, method: 'GET' as const, accountId: 'anonymous' });
  const recipe: LocalReplayRecipe = { recipeId: 'recipe', fixtureId: 'controlled-fixture', targetId: 'fixture-target', invariant: CLAIM, inputDigests: [INPUT],
    baseline: { input: input('/baseline'), expected: { status: 200, bodyIncludes: 'own' } },
    negativeControl: { input: input('/control'), expected: { status: 403, bodyIncludes: 'denied' } },
    probe: { input: input('/probe'), violation: { status: 200, bodyIncludes: 'foreign' }, safe: { status: 403, bodyIncludes: 'denied' } } };
  environmentReceiptId = runtime('environment', { recipeDigest: digestJson(recipe), independentSession: true, targetReset: false, qualification: 'independent fixture session; targetReset=false', fixtureReset: false });
  const options = { vault: h.vault, finding, recipe, replayId: 'scoped-replay', verifierId: attempt.ownerId, verifierTask: task, verifierAttempt: attempt, authorization: h.run.authorization, broker, clock: () => NOW };
  return { h, options, requests, expire: () => { time = Date.parse(expiry ? shortExpiry : h.run.authorization.expiresAt); } };
}
describe('scoped independent replay decisions (controlled responses, no external egress)', () => {
  it.each([['violation', 'independently-validated'], ['safe', 'rejected'], ['inconclusive', 'unresolved'], ['control', 'unresolved']] as const)('%s stays %s', async (mode, expected) => {
    const s = setup(mode);
    try {
      const outcome = await replayFinding(s.options);
      expect(outcome.review.finding?.state, JSON.stringify(outcome.issues)).toBe(expected);
      expect(s.requests).toEqual(mode === 'control' ? ['/baseline', '/control'] : ['/baseline', '/control', '/probe']);
      if (mode === 'violation') expect(outcome.status, JSON.stringify(outcome.issues)).toBe('accepted');
    } finally { s.h.dispose(); }
  });
  it.each(['host', 'account', 'expired', 'grant', 'account-expiry', 'tampered', 'receipt', 'prediction'] as const)('refuses %s before replay network calls', async variant => {
    const s = setup('violation', variant === 'grant' ? 'grant' : variant === 'account-expiry' ? 'account' : undefined);
    try {
      if (variant === 'host') s.options.recipe.probe.input.url = 'https://unapproved.test/probe';
      if (variant === 'account') s.options.recipe.probe.input.accountId = 'unapproved-admin';
      if (['expired', 'grant', 'account-expiry'].includes(variant)) s.expire();
      if (variant === 'prediction') s.options.recipe.probe.violation.bodyIncludes = 'invented-marker';
      if (variant === 'receipt') {
        const record = s.h.vault.inspect('environment')!;
        const path = join(s.h.vaultRoot, 'records', `${record.keyDigest}.json`);
        const signed = JSON.parse(readFileSync(path, 'utf8'));
        signed.body.receipt.metadata.targetReset = true;
        chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(signed));
      }
      if (variant === 'tampered') {
        const e = s.h.vault.get('environment')!;
        chmodSync(join(s.h.vaultRoot, e.locator), 0o600);
        writeFileSync(join(s.h.vaultRoot, e.locator), 'tampered');
      }
      const outcome = await replayFinding(s.options);
      expect(outcome.status).toBe('returned-for-evidence');
      expect(outcome.review.finding?.state).toBe('unresolved');
      expect(s.requests).toEqual([]);
    } finally { s.h.dispose(); }
  });
});
