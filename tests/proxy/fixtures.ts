import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import type { TestContext } from 'node:test';
import { createPolicy, PolicyError, TargetBudget, type CapabilityGrant, type Scope, type TargetLimits, type ToolContext } from '../../src/policy/index.js';
import {
  createBrowserPack, createDefaultRegistry, createHostBrowserSandbox, createLocalFixtureSandbox, createProxyPack, createToolBroker,
  discoverChromeIdentity, type BrowserPack, type ChromeIdentity, type ExecutionSandbox, type ProxyPack, type ToolBroker, type ToolReceipt,
} from '../../src/tools/index.js';

export const EXPIRES = '2099-01-01T00:00:00.000Z';
export const contextA: ToolContext = { runId: 'proxy-run', taskId: 'proxy-task', attemptId: 'attempt-a', grantId: 'grant-a' };
export const contextB: ToolContext = { runId: 'proxy-run', taskId: 'proxy-task', attemptId: 'attempt-b', grantId: 'grant-b' };
export const code = (expected: string) => (error: unknown) => error instanceof PolicyError && error.code === expected;

export interface ScopeOptions { grantExpiresAt?: string; maxRequests?: number; maxBytes?: number; methods?: string[]; capabilities?: CapabilityGrant['capabilities'] }
/** Two-attempt scope: one target with the given origins, an anonymous account, and capture/repeat grants. */
export function proxyScope(origins: string[], options: ScopeOptions = {}): Scope {
  const limits: TargetLimits = { maxRequests: options.maxRequests ?? 500, maxBytes: options.maxBytes ?? 40_000_000, maxConcurrent: 8, rate: { requests: 500, windowMs: 1000 } };
  const grant = (id: string, attemptId: string, expiresAt: string): CapabilityGrant => ({
    id, taskId: 'proxy-task', attemptId, role: 'worker',
    capabilities: options.capabilities ?? ['proxy.session', 'proxy.history'], targetIds: ['fixture-target'], actions: ['read', 'mutate'], accountIds: ['anonymous'],
    expiresAt, maxCalls: 500, maxArtifactBytes: 40_000_000,
  });
  return {
    version: 1, runId: 'proxy-run',
    authorization: { reference: 'proxy-pack-owner-approval', approvedBy: 'fixture-owner', notBefore: '2000-01-01T00:00:00.000Z', expiresAt: EXPIRES },
    targets: [{
      id: 'fixture-target', origins, pathPrefixes: ['/'], allowedCidrs: ['127.0.0.0/8', '::1/128'],
      methods: options.methods ?? ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'],
      actions: ['read', 'mutate'], accounts: ['anonymous'], limits,
    }],
    exclusions: [{ origin: origins[0]!, pathPrefixes: ['/excluded'] }],
    accounts: [{ id: 'anonymous', targetIds: ['fixture-target'], actions: ['read', 'mutate'], expiresAt: EXPIRES, kind: 'anonymous' }],
    grants: [grant('grant-a', 'attempt-a', options.grantExpiresAt ?? EXPIRES), grant('grant-b', 'attempt-b', EXPIRES)],
  };
}

