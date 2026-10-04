import test from 'node:test';
import assert from 'node:assert/strict';
import { addressInCidr, createPolicy, isForbiddenAddress, normalizeAddress, normalizeWebTarget, pathWithin, PolicyError, TargetBudget, validateCidr } from '../../src/policy/index.js';
import { context, fixtureScope, NOW } from './fixture.js';

const code = (expected: string) => (e: unknown) => e instanceof PolicyError && e.code === expected;
const request = (url = 'http://127.0.0.1:32123/ok') => ({ context, capability: 'http.request' as const, action: 'read' as const, method: 'GET', url, accountId: 'anonymous' });
test('canonical HTTP identities, segment-bounded paths, IDNA and literal IPs', () => {
  assert.equal(normalizeWebTarget('HTTPS://EXAMPLE.TEST.:443/api?q=a#ignored').url, 'https://example.test/api?q=a');
  assert.equal(normalizeWebTarget('http://127.1:32123/').hostname, '127.0.0.1');
  assert.equal(normalizeWebTarget('https://bücher.test/').hostname, 'xn--bcher-kva.test');
  assert.equal(normalizeWebTarget('http://[::1]:32123/').hostname, '::1');
  assert.equal(pathWithin('/api/users', '/api'), true);
  assert.equal(pathWithin('/api-escape', '/api'), false);
});
test('ambiguous/credential/non-web URLs fail before dispatch', () => {
  for (const value of ['http://u:p@127.0.0.1/', 'file:///etc/passwd', 'ftp://fixture.test/', 'http://fixture.test/a/../b', 'http://fixture.test/%2e%2e/a', 'http://fixture.test/a%2fb', 'http://fixture.test/%252f', 'http://fixture.test/\\evil', 'http://fixture.test/a\n']) assert.throws(() => normalizeWebTarget(value), PolicyError);
});
test('explicit allow, exclusions, target identity, account, method and capability denials', () => {
  const policy = createPolicy(fixtureScope(), { now: () => NOW });
  assert.equal(policy.authorize(request()).target?.id, 'fixture-target');
  for (const url of ['http://127.0.0.1:32124/ok', 'http://127.0.0.1:32123/excluded', 'http://127.0.0.1:32123/excluded/nested']) assert.throws(() => policy.authorize(request(url)), code('TARGET_DENIED'));
  assert.equal(policy.authorize(request('http://127.0.0.1:32123/excluded-sibling')).target?.id, 'fixture-target');
  assert.throws(() => policy.authorize({ ...request(), accountId: 'not-approved' }), code('ACCOUNT_DENIED'));
  assert.throws(() => policy.authorize({ ...request(), method: 'POST' }), code('ACTION_DENIED'));
  assert.throws(() => policy.authorize({ ...request(), capability: 'native.inspect' }), code('CAPABILITY_DENIED'));
  assert.throws(() => policy.authorize({ ...request(), context: { ...context, attemptId: 'replay' } }), code('IDENTITY_DENIED'));
  assert.throws(() => policy.authorize({ ...request(), capability: 'web.observe', method: 'POST', action: 'mutate' }), code('ACTION_DENIED'));
  assert.equal(policy.authorize({ ...request(), method: 'POST', action: 'mutate', accountId: 'approved-user' }).action, 'mutate');
});
test('authorization, grant and account expiry are rechecked at connection time', () => {
  let now = NOW;
  const scope = fixtureScope();
  scope.grants[0]!.expiresAt = '2026-10-02T12:00:01.000Z';
  const policy = createPolicy(scope, { now: () => now });
  const decision = policy.authorize(request());
  assert.equal(policy.authorizeAddress(decision, '127.0.0.1'), '127.0.0.1');
  now += 1000;
  assert.throws(() => policy.authorizeAddress(decision, '127.0.0.1'), code('EXPIRED'));
  scope.grants[0]!.expiresAt = '2099-10-02T13:00:00.000Z';
  scope.accounts[0]!.expiresAt = '2026-10-02T12:00:01.000Z'; now = NOW;
  const p2 = createPolicy(scope, { now: () => now }); const d2 = p2.authorize(request()); now += 1000;
  assert.throws(() => p2.authorizeAddress(d2, '127.0.0.1'), code('EXPIRED'));
  const expired = fixtureScope(); expired.authorization.expiresAt = '2026-10-02T12:00:00.000Z'; expired.grants[0]!.expiresAt = expired.authorization.expiresAt; expired.accounts.forEach(a => { a.expiresAt = expired.authorization.expiresAt; });
  assert.throws(() => createPolicy(expired, { now: () => NOW }).authorize(request()), code('EXPIRED'));
});
test('scope is deeply immutable, rejects unknown fields/ambiguous origins/unbounded CIDRs/role escalation', () => {
  const scope = fixtureScope(); const p = createPolicy(scope, { now: () => NOW }); scope.targets[0]!.origins[0] = 'http://127.0.0.2/';
  assert.equal(p.authorize(request()).normalized?.hostname, '127.0.0.1');
  assert.throws(() => p.scope.targets[0]!.accounts.push('attack'), TypeError);
  assert.throws(() => createPolicy({ ...fixtureScope(), surprise: true }), code('INVALID_INPUT'));
  const duplicate = fixtureScope(); duplicate.targets.push({ ...duplicate.targets[0]!, id: 'second' }); duplicate.accounts.forEach(a => a.targetIds.push('second'));
  assert.throws(() => createPolicy(duplicate), code('INVALID_INPUT'));
  const control = fixtureScope(); control.grants[0]!.role = 'orchestrator'; assert.throws(() => createPolicy(control), code('CAPABILITY_DENIED'));
  assert.throws(() => validateCidr('0.0.0.0/0'), code('INVALID_INPUT'));
  assert.throws(() => validateCidr('::/0'), code('INVALID_INPUT'));
});
test('CIDR checks handle IPv6 and mapped IPv4 exclusions without spelling bypasses', () => {
  assert.equal(addressInCidr('2001:db8::1', '2001:db8::/32'), true);
  assert.equal(addressInCidr('2001:db9::1', '2001:db8::/32'), false);
  assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeAddress('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(addressInCidr('::ffff:192.0.2.1', '192.0.2.0/24'), true);
  assert.equal(isForbiddenAddress('169.254.169.254'), true);
  assert.equal(isForbiddenAddress('fe80::1'), true);
  const p = createPolicy(fixtureScope(), { now: () => NOW }), d = p.authorize(request());
  for (const ip of ['127.0.0.9', '::ffff:127.0.0.9', '192.0.2.1', '169.254.169.254', '::']) assert.throws(() => p.authorizeAddress(d, ip), code('ADDRESS_DENIED'));
  assert.throws(() => p.authorizeAddress({ ...d }, '127.0.0.1'), code('IDENTITY_DENIED'));
});
test('offline capability has no network authority; validity interval is enforced', () => {
  const p = createPolicy(fixtureScope(), { now: () => NOW });
  const d = p.authorize({ context, capability: 'source.analyze', action: 'analyze' });
  assert.throws(() => p.authorizeAddress(d, '127.0.0.1'), code('TARGET_DENIED'));
  assert.throws(() => p.authorize({ context, capability: 'source.analyze', action: 'analyze', url: 'http://127.0.0.1/' }), code('TARGET_DENIED'));
  const s = fixtureScope(); s.authorization.notBefore = '2026-10-02T12:00:01.000Z';
  assert.throws(() => createPolicy(s, { now: () => NOW }).authorize(request()), code('NOT_YET_VALID'));
});
test('target-wide sliding rate/concurrency/byte/request and grant budgets are charged atomically', () => {
  let time = 1000; const scope = fixtureScope(); const t = scope.targets[0]!;
  t.limits = { maxRequests: 3, maxBytes: 100, maxConcurrent: 1, rate: { requests: 1, windowMs: 1000 } };
  const budget = new TargetBudget(scope.targets, { now: () => time });
  const r1 = budget.reserve(t.id); assert.throws(() => budget.reserve(t.id), code('BUDGET_EXCEEDED')); r1.consumeBytes(20); r1.release(); r1.release();
  assert.throws(() => budget.reserve(t.id), code('RATE_LIMITED')); time += 1000;
  const r2 = budget.reserve(t.id); r2.consumeBytes(50); r2.release(); time += 1000;
  const r3 = budget.reserve(t.id); assert.throws(() => r3.consumeBytes(31), code('BUDGET_EXCEEDED')); r3.release(); time += 1000;
  assert.throws(() => budget.reserve(t.id), code('BUDGET_EXCEEDED'));
  assert.equal(budget.snapshot(t.id).requests, 3); assert.equal(budget.snapshot(t.id).bytes, 101); assert.equal(budget.snapshot(t.id).active, 0);
  const g = scope.grants[0]!; g.maxCalls = 1; g.maxArtifactBytes = 10;
  budget.chargeCall(g); assert.throws(() => budget.chargeCall(g), code('BUDGET_EXCEEDED'));
  budget.chargeArtifact(g, 10); assert.throws(() => budget.chargeArtifact(g, 1), code('BUDGET_EXCEEDED'));
});
test('durable target counters survive restart, retain unknown active leases and reject resets/wider budgets', () => {
  const scope = fixtureScope(); scope.targets[0]!.limits.maxConcurrent = 1;
  let saved: unknown; const journal = { load: () => saved, save: (state: unknown) => { saved = structuredClone(state); } };
  const first = new TargetBudget(scope.targets, { runId: scope.runId, freshRun: true, journal, now: () => NOW });
  first.bindRun(scope.runId, scope.targets); first.chargeCall(scope.grants[0]!); first.reserve('fixture-target').consumeBytes(20);
  const resumed = new TargetBudget(scope.targets, { runId: scope.runId, journal, now: () => NOW });
  assert.equal(resumed.snapshot('fixture-target').requests, 1); assert.equal(resumed.grantSnapshot(context.grantId).calls, 1);
  assert.throws(() => resumed.reserve('fixture-target'), code('BUDGET_EXCEEDED'));
  assert.throws(() => resumed.clearActiveAfterReconciliation('fixture-target', { terminationVerified: false as never, reference: 'unknown' }), code('UNAVAILABLE'));
  resumed.clearActiveAfterReconciliation('fixture-target', { terminationVerified: true, reference: 'fixture-proved-termination' });
  const r = resumed.reserve('fixture-target'); r.release(); assert.equal(resumed.snapshot('fixture-target').requests, 2);
  assert.throws(() => new TargetBudget(scope.targets, { runId: scope.runId, freshRun: true, journal }), code('UNAVAILABLE'));
  assert.throws(() => resumed.bindRun('foreign-run', scope.targets), code('IDENTITY_DENIED'));
  const looser = structuredClone(scope.targets); looser[0]!.limits.maxRequests += 1;
  assert.throws(() => new TargetBudget(looser).bindRun(scope.runId, scope.targets), code('BUDGET_EXCEEDED'));
});
test('missing or failed persistent budget state fails closed before any dispatch', () => {
  const scope = fixtureScope();
  assert.throws(() => new TargetBudget(scope.targets, { runId: scope.runId, journal: { load: () => undefined, save: () => {} } }), code('UNAVAILABLE'));
  let saves = 0;
  const budget = new TargetBudget(scope.targets, { runId: scope.runId, freshRun: true, journal: { load: () => undefined, save: () => { if (++saves > 1) throw new Error('fixture disk unavailable'); } } });
  assert.throws(() => budget.reserve('fixture-target'), code('UNAVAILABLE'));
  assert.throws(() => budget.reserve('fixture-target'), code('UNAVAILABLE'));
});
test('canonical percent/unicode/duplicate-separator paths cannot evade exclusions', () => {
  const policy = createPolicy(fixtureScope(), { now: () => NOW });
  for (const path of ['/%65xcluded/private', '//excluded/private', '/ｅxcluded/private']) assert.throws(() => policy.authorize(request(`http://127.0.0.1:32123${path}`)), code('TARGET_DENIED'));
  for (const path of ['/excluded;parameter', '/excluded%3bparameter', '/%00', '/a%3fb', '/a%23b']) assert.throws(() => normalizeWebTarget(`http://127.0.0.1:32123${path}`), code('TARGET_DENIED'));
  assert.equal(normalizeWebTarget('http://127.0.0.1:32123/%6Fk').path, '/ok');
});
test('expiry cannot be reopened by a backward clock and invalid calendar dates are rejected', () => {
  const scope = fixtureScope(); scope.grants[0]!.expiresAt = '2026-10-02T12:00:01.000Z'; let now = NOW;
  const policy = createPolicy(scope, { now: () => now }); policy.authorize(request()); now += 1000;
  assert.throws(() => policy.authorize(request()), code('EXPIRED')); now = NOW; assert.throws(() => policy.authorize(request()), code('EXPIRED'));
  const invalid = fixtureScope(); invalid.authorization.notBefore = '2026-02-30T00:00:00.000Z'; assert.throws(() => createPolicy(invalid), code('INVALID_INPUT'));
});
