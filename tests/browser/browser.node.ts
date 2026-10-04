import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TargetBudget, createPolicy } from '../../src/policy/index.js';
import {
  CapabilityRegistry, createBrowserPack, createDefaultRegistry, createHostBrowserSandbox, createLocalFixtureSandbox, createToolBroker, doctor,
  verifyChromeIdentity, type BrowserActEvidence, type BrowserSessionEvidence, type ToolDescriptor,
} from '../../src/tools/index.js';
import {
  browserFixture, browserScope, chromePin, code, contextA, contextB, jsFixture, memoryBudget, openSession, roots, act,
} from './fixtures.js';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const refFor = (data: BrowserActEvidence, role: string) => data.refs?.find(item => item.role === role)?.ref;
const sessionInput = (browserId: string, action: string) => ({ tool: 'browser.session' as const, input: { action, browserId } });

test('real browser renders JS: snapshot -> fill -> click changes the DOM, screenshot is digested, only in-scope traffic is allowed', async t => {
  const pin = await chromePin();
  if (!pin) return t.skip('no host Chrome available');
  const fixture = await jsFixture(t);
  const f = await browserFixture(t, { scope: browserScope([fixture.origin]) });
  const session = await openSession(f, `${fixture.origin}/app`);
  assert.equal(session.status, 'open');
  assert.equal(session.origin, fixture.origin);
  assert.equal(session.chrome.version, pin.version);
  assert.equal(session.chrome.identityDigest.length, 64);
  assert.match(String(session.isolation), /^host-browser:not-container-isolated:/);

  const snapshot = (await act(f, session.browserId, { action: 'snapshot' })).data as BrowserActEvidence;
  assert.equal(snapshot.action, 'snapshot');
  assert.ok((snapshot.snapshot?.lines ?? 0) >= 2);
  assert.match(snapshot.snapshot!.text, /rendered-by-js|Name|Say hi/);
  const inputRef = refFor(snapshot, 'textbox'), buttonRef = refFor(snapshot, 'button');
  assert.ok(inputRef, 'snapshot exposes the JS-created textbox');
  assert.ok(buttonRef, 'snapshot exposes the JS-created button');

  const filled = (await act(f, session.browserId, { action: 'fill', ref: inputRef, value: 'p2o' })).data as BrowserActEvidence;
  assert.equal(filled.changed, 'yes', 'fill mutated the DOM through the page listener');
  // Refs are snapshot-scoped: an old ref is refused after the page changed.
  await assert.rejects(act(f, session.browserId, { action: 'click', ref: inputRef }), code('INVALID_INPUT'));

  const fresh = (await act(f, session.browserId, { action: 'snapshot' })).data as BrowserActEvidence;
  const freshButton = refFor(fresh, 'button');
  assert.ok(freshButton);
  const clicked = (await act(f, session.browserId, { action: 'click', ref: freshButton })).data as BrowserActEvidence;
  assert.equal(clicked.changed, 'yes');
  const text = (await act(f, session.browserId, { action: 'extract_text' })).data as BrowserActEvidence;
  assert.match(text.extraction!.text, /clicked:p2o/);
  assert.equal(text.extraction!.mediaType, 'text/plain');
  const html = (await act(f, session.browserId, { action: 'extract_html' })).data as BrowserActEvidence;
  assert.match(html.extraction!.text, /<form id="form"/);
  assert.equal(html.extraction!.mediaType, 'text/html');

  const shot = (await act(f, session.browserId, { action: 'screenshot' })).data as BrowserActEvidence;
  assert.ok(shot.screenshot);
  const png = await readFile(join(f.outputRoot, shot.screenshot!.path));
  assert.equal(shot.screenshot!.sha256, sha256(png));
  assert.equal(shot.screenshot!.bytes, png.byteLength);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(png.byteLength <= 2 * 1024 * 1024);
  assert.equal(shot.screenshot!.mediaType, 'image/png');

  // Every allowed request stayed inside the approved origin; the out-of-scope origin was never reached.
  const log = f.pack.inspect(session.browserId)!;
  const allowed = log.network.filter(entry => entry.decision === 'allowed');
  assert.ok(allowed.length >= 2, 'the document and in-scope subresources were observed');
  for (const entry of allowed) assert.equal(new URL(entry.url).origin, fixture.origin, `${entry.url} must be in scope`);
  assert.ok(log.blocked.length >= 2, 'out-of-scope subresources were blocked');
  assert.deepEqual([...new Set(log.blocked.map(entry => entry.reason))], ['TARGET_DENIED']);
  assert.equal(fixture.outsideHits.length, 0, 'out-of-scope origin received no request');
  assert.ok(fixture.hits.some(hit => hit.path === '/app'));

  // The broker receipt is the evidence-collector contract: one JSON artifact, host-browser isolation.
  const receipt = f.receipts.at(-1)!;
  assert.equal(receipt.artifacts.length, 1);
  assert.equal(receipt.artifacts[0]!.mediaType, 'application/json');
  assert.equal(receipt.artifacts[0]!.redacted, true);
  assert.match(receipt.isolation, /^host-browser:not-container-isolated:/);
  assert.deepEqual([...receipt.targets], ['fixture-target']);
  assert.equal(receipt.classification, 'observation-not-verified-finding');
  const artifact = await readFile(join(f.outputRoot, receipt.artifacts[0]!.path), 'utf8');
  assert.equal(sha256(artifact), receipt.artifacts[0]!.sha256);
  assert.equal((JSON.parse(artifact) as { action: string }).action, 'screenshot');
  assert.ok(JSON.stringify(Object.keys(receipt.budgets)) === JSON.stringify(['fixture-target']));
  assert.ok(receipt.budgets['fixture-target']!.requests >= 2, 'in-scope requests charged the target budget');

  // status and close: the process really stops, the profile is removed, further actions are refused.
  const pid = f.pack.inspect(session.browserId)!.pid;
  const status = (await f.broker.execute({ context: contextA, ...sessionInput(session.browserId, 'status') })).data as BrowserSessionEvidence;
  assert.equal(status.status, 'open');
  const closed = (await f.broker.execute({ context: contextA, ...sessionInput(session.browserId, 'close') })).data as BrowserSessionEvidence;
  assert.equal(closed.status, 'closed');
  assert.equal(f.pack.sessions, 0);
  assert.throws(() => process.kill(pid, 0));
  await assert.rejects(act(f, session.browserId, { action: 'snapshot' }), code('UNAVAILABLE'));
});

