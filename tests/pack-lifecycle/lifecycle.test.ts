import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { environment, chromePin, listenerState, identityAlive, exists, waitFor, sleep } from './fixtures.js';
import { currentProcessIdentity, recoverBrowserResources, type BrowserOwnerRecord } from '../../src/tools/browser-lifecycle.js';
import { PackCreationFence } from '../../src/tools/pack-session.js';
import type { ProcessIdentity, RuntimeHandle } from '../../src/runtime/types.js';
import { createProxyPack } from '../../src/tools/proxy/pack.js';
import { createBrowserPack } from '../../src/tools/browser-session.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'p2o-pack-lifecycle-'));
  const hits: string[] = [];
  const activeHold = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    hits.push(req.url ?? '/');
    res.setHeader('content-type', 'text/html');
    if (req.url === '/hold') { activeHold.add(res); res.once('close', () => activeHold.delete(res)); res.write('<html>pending'); return; }
    res.end('<html><title>Local lifecycle</title><body><button>loopback only</button></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let env: Awaited<ReturnType<typeof environment>> | undefined;
  const handles: RuntimeHandle[] = [];
  t.after(async () => {
    try {
      if (env) {
        for (const handle of handles) await env.runtime.stop(handle).catch(() => {});
        await env.close();
      }
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  const pin = await chromePin(); // Missing Chrome is a failure, never a silent "verified" skip.
  env = await environment(root, origin, pin);
  const fixtureEnv = env;
  const start = async (mode: Record<string, unknown>, deadlineAt?: number) => { const request = await fixtureEnv.request(mode, deadlineAt); const handle = await fixtureEnv.runtime.start(request); handles.push(handle); await fixtureEnv.ready(handle); return { request, handle }; };
  return { ...fixtureEnv, root, pin, handles, start, hits, activeHold };
}
async function gone(opened: Awaited<ReturnType<Awaited<ReturnType<typeof environment>>['open']>>) {
  assert.equal(await identityAlive(opened.identity), false, 'exact Chrome kernel identity must be gone');
  for (const identity of opened.family) assert.equal(await identityAlive(identity), false, `recorded Chrome descendant ${identity.pid}/${identity.startTicks} must be gone`);
  assert.equal(await exists(opened.inspected.profile), false, 'private Chrome profile is removed after proof');
  for (const port of opened.ports) assert.equal(await listenerState(port), 'refused', `old proxy/CDP port ${port} must refuse connections`);
  assert.equal(opened.pack.browser.sessions, 0); assert.equal(opened.pack.proxy.sessions, 0);
}
function trace(label: string, data: unknown) { console.log(`LIFECYCLE_TRACE ${JSON.stringify({ label, data })}`); }

for (const outcome of ['stopped', 'completed', 'timed-out'] as const) test(`real Chrome + capture listeners close on ${outcome}; stale actions/tokens are rejected`, { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const { handle } = await f.start(outcome === 'completed' ? { settleFile: 'finish' } : { hold: true, ignoreTerm: true }, outcome === 'timed-out' ? Date.now() + 6500 : undefined);
  const opened = await f.open(handle);
  assert.equal(await identityAlive(opened.identity), true);
  for (const port of opened.ports) assert.equal(await listenerState(port), 'open');
  assert.ok(f.hits.includes('/'), 'actual local Chrome navigation reached the approved loopback app');
  assert.equal((await f.runtime.sessions.inventory(handle, 'browser-pack')).length, 1);
  if (outcome === 'completed') await writeFile(path.join(f.workspace, 'finish'), 'controller-triggered inert completion');
  else if (outcome === 'stopped') await Promise.all([f.runtime.stop(handle), f.runtime.stop(handle)]);
  const terminal = await waitFor(async () => { const c = await f.runtime.collect(handle); return c.outcome === outcome && c.handle.sessionRelease ? c.handle : undefined; }, 8500, `${outcome} plus durable pack release`);
  assert.equal(terminal.stopReceipt?.verified, true);
  assert.equal(terminal.sessionRelease?.verified, true, JSON.stringify(terminal.sessionRelease));
  assert.equal(terminal.sessionRelease?.releasers.find(r => r.name === 'browser-pack')?.released, 1);
  assert.equal(terminal.sessionRelease?.releasers.find(r => r.name === 'proxy-pack')?.released, 1);
  await gone(opened);
  await assert.rejects(f.act(handle, opened.browser.browserId), /sealed|closed/);
  await assert.rejects(f.history(handle, opened.proxy.proxyId), /sealed|closed/);
  await assert.rejects(f.runtime.sessions.assertOpen(handle, handle.ownerToken), /sealed/);
  const replay = await f.runtime.sessions.release(handle, handle.ownerToken, 'stopped');
  assert.equal(replay.duplicate, true); assert.equal(replay.verified, true);
  trace(outcome, { chrome: opened.identity, descendants: opened.family, session: opened.browser.browserId, ports: opened.ports, profileRemoved: true, receipt: terminal.sessionRelease, staleTokenRejected: true, staleSessionRejected: true });
});

test('checkpoint/resume opens new Chrome/proxy sessions and cannot reuse old attempt token/session IDs', { timeout: 20_000 }, async t => {
  const f = await fixture(t), { request, handle } = await f.start({ hold: true, ignoreTerm: true });
  const old = await f.open(handle);
  const checkpoint = await f.runtime.checkpoint(handle); await gone(old);
  assert.equal(checkpoint.restoredToolProcesses, false);
  const next = await f.runtime.resume(checkpoint, { ...request, attemptId: 'two' }); f.handles.push(next); await f.ready(next);
  const fresh = await f.open(next);
  assert.notEqual(fresh.browser.browserId, old.browser.browserId); assert.notEqual(fresh.proxy.proxyId, old.proxy.proxyId);
  assert.notEqual(next.ownerToken, handle.ownerToken); assert.notEqual(next.sessionId, handle.sessionId);
  await assert.rejects(f.runtime.sessions.assertOpen(handle, handle.ownerToken), /sealed/);
  await assert.rejects(f.runtime.sessions.assertOpen(next, handle.ownerToken), /another attempt owner/);
  await assert.rejects(old.pack.browser.execute({ context: fresh.context, capability: 'browser.act', input: { action: 'snapshot', browserId: old.browser.browserId }, descriptor: {} as never, touchedTargets: new Set() }), /different attempt/);
  await assert.rejects(old.pack.proxy.execute({ context: fresh.context, capability: 'proxy.history', input: { action: 'list', proxyId: old.proxy.proxyId }, descriptor: {} as never, touchedTargets: new Set() }), /sealed|another attempt|different attempt/);
  assert.equal((await f.runtime.sessions.release(handle, handle.ownerToken, 'stopped')).duplicate, true); // old teardown cannot touch the replacement
  await f.act(next, fresh.browser.browserId);
  await f.runtime.stop(next); await gone(fresh);
  trace('resume', { old: { session: old.browser.browserId, ports: old.ports }, fresh: { session: fresh.browser.browserId, ports: fresh.ports }, oldTokenRejected: true, oldSessionsRejected: true, restoredToolProcesses: false });
});

test('local creation fence waits for a creator and denies publication after teardown seals it', { timeout: 5000 }, async () => {
  let release!: () => void, started!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  const fence = new PackCreationFence();
  const scope = { runId: 'race', taskId: 'task', attemptId: 'one' };
  const pending = fence.create(scope, async () => { started(); await wait; await fence.check(scope); });
  await entered;
  let sealed = false;
  const stopping = fence.seal(scope).then(() => { sealed = true; });
  await sleep(10); assert.equal(sealed, false);
  release(); await assert.rejects(pending, /sealed/); await stopping;
  assert.equal(sealed, true); await assert.rejects(fence.create(scope, async () => {}), /sealed/);
});
test('actual listener creation racing runtime stop is quiesced; no early empty verified receipt', { timeout: 12_000 }, async t => {
  const f = await fixture(t), { handle } = await f.start({ hold: true, ignoreTerm: true });
  const existing = f.packsFor(handle);
  const binding = f.runtime.sessions.binding(handle, handle.ownerToken, 'proxy-pack');
  let unblock!: () => void, entered!: () => void, port = 0;
  const paused = new Promise<void>(resolve => { unblock = resolve; }), atListener = new Promise<void>(resolve => { entered = resolve; });
  const proxy = createProxyPack({ policy: f.policy, budgets: f.budgets, sandbox: f.sandbox, lifecycle: { ...binding,
    async update(context, id, data) {
      await binding.update(context, id, data);
      port = (data.ports as number[])[0]!; entered(); await paused;
    },
  } });
  f.attempts.set(handle.attemptId, { browser: existing.browser, proxy });
  const opening = proxy.execute({ context: { runId: handle.runId, taskId: handle.taskId, attemptId: handle.attemptId, grantId: 'grant-one' }, capability: 'proxy.session', input: { action: 'start', origins: [f.origin], accountId: 'anonymous' }, descriptor: f.descriptors.get('proxy.session'), touchedTargets: new Set() });
  void opening.catch(() => {});
  await atListener;
  assert.equal(await listenerState(port), 'open', 'real listener exists before the race');
  let done = false;
  const stop = f.runtime.stop(handle).then(receipt => { done = true; return receipt; });
  await sleep(25); assert.equal(done, false, 'teardown cannot publish a verified empty count before creator quiescence');
  await waitFor(async () => { try { await f.runtime.sessions.assertOpen(handle, handle.ownerToken); return undefined; } catch (error) { return /sealed/.test(String(error)) ? true : undefined; } }, 1500, 'runtime sealed the actual pack lease');
  unblock(); await assert.rejects(opening);
  assert.equal((await stop).verified, true);
  assert.equal((await f.runtime.collect(handle)).handle.sessionRelease?.verified, true);
  assert.equal(await listenerState(port), 'refused');
  assert.equal((await f.runtime.sessions.inventory(handle, 'proxy-pack')).length, 0);
  trace('create-stop-race', { port, refused: true, noEarlyReceipt: true });
});

test('stop cancels and quiesces an actual in-flight proxy repeat socket, not only the listener', { timeout: 12_000 }, async t => {
  const f = await fixture(t), { handle } = await f.start({ hold: true, ignoreTerm: true });
  const pack = f.packsFor(handle), context = { runId: handle.runId, taskId: handle.taskId, attemptId: handle.attemptId, grantId: 'grant-one' };
  const started = await pack.proxy.execute({ context, capability: 'proxy.session', input: { action: 'start', origins: [f.origin], accountId: 'anonymous' }, descriptor: f.descriptors.get('proxy.session'), touchedTargets: new Set() });
  assert.equal(started.kind, 'proxy-session'); const proxyId = (started as { proxyId: string }).proxyId;
  const port = pack.proxy.inspect(proxyId)!.port;
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: `${f.origin}/`, headers: { host: new URL(f.origin).host, connection: 'close' } }, response => { response.resume(); response.once('end', resolve); response.once('error', reject); });
    request.once('error', reject); request.end();
  });
  const id = await waitFor(async () => { const result = await f.history(handle, proxyId); return (result as { entries?: { id: string }[] }).entries?.[0]?.id; }, 1000, 'real captured request record');
  const repeat = pack.proxy.execute({ context, capability: 'proxy.history', input: { action: 'repeat', proxyId, requestId: id, url: `${f.origin}/hold` }, descriptor: f.descriptors.get('proxy.history'), touchedTargets: new Set() });
  void repeat.catch(() => {});
  await waitFor(async () => f.activeHold.size === 1 ? true : undefined, 1000, 'actual repeat socket at loopback upstream');
  assert.equal((await f.runtime.stop(handle)).verified, true);
  await assert.rejects(repeat);
  await waitFor(async () => f.activeHold.size === 0 ? true : undefined, 500, 'upstream repeat connection closed');
  assert.equal(await listenerState(port), 'refused');
  assert.equal((await f.runtime.collect(handle)).handle.sessionRelease?.verified, true);
  trace('inflight-repeat-stop', { port, listenerRefused: true, activeRepeatSockets: f.activeHold.size });
});


