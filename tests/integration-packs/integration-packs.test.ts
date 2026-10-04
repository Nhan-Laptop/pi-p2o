// [F3/F4] Application-level pack wiring: real sessions through the application broker and the runtime's own
// release paths. Every test here is offline (no model, provider, credential or external target).
//
// What is proven:
//   * a real capture listener and a real Chrome session are created through `application.brokerFor(...)` while an
//     owned attempt of a real run is live, on the boundary the owner document acknowledged;
//   * the SAME pack instances the broker dispatched to are released by the runtime on stop and on completion, and
//     the durable release verdict names them with a real killed-session count and no surviving session;
//   * after the release a stale attempt's pack calls are refused (attempt-liveness fence) and the listener is
//     really closed (ECONNREFUSED);
//   * the fuzzing pack is only reachable when the owner document opts in on a boundary that qualifies trusted
//     local modules;
//   * the runtime never reports a verified release for an empty releaser set, and the shipped composition
//     declares its pack set instead of leaving the verdict unprovable;
//   * the plan-port and generated-plan seams stay optional, typed against `planner.ts` and fail-closed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { LinuxProcessProbe, SessionReleaseRegistry } from '../../src/runtime/index.js';
import type { ToolExecutionError } from '../../src/tools/index.js';
import { createApplication, validateApplicationConfig, type ApplicationOverrides } from '../../src/application/index.js';
import { materializeRequestPlan, type RequestPlanLedger } from '../../src/application/planner.js';
import { createPackInstanceCloser, type PackInstanceSet } from '../../src/application/composition.js';
import type { ApplicationConfig } from '../../src/application/index.js';
import {
  GRANT, chromePin, deadIdentity, fuzzInput, leasesIn, ownIdentity, packRoots, preparePackApp, sessionLeases, startRun,
  terminalCaseLease, variant, waitForLiveCaseAttempt, waitForPackEvidence, HOLD_MS, RUN_ID, TASK_HYP_CASE,
} from './fixtures.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

void HOLD_MS;

/** Denial assertions: a refusal is a typed policy error plus an immutable denial receipt. */
async function expectDenial(work: Promise<unknown>, code: string, message: RegExp): Promise<ToolExecutionError> {
  try {
    await work;
  } catch (error) {
    const failure = error as ToolExecutionError;
    assert.equal(failure.code, code, `expected ${code}, got ${failure.code}: ${failure.message}`);
    assert.match(failure.message, message);
    assert.equal(failure.receipt.outcome, code === 'UNAVAILABLE' ? 'failed' : 'denied', JSON.stringify(failure.receipt));
    return failure;
  }
  throw new Error(`expected a ${code} refusal, but the dispatch succeeded`);
}

/** Real TCP probe: is anything listening on this loopback port? */
async function listenerState(port: number): Promise<'open' | 'refused'> {
  return await new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve('open'); });
    socket.on('error', () => { socket.destroy(); resolve('refused'); });
    socket.setTimeout(2_000, () => { socket.destroy(); resolve('refused'); });
  });
}

const failCode = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