test('cross-origin navigation, non-http navigation and a cross-origin redirect hop are refused before egress', async t => {
  if (!(await chromePin())) return t.skip('no host Chrome available');
  const fixture = await jsFixture(t);
  const f = await browserFixture(t, { scope: browserScope([fixture.origin]) });
  const session = await openSession(f, `${fixture.origin}/app`);
  await assert.rejects(act(f, session.browserId, { action: 'navigate', url: `${fixture.outsideOrigin}/xhr` }), code('TARGET_DENIED'));
  await assert.rejects(act(f, session.browserId, { action: 'navigate', url: 'file:///etc/passwd' }), code('TARGET_DENIED'));
  await assert.rejects(act(f, session.browserId, { action: 'navigate', url: `${fixture.origin}/excluded/private` }), code('TARGET_DENIED'));
  // The redirect target is a separate intercepted request; it is blocked, so the outside origin is never hit.
  await act(f, session.browserId, { action: 'navigate', url: `${fixture.origin}/redir` }).catch(() => undefined);
  const log = f.pack.inspect(session.browserId)!;
  assert.ok(log.blocked.some(entry => entry.url.startsWith(`${fixture.outsideOrigin}/redirected`) && entry.reason === 'TARGET_DENIED'));
  assert.equal(fixture.outsideHits.length, 0);
  assert.equal(fixture.hits.filter(hit => hit.path === '/excluded/private').length, 0);
  // The session survived the refusals and still works.
  const still = (await act(f, session.browserId, { action: 'extract_text' })).data as BrowserActEvidence;
  assert.match(still.url, /^(?:http:\/\/127\.0\.0\.1:|chrome-error:)/, 'the blocked redirect left an error page, never the outside origin');
});