export interface ProxyRoots { inputRoot: string; outputRoot: string; profileRoot: string }
export async function roots(t: TestContext): Promise<ProxyRoots> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-proxy-fixture-'));
  const inputRoot = join(root, 'inputs'), outputRoot = join(root, 'outputs'), profileRoot = join(root, 'profiles');
  await mkdir(inputRoot, { mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  await mkdir(profileRoot, { mode: 0o700 });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { inputRoot, outputRoot, profileRoot };
}

export interface HttpFixture {
  origin: string;
  port: number;
  outsideOrigin: string;
  outsidePort: number;
  hits: { path: string; method: string; headers: IncomingMessage['headers'] }[];
  outsideHits: { path: string; method: string }[];
}
/** Two loopback origins: an in-scope app and an out-of-scope origin that must never be reached. */
export async function httpFixture(t: TestContext, outsideScript = true): Promise<HttpFixture> {
  const outsideHits: { path: string; method: string }[] = [];
  const outside: Server = createServer((request, response) => {
    outsideHits.push({ path: request.url ?? '/', method: request.method ?? 'GET' });
    response.end('outside');
  });
  await new Promise<void>(resolve => outside.listen(0, '127.0.0.1', () => resolve()));
  const outsidePort = (outside.address() as { port: number }).port;
  const outsideOrigin = `http://127.0.0.1:${outsidePort}`;
  const hits: { path: string; method: string; headers: IncomingMessage['headers'] }[] = [];
  const app: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?', 1)[0]!;
    hits.push({ path, method: request.method ?? 'GET', headers: request.headers });
    if (path === '/app') {
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><html><head><title>Proxy Fixture</title></head><body><div id="root">rendered</div><script>
${outsideScript ? `fetch('${outsideOrigin}/xhr').catch(() => {});` : ''}
</script></body></html>`);
      return;
    }
    if (path === '/json') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, path })); return; }
    if (path === '/echo') {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk as Buffer));
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ method: request.method, body: Buffer.concat(chunks).toString('utf8') }));
      });
      return;
    }
    if (path === '/redirect') { response.writeHead(302, { location: '/json' }); response.end(); return; }
    if (path === '/large') { response.setHeader('content-type', 'text/plain'); response.end('x'.repeat(65536)); return; }
    if (path === '/excluded/private') { response.end('excluded'); return; }
    response.setHeader('content-type', 'text/plain');
    response.end('fixture ok');
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', () => resolve()));
  const port = (app.address() as { port: number }).port;
  t.after(async () => {
    app.closeAllConnections(); outside.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
    await new Promise<void>(resolve => outside.close(() => resolve()));
  });
  return { origin: `http://127.0.0.1:${port}`, port, outsideOrigin, outsidePort, hits, outsideHits };
}

export interface ProxyFixtureOptions { scope: Scope; resolver?: (hostname: string, signal?: AbortSignal) => Promise<readonly string[]> }
export interface ProxyFixture {
  inputRoot: string; outputRoot: string; profileRoot: string;
  policy: ReturnType<typeof createPolicy>; budgets: TargetBudget; sandbox: ExecutionSandbox;
  pack: ProxyPack; broker: ToolBroker; receipts: ToolReceipt[];
}
export async function proxyFixture(t: TestContext, options: ProxyFixtureOptions): Promise<ProxyFixture> {
  const paths = await roots(t);
  const policy = createPolicy(options.scope);
  const budgets = new TargetBudget(policy.scope.targets);
  const sandbox = createLocalFixtureSandbox({ inputRoot: paths.inputRoot, outputRoot: paths.outputRoot, trustedInputSnapshot: true, acknowledgement: 'local-fixtures-only-not-hostile-code-isolation' });
  const pack = createProxyPack({ policy, budgets, sandbox, ...(options.resolver ? { resolver: options.resolver } : {}) });
  const registry = createDefaultRegistry();
  const receipts: ToolReceipt[] = [];
  const broker = createToolBroker({ policy, budgets, sandbox, registry, proxy: pack, receiptSink: receipt => { receipts.push(receipt); } });
  const preflight = await sandbox.preflight();
  if (!preflight.ok) throw new Error(`local-fixture preflight failed: ${preflight.checks.filter(check => !check.ok).map(check => check.name).join(',')}`);
  t.after(async () => { try { await pack.close(); } catch { /* already closed */ } });
  return { ...paths, policy, budgets, sandbox, pack, broker, receipts };
}

let pinCache: ChromeIdentity | undefined | null = null;
export async function chromePin(): Promise<ChromeIdentity | undefined> {
  if (pinCache !== null) return pinCache;
  try { pinCache = await discoverChromeIdentity(process.env.P2O_CHROME_LAUNCHER ?? '/usr/bin/google-chrome'); }
  catch { pinCache = undefined; }
  return pinCache;
}
export interface HostFixture { proxy: ProxyFixture; browsers: BrowserPack }
/** Host-browser boundary fixture: the browser pack routes through the proxy pack's capture listener. */
export async function hostFixture(t: TestContext, options: ProxyFixtureOptions): Promise<HostFixture | undefined> {
  const pin = await chromePin();
  if (!pin) return undefined;
  const paths = await roots(t);
  const policy = createPolicy(options.scope);
  const budgets = new TargetBudget(policy.scope.targets, {
    runId: policy.scope.runId, freshRun: true,
    journal: { load: () => undefined, save: () => { /* in-memory fixture */ } },
  });
  const sandbox = createHostBrowserSandbox({
    inputRoot: paths.inputRoot, outputRoot: paths.outputRoot, trustedInputSnapshot: true,
    browser: {
      acknowledgement: 'host-browser-not-container-isolated', approvedBy: 'fixture-owner', expiresAt: EXPIRES, egress: 'loopback-only', profileRoot: paths.profileRoot,
      maxSessions: 2, sessionTtlMs: 120000, maxActionsPerSession: 32, maxRequestsPerSession: 64, identity: pin,
    },
  });
  const pack = createProxyPack({ policy, budgets, sandbox, ...(options.resolver ? { resolver: options.resolver } : {}) });
  const browsers = createBrowserPack({ policy, budgets, sandbox, resolver: options.resolver ?? (async () => ['127.0.0.1']), egressProxy: pack.egressProxy });
  const registry = createDefaultRegistry({ browser: true });
  const receipts: ToolReceipt[] = [];
  const broker = createToolBroker({ policy, budgets, sandbox, registry, browser: browsers, proxy: pack, receiptSink: receipt => { receipts.push(receipt); } });
  const preflight = await sandbox.preflight();
  if (!preflight.ok) throw new Error(`host-browser preflight failed: ${preflight.checks.filter(check => !check.ok).map(check => check.name).join(',')}`);
  t.after(async () => { try { await browsers.close(); } catch { /* already closed */ } try { await pack.close(); } catch { /* already closed */ } });
  return { proxy: { ...paths, policy, budgets, sandbox, pack, broker, receipts }, browsers };
}

export interface ProxyResponse { status: number; headers: Record<string, string | string[] | undefined>; body: string }
/** Send one absolute-form request through a loopback capture proxy. */
export function viaProxy(proxyPort: number, url: string, options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<ProxyResponse> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = net.connect({ host: '127.0.0.1', port: proxyPort });
    const head = [`${options.method ?? 'GET'} ${url} HTTP/1.1`, `host: ${parsed.host}`];
    for (const [key, value] of Object.entries(options.headers ?? {})) head.push(`${key}: ${value}`);
    if (options.body !== undefined) head.push(`content-length: ${Buffer.byteLength(options.body)}`);
    head.push('connection: close', '', '');
    let settled = false;
    let raw = '';
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      request.destroy();
      if (error) { reject(error); return; }
      const at = raw.indexOf('\r\n\r\n');
      const headText = at === -1 ? raw : raw.slice(0, at);
      const body = at === -1 ? '' : raw.slice(at + 4);
      const [statusLine = '', ...headerLines] = headText.split('\r\n');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const line of headerLines) { const index = line.indexOf(':'); if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim(); }
      resolve({ status, headers, body });
    };
    request.on('data', chunk => { raw += chunk.toString('latin1'); });
    request.once('error', error => finish(error));
    request.once('close', () => finish());
    request.setTimeout(options.timeoutMs ?? 5000, () => finish(new Error('proxy client timeout')));
    request.once('connect', () => request.write(head.join('\r\n') + (options.body ?? '')));
  });
}
/** CONNECT-tunnel request used to prove HTTPS passthrough capture without TLS interception. */
export function tunnel(proxyPort: number, host: string, port: number, request: string, timeoutMs = 5000): Promise<{ status: number; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
    let stage: 'connect' | 'established' = 'connect';
    let head = '';
    let raw = '';
    let settled = false;
    const finish = (error?: Error, establishedStatus = 0) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) { reject(error); return; }
      resolve({ status: establishedStatus, response: raw });
    };
    socket.once('error', error => finish(error));
    socket.setTimeout(timeoutMs, () => finish(new Error('tunnel timeout')));
    socket.on('data', chunk => {
      if (stage === 'connect') {
        head += chunk.toString('latin1');
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) return;
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
        if (status !== 200) { finish(undefined, status); return; }
        stage = 'established';
        socket.write(request);
        return;
      }
      raw += chunk.toString('latin1');
      if (raw.includes('fixture ok')) finish(undefined, 200);
    });
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
  });
}
