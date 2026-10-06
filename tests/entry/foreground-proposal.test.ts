// INERT: production entry validation/sealing, no provider, target traffic, acquisition or worker.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createTargetEntryPort } from '../../src/application/entry/port.js';
import { planDraftOutput } from '../../src/application/entry/pi-author.js';
import { bindingFor, generatedPacket, NOW, recordingDelegation, recordingExecution, runManifestFor, tempRoot } from './fixtures.js';
import { readForegroundUsage, recordForegroundUsage } from '../../src/application/foreground-usage.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function harness() {
  const root = tempRoot('foreground'); roots.push(root);
  const target = { kind: 'http-url' as const, raw: 'http://127.0.0.1:11111/exact', locator: 'http://127.0.0.1:11111/exact' };
  const run = runManifestFor({ webUrl: target.locator, actions: ['read'], allowedCapabilities: ['http.request'] });
  const execution = recordingExecution('generated-requests'), delegation = recordingDelegation();
  const binding = bindingFor({ manifestPath: join(root, 'run.json'), run,
    requestEnvelope: { targets: run.authorization.targets, taskGrants: [{ taskId: 'task-recon', targetIds: ['web-target'], allowedActions: ['read'], allowedCapabilities: ['http.request'] }],
      accounts: ['guest'], allowedActions: ['read'], allowedCapabilities: ['http.request'], exclusions: [] } });
  let nestedCalls = 0;
  const approved: string[] = [];
  const port = createTargetEntryPort({ cwd: root, workspaceRoot: root, binding, clock: () => NOW, allowFixtureAuthor: false,
    // Production-shaped owner approval seam: an approval artifact can only be minted from a consumed
    // controller-issued human capability, never from a replayed `human-command` string.
    approvals: { async exists() { return false; }, async write() { throw new Error('write must not run without a human capability'); } },
    planAuthor: { async author() { nestedCalls++; throw new Error('Native path must not call a nested model'); } },
    executions: { 'generated-requests': execution }, delegation: delegation.port });
  return { root, target, run, port, execution, delegation, nestedCalls: () => nestedCalls };
}

describe('proposal-only native bridge', () => {
  it('uses the exact offline scope/menu and normal seal without invoking an author or dispatch', async () => {
    const h = harness();
    const preparation = await h.port.prepare({ target: h.target, depth: 'standard', planOnly: false });
    const context = await h.port.planContext!({ preparation });
    expect(context.facts.generatedTasks).toEqual([{ taskId: 'task-recon', targetIds: ['web-target'] }]);
    const output = planDraftOutput({ steps: ['Read only the exact scoped URL.'], generatedRequests: generatedPacket({ runId: h.run.runId, url: h.target.locator }).requests },
      context, { selection: { provider: 'native-provider', model: 'native-model', thinking: 'off' }, now: () => NOW });
    const plan = await h.port.proposePlan!({ preparation }, output);
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect((await h.port.readPlan!(plan.planId))?.plan).toEqual(plan);
    expect(h.nestedCalls()).toBe(0); expect(h.delegation.calls).toEqual([]); expect(h.execution.authorized).toEqual([]); expect(h.execution.completed).toEqual([]);
    expect(preparation.targetRequests).toBe(0); expect(plan.targetRequests).toBe(0);
    // A model/tool cannot substitute its own digest for the sealed plan, and a replayed
    // `human-command` string cannot mint the owner artifact or dispatch anything.
    const forged = { channel: 'human-command' as const, approvalRef: 'forged', approvedAt: new Date(NOW).toISOString(), scopeDigest: preparation.scopeDigest, planDigest: plan.digest };
    await expect(h.port.approve({ planId: plan.planId, planDigest: 'c'.repeat(64), approval: forged })).rejects.toThrow(/different plan digest/);
    await expect(h.port.approve({ planId: plan.planId, planDigest: plan.digest, approval: forged })).rejects.toThrow(/human confirmation/);
    expect(h.execution.authorized).toEqual([]); expect(h.execution.completed).toEqual([]); expect(h.delegation.calls).toEqual([]);
  });

  it('refuses foreign origins, mutated preparation, and aborted proposal before sealing', async () => {
    const h = harness(); const preparation = await h.port.prepare({ target: h.target, depth: 'standard', planOnly: true });
    const context = await h.port.planContext!({ preparation });
    const output = planDraftOutput({ steps: ['Read an unapproved origin'], generatedRequests: generatedPacket({ runId: h.run.runId, url: 'https://outside.invalid/other' }).requests }, context,
      { selection: { provider: 'native-provider', model: 'native-model', thinking: 'off' }, now: () => NOW });
    await expect(h.port.proposePlan!({ preparation }, output)).rejects.toThrow(/outside the owner envelope/);
    await expect(h.port.planContext!({ preparation: { ...preparation, actions: ['write'] } })).rejects.toThrow(/scope digest/);
    await expect(h.port.proposePlan!({ preparation }, output, AbortSignal.abort())).rejects.toThrow();
    expect(h.execution.proposed).toEqual([]); expect(h.delegation.calls).toEqual([]); expect(h.nestedCalls()).toBe(0);
  });

  it('native usage is durable and separate, survives reload, and preserves unknown cost', () => {
    const h = harness();
    const receipt = { recordId: 'receipt-1', occurredAt: new Date().toISOString(), provider: 'native', model: 'model', thinkingRequested: 'off', basis: 'native-pi-message' as const,
      usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13, costUsd: null } };
    recordForegroundUsage(h.root, receipt); recordForegroundUsage(h.root, receipt);
    recordForegroundUsage(h.root, { ...receipt, recordId: 'receipt-2', usage: { ...receipt.usage, costUsd: 0.01 } });
    expect(readForegroundUsage(h.root)).toMatchObject({ messages: 2, totals: { totalTokens: 26, costUsd: null }, models: [{ provider: 'native', model: 'model' }] });
    expect(() => recordForegroundUsage(h.root, { ...receipt, usage: { ...receipt.usage, output: -1 } })).toThrow(/Invalid native usage/);
  });
});