test('non-scope subresources and websocket upgrades are blocked at the gate before leaving the host', async t => {
  if (!(await chromePin())) return t.skip('no host Chrome available');
  const fixture = await jsFixture(t);
  const f = await browserFixture(t, { scope: browserScope([fixture.origin]) });
  const session = await openSession(f, `${fixture.origin}/app`);
  await sleep(300);
  assert.equal(fixture.outsideHits.length, 0, 'fetch/image/websocket to the out-of-scope origin never egressed');
  const log = f.pack.inspect(session.browserId)!;
  const urls = log.blocked.map(entry => entry.url);
  assert.ok(urls.includes(`${fixture.outsideOrigin}/xhr`), `XHR blocked: ${urls.join(',')}`);
  assert.ok(urls.includes(`${fixture.outsideOrigin}/pixel.png`), `image blocked: ${urls.join(',')}`);
  assert.ok(log.blocked.some(entry => entry.resourceType === 'WebSocket' || entry.resourceType === 'CONNECT'), `websocket/wss egress blocked: ${urls.join(',')}`);
  assert.equal(fixture.outsideHits.some(hit => hit.path === '/ws'), false);
  assert.ok(log.blocked.every(entry => entry.reason === 'TARGET_DENIED'));
  // Chrome's own background services also arrive at the proxy and are denied there; nothing is allowed off-scope.
  assert.ok(log.network.every(entry => entry.decision !== 'allowed' || new URL(entry.url).origin === fixture.origin));
});

test('session action budget, per-session request budget and the target budget all fail closed', async t => {
  if (!(await chromePin())) return t.skip('no host Chrome available');
  const fixture = await jsFixture(t);
  const actions = await browserFixture(t, { scope: browserScope([fixture.origin]), maxActionsPerSession: 2 });
  const session = await openSession(actions, `${fixture.origin}/app`);
  assert.equal(session.budget.actions, 0, 'opening a session is not charged as an action');
  await act(actions, session.browserId, { action: 'snapshot' });
  await act(actions, session.browserId, { action: 'snapshot' });
  await assert.rejects(act(actions, session.browserId, { action: 'snapshot' }), code('BUDGET_EXCEEDED'));

  const requests = await browserFixture(t, { scope: browserScope([fixture.origin]), maxRequestsPerSession: 1 });
  const limited = await openSession(requests, `${fixture.origin}/app`);
  assert.equal(limited.budget.requests, 1);
  await assert.rejects(act(requests, limited.browserId, { action: 'navigate', url: `${fixture.origin}/text` }), code('BUDGET_EXCEEDED'));
  // The exhausted session refuses further actions rather than allowing uncounted traffic.
  await assert.rejects(act(requests, limited.browserId, { action: 'snapshot' }), code('BUDGET_EXCEEDED'));
  assert.ok(requests.budgets.snapshot('fixture-target').requests >= 1);
  assert.equal(requests.budgets.snapshot('fixture-target').active, 0);
});

