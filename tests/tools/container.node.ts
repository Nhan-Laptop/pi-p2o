import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createContainerSandbox, createDefaultRegistry, doctor, type ContainerSandboxOptions, type EngineRunner } from '../../src/tools/index.js';
import { createToolBroker } from '../../src/tools/broker.js';
import { createPolicy, TargetBudget } from '../../src/policy/index.js';
import { sha256 } from '../../src/tools/redaction.js';
import { analyzeSourceFiles } from '../../src/tools/source.js';
import { code, context, fixtureScope, roots } from './fixtures.js';

const ENGINE = '28.5.2+dfsg4';
const IMAGE = `fixture.invalid/p2o@sha256:${'a'.repeat(64)}`;
const LOCAL_IMAGE = `sha256:${'a'.repeat(64)}`;
const PACK_IMAGE_ID = `sha256:${'f'.repeat(64)}`;
const BASE_REF = `node@sha256:${'d'.repeat(64)}`;
const BASE_IMAGE = `sha256:${'e'.repeat(64)}`;
const BASE_LAYERS = Object.freeze([`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`]);
/** Base layers plus one pack layer: the honest pack descends from the digest-pinned base. */
const PACK_LAYERS = Object.freeze([...BASE_LAYERS, `sha256:${'3'.repeat(64)}`]);
/** A forged image can copy every label, yet its layer content addresses still differ. */
const FORGED_IMAGE_ID = `sha256:${'7'.repeat(64)}`;
const FORGED_LAYERS = Object.freeze([...BASE_LAYERS, `sha256:${'8'.repeat(64)}`]);
const FORGED_PIN = `fixture.invalid/forged@sha256:${'9'.repeat(64)}`;

function packEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 1, packVersion: '1.0.0', nodeVersion: 'v22.14.0',
    workerSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64), nodeSha256: 'e'.repeat(64),
    nonRoot: true, uid: 65532, gid: 65532, pid1: true, platform: 'linux', arch: 'x64',
    rootReadOnly: true, rootWriteDenied: true, inputReadOnly: true, inputWriteDenied: true, scratchWritable: true,
    noNetwork: true, seccompMode: 2, seccompFilters: 1, noNewPrivileges: 1, capabilities: '0'.repeat(16),
    ulimits: { nofile: '64', core: '0' },
    cgroup: { version: 2, memoryMax: '268435456', pidsMax: '32', cpuQuota: '50000', cpuPeriod: '100000' },
    ...overrides,
  };
}

function packLabels(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'org.pi-p2o.pack.version': '1.0.0', 'org.pi-p2o.node.version': '22.14.0',
    'org.pi-p2o.base.image': BASE_REF,
    'org.pi-p2o.worker.sha256': 'b'.repeat(64), 'org.pi-p2o.source.sha256': 'c'.repeat(64),
    ...overrides,
  };
}

interface FixtureOptions {
  version?: string; noCleanup?: boolean; evidence?: Record<string, unknown>;
  image?: string; labels?: Record<string, string>;
  /** RootFS.Layers served for the pinned image; defaults to the qualified pack layer list. */
  packLayers?: readonly string[];
  /** RootFS.Layers of the locally resolved base image; defaults to BASE_LAYERS. */
  baseLayers?: readonly string[];
  /** Local image ID the base reference resolves to; defaults to BASE_IMAGE. */
  baseImageId?: string;
  /** Digest-pinned base reference recorded in the pack label; defaults to BASE_REF. */
  baseRef?: string;
  /** Simulate a pruned/unpulled base image (cannot be verified locally). */
  baseMissing?: boolean;
  /** Alters the runtime config the pack record declares (forged-image modelling). */
  config?: { user?: string; workdir?: string; env?: readonly string[] };
}

