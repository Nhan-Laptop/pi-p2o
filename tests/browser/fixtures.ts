import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createPolicy, PolicyError, TargetBudget, type BudgetJournal, type CapabilityGrant, type Scope, type TargetLimits, type ToolContext, type WebTarget } from '../../src/policy/index.js';
import {
  createBrowserPack, createDefaultRegistry, createHostBrowserSandbox, createToolBroker, discoverChromeIdentity,
  type BrowserPack, type BrowserSessionEvidence, type ChromeIdentity, type ExecutionSandbox, type ToolBroker, type ToolReceipt,
} from '../../src/tools/index.js';

export const EXPIRES = '2099-01-01T00:00:00.000Z';
export const contextA: ToolContext = { runId: 'browser-run', taskId: 'browser-task', attemptId: 'attempt-a', grantId: 'grant-a' };
export const contextB: ToolContext = { runId: 'browser-run', taskId: 'browser-task', attemptId: 'attempt-b', grantId: 'grant-b' };
export const code = (expected: string) => (error: unknown) => error instanceof PolicyError && error.code === expected;

let pinCache: ChromeIdentity | undefined | null = null;
/** The host Chrome pin, discovered once per test process; undefined when the host has no usable Chrome. */
export async function chromePin(): Promise<ChromeIdentity | undefined> {
  if (pinCache !== null) return pinCache;
  try { pinCache = await discoverChromeIdentity(process.env.P2O_CHROME_LAUNCHER ?? '/usr/bin/google-chrome'); }
  catch { pinCache = undefined; }
  return pinCache;
}