test('sessions are attempt-bound: another attempt can never reuse a live or a released session', async t => {
  if (!(await chromePin())) return t.skip('no host Chrome available');
  const fixture = await jsFixture(t);
  const f = await browserFixture(t, { scope: browserScope([fixture.origin]) });
  const session = await openSession(f, `${fixture.origin}/app`, contextA);
  await assert.rejects(f.broker.execute({ context: contextB, tool: 'browser.act', input: { browserId: session.browserId, action: 'snapshot' } }), code('IDENTITY_DENIED'));
  await assert.rejects(f.broker.execute({ context: contextB, ...sessionInput(session.browserId, 'status') }), code('IDENTITY_DENIED'));
  await act(f, session.browserId, { action: 'snapshot' }, contextA);
  const pid = f.pack.inspect(session.browserId)!.pid;
  assert.equal(await f.pack.releaseAttempt(contextA), 1);
  assert.equal(f.pack.sessions, 0);
  assert.throws(() => process.kill(pid, 0));
  await assert.rejects(act(f, session.browserId, { action: 'snapshot' }, contextA), code('UNAVAILABLE'));
  await assert.rejects(f.broker.execute({ context: contextB, ...sessionInput(session.browserId, 'status') }), code('IDENTITY_DENIED'));
  await assert.rejects(act(f, session.browserId, { action: 'snapshot' }, contextB), code('UNAVAILABLE'));
});

test('attempt release kills the browser, removes the private profile and leaves no session behind', async t => {
  if (!(await chromePin())) return t.skip('no host Chrome available');
  const fixture = await jsFixture(t);
  const f = await browserFixture(t, { scope: browserScope([fixture.origin]) });
  const session = await openSession(f, `${fixture.origin}/app`);
  const info = f.pack.inspect(session.browserId)!;
  const profile = await lstat(info.profile);
  assert.equal(profile.isDirectory(), true);
  assert.equal(profile.mode & 0o077, 0);
  assert.equal(info.profile.startsWith(f.profileRoot), true);
  assert.equal(await f.pack.releaseAttempt(contextA), 1);
  await assert.rejects(lstat(info.profile));
  assert.deepEqual(await readdir(f.profileRoot), []);
  assert.equal(f.pack.sessions, 0);
});

test('the grant deadline kills the session and the tombstone refuses further actions', async t => {
  if (!(await chromePin())) return t.skip('no host Chrome available');
  const fixture = await jsFixture(t);
  const grantExpiresAt = new Date(Date.now() + 25000).toISOString();
  const f = await browserFixture(t, { scope: browserScope([fixture.origin], { grantExpiresAt }), sessionTtlMs: 3000 });
  const session = await openSession(f, `${fixture.origin}/app`);
  assert.equal(f.pack.sessions, 1);
  await sleep(4200);
  assert.equal(f.pack.sessions, 0, 'the session deadline killed the browser');
  await assert.rejects(act(f, session.browserId, { action: 'snapshot' }), code('UNAVAILABLE'));
  const log = f.pack.inspect(session.browserId);
  assert.equal(log, undefined);
});

test('DNS rebinding at connect time is refused after the session pinned its address', async t => {
  if (!(await chromePin())) return t.skip('no host Chrome available');
  const fixture = await jsFixture(t);
  const origin = `http://fixture.test:${new URL(fixture.origin).port}`;
  let rebound = false;
  const resolver = async () => (rebound ? ['192.0.2.1'] : ['127.0.0.1']);
  const f = await browserFixture(t, { scope: browserScope([origin]), resolver });
  const session = await openSession(f, `${origin}/app`);
  assert.equal(fixture.hits.filter(hit => hit.path === '/app').length, 1);
  rebound = true;
  await assert.rejects(act(f, session.browserId, { action: 'navigate', url: `${origin}/text` }), code('DNS_CHANGED'));
  assert.equal(fixture.hits.filter(hit => hit.path === '/text').length, 0, 'no request egressed after the DNS answer changed');
  assert.equal(fixture.outsideHits.length, 0);
});

