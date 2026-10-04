/**
 * Raw evidence generator for docs/architecture/proxy-pack.md. It runs the acceptance scenarios against the
 * two-origin local fixture and prints the exact redacted observations a worker receives. Run it with
 * `node tests/proxy/evidence.mjs`; no target outside 127.0.0.1 is contacted and nothing is written to the
 * repository.
 */
import type { TestContext } from 'node:test';
import { contextA, httpFixture, proxyFixture, proxyScope, tunnel, viaProxy } from './fixtures.js';
import type { ProxyHistoryEvidence, ProxySessionEvidence } from '../../src/tools/index.js';

const cleanups: (() => Promise<void> | void)[] = [];
const t = { after: (hook: () => Promise<void> | void) => { cleanups.push(hook); } } as unknown as TestContext;
const show = (label: string, value: unknown): void => { console.log(`\n### ${label}\n${JSON.stringify(value, null, 2)}`); };
const capture = async (port: number, url: string, options: Parameters<typeof viaProxy>[2] = {}) => {
  const response = await viaProxy(port, url, options);
  console.log(`\n→ ${options.method ?? 'GET'} ${url} (through the capture proxy)\n← HTTP ${response.status} ${JSON.stringify(response.body.slice(0, 120))}`);
  return response;
};

const fixture = await httpFixture(t);
const f = await proxyFixture(t, { scope: proxyScope([fixture.origin, `https://127.0.0.1:${fixture.port}`]) });
const started = (await f.broker.execute({ context: contextA, tool: 'proxy.session', input: { action: 'start', accountId: 'anonymous', origins: [fixture.origin, `https://127.0.0.1:${fixture.port}`] } })).data as ProxySessionEvidence;
const port = f.pack.inspect(started.proxyId)!.port;
show('proxy.session start (worker-visible evidence)', started);

console.log(`\n=== 1. two-origin capture: allowed traffic is captured, non-scope is refused before egress ===`);
await capture(port, `${fixture.origin}/app`, { headers: { authorization: 'Bearer fixture-secret-token-value', cookie: 'fixture=session-secret' } });
await capture(port, `${fixture.outsideOrigin}/xhr`);
show('out-of-scope origin hits (must be empty)', fixture.outsideHits);
console.log(`\n=== 1b. HTTPS passthrough (CONNECT) capture without MITM ===`);
const tunneled = await tunnel(port, '127.0.0.1', fixture.port, `GET /tunnel HTTP/1.1\r\nhost: 127.0.0.1:${fixture.port}\r\nconnection: close\r\n\r\n`);
console.log(`CONNECT 127.0.0.1:${fixture.port} → HTTP ${tunneled.status}; tunneled body reached the fixture: ${tunneled.response.includes('fixture ok')}`);
const blockedTunnel = await tunnel(port, '127.0.0.1', fixture.outsidePort, 'GET / HTTP/1.1\r\n\r\n');
console.log(`CONNECT 127.0.0.1:${fixture.outsidePort} (out of scope) → HTTP ${blockedTunnel.status}`);
const list = (await f.broker.execute({ context: contextA, tool: 'proxy.history', input: { action: 'list', proxyId: started.proxyId, limit: 10 } })).data as ProxyHistoryEvidence;
show('proxy.history list', list);

