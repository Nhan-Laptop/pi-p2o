import { describe, it, expect, afterEach } from 'vitest';
import type { TestContext } from 'node:test';
import { brokerFixture, webFixture, fixtureScope, context } from '../tools/fixtures.js';
import { createHarness } from '../evidence/fixtures.js';
import { createScopedVerificationPolicy } from '../../src/application/first-use-verification/index.js';

// Real normal HTTP broker; external-shaped .test DNS is deliberately routed to a controlled loopback server.
// Not a live third-party scan. No credentials, mutation, paid model or public target requests.
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const t = { after(fn: () => unknown) { cleanups.push(fn); } } as unknown as TestContext;
async function setup(resolver?: (hostname: string) => Promise<readonly string[]>) {
  const web = await webFixture(t);
  const origin = `http://approved.test:${web.port}`;
  const scope = fixtureScope(origin);
  const h = createHarness({ clock: () => new Date().toISOString() });
  cleanups.push(() => h.dispose());
  h.run.runId = context.runId;
  h.run.authorization.reference = scope.authorization.reference;
  h.run.authorization.targets = [{ id: 'fixture-target', kind: 'web', locator: `${origin}/` }];
  h.run.allowedCapabilities = ['http.request'];
  h.run.budgets.targetRequestLimits = { 'fixture-target': 20 };
  scope.authorization.expiresAt = h.run.authorization.expiresAt;
  scope.accounts.forEach(a => { a.expiresAt = scope.authorization.expiresAt; });
  scope.grants[0]!.expiresAt = scope.authorization.expiresAt;
  scope.grants[0]!.role = 'verifier';
  const verification = createScopedVerificationPolicy(h.run, scope);
  const broker = await brokerFixture(t, scope, { resolver: resolver ?? (async () => ['127.0.0.1']) });
  const request = async (path: string, accountId = 'anonymous') => {
    const input = { url: `${origin}${path}`, method: 'GET' as const, action: 'read' as const, accountId, maxRedirects: 0 as const };
    verification.assertVerifier(context);
    verification.assertRequest(context, 'fixture-target', input);
    return broker.broker.execute({ context, tool: 'http.request', input });
  };
  return { request, web, broker, verification, origin, scope, h };
}
describe('scoped replay transport retains normal broker network/account policy', () => {
  it('anonymous approved hostname uses pinned normal broker transport per request', async () => {
    let resolutions = 0;
    const s = await setup(async host => { expect(host).toBe('approved.test'); resolutions++; return ['127.0.0.1']; });
    await s.request('/ok'); await s.request('/ok');
    expect(resolutions).toBe(4);
    expect(s.web.hits).toHaveLength(2);
    expect(s.web.hits.every(hit => !hit.headers.authorization && !hit.headers.cookie)).toBe(true);
  });
  it('denies unapproved hosts and accounts without contacting them', async () => {
    const s = await setup();
    expect(() => s.verification.assertRequest(context, 'fixture-target', { url: 'http://unapproved.test/', accountId: 'anonymous' })).toThrow();
    await expect(s.request('/ok', 'admin')).rejects.toThrow();
    expect(s.web.hits).toHaveLength(0);
  });
  it('does not follow even approved or unapproved redirects', async () => {
    const s = await setup();
    await expect(s.request('/cross')).rejects.toMatchObject({ code: 'REDIRECT_DENIED' });
    await expect(s.request('/redirect')).rejects.toMatchObject({ code: 'REDIRECT_DENIED' });
    expect(s.web.hits.map(hit => hit.path)).toEqual(['/cross', '/redirect']);
  });
  it('blocks connection-time DNS drift before HTTP is sent', async () => {
    let resolutions = 0;
    const s = await setup(async () => ++resolutions === 1 ? ['127.0.0.1'] : ['127.0.0.2']);
    await expect(s.request('/ok')).rejects.toMatchObject({ code: 'DNS_CHANGED' });
    expect(s.web.hits).toHaveLength(0);
  });
  it('blocks a mixed denied DNS answer and missing approved credential provider', async () => {
    const s = await setup(async () => ['127.0.0.1', '192.0.2.1']);
    await expect(s.request('/ok')).rejects.toMatchObject({ code: 'ADDRESS_DENIED' });
    expect(s.web.hits).toHaveLength(0);
    // Separate normal broker with stable approved DNS; it cannot mint/borrow credentials.
    const b = await brokerFixture(t, s.scope, { resolver: async () => ['127.0.0.1'] });
    await expect(b.broker.execute({ context, tool: 'http.request', input: { url: `${s.origin}/auth`, accountId: 'approved-user', maxRedirects: 0 } })).rejects.toMatchObject({ code: 'ACCOUNT_DENIED' });
    expect(s.web.hits).toHaveLength(0);
  });
  it('refuses expired verifier grants and does not widen read actions', async () => {
    const s = await setup();
    const time = Date.parse(s.scope.grants[0]!.expiresAt);
    const expired = createScopedVerificationPolicy(s.h.run, s.scope, () => time);
    expect(() => expired.assertVerifier(context)).toThrow();
    expect(() => s.verification.assertRequest(context, 'fixture-target', { url: `${s.origin}/ok`, accountId: 'anonymous', method: 'POST', action: 'mutate' })).toThrow();
    expect(s.web.hits).toHaveLength(0);
  });
});
