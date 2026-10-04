import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireApprovedSource, bindApprovedSourceContainer } from '../../src/application/source-binding/index.js';
import { createContainerSandbox, recoverContainerResources, containerSessionLabels, type SourceContainerSandbox } from '../../src/tools/container.js';
import { runFixedProcess } from '../../src/tools/process.js';
import { SessionReleaseRegistry } from '../../src/runtime/sessions.js';
import { registerPackSessionFamily } from '../../src/runtime/pack-lifecycle.js';
import { processIdentity, LinuxProcessProbe } from '../../src/runtime/processes.js';
import type { SessionScope } from '../../src/runtime/types.js';
import type { PackSessionLifecycle } from '../../src/tools/pack-session.js';
import { approvedRequest, dockerAvailable, qualifiedSettings, roots } from './fixtures.js';
const missing = await dockerAvailable();
if (missing && process.env.P2O_SOURCE_REQUIRE_DOCKER === '1') throw new Error(missing);
if (missing) console.warn(`SKIP REAL Docker lifecycle: ${missing}`);
const real = missing ? describe.skip : describe;
const docker = (args: string[]) => runFixedProcess('/usr/bin/docker', args, { timeoutMs: 3000, maxOutputBytes: 1048576 });
const isGone = (r: Awaited<ReturnType<typeof docker>>) => r.code === 1 && /No such (?:object|container):/.test(r.stderr);
real('REAL pinned Docker + REAL durable lifecycle registry; no source/model execution', () => {
  it('enrolls before create, persists exact ID/labels before start, resolves after absence, fences old attempts', async () => {
    const r = await roots(); let sandbox: SourceContainerSandbox | undefined;
    try {
      await writeFile(join(r.original, 'canary.ts'), 'export const lifecycleCanary = true;\n');
      const approved = await approvedRequest({ root: r.root, origin: r.original }), source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot }), q = await qualifiedSettings();
      const probe = new LinuxProcessProbe(), self = processIdentity((await probe.snapshot()).find(p => p.pid === process.pid)!);
      const registry = new SessionReleaseRegistry({ root: join(r.root, 'sessions'), probe, now: Date.now, monoNow: () => performance.now() });
      const attempt: SessionScope = { runId: source.identity.runId, taskId: 'source-task', attemptId: 'source-attempt' }, control: SessionScope = { runId: source.identity.runId, taskId: 'controller-probe', attemptId: 'controller-probe-owner' };
      registerPackSessionFamily(registry, { name: 'container', lookup: () => sandbox, recover: (resources, scope, owner) => recoverContainerResources(resources, scope, owner, q), shutdown: async () => { if (!sandbox) throw new Error('no exact container owner'); await sandbox.close(); } });
      await registry.open(attempt, 'attempt-owner-token', self); await registry.open(control, 'controller-owner-token', self);
      const observed: Record<string, unknown>[] = [];
      const wrap = (scope: SessionScope, token: string): PackSessionLifecycle => {
        const base = registry.binding(scope, token, 'container');
        return { check: c => base.check(c), async enroll(c, id, data) { await base.enroll(c, id, data); expect(isGone(await docker(['inspect', id]))).toBe(true); expect((await registry.inventory(c, 'container')).some(r => r.id === id)).toBe(true); }, async update(c, id, data) { await base.update(c, id, data); if (data.stage === 'created') { const actual = JSON.parse((await docker(['inspect', '--format', '{{json .}}', String(data.containerId)])).stdout); expect(actual.Config.Labels).toMatchObject(data.labels as Record<string, string>); expect(actual.State.Status).toBe('created'); expect(actual.Id).toBe(data.containerId); expect(actual.Image).toBe(q.image); observed.push(structuredClone(data)); } }, async resolve(c, id) { const row = (await registry.inventory(c, 'container')).find(r => r.id === id)!; expect(isGone(await docker(['inspect', String(row.data.containerId)]))).toBe(true); expect(isGone(await docker(['inspect', id]))).toBe(true); await base.resolve(c, id); } };
      };
      q.lifecycle = { scope: attempt, lifecycle: wrap(attempt, 'attempt-owner-token') }; q.controllerLifecycle = { scope: control, lifecycle: wrap(control, 'controller-owner-token') };
      const binding = await bindApprovedSourceContainer({ ...approved, source, qualified: q }); sandbox = binding.sandbox;
      expect(binding.preflight.checks.some(c => c.name === 'container-lifecycle' && c.ok)).toBe(true);
      expect(observed).toHaveLength(1); expect(observed[0]!.scope).toEqual(control);
      const controllerOnly = createContainerSandbox({ ...q, lifecycle: undefined, inputRoot: binding.inputRoot, outputRoot: binding.outputRoot, trustedInputSnapshot: true, approvedSource: { identityDigest: source.identityDigest, snapshot: source.seal } });
      expect(controllerOnly.configurationDigest).toBe(sandbox.configurationDigest); await controllerOnly.close();
      expect((await sandbox.verifyMountedSource('canary.ts')).inputTreeDigest).toBe(source.identity.digest);
      expect(observed[1]!.scope).toEqual(attempt); expect(await registry.inventory(attempt, 'container')).toEqual([]); expect(await registry.inventory(control, 'container')).toEqual([]);
      expect(() => sandbox!.outstanding({ ...attempt, attemptId: 'foreign-attempt' })).toThrow(/owner/);
      const released = await registry.release(attempt, 'attempt-owner-token', 'completed'); expect(released.verified).toBe(true); expect(sandbox.outstanding(attempt)).toBe(0);
      await expect(sandbox.verifyMountedSource('canary.ts')).rejects.toThrow(/sealed/); expect(observed).toHaveLength(2);
      expect((await registry.release(control, 'controller-owner-token', 'completed')).verified).toBe(true);
      await registry.shutdown();
    } finally { await sandbox?.close(); await r.cleanup(); }
  });
  it('does not resolve a failed durable absence acknowledgment or publish 0/0; retries cleanup without reopening', async () => {
    const r = await roots(); let sandbox: SourceContainerSandbox | undefined, refuse = true;
    try {
      await writeFile(join(r.original, 'canary.ts'), 'approved'); const approved = await approvedRequest({ root: r.root, origin: r.original }), source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot }), q = await qualifiedSettings();
      const probe = new LinuxProcessProbe(), self = processIdentity((await probe.snapshot()).find(p => p.pid === process.pid)!), registry = new SessionReleaseRegistry({ root: join(r.root, 'sessions'), probe, now: Date.now, monoNow: () => performance.now() });
      const scope = { runId: source.identity.runId, taskId: 'source-task', attemptId: 'source-attempt' }, control = { ...scope, taskId: 'control', attemptId: 'controller-owner' };
      registerPackSessionFamily(registry, { name: 'container', lookup: () => sandbox, recover: (resources, scope, owner) => recoverContainerResources(resources, scope, owner, q), shutdown: async () => { if (!sandbox) throw new Error('no exact owner'); await sandbox.close(); } });
      await registry.open(scope, 'owner-token', self); await registry.open(control, 'controller-token', self);
      const base = registry.binding(scope, 'owner-token', 'container'); q.lifecycle = { scope, lifecycle: { check: c => base.check(c), enroll: (c, id, d) => base.enroll(c, id, d), update: (c, id, d) => base.update(c, id, d), async resolve(c, id) { if (refuse) throw new Error('CONTROLLED_ACK_FAILURE_AFTER_REAL_DOCKER_ABSENCE'); await base.resolve(c, id); } } }; q.controllerLifecycle = { scope: control, lifecycle: registry.binding(control, 'controller-token', 'container') };
      sandbox = (await bindApprovedSourceContainer({ ...approved, source, qualified: q })).sandbox;
      await expect(sandbox.verifyMountedSource('canary.ts')).rejects.toThrow(/ACK_FAILURE/);
      expect(sandbox.outstanding(scope)).toBe(1); expect(await registry.inventory(scope, 'container')).toHaveLength(1);
      expect((await registry.release(scope, 'owner-token', 'failed')).verified).toBe(false); expect(sandbox.outstanding(scope)).toBe(1);
      refuse = false; expect((await registry.release(scope, 'owner-token', 'failed')).verified).toBe(true); expect(sandbox.outstanding(scope)).toBe(0);
      expect((await registry.read(scope))!.fencedAt).toBeTypeOf('number'); await expect(registry.binding(scope, 'owner-token', 'container').check(scope)).rejects.toThrow(/sealed/);
    } finally { refuse = false; await sandbox?.close(); await r.cleanup(); }
  });
  it('REAL stopped-container + inert kernel owner: fresh registry recovers exact daemon/ID/labels, refuses live/foreign/uncertain identities', async () => {
    const r = await roots(), child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    let cid: string | undefined, record: Awaited<ReturnType<SessionReleaseRegistry['inventory']>>[number] | undefined, owner: Awaited<ReturnType<SessionReleaseRegistry['read']>>;
    const q = await qualifiedSettings(), probe = new LinuxProcessProbe();
    try {
      await writeFile(join(r.original, 'canary.ts'), 'approved'); const approved = await approvedRequest({ root: r.root, origin: r.original }), source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot });
      const binding = await bindApprovedSourceContainer({ ...approved, source, qualified: q }); // Existing real pin/constraints qualification FIRST.
      const identity = processIdentity((await probe.snapshot()).find(p => p.pid === child.pid)!); expect(identity).toBeDefined();
      const scope = { runId: source.identity.runId, taskId: 'recovery-fixture', attemptId: 'stopped-container-owner' }, root = join(r.root, 'sessions');
      const registry = new SessionReleaseRegistry({ root, probe, now: Date.now, monoNow: () => performance.now() });
      registry.register({ name: 'container', async release() { throw new Error('fixture intentionally leaves a CREATED, never-executed container'); }, outstanding: () => 1 });
      await registry.open(scope, 'fixture-owner-token', identity); const life = registry.binding(scope, 'fixture-owner-token', 'container');
      const id = `p2o-${randomUUID()}`, labels = containerSessionLabels(scope, id, binding.sandbox.configurationDigest);
      const data = { kind: 'docker-container', protocol: 1, name: id, enginePath: q.enginePath, engineVersion: q.engineVersion, daemonId: (await docker(['info', '--format', '{{.ID}}'])).stdout.trim(), imagePin: q.image, imageId: q.image, labels, scope, stage: 'enrolled' };
      await life.enroll(scope, id, data); await life.update(scope, id, { ...data, stage: 'allocating' });
      // Minimal inert recovery fixture: Docker CREATE only, never START/exec/repository code.
      const made = await docker(['create', '--name', id, '--pull=never', '--network=none', '--read-only', '--user=65532:65532', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', `--security-opt=seccomp=${q.seccompPath}`, '--pids-limit=32', '--memory=256m', '--memory-swap=256m', '--cpus=0.5', ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]), '--entrypoint=/usr/local/bin/node', q.image, '/opt/p2o/offline-worker.mjs']);
      expect(made.code).toBe(0); cid = made.stdout.trim(); await life.update(scope, id, { ...data, stage: 'created', containerId: cid });
      record = (await registry.inventory(scope, 'container'))[0]!; owner = await registry.read(scope);
      await expect(recoverContainerResources([record], scope, owner!.owner, q)).rejects.toThrow(/still live/); expect((await docker(['inspect', cid])).code).toBe(0);
      child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('close', () => resolve()));
      await expect(recoverContainerResources([], scope, owner!.owner, q)).rejects.toThrow(/empty/);
      for (const patch of [{ daemonId: 'wrong-daemon' }, { containerId: 'f'.repeat(64) }, { labels: { ...labels, 'org.pi-p2o.container.configuration': 'f'.repeat(64) } }]) { await expect(recoverContainerResources([{ ...record, data: { ...record.data, ...patch } }], scope, owner!.owner, q)).rejects.toThrow(); expect((await docker(['inspect', cid])).code).toBe(0); }
      const uncertain = `p2o-${randomUUID()}`; await expect(recoverContainerResources([{ ...record, id: uncertain, data: { ...data, name: uncertain, labels: containerSessionLabels(scope, uncertain, binding.sandbox.configurationDigest), stage: 'allocating' } }], scope, owner!.owner, q)).rejects.toThrow(/Allocation outcome unknown/);
      const fresh = new SessionReleaseRegistry({ root, probe, now: Date.now, monoNow: () => performance.now() });
      registerPackSessionFamily(fresh, { name: 'container', lookup: () => undefined, recover: (resources, s, o) => recoverContainerResources(resources, s, o, q), shutdown: async () => {} });
      const self = processIdentity((await probe.snapshot()).find(p => p.pid === process.pid)!);
      let swept = await fresh.sweepStale(self);
      if (!swept.verified) {
        expect(swept.entries[0]!.state).toBe('unverifiable'); expect(swept.entries[0]!.error).toMatch(/Absolute deadline exhausted/);
        // Keep the registry's original 2s bound. Quarantine while bounded background teardown finishes;
        // a LATER retry may prove durable absence, never pretend the first timeout was successful.
        const end = Date.now() + 10000;
        while ((await fresh.inventory(scope, 'container')).length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
        expect(await fresh.inventory(scope, 'container')).toEqual([]); swept = await fresh.sweepStale(self);
      }
      expect(swept.entries[0]!.state, JSON.stringify(swept)).toBe('swept'); expect(swept.entries[0]!.outstanding).toBe(0); expect(await fresh.inventory(scope, 'container')).toEqual([]); expect(isGone(await docker(['inspect', cid]))).toBe(true);
      await binding.sandbox.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('close', () => resolve())); }
      if (record && owner) await recoverContainerResources([record], record.data.scope as SessionScope, owner.owner, q);
      else if (cid) await docker(['rm', '--force', cid]);
      await r.cleanup();
    }
  });
});
