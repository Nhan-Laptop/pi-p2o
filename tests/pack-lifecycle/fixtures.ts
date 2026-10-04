import assert from 'node:assert/strict';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { connect } from 'node:net';
import { createPolicy, TargetBudget, type Scope, type ToolContext } from '../../src/policy/index.js';
import { createHostBrowserSandbox } from '../../src/tools/sandbox.js';
import { createBrowserPack, type BrowserPack, type BrowserSessionEvidence } from '../../src/tools/browser-session.js';
import { createProxyPack, type ProxyPack } from '../../src/tools/proxy/pack.js';
import { discoverChromeIdentity, type ChromeIdentity } from '../../src/tools/browser-identity.js';
import { recoverBrowserResources } from '../../src/tools/browser-lifecycle.js';
import { createDefaultRegistry } from '../../src/tools/registry.js';
import { createHeadlessRuntime } from '../../src/runtime/headless.js';
import { registerPackSessionFamily, recoverControllerListeners } from '../../src/runtime/pack-lifecycle.js';
import { alive, LinuxProcessProbe, sameProcess } from '../../src/runtime/processes.js';
import type { RuntimeHandle, RuntimeRequest, SessionScope, ProcessIdentity } from '../../src/runtime/types.js';
import { filesystemHooks } from '../../src/runtime/filesystem-hooks.js';
import type { ProxySessionEvidence } from '../../src/tools/types.js';

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function waitFor<T>(work: () => Promise<T | undefined>, ms: number, label: string): Promise<T> {
  const end = performance.now() + ms;
  do { const value = await work(); if (value !== undefined) return value; await sleep(25); } while (performance.now() < end);
  throw new Error(`Bounded fixture wait failed: ${label} (${ms}ms)`);
}
export async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export async function listenerState(port: number): Promise<'open' | 'refused'> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve('open'); });
    socket.once('error', error => { socket.destroy(); if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve('refused'); else reject(error); });
    socket.setTimeout(500, () => { socket.destroy(); reject(new Error('TCP probe timed out: not proof of absence')); });
  });
}
export async function identityAlive(identity: ProcessIdentity): Promise<boolean> { return (await new LinuxProcessProbe().snapshot()).some(row => sameProcess(row, identity) && alive(row)); }
const EXPIRES = '2099-01-01T00:00:00.000Z';
const contextFor = (handle: SessionScope): ToolContext => ({ runId: handle.runId, taskId: handle.taskId, attemptId: handle.attemptId, grantId: `grant-${handle.attemptId}` });
export async function chromePin(): Promise<ChromeIdentity> { return discoverChromeIdentity(process.env.P2O_CHROME_LAUNCHER ?? '/usr/bin/google-chrome'); }