test('isolated controller SIGKILL leaves actual Chrome; fresh recovery closes exact family, never a decoy/recycled PID', { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const settings = path.join(f.root, 'controller-settings.json'); await writeFile(settings, JSON.stringify({ root: f.root, origin: f.origin, pin: f.pin }));
  const child = fork(fileURLToPath(new URL('./controller.js', import.meta.url)), [settings], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const ready = await new Promise<{ handle: RuntimeHandle; controller: ProcessIdentity; browserId: string; proxyId: string; identity: ProcessIdentity; profile: string; ports: number[] }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child handshake exhausted: ${stderr}`)), 10_000);
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Controller exited before ready: ${code}/${signal}: ${stderr}`)); });
    child.once('message', message => { clearTimeout(timer); const m = message as { kind: string; message?: string }; if (m.kind === 'error') reject(new Error(m.message)); else resolve(message as never); });
  });
  assert.equal(await identityAlive(ready.controller), true); assert.equal(await identityAlive(ready.identity), true);
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
  assert.equal(await identityAlive(ready.controller), false); assert.equal(await identityAlive(ready.identity), true, 'exit hooks were bypassed; a real browser still needs recovery');
  // Original controller-hosted listeners closed by kernel exit, CDP in Chrome remains live until sweep.
  assert.equal(await listenerState(ready.ports[0]!), 'refused'); assert.equal(await listenerState(ready.ports[2]!), 'open');
  const decoy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const decoyIdentity = currentProcessIdentity(decoy.pid!);
  t.after(async () => { if (await identityAlive(decoyIdentity)) { decoy.kill('SIGKILL'); await new Promise<void>(resolve => decoy.once('exit', () => resolve())); } });
  const manifestFile = path.join(ready.profile, 'p2o-owner.json'), original = await readFile(manifestFile, 'utf8');
  const manifest = JSON.parse(original) as BrowserOwnerRecord;
  // Real unrelated PID + start-time identity, wrong actual session/profile argv. Recovery MUST refuse it.
  const resources = await f.runtime.sessions.inventory(ready.handle, 'browser-pack');
  await writeFile(manifestFile, JSON.stringify({ ...manifest, process: decoyIdentity }));
  await assert.rejects(recoverBrowserResources(resources, ready.handle, (await f.runtime.sessions.read(ready.handle))!.owner, f.profileRoot), /identity mismatch/);
  assert.equal(await identityAlive(decoyIdentity), true); assert.equal(await identityAlive(ready.identity), true);
  const decoyResources = resources.map(resource => ({ ...resource, data: { ...resource.data, process: decoyIdentity, processes: [] } }));
  await writeFile(manifestFile, JSON.stringify({ ...manifest, process: decoyIdentity, processes: [] }));
  await assert.rejects(recoverBrowserResources(decoyResources, ready.handle, (await f.runtime.sessions.read(ready.handle))!.owner, f.profileRoot), /actual profile\/session identity/);
  assert.equal(await identityAlive(decoyIdentity), true, 'matching recorded PID/startTicks still does not authorize unrelated actual argv');
  await writeFile(manifestFile, original);
  // Same numeric PID with mismatched startTicks is also not a kill authority, even with matching argv.
  const forged = resources.map(resource => ({ ...resource, data: { ...resource.data, process: { ...ready.identity, startTicks: '0' } } }));
  await assert.rejects(recoverBrowserResources(forged, ready.handle, (await f.runtime.sessions.read(ready.handle))!.owner, f.profileRoot), /identity mismatch/);
  assert.equal(await identityAlive(decoyIdentity), true);
  f.handles.push(ready.handle);
  const reconciled = await f.runtime.reconcile(ready.handle); assert.notEqual(reconciled.state, 'quarantined', reconciled.explanation);
  const sweep = await f.runtime.sweepStaleSessions(); assert.equal(sweep.verified, true, JSON.stringify(sweep)); assert.equal(sweep.swept, 1);
  assert.equal(await identityAlive(ready.identity), false); assert.equal(await exists(ready.profile), false);
  for (const port of ready.ports) assert.equal(await listenerState(port), 'refused');
  assert.equal(await identityAlive(decoyIdentity), true, 'fresh-controller cleanup must leave unrelated processes untouched');
  const stopped = await f.runtime.stop(ready.handle); assert.equal(stopped.verified, true);
  const final = (await f.runtime.collect(ready.handle)).handle; assert.equal(final.sessionRelease?.verified, true, JSON.stringify(final.sessionRelease));
  assert.deepEqual(final.sessionRelease!.releasers.map(result => result.name).sort(), ['browser-pack', 'proxy-pack'], 'crash recovery retains named non-empty actual per-pack proof');
  assert.equal(final.sessionRelease!.reason, 'crash-recovery');
  await assert.rejects(f.runtime.sessions.assertOpen(ready.handle, ready.handle.ownerToken), /sealed/);
  await assert.rejects(f.act(ready.handle, ready.browserId), /sealed|Unknown|not live/);
  trace('controller-crash', { controller: ready.controller, chrome: ready.identity, session: ready.browserId, ports: ready.ports, sweep, cleanupVerified: true, decoy: decoyIdentity, decoyUntouched: true });
});