export interface LocalRoots { inputRoot: string; outputRoot: string; profileRoot: string }
export async function roots(t: TestContext, beforeRemove?: () => Promise<void>): Promise<LocalRoots> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-browser-fixture-'));
  const inputRoot = join(root, 'inputs'), outputRoot = join(root, 'outputs'), profileRoot = join(root, 'profiles');
  await mkdir(inputRoot, { mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  await mkdir(profileRoot, { mode: 0o700 });
  // Retry: a killed browser can still be flushing its profile for a moment, and rm can race that.
  t.after(async () => {
    await beforeRemove?.(); // preserve identity/recovery evidence until actual owned resources are closed
    for (let attempt = 0; attempt < 6; attempt++) {
      try { await rm(root, { recursive: true, force: true }); return; } catch { await new Promise(resolve => setTimeout(resolve, 150)); }
    }
  });
  return { inputRoot, outputRoot, profileRoot };
}

export interface JsFixture { origin: string; outsideOrigin: string; hits: { path: string; method: string }[]; outsideHits: { path: string; method: string }[] }
/** Two loopback origins: an in-scope JS-rendered app and an out-of-scope origin that must never be reached. */
export async function jsFixture(t: TestContext, inScopePathPrefix = ''): Promise<JsFixture> {
  const outsideHits: { path: string; method: string }[] = [];
  const outside: Server = createServer((request, response) => {
    outsideHits.push({ path: request.url ?? '/', method: request.method ?? 'GET' });
    response.end('outside');
  });
  await new Promise<void>(resolve => outside.listen(0, '127.0.0.1', () => resolve()));
  const outsideOrigin = `http://127.0.0.1:${(outside.address() as { port: number }).port}`;
  const hits: { path: string; method: string }[] = [];
  const app: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?', 1)[0]!;
    hits.push({ path, method: request.method ?? 'GET' });
    if (path === '/app') {
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><html><head><title>JS Fixture</title></head><body>
<div id="root">loading</div>
<script>
  const root = document.getElementById('root');
  const status = document.createElement('p'); status.id = 'status'; status.textContent = 'rendered-by-js'; document.body.appendChild(status);
  const form = document.createElement('form'); form.id = 'form';
  const input = document.createElement('input'); input.type = 'text'; input.placeholder = 'Name'; input.id = 'name';
  input.addEventListener('input', () => { root.textContent = 'typed:' + input.value; input.setAttribute('data-value', input.value); });
  const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Say hi';
  button.addEventListener('click', () => { root.textContent = 'clicked:' + input.value; });
  form.appendChild(input); form.appendChild(button); document.body.appendChild(form);
  root.textContent = 'rendered-by-js';
  fetch('${outsideOrigin}/xhr').catch(() => {});
  const image = new Image(); image.src = '${outsideOrigin}/pixel.png';
  try { new WebSocket('ws://127.0.0.1:${(outside.address() as { port: number }).port}/ws'); } catch (e) {}
</script></body></html>`);
      return;
    }
    if (path === '/redir') { response.writeHead(302, { location: `${outsideOrigin}/redirected` }); response.end(); return; }
    if (path === '/excluded/private') { response.end('excluded'); return; }
    if (path === '/text') { response.setHeader('content-type', 'text/plain'); response.end(inScopePathPrefix + 'plain fixture text'); return; }
    response.end('fixture ok');
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  t.after(async () => {
    app.closeAllConnections(); outside.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
    await new Promise<void>(resolve => outside.close(() => resolve()));
  });
  return { origin, outsideOrigin, hits, outsideHits };
}

export interface ScopeOptions { grantExpiresAt?: string; maxRequests?: number; maxBytes?: number; origins?: string[]; accountIds?: string[]; actions?: ('read' | 'mutate')[] }
export function browserScope(origins: string[], options: ScopeOptions = {}): Scope {
  const limits: TargetLimits = { maxRequests: options.maxRequests ?? 500, maxBytes: options.maxBytes ?? 20000000, maxConcurrent: 8, rate: { requests: 500, windowMs: 1000 } };
  const grant = (id: string, attemptId: string, expiresAt: string): CapabilityGrant => ({
    id, taskId: 'browser-task', attemptId, role: 'worker',
    capabilities: ['browser.session', 'browser.act'],
    targetIds: ['fixture-target'], actions: options.actions ?? ['read', 'mutate'], accountIds: options.accountIds ?? ['anonymous'],
    expiresAt, maxCalls: 500, maxArtifactBytes: 20000000,
  });
  return {
    version: 1, runId: 'browser-run',
    authorization: { reference: 'browser-pack-owner-approval', approvedBy: 'fixture-owner', notBefore: '2000-01-01T00:00:00.000Z', expiresAt: EXPIRES },
    targets: [{
      id: 'fixture-target', origins, pathPrefixes: ['/'], allowedCidrs: ['127.0.0.0/8', '::1/128'],
      methods: ['GET', 'HEAD', 'OPTIONS', 'POST'], actions: ['read', 'mutate'],
      accounts: options.accountIds ?? ['anonymous'], limits,
    }],
    exclusions: [{ origin: origins[0]!, pathPrefixes: ['/excluded'] }],
    accounts: (options.accountIds ?? ['anonymous']).map(id => ({ id, targetIds: ['fixture-target'], actions: options.actions ?? ['read', 'mutate'], expiresAt: EXPIRES, kind: id === 'anonymous' ? 'anonymous' as const : 'credential' as const })),
    grants: [grant('grant-a', 'attempt-a', options.grantExpiresAt ?? EXPIRES), grant('grant-b', 'attempt-b', EXPIRES)],
  };
}
/** Synchronous in-memory budget journal: host-browser mode demands durable supervisor-owned counters. */
export function memoryBudget(targets: readonly WebTarget[], runId: string): TargetBudget {
  const state = new Map<string, unknown>();
  const journal: BudgetJournal = {
    load: id => state.get(id),
    save: value => { state.set(value.runId, JSON.parse(JSON.stringify(value)) as unknown); },
  };
  return new TargetBudget(targets, { runId, journal, freshRun: true });
}

export interface BrowserFixtureOptions {
  scope: Scope;
  resolver?: (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;
  identity?: ChromeIdentity;
  maxSessions?: number;
  sessionTtlMs?: number;
  maxActionsPerSession?: number;
  maxRequestsPerSession?: number;
  browserEnabled?: boolean;
}
export interface BrowserFixture {
  inputRoot: string; outputRoot: string; profileRoot: string;
  policy: ReturnType<typeof createPolicy>; budgets: TargetBudget; sandbox: ExecutionSandbox;
  registry: ReturnType<typeof createDefaultRegistry>; pack: BrowserPack; broker: ToolBroker; receipts: ToolReceipt[]; pin: ChromeIdentity;
}
export async function browserFixture(t: TestContext, options: BrowserFixtureOptions): Promise<BrowserFixture> {
  const pin = options.identity ?? await chromePin();
  if (!pin) throw new Error('host Chrome is required for the browser pack tests');
  let ownedPack: BrowserPack | undefined;
  const paths = await roots(t, async () => { await ownedPack?.close(); });
  const policy = createPolicy(options.scope);
  const budgets = memoryBudget(policy.scope.targets, policy.scope.runId);
  const sandbox = createHostBrowserSandbox({
    ...paths, trustedInputSnapshot: true,
    browser: {
      acknowledgement: 'host-browser-not-container-isolated', approvedBy: 'fixture-owner', expiresAt: EXPIRES, egress: 'loopback-only', profileRoot: paths.profileRoot,
      maxSessions: options.maxSessions ?? 2, sessionTtlMs: options.sessionTtlMs ?? 120000,
      maxActionsPerSession: options.maxActionsPerSession ?? 64, maxRequestsPerSession: options.maxRequestsPerSession ?? 64,
      identity: pin,
    },
  });
  const pack = ownedPack = createBrowserPack({ policy, budgets, sandbox, resolver: options.resolver ?? (async () => ['127.0.0.1']) });
  const registry = createDefaultRegistry(options.browserEnabled === false ? {} : { browser: true });
  const receipts: ToolReceipt[] = [];
  const broker = createToolBroker({
    policy, budgets, sandbox, registry, browser: pack,
    ...(options.resolver ? { resolver: options.resolver } : {}),
    receiptSink: receipt => { receipts.push(receipt); },
  });
  const preflight = await sandbox.preflight();
  if (!preflight.ok) throw new Error(`host-browser sandbox preflight failed: ${preflight.checks.filter(c => !c.ok).map(c => c.name).join(',')}`);
  // The root's beforeRemove barrier closes the pack first. Failed teardown now fails the test and
  // retains the identity files; it is never swallowed before deleting the only recovery evidence.
  return { ...paths, policy, budgets, sandbox, registry, pack, broker, receipts, pin };
}

export const openSession = async (f: BrowserFixture, url: string, context: ToolContext = contextA): Promise<BrowserSessionEvidence> =>
  await f.broker.execute({ context, tool: 'browser.session', input: { action: 'open', url, accountId: 'anonymous' } }).then(result => result.data as BrowserSessionEvidence);
export const act = async (f: BrowserFixture, browserId: string, input: Record<string, unknown>, context: ToolContext = contextA) =>
  await f.broker.execute({ context, tool: 'browser.act', input: { browserId, ...input } });