test('credential-owning accounts are refused for browser sessions; only anonymous approved accounts are used', async t => {
  if (!(await chromePin())) return t.skip('no host Chrome available');
  const fixture = await jsFixture(t);
  const f = await browserFixture(t, { scope: browserScope([fixture.origin], { accountIds: ['anonymous', 'credential-user'] }) });
  await assert.rejects(
    f.broker.execute({ context: contextA, tool: 'browser.session', input: { action: 'open', url: `${fixture.origin}/app`, accountId: 'credential-user' } }),
    code('ACCOUNT_DENIED'),
  );
  assert.equal(f.pack.sessions, 0, 'no browser was launched for a credential account');
});

test('doctor and the dispatcher fail closed without the acknowledged host-browser pack, and identity drift is refused', async t => {
  const pin = await chromePin();
  if (!pin) return t.skip('no host Chrome available');
  const fixture = await jsFixture(t);
  const paths = await roots(t);
  const scope = browserScope([fixture.origin]);
  const policy = createPolicy(scope);
  const targets = policy.scope.targets;
  const localSandbox = createLocalFixtureSandbox({ ...paths, trustedInputSnapshot: true, acknowledgement: 'local-fixtures-only-not-hostile-code-isolation' });
  const localReport = await doctor({ registry: createDefaultRegistry({ browser: true }), sandbox: localSandbox, required: ['browser.session'], budgets: memoryBudget(targets, scope.runId) });
  assert.equal(localReport.ok, false);
  assert.ok(localReport.checks.some(check => check.name === 'browser-pack' && !check.ok));
  assert.ok(localReport.checks.some(check => check.name === 'browser.session' && !check.ok));
  // A local-fixture broker refuses the capability even when the registry provisions it.
  const localBroker = createToolBroker({ policy, budgets: memoryBudget(targets, scope.runId), sandbox: localSandbox, registry: createDefaultRegistry({ browser: true }) });
  await assert.rejects(localBroker.execute({ context: contextA, tool: 'browser.session', input: { action: 'open', url: `${fixture.origin}/app`, accountId: 'anonymous' } }), code('UNAVAILABLE'));
  // The pack is not provisioned unless the run enables it.
  assert.throws(() => createDefaultRegistry().get('browser.session'), code('CAPABILITY_DENIED'));

  const hostSandbox = createHostBrowserSandbox({ ...paths, trustedInputSnapshot: true, browser: { acknowledgement: 'host-browser-not-container-isolated', approvedBy: 'fixture-owner', expiresAt: '2099-01-01T00:00:00.000Z', egress: 'loopback-only', profileRoot: paths.profileRoot, identity: pin } });
  const hostReport = await doctor({ registry: createDefaultRegistry({ browser: true }), sandbox: hostSandbox, required: ['browser.session', 'browser.act'], budgets: memoryBudget(targets, scope.runId) });
  assert.equal(hostReport.ok, true, JSON.stringify(hostReport.checks.filter(check => !check.ok)));
  assert.ok(hostReport.checks.some(check => check.name === 'browser-identity' && check.ok));
  assert.ok(hostReport.checks.some(check => check.name === 'browser-pack' && check.ok));

  // (a) a substituted file at a pinned path, (b) a hash-consistent impostor that lies about its version.
  const fake = join(paths.profileRoot, 'fake-chrome');
  await writeFile(fake, '#!/bin/sh\necho "Google Chrome 999.0.0.0"\n', { mode: 0o700 });
  const fakeHash = sha256(await readFile(fake));
  await assert.rejects(verifyChromeIdentity({ ...pin, launcher: fake, executable: fake }), code('UNAVAILABLE'));
  await assert.rejects(verifyChromeIdentity({ launcher: fake, launcherSha256: fakeHash, executable: fake, executableSha256: fakeHash, version: pin.version, product: pin.product }), code('UNAVAILABLE'));
  const spoofed = createHostBrowserSandbox({ ...paths, trustedInputSnapshot: true, browser: { acknowledgement: 'host-browser-not-container-isolated', approvedBy: 'fixture-owner', expiresAt: '2099-01-01T00:00:00.000Z', egress: 'loopback-only', profileRoot: paths.profileRoot, identity: { ...pin, executableSha256: 'a'.repeat(64) } } });
  const spoofReport = await doctor({ registry: createDefaultRegistry({ browser: true }), sandbox: spoofed, required: ['browser.session'], budgets: memoryBudget(targets, scope.runId) });
  assert.equal(spoofReport.ok, false);
  assert.ok(spoofReport.checks.some(check => check.name === 'browser-identity' && !check.ok));
  const spoofPack = createBrowserPack({ policy, budgets: memoryBudget(targets, scope.runId), sandbox: spoofed, resolver: async () => ['127.0.0.1'] });
  const spoofBroker = createToolBroker({ policy, budgets: memoryBudget(targets, scope.runId), sandbox: spoofed, registry: createDefaultRegistry({ browser: true }), browser: spoofPack });
  await assert.rejects(spoofBroker.execute({ context: contextA, tool: 'browser.session', input: { action: 'open', url: `${fixture.origin}/app`, accountId: 'anonymous' } }), code('UNAVAILABLE'));
  await spoofPack.close();
});

