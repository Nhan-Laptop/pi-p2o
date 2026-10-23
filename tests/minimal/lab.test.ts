import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ENVIRONMENT_STEPS, EnvironmentStore, PAYLOAD_BYTES, PayloadStore, isPayloadId, normalizeRecipe, payloadDirectory, runEnvironment, stopEnvironment } from '../../src/lab.js';
import { readCompose } from '../../src/compose.js';
import { fixture, populate } from './helpers/report-fixture.js';

// planning_update.md P14.2: a receipt is a redacted excerpt, so a claim could not hand the thing that actually ran to a second
// worker. These tests pin the replacement: byte-exact run-scoped storage, a sha256 the ledger can cite, and a derived
// `replayable` that never becomes a stored field.
describe('payload artifacts (P14.2)', () => {
  it('stores the exact bytes unredacted, under a private directory, and reads them back with the recorded hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-lab-'));
    try {
      const storePath = join(root, 'records.sqlite'), store = new PayloadStore(storePath);
      const body = 'GET /orders/7 HTTP/1.1\nHost: fixture.invalid\nAuthorization: Bearer sekret-value\n\n';
      const ref = await store.put('worker-a', { kind: 'request', name: 'foreign order read', body });
      expect(isPayloadId(ref.id)).toBe(true);
      expect(ref).toMatchObject({ kind: 'request', name: 'foreign order read', bytes: Buffer.byteLength(body), storedBy: 'worker-a' });
      expect(store.directory).toBe(payloadDirectory(storePath));
      expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(store.directory, `${ref.id}.json`))).mode & 0o777).toBe(0o600);
      const read = await store.get(ref.id);
      // The whole point: the credential survives, because a replay that loses it is not a replay.
      expect(read.body).toBe(body);
      expect(read.ref).toMatchObject({ id: ref.id, sha256: ref.sha256, bytes: ref.bytes });
      expect(ref.sha256).toBe((await import('node:crypto')).createHash('sha256').update(body).digest('hex'));
      expect(await store.has(ref.id)).toBe(true);
      // A second write is a new artifact, never a rewrite of the first.
      expect((await store.put('worker-b', { kind: 'script', name: 'second', body: 'id' })).id).not.toBe(ref.id);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails closed on a bad id, a missing artifact and bytes that no longer match their hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-lab-'));
    try {
      const store = new PayloadStore(join(root, 'records.sqlite'));
      const ref = await store.put('owner', { kind: 'command', name: 'probe', body: 'curl -s http://127.0.0.1:8080/' });
      await expect(store.get('../../etc/passwd')).rejects.toThrow(/Invalid payload ID/);
      await expect(store.get('payload-00000000-0000-4000-8000-000000000000')).rejects.toThrow(/Unknown payload ID/);
      expect(await store.has('payload-00000000-0000-4000-8000-000000000000')).toBe(false);
      await writeFile(join(store.directory, `${ref.id}.json`), JSON.stringify({ ...ref, body: 'curl -s http://elsewhere/' }));
      await expect(store.get(ref.id)).rejects.toThrow(/Payload integrity failure/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('bounds the artifact: closed kind list, named body cap and no control or bidi characters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-lab-'));
    try {
      const store = new PayloadStore(join(root, 'records.sqlite')), ok = { kind: 'script', name: 'probe', body: 'echo hi' };
      await expect(store.put('owner', { ...ok, kind: 'binary' })).rejects.toThrow(/kind must be one of/);
      await expect(store.put('owner', { ...ok, name: '  ' })).rejects.toThrow(/Payload name/);
      await expect(store.put('owner', { ...ok, name: 'x'.repeat(121) })).rejects.toThrow(/Payload name/);
      await expect(store.put('owner', { ...ok, body: '' })).rejects.toThrow(/Payload body/);
      await expect(store.put('owner', { ...ok, body: 'a'.repeat(PAYLOAD_BYTES + 1) })).rejects.toThrow(/Payload body/);
      await expect(store.put('owner', { ...ok, body: 'echo \u0000hi' })).rejects.toThrow(/control/);
      await expect(store.put('owner', { ...ok, body: 'echo \u202ehi' })).rejects.toThrow(/control/);
      await expect(store.put('bad id', ok)).rejects.toThrow(/Invalid payload producer/);
      // A body of exactly the cap is accepted, so the bound is inclusive and documented rather than off by one.
      expect((await store.put('owner', { ...ok, body: 'a'.repeat(PAYLOAD_BYTES) })).bytes).toBe(PAYLOAD_BYTES);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('lets a claim cite the payload, and says "not replayable" for a claim that does not', async () => fixture(async h => {
    const built = await populate(h);
    const stored = (await h.call('p2o_lab', { action: 'payload', kind: 'request', name: 'fixture order read',
      body: 'GET /orders/7 HTTP/1.1\r\nHost: fixture.invalid\r\n\r\n' })).details;
    expect(stored.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await h.call('p2o_lab', { action: 'payload', id: stored.id })).details.body).toContain('GET /orders/7');
    const claim = (extra: Record<string, unknown>) => h.call('p2o_candidate', { surface: '/report-fixture', risk: 'authorization',
      negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary',
      limitations: 'One inert fixture actor only', evidenceRefs: [built.observation.evidenceId], ...extra });
    await claim({ candidate: 'replayable-claim', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', payloadRef: stored.id });
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
    // P14.3 tightened `replayable` to payload + environment, so a payload alone is still honestly "not replayable".
    expect(report).toContain('not replayable');
    expect(report).not.toContain(`payload \`${stored.id}\``);
    expect(report.slice(report.indexOf('| Claim |'), report.indexOf('## Tasks and handoffs'))).toContain('| Replayable |');
  }));

  it('refuses a payload reference that does not exist, and one on a claim that never ran', async () => fixture(async h => {
    const built = await populate(h);
    const base = { candidate: 'unreplayable-claim', surface: '/report-fixture', risk: 'authorization', evidenceRefs: [built.observation.evidenceId],
      negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary', limitations: 'One inert fixture actor only' };
    await expect(h.call('p2o_candidate', { ...base, closure: 'confirmed', execution: 'tested', proof: 'live_reproduction',
      payloadRef: 'payload-00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/Unknown payload reference/);
    await expect(h.call('p2o_candidate', { ...base, closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
      payloadRef: 'payload-00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/requires tested execution/);
    await expect(h.call('p2o_lab', { action: 'payload', kind: 'request', name: 'broken', body: 'echo \u0001' })).rejects.toThrow(/control/);
    await expect(h.call('p2o_lab', { action: 'payload', kind: 'request' })).rejects.toThrow(/needs kind, name and body/);
  }));
});

// planning_update.md P14.3: the environment recipe. The sandbox has no Docker daemon, so an environment is a recipe of local
// processes; the compose reader turns the target's own file into that recipe or refuses it by the key it cannot honour.
describe('environment recipe (P14.3)', () => {
  const IMAGE = 'p2o-sandbox:test';

  it('derives a runnable recipe from the target compose file, ordering services by depends_on', () => {
    const result = readCompose(`services:
  app:
    image: ${IMAGE}
    command: |
      sh -c 'exec python3 app.py'
    ports:
      - "8080:8000"
    environment:
      DEBUG: "1"
    depends_on:
      - db
  db:
    image: ${IMAGE}
    command: redis-server --port 6379
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
`, IMAGE);
    expect(result.refused).toEqual([]);
    expect(result.recipe).toEqual({ version: 1, source: 'compose', image: IMAGE, setup: [], seed: [], services: [
      { name: 'db', command: 'redis-server --port 6379', healthcheck: 'redis-cli ping', environment: {} },
      { name: 'app', command: "sh -c 'exec python3 app.py'", port: 8000, environment: { DEBUG: '1' } },
    ] });
  });

  it('refuses a compose file by the exact key it cannot honour, instead of stripping it', () => {
    const refusedFor = (body: string) => readCompose(`services:\n  web:\n    image: ${IMAGE}\n    command: echo hi\n${body}`, IMAGE).refused;
    expect(refusedFor('    privileged: true\n')).toContain("service 'web' sets privileged: true");
    expect(refusedFor('    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n')).toContain("service 'web' mounts host path '/var/run/docker.sock:/var/run/docker.sock'; only a named volume may be mounted");
    expect(refusedFor('    volumes:\n      - ./data:/data\n')).toEqual([expect.stringContaining("mounts host path './data:/data'")]);
    expect(refusedFor('    cap_add:\n      - SYS_ADMIN\n')).toContain("service 'web' sets cap_add");
    expect(refusedFor('    devices:\n      - "/dev/kvm"\n')).toContain("service 'web' sets devices");
    expect(refusedFor('    network_mode: host\n')).toContain("service 'web' sets network_mode: host");
    expect(refusedFor('    pid: host\n')).toContain("service 'web' sets pid: host");
    expect(refusedFor('    restart: always\n')).toContain("service 'web' sets restart: always");
    expect(refusedFor('    build: https://example.invalid/repo.git\n')).toContain("service 'web' builds an image; the sandbox has no Docker daemon, so pin an image and a command instead");
    expect(refusedFor('    ulimits:\n      nofile: 1024\n')).toContain("service 'web' sets 'ulimits', which this environment cannot translate");
    // A service in another image would silently run the wrong thing, so it is named rather than ignored.
    expect(readCompose(`services:\n  db:\n    image: postgres:16\n    command: postgres\n`, IMAGE).refused).toContain("service 'db' requests image 'postgres:16'; this environment runs commands inside 'p2o-sandbox:test'");
    // Nothing is half-accepted: one refusal means no recipe at all.
    expect(readCompose(`services:\n  web:\n    image: ${IMAGE}\n    command: echo hi\n    privileged: true\n`, IMAGE).recipe).toBeUndefined();
    expect(readCompose('services:\n  - not a mapping\n', IMAGE).recipe).toBeUndefined();
    expect(readCompose('', IMAGE).refused).toEqual([expect.stringContaining('compose file is empty')]);
  });

  it('keeps one environment per name and one revision per fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-env-'));
    try {
      const store = new EnvironmentStore(join(root, 'records.sqlite'));
      const recipe = normalizeRecipe({ setup: ['cp -r /target/. /work/app'], services: [{ name: 'web', command: 'python3 app.py', port: 8080 }], seed: ['curl -sf http://127.0.0.1:8080/seed'] }, IMAGE);
      const first = await store.put('owner', 'fixture-app', recipe);
      expect(first.created).toBe(true); expect(first.ref.revision).toBe(1);
      const second = await store.put('owner', 'fixture-app', recipe);
      // Registering the same recipe again is what a second worker does; it must not invent a revision.
      expect(second).toEqual({ ref: first.ref, created: false });
      expect(second.ref.fingerprint).toBe(first.ref.fingerprint);
      const changed = await store.put('owner', 'fixture-app', normalizeRecipe({ ...recipe, setup: ['cp -r /target/. /work/app', 'make'] }, IMAGE));
      expect(changed.created).toBe(true); expect(changed.ref.revision).toBe(2);
      expect(changed.ref.fingerprint).not.toBe(first.ref.fingerprint);
      expect((await store.list('fixture-app')).map(ref => ref.revision)).toEqual([1, 2]);
      expect((await store.get(first.ref.id)).fingerprint).toBe(first.ref.fingerprint);
      expect(await store.has(first.ref.id)).toBe(true);
      // Editing the stored recipe cannot keep the old identity.
      await writeFile(join(store.directory, `${first.ref.id}.json`), JSON.stringify({ ...first.ref, recipe: { ...recipe, setup: ['rm -rf /'] } }));
      await expect(store.get(first.ref.id)).rejects.toThrow(/Environment integrity failure/);
      expect(await store.has('env-00000000-0000-4000-8000-000000000000')).toBe(false);
      await expect(store.get('../../etc/passwd')).rejects.toThrow(/Invalid environment ID/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('verifies the same fingerprint twice while each run gets its own processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-env-'));
    try {
      const store = new EnvironmentStore(join(root, 'records.sqlite'));
      const recipe = normalizeRecipe({ services: [{ name: 'web', command: 'python3 app.py', port: 8080 }], seed: ['touch /work/seeded'] }, IMAGE);
      const { ref } = await store.put('owner', 'fixture-app', recipe);
      const record = await store.get(ref.id);
      const seen: string[] = [];
      const exec = async (command: string) => { seen.push(command); return { code: 0 }; };
      const first = await runEnvironment({ recipe: record.recipe, ref: record, exec });
      const second = await runEnvironment({ recipe: record.recipe, ref: record, exec });
      expect(first.fingerprint).toBe(record.fingerprint);
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(first.healthy).toBe(true);
      expect(first.services).toEqual([{ name: 'web', port: 8080, log: `/work/.p2o-env/${ref.id}/web.log` }]);
      expect(seen[0]).toBe(`mkdir -p /work/.p2o-env/${ref.id}`);
      expect(seen.some(command => command.includes('echo $$ >'))).toBe(true);
      expect(seen.some(command => command.includes('127.0.0.1:8080'))).toBe(true);
      expect(seen.at(-1)).toBe('touch /work/seeded');
      // A failing probe is reported as unhealthy, and a failing setup step stops the run with that step named.
      const unhealthy = await runEnvironment({ recipe: record.recipe, ref: record, exec: async command => ({ code: command.includes('127.0.0.1') ? 1 : 0 }) });
      expect(unhealthy.healthy).toBe(false);
      await expect(runEnvironment({ recipe: record.recipe, ref: record, exec: async () => ({ code: 7 }) })).rejects.toThrow(/Environment step prepare exited 7/);
      const stopped = await stopEnvironment({ ref: record, exec });
      expect(stopped.stopped).toBe(true);
      expect(seen.some(command => command.startsWith('rm -rf '))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('bounds the recipe and derives replayable only from a payload and a matching environment', async () => fixture(async h => {
    expect(() => normalizeRecipe({ setup: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }, IMAGE)).toThrow(/at most 8 commands/);
    expect(() => normalizeRecipe({}, IMAGE)).toThrow(/at least one setup command/);
    expect(() => normalizeRecipe({ services: [{ name: 'web', command: 'x', port: 0 }] }, IMAGE)).toThrow(/port/);
    expect(() => normalizeRecipe({ services: [{ name: 'web', command: 'x', extra: 1 }] }, IMAGE)).toThrow(/unknown field extra/);
    const built = await populate(h);
    const environment = (await h.call('p2o_lab', { action: 'env', name: 'fixture-app', services: [{ name: 'web', command: 'python3 app.py', port: 8080 }], seed: ['curl -sf http://127.0.0.1:8080/'] })).details;
    expect(environment).toMatchObject({ name: 'fixture-app', revision: 1, created: true, services: 1, seed: 1 });
    const verified = (await h.call('p2o_lab', { action: 'verify', id: environment.id })).details;
    // The inert sandbox answers every command with exit 0, so health here means "the recipe ran", not "the target worked".
    expect(verified).toMatchObject({ fingerprint: environment.fingerprint, healthy: true });
    const again = (await h.call('p2o_lab', { action: 'env', name: 'fixture-app', services: [{ name: 'web', command: 'python3 app.py', port: 8080 }], seed: ['curl -sf http://127.0.0.1:8080/'] })).details;
    expect(again).toMatchObject({ id: environment.id, created: false });
    const payload = (await h.call('p2o_lab', { action: 'payload', kind: 'request', name: 'fixture read', body: 'GET /orders/7 HTTP/1.1\r\n\r\n' })).details;
    const claim = (extra: Record<string, unknown>) => h.call('p2o_candidate', { surface: '/report-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested',
      proof: 'live_reproduction', negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor/object boundary',
      limitations: 'One inert fixture actor only', evidenceRefs: [built.observation.evidenceId], ...extra });
    await claim({ candidate: 'payload-only', payloadRef: payload.id });
    await claim({ candidate: 'both-refs', payloadRef: payload.id, environmentRef: environment.id });
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
    const row = (name: string) => report.slice(report.indexOf(`| ${name} |`) - 60, report.indexOf(`| ${name} |`) + 400);
    expect(row('both-refs')).toContain(`payload \`${payload.id}\``);
    expect(row('payload-only')).toContain('not replayable');
    await expect(claim({ candidate: 'dangling-env', payloadRef: payload.id, environmentRef: 'env-00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/Unknown environment reference/);
    await expect(h.call('p2o_lab', { action: 'verify', id: 'env-00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/Unknown environment ID/);
    expect((await h.call('p2o_lab', { action: 'destroy', id: environment.id })).details.stopped).toBe(true);
  }));
});
