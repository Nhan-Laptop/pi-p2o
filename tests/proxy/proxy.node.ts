import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry, createDefaultRegistry, doctor, type ProxyHistoryEvidence, type ProxySessionEvidence, type ToolDescriptor } from '../../src/tools/index.js';
import { contextA, contextB, code, hostFixture, httpFixture, proxyFixture, proxyScope, tunnel, viaProxy } from './fixtures.js';

const secret = 'Bearer fixture-secret-token-value';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function start(f: Awaited<ReturnType<typeof proxyFixture>>, origins: string[], extra: Record<string, unknown> = {}): Promise<ProxySessionEvidence> {
  const result = await f.broker.execute({ context: contextA, tool: 'proxy.session', input: { action: 'start', accountId: 'anonymous', origins, ...extra } });
  return result.data as ProxySessionEvidence;
}
async function history(f: Awaited<ReturnType<typeof proxyFixture>>, input: Record<string, unknown>, context = contextA, tool: 'proxy.session' | 'proxy.history' = 'proxy.history') {
  const result = await f.broker.execute({ context, tool, input });
  return { data: result.data as ProxyHistoryEvidence | ProxySessionEvidence, receipt: result.receipt };
}
const portOf = (f: Awaited<ReturnType<typeof proxyFixture>>, proxyId: string): number => {
  const inspected = f.pack.inspect(proxyId);
  assert.ok(inspected, 'capture listener should be live');
  return inspected.port;
};