test('capability descriptor tampering is refused: isolation, actions, side effects, schemas, identity and limits', async t => {
  const registry = createDefaultRegistry({ browser: true });
  const tamper = (id: 'browser.session' | 'browser.act', patch: Partial<ToolDescriptor>) => new CapabilityRegistry(
    registry.list().map(descriptor => (descriptor.id === id ? { ...descriptor, ...patch } : descriptor)),
  );
  assert.throws(() => tamper('browser.act', { isolation: ['local-fixture'] }), code('INVALID_INPUT'));
  assert.throws(() => tamper('browser.session', { isolation: ['local-fixture', 'container'] }), code('INVALID_INPUT'));
  assert.throws(() => tamper('browser.session', { actions: ['read', 'mutate'] }), code('INVALID_INPUT'));
  assert.throws(() => tamper('browser.act', { sideEffects: ['target-request', 'write-private-artifact'] }), code('INVALID_INPUT'));
  assert.throws(() => tamper('browser.act', { sideEffects: ['target-request', 'write-private-artifact', 'explicit-mutation', 'read-trusted-input'] }), code('INVALID_INPUT'));
  assert.throws(() => tamper('browser.session', { implementationDigest: 'b'.repeat(64) }), code('INVALID_INPUT'));
  assert.throws(() => tamper('browser.session', { inputSchema: { type: 'object' } }), code('INVALID_INPUT'));
  assert.throws(() => tamper('browser.act', { version: '2.0.0' }), code('INVALID_INPUT'));
  const descriptor = registry.get('browser.act');
  assert.throws(() => tamper('browser.act', { limits: { ...descriptor.limits, maxRedirects: 99 } }), code('INVALID_INPUT'));
  // The untampered descriptors are accepted and declare the honest boundary.
  assert.deepEqual([...descriptor.isolation], ['host-browser']);
  assert.deepEqual([...descriptor.sideEffects], ['target-request', 'explicit-mutation', 'write-private-artifact']);
});