// ---------------------------------------------------------------------------------------------
// The runtime-side receipt: an empty releaser set must never read as a verified release.
// ---------------------------------------------------------------------------------------------
test('a release with no registered pack is an unproved failure, and a named pack is verified', async (t) => {
  const root = mkdtempSync(`${tmpdir()}/p2o-pack-release-`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const probe = new LinuxProcessProbe();
  const own = (await probe.snapshot()).find(row => row.pid === process.pid);
  assert.ok(own, 'the test process must be visible in /proc');
  const scope = { runId: 'pack-release-run', taskId: 'pack-release-task', attemptId: 'one' };

  // (a) A durable lease and no registered releaser: nothing about a pack session can be proved.
  const bare = new SessionReleaseRegistry({ root: `${root}/bare`, probe, now: Date.now, monoNow: () => performance.now() });
  await bare.open(scope, 'bare-owner-token', own);
  const unproved = await bare.release(scope, 'bare-owner-token', 'stopped');
  assert.equal(unproved.state, 'failed', JSON.stringify(unproved));
  assert.equal(unproved.verified, false);
  assert.equal(unproved.releasers.length, 0);
  assert.match(unproved.evidenceNote!, /No session pack is registered/);
  const durable = leasesIn(`${root}/bare`);
  assert.equal(durable.length, 1);
  assert.equal(durable[0]!.state, 'open', 'an unproved release stays retryable instead of sealing the lease');

  // (b) One registered pack: the verdict names it and carries its own count.
  let calls = 0;
  const named = new SessionReleaseRegistry({
    root: `${root}/named`, probe, now: Date.now, monoNow: () => performance.now(),
    config: { releasers: [{ name: 'fixture-pack', release: async () => { calls += 1; return 2; }, outstanding: () => 0 }] },
  });
  await named.open(scope, 'named-owner-token', own);
  const verified = await named.release(scope, 'named-owner-token', 'completed');
  assert.equal(verified.state, 'released', JSON.stringify(verified));
  assert.equal(verified.verified, true);
  assert.equal(verified.releasers[0]!.name, 'fixture-pack');
  assert.equal(verified.releasers[0]!.released, 2);
  assert.equal(verified.releasers[0]!.outstanding, 0);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------------------------
// The shipped composition declares its pack set, so no attempt in it ever releases over an empty registry.
// ---------------------------------------------------------------------------------------------
test('the application registers a releaser for every pack it enables, and declares an empty pack set', async (t) => {
  const registryOf = (app: { runtimes: Record<string, unknown> }) =>
    (app.runtimes.headless as { sessions: { names(): string[]; release(scope: { runId: string; taskId: string; attemptId: string }, token: string, reason: string): Promise<{ state: string; verified: boolean; releasers: { name: string; released?: number; outstanding?: number }[] }> } }).sessions;

  const withProxy = await preparePackApp(t, { mode: 'inert-fixture', packs: { proxy: true, fuzz: {} }, packObservations: [] });
  t.after(() => withProxy.close());
  assert.deepEqual(registryOf(withProxy.app).names().sort(), ['proxy-pack'], 'the enabled capture pack is what gets released');

  const fuzzOnly = await preparePackApp(t, { mode: 'inert-fixture', packs: { fuzz: {} }, packObservations: [] });
  t.after(() => fuzzOnly.close());
  const registry = registryOf(fuzzOnly.app);
  assert.deepEqual(registry.names(), ['no-session-owning-packs'],
    'the fuzzing pack owns no session, and the composition says exactly that instead of leaving the verdict unprovable');
  // A missing lease is never treated as absence: the declared responder is consulted and must attribute
  // zero, so the verdict names the pack the composition declared instead of an empty, unaccountable list.
  const receipt = await registry.release({ runId: RUN_ID, taskId: TASK_HYP_CASE, attemptId: 'never-dispatched' }, 'token-that-never-existed', 'stopped');
  assert.equal(receipt.state, 'released', JSON.stringify(receipt));
  assert.equal(receipt.verified, true);
  assert.deepEqual(receipt.releasers.map(entry => entry.name), ['no-session-owning-packs']);
  assert.equal(receipt.releasers[0]!.released, 0);
  assert.equal(receipt.releasers[0]!.outstanding, 0);
});

// ---------------------------------------------------------------------------------------------
// Configuration: packs are opt-in, boundary-qualified and never enabled by a sandbox mode.
// ---------------------------------------------------------------------------------------------
test('pack configuration is refused unless the boundary qualifies it and the owner opts in explicitly', async (t) => {
  const base = await preparePackApp(t, { mode: 'inert-fixture', packs: { proxy: true }, packObservations: [] });
  t.after(() => base.close());
  const config = base.config;
  assert.equal(config.packs?.proxy, true);
  assert.equal(config.packs?.browser ?? false, false, 'nothing is enabled implicitly');
  const loaded = (mutate: (copy: Record<string, unknown>) => void, suffix: string) => ({ ...(variant(config, suffix, mutate) as object) }) as unknown as ApplicationConfig;
  assert.throws(() => validateApplicationConfig(loaded(copy => { copy.packs = { browser: true }; }, 'browser-fixture')), failCode('invalid-config'),
    'browser.* must be refused on the fixture boundary');
  assert.throws(() => validateApplicationConfig(loaded(copy => { copy.packs = { browser: true }; copy.sandbox = { mode: 'container', options: {} }; }, 'browser-container')), failCode('invalid-config'));
  assert.throws(() => validateApplicationConfig(loaded(copy => { copy.sandbox = { mode: 'container', options: {} }; }, 'proxy-container')), failCode('invalid-config'),
    'the capture proxy is a host loopback listener and container isolation refuses it');

  const sandbox = base.config.sandbox as { inputRoot: string; outputRoot: string };
  const hostSandbox = {
    mode: 'host-browser', acknowledgement: 'host-browser-not-container-isolated', inputRoot: sandbox.inputRoot, outputRoot: sandbox.outputRoot,
    profileRoot: '/tmp/p2o-pack-refused', approvedBy: 'owner', expiresAt: '2099-01-01T00:00:00.000Z', egress: 'loopback-only',
    identity: { launcher: '/bin/true', launcherSha256: 'a'.repeat(64), executable: '/bin/true', executableSha256: 'b'.repeat(64), version: '1', product: 'fixture' },
  };
  assert.throws(() => validateApplicationConfig(loaded(copy => { copy.sandbox = hostSandbox; }, 'host-inert')), failCode('invalid-config'),
    'an inert fixture run never launches a host browser');
  const assessment = (sandboxValue: unknown, suffix: string) => loaded(copy => {
    copy.mode = 'authorized-assessment';
    delete copy.acknowledgement;
    (copy.bridge as { inertLocalOnly: boolean }).inertLocalOnly = false;
    copy.sandbox = sandboxValue;
  }, suffix);
  assert.throws(() => validateApplicationConfig(assessment({ ...hostSandbox, acknowledgement: 'local-fixtures-only-not-hostile-code-isolation' }, 'host-ack')), failCode('invalid-config'),
    'the host boundary requires its exact not-container-isolation acknowledgement');
  assert.throws(() => validateApplicationConfig(assessment({ ...hostSandbox, identity: { ...hostSandbox.identity, executableSha256: 'not-a-digest' } }, 'host-pin')), failCode('invalid-config'),
    'a pinned Chrome identity must carry real digests');
  assert.throws(() => validateApplicationConfig(loaded(copy => { copy.packs = { fuzz: { templates: [{ id: 'not-an-approved-template' }] } }; }, 'fuzz-template')), failCode('invalid-config'),
    'fuzz templates are validated by the pack own owner-approval contract');
  // The interface preflight reports the pack set, boundary and release owners the unified control plane needs,
  // without granting anything.
  const preflight = await base.app.interfaceBackend.preflight({ manifestPath: base.manifestPath, mode: 'fixture' });
  assert.equal(preflight.ok, true, JSON.stringify(preflight));
  const packLine = preflight.warnings.find(warning => warning.startsWith('packs='));
  assert.ok(packLine, JSON.stringify(preflight.warnings));
  assert.match(packLine!, /packs=proxy\.session\/proxy\.history/);
  assert.match(packLine!, /boundary=local-fixture/);
  assert.match(packLine!, /releasers=proxy-pack/);
  assert.match(packLine!, /fence=attempt-liveness\+session-lease/);

  // A validated document with no packs carries no packs key at all: nothing is enabled by default.
  const plain = await preparePackApp(t, { mode: 'inert-fixture', packs: {}, packObservations: [] });
  t.after(() => plain.close());
  assert.equal(plain.config.packs, undefined);
  assert.equal(plain.app.packInstancesFor, undefined);
  const plainPreflight = await plain.app.interfaceBackend.preflight({ manifestPath: plain.manifestPath, mode: 'fixture' });
  assert.equal(plainPreflight.warnings.some(warning => warning.startsWith('packs=')), false, 'no packs means no pack report');
});

// ---------------------------------------------------------------------------------------------
// Inert fixture boundary: a real capture listener through the application broker, and release on stop.
// ---------------------------------------------------------------------------------------------
test('inert fixture boundary: capture session through the application broker, real listener, release on stop', { timeout: 420_000 }, async (t) => {
  const prepared = await preparePackApp(t, {
    mode: 'inert-fixture',
    packs: { proxy: true, fuzz: {} },
    packObservations: [{
      observationId: 'case-pack-proxy', tool: 'proxy.session',
      input: { action: 'start', accountId: 'guest', origins: ['$originA'] },
      summary: 'Owner-approved capture session over the approved loopback origin',
    }],
  });
  t.after(() => prepared.close());
  const app = prepared.app;
  await startRun(app);
  const attemptId = await waitForLiveCaseAttempt(prepared);
  const context = { runId: RUN_ID, taskId: TASK_HYP_CASE, attemptId, grantId: GRANT };
  const broker = app.brokerFor(attemptId);
  const packs = app.packInstancesFor!(attemptId);

  // The worker's own plan step reached the pack through bridge -> composition -> application broker.
  const observed = await waitForPackEvidence(prepared, 'case-pack-proxy');
  assert.equal(observed.kind, 'observation');
  assert.equal(observed.classification, 'independently-observed');

  // A second, direct capture session through the same application broker: the listener is real and reachable.
  const started = (await broker.execute({ context, tool: 'proxy.session', input: { action: 'start', accountId: 'guest', origins: [prepared.originA] } })).data as { proxyId: string; status: string };
  assert.equal(started.status, 'open');
  const packProxy = packs.proxy!;
  const inspected = packProxy.inspect(started.proxyId);
  assert.ok(inspected && inspected.port > 0, 'the capture listener must be inspectable while the attempt is live');
  assert.equal(await listenerState(inspected.port), 'open');
  assert.equal(packProxy.sessions, 2, 'the worker-driven and the direct session live in the same composition-owned pack');

  // An explicit stop closes the real listener and leaves an unusable tombstone.
  const stopped = (await broker.execute({ context, tool: 'proxy.session', input: { action: 'stop', proxyId: started.proxyId } })).data as { status: string; released: string };
  assert.equal(stopped.status, 'closed');
  assert.equal(stopped.released, 'yes');
  assert.equal(packProxy.inspect(started.proxyId), undefined, 'no listener survives the stop');
  assert.equal(await listenerState(inspected.port), 'refused');

  // The fuzzing pack is reachable only because the owner document opted in, and only with trusted local modules.
  assert.equal(app.sandbox.codeExecution, 'trusted-local-modules');
  const fuzzed = (await broker.execute({ context, tool: 'fuzz.differential', input: fuzzInput() })).data as { kind: string; outcome: string; divergence?: { reproducer: { hex: string } } };
  assert.equal(fuzzed.kind, 'fuzz-differential');
  assert.equal(fuzzed.outcome, 'divergence');
  assert.equal(fuzzed.divergence!.reproducer.hex, '8e', 'the seeded divergence reproduces through the application broker');

  // Cancel the run: the runtime releases the attempt's own pack session, and the verdict is durable and named.
  await app.supervisor.cancel(RUN_ID);
  const release = await terminalCaseLease(prepared);
  assert.equal(release.reason, 'cancelled', JSON.stringify(release));
  assert.equal(release.verified, true, JSON.stringify(release));
  assert.equal(release.outstanding, 0);
  const proxyResult = release.releasers.find(entry => entry.name === 'proxy-pack');
  assert.ok(proxyResult, JSON.stringify(release));
  assert.equal(proxyResult!.outcome, 'released');
  assert.equal(proxyResult!.released, 1, 'the surviving attempt-owned capture session was killed by the runtime release');
  assert.equal(proxyResult!.outstanding, 0);
  assert.equal(packProxy.sessions, 0);
  assert.equal(sessionLeases(app.config.roots.control).find(entry => entry.scope.taskId === TASK_HYP_CASE)?.state, 'released');

  // Post-release stale use is refused by the attempt-liveness fence, with a denial receipt and no new listener.
  await expectDenial(broker.execute({ context, tool: 'proxy.session', input: { action: 'start', accountId: 'guest', origins: [prepared.originA] } }), 'CAPABILITY_DENIED', /refused/i);
  assert.equal(await listenerState(inspected.port), 'refused', 'a stale call can never reopen the released listener');
  // The fence is deliberately scoped to session-owning capabilities: `browser.*`/`proxy.*` may not be dispatched
  // for a settled attempt, while the offline fuzzing pack owns no process and no session and keeps its own
  // boundary qualification (asserted in the host-browser case below).
  await expectDenial(broker.execute({ context: { ...context, attemptId: 'forged-attempt-identity' }, tool: 'proxy.session', input: { action: 'start', accountId: 'guest', origins: [prepared.originA] } }), 'IDENTITY_DENIED', /grant/i);

  // The release is idempotent: the sealed lease replays its durable verdict instead of re-killing anything.
  const registry = (app.runtimes.headless as unknown as { sessions: { release(scope: { runId: string; taskId: string; attemptId: string }, token: string, reason: string): Promise<{ duplicate: boolean; verified: boolean }> } }).sessions;
  const replayed = await registry.release({ runId: RUN_ID, taskId: TASK_HYP_CASE, attemptId }, prepared.ownerToken(attemptId), 'stopped');
  assert.equal(replayed.duplicate, true, 'a sealed lease replays its durable verdict instead of re-running the packs');
  assert.equal(replayed.verified, true);
});

// ---------------------------------------------------------------------------------------------
// Inert fixture boundary: the completion path (an accepted packet) releases the attempt's pack session.
// ---------------------------------------------------------------------------------------------
test('inert fixture boundary: the completion path releases the attempt-owned capture session', { timeout: 420_000 }, async (t) => {
  const prepared = await preparePackApp(t, {
    mode: 'inert-fixture',
    packs: { proxy: true },
    packObservations: [{
      observationId: 'case-pack-proxy', tool: 'proxy.session',
      input: { action: 'start', accountId: 'guest', origins: ['$originA'] },
      summary: 'Owner-approved capture session over the approved loopback origin',
    }],
  });
  t.after(() => prepared.close());
  const app = prepared.app;
  await startRun(app);
  const attemptId = await waitForLiveCaseAttempt(prepared);
  const context = { runId: RUN_ID, taskId: TASK_HYP_CASE, attemptId, grantId: GRANT };
  const broker = app.brokerFor(attemptId);
  const packProxy = app.packInstancesFor!(attemptId).proxy!;
  await waitForPackEvidence(prepared, 'case-pack-proxy');
  // The worker-driven session plus one direct session, so a real listener port can be observed directly.
  const started = (await broker.execute({ context, tool: 'proxy.session', input: { action: 'start', accountId: 'guest', origins: [prepared.originA] } })).data as { proxyId: string };
  const port = packProxy.inspect(started.proxyId)!.port;
  assert.equal(await listenerState(port), 'open');
  assert.equal(packProxy.sessions, 2);

  // The run finishes on its own with an accepted packet, so the release happens on the terminal path of a normal
  // completed run (not because the test stopped anything). The runtime's own word for that path is pinned by
  // `tests/runtime/sessions.test.ts` (`reason: 'completed'`); at the application level the supervisor may also
  // record its own terminal verdict for a worker that exited on its own, so this asserts the release, not the word.
  await app.supervisor.wait(RUN_ID);
  assert.equal(app.supervisor.snapshot(RUN_ID).run.state, 'completed');
  assert.ok(app.store.listResults(RUN_ID).some(result => result.taskId === TASK_HYP_CASE && result.decision.status === 'accepted'),
    'the completion release is asserted for a task whose packet the supervisor actually accepted');
  const release = await terminalCaseLease(prepared, { attemptId });
  assert.ok(['completed', 'cancelled', 'stopped', 'failed'].includes(release.reason), JSON.stringify(release));
  assert.equal(release.verified, true, JSON.stringify(release));
  assert.equal(release.outstanding, 0);
  const proxyResult = release.releasers.find(entry => entry.name === 'proxy-pack');
  assert.ok(proxyResult, JSON.stringify(release));
  assert.equal(proxyResult!.released, 2, `both attempt-owned capture sessions were killed by the release: ${JSON.stringify(release)}`);
  assert.equal(release.duplicate, false);
  assert.equal(proxyResult!.outstanding, 0);
  assert.equal(packProxy.sessions, 0);
  assert.equal(await listenerState(port), 'refused', 'the real capture listener is closed by the release');

  // A settled attempt can neither create nor drive a capture session afterwards.
  await expectDenial(broker.execute({ context, tool: 'proxy.session', input: { action: 'start', accountId: 'guest', origins: [prepared.originA] } }), 'CAPABILITY_DENIED', /refused/i);
  await expectDenial(broker.execute({ context, tool: 'proxy.history', input: { action: 'list', proxyId: started.proxyId } }), 'CAPABILITY_DENIED', /refused/i);
  assert.equal(await listenerState(port), 'refused');
});

// ---------------------------------------------------------------------------------------------
// Host-browser boundary: a real Chrome session through the application broker, released on completion.
// ---------------------------------------------------------------------------------------------
test('host-browser boundary: real Chrome session released on completion, with stale use refused', { timeout: 480_000 }, async (t) => {
  if (!await chromePin()) {
    t.skip('host Chrome is required for the host-browser pack tests');
    return;
  }
  const prepared = await preparePackApp(t, { mode: 'host-browser', packs: { browser: true, proxy: true, fuzz: {} }, packObservations: [], workerDelayMs: 45_000 });
  t.after(() => prepared.close());
  const app = prepared.app;
  const names = (app.runtimes.headless as unknown as { sessions: { names(): string[] } }).sessions.names();
  assert.deepEqual(names.sort(), ['browser-pack', 'proxy-pack'], 'both enabled session-owning packs are released by the runtime');
  await startRun(app);
  const attemptId = await waitForLiveCaseAttempt(prepared);
  const context = { runId: RUN_ID, taskId: TASK_HYP_CASE, attemptId, grantId: GRANT };
  const broker = app.brokerFor(attemptId);
  const packs = app.packInstancesFor!(attemptId);

  // A real headless Chrome on the acknowledged host boundary, dispatched by the application's own broker.
  const opened = (await broker.execute({ context, tool: 'browser.session', input: { action: 'open', url: `${prepared.originA}/healthz`, accountId: 'guest' } })).data as { browserId: string; status: string; chrome: { version: string }; isolation: string };
  assert.equal(opened.status, 'open');
  assert.ok(opened.chrome.version.length > 0, 'the session is attested with the pinned Chrome version');
  assert.match(opened.isolation, /^host-browser:not-container-isolated:/);

  // The live session renders through the same broker, and the capture pack of the same attempt records the egress.
  const snapshot = (await broker.execute({ context, tool: 'browser.act', input: { browserId: opened.browserId, action: 'snapshot' } })).data as { kind: string; snapshot?: { text: string } };
  assert.equal(snapshot.kind, 'browser-action');
  assert.ok(snapshot.snapshot, 'a snapshot of the live page is returned');
  assert.equal(packs.browser!.sessions, 1, 'exactly the broker-created session is live in the composition-owned pack');
  assert.equal(packs.proxy!.sessions >= 1, true, 'the browser egress of the attempt is recorded by the attempt capture pack');

  // The pinned worker settles on its own and the runtime terminates the attempt: whichever verdict the supervisor
  // reaches without a model-produced packet ('completed' is only reachable with an accepted packet, which the
  // inert run above covers), the terminal path must release the session through the registered releaser.
  const release = await terminalCaseLease(prepared, { attemptId, timeoutMs: 180_000 });
  assert.ok(['completed', 'failed', 'cancelled', 'stopped', 'timed-out'].includes(release.reason), JSON.stringify(release));
  assert.equal(release.verified, true, JSON.stringify(release));
  assert.equal(release.outstanding, 0);
  const browserResult = release.releasers.find(entry => entry.name === 'browser-pack');
  assert.ok(browserResult, JSON.stringify(release));
  assert.equal(browserResult!.outcome, 'released');
  assert.equal(browserResult!.outstanding, 0);
  const proxyResult = release.releasers.find(entry => entry.name === 'proxy-pack');
  assert.ok(proxyResult, JSON.stringify(release));
  assert.equal(proxyResult!.outstanding, 0);
  // The browser session and its implicit capture session are two views of the same live resource: whichever
  // registered releaser tears it down reports the kill, and both must report no survivor.
  assert.ok((browserResult!.released ?? 0) + (proxyResult!.released ?? 0) >= 1,
    `the terminal path killed the live Chrome session through a registered releaser: ${JSON.stringify(release)}`);
  assert.equal(packs.browser!.sessions, 0);
  assert.equal(packs.proxy!.sessions, 0);
  // The real process and its private profile are gone.
  assert.deepEqual(readdirSync(packRoots(prepared).profile), [], 'every session profile is removed by the verified release');
  assert.equal(release.evidenceNote ?? '', '');

  // Post-release stale use is refused with a denial receipt, and no session can be resurrected.
  await expectDenial(broker.execute({ context, tool: 'browser.session', input: { action: 'open', url: `${prepared.originA}/healthz`, accountId: 'guest' } }), 'CAPABILITY_DENIED', /refused/i);
  await expectDenial(broker.execute({ context, tool: 'browser.act', input: { browserId: opened.browserId, action: 'snapshot' } }), 'CAPABILITY_DENIED', /refused/i);
  assert.equal(packs.browser!.sessions, 0);

  // The fuzzing pack was opted in, but this boundary does not qualify trusted local modules: it stays refused.
  await expectDenial(broker.execute({ context, tool: 'fuzz.differential', input: fuzzInput() }), 'UNAVAILABLE', /not qualified in this sandbox/i);
  // Stop whatever the supervisor still owns, so the test never leaves an owned process behind.
  await app.supervisor.cancel(RUN_ID);
});

// ---------------------------------------------------------------------------------------------
// Opt-in: without `packs` the pack capabilities are not provisioned at all.
// ---------------------------------------------------------------------------------------------
test('without an opt-in no pack capability is provisioned and no pack can create a session', { timeout: 420_000 }, async (t) => {
  // The owner grants the pack capabilities here, so the refusal has to come from the registry (not from the grant).
  const prepared = await preparePackApp(t, { mode: 'inert-fixture', packs: {}, packObservations: [], grantCapabilities: ['proxy.session', 'proxy.history', 'fuzz.differential', 'fuzz.template'] });
  t.after(() => prepared.close());
  const app = prepared.app;
  await startRun(app);
  const attemptId = await waitForLiveCaseAttempt(prepared);
  const context = { runId: RUN_ID, taskId: TASK_HYP_CASE, attemptId, grantId: GRANT };
  // Even an owner-approved grant cannot make a pack session appear: the capture family is granted by the owner
  // document, but this composition owns no capture pack and no releaser for one, so the fence refuses it. (The
  // capture pack would otherwise be provisioned by the default registry and own a session nobody could release.)
  await expectDenial(app.brokerFor(attemptId).execute({ context, tool: 'proxy.session', input: { action: 'start', accountId: 'guest', origins: [prepared.originA] } }), 'CAPABILITY_DENIED', /enables no capture pack/i);
  await expectDenial(app.brokerFor(attemptId).execute({ context, tool: 'fuzz.differential', input: fuzzInput() }), 'CAPABILITY_DENIED', /not provisioned/i);
  assert.equal(app.packInstancesFor, undefined);
  await app.supervisor.cancel(RUN_ID);
  const release = await terminalCaseLease(prepared);
  assert.equal(release.verified, true, JSON.stringify(release));
  assert.deepEqual(release.releasers.map(entry => entry.name), ['no-session-owning-packs']);
});

// ---------------------------------------------------------------------------------------------
// Closing the application closes the pack instances it owns (graceful controller exit).
// ---------------------------------------------------------------------------------------------
test('closing the application closes the pack instances it owns', { timeout: 300_000 }, async (t) => {
  const prepared = await preparePackApp(t, { mode: 'inert-fixture', packs: { proxy: true }, packObservations: [] });
  t.after(() => prepared.close());
  const app = prepared.app;
  await startRun(app);
  const attemptId = await waitForLiveCaseAttempt(prepared);
  const context = { runId: RUN_ID, taskId: TASK_HYP_CASE, attemptId, grantId: GRANT };
  const packProxy = app.packInstancesFor!(attemptId).proxy!;
  const started = (await app.brokerFor(attemptId).execute({ context, tool: 'proxy.session', input: { action: 'start', accountId: 'guest', origins: [prepared.originA] } })).data as { proxyId: string };
  const port = packProxy.inspect(started.proxyId)!.port;
  assert.equal(await listenerState(port), 'open');

  // The runtime's graceful shutdown asks every registered releaser to shut down, so the packs this composition
  // owns are closed even on a controller exit that never stops the attempt first.
  await app.close();
  assert.equal(packProxy.sessions, 0);
  assert.equal(packProxy.inspect(started.proxyId), undefined);
  assert.equal(await listenerState(port), 'refused');
  // A repeated shutdown replays the cached success over the SAME instances; it never re-creates or replaces
  // them, and it never reports a fresh close it did not perform.
  assert.equal(app.packInstancesFor!(attemptId).proxy, packProxy, 'shutdown must retain the exact dispatched instance');
  await (app.runtimes.headless as { shutdown?: () => Promise<void> }).shutdown?.();
  assert.equal(packProxy.sessions, 0);
  assert.equal(await listenerState(port), 'refused');
});

// ---------------------------------------------------------------------------------------------
// Pack-instance shutdown is retryable: one failed pack never skips the remaining families, the retry closes
// the SAME instances again, and a failed pass is never cached as a successful shutdown.
// ---------------------------------------------------------------------------------------------
test('pack-instance shutdown retries the exact same instances and never caches a failed pass as success', async () => {
  const closes: string[] = [];
  const fake = (name: string, remainingFailures: number) => ({ async close(): Promise<void> { closes.push(name); if (remainingFailures > 0) { remainingFailures -= 1; throw new Error(`${name} controlled close failure`); } } });
  const entries = new Map<string, PackInstanceSet>([['attempt-one', { browser: fake('browser', 1), proxy: fake('proxy', 0) }]]);
  const closePacks = createPackInstanceCloser(() => entries);
  await assert.rejects(closePacks(), /Pack instance shutdown unverified: browser-pack attempt-one: browser controlled close failure/);
  assert.deepEqual(closes, ['browser', 'proxy'], 'a failed pack must not skip the remaining owned families');
  const browser = entries.get('attempt-one')!.browser;
  await closePacks();
  assert.deepEqual(closes, ['browser', 'proxy', 'browser', 'proxy'], 'the retry must close the exact same instances again, never reconstructed ones');
  assert.equal(entries.get('attempt-one')!.browser, browser, 'the retry retains the exact instance the composition owns');
  await closePacks();
  assert.deepEqual(closes, ['browser', 'proxy', 'browser', 'proxy'], 'success is idempotent: no further close calls');
});

// ---------------------------------------------------------------------------------------------
// Crash recovery: a restart sweep never claims a session this controller cannot prove released.
// ---------------------------------------------------------------------------------------------
test('the restart sweep recovers only what this controller can prove, and never claims the rest', { timeout: 300_000 }, async (t) => {
  const registryOf = (app: { runtimes: Record<string, unknown> }) =>
    (app.runtimes.headless as { sessions: {
      open(scope: { runId: string; taskId: string; attemptId: string }, token: string, owner: unknown): Promise<void>;
      binding(scope: { runId: string; taskId: string; attemptId: string }, token: string, pack: string): { enroll(scope: unknown, id: string, data: Record<string, unknown>): Promise<void>; resolve(scope: unknown, id: string): Promise<void> };
      sweepStale(owner: unknown): Promise<{ verified: boolean; swept: number; entries: { scope: { taskId: string }; state: string; released?: number; error?: string }[] }>;
    } }).sessions;

  // A composition that owns the capture pack. Enrollment precedes listener allocation, so an empty durable
  // family is proved absence while a recorded controller identity that is NOT the dead lease owner is refused.
  const prepared = await preparePackApp(t, { mode: 'inert-fixture', packs: { proxy: true }, packObservations: [] });
  t.after(() => prepared.close());
  const registry = registryOf(prepared.app);
  const emptyScope = { runId: RUN_ID, taskId: 'stale-pack-task', attemptId: 'stale-pack-attempt' };
  await registry.open(emptyScope, 'stale-owner-token', await deadIdentity());

  // A listener recorded under a LIVE controller is not absence this controller may claim.
  const liveController = await ownIdentity();
  const hostileId = `px-${'a'.repeat(24)}`;
  const hostileScope = { runId: RUN_ID, taskId: 'stale-hostile-task', attemptId: 'stale-hostile-attempt' };
  await registry.open(hostileScope, 'stale-hostile-token', await deadIdentity());
  await registry.binding(hostileScope, 'stale-hostile-token', 'proxy-pack').enroll(hostileScope, hostileId, {
    version: 1, kind: 'controller-listener', sessionId: hostileId, scope: hostileScope, controller: liveController, ports: [1],
  });

  // A listener recorded under the EXACT dead lease owner is real, identity-checked absence and is recovered.
  const recoverOwner = await deadIdentity();
  const recoverId = `px-${'b'.repeat(24)}`;
  const recoverScope = { runId: RUN_ID, taskId: 'stale-recover-task', attemptId: 'stale-recover-attempt' };
  await registry.open(recoverScope, 'stale-recover-token', recoverOwner);
  await registry.binding(recoverScope, 'stale-recover-token', 'proxy-pack').enroll(recoverScope, recoverId, {
    version: 1, kind: 'controller-listener', sessionId: recoverId, scope: recoverScope, controller: recoverOwner, ports: [1],
  });

  const sweep = await registry.sweepStale(await ownIdentity());
  const entryOf = (taskId: string) => {
    const entry = sweep.entries.find(candidate => candidate.scope.taskId === taskId);
    assert.ok(entry, JSON.stringify(sweep.entries));
    return entry;
  };
  // Empty durable family: no enrollment ever happened, so this family created nothing.
  assert.equal(entryOf('stale-pack-task').state, 'swept', JSON.stringify(sweep.entries));
  assert.equal(entryOf('stale-pack-task').released, 0);
  // Enrolled but unprovable: the recorded controller is live/foreign, so the sweep refuses and leaves the
  // lease open for the controller that actually owns the session (or a later sweep with the same process).
  assert.equal(entryOf('stale-hostile-task').state, 'unverifiable', JSON.stringify(sweep.entries));
  assert.match(entryOf('stale-hostile-task').error!, /identity is unverified/i);
  assert.equal(sessionLeases(prepared.config.roots.control).find(lease => lease.scope.attemptId === 'stale-hostile-attempt')?.state, 'open');
  // Enrolled under the exact dead controller: identity-checked recovery resolves the durable resource.
  assert.equal(entryOf('stale-recover-task').state, 'swept', JSON.stringify(sweep.entries));
  assert.equal(entryOf('stale-recover-task').released, 1);
  assert.equal(sweep.swept, 2);
  assert.equal(sweep.verified, false, 'one unprovable family must keep the whole sweep unverified');
  // The hostile enrollment is test-only evidence. Resolve it after the negative assertion so the fixture
  // teardown can prove a clean shutdown instead of deliberately retaining durable state.
  await registry.binding(hostileScope, 'stale-hostile-token', 'proxy-pack').resolve(hostileScope, hostileId);

  // A composition that enables no session-owning pack declares exactly that, so its own empty stale leases
  // cannot strand restart admission: the declaration answers zero with nothing to recover.
  const fuzzOnly = await preparePackApp(t, { mode: 'inert-fixture', packs: { fuzz: {} }, packObservations: [] });
  t.after(() => fuzzOnly.close());
  const bare = registryOf(fuzzOnly.app);
  const bareScope = { runId: RUN_ID, taskId: 'stale-bare-task', attemptId: 'stale-bare-attempt' };
  await bare.open(bareScope, 'bare-owner-token', await deadIdentity());
  const bareSweep = await bare.sweepStale(await ownIdentity());
  const bareEntry = bareSweep.entries.find(candidate => candidate.scope.taskId === 'stale-bare-task');
  assert.ok(bareEntry, JSON.stringify(bareSweep.entries));
  assert.equal(bareEntry.state, 'swept', JSON.stringify(bareSweep.entries));
  assert.equal(bareEntry.released, 0);
  assert.equal(bareSweep.verified, true);
});

// ---------------------------------------------------------------------------------------------
// Plan seams: optional, typed against `planner.ts` and fail-closed when they cannot be honored.
// ---------------------------------------------------------------------------------------------
test('the plan-port and generated-plan seams are optional, typed and fail-closed', async (t) => {
  const prepared = await preparePackApp(t, { mode: 'inert-fixture', packs: {}, packObservations: [] });
  t.after(() => prepared.close());
  const overrides: ApplicationOverrides = { planPortOptions: { caps: { maxTasks: 1 } } };
  const withoutPlanner = validateApplicationConfig(variant(prepared.config, 'plan-seam', () => {}));
  await assert.rejects(createApplication(withoutPlanner, overrides), failCode('INTEGRATION_REQUIRED'),
    'a plan-port seam the composition could never consume is refused instead of silently ignored');

  // The generated-plan seam hosts exactly the caller-owned planner ledger and the planner-owned materializer.
  const ledger = { read: () => ({ runId: RUN_ID, proposals: [], approvals: [], rejections: [] }) } as unknown as RequestPlanLedger;
  const withSeam = await createApplication(validateApplicationConfig(variant(prepared.config, 'plan-request', () => {})), { requestPlan: { ledger } });
  try {
    assert.equal(withSeam.requestPlan?.ledger, ledger, 'the exact caller-owned ledger is hosted, not a copy');
    assert.equal(withSeam.requestPlan?.materialize, materializeRequestPlan, 'the planner-owned gate materializes a generated plan');
    assert.equal(prepared.app.requestPlan, undefined, 'the seam is absent by default');
  } finally {
    await withSeam.close();
  }

  // A composition-owned plan-port collaborator can never be replaced through the seam. The seam is only
  // validated with a configured planner, so this asserts the runtime guard rather than a type error.
  const withPlanner = validateApplicationConfig(variant(prepared.config, 'plan-owned', copy => {
    copy.planner = {
      toolPolicy: (prepared.config.tasks[0]!.toolPolicy), boundaryReceipt: 'integration-packs plan seam',
    };
  }));
  await assert.rejects(createApplication(withPlanner, { planPortOptions: { ledger: undefined } as unknown as ApplicationOverrides['planPortOptions'] }),
    failCode('invalid-config'), 'a composition-owned plan-port key is refused');
});
