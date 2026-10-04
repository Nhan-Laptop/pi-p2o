import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPolicy, TargetBudget } from '../../src/policy/index.js';
import { createToolBroker, ToolExecutionError, type HttpEvidence } from '../../src/tools/index.js';
import { brokerFixture, code, context, deferred, fixtureScope, webFixture } from './fixtures.js';

const input = (url: string) => ({ url, accountId: 'anonymous' });
test('allowed request produces redacted hashed private evidence and immutable collector receipt', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin));
  const result = await f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/ok`) });
  const data = result.data as HttpEvidence;
  assert.equal(data.status, 200); assert.equal(data.body, 'fixture ok'); assert.equal(web.hits.length, 1);
  assert.equal(data.hops[0]!.pinnedAddress, '127.0.0.1'); assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(f.outputRoot, result.artifact.path), 'utf8'), JSON.stringify(result.data));
  assert.equal(result.receipt.budgets['fixture-target']!.requests, 1); assert.equal(result.receipt.classification, 'observation-not-verified-finding');
  assert.throws(() => (result.receipt.targets as string[]).push('invented'), TypeError); assert.equal(f.receipts.length, 1);
});
test('denied destinations/accounts/mutations/headers/schema cause no fixture requests', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin));
  const cases: [unknown, string][] = [
    [input(`${web.origin}/excluded/x`), 'TARGET_DENIED'],
    [{ ...input(`${web.origin}/ok`), accountId: 'foreign' }, 'ACCOUNT_DENIED'],
    [{ ...input(`${web.origin}/ok`), method: 'POST' }, 'ACTION_DENIED'],
    [{ ...input(`${web.origin}/ok`), headers: { Host: 'outside.test' } }, 'ACCOUNT_DENIED'],
    [{ ...input(`${web.origin}/ok`), headers: { authorization: 'Bearer worker-secret' } }, 'ACCOUNT_DENIED'],
    [{ ...input(`${web.origin}/ok`), shell: 'curl outside.test' }, 'INVALID_INPUT'],
    [{ ...input(`${web.origin}/ok`), maxRedirects: 99 }, 'INVALID_INPUT'],
  ];
  for (const [v, expected] of cases) await assert.rejects(f.broker.execute({ context, tool: 'http.request', input: v }), code(expected));
  assert.equal(web.hits.length, 0); assert.equal(f.budgets.snapshot('fixture-target').active, 0);
  assert.equal(f.receipts.length, cases.length);
});
test('same-origin redirects are separately authorized, DNS checked and budgeted', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin));
  const result = await f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/redirect`) });
  assert.equal((result.data as HttpEvidence).hops.length, 2); assert.deepEqual(web.hits.map(h => h.path), ['/redirect', '/ok']);
  assert.equal(f.budgets.snapshot('fixture-target').requests, 2);
});
test('excluded, cross-origin, ambiguous and state-changing redirects cannot escape authority', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin));
  for (const [path, expected] of [['/escape', 'TARGET_DENIED'], ['/cross', 'REDIRECT_DENIED'], ['/ambiguous', 'REDIRECT_DENIED']] as const) await assert.rejects(f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}${path}`) }), code(expected));
  await assert.rejects(f.broker.execute({ context, tool: 'http.request', input: { ...input(`${web.origin}/redirect`), method: 'POST', action: 'mutate', body: '{}' } }), code('REDIRECT_DENIED'));
  assert.deepEqual(web.hits.map(h => h.path), ['/escape', '/cross', '/ambiguous', '/redirect']);
  assert.equal(f.budgets.snapshot('fixture-target').active, 0);
});
test('redirect loops stop at exact cap with no unbounded replay', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin));
  await assert.rejects(f.broker.execute({ context, tool: 'http.request', input: { ...input(`${web.origin}/loop`), maxRedirects: 1 } }), code('REDIRECT_DENIED'));
  assert.equal(web.hits.length, 2);
});
test('connection-time DNS change inside allowed CIDR fails before sending HTTP', async t => {
  const web = await webFixture(t), origin = `http://fixture.test:${web.port}`;
  let calls = 0;
  const f = await brokerFixture(t, fixtureScope(origin), { resolver: async hostname => { assert.equal(hostname, 'fixture.test'); return ++calls === 1 ? ['127.0.0.1'] : ['127.0.0.2']; } });
  await assert.rejects(f.broker.execute({ context, tool: 'http.request', input: input(`${origin}/ok`) }), code('DNS_CHANGED'));
  assert.equal(calls, 2); assert.equal(web.hits.length, 0); assert.equal(f.budgets.snapshot('fixture-target').requests, 1); assert.equal(f.budgets.snapshot('fixture-target').active, 0);
});
test('one denied answer in DNS set, rebinding to denied address, and fixture non-loopback are rejected', async t => {
  const web = await webFixture(t), origin = `http://fixture.test:${web.port}`;
  const mixed = await brokerFixture(t, fixtureScope(origin), { resolver: async () => ['127.0.0.1', '192.0.2.1'] });
  await assert.rejects(mixed.broker.execute({ context, tool: 'http.request', input: input(`${origin}/ok`) }), code('ADDRESS_DENIED'));
  let calls = 0; const rebound = await brokerFixture(t, fixtureScope(origin), { resolver: async () => ++calls === 1 ? ['127.0.0.1'] : ['169.254.169.254'] });
  await assert.rejects(rebound.broker.execute({ context, tool: 'http.request', input: input(`${origin}/ok`) }), code('ADDRESS_DENIED'));
  const scope = fixtureScope(origin); scope.targets[0]!.allowedCidrs.push('192.0.2.0/24');
  const external = await brokerFixture(t, scope, { resolver: async () => ['192.0.2.1'] });
  await assert.rejects(external.broker.execute({ context, tool: 'http.request', input: input(`${origin}/ok`) }), code('ADDRESS_DENIED'));
  assert.equal(web.hits.length, 0);
});
test('DNS is rechecked on subsequent calls and redirect hops, with stable order independent sets', async t => {
  const web = await webFixture(t), origin = `http://fixture.test:${web.port}`;
  let calls = 0;
  const f = await brokerFixture(t, fixtureScope(origin), { resolver: async () => ++calls <= 2 ? ['127.0.0.1', '127.0.0.2'] : ['127.0.0.2', '127.0.0.1'] });
  const result = await f.broker.execute({ context, tool: 'http.request', input: input(`${origin}/redirect`) });
  assert.equal((result.data as HttpEvidence).hops.length, 2); assert.equal(calls, 4);
  const p = createPolicy(fixtureScope(origin)); const budgets = new TargetBudget(p.scope.targets);
  const denied = createToolBroker({ policy: p, budgets, sandbox: f.sandbox, resolver: async () => ['127.0.0.9'] });
  await assert.rejects(denied.execute({ context, tool: 'http.request', input: input(`${origin}/ok`) }), code('ADDRESS_DENIED'));
});
test('approved credentials come only from supervisor and are redacted from body, headers, artifact and receipt', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin), { credentials: { headers: async r => { assert.equal(r.accountId, 'approved-user'); assert.equal(r.origin, web.origin); return { Authorization: 'Bearer fixture-auth-secret', Cookie: 'session=fixture-cookie-secret' }; } } });
  const result = await f.broker.execute({ context, tool: 'http.request', input: { url: `${web.origin}/auth`, accountId: 'approved-user' } });
  assert.equal(web.hits[0]!.headers.authorization, 'Bearer fixture-auth-secret');
  assert.doesNotMatch(JSON.stringify(result), /fixture-auth-secret|fixture-cookie-secret/);
  assert.doesNotMatch(await readFile(join(f.outputRoot, result.artifact.path), 'utf8'), /fixture-auth-secret|fixture-cookie-secret/);
  assert.match((result.data as HttpEvidence).body, /REDACTED/);
});
test('target requests and rate limits are shared across two brokers/workers, not per adapter', async t => {
  const web = await webFixture(t), scope = fixtureScope(web.origin); scope.targets[0]!.limits.maxRequests = 2;
  const f = await brokerFixture(t, scope);
  const other = createToolBroker({ policy: f.policy, budgets: f.budgets, sandbox: f.sandbox });
  await f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/ok`) });
  await other.execute({ context, tool: 'web.observe', input: input(`${web.origin}/page`) });
  await assert.rejects(f.broker.execute({ context, tool: 'api.map', input: input(`${web.origin}/schema`) }), code('BUDGET_EXCEEDED'));
  assert.equal(web.hits.length, 2);
  const rateScope = fixtureScope(web.origin); rateScope.targets[0]!.limits.rate = { requests: 1, windowMs: 60000 };
  const r = await brokerFixture(t, rateScope); await r.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/ok`) });
  await assert.rejects(r.broker.execute({ context, tool: 'web.observe', input: input(`${web.origin}/page`) }), code('RATE_LIMITED'));
});
test('cancellation destroys in-flight request, stops new work, releases target lease and preserves spent budget', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin));
  const cancel = new AbortController();
  const pending = f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/hold`), signal: cancel.signal });
  await web.held.promise; cancel.abort(); await assert.rejects(pending, code('CANCELLED'));
  assert.equal(f.budgets.snapshot('fixture-target').active, 0); assert.equal(f.budgets.snapshot('fixture-target').requests, 1);
  await assert.rejects(f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/ok`), signal: cancel.signal }), code('CANCELLED'));
  assert.equal(web.hits.length, 1); assert.equal(f.receipts.at(-1)!.outcome, 'cancelled');
});
test('cancellation while resolver is pending cannot create a late connection', async t => {
  const web = await webFixture(t), origin = `http://fixture.test:${web.port}`, entered = deferred(), dns = deferred<readonly string[]>();
  const f = await brokerFixture(t, fixtureScope(origin), { resolver: async () => { entered.resolve(); return dns.promise; } });
  const cancel = new AbortController();
  const pending = f.broker.execute({ context, tool: 'http.request', input: input(`${origin}/ok`), signal: cancel.signal });
  await entered.promise; cancel.abort(); await assert.rejects(pending, code('CANCELLED')); dns.resolve(['127.0.0.1']);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(web.hits.length, 0); assert.equal(f.budgets.snapshot('fixture-target').active, 0);
});
test('tool deadline and bounded HTTP/artifact/traffic output are enforced', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin), {}, { limits: { timeoutMs: 100 } });
  await assert.rejects(f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/hold`) }), code('TIMEOUT'));
  assert.equal(f.budgets.snapshot('fixture-target').active, 0);
  const bounded = await brokerFixture(t, fixtureScope(web.origin));
  await assert.rejects(bounded.broker.execute({ context, tool: 'http.request', input: { ...input(`${web.origin}/large`), maxResponseBytes: 64 } }), code('OUTPUT_LIMIT'));
  const byteScope = fixtureScope(web.origin); byteScope.targets[0]!.limits.maxBytes = 1;
  const bytes = await brokerFixture(t, byteScope); await assert.rejects(bytes.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/ok`) }), code('BUDGET_EXCEEDED'));
  const artScope = fixtureScope(web.origin); artScope.grants[0]!.maxArtifactBytes = 1;
  const artifacts = await brokerFixture(t, artScope); await assert.rejects(artifacts.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/ok`) }), code('BUDGET_EXCEEDED'));
});
test('concurrent target lease limit cannot be bypassed by a second call', async t => {
  const web = await webFixture(t), scope = fixtureScope(web.origin); scope.targets[0]!.limits.maxConcurrent = 1;
  const f = await brokerFixture(t, scope); const cancel = new AbortController();
  const held = f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/hold`), signal: cancel.signal });
  await web.held.promise;
  await assert.rejects(f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/ok`) }), code('BUDGET_EXCEEDED'));
  cancel.abort(); await assert.rejects(held, code('CANCELLED')); assert.equal(web.hits.length, 1);
});
test('receipt sink failure is not returned as collected success', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin), { receiptSink: () => { throw new Error('sink not durable'); } });
  try { await f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/ok`) }); assert.fail('must fail'); }
  catch (e) { assert.ok(e instanceof ToolExecutionError); assert.equal(e.receipt.outcome, 'failed'); assert.equal(e.code, 'UNAVAILABLE'); }
});
test('explicitly approved mutation/account sends bounded body through the same guarded broker', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin), { credentials: { headers: async () => ({ Authorization: 'Bearer fixture-mutation-token' }) } });
  const result = await f.broker.execute({ context, tool: 'http.request', input: { url: `${web.origin}/mutate`, method: 'POST', action: 'mutate', accountId: 'approved-user', headers: { 'Content-Type': 'application/json' }, body: '{"hello":"fixture"}' } });
  assert.equal((result.data as HttpEvidence).status, 200); assert.equal(web.hits[0]!.method, 'POST');
  assert.equal(web.hits[0]!.headers.authorization, 'Bearer fixture-mutation-token');
  assert.equal(web.hits[0]!.headers['content-length'], '19');
});
test('credential URL/body channels and canonical excluded paths are denied without requests', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin));
  await assert.rejects(f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/ok?access%5Ftoken=worker-supplied`) }), code('ACCOUNT_DENIED'));
  for (const body of ['{"password":"worker-supplied"}', 'password=worker-supplied', '%70assword=worker-supplied', '{"nested":{"api_key":"worker-supplied"}}']) await assert.rejects(f.broker.execute({ context, tool: 'http.request', input: { ...input(`${web.origin}/mutate`), method: 'POST', action: 'mutate', body } }), code('ACCOUNT_DENIED'));
  await assert.rejects(f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/%65xcluded/private`) }), code('TARGET_DENIED'));
  assert.equal(web.hits.length, 0);
});
test('canonical unreserved path is checked and sent in the same representation', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin));
  const result = await f.broker.execute({ context, tool: 'http.request', input: input(`${web.origin}/%6Fk`) });
  assert.equal((result.data as HttpEvidence).finalUrl, `${web.origin}/ok`); assert.equal(web.hits[0]!.path, '/ok');
});