test('launch hygiene: private throwaway profile, no host profile, no debug port or host path in environment or evidence', async t => {
  if (!(await chromePin())) return t.skip('no host Chrome available');
  const hostProfileDefault = join(homedir(), '.config', 'google-chrome', 'Default');
  const hostProfileExists = existsSync(hostProfileDefault);
  const fixture = await jsFixture(t);
  const f = await browserFixture(t, { scope: browserScope([fixture.origin]) });
  const session = await openSession(f, `${fixture.origin}/app`);
  const info = f.pack.inspect(session.browserId)!;
  const evidence = JSON.stringify(session) + JSON.stringify(f.receipts.at(-1));
  assert.equal(evidence.includes(info.profile), false, 'no host profile path in worker-visible evidence');
  assert.equal(evidence.includes('/devtools/browser'), false);
  assert.equal(evidence.includes('DevToolsActivePort'), false);
  assert.equal(evidence.includes('--remote-debugging-port'), false);
  assert.equal(evidence.includes('--user-data-dir'), false);
  assert.equal('pid' in session, false);
  for (const value of Object.values(process.env)) {
    if (typeof value !== 'string') continue;
    assert.equal(value.includes(info.profile), false, `environment leaked the profile path: ${value}`);
    assert.equal(value.includes('DevToolsActivePort'), false);
    assert.equal(/remote-debugging-port/.test(value), false);
  }
  const profile = await lstat(info.profile);
  assert.equal(profile.mode & 0o077, 0);
  assert.equal(info.profile.startsWith(f.profileRoot), true);
  if (hostProfileExists) assert.equal(info.profile.startsWith(hostProfileDefault), false, 'the throwaway profile is not the host profile');
  // The browser only listens on loopback for its own debugging endpoint; nothing else was recorded in evidence.
  assert.ok(info.chromeVersion === f.pin.version);
});

test('session limit and unknown/stale session ids are refused without side effects', async t => {
  if (!(await chromePin())) return t.skip('no host Chrome available');
  const fixture = await jsFixture(t);
  const f = await browserFixture(t, { scope: browserScope([fixture.origin]), maxSessions: 1 });
  const session = await openSession(f, `${fixture.origin}/app`);
  await assert.rejects(openSession(f, `${fixture.origin}/text`), code('BUDGET_EXCEEDED'));
  assert.equal(f.pack.sessions, 1);
  await assert.rejects(f.broker.execute({ context: contextA, ...sessionInput('bs-does-not-exist', 'status') }), code('INVALID_INPUT'));
  await assert.rejects(f.broker.execute({ context: contextA, tool: 'browser.act', input: { browserId: 'bs-does-not-exist', action: 'snapshot' } }), code('UNAVAILABLE'));
  await f.broker.execute({ context: contextA, ...sessionInput(session.browserId, 'close') });
  assert.equal(f.pack.sessions, 0);
});

test('sandbox acknowledgement and isolation claims are explicit', async t => {
  const fixture = await jsFixture(t);
  const paths = await roots(t);
  const pin = await chromePin();
  if (!pin) return t.skip('no host Chrome available');
  // A host-browser sandbox without the exact acknowledgement is refused at construction time.
  assert.throws(() => createHostBrowserSandbox({
    ...paths, trustedInputSnapshot: true,
    browser: { acknowledgement: 'anything-else' as never, approvedBy: 'fixture-owner', expiresAt: '2099-01-01T00:00:00.000Z', egress: 'loopback-only', profileRoot: paths.profileRoot, identity: pin },
  }), code('UNAVAILABLE'));
  const sandbox = createHostBrowserSandbox({
    ...paths, trustedInputSnapshot: true,
    browser: { acknowledgement: 'host-browser-not-container-isolated', approvedBy: 'fixture-owner', expiresAt: '2099-01-01T00:00:00.000Z', egress: 'loopback-only', profileRoot: paths.profileRoot, identity: pin },
  });
  assert.equal(sandbox.mode, 'host-browser');
  assert.match(sandbox.boundary, /not-container-isolated/);
  assert.equal(sandbox.browser?.enabled, true);
  const scope = browserScope([fixture.origin]);
  const policy = createPolicy(scope);
  const budgets = new TargetBudget(policy.scope.targets, { runId: scope.runId });
  const report = await sandbox.preflight();
  assert.equal(report.ok, true);
  assert.ok(report.checks.some(check => check.name === 'browser-acknowledgement' && check.ok));
  // assertEgress stays loopback-only in fixture egress mode even after preflight.
  assert.throws(() => sandbox.assertEgress('192.0.2.1'), code('ADDRESS_DENIED'));
  assert.equal(budgets.durable, false);
});