/** Inert engine fixture: proves adapter logic only; never claims container isolation. */
function inertEngine(log: string[][], options: FixtureOptions = {}): EngineRunner {
  const image = options.image ?? IMAGE;
  const baseRef = options.baseRef ?? BASE_REF;
  const labels = options.labels ?? packLabels({ 'org.pi-p2o.base.image': baseRef });
  const packRecord = JSON.stringify({
    Id: image.startsWith('sha256:') ? image : PACK_IMAGE_ID,
    RepoDigests: image.startsWith('sha256:') ? [] : [image],
    Os: 'linux', Architecture: 'amd64',
    Config: { User: options.config?.user ?? '65532:65532', WorkingDir: options.config?.workdir ?? '/outputs', Env: [...(options.config?.env ?? ['P2O_OFFLINE_PACK=1'])], Labels: labels },
    RootFS: { Layers: [...(options.packLayers ?? PACK_LAYERS)] },
  });
  const baseRecord = JSON.stringify({ Id: options.baseImageId ?? BASE_IMAGE, RepoDigests: [baseRef], Os: 'linux', Architecture: 'amd64', Config: {}, RootFS: { Layers: [...(options.baseLayers ?? BASE_LAYERS)] } });
  return async (_executable, args, opts) => {
    log.push([...args]);
    if (args[0] === 'version') return { code: 0, stdout: `${options.version ?? ENGINE}/${options.version ?? ENGINE}`, stderr: '' };
    if (args[0] === 'image') {
      const reference = args.at(-1) ?? '';
      if (reference === (options.image ?? IMAGE)) return { code: 0, stdout: packRecord, stderr: '' };
      if (reference === baseRef) return options.baseMissing
        ? { code: 1, stdout: '', stderr: `Error response from daemon: No such image: ${baseRef}` }
        : { code: 0, stdout: baseRecord, stderr: '' };
      return { code: 1, stdout: '', stderr: `Error response from daemon: No such image: ${reference}` };
    }
    if (args[0] === 'run') {
      const input = JSON.parse(opts.input ?? '{}');
      const result = input.operation === 'preflight' ? packEvidence(options.evidence)
        : input.operation === 'source' ? analyzeSourceFiles(input.files, input.contains)
        : { kind: 'native', path: input.path, sha256: input.expectedSha256, bytes: 8, format: 'wasm', architecture: 'wasm32-or-wasm64-not-inferred', strings: [], limits: ['Fixture inspection only'] };
      return { code: 0, stdout: JSON.stringify(result), stderr: '' };
    }
    if (args[0] === 'rm') return { code: 0, stdout: '', stderr: `Error response from daemon: No such container: ${args[2]}` };
    if (args[0] === 'inspect') return { code: options.noCleanup ? 0 : 1, stdout: '', stderr: options.noCleanup ? '' : `Error: No such object: ${args[1]}` };
    throw new Error('Unexpected fixture engine command');
  };
}

async function config(t: Parameters<typeof roots>[0], runner: EngineRunner, overrides: Partial<ContainerSandboxOptions> = {}): Promise<ContainerSandboxOptions> {
  const p = await roots(t), seccompPath = join(p.root, 'seccomp.json');
  const seccomp = await readFile(new URL('../../containers/seccomp.json', import.meta.url)); await writeFile(seccompPath, seccomp);
  return {
    ...p, enginePath: '/usr/bin/docker', engineVersion: ENGINE, image: IMAGE,
    // Content pins: imageRootfsLayers is the lock's image.rootfsLayers, baseImageId is base.localBaseImageId.
    imageRootfsLayers: PACK_LAYERS, baseImageId: BASE_IMAGE,
    workerSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64), seccompPath, seccompSha256: sha256(seccomp),
    qualification: { acknowledgement: 'containers-share-host-kernel-not-hostile-code-isolation', dedicatedLab: true, approvedBy: 'local-fixture-owner', expiresAt: '2099-10-02T00:00:00.000Z', nativeEnabled: true },
    runner, fixtureAcknowledgement: 'inert-engine-fixture-not-container-isolation',
    ...overrides,
  };
}