test('a launch that fails after durable enrollment retires its exact resource once absence is proved', { timeout: 15_000 }, async t => {
  // Inert local fixture only: loopback origin, no model or target traffic. The wrapped binding fails the
  // first identity update AFTER its durable write, which is the window where a launch can abort.
  const f = await fixture(t), { handle } = await f.start({ hold: true, ignoreTerm: true });
  const existing = f.packsFor(handle);
  const binding = f.runtime.sessions.binding(handle, handle.ownerToken, 'browser-pack');
  let updates = 0;
  const browser = createBrowserPack({ policy: f.policy, budgets: f.budgets, sandbox: f.sandbox, resolver: async () => ['127.0.0.1'], egressProxy: existing.proxy.egressProxy,
    lifecycle: { ...binding, async update(context, id, data) { await binding.update(context, id, data); if (++updates === 1) throw new Error('CONTROLLED_FIRST_UPDATE_FAILURE_AFTER_DURABLE_IDENTITY'); } } });
  f.attempts.set(handle.attemptId, { browser, proxy: existing.proxy });
  const context = { runId: handle.runId, taskId: handle.taskId, attemptId: handle.attemptId, grantId: 'grant-one' };
  await assert.rejects(browser.execute({ context, capability: 'browser.session', input: { action: 'open', url: `${f.origin}/`, accountId: 'anonymous' }, descriptor: f.descriptors.get('browser.session'), touchedTargets: new Set() }), /CONTROLLED_FIRST_UPDATE_FAILURE/);
  assert.equal(updates, 1);
  assert.equal(browser.sessions, 0, 'a launch that never published a session is not a live session');
  assert.equal(browser.outstanding(context), 0);
  assert.equal((await f.runtime.sessions.inventory(handle, 'browser-pack')).length, 0, 'proved absence must retire the durable enrollment, not leave it stuck for the controller lifetime');
  const released = await f.runtime.sessions.release(handle, handle.ownerToken, 'stopped');
  assert.equal(released.verified, true, JSON.stringify(released));
  trace('failed-launch-retired', { browserSessions: browser.sessions, inventory: 0, releaseVerified: true });
});

