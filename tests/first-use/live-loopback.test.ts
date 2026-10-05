// LIVE PROVIDER + REAL INSTALLED PI, LOOPBACK TARGET ONLY. Gated on P2O_LIVE_FIRST_USE=1 because it spends
// real provider credit; the default suites never run it. No external target is contacted: the only target is
// a loopback URL served by this test. Selection is the owner's exact registry model and thinking.
//
// Scope of this live proof: the PLANNER phase at the requested max thinking. It proves that no application
// token/USD quota or fixed 4096 ceiling gates planning, that the ceiling is the selected model's own
// capability, and that observed usage is recorded informationally. The complete plan -> approve -> worker ->
// verifier -> report flow with the real installed Pi/Docker is proven by `tests/first-use` (explicit inert
// loopback model) and `tests/autonomous-integration`; a LIVE worker/model-quality run is deliberately not
// asserted here, because a live model's handoff packet can be rejected by the H2 schema for reasons that have
// nothing to do with spend policy (observed during bring-up: `priority`/`reachability` enum violations).
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelRuntime, ModelRegistry, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerP2O } from '../../extensions/p2o/index.js';
import { ensureOwnerOnboarding } from '../../src/application/onboarding/index.js';
import { removePrivateSourceTree } from '../../src/application/entry/snapshot.js';

const live = process.env.P2O_LIVE_FIRST_USE === '1';
const PROVIDER = process.env.P2O_LIVE_PROVIDER ?? 'deepseek';
const MODEL = process.env.P2O_LIVE_MODEL ?? 'deepseek-flash';
const THINKING = process.env.P2O_LIVE_THINKING ?? 'max';
const repo = resolve(import.meta.dirname, '../..');

describe.runIf(live)('live provider, loopback target, ordinary accounting-only /p2o', () => {
  it('plans at the requested max thinking with no budget dialog, no phase quota and a native completion bound', async () => {
    const root = await mkdtemp(join(homedir(), '.p2o-LIVE-LOOPBACK-'));
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    await runtime.getAvailable();
    const registry = new ModelRegistry(runtime);
    await registry.refresh();
    const model = registry.find(PROVIDER, MODEL);
    if (!model) throw new Error(`${PROVIDER}/${MODEL} is not in the host registry`);
    // The claim is only meaningful against a model whose own completion capability exceeds the old constant.
    expect(model.maxTokens).toBeGreaterThan(4096);
    const messages: any[] = [], notifications: any[] = [], dialogs: Array<{ title: string; body?: string }> = [];
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = { registerTool() {}, registerCommand(name: string, spec: any) { if (name === 'p2o') handler = spec.handler; }, on() {}, appendEntry() {}, sendMessage(message: any) { messages.push(message); } } as unknown as ExtensionAPI;
    const ui = {
      async confirm(title: string, body: string) { dialogs.push({ title, body }); return true; },
      async select(title: string, choices: string[]) { dialogs.push({ title }); return title.startsWith('Assessment thinking') ? THINKING : choices[0]; },
      async input(title: string, placeholder?: string) { dialogs.push({ title }); return placeholder ?? 'explicit live loopback test owner'; },
      notify(message: string) { notifications.push({ message }); },
    };
    const controller = registerP2O(pi, { onboardingFor: input => ensureOwnerOnboarding(input, { storageRoot: join(root, 'owner-consent') }) });
    const ctx = { cwd: repo, model, modelRegistry: registry, thinkingLevel: THINKING, hasUI: true, mode: 'rpc', ui, waitForIdle: async () => {}, sessionManager: { getBranch: () => [] } } as unknown as ExtensionCommandContext;
    let targetRequests = 0;
    const server = createServer((_req, res) => { targetRequests++; res.end('controlled benign loopback response'); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/exact`;
    try {
      await handler!(`--target ${target} --plan-only`, ctx);
      const planned = messages.at(-1)?.details;
      expect(notifications.filter(n => n.type === 'error')).toEqual([]);
      expect(planned?.planId).toBeTruthy();
      expect(targetRequests).toBe(0);
      // Ordinary consent has no budget/quota dialog at all.
      expect(dialogs.filter(dialog => /budget|USD|model tokens|quota/i.test(dialog.title))).toEqual([]);
      const runDirectory = join(root, 'runs', (await readdir(join(root, 'runs')))[0]!);
      const pinned = JSON.parse(await readFile(join(runDirectory, 'autonomous-budget.json'), 'utf8'));
      expect(pinned).toMatchObject({ outcome: 'accounting-only', ownerLimits: { mode: 'accounting-only' }, selection: { provider: PROVIDER, model: MODEL, thinking: THINKING } });
      expect(pinned.phases).toBeUndefined();
      const planning = JSON.parse(await readFile(join(runDirectory, 'control/planning-spend.json'), 'utf8'));
      const receipt = planning.receipts.at(-1);
      expect(receipt.selection).toMatchObject({ provider: PROVIDER, model: MODEL, thinking: THINKING });
      // Native selected-model capability (clamped only by the remaining context), never a fixed 4096 ceiling.
      expect(receipt.outputBound).toBe(Math.min(model.maxTokens, model.contextWindow - receipt.inputBound));
      expect(receipt.outputBound).toBeGreaterThan(4096);
      // Observed usage is recorded informationally with a real cost, and nothing was refused on spend.
      expect(receipt.usage.input).toBeGreaterThan(0);
      expect(receipt.usage.output).toBeGreaterThan(0);
      expect(receipt.usage.cost.total).toBeGreaterThan(0);
      expect(planning.limits).toEqual({ modelAccounting: 'informational', maxTokens: null, maxCostUsd: null });
      process.stdout.write(`LIVE_LOOPBACK_PLANNER_OK provider=${PROVIDER} model=${MODEL} thinking=${THINKING} native=${model.maxTokens} plannerBound=${receipt.outputBound} observedIn=${receipt.usage.input} observedOut=${receipt.usage.output} costUsd=${receipt.usage.cost.total}\n`);
    } finally {
      await controller.close();
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
      if (process.env.P2O_LIVE_KEEP === '1') process.stdout.write(`LIVE_LOOPBACK_ROOT ${root}\n`);
      else await removePrivateSourceTree(root);
    }
  }, 600_000);
});