test('qualified container builds fixed offline argv and verifies kernel-reported confinement', async t => {
  const log: string[][] = [], options = await config(t, inertEngine(log)), sandbox = createContainerSandbox(options);
  const scope = fixtureScope(); scope.grants[0]!.capabilities.push('native.inspect'); scope.grants[0]!.actions.push('native');
  const policy = createPolicy(scope);
  let state: unknown; // Inert local journal fixture, NOT a durability attestation.
  const budgets = new TargetBudget(policy.scope.targets, { runId: scope.runId, freshRun: true, journal: { load: () => state, save: s => { state = structuredClone(s); } } });
  assert.equal((await doctor({ registry: createDefaultRegistry({ native: true }), sandbox, budgets, required: ['source.analyze', 'native.inspect'] })).ok, true);
  const broker = createToolBroker({ policy, budgets, sandbox, registry: createDefaultRegistry({ native: true }) });
  const source = await broker.execute({ context, tool: 'source.analyze', input: { paths: ['app.ts'] } }); assert.equal((source.data as { kind: string }).kind, 'source');
  await writeFile(join(options.inputRoot, 'sample.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  const native = await broker.execute({ context, tool: 'native.inspect', input: { path: 'sample.wasm' } }); assert.equal((native.data as { format: string }).format, 'wasm');
  const runs = log.filter(argv => argv[0] === 'run'); assert.ok(runs.length >= 3);
  for (const args of runs) {
    assert.ok(args.includes('--network=none')); assert.ok(args.includes('--read-only')); assert.ok(args.includes('--cap-drop=ALL')); assert.ok(args.includes('--user=65532:65532')); assert.ok(args.includes('--pull=never'));
    assert.ok(args.includes(`--security-opt=seccomp=${options.seccompPath}`));
    assert.ok(args.includes('--security-opt=no-new-privileges:true'));
    assert.ok(args.includes(`type=bind,src=${options.inputRoot},dst=/inputs,readonly,bind-propagation=rprivate`));
    assert.doesNotMatch(args.join(' '), /docker\.sock|--privileged|--network=host|\/bin\/(?:ba)?sh|dst=\/home|src=.*outputs/);
    assert.ok(args.includes('--memory=256m')); assert.ok(args.includes('--pids-limit=32')); assert.ok(args.includes('--cpus=0.5'));
    assert.ok(args.includes('--ulimit=nofile=64:64')); assert.ok(args.includes('--ulimit=core=0:0'));
  }
  // Termination is proven by repeated removal+absence, never by a single check.
  assert.equal(log.filter(a => a[0] === 'rm').length, runs.length * 2);
  assert.equal(log.filter(a => a[0] === 'inspect').length, runs.length * 2);
});

test('local image-ID and registry-digest pins are both verified; identity or label drift fails closed', async t => {
  const digestConfig = await config(t, inertEngine([])); assert.equal((await createContainerSandbox(digestConfig).preflight()).ok, true);
  const idConfig = await config(t, inertEngine([], { image: LOCAL_IMAGE }), { image: LOCAL_IMAGE }); assert.equal((await createContainerSandbox(idConfig).preflight()).ok, true);
  const mismatched = await config(t, inertEngine([], { image: `sha256:${'9'.repeat(64)}` }), { image: LOCAL_IMAGE });
  assert.equal((await createContainerSandbox(mismatched).preflight()).ok, false);
  for (const drift of [
    { labels: packLabels({ 'org.pi-p2o.base.image': 'node:latest' }) },
    { labels: packLabels({ 'org.pi-p2o.pack.version': '0.9.0' }) },
    { labels: packLabels({ 'org.pi-p2o.worker.sha256': '9'.repeat(64) }) },
    { labels: packLabels({ 'org.pi-p2o.source.sha256': '9'.repeat(64) }) },
  ]) {
    const options = await config(t, inertEngine([], drift)); assert.equal((await createContainerSandbox(options).preflight()).ok, false);
  }
  const untagged = await config(t, inertEngine([])); untagged.image = 'node:latest'; assert.throws(() => createContainerSandbox(untagged), code('INVALID_INPUT'));
  const shortDigest = await config(t, inertEngine([])); shortDigest.image = `fixture.invalid/p2o@sha256:${'a'.repeat(63)}`; assert.throws(() => createContainerSandbox(shortDigest), code('INVALID_INPUT'));
});

test('kernel-reported execution constraints are mandatory, including the two-word ulimit regression', async t => {
  const failures: Record<string, unknown>[] = [
    { uid: 0 }, { gid: 0 }, { pid1: false }, { nonRoot: false },
    { rootReadOnly: false }, { rootWriteDenied: false }, { inputReadOnly: false }, { inputWriteDenied: false },
    { scratchWritable: false }, { noNetwork: false }, { seccompMode: 1 }, { seccompFilters: 0 },
    { noNewPrivileges: 0 }, { capabilities: '0000000000a80425' },
    { ulimits: { nofile: 'open', core: 'core' } }, // the real live-run bug: naive two-word limit parsing
    { ulimits: { nofile: '1024', core: '0' } },
    { cgroup: { version: 2, memoryMax: '536870912', pidsMax: '32', cpuQuota: '50000', cpuPeriod: '100000' } },
    { cgroup: { version: 2, memoryMax: '268435456', pidsMax: '64', cpuQuota: '50000', cpuPeriod: '100000' } },
    { cgroup: { version: 2, memoryMax: '268435456', pidsMax: '32', cpuQuota: '100000', cpuPeriod: '100000' } },
  ];
  for (const evidence of failures) {
    const options = await config(t, inertEngine([], { evidence }));
    const sandbox = createContainerSandbox(options);
    assert.equal((await sandbox.preflight()).ok, false, `expected failure for ${JSON.stringify(evidence)}`);
    await assert.rejects(sandbox.analyzeSource([{ path: 'x.ts', text: 'export const x = 1', sha256: 'd'.repeat(64) }]), code('UNAVAILABLE'));
  }
  // Pack byte identity is a different refusal class: the specific IDENTITY_DENIED code survives preflight.
  const identityFailures: Record<string, unknown>[] = [
    { nodeSha256: 'not-a-hash' }, { workerSha256: '9'.repeat(64) }, { nodeVersion: 'v24.19.0' }, { packVersion: '0.9.0' },
  ];
  for (const evidence of identityFailures) {
    const options = await config(t, inertEngine([], { evidence }));
    const sandbox = createContainerSandbox(options);
    const report = await sandbox.preflight();
    assert.equal(report.ok, false, `expected identity failure for ${JSON.stringify(evidence)}`);
    assert.match(report.checks.filter(entry => !entry.ok).map(entry => entry.detail).join(' '), /code=IDENTITY_DENIED/);
    await assert.rejects(sandbox.analyzeSource([{ path: 'x.ts', text: 'export const x = 1', sha256: 'd'.repeat(64) }]), code('IDENTITY_DENIED'));
  }
});

test('missing engine release, unverified termination and daemon failure all fail closed', async t => {
  for (const failure of [{ version: '28.0.1' }, { noCleanup: true }]) {
    const log: string[][] = [], options = await config(t, inertEngine(log, failure));
    const sandbox = createContainerSandbox(options); assert.equal((await sandbox.preflight()).ok, false);
    await assert.rejects(sandbox.analyzeSource([{ path: 'x.ts', text: 'export const x = 1', sha256: 'd'.repeat(64) }]), code('UNAVAILABLE'));
  }
  const base = inertEngine([]);
  const daemonDown: EngineRunner = async (executable, args, opts) => args[0] === 'inspect' ? { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' } : base(executable, args, opts);
  const options = await config(t, daemonDown); assert.equal((await createContainerSandbox(options).preflight()).ok, false);
});

test('container qualification and seccomp identity are mandatory and expire without fallback', async t => {
  const expired = await config(t, inertEngine([])); expired.qualification.expiresAt = '2000-01-01T00:00:00.000Z';
  assert.equal((await createContainerSandbox(expired).preflight()).ok, false);
  const unacknowledged = await config(t, inertEngine([])); (unacknowledged.qualification as { dedicatedLab: boolean }).dedicatedLab = false;
  assert.throws(() => createContainerSandbox(unacknowledged), code('UNAVAILABLE'));
  const valid = await config(t, inertEngine([])); const sandbox = createContainerSandbox(valid); assert.equal((await sandbox.preflight()).ok, true);
  await writeFile(valid.seccompPath, '{}');
  await assert.rejects(sandbox.analyzeSource([{ path: 'x', text: 'x', sha256: 'd'.repeat(64) }]), code('UNAVAILABLE'));
});

test('container cancellation cleans owned container and verifies absence rather than just killing CLI', async t => {
  const log: string[][] = [], base = inertEngine(log); let blocked = false;
  const runner: EngineRunner = async (executable, args, opts) => {
    if (blocked && args[0] === 'run') {
      log.push([...args]);
      return await new Promise((_resolve, reject) => { const cancel = () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); opts.signal?.addEventListener('abort', cancel, { once: true }); if (opts.signal?.aborted) cancel(); });
    }
    return base(executable, args, opts);
  };
  const options = await config(t, runner), sandbox = createContainerSandbox(options); assert.equal((await sandbox.preflight()).ok, true);
  blocked = true; const cancel = new AbortController();
  const pending = sandbox.analyzeSource([{ path: 'x', text: 'x', sha256: 'd'.repeat(64) }], undefined, cancel.signal);
  cancel.abort(); await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === 'CANCELLED');
  assert.equal(log.at(-2)![0], 'rm'); assert.equal(log.at(-1)![0], 'inspect');
});

test('pinned security profile denies all socket/network/namespace syscalls by default', async () => {
  const profile = JSON.parse(await readFile(new URL('../../containers/seccomp.json', import.meta.url), 'utf8'));
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  const allowed = profile.syscalls.flatMap((rule: { names: string[] }) => rule.names);
  for (const name of ['socket', 'socketpair', 'connect', 'bind', 'listen', 'accept', 'sendto', 'mount', 'unshare', 'setns', 'ptrace', 'bpf']) assert.ok(!allowed.includes(name));
  assert.equal(profile.defaultErrnoRet, 1);
});

test('kill, module and privileged syscalls stay unavailable and clone3 falls back to clone', async () => {
  const profile = JSON.parse(await readFile(new URL('../../containers/seccomp.json', import.meta.url), 'utf8'));
  const rules = new Map<string, { action: string; errnoRet?: number; args?: unknown[] }>(profile.syscalls.flatMap((rule: { names: string[]; action: string; errnoRet?: number; args?: unknown[] }) => rule.names.map(name => [name, rule])));
  for (const name of ['init_module', 'finit_module', 'reboot', 'kexec_load', 'setuid', 'setns', 'pivot_root', 'open_by_handle_at']) assert.equal(rules.has(name), false, `${name} must be denied by default`);
  assert.equal(rules.get('kill')?.action, 'SCMP_ACT_ALLOW'); // allowed only inside the container's own PID namespace
  assert.equal(rules.get('clone3')?.action, 'SCMP_ACT_ERRNO');
  assert.equal(rules.get('clone3')?.errnoRet, 38); // ENOSYS forces glibc/pthread to fall back to clone
  assert.equal(rules.get('clone')?.action, 'SCMP_ACT_ALLOW');
  assert.equal((rules.get('clone')?.args?.[0] as { op: string }).op, 'SCMP_CMP_MASKED_EQ');
});

test('native header inspector is functional on local inert ELF/PE/Wasm bytes and never executes them', async () => {
  const moduleUrl = new URL('../../containers/offline-worker.mjs', import.meta.url).href;
  const { inspectBuffer } = await import(moduleUrl);
  const elf = Buffer.alloc(32); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); elf.writeUInt16LE(62, 18);
  assert.equal(inspectBuffer('sample.elf', elf).architecture, 'x86_64');
  const pe = Buffer.alloc(128); pe.set([0x4d, 0x5a]); pe.writeUInt32LE(64, 0x3c); pe.set([0x50, 0x45, 0, 0], 64); pe.writeUInt16LE(0x8664, 68);
  assert.equal(inspectBuffer('sample.exe', pe).format, 'pe');
  assert.equal(inspectBuffer('sample.wasm', Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])).format, 'wasm');
  assert.match(inspectBuffer('sample.wasm', Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])).limits.join(' '), /never executed/);
});

