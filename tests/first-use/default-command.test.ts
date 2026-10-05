import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelRuntime, ModelRegistry, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerP2O } from '../../extensions/p2o/index.js';
import { createHostPiPlanAuthor } from '../../src/application/entry/pi-author.js';
import { ensureOwnerOnboarding } from '../../src/application/onboarding/index.js';
import { inertProvider } from './inert-provider.js';
import { gitServer, fixtureRepoUrl } from '../source-container/git-server.js';
import type { EntryCommandRunner } from '../../src/application/entry/types.js';
import { removePrivateSourceTree } from '../../src/application/entry/snapshot.js';

const repo = resolve(import.meta.dirname, '../..');
async function harness(options: { sourceRunner?: EntryCommandRunner; refuse?: string; unpriced?: boolean } = {}) {
  for (const key of ['P2O_CONTROL_MODULE', 'P2O_APP_CONFIG', 'P2O_PLAN_AUTHOR_MODULE']) delete process.env[key];
  const root = await mkdtemp(join(homedir(), '.p2o-FIRST-USE-MODEL-INERT-'));
  const provider = await inertProvider();
  const runtime = await ModelRuntime.create({ authPath: join(root, 'host-auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider('inert-fixture', { baseUrl: provider.origin, api: 'openai-completions', apiKey: 'explicit-inert-secret-not-live', models: [{ id: options.unpriced ? 'unpriced-fixture' : 'inert-worker', name: 'MODEL-INERT ONLY', api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 }, contextWindow: 128000, maxTokens: 4096 }] });
  const models = await runtime.getAvailable();
  const model = models.find(m => m.provider === 'inert-fixture')!;
  const registry = new ModelRegistry(runtime);
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const messages: any[] = [], notifications: any[] = [], dialogs: Array<{ title: string; body?: string }> = [];
  const pi = { registerTool() {}, registerCommand(name: string, spec: any) { if (name === 'p2o') handler = spec.handler; }, on() {}, appendEntry() {}, sendMessage(message: any) { messages.push(message); } } as unknown as ExtensionAPI;
  const ui = {
    async confirm(title: string, body: string) { dialogs.push({ title, body }); return !options.refuse || !title.includes(options.refuse); },
    async select(title: string, choices: string[]) { dialogs.push({ title }); return choices[0]; },
    async input(title: string, placeholder?: string) { dialogs.push({ title }); if (title.startsWith('Maximum model tokens')) return '400000'; if (title.startsWith('Total USD')) return '10'; return placeholder ?? 'explicit inert test owner'; },
    notify(message: string, type?: string) { notifications.push({ message, type }); }, setStatus() {},
  };
  const controller = registerP2O(pi, {
    onboardingFor: input => ensureOwnerOnboarding(input, { storageRoot: join(root, 'owner-consent') }),
    // Default host author is used for URL/local. Only the explicitly inert controlled-Git transport is injected.
    ...(options.sourceRunner ? { planAuthorFor(ctx: ExtensionCommandContext) { const author = createHostPiPlanAuthor(ctx); return { ...author, async configure(owner: any) { const setup = await author.configure(owner); return { ...setup, qualificationHarness: { kind: 'model-inert-controlled-targets-not-live' as const, sourceRunner: options.sourceRunner } }; } }; } } : {}),
  });
  const ctx = { cwd: repo, model, modelRegistry: registry, thinkingLevel: 'off', hasUI: true, mode: 'rpc', ui, waitForIdle: async () => {}, sessionManager: { getBranch: () => [] } } as unknown as ExtensionCommandContext;
  async function command(args: string) { const before = messages.length; await handler!(args, ctx); const message = messages.slice(before).at(-1); return message?.details as any; }
  async function waitForRun(runId: string) {
    let status: any;
    for (let i=0; i<400; i++) {
      status = await controller.execute('status', { runId }, repo);
      if (['completed','failed','cancelled'].includes(status.run?.state)) { if (process.env.P2O_FIRST_USE_KEEP === '1') await writeFile('/tmp/p2o-first-use-test-status.json', JSON.stringify(status, null, 2)); return status; }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`run did not settle: ${JSON.stringify(status)}`);
  }
  return { root, provider, dialogs, notifications, controller, command, waitForRun, messages,
    async close() { await controller.close(); await provider.close(); if (process.env.P2O_FIRST_USE_KEEP === '1') { await writeFile('/tmp/p2o-first-use-test-debug.json', JSON.stringify({ root, notifications, providerRequests: provider.requests }, null, 2)); } else await removePrivateSourceTree(root); } };
}

// These are CONTRACT + REAL PROCESS/BROKER/DOCKER, MODEL-INERT tests. NOT real-provider qualification.
describe('no-config /p2o first-use, real bundled backend (explicit MODEL-INERT provider)', () => {
  it('URL: human consent -> real host API plan -> exact approval -> real Pi worker -> broker -> report', async () => {
    delete process.env.P2O_CONTROL_MODULE; delete process.env.P2O_APP_CONFIG;
    let targetRequests = 0;
    const server = createServer((_req, res) => { targetRequests++; res.end('controlled benign target'); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/exact`;
    const h = await harness();
    try {
      const planned = await h.command(`--target ${target} --plan-only`);
      expect(h.notifications.filter(n => n.type === 'error')).toEqual([]);
      expect(planned?.planOnly).toBe(true); expect(targetRequests).toBe(0); expect(h.provider.requests.length).toBe(1);
      // Ordinary first-use asks for scope/rights only: no budget/quota dialog exists on this path.
      expect(h.dialogs.filter(dialog => /budget|USD|model tokens|quota/i.test(dialog.title))).toEqual([]);
      const runDirectory = join(h.root, 'runs', (await readdir(join(h.root, 'runs')))[0]!);
      const pinnedBudget = JSON.parse(await readFile(join(runDirectory, 'autonomous-budget.json'), 'utf8'));
      expect(pinnedBudget).toMatchObject({ outcome: 'accounting-only', policy: 'informational-durable-no-phase-quotas', ownerLimits: { mode: 'accounting-only' } });
      expect(pinnedBudget.phases).toBeUndefined();
      const manifest = JSON.parse(await readFile(join(runDirectory, 'control/run-manifest.json'), 'utf8'));
      expect(manifest.budgets).toMatchObject({ modelAccounting: 'informational', maxTokens: null, maxCostUsd: null });
      await h.command(`approve ${planned.planId}`);
      expect(h.notifications.filter(n => n.type === 'error')).toEqual([]);
      const status = await h.waitForRun(planned.runId);
      expect(status.run.state).toBe('completed'); expect(status.process.attempts.length).toBeGreaterThan(0); expect(targetRequests).toBe(1);
      expect(status.packets.some((packet: any) => JSON.stringify(packet).includes('accepted'))).toBe(true);
      const report: any = await h.controller.execute('report', { runId: planned.runId, format: 'json' }, repo);
      expect(JSON.stringify(report)).toContain('independently-observed');
      expect(JSON.stringify(report)).toContain('MODEL-INERT');
      expect(JSON.stringify(report)).toContain('"findings":[]');
      expect(JSON.stringify(report)).not.toContain('tenant=alpha');
      expect(h.dialogs.filter(d => d.title.includes('First-use owner consent'))).toHaveLength(1);
      // The controller-attested native completion/context capability is what bounded planning, and the
      // informational ledger records usage without any financial admission gate.
      expect(report.modelBudget).toMatchObject({ policy: 'informational-durable-no-phase-quotas', accounting: { limits: { mode: 'accounting-only', maxTokens: null, maxCostUsd: null } } });
      expect(report.modelBudget.phases).toBeUndefined();
      expect(report.modelBudget.accounting.committed.tokens).toBeGreaterThan(0);
      const planningSpend = JSON.parse(await readFile(join(runDirectory, 'control/planning-spend.json'), 'utf8')) as { accounting: any; receipts: any[] };
      expect(planningSpend.accounting.limits).toMatchObject({ mode: 'accounting-only', maxTokens: null, maxCostUsd: null });
      expect(planningSpend.accounting.committed.tokens).toBeGreaterThan(0);
      // The planner receipt records the native selected-model completion bound (4096 for this model), not a
      // fixed 4096 application constant, and it records observed usage informationally.
      const planReceipt = planningSpend.receipts.at(-1);
      expect(planReceipt).toMatchObject({ basis: 'durable-planner-phase; controller-gateway-wire-admission', outputBound: 4096 });
      expect(planReceipt.usage.output).toBeGreaterThan(0);
    } finally { await h.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  }, 90000);

  it('local: immutable approval -> exact per-run Docker mount + provenance before worker, no repo scripts', async () => {
    const h = await harness(); const target = join(h.root, 'controlled-source'); await mkdir(target);
    await writeFile(join(target, 'index.ts'), 'export const localCanary = "APPROVED_FIRST_USE_CANARY";\n');
    await writeFile(join(target, 'package.json'), JSON.stringify({ scripts: { postinstall: `touch ${join(h.root, 'SCRIPT_EXECUTED')}` } }));
    try {
      const result = await h.command(`--target ${target}`);
      expect(h.notifications.filter(n => n.type === 'error')).toEqual([]); expect(result?.runId).toBeTruthy();
      const status = await h.waitForRun(result.runId); expect(status.run.state).toBe('completed');
      expect(h.dialogs.some(d => d.title.includes('Approve immutable source'))).toBe(true);
      const runDirs = await readdir(join(h.root, 'runs'));
      const config = JSON.parse(await readFile(join(h.root, 'runs', runDirs[0]!, 'control/application.json'), 'utf8'));
      expect(config.sandbox.options.inputRoot).not.toBe(target); expect(config.sandbox.options.approvedSource.snapshot.root).toBe(config.sandbox.options.inputRoot);
      expect(config.tasks[0].manifest.scope.configurationDigest).toBeTruthy();
      const evidence: any = await h.controller.execute('evidence', { runId: result.runId, offset: 0, limit: 100 }, repo);
      expect(JSON.stringify(evidence)).toContain('source-binding');
      expect(await readFile(join(target, 'index.ts'), 'utf8')).toContain('APPROVED_FIRST_USE_CANARY');
      await expect(readFile(join(h.root, 'SCRIPT_EXECUTED'))).rejects.toThrow();
      const leaseDir = join(h.root, 'runs', runDirs[0]!, 'control/session-leases');
      // Actual runtime session-release receipt, not a map-empty response, is also in the private attempt handle.
      const handles = await readdir(join(h.root, 'runs', runDirs[0]!, 'control/handles'));
      const handle = JSON.parse(await readFile(join(h.root, 'runs', runDirs[0]!, 'control/handles', handles[0]!), 'utf8'));
      expect(handle.sessionRelease.verified).toBe(true); expect(handle.sessionRelease.releasers.some((r: any) => r.name === 'container-pack')).toBe(true);
      expect(JSON.stringify(config)).not.toContain('explicit-inert-secret'); void leaseDir;
    } finally { await h.close(); }
  }, 90000);

  it('GitHub syntax: real controlled Git smart-HTTP acquisition -> immutable full commit/tree approval -> Docker -> report (NOT live GitHub)', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'p2o-first-use-real-git-'));
    const git = await gitServer(fixtureRoot); const h = await harness({ sourceRunner: git.runner });
    try {
      const result = await h.command(`--target ${fixtureRepoUrl}`);
      expect(h.notifications.filter(n => n.type === 'error')).toEqual([]); expect(result?.runId).toBeTruthy();
      const status = await h.waitForRun(result.runId); expect(status.run.state).toBe('completed'); expect(git.requests.length).toBeGreaterThan(0);
      expect(h.dialogs.find(d => d.title.includes('Approve immutable source'))?.body).toContain(git.revision);
      expect(git.invocations.some(args => args[0] === 'clone')).toBe(true);
      const report: any = await h.controller.execute('report', { runId: result.runId, format: 'markdown' }, repo);
      expect(JSON.stringify(report)).toContain('static');
      await expect(readFile(join(fixtureRoot, 'REPO_SCRIPT_EXECUTED'))).rejects.toThrow();
    } finally { await h.close(); await git.close(); await rm(fixtureRoot, { recursive: true, force: true }); }
  }, 90000);

  it('an explicitly bounded consent still refuses an unpriced selection before any host provider or worker call', async () => {
    // Ordinary accounting-only runs may use an unpriced model (tokens recorded, cost unknown) — covered by the
    // budget ledger test and the composition gate. An explicit legacy bounded consent still fails closed here.
    const h = await harness({ unpriced: true });
    try {
      await h.command('--target https://example.invalid/only --plan-only --profile conservative');
      expect(h.notifications.some(n => n.message.includes('MODEL_SPEND_UNPRICED'))).toBe(true);
      expect(h.provider.requests).toHaveLength(0);
    } finally { await h.close(); }
  }, 30000);

  it('source identity refusal leaves workers/broker unlaunched (first approval permits acquisition only)', async () => {
    const h = await harness({ refuse: 'Approve immutable source' }); const target = join(h.root, 'source'); await mkdir(target); await writeFile(join(target, 'index.ts'), 'export const a = 1;');
    try { await h.command(`--target ${target}`); expect(h.notifications.some(n => n.message.includes('NOT_APPROVED'))).toBe(true); expect(h.provider.requests).toHaveLength(1); }
    finally { await h.close(); }
  }, 30000);
});
