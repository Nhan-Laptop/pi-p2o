import { mkdtemp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ModelRuntime, ModelRegistry, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerP2O } from '../../extensions/p2o/index.js';
import { ensureOwnerOnboarding } from '../../src/application/onboarding/index.js';
import { inertProvider } from '../first-use/inert-provider.js';
import { removePrivateSourceTree } from '../../src/application/entry/snapshot.js';

/** Real command/bundled backend/Pi/gateway/broker; automated human dialogs + INERT MODEL.
 * Optional `root` reuses an existing harness root across processes (the harness then leaves its removal
 * to the caller); `holdWorkerMs` stalls only tool-bearing worker turns so a crash window can be observed.
 * Not live model qualification, not a fake TargetEntryPort or replacement runtime.
 */
export async function commandHarness(options: { tokens?: number; packBoundary?: 'unsupported'; declinePack?: boolean; root?: string; holdWorkerMs?: number; storageRoot?: string } = {}) {
  for (const key of ['P2O_CONTROL_MODULE', 'P2O_APP_CONFIG', 'P2O_PLAN_AUTHOR_MODULE']) delete process.env[key];
  const root = options.root ?? await mkdtemp(join(homedir(), '.p2o-AUTONOMOUS-INERT-'));
  const cwd = resolve(import.meta.dirname, '../..');
  const provider = await inertProvider(options.holdWorkerMs === undefined ? {} : { holdWorkerMs: options.holdWorkerMs });
  const runtime = await ModelRuntime.create({ authPath: join(root, 'host-auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider('inert-fixture', { baseUrl: provider.origin, api: 'openai-completions', apiKey: 'explicit-inert-secret-not-live', models: [{ id: 'inert-worker', name: 'MODEL-INERT ONLY', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 }, contextWindow: 128000, maxTokens: 4096 }] });
  const model = (await runtime.getAvailable()).find(m => m.provider === 'inert-fixture')!;
  const messages: any[] = [], notifications: any[] = [], dialogs: Array<{ title: string; body?: string }> = [];
  let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const pi = { registerTool() {}, registerCommand(name: string, spec: any) { if (name === 'p2o') handler = spec.handler; }, on() {}, appendEntry() {}, sendMessage(message: any) { messages.push(message); } } as unknown as ExtensionAPI;
  const ui = {
    async confirm(title: string, body: string) { dialogs.push({ title, body }); return !(options.declinePack && title.includes('TOOL PACK')); },
    async select(title: string, choices: string[]) { dialogs.push({ title }); return options.packBoundary === 'unsupported' && title.startsWith('First-use tool boundary') ? choices[1] : choices[0]; },
    async input(title: string, placeholder?: string) { dialogs.push({ title }); if (title.startsWith('Maximum model tokens')) return String(options.tokens ?? 100000); if (title.startsWith('Total USD')) return '10'; return placeholder ?? 'explicit inert test owner'; },
    notify(message: string, type?: string) { notifications.push({ message, type }); }, setStatus() {},
  };
  const storageRoot = options.storageRoot ?? join(root, 'owner-consent');
  const controller = registerP2O(pi, { onboardingFor: input => ensureOwnerOnboarding(input, { storageRoot }), ownerStorageRoot: storageRoot });
  const ctx = { cwd, model, modelRegistry: new ModelRegistry(runtime), thinkingLevel: 'off', hasUI: true, mode: 'rpc', ui, waitForIdle: async () => {}, sessionManager: { getBranch: () => [] } } as unknown as ExtensionCommandContext;
  return { root, cwd, provider, dialogs, notifications, controller, messages,
    // A narrow token budget is a *guided* answer, because the default one-dialog path derives limits from
    // --profile. Asking for it therefore opts into the full questionnaire, exactly like a human would.
    async command(args: string) { const before = messages.length; await handler!(options.tokens === undefined ? args : `${args} --advanced`, ctx); return messages.slice(before).at(-1)?.details as any; },
    async wait(runId: string) { for (let i = 0; i < 400; i++) { const s: any = await controller.execute('status', { runId }, cwd); if (['completed', 'failed', 'cancelled'].includes(s.run?.state)) return s; await new Promise(r => setTimeout(r, 100)); } throw new Error('Run did not settle'); },
    async close() { await controller.close(); await provider.close(); if (!options.root) await removePrivateSourceTree(root); },
  };
}
