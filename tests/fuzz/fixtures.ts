import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createPolicy, PolicyError, TargetBudget, type Action, type Capability, type Scope, type ToolContext } from '../../src/policy/index.js';
import { createDefaultRegistry, createLocalFixtureSandbox, createToolBroker, type ApprovedFuzzTemplate, type CapabilityRegistry, type ToolReceipt } from '../../src/tools/index.js';

export const fuzzContext: ToolContext = { runId: 'fuzz-run', taskId: 'fuzz-task', attemptId: 'fuzz-attempt', grantId: 'fuzz-grant' };
export const NEGATIVE_NOW = '2026-10-02T12:00:00.000Z';
export const EXPIRES_AT = '2099-10-02T13:00:00.000Z';
export const code = (expected: string) => (error: unknown) => error instanceof PolicyError && error.code === expected;

export const FIXTURE_MODULES = ['strict-header.mjs', 'lenient-header.mjs', 'oracle-header.mjs'] as const;

export function fuzzScope(origin: string, options: { capabilities?: readonly Capability[]; actions?: readonly Action[]; methods?: readonly string[]; maxRequests?: number } = {}): Scope {
  const capabilities = options.capabilities ?? ['fuzz.differential', 'fuzz.template', 'http.request'];
  const actions = options.actions ?? ['analyze', 'read', 'mutate'];
  const methods = options.methods ?? ['GET', 'HEAD', 'OPTIONS', 'POST'];
  return {
    version: 1, runId: fuzzContext.runId,
    authorization: { reference: 'fuzz-fixture-owner-approval', approvedBy: 'fixture-owner', notBefore: NEGATIVE_NOW, expiresAt: EXPIRES_AT },
    targets: [{
      id: 'fixture-target', origins: [origin], pathPrefixes: ['/'], allowedCidrs: ['127.0.0.0/8', '::1/128'], excludedCidrs: ['127.0.0.9/32'],
      methods: [...methods], actions: [...actions], accounts: ['anonymous'],
      limits: { maxRequests: options.maxRequests ?? 100, maxBytes: 20000000, maxConcurrent: 4, rate: { requests: 100, windowMs: 1000 } },
    }],
    exclusions: [],
    accounts: [{ id: 'anonymous', targetIds: ['fixture-target'], actions: [...actions], expiresAt: EXPIRES_AT, kind: 'anonymous' }],
    grants: [{
      id: fuzzContext.grantId, taskId: fuzzContext.taskId, attemptId: fuzzContext.attemptId, role: 'worker',
      capabilities: [...capabilities], targetIds: ['fixture-target'], actions: [...actions], accountIds: ['anonymous'],
      expiresAt: EXPIRES_AT, maxCalls: 500, maxArtifactBytes: 20000000,
    }],
  };
}

export async function fuzzRoots(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-fuzz-fixture-'));
  const inputRoot = join(root, 'inputs'), outputRoot = join(root, 'outputs');
  await mkdir(inputRoot, { mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, inputRoot, outputRoot, trustedInputSnapshot: true as const };
}

export async function writeFixtureModules(inputRoot: string): Promise<void> {
  for (const name of FIXTURE_MODULES) await writeFile(join(inputRoot, name), await readFile(new URL(`./fixtures/${name}`, import.meta.url)));
}

export interface TemplateHit { readonly method: string; readonly path: string; readonly query: readonly string[]; readonly q: string; readonly accept: string; readonly body: string }

/** Loopback fixture with a single approved path; every hit is recorded so tests can prove what was sent. */
export async function templateFixture(t: TestContext) {
  const hits: TemplateHit[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const q = url.searchParams.get('q') ?? '';
      const accept = String(request.headers.accept ?? '');
      hits.push({ method: request.method ?? '', path: url.pathname, query: [...url.searchParams.keys()], q, accept, body });
      if (q.includes('ERR')) { response.writeHead(500, { 'content-type': 'text/plain' }); response.end('error'); return; }
      if (q.includes('BIG')) { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('y'.repeat(4096)); return; }
      if (q.includes('JSON') || accept.includes('application/json')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, q })); return; }
      if (body) { response.writeHead(200, { 'content-type': 'text/plain' }); response.end(`echo:${body}`); return; }
      response.writeHead(200, { 'content-type': 'text/plain' }); response.end('base');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { origin: `http://127.0.0.1:${port}`, hits };
}

export async function fuzzBroker(t: TestContext, scope: Scope, options: { templates?: readonly ApprovedFuzzTemplate[]; registry?: CapabilityRegistry } = {}) {
  const paths = await fuzzRoots(t);
  const policy = createPolicy(scope);
  const budgets = new TargetBudget(policy.scope.targets);
  const sandbox = createLocalFixtureSandbox({ ...paths, acknowledgement: 'local-fixtures-only-not-hostile-code-isolation' });
  const receipts: ToolReceipt[] = [];
  const registry = options.registry ?? createDefaultRegistry({ fuzz: true });
  const broker = createToolBroker({
    policy, budgets, sandbox, registry,
    ...(options.templates ? { fuzz: { templates: options.templates } } : {}),
    receiptSink: receipt => { receipts.push(receipt); },
  });
  return { ...paths, broker, policy, budgets, sandbox, receipts, registry };
}

export function queryTemplate(origin: string, overrides: Partial<ApprovedFuzzTemplate> = {}): ApprovedFuzzTemplate {
  return {
    id: 'tpl-query', accountId: 'anonymous', method: 'GET', url: `${origin}/tpl?q=base`,
    query: [{ name: 'q', base: 'base', tokens: ['BIG', 'ERR', 'JSON', 'x'], maxLength: 32 }],
    headers: [{ name: 'accept', base: 'text/plain', tokens: ['application/json', '*/*'], maxLength: 32 }],
    maxRequests: 16, rate: { requests: 16, windowMs: 60000 }, approvedBy: 'fixture-owner', expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

export function bodyTemplate(origin: string, overrides: Partial<ApprovedFuzzTemplate> = {}): ApprovedFuzzTemplate {
  return {
    id: 'tpl-body', accountId: 'anonymous', method: 'POST', url: `${origin}/tpl?q=base`,
    query: [], headers: [], body: { base: 'base', tokens: ['{"a":1}', 'BIG', 'ERR'], maxLength: 64 },
    maxRequests: 8, rate: { requests: 8, windowMs: 60000 }, approvedBy: 'fixture-owner', expiresAt: EXPIRES_AT,
    ...overrides,
  };
}
