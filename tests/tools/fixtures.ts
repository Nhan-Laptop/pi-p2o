import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { TestContext } from 'node:test';
import { createPolicy, PolicyError, TargetBudget, type Scope } from '../../src/policy/index.js';
import { createDefaultRegistry, createLocalFixtureSandbox, createToolBroker, type ToolBrokerOptions, type ToolReceipt } from '../../src/tools/index.js';
import { context, fixtureScope } from '../policy/fixture.js';

export { context, fixtureScope };
export const code = (expected: string) => (e: unknown) => e instanceof PolicyError && e.code === expected;
export function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
export async function roots(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-tools-fixture-'));
  const inputRoot = join(root, 'inputs'), outputRoot = join(root, 'outputs');
  await mkdir(inputRoot, { mode: 0o700 }); await mkdir(outputRoot, { mode: 0o700 });
  await writeFile(join(inputRoot, 'app.ts'), `import http from 'node:http';\nexport const version = 1;\napp.get('/ok', handler);\nconst password = "fixture-only-secret";\nthrow new Error('SOURCE MUST NEVER EXECUTE');\n`);
  await writeFile(join(inputRoot, 'package.json'), JSON.stringify({ scripts: { postinstall: 'NEVER RUN' }, dependencies: { 'fixture-dep': '1.2.3' } }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, inputRoot, outputRoot, trustedInputSnapshot: true as const };
}
export async function webFixture(t: TestContext) {
  const hits: { path: string; method: string; headers: Record<string, unknown> }[] = [];
  const held = deferred(); const release = deferred();
  const server = createServer(async (req, res) => {
    const path = req.url ?? '/'; hits.push({ path, method: req.method ?? '', headers: req.headers });
    res.setHeader('content-type', 'text/plain');
    if (path === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end('redirect'); }
    else if (path === '/escape') { res.writeHead(302, { location: '/excluded/private' }); res.end('blocked'); }
    else if (path === '/cross') { res.writeHead(302, { location: `http://127.0.0.1:${(server.address() as { port: number }).port + 1}/unapproved` }); res.end('cross'); }
    else if (path === '/ambiguous') { res.writeHead(302, { location: '/%252fexcluded' }); res.end('ambiguous'); }
    else if (path === '/loop') { res.writeHead(302, { location: '/loop' }); res.end('loop'); }
    else if (path === '/large') { res.end('x'.repeat(131072)); }
    else if (path === '/hold') { held.resolve(); await release.promise; if (!res.destroyed) res.end('released'); }
    else if (path === '/page') { res.setHeader('content-type', 'text/html'); res.end('<title>Fixture</title><a href="/ok">ok</a><a href="/excluded/x">blocked</a><a href="http://outside.test/">outside</a><form method="POST" action="/mutate"></form><script>fetch("http://outside.test/")</script><img src="/never-fetch">'); }
    else if (path === '/schema') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ openapi: '3.0.3', servers: [{ url: 'http://outside.test/' }], paths: { '/ok': { get: {} }, '/mutate': { post: {} }, '/users/{id}': { get: {} }, '/excluded/x': { get: {} } }, components: { schemas: { Remote: { $ref: 'http://outside.test/secret-schema' } } } })); }
    else if (path === '/auth') { res.setHeader('set-cookie', 'session=fixture-cookie-secret; HttpOnly'); res.end(`echo ${req.headers.authorization ?? 'anonymous'} fixture-cookie-secret`); }
    else { res.end('fixture ok'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  t.after(async () => { release.resolve(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { origin: `http://127.0.0.1:${port}`, port, hits, held, release };
}
export async function brokerFixture(t: TestContext, scope: Scope, options: Partial<ToolBrokerOptions> = {}, limits: Parameters<typeof createDefaultRegistry>[0] = {}) {
  const paths = await roots(t);
  const policy = createPolicy(scope), budgets = new TargetBudget(policy.scope.targets);
  const sandbox = createLocalFixtureSandbox({ ...paths, acknowledgement: 'local-fixtures-only-not-hostile-code-isolation' });
  const receipts: ToolReceipt[] = [];
  const broker = createToolBroker({ policy, budgets, sandbox, registry: createDefaultRegistry(limits), receiptSink: receipt => { receipts.push(receipt); }, ...options });
  return { ...paths, broker, policy, budgets, sandbox, receipts };
}