console.log(`\n=== 2. list/view/repeat round-trip with evidence digests ===`);
const original = list.entries!.find(entry => entry.url.endsWith('/app'))!;
const viewed = (await f.broker.execute({ context: contextA, tool: 'proxy.history', input: { action: 'view', proxyId: started.proxyId, requestId: original.id } })).data as ProxyHistoryEvidence;
show('proxy.history view (bounded headers, redacted, body digests)', viewed);
const repeated = (await f.broker.execute({ context: contextA, tool: 'proxy.history', input: { action: 'repeat', proxyId: started.proxyId, requestId: original.id, method: 'POST', url: `${fixture.origin}/echo`, body: '{"hello":"world"}', headers: { 'content-type': 'application/json' } } })).data as ProxyHistoryEvidence;
show('proxy.history repeat (method/path/body modified, host/account unchanged)', repeated.repeat);
const replayView = (await f.broker.execute({ context: contextA, tool: 'proxy.history', input: { action: 'view', proxyId: started.proxyId, requestId: repeated.repeat!.id } })).data as ProxyHistoryEvidence;
show('replayed record', replayView.entry);
for (const attempt of [
  { label: 'cross-origin repeat', input: { url: `${fixture.outsideOrigin}/xhr` } },
  { label: 'host header override', input: { headers: { host: 'outside.test' } } },
  { label: 'cookie header override', input: { headers: { cookie: 'stolen=1' } } },
  { label: 'excluded path', input: { url: `${fixture.origin}/excluded/private` } },
]) {
  try { await f.broker.execute({ context: contextA, tool: 'proxy.history', input: { action: 'repeat', proxyId: started.proxyId, requestId: original.id, ...attempt.input } }); }
  catch (error) { console.log(`refused: ${attempt.label} → ${(error as { code?: string }).code}`); }
}

console.log(`\n=== 3. sitemap aggregation and explicit scope decisions ===`);
await capture(port, `${fixture.origin}/json`);
await capture(port, `${fixture.origin}/json`);
await capture(port, `${fixture.origin}/redirect`);
show('proxy.history sitemap', ((await f.broker.execute({ context: contextA, tool: 'proxy.history', input: { action: 'sitemap', proxyId: started.proxyId } })).data as ProxyHistoryEvidence).sitemap);
show('proxy.history scope_rules', ((await f.broker.execute({ context: contextA, tool: 'proxy.history', input: { action: 'scope_rules', proxyId: started.proxyId } })).data as ProxyHistoryEvidence).scope);

console.log(`\n=== 4. session request budget exhaustion refuses before egress ===`);
const budgeted = (await f.broker.execute({ context: contextA, tool: 'proxy.session', input: { action: 'start', accountId: 'anonymous', origins: [fixture.origin], maxRequests: 2 } })).data as ProxySessionEvidence;
const budgetPort = f.pack.inspect(budgeted.proxyId)!.port;
for (let index = 1; index <= 3; index += 1) await capture(budgetPort, `${fixture.origin}/json`);
const budgetedList = (await f.broker.execute({ context: contextA, tool: 'proxy.history', input: { action: 'list', proxyId: budgeted.proxyId } })).data as ProxyHistoryEvidence;
show('budgeted session history (third request refused)', budgetedList);
console.log(`target hits for /json: ${fixture.hits.filter(hit => hit.path === '/json').length}`);

console.log(`\n=== 5. session killed on release and unusable afterwards ===`);
show('release receipt', await f.pack.releaseAttempt(contextA));
show('proxy.session status after release', (await f.broker.execute({ context: contextA, tool: 'proxy.session', input: { action: 'status', proxyId: started.proxyId } })).data);
for (const [label, work] of [
  ['proxy.history on a released session', () => f.broker.execute({ context: contextA, tool: 'proxy.history', input: { action: 'list', proxyId: started.proxyId } })],
  ['another attempt reusing the handle', () => f.broker.execute({ context: { ...contextA, attemptId: 'attempt-b', grantId: 'grant-b' }, tool: 'proxy.session', input: { action: 'status', proxyId: started.proxyId } })],
  ['loopback listener after release', () => viaProxy(port, `${fixture.origin}/json`, { timeoutMs: 2000 })],
] as const) {
  try { await work(); console.log(`unexpected success: ${label}`); }
  catch (error) { console.log(`refused: ${label} → ${(error as { code?: string }).code}`); }
}
show('live sessions after release', f.pack.sessions);

for (const cleanup of cleanups.reverse()) await cleanup();
