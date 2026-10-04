#!/usr/bin/env node
// Live sandbox qualification smoke for the pinned pi-p2o offline execution pack.
//
// This is deliberately NOT a fixture test: it builds nothing, pulls nothing, injects no
// engine runner, and drives `createContainerSandbox` with the real `/usr/bin/docker` engine
// against the digest/image-ID pinned pack in `containers/pack.lock.json`. It verifies, from
// both outside and inside the container:
//
//   * the pinned engine release and pinned image identity really exist and are used
//   * a real container is created (observed via `docker events`) with the verified runtime
//     HostConfig (no network, read-only root, dropped capabilities, limits, no host mounts)
//   * non-root uid/gid 65532, read-only root + inputs, denied writes, seccomp filter active,
//     no_new_privs, zero capabilities, and real cgroup/ulimit bounds
//   * network socket syscalls are denied inside the container (kernel-level listen probe)
//   * bounded source/native inspection works and out-of-bounds requests fail closed
//   * cancellation kills and removes the owned container, with absence re-verified
//   * no owned `p2o-*` container leaks and no image is pulled anywhere in the run
//
// Inputs/outputs are dedicated temp directories only. Exit code 0 = every check passed.
// Identity is verified as a chain, never from a tag or a mutable name: the pinned image ID is
// checked against the engine, its RootFS layer content addresses are checked against the lock's
// image.rootfsLayers pin, the pack layers must start with the locally resolved digest-pinned base
// layers, and the in-container worker/source/node bytes are re-hashed by the pack itself. A forged
// image that copies every label and runtime field is built and must be refused before any container
// start. Nothing is ever pulled or built except that inert forged fixture.
//
//   node tests/sandbox/run.mjs [--allow-missing] [--receipt <path>] [--static]
//   --static performs only the lock/file integrity checks (no engine required).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const argv = process.argv.slice(2);
const flags = new Set(argv);
const allowMissing = flags.has('--allow-missing');
const receiptPath = flags.has('--receipt') ? argv[argv.indexOf('--receipt') + 1] : null;
const staticOnly = flags.has('--static');
const enginePath = '/usr/bin/docker';
const lockPath = join(repo, 'containers/pack.lock.json');
const seccompPath = join(repo, 'containers/seccomp.json');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}\n`); return ok; };
const check = (name, condition, detail) => record(name, Boolean(condition), detail);
class SmokeFailure extends Error {}

function docker(args, options = {}) {
  const result = spawnSync(enginePath, args, { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024, ...options });
  return { code: result.status ?? -1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim(), error: result.error };
}
const ownedContainers = () => docker(['ps', '-a', '--filter', 'name=p2o-', '--format', '{{.Names}}']).stdout.split('\n').filter(Boolean);

/** Real container/image observation: proves the engine executed the pinned image, captures the
 * actual HostConfig of live containers, and records any image pull during the whole run. */
function startObserver() {
  const since = new Date().toISOString();
  const child = spawn(enginePath, ['events', '--since', since, '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { events: [], creations: [], inspections: [], pulls: [], stopped: false };
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      state.events.push(event);
      const name = event?.Actor?.Attributes?.name ?? '';
      if (event?.Type === 'image' && event?.Action === 'pull') state.pulls.push(event.Actor?.ID ?? 'unknown');
      if (event?.Type !== 'container' || event?.Action !== 'create' || !name.startsWith('p2o-')) continue;
      state.creations.push({ name, image: event.Actor.Attributes.image, at: Date.now() });
      const inspector = spawn(enginePath, ['inspect', name], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      inspector.stdout.on('data', data => { output += data.toString('utf8'); });
      inspector.on('error', () => {});
      inspector.on('close', () => { try { state.inspections.push({ name, config: JSON.parse(output)[0] }); } catch { /* container already gone */ } });
    }
  });
  child.stderr.resume();
  return {
    state,
    async waitForCreate(afterIndex, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (state.creations.length > afterIndex) return state.creations[state.creations.length - 1];
        await sleep(20);
      }
      return null;
    },
    async stop() {
      if (state.stopped) return;
      state.stopped = true;
      child.kill('SIGTERM');
      await new Promise(resolve => { const timer = setTimeout(resolve, 1000); child.once('close', () => { clearTimeout(timer); resolve(); }); });
      await sleep(100);
    },
  };
}

async function compileOwnedSources(workDir) {
  const files = [];
  for (const dir of ['src/policy', 'src/tools']) for (const name of (await readdir(join(repo, dir))).sort()) if (name.endsWith('.ts')) files.push(join(repo, dir, name));
  const local = join(repo, 'node_modules/typescript/bin/tsc');
  const compiler = process.env.P2O_TSC ?? (existsSync(local) ? local : '/usr/bin/tsc');
  if (!existsSync(compiler)) throw new SmokeFailure('Provisioned TypeScript compiler unavailable; no auto-installation');
  const typeRoots = process.env.P2O_NODE_TYPE_ROOT ?? [join(repo, 'node_modules/@types'), '/usr/share/nodejs/@types'].find(path => existsSync(join(path, 'node')));
  if (!typeRoots) throw new SmokeFailure('Provisioned Node types unavailable');
  const compiled = spawnSync(process.execPath, [compiler, '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck', '--esModuleInterop', '--types', 'node', '--typeRoots', typeRoots, '--rootDir', repo, '--outDir', workDir, ...files], { cwd: repo, encoding: 'utf8' });
  if (compiled.status !== 0) throw new SmokeFailure(`Compile failed: ${(compiled.stdout + compiled.stderr).trim().split('\n').slice(0, 3).join(' ')}`);
  await writeFile(join(workDir, 'package.json'), '{"type":"module"}\n');
  return {
    index: await import(pathToFileURL(join(workDir, 'src/tools/index.js')).href),
    policy: await import(pathToFileURL(join(workDir, 'src/policy/index.js')).href),
  };
}

/**
 * Builds an inert forged pack image from the locally present pinned base: identical labels, uid,
 * workdir, marker env and base prefix, but different pack bytes. No pull, no target code; the caller
 * removes it again in a `finally`.
 */
async function forgeLabelledImage(lock) {
  const context = await mkdtemp(join(tmpdir(), 'p2o-forge-context-'));
  const tag = `p2o-forge-smoke:${Date.now()}`;
  try {
    const labelLines = Object.entries(lock.image.labels).map(([key, value]) => `      ${key}="${value}"`).join(' \\\n');
    await writeFile(join(context, 'Dockerfile'), `ARG BASE\nFROM \${BASE}\nARG BASE\nRUN echo forged-pack-layer > /opt/p2o-forged-marker\nWORKDIR /outputs\nUSER 65532:65532\nENV HOME=/tmp P2O_OFFLINE_PACK=1 NODE_OPTIONS=""\nLABEL ${labelLines}\n`);
    const build = docker(['build', '--no-cache', '--pull=false', '--progress=quiet', '--build-arg', `BASE=${lock.base.imageRef}`, '-t', tag, context]);
    if (build.code !== 0) { process.stdout.write(`note: forged-image build unavailable: ${(build.stderr || build.stdout).split('\n').slice(-2).join(' ')}\n`); return null; }
    const id = docker(['image', 'inspect', tag, '--format', '{{.Id}}']).stdout;
    return /^sha256:[a-f0-9]{64}$/.test(id) ? { id, tag } : null;
  } catch (error) { process.stdout.write(`note: forged-image build unavailable: ${error?.message ?? error}\n`); return null; }
  finally { await rm(context, { recursive: true, force: true }); }
}

async function main() {
  const started = Date.now();
  let buildDir = null;
  let workRoot = null;
  let observer = null;
  try {
    const missing = detail => {
      if (allowMissing) { process.stdout.write(`SKIP ${staticOnly ? 'static' : 'live'} sandbox smoke: ${detail}\n`); return true; }
      throw new SmokeFailure(`${detail} (run \`node containers/prepare.mjs --allow-pull\`; or pass --allow-missing to skip)`);
    };
    if (!existsSync(lockPath) && missing('containers/pack.lock.json is missing')) return;
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const receipt = {
      name: staticOnly ? 'p2o-sandbox-static-checks' : 'p2o-sandbox-live-smoke',
      generatedAt: new Date().toISOString(),
      get durationMs() { return Date.now() - started; },
      engine: lock.engineVersion,
      image: lock.image.pin,
      imageRootfsLayers: lock.image.rootfsLayers ?? null,
      base: lock.base.imageRef,
      baseImageId: lock.base.localBaseImageId,
      baseRootfsLayers: lock.base.rootfsLayers ?? null,
      workerSha256: lock.sources.workerSha256,
      sourceSha256: lock.sources.sourceSha256,
      seccompSha256: lock.sources.seccompSha256,
      nodeBinarySha256: lock.base.nodeBinarySha256,
      results,
    };
    const finish = async () => {
      const failed = results.filter(entry => !entry.ok);
      if (receiptPath) await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} ${staticOnly ? 'static' : 'live'} sandbox smoke: ${results.length - failed.length}/${results.length} checks passed (${Date.now() - started}ms)\n`);
      if (failed.length) process.exitCode = 1;
    };

    // ---- lock integrity: no engine required, so these run (and fail) even on a bare checkout ----
    const isLayer = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
    check('lock-version', lock.lockVersion === 2, `lockVersion=${lock.lockVersion} (2 records the content pins the adapter now requires)`);
    check('lock-image-pin-format', isLayer(lock.image?.pin), `image.pin=${lock.image?.pin}`);
    check('lock-base-image-id', isLayer(lock.base?.localBaseImageId), `base.localBaseImageId=${lock.base?.localBaseImageId}`);
    check('lock-image-layer-pin', Array.isArray(lock.image?.rootfsLayers) && lock.image.rootfsLayers.length > 0 && lock.image.rootfsLayers.every(isLayer), `image.rootfsLayers=${Array.isArray(lock.image?.rootfsLayers) ? lock.image.rootfsLayers.length : 'missing'} content addresses`);
    check('lock-base-layer-pin', Array.isArray(lock.base?.rootfsLayers) && lock.base.rootfsLayers.length > 0 && lock.base.rootfsLayers.every(isLayer), `base.rootfsLayers=${Array.isArray(lock.base?.rootfsLayers) ? lock.base.rootfsLayers.length : 'missing'} content addresses`);
    check('lock-base-layer-prefix', Array.isArray(lock.base?.rootfsLayers) && Array.isArray(lock.image?.rootfsLayers) && lock.base.rootfsLayers.every((layer, index) => lock.image.rootfsLayers[index] === layer), 'the pinned pack layers start with the pinned base layers');
    check('lock-identity-consistency', lock.image?.labels?.['org.pi-p2o.worker.sha256'] === lock.sources?.workerSha256 && lock.image?.labels?.['org.pi-p2o.source.sha256'] === lock.sources?.sourceSha256 && lock.image?.inImage?.worker === lock.sources?.workerSha256 && lock.image?.inImage?.source === lock.sources?.sourceSha256, 'pack labels, inImage bytes and source identities agree inside the lock');
    check('lock-seccomp-file-bytes', sha256(await readFile(seccompPath)) === lock.sources.seccompSha256, `containers/seccomp.json matches the locked ${String(lock.sources.seccompSha256).slice(0, 16)}…`);
    check('lock-worker-file-bytes', sha256(await readFile(join(repo, 'containers/offline-worker.mjs'))) === lock.sources.workerSha256, `containers/offline-worker.mjs matches the locked ${String(lock.sources.workerSha256).slice(0, 16)}…`);
    if (staticOnly) { await finish(); return; }
    if (docker(['image', 'inspect', '--format', '{{.Id}}', lock.image.pin]).code !== 0 && missing(`pinned pack image ${lock.image.pin} is not present in the local engine`)) return;
    if (docker(['version', '--format', '{{.Client.Version}}/{{.Server.Version}}']).stdout !== `${lock.engineVersion}/${lock.engineVersion}` && missing(`pinned engine ${lock.engineVersion} is unavailable`)) return;

    buildDir = await mkdtemp(join(tmpdir(), 'p2o-sandbox-smoke-'));
    const { index, policy } = await compileOwnedSources(buildDir);
    workRoot = await mkdtemp(join(tmpdir(), 'p2o-sandbox-live-'));
    const inputRoot = join(workRoot, 'inputs');
    const outputRoot = join(workRoot, 'outputs');
    const marker = join(workRoot, 'fixture-executed-marker-must-not-exist');
    await mkdir(inputRoot, { mode: 0o700 });
    await mkdir(outputRoot, { mode: 0o700 });
    // The in-container identity is uid 65532, so the trusted snapshot is made world-readable for
    // native inspection (documented operator requirement); the output root stays owner-only.
    await chmod(inputRoot, 0o755);

    observer = startObserver();
    const before = ownedContainers();
    check('no-preexisting-owned-containers', before.length === 0, before.length ? `refusing to run with existing p2o-* containers: ${before.join(', ')}` : 'engine has no p2o-* containers before the smoke');
    if (before.length) throw new SmokeFailure('refusing to interfere with existing p2o-* containers');

    const sourceFiles = {
      'app.ts': "import http from 'node:http';\nimport { helper } from './helper.js';\nexport const version = 1;\napp.get('/ok', handler);\nconst password = \"fixture-only-secret\";\n",
      'helper.ts': 'export function helper() { return 1; }\n',
      'package.json': JSON.stringify({ name: 'inert-fixture', scripts: { postinstall: `touch ${marker}` }, dependencies: { 'fixture-dep': '1.2.3' } }, null, 2),
    };
    for (const [name, text] of Object.entries(sourceFiles)) await writeFile(join(inputRoot, name), text, { mode: 0o644 });
    const wasmBytes = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    await writeFile(join(inputRoot, 'sample.wasm'), wasmBytes, { mode: 0o644 });
    await writeFile(join(inputRoot, 'oversized.bin'), Buffer.alloc(1048577, 0x41), { mode: 0o644 });
    const inputHashes = Object.fromEntries(await Promise.all((await readdir(inputRoot)).map(async name => [name, sha256(await readFile(join(inputRoot, name)))])));

    const options = {
      enginePath, engineVersion: lock.engineVersion, image: lock.image.pin,
      // Content pins from the lock; without them the adapter refuses to start a container at all.
      imageRootfsLayers: lock.image.rootfsLayers, baseImageId: lock.base.localBaseImageId,
      workerSha256: lock.sources.workerSha256, sourceSha256: lock.sources.sourceSha256,
      seccompPath, seccompSha256: lock.sources.seccompSha256,
      inputRoot, outputRoot, trustedInputSnapshot: true,
      qualification: {
        acknowledgement: 'containers-share-host-kernel-not-hostile-code-isolation',
        dedicatedLab: true,
        approvedBy: 'tests/sandbox/run.mjs live verification window',
        expiresAt: new Date(Date.now() + 6 * 3600e3).toISOString(),
        nativeEnabled: true,
      },
    };
    check('no-injected-engine-runner', !Object.hasOwn(options, 'runner') && !Object.hasOwn(options, 'fixtureAcknowledgement'), 'sandbox is constructed with the real runFixedProcess engine boundary only');
    const sandbox = index.createContainerSandbox(options);
    check('dedicated-boundary', sandbox.boundary === 'dedicated-offline-container:shared-kernel:broker-only-target-egress' && /^[a-f0-9]{64}$/.test(sandbox.configurationDigest), `boundary=${sandbox.boundary} configurationDigest=${sandbox.configurationDigest.slice(0, 16)}…`);

    const preflightStarted = Date.now();
    const report = await sandbox.preflight();
    const preflightMs = Date.now() - preflightStarted;
    const named = Object.fromEntries(report.checks.map(entry => [entry.name, entry]));
    const required = ['filesystem', 'engine-release', 'image-pin', 'pack-identity', 'execution-constraints', 'termination-verified', 'offline-container'];
    check('real-container-preflight', report.ok && required.every(name => named[name]?.ok === true), `preflight ok=${report.ok} in ${preflightMs}ms; checks=${report.checks.map(entry => `${entry.name}:${entry.ok ? 'ok' : 'fail'}`).join(' ')}`);
    check('engine-release-pinned', Boolean(named['engine-release']?.detail.includes(`client=server=${lock.engineVersion}`)), named['engine-release']?.detail ?? 'missing');
    check('image-pin-verified', Boolean(named['image-pin']?.detail.includes(lock.image.pin) && named['image-pin']?.detail.includes(lock.base.imageRef)), named['image-pin']?.detail ?? 'missing');
    check('pack-identity-verified', ['node=v22.14.0', lock.sources.workerSha256, lock.sources.sourceSha256, lock.base.nodeBinarySha256].every(fragment => named['pack-identity']?.detail.includes(fragment)), named['pack-identity']?.detail ?? 'missing');
    const constrained = named['execution-constraints']?.detail ?? '';
    const requiredConstraints = ['uid=65532', 'gid=65532', 'pid1=true', 'root=ro', 'inputs=ro', 'write-denied=root,inputs', 'scratch=rw', 'seccomp=2', 'no-new-privs=1', 'caps=0000000000000000', 'net-sockets=denied', 'pids=32', 'memory=268435456', 'cpu=50000/100000', 'nofile=64', 'core=0'];
    check('execution-constraints-kernel-reported', requiredConstraints.every(fragment => constrained.includes(fragment)), constrained || 'missing');
    const imagePinDetail = named['image-pin']?.detail ?? '';
    check('image-layer-pin-verified', imagePinDetail.includes('layer-pin=verified') && imagePinDetail.includes(`layers=${lock.image.rootfsLayers.length}`), `pinned image content addresses verified against image.rootfsLayers (${lock.image.rootfsLayers.length} layers), not against a tag or label`);
    check('base-layer-binding-verified', imagePinDetail.includes(`baseId=${lock.base.localBaseImageId}`) && imagePinDetail.includes(`baseLayers=${lock.base.rootfsLayers.length}`), `pack layers descend from the locally resolved ${lock.base.imageRef} (baseId=${lock.base.localBaseImageId}, ${lock.base.rootfsLayers.length} base layers)`);

    // Real-runner proof: the engine created a container from the pinned image and its live
    // HostConfig matches the qualified confinement, observed from outside the container.
    await sleep(200);
    const creation = observer.state.creations[0];
    const inspected = observer.state.inspections[0]?.config;
    check('real-engine-created-pinned-container', Boolean(creation) && creation.image.includes(lock.image.pin) && creation.name.startsWith('p2o-'), creation ? `docker events create name=${creation.name} image=${creation.image}` : 'docker events observed no p2o-* create event');
    const host = inspected?.HostConfig ?? {};
    const binds = (inspected?.Mounts ?? []).filter(entry => entry.Type === 'bind').map(entry => `${entry.Source}->${entry.Destination}:${entry.RW ? 'rw' : 'ro'}`);
    const hostOk = Boolean(inspected)
      && host.NetworkMode === 'none' && host.ReadonlyRootfs === true && host.Privileged !== true
      && host.PidsLimit === 32 && host.Memory === 268435456 && host.NanoCpus === 500000000
      && JSON.stringify(host.CapDrop ?? []) === '["ALL"]' && (host.SecurityOpt ?? []).includes('no-new-privileges:true')
      && (host.SecurityOpt ?? []).some(value => value.startsWith('seccomp=')) && host.LogConfig?.Type === 'none'
      && (inspected.Config?.User === '65532:65532' || host.User === '65532:65532')
      && ['/tmp', '/outputs'].every(path => Boolean(host.Tmpfs?.[path]))
      && binds.length === 1 && binds[0] === `${inputRoot}->/inputs:ro`
      && !binds.some(entry => /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.docker|docker\.sock|\.pi)(?:\/|$)/.test(entry) || entry.startsWith(`${homedir()}->`));
    check('real-container-host-config', hostOk, inspected ? `network=${host.NetworkMode} readonly=${host.ReadonlyRootfs} user=${host.User ?? inspected.Config?.User} pids=${host.PidsLimit} memory=${host.Memory} nanocpus=${host.NanoCpus} capdrop=${JSON.stringify(host.CapDrop)} security=${(host.SecurityOpt ?? []).map(value => value.startsWith('seccomp=') ? 'seccomp=<pinned profile>' : value).join(',')} logDriver=${host.LogConfig?.Type} binds=${binds.join(',') || 'none'} tmpfs=${Object.keys(host.Tmpfs ?? {}).join(',') || 'none'}` : 'no live inspect captured (container may have exited before inspection)');

    const files = Object.entries(sourceFiles).map(([path, text]) => ({ path, text, sha256: sha256(Buffer.from(text)) }));
    const evidence = await sandbox.analyzeSource(files, 'password');
    const app = evidence.files.find(entry => entry.path === 'app.ts');
    const pkg = evidence.files.find(entry => entry.path === 'package.json');
    check('source-inspection-real', evidence.kind === 'source' && Boolean(app?.imports.includes('node:http')) && Boolean(app?.routes.some(route => route.method === 'GET' && route.path === '/ok')) && Boolean(app?.indicators.some(item => item.kind === 'possible-hardcoded-secret-redacted-not-validated')) && pkg?.dependencies['dependencies:fixture-dep'] === '1.2.3' && app?.sha256 === sha256(Buffer.from(sourceFiles['app.ts'])), `files=${evidence.files.length} app.routes=${JSON.stringify(app?.routes)} app.imports=${JSON.stringify(app?.imports)} package.deps=${JSON.stringify(pkg?.dependencies)}`);
    check('source-never-executed', !existsSync(marker), 'inert postinstall marker command did not run; the pack performs lexical inspection only');

    const native = await sandbox.inspectNative('sample.wasm');
    check('native-bounded-inspection', native.format === 'wasm' && native.sha256 === sha256(wasmBytes) && native.kind === 'native' && native.limits.join(' ').includes('Read-only') && native.limits.join(' ').includes('never executed'), `format=${native.format} bytes=${native.bytes} sha256=${native.sha256.slice(0, 16)}… limits=${native.limits.length}`);
    const oversized = await sandbox.inspectNative('oversized.bin').then(() => null, error => error);
    check('native-input-bound', oversized instanceof policy.PolicyError && oversized.code === 'FILESYSTEM_DENIED', `oversized input rejected by the trusted-snapshot bound: ${oversized?.code ?? 'accepted'}`);

    const tiny = 'export const x = 1;\n';
    const tooMany = Array.from({ length: 65 }, (unused, index) => ({ path: `f${index}.ts`, text: tiny, sha256: sha256(Buffer.from(tiny)) }));
    const tooManyError = await sandbox.analyzeSource(tooMany).then(() => null, error => error);
    check('in-container-request-bound', tooManyError instanceof policy.PolicyError && tooManyError.code === 'UNAVAILABLE', `65-file request rejected inside the pack: ${tooManyError?.code ?? 'accepted'}`);
    const bigText = 'a'.repeat(4 * 1024 * 1024);
    const bigError = await sandbox.analyzeSource([{ path: 'big.ts', text: bigText, sha256: sha256(Buffer.from(bigText)) }]).then(() => null, error => error);
    check('in-container-stdin-bound', bigError instanceof policy.PolicyError && bigError.code === 'UNAVAILABLE', `>4MiB request rejected inside the pack: ${bigError?.code ?? 'accepted'}`);
    // ---- real-engine spoof refusal: identical labels/config/base prefix, different pack bytes ---
    const spoof = await forgeLabelledImage(lock);
    try {
      if (!spoof) {
        check('spoofed-image-refused', false, 'the inert forged image could not be built from the locally present base; content-pin refusal is proven only by the inert-runner tests');
      } else {
        const spoofImage = JSON.parse(docker(['image', 'inspect', spoof.id, '--format', '{{json .}}']).stdout);
        const spoofLabels = spoofImage.Config?.Labels ?? {};
        const canonicalLabels = value => JSON.stringify(Object.entries(value ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
        const labelsIdentical = canonicalLabels(spoofLabels) === canonicalLabels(lock.image.labels);
        const basePrefixIdentical = JSON.stringify((spoofImage.RootFS?.Layers ?? []).slice(0, lock.base.rootfsLayers.length)) === JSON.stringify(lock.base.rootfsLayers);
        const configIdentical = spoofImage.Config?.User === '65532:65532' && spoofImage.Config?.WorkingDir === '/outputs' && (spoofImage.Config?.Env ?? []).includes('P2O_OFFLINE_PACK=1');
        check('spoof-copies-every-declared-identity', labelsIdentical && basePrefixIdentical && configIdentical, `forged image ${spoof.id}: labels=${labelsIdentical} base-prefix=${basePrefixIdentical} user/workdir/marker=${configIdentical}; only the pack layer content differs`);
        const spoofSandbox = index.createContainerSandbox({ ...options, image: spoof.id });
        const creationsBefore = observer.state.creations.length;
        const spoofReport = await spoofSandbox.preflight();
        const spoofFailure = spoofReport.checks.filter(entry => !entry.ok).map(entry => entry.detail).join(' ');
        const spoofRefusal = await spoofSandbox.analyzeSource([{ path: 'x.ts', text: 'export const x = 1;\n', sha256: sha256(Buffer.from('export const x = 1;\n')) }]).then(() => null, error => error);
        const startedContainers = observer.state.creations.length - creationsBefore;
        check('spoofed-image-refused', spoofReport.ok === false && spoofFailure.includes('code=IDENTITY_DENIED') && spoofFailure.includes('layer content does not match the recorded pack layer pin') && spoofRefusal?.code === 'IDENTITY_DENIED' && startedContainers === 0, `preflight ok=${spoofReport.ok}; analyzeSource=${spoofRefusal?.code ?? 'accepted'}; container starts during the attempt=${startedContainers}; detail=${spoofFailure.slice(0, 240)}`);
        receipt.spoof = { image: spoof.id, labelsIdentical, basePrefixIdentical, configIdentical, refusedCode: spoofRefusal?.code ?? null, containerStarts: startedContainers };
      }
    } finally { if (spoof) docker(['rmi', '--force', spoof.tag]); }


    // Cancellation must abort a live container, prove its removal, and leave nothing behind.
    const cancelPayload = Array.from({ length: 64 }, (unused, index) => {
      const text = (`import x from 'pkg${index}';\nexport const y = ${index};\n`).padEnd(50 * 1024, `// padding ${index}\n`);
      return { path: `slow${index}.ts`, text, sha256: sha256(Buffer.from(text)) };
    });
    let cancelled = null;
    for (let attempt = 1; attempt <= 4 && !cancelled; attempt++) {
      const startIndex = observer.state.creations.length;
      const controller = new AbortController();
      const pending = sandbox.analyzeSource(cancelPayload, undefined, controller.signal).then(value => ({ value }), error => ({ error }));
      const live = await observer.waitForCreate(startIndex, 8000);
      if (!live) throw new SmokeFailure('cancellation smoke could not observe a live container within 8s');
      controller.abort();
      const outcome = await pending;
      if (outcome.error) cancelled = { name: live.name, code: outcome.error.code, attempt };
      else process.stdout.write(`note: cancellation attempt ${attempt} finished before the abort was delivered; retrying\n`);
    }
    check('cancellation-cleanup-verified', cancelled?.code === 'CANCELLED', cancelled ? `aborted live container ${cancelled.name} on attempt ${cancelled.attempt}; the adapter raised ${cancelled.code} only after verifying removal plus absence` : 'all attempts completed before the abort could be delivered');
    check('cancellation-left-no-container', ownedContainers().length === 0, `p2o-* containers after cancellation: ${ownedContainers().join(', ') || 'none'}`);

    const unchanged = (await Promise.all(Object.entries(inputHashes).map(async ([name, hash]) => sha256(await readFile(join(inputRoot, name))) === hash))).every(Boolean);
    check('trusted-input-unchanged', unchanged, `${Object.keys(inputHashes).length} trusted input files unchanged after all container runs`);

    await observer.stop();
    const after = ownedContainers();
    check('no-leaked-owned-containers', after.length === 0, `final p2o-* containers: ${after.join(', ') || 'none'} (${observer.state.creations.length} create events observed)`);
    check('no-image-pull-during-smoke', observer.state.pulls.length === 0, observer.state.pulls.length ? `pull events observed: ${observer.state.pulls.join(', ')}` : `docker events recorded no image pull across ${observer.state.events.length} engine events`);
    check('observed-engine-events', observer.state.creations.length >= 1 && observer.state.creations.every(entry => entry.name.startsWith('p2o-')), `docker events create events: ${observer.state.creations.length} (preflight+source+native+rejected requests+cancellation attempts)`);

    await finish();
  } finally {
    await observer?.stop();
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
    const leftover = ownedContainers();
    if (leftover.length) record('leak-guard-cleanup', false, `p2o-* containers still present after cleanup: ${leftover.join(', ')}`);
  }
}

main().catch(error => {
  const message = error instanceof SmokeFailure ? error.message : `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
  if (!results.some(entry => entry.name === 'live-smoke')) record('live-smoke', false, message);
  process.stdout.write(`\nFAIL ${staticOnly ? 'static' : 'live'} sandbox smoke: ${message}\n`);
  process.exitCode = 1;
});