test('operational broker/doctor refuses missing durable counters instead of a fixture fallback', async t => {
  const options = await config(t, inertEngine([])), sandbox = createContainerSandbox(options), policy = createPolicy(fixtureScope());
  assert.equal((await doctor({ registry: createDefaultRegistry(), sandbox, required: ['http.request'] })).ok, false);
  assert.throws(() => createToolBroker({ policy, budgets: new TargetBudget(policy.scope.targets), sandbox }), code('UNAVAILABLE'));
});

test('injected container drivers require explicit fixture acknowledgement and cannot widen egress', async t => {
  const options = await config(t, inertEngine([]));
  const noAck = { ...options, fixtureAcknowledgement: undefined }; assert.throws(() => createContainerSandbox(noAck), code('UNAVAILABLE'));
  const sandbox = createContainerSandbox(options); assert.equal((await sandbox.preflight()).ok, true);
  assert.match(sandbox.boundary, /inert-engine-fixture.*no-container-isolation/); sandbox.assertEgress('127.0.0.1');
  assert.throws(() => sandbox.assertEgress('192.0.2.1'), code('ADDRESS_DENIED'));
});


test('image identity requires a content-addressed layer pin, base descent and pack runtime config', async t => {
  const log: string[][] = [], options = await config(t, inertEngine(log));
  const sandbox = createContainerSandbox(options);
  const report = await sandbox.preflight();
  assert.equal(report.ok, true);
  const detail = report.checks.find(entry => entry.name === 'image-pin')?.detail ?? '';
  assert.match(detail, /layer-pin=verified/);
  assert.match(detail, new RegExp(`baseId=${BASE_IMAGE}`));
  assert.match(detail, /baseLayers=2/);
  assert.match(detail, /layers=3/);

  // Every refusal below happens during preflight, i.e. before any container is started.
  const refusals: { name: string; options: Partial<ContainerSandboxOptions>; fixture?: FixtureOptions; reason: RegExp }[] = [
    { name: 'layer pin absent', options: { imageRootfsLayers: undefined }, reason: /A content-addressed image layer pin/ },
    { name: 'layer pin drift', options: {}, fixture: { packLayers: FORGED_LAYERS }, reason: /layer content does not match the recorded pack layer pin/ },
    { name: 'layer pin malformed', options: { imageRootfsLayers: ['not-a-layer'] as unknown as readonly string[] }, reason: /INVALID_INPUT|sha256 layer diff ids/ },
    { name: 'claimed base not resolvable locally', options: {}, fixture: { baseMissing: true }, reason: /is not present locally/ },
    { name: 'recorded base image id drift', options: { baseImageId: `sha256:${'c'.repeat(64)}` }, reason: /does not match the recorded base image pin/ },
    { name: 'base layer descent broken', options: {}, fixture: { baseLayers: [`sha256:${'4'.repeat(64)}`] }, reason: /does not descend from the claimed base image layers/ },
    { name: 'base label is a mutable name', options: {}, fixture: { baseRef: 'node:latest' }, reason: /digest-pinned base image/ },
    { name: 'pack user is not the pinned uid', options: {}, fixture: { config: { user: '0:0' } }, reason: /non-root pack user/ },
    { name: 'pack working directory drift', options: {}, fixture: { config: { workdir: '/tmp' } }, reason: /working directory/ },
    { name: 'pack marker environment missing', options: {}, fixture: { config: { env: [] } }, reason: /offline pack marker/ },
  ];
  for (const refusal of refusals) {
    const attemptLog: string[][] = [];
    const attempt = await config(t, inertEngine(attemptLog, refusal.fixture ?? {}), refusal.options);
    let attemptSandbox: ReturnType<typeof createContainerSandbox> | undefined;
    let constructionError: unknown;
    try { attemptSandbox = createContainerSandbox(attempt); } catch (error) { constructionError = error; }
    if (constructionError) {
      // Malformed pins are rejected before any engine call at all.
      assert.equal((constructionError as { code?: string }).code, 'INVALID_INPUT', refusal.name);
      assert.equal(attemptLog.length, 0, `${refusal.name}: no engine call may happen`);
      continue;
    }
    const attemptReport = await attemptSandbox!.preflight();
    assert.equal(attemptReport.ok, false, refusal.name);
    const failedDetail = attemptReport.checks.filter(entry => !entry.ok).map(entry => `${entry.name} ${entry.detail}`).join(' | ');
    assert.match(failedDetail, refusal.reason, refusal.name);
    const refusalError = await attemptSandbox!.analyzeSource([{ path: 'x.ts', text: 'export const x = 1;', sha256: 'd'.repeat(64) }]).then(() => null, (error: unknown) => error);
    assert.equal((refusalError as { code?: string } | null)?.code, 'IDENTITY_DENIED', refusal.name);
    assert.equal(attemptLog.filter(argv => argv[0] === 'run').length, 0, `${refusal.name}: no container may be started`);
  }
});

test('a forged image that copies every label and runtime field is still refused by the content layer pin', async t => {
  // The pin cannot be inferred from a tag, a name or a label set: the forged image declares the
  // honest release labels, uid, workdir, marker env and the same digest-pinned base prefix, and only
  // its pack layer content differs. It must be refused before any container is started.
  const log: string[][] = [];
  const options = await config(t, inertEngine(log, { image: FORGED_PIN, packLayers: FORGED_LAYERS, labels: packLabels() }), {
    image: FORGED_PIN, imageRootfsLayers: PACK_LAYERS,
  });
  const sandbox = createContainerSandbox(options);
  const report = await sandbox.preflight();
  assert.equal(report.ok, false);
  const failed = report.checks.filter(entry => !entry.ok).map(entry => entry.detail).join(' ');
  assert.match(failed, /code=IDENTITY_DENIED/);
  assert.match(failed, /layer content does not match the recorded pack layer pin/);
  await assert.rejects(sandbox.analyzeSource([{ path: 'x.ts', text: 'export const x = 1;', sha256: 'd'.repeat(64) }]), code('IDENTITY_DENIED'));
  assert.equal(log.filter(argv => argv[0] === 'run').length, 0, 'a spoofed image must never reach a container start');
});