test('capture: in-scope traffic is recorded and non-scope traffic is refused before egress', async t => {
  const fixture = await httpFixture(t);
  const f = await proxyFixture(t, { scope: proxyScope([fixture.origin]) });
  const started = await start(f, [fixture.origin]);
  assert.equal(started.status, 'open');
  assert.equal(started.mode, 'passthrough-no-mitm');
  assert.equal(started.identity.mitm, 'none');
  assert.match(started.identity.identityDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(started.origins, [fixture.origin]);
  const port = portOf(f, started.proxyId);

  const allowed = await viaProxy(port, `${fixture.origin}/app`, { headers: { authorization: secret } });
  assert.equal(allowed.status, 200);
  assert.match(allowed.body, /Proxy Fixture/);
  const refused = await viaProxy(port, `${fixture.outsideOrigin}/xhr`);
  assert.equal(refused.status, 403);
  assert.deepEqual(fixture.outsideHits, [], 'the out-of-scope origin never received anything');

  const { data, receipt } = await history(f, { action: 'list', proxyId: started.proxyId, limit: 10 });
  const listed = data as ProxyHistoryEvidence;
  assert.equal(listed.total, 2);
  const captured = listed.entries!.find(entry => entry.url.endsWith('/app'))!;
  assert.equal(captured.decision, 'allowed');
  assert.equal(captured.status, 200);
  assert.equal(captured.source, 'capture-proxy');
  assert.match(captured.requestDigest, /^[a-f0-9]{64}$/);
  assert.match(captured.responseDigest, /^[a-f0-9]{64}$/);
  assert.ok(captured.responseBytes > 0);
  assert.ok(captured.ms >= 0);
  const blocked = listed.entries!.find(entry => entry.url.includes('/xhr'))!;
  assert.equal(blocked.decision, 'blocked');
  assert.equal(blocked.reason, 'TARGET_DENIED');
  assert.equal(listed.refused, 'no');
  assert.deepEqual(receipt.targets, ['fixture-target']);
});

test('https passthrough: CONNECT tunnels are captured at tunnel granularity without MITM', async t => {
  const fixture = await httpFixture(t, false);
  const origins = [fixture.origin, `https://127.0.0.1:${fixture.port}`];
  const f = await proxyFixture(t, { scope: proxyScope(origins) });
  const started = await start(f, origins);
  const port = portOf(f, started.proxyId);

  const tunneled = await tunnel(port, '127.0.0.1', fixture.port, `GET /tunnel HTTP/1.1\r\nhost: 127.0.0.1:${fixture.port}\r\nconnection: close\r\n\r\n`);
  assert.equal(tunneled.status, 200);
  assert.match(tunneled.response, /fixture ok/);

  const blockedTunnel = await tunnel(port, '127.0.0.1', fixture.outsidePort, 'GET / HTTP/1.1\r\n\r\n');
  assert.equal(blockedTunnel.status, 403);
  assert.deepEqual(fixture.outsideHits, []);

  const listed = (await history(f, { action: 'list', proxyId: started.proxyId })).data as ProxyHistoryEvidence;
  const allowed = listed.entries!.find(entry => entry.kind === 'connect' && entry.decision === 'allowed')!;
  assert.equal(allowed.method, 'CONNECT');
  assert.equal(allowed.status, 200);
  assert.ok(allowed.requestBytes > 0 && allowed.responseBytes > 0, 'tunnel bytes are counted in both directions');
  assert.equal(allowed.responseDigest.length, 64, 'tunnel bytes are digested, never decrypted');
  assert.equal(allowed.targetId, 'fixture-target');
  assert.equal(allowed.truncated, 'no', 'an opaque stream is digested in full and never previewed');
  const refused = listed.entries!.find(entry => entry.kind === 'connect' && entry.decision === 'blocked')!;
  assert.equal(refused.reason, 'TARGET_DENIED');
});

test('list/view/repeat round-trip: digests match, modifications cannot widen scope/host/account', async t => {
  const fixture = await httpFixture(t);
  const f = await proxyFixture(t, { scope: proxyScope([fixture.origin]) });
  const started = await start(f, [fixture.origin]);
  const port = portOf(f, started.proxyId);
  await viaProxy(port, `${fixture.origin}/json`, { headers: { authorization: secret, cookie: 'fixture=session-secret' } });

  const listed = (await history(f, { action: 'list', proxyId: started.proxyId })).data as ProxyHistoryEvidence;
  const original = listed.entries!.find(entry => entry.url.endsWith('/json'))!;
  const viewed = (await history(f, { action: 'view', proxyId: started.proxyId, requestId: original.id })).data as ProxyHistoryEvidence;
  assert.equal(viewed.entry!.requestHeaders.authorization, '[REDACTED]');
  assert.equal(viewed.entry!.requestHeaders.cookie, '[REDACTED]');
  assert.equal(viewed.entry!.responseBody.mediaType, 'application/json');
  assert.match(viewed.entry!.responseBody.preview, /"ok":true/);
  assert.equal(viewed.entry!.requestDigest, original.requestDigest);
  assert.equal(viewed.entry!.responseDigest, original.responseDigest);
  assert.deepEqual(viewed.entry!.dns, ['127.0.0.1']);

  const repeated = (await history(f, {
    action: 'repeat', proxyId: started.proxyId, requestId: original.id,
    method: 'POST', url: `${fixture.origin}/echo`, body: '{"hello":"world"}', headers: { 'content-type': 'application/json' },
  })).data as ProxyHistoryEvidence;
  assert.equal(repeated.repeat!.status, 200);
  assert.equal(repeated.repeat!.replayOf, original.id);
  assert.equal(repeated.repeat!.method, 'POST');
  assert.equal(repeated.repeat!.pinnedAddress, '127.0.0.1');
  assert.match(repeated.repeat!.requestDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(repeated.repeat!.requestDigest, original.requestDigest);
  const replayView = (await history(f, { action: 'view', proxyId: started.proxyId, requestId: repeated.repeat!.id })).data as ProxyHistoryEvidence;
  assert.equal(replayView.entry!.source, 'repeat');
  assert.match(replayView.entry!.responseBody.preview, /"method":"POST"/);

  // A refused request is never replayed, and a repeat may not widen host, headers or scope.
  await viaProxy(port, `${fixture.outsideOrigin}/xhr`);
  const blockedId = ((await history(f, { action: 'list', proxyId: started.proxyId, filter: 'blocked' })).data as ProxyHistoryEvidence).entries![0]!.id;
  await assert.rejects(history(f, { action: 'repeat', proxyId: started.proxyId, requestId: blockedId }), code('TARGET_DENIED'));
  await assert.rejects(history(f, { action: 'repeat', proxyId: started.proxyId, requestId: original.id, url: `${fixture.outsideOrigin}/xhr` }), code('TARGET_DENIED'));
  await assert.rejects(history(f, { action: 'repeat', proxyId: started.proxyId, requestId: original.id, headers: { host: 'outside.test' } }), code('ACCOUNT_DENIED'));
  await assert.rejects(history(f, { action: 'repeat', proxyId: started.proxyId, requestId: original.id, headers: { cookie: 'stolen=1' } }), code('ACCOUNT_DENIED'));
  await assert.rejects(history(f, { action: 'repeat', proxyId: started.proxyId, requestId: original.id, url: `${fixture.origin}/excluded/private` }), code('TARGET_DENIED'));
});

test('sitemap aggregates captured origins and paths; scope_rules reports explicit decisions', async t => {
  const fixture = await httpFixture(t);
  const f = await proxyFixture(t, { scope: proxyScope([fixture.origin]) });
  const started = await start(f, [fixture.origin]);
  const port = portOf(f, started.proxyId);
  await viaProxy(port, `${fixture.origin}/app`);
  await viaProxy(port, `${fixture.origin}/json`);
  await viaProxy(port, `${fixture.origin}/json`);
  await viaProxy(port, `${fixture.outsideOrigin}/xhr`);

  const sitemap = (await history(f, { action: 'sitemap', proxyId: started.proxyId })).data as ProxyHistoryEvidence;
  const origin = sitemap.sitemap!.origins.find(entry => entry.origin === fixture.origin)!;
  assert.equal(origin.requests, 3);
  assert.equal(origin.allowed, 3);
  assert.equal(origin.paths.find(path => path.path === '/json')!.requests, 2);
  assert.deepEqual(origin.paths.find(path => path.path === '/json')!.methods, ['GET']);
  const outside = sitemap.sitemap!.origins.find(entry => entry.origin === fixture.outsideOrigin)!;
  assert.equal(outside.blocked, 1);

  const rules = (await history(f, { action: 'scope_rules', proxyId: started.proxyId })).data as ProxyHistoryEvidence;
  assert.deepEqual(rules.scope!.allowed[0]!.origins, [fixture.origin]);
  assert.deepEqual(rules.scope!.allowed[0]!.accounts, ['anonymous']);
  assert.equal(rules.scope!.excluded[0]!.origin, fixture.origin);
  assert.deepEqual(rules.scope!.excluded[0]!.pathPrefixes, ['/excluded']);
  assert.equal(rules.scope!.decisions.allowed, 3);
  assert.equal(rules.scope!.decisions.blocked, 1);
  assert.equal(rules.scope!.decisions.byReason.find(entry => entry.reason === 'TARGET_DENIED')!.count, 1);
  assert.deepEqual(rules.scope!.pinned, [{ host: '127.0.0.1', addresses: ['127.0.0.1'] }]);
});

test('session request budget exhaustion refuses before egress and is reported', async t => {
  const fixture = await httpFixture(t);
  const f = await proxyFixture(t, { scope: proxyScope([fixture.origin]) });
  const started = await start(f, [fixture.origin], { maxRequests: 2 });
  const port = portOf(f, started.proxyId);
  assert.equal((await viaProxy(port, `${fixture.origin}/json`)).status, 200);
  assert.equal((await viaProxy(port, `${fixture.origin}/json`)).status, 200);
  const refused = await viaProxy(port, `${fixture.origin}/json`);
  assert.equal(refused.status, 403);
  assert.equal(fixture.hits.filter(hit => hit.path === '/json').length, 2, 'the third request never reached the target');
  const listed = (await history(f, { action: 'list', proxyId: started.proxyId })).data as ProxyHistoryEvidence;
  assert.equal(listed.refused, 'yes');
  assert.equal(listed.entries!.find(entry => entry.decision === 'blocked')!.reason, 'BUDGET_EXCEEDED');
  const status = (await history(f, { action: 'status', proxyId: started.proxyId }, contextA, 'proxy.session')).data as ProxySessionEvidence;
  assert.equal(status.budget.requestsMax, 2);
});

test('sessions are killed on attempt release and are unusable afterwards', async t => {
  const fixture = await httpFixture(t);
  const f = await proxyFixture(t, { scope: proxyScope([fixture.origin]) });
  const started = await start(f, [fixture.origin]);
  const port = portOf(f, started.proxyId);
  assert.equal((await viaProxy(port, `${fixture.origin}/json`)).status, 200);

  // The pack exposes the same attempt-release registry shape the runtime's pack releaser drives.
  assert.equal(f.pack.outstanding(contextA), 1);
  assert.equal(f.pack.outstanding(contextB), 0);
  const released = await f.pack.releaseAttempt(contextA);
  assert.equal(released, 1);
  assert.equal(f.pack.outstanding(contextA), 0);
  assert.equal(f.pack.sessions, 0);
  assert.equal(f.pack.inspect(started.proxyId), undefined, 'no listener survives the release');
  const status = (await history(f, { action: 'status', proxyId: started.proxyId }, contextA, 'proxy.session')).data as ProxySessionEvidence;
  assert.equal(status.status, 'closed');
  assert.equal(status.released, 'yes');
  await assert.rejects(history(f, { action: 'list', proxyId: started.proxyId }), code('UNAVAILABLE'));
  await assert.rejects(f.broker.execute({ context: contextB, tool: 'proxy.session', input: { action: 'status', proxyId: started.proxyId } }), code('IDENTITY_DENIED'));
  await assert.rejects(viaProxy(port, `${fixture.origin}/json`, { timeoutMs: 2000 }), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ECONNREFUSED');
});

test('an explicit stop closes the listener and leaves a tombstone for the owning attempt', async t => {
  const fixture = await httpFixture(t);
  const f = await proxyFixture(t, { scope: proxyScope([fixture.origin]) });
  const started = await start(f, [fixture.origin]);
  const port = portOf(f, started.proxyId);
  const stopped = (await history(f, { action: 'stop', proxyId: started.proxyId }, contextA, 'proxy.session')).data as ProxySessionEvidence;
  assert.equal(stopped.status, 'closed');
  assert.equal(stopped.released, 'yes');
  await assert.rejects(viaProxy(port, `${fixture.origin}/json`, { timeoutMs: 2000 }), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ECONNREFUSED');
  const after = (await history(f, { action: 'status', proxyId: started.proxyId }, contextA, 'proxy.session')).data as ProxySessionEvidence;
  assert.equal(after.status, 'closed');
});

test('the grant deadline kills the capture session and the tombstone refuses further reads', async t => {
  const fixture = await httpFixture(t);
  const f = await proxyFixture(t, { scope: proxyScope([fixture.origin], { grantExpiresAt: new Date(Date.now() + 1500).toISOString() }) });
  const started = await start(f, [fixture.origin]);
  const port = portOf(f, started.proxyId);
  for (let attempt = 0; attempt < 20 && f.pack.sessions > 0; attempt++) await sleep(250);
  assert.equal(f.pack.sessions, 0, 'the watchdog killed the session at its deadline');
  await assert.rejects(viaProxy(port, `${fixture.origin}/json`, { timeoutMs: 2000 }), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ECONNREFUSED');
  // The grant deadline kills the session; the broker then refuses the stale context before dispatch.
  await assert.rejects(history(f, { action: 'list', proxyId: started.proxyId }), code('EXPIRED'));
});

test('worker-visible evidence never contains a host path or an unredacted secret', async t => {
  const fixture = await httpFixture(t);
  const f = await proxyFixture(t, { scope: proxyScope([fixture.origin]) });
  const started = await start(f, [fixture.origin]);
  const port = portOf(f, started.proxyId);
  await viaProxy(port, `${fixture.origin}/app`, { headers: { authorization: secret, cookie: 'fixture=session-secret' } });
  const listed = await history(f, { action: 'list', proxyId: started.proxyId });
  const viewed = await history(f, { action: 'view', proxyId: started.proxyId, requestId: (listed.data as ProxyHistoryEvidence).entries![0]!.id });
  const serialized = JSON.stringify([started, listed.data, viewed.data]);
  assert.ok(!serialized.includes('fixture-secret-token-value'), 'the authorization value is never observable');
  assert.ok(!serialized.includes('session-secret'), 'the cookie value is never observable');
  assert.ok(!serialized.includes(f.inputRoot) && !serialized.includes(f.outputRoot), 'no host path reaches the worker');
  assert.ok(!serialized.includes('inputRoot') && !serialized.includes('profileRoot'));
});

test('doctor qualifies capture sessions on the acknowledged boundaries and refuses container isolation', async t => {
  const fixture = await httpFixture(t);
  const f = await proxyFixture(t, { scope: proxyScope([fixture.origin]) });
  const budgets = f.budgets;
  const ok = await doctor({ registry: createDefaultRegistry(), sandbox: f.sandbox, required: ['proxy.session', 'proxy.history'], budgets });
  assert.equal(ok.ok, true, JSON.stringify(ok.checks.filter(check => !check.ok)));
  assert.ok(ok.checks.some(check => check.name === 'proxy-pack' && check.ok));
  const stub = {
    mode: 'container' as const, boundary: 'container:stub', configurationDigest: f.sandbox.configurationDigest, filesystem: f.sandbox.filesystem,
    nativeEnabled: false, preflight: async () => ({ ok: true, boundary: 'container:stub', checks: [] }),
  } as unknown as Parameters<typeof doctor>[0]['sandbox'];
  const refused = await doctor({ registry: createDefaultRegistry(), sandbox: stub, required: ['proxy.session', 'proxy.history'], budgets });
  assert.equal(refused.ok, false);
  assert.ok(refused.checks.some(check => check.name === 'proxy-pack' && !check.ok));
  assert.ok(refused.checks.some(check => check.name === 'proxy.session' && !check.ok));
});

test('capability descriptor tampering is refused: isolation, actions, side effects, schemas and identity', async () => {
  const registry = createDefaultRegistry();
  const tamper = (id: 'proxy.session' | 'proxy.history', patch: Partial<ToolDescriptor>) => new CapabilityRegistry(
    registry.list().map(descriptor => (descriptor.id === id ? { ...descriptor, ...patch } : descriptor)),
  );
  assert.throws(() => tamper('proxy.session', { isolation: ['local-fixture', 'container'] }), code('INVALID_INPUT'));
  assert.throws(() => tamper('proxy.history', { isolation: ['host-browser'] }), code('INVALID_INPUT'));
  assert.throws(() => tamper('proxy.history', { actions: ['read'] }), code('INVALID_INPUT'));
  assert.throws(() => tamper('proxy.session', { sideEffects: ['write-private-artifact'] }), code('INVALID_INPUT'));
  assert.throws(() => tamper('proxy.history', { implementationDigest: '0'.repeat(64) }), code('INVALID_INPUT'));
  assert.throws(() => tamper('proxy.session', { inputSchema: { ...registry.get('proxy.session').inputSchema, additionalProperties: { type: 'string' } } }), code('INVALID_INPUT'));
  const descriptor = registry.get('proxy.history');
  assert.deepEqual(descriptor.sideEffects.includes('explicit-mutation'), true);
  assert.equal(descriptor.version, '1.0.0');
});

test('browser page traffic is captured through the pack egress proxy', async t => {
  const fixture = await httpFixture(t);
  const host = await hostFixture(t, { scope: proxyScope([fixture.origin], { capabilities: ['browser.session', 'browser.act', 'proxy.session', 'proxy.history'] }) });
  if (!host) return t.skip('no host Chrome available');
  const opened = await host.proxy.broker.execute({ context: contextA, tool: 'browser.session', input: { action: 'open', url: `${fixture.origin}/app`, accountId: 'anonymous' } });
  const browserId = (opened.data as { browserId: string }).browserId;
  assert.ok(browserId);
  const captured = (await history(host.proxy, { action: 'status' }, contextA, 'proxy.session')).data as ProxySessionEvidence;
  assert.equal(captured.status, 'open');
  const listed = (await history(host.proxy, { action: 'list', proxyId: captured.proxyId, limit: 32 })).data as ProxyHistoryEvidence;
  const page = listed.entries!.find(entry => entry.source === 'browser-egress' && entry.url.endsWith('/app'));
  assert.ok(page, `page traffic should be captured: ${JSON.stringify(listed.entries!.map(entry => [entry.source, entry.kind, entry.url, entry.decision]))}`);
  assert.equal(page.decision, 'allowed');
  assert.ok(listed.entries!.some(entry => entry.source === 'browser-egress' && entry.decision === 'blocked' && entry.reason === 'TARGET_DENIED'), 'the page XHR to the out-of-scope origin is captured as refused');
  assert.deepEqual(fixture.outsideHits, []);
  const closed = await host.proxy.broker.execute({ context: contextA, tool: 'browser.session', input: { action: 'close', browserId } });
  assert.equal((closed.data as { status: string }).status, 'closed');
  assert.equal(await host.proxy.pack.releaseAttempt(contextA), 1, 'attempt release also kills the implicit capture session');
});