test('graceful controller shutdown kills live real Chrome/proxy sessions and clears the durable inventory', { timeout: 20_000 }, async t => {
  const f = await fixture(t), { handle } = await f.start({ hold: true, ignoreTerm: true });
  const opened = await f.open(handle);
  assert.equal(await identityAlive(opened.identity), true);
  for (const port of opened.ports) assert.equal(await listenerState(port), 'open');
  await f.runtime.shutdown();
  await gone(opened);
  assert.equal((await f.runtime.sessions.inventory(handle, 'browser-pack')).length, 0);
  assert.equal((await f.runtime.sessions.inventory(handle, 'proxy-pack')).length, 0);
  trace('controller-shutdown', { chrome: opened.identity, ports: opened.ports, inventoryEmpty: true });
});

test('enrolled-before-allocation recovery requires the exact DEAD controller and never signals an unrelated process', { timeout: 10_000 }, async t => {
  const f = await fixture(t), { handle } = await f.start({ hold: true, ignoreTerm: true });
  const dead = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const deadIdentity = currentProcessIdentity(dead.pid!);
  dead.kill('SIGKILL'); await new Promise<void>(resolve => dead.once('exit', () => resolve()));
  assert.equal(await identityAlive(deadIdentity), false);
  const decoy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const decoyIdentity = currentProcessIdentity(decoy.pid!);
  t.after(async () => { if (await identityAlive(decoyIdentity)) { decoy.kill('SIGKILL'); await new Promise<void>(resolve => decoy.once('exit', () => resolve())); } });
  const scope = { runId: handle.runId, taskId: handle.taskId, attemptId: handle.attemptId };
  const owner = { instance: 'crashed-controller-instance', token: 'crashed-owner-token', process: deadIdentity, at: Date.now() };
  const id = `bs-${'a'.repeat(24)}`;
  const record = { pack: 'browser-pack', id, state: 'active' as const, data: { version: 2, sessionId: id, scope, controller: deadIdentity, profile: '' } };
  // A live controller is never recovery authority, even for a real record of its own run.
  await assert.rejects(recoverBrowserResources([record], scope, { ...owner, process: currentProcessIdentity() }, f.profileRoot), /still live/);
  // A process identity on an enroll-only record is contradictory: refuse without signalling anything.
  await assert.rejects(recoverBrowserResources([{ ...record, data: { ...record.data, process: decoyIdentity } }], scope, owner, f.profileRoot), /bounded private profile/);
  // A foreign scope cannot adopt this inventory.
  await assert.rejects(recoverBrowserResources([record], { ...scope, attemptId: 'foreign-attempt' }, owner, f.profileRoot), /identity mismatch/);
  // Exact dead controller + no allocation recorded => proved absence with zero signals.
  assert.deepEqual(await recoverBrowserResources([record], scope, owner, f.profileRoot), { released: 0, resolved: [id] });
  assert.equal(await identityAlive(decoyIdentity), true);
  trace('enrolled-only-recovery', { session: id, controller: deadIdentity, resolved: [id], decoyUntouched: true });
});