/** Actual explicit registration used by dispatch below. Mirrors the composition contract, no imaginary defaults. */
export async function environment(root: string, origin: string, pin: ChromeIdentity) {
  const inputRoot = path.join(root, 'inputs'), outputRoot = path.join(root, 'artifacts'), profileRoot = path.join(root, 'profiles'), workspace = path.join(root, 'workspace');
  for (const dir of [inputRoot, outputRoot, profileRoot, workspace]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const scope: Scope = {
    version: 1, runId: 'pack-lifecycle-run',
    authorization: { reference: 'loopback-only-lifecycle-test', approvedBy: 'fixture-owner', notBefore: '2000-01-01T00:00:00.000Z', expiresAt: EXPIRES },
    targets: [{ id: 'loopback', origins: [origin], pathPrefixes: ['/'], allowedCidrs: ['127.0.0.0/8'], methods: ['GET', 'HEAD'], actions: ['read'], accounts: ['anonymous'], limits: { maxRequests: 500, maxBytes: 10_000_000, maxConcurrent: 8, rate: { requests: 500, windowMs: 1000 } } }],
    exclusions: [], accounts: [{ id: 'anonymous', targetIds: ['loopback'], actions: ['read'], expiresAt: EXPIRES, kind: 'anonymous' }],
    grants: ['one', 'two'].map(attemptId => ({ id: `grant-${attemptId}`, taskId: 'lifecycle-task', attemptId, role: 'worker', capabilities: ['browser.session', 'browser.act', 'proxy.session', 'proxy.history'], targetIds: ['loopback'], actions: ['read'], accountIds: ['anonymous'], expiresAt: EXPIRES, maxCalls: 500, maxArtifactBytes: 10_000_000 })),
  };
  const policy = createPolicy(scope);
  const budgets = new TargetBudget(policy.scope.targets, { runId: scope.runId, freshRun: true, journal: { load: () => undefined, save: () => {} } });
  const sandbox = createHostBrowserSandbox({ inputRoot, outputRoot, trustedInputSnapshot: true, browser: { acknowledgement: 'host-browser-not-container-isolated', approvedBy: 'fixture-owner', expiresAt: EXPIRES, egress: 'loopback-only', profileRoot, maxSessions: 4, maxActionsPerSession: 64, maxRequestsPerSession: 64, sessionTtlMs: 60_000, identity: pin } });
  const preflight = await sandbox.preflight(); assert.equal(preflight.ok, true, JSON.stringify(preflight));
  const runtime = createHeadlessRuntime({ controlRoot: path.join(root, 'control'), piBinary: fileURLToPath(new URL('../runtime/fixtures/fake-pi.mjs', import.meta.url)), nodeBinary: process.execPath, startupTimeoutMs: 3000, pollMs: 25, stopGraceMs: 100,
    hooks: { ...filesystemHooks(path.join(root, 'control')), async validateResume(_checkpoint, request) {
      policy.assertActive(contextFor(request));
      return request.scopeDigest === policy.digest && request.inputDigest === 'inert-owned-input' && request.workspace === workspace;
    } },
    gateway: { approval: 'inert local fixture, no model calls', baseUrl: 'http://127.0.0.1:1/never-contacted', api: 'openai-completions', models: [{ id: 'inert', reasoning: true, contextWindow: 32000, maxTokens: 1024, thinkingLevelMap: { max: 'max' } }] } });
  const attempts = new Map<string, { browser: BrowserPack; proxy: ProxyPack }>();
  registerPackSessionFamily(runtime.sessions, { name: 'browser-pack', lookup: scope => attempts.get(scope.attemptId)?.browser,
    recover: (resources, scope, owner) => recoverBrowserResources(resources, scope, owner, profileRoot), shutdown: async () => { await Promise.all([...attempts.values()].map(pack => pack.browser.close())); } });
  registerPackSessionFamily(runtime.sessions, { name: 'proxy-pack', lookup: scope => attempts.get(scope.attemptId)?.proxy,
    recover: recoverControllerListeners, shutdown: async () => { await Promise.all([...attempts.values()].map(pack => pack.proxy.close())); } });
  const descriptors = createDefaultRegistry({ browser: true });
  const packsFor = (handle: RuntimeHandle) => {
    const cached = attempts.get(handle.attemptId); if (cached) return cached;
    const proxy = createProxyPack({ policy, budgets, sandbox, resolver: async () => ['127.0.0.1'], lifecycle: runtime.sessions.binding(handle, handle.ownerToken, 'proxy-pack') });
    const browser = createBrowserPack({ policy, budgets, sandbox, resolver: async () => ['127.0.0.1'], egressProxy: proxy.egressProxy, lifecycle: runtime.sessions.binding(handle, handle.ownerToken, 'browser-pack') });
    const created = { browser, proxy }; attempts.set(handle.attemptId, created); return created;
  };
  const request = async (mode: Record<string, unknown>, deadlineAt = Date.now() + 30_000): Promise<RuntimeRequest> => {
    await writeFile(path.join(workspace, 'fixture.json'), JSON.stringify(mode));
    return { runId: scope.runId, taskId: 'lifecycle-task', attemptId: 'one', workspace, scopeDigest: policy.digest, inputDigest: 'inert-owned-input', deadlineAt,
      requested: { provider: 'p2o-inert', model: 'inert', thinking: 'max' }, prompt: 'Local inert lifecycle fixture only; no model or target calls', toolPolicy: { mode: 'trusted-fixture', allowUnsandboxedHostTools: true, tools: [] } };
  };
  const ready = async (handle: RuntimeHandle) => waitFor(async () => { const state = await runtime.collect(handle); if (['failed', 'timed-out', 'quarantined'].includes(state.outcome)) throw new Error(JSON.stringify(state.handle)); return state.outcome === 'running' ? state.handle : undefined; }, 4000, 'inert worker executing');
  const open = async (handle: RuntimeHandle) => {
    const pack = packsFor(handle), context = contextFor(handle);
    const proxy = await pack.proxy.execute({ context, capability: 'proxy.session', input: { action: 'start', origins: [origin], accountId: 'anonymous' }, descriptor: descriptors.get('proxy.session'), touchedTargets: new Set() }) as ProxySessionEvidence;
    const browser = await pack.browser.execute({ context, capability: 'browser.session', input: { action: 'open', url: `${origin}/`, accountId: 'anonymous' }, descriptor: descriptors.get('browser.session'), touchedTargets: new Set() }) as BrowserSessionEvidence;
    const inspected = pack.browser.inspect(browser.browserId)!;
    const row = (await new LinuxProcessProbe().snapshot()).find(row => row.pid === inspected.pid); assert.ok(row);
    const family = ((await runtime.sessions.inventory(handle, 'browser-pack'))[0]!.data.processes ?? []) as ProcessIdentity[];
    const ports = [pack.proxy.inspect(proxy.proxyId)!.port, inspected.proxyPort, Number(new URL(inspected.endpoint).port)];
    return { pack, context, proxy, browser, inspected, identity: row as ProcessIdentity, family, ports };
  };
  const act = (handle: RuntimeHandle, browserId: string) => packsFor(handle).browser.execute({ context: contextFor(handle), capability: 'browser.act', input: { action: 'snapshot', browserId }, descriptor: descriptors.get('browser.act'), touchedTargets: new Set() });
  const history = (handle: RuntimeHandle, proxyId: string) => packsFor(handle).proxy.execute({ context: contextFor(handle), capability: 'proxy.history', input: { action: 'list', proxyId }, descriptor: descriptors.get('proxy.history'), touchedTargets: new Set() });
  const close = async () => { await runtime.shutdown(); };
  return { root, origin, runtime, attempts, request, ready, open, act, history, close, packsFor, workspace, profileRoot, policy, budgets, sandbox, descriptors };
}
