import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionReleaseRegistry } from '../../src/runtime/sessions.js';
import { attemptKey } from '../../src/runtime/filesystem-hooks.js';
import { currentProcessIdentity } from '../../src/tools/browser-lifecycle.js';
import { LinuxProcessProbe } from '../../src/runtime/processes.js';
import type { SessionReleaser, SessionScope } from '../../src/runtime/types.js';

const scope: SessionScope = { runId: 'registry-run', taskId: 'task', attemptId: 'one' };
const token = 'registry-private-token';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function registry(t: test.TestContext, releasers: SessionReleaser[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'p2o-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new SessionReleaseRegistry({ root, now: Date.now, monoNow: () => performance.now(), probe: new LinuxProcessProbe(), config: { timeoutMs: 100, totalTimeoutMs: 300, releasers } });
  await sessions.open(scope, token, currentProcessIdentity());
  return { root, sessions };
}

test('concurrent teardown is one call and replays exact durable reason; same object registration is idempotent', async t => {
  let calls = 0;
  const releaser = { name: 'pack', async release() { calls++; await sleep(10); return 1; }, outstanding: () => 0 };
  const { sessions } = await registry(t, [releaser]);
  sessions.register(releaser);
  assert.throws(() => sessions.register({ ...releaser }), /already registered/);
  const [a, b, c] = await Promise.all(['completed', 'stopped', 'cancelled'].map(reason => sessions.release(scope, token, reason as 'completed')));
  assert.equal(calls, 1);
  assert.equal(a.verified, true); assert.equal(b.duplicate, true); assert.equal(c.duplicate, true);
  assert.equal(b.reason, 'completed'); assert.equal(c.reason, 'completed');
  await assert.rejects(sessions.assertOpen(scope, token), /sealed/);
});

test('no attributable outstanding proof, invalid counts and empty responders cannot verify real enrollment', async t => {
  for (const releaser of [
    { name: 'pack', release: async () => 0 },
    { name: 'pack', release: async () => -1, outstanding: () => 0 },
    { name: 'pack', release: async () => 0, outstanding: () => Number.NaN },
    { name: 'pack', release: async () => 0, outstanding: () => 0 },
  ]) {
    const { sessions } = await registry(t, [releaser]);
    await sessions.binding(scope, token, 'pack').enroll(scope, 'real-session', { identity: 'owned-resource' });
    const receipt = await sessions.release(scope, token, 'stopped');
    assert.equal(receipt.verified, false, JSON.stringify(receipt));
    assert.equal(receipt.state, 'failed');
    await assert.rejects(sessions.assertOpen(scope, token), /sealed/);
    assert.equal((await sessions.inventory(scope, 'pack')).length, 1);
  }
});

test('failed release seals use/create permanently but cleanup can retry after proof; no lost enrollment', async t => {
  const { sessions } = await registry(t, [{ name: 'pack', release: async () => 0, outstanding: () => 0 }]);
  const lifecycle = sessions.binding(scope, token, 'pack');
  await lifecycle.enroll(scope, 'owned', { stage: 'starting' });
  const failed = await sessions.release(scope, token, 'completed');
  assert.equal(failed.verified, false);
  await assert.rejects(sessions.open(scope, token, currentProcessIdentity()), /sealed/);
  await assert.rejects(lifecycle.enroll(scope, 'resurrected'), /sealed/);
  await lifecycle.update(scope, 'owned', { stage: 'identity-known' });
  await lifecycle.resolve(scope, 'owned');
  assert.equal((await sessions.release(scope, token, 'completed')).verified, true);
  await assert.rejects(lifecycle.check(scope), /sealed/);
});

test('a missing lease is not proof that a live pack owns nothing', async t => {
  const { sessions } = await registry(t, [{ name: 'pack', release: async () => 0, outstanding: () => 1 }]);
  const receipt = await sessions.release({ ...scope, attemptId: 'never-leased' }, token, 'stopped');
  assert.equal(receipt.verified, false); assert.equal(receipt.state, 'orphaned');
});

test('release and its outstanding proof share ONE bound, hung async proof is not awaited forever', async t => {
  const { sessions } = await registry(t, [{ name: 'pack', release: async () => { await sleep(70); return 1; }, outstanding: () => new Promise<number>(() => {}) }]);
  const start = performance.now(), receipt = await sessions.release(scope, token, 'stopped');
  assert.equal(receipt.verified, false);
  assert.match(receipt.releasers[0]!.error!, /deadline exhausted/);
  assert.ok(performance.now() - start < 250, 'outstanding must not renew the per-pack bound');
});

test('one crash sweeper cannot vouch for a different pack with only an in-memory empty release', async t => {
  const { root } = await registry(t);
  const sessions = new SessionReleaseRegistry({ root: path.join(root, 'dead'), now: Date.now, monoNow: () => performance.now(), probe: new LinuxProcessProbe(),
    config: { timeoutMs: 100, totalTimeoutMs: 300, releasers: [
      { name: 'real-sweeper', release: async () => 0, sweep: async () => 0, outstanding: () => 0 },
      { name: 'empty-fresh-pack', release: async () => 0, outstanding: () => 0 },
    ] } });
  const own = currentProcessIdentity();
  await sessions.open(scope, token, { ...own, startTicks: '0' });
  const sweep = await sessions.sweepStale(own);
  assert.equal(sweep.verified, false); assert.equal(sweep.unverifiable, 1);
  assert.match(sweep.entries[0]!.error!, /empty-fresh-pack.*crash-recovery/);
});

test('a new controller never gets permission to act on a dead or live old lease', async t => {
  const { root, sessions } = await registry(t, [{ name: 'pack', release: async () => 0, outstanding: () => 0 }]);
  const fresh = new SessionReleaseRegistry({ root, probe: new LinuxProcessProbe(), now: Date.now, monoNow: () => performance.now() });
  await assert.rejects(fresh.assertOpen(scope, token), /another controller/);
  const foreign = await fresh.release(scope, token, 'crash-recovery');
  assert.equal(foreign.verified, false); assert.match(foreign.evidenceNote!, /live controller/);
  await sessions.assertOpen(scope, token);
  await assert.rejects(fresh.open(scope, token, currentProcessIdentity()), /another attempt owner/);
});

test('registration preserves prototype callbacks/receiver; zero-pack release stays unverified', async t => {
  class Releaser { name = 'class-pack'; calls = 0; async release() { this.calls++; return 0; } outstanding() { return 0; } }
  const pack = new Releaser(), { sessions } = await registry(t, [pack]);
  assert.equal((await sessions.release(scope, token, 'stopped')).verified, true); assert.equal(pack.calls, 1);
  const bare = await registry(t);
  assert.equal((await bare.sessions.release(scope, token, 'stopped')).verified, false);
});

test('a legacy clean verdict without durable inventory cannot be replayed as verified by empty responders', async t => {
  const { root, sessions } = await registry(t, [{ name: 'pack', release: async () => 0, outstanding: () => 0 }]);
  assert.equal((await sessions.release(scope, token, 'completed')).verified, true);
  const file = path.join(root, `lease-${attemptKey(scope)}.json`);
  const legacy = JSON.parse(await readFile(file, 'utf8')); delete legacy.resources;
  await writeFile(file, JSON.stringify(legacy));
  const denied = await sessions.release(scope, token, 'stopped'); assert.equal(denied.verified, false);
  assert.match(denied.evidenceNote!, /Legacy.*inventory/); assert.equal(sessions.recorded(scope)?.verified, false);
  assert.equal((await sessions.read(scope))!.release?.verified, false);
  const swept = await sessions.sweepStale(currentProcessIdentity()); assert.equal(swept.verified, false); assert.equal(swept.unverifiable, 1);
});

test('concurrent failed teardown is coalesced too; only a later explicit retry calls the pack again', async t => {
  let calls = 0;
  const { sessions } = await registry(t, [{ name: 'hung-pack', release: async () => { calls++; return await new Promise<number>(() => {}); }, outstanding: () => 0 }]);
  const receipts = await Promise.all(Array.from({ length: 4 }, () => sessions.release(scope, token, 'stopped')));
  assert.equal(calls, 1, 'failure does not turn simultaneous callers into repeated teardown operations');
  for (const receipt of receipts) assert.equal(receipt.verified, false);
  await sessions.release(scope, token, 'stopped'); assert.equal(calls, 2, 'an explicit later cleanup retry remains possible');
});

test('unresponsive process inventory bounds recovery and never signals on guessed owner liveness', async t => {
  const { root, sessions } = await registry(t, [{ name: 'pack', release: async () => 0, outstanding: () => 0 }]);
  let calls = 0;
  const hung = new SessionReleaseRegistry({ root, now: Date.now, monoNow: () => performance.now(),
    probe: { snapshot: () => new Promise(() => {}), signal: () => assert.fail('must never signal without identity proof') },
    config: { timeoutMs: 50, totalTimeoutMs: 150, releasers: [{ name: 'pack', release: async () => { calls++; return 0; }, outstanding: () => 0 }] } });
  const denied = await hung.release(scope, token, 'crash-recovery'); assert.equal(denied.verified, false);
  const swept = await hung.sweepStale(currentProcessIdentity()); assert.equal(swept.verified, false); assert.equal(swept.unverifiable, 1);
  assert.equal(calls, 0); await sessions.assertOpen(scope, token);
});

test('a pack shutdown hook that returns without resolving durable enrollment cannot report a clean shutdown', async t => {
  const hooks: number[] = [];
  const { sessions } = await registry(t, [{ name: 'pack', release: async () => 0, outstanding: () => 1, shutdown: async () => { hooks.push(1); } }]);
  await sessions.binding(scope, token, 'pack').enroll(scope, 'enrolled-real', { stage: 'created' });
  await assert.rejects(sessions.shutdown(), /enrolled-real remains enrolled after pack shutdown/);
  // Cleanup retries stay possible: only real absence may publish the clean verdict.
  await sessions.binding(scope, token, 'pack').resolve(scope, 'enrolled-real');
  await sessions.shutdown();
  assert.deepEqual(hooks, [1, 1], 'the retry must run the shutdown hook again, not replay a cached failure');
});
