#!/usr/bin/env node
// Reproducible prepare/verify for the pinned pi-p2o offline execution pack.
//
//   node containers/prepare.mjs                 # verify inputs, build the pack, write pack.lock.json
//   node containers/prepare.mjs --allow-pull    # same, but pull the pinned base digest when absent
//   node containers/prepare.mjs --check         # rebuild and compare byte identity with the lock (fails on drift)
//   node containers/prepare.mjs --verify        # re-verify the locked pack against the local engine, no build/pull
//   node containers/prepare.mjs --offline       # skip the registry tag->digest re-resolution
//
// Only builtins plus the pinned Docker engine are used. Nothing is installed, no host
// network/security setting is changed, and no untrusted Dockerfile or target binary is built
// or run: the build context is `containers/` and every executed binary comes from the pinned
// public Node base image.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const flags = new Set(process.argv.slice(2));
const allowPull = flags.has('--allow-pull');
const checkOnly = flags.has('--check');
const rebase = flags.has('--rebase');
const offline = flags.has('--offline');
const verifyOnly = flags.has('--verify');
const printJson = flags.has('--print-json');
const enginePath = flags.has('--engine') ? process.argv[process.argv.indexOf('--engine') + 1] : '/usr/bin/docker';
const lockPath = join(here, 'pack.lock.json');
const buildDir = join(here, 'build');
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const fileSha = async path => sha256(await readFile(path));
const fail = message => { throw new Error(message); };
const step = message => process.stdout.write(`\n== ${message}\n`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  return result;
}
function docker(args, options = {}) {
  const result = run(enginePath, args, options);
  if (result.status !== 0) fail(`docker ${args[0]} failed (${result.status}): ${(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ')}`);
  return (result.stdout ?? '').trim();
}
function dockerJson(args) { return JSON.parse(docker(args)); }

/** Tag -> index digest, straight from the registry; never an invented digest. */
async function resolveTagDigest(reference) {
  const [repository, tag] = reference.split(':');
  if (!repository || !tag || !repository.startsWith('node')) fail(`Unsupported base reference: ${reference}`);
  const tokenResponse = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull`, { signal: AbortSignal.timeout(20000) });
  if (!tokenResponse.ok) fail(`Registry token request failed (${tokenResponse.status})`);
  const { token } = await tokenResponse.json();
  const manifestResponse = await fetch(`https://registry-1.docker.io/v2/library/node/manifests/${tag}`, {
    method: 'HEAD',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!manifestResponse.ok) fail(`Registry manifest request failed (${manifestResponse.status})`);
  const digest = manifestResponse.headers.get('docker-content-digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) fail('Registry did not return a digest for the pinned base tag');
  const bodyResponse = await fetch(`https://registry-1.docker.io/v2/library/node/manifests/${tag}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!bodyResponse.ok) fail(`Registry manifest body request failed (${bodyResponse.status})`);
  const index = await bodyResponse.json();
  const amd64 = (index.manifests ?? []).find(entry => entry?.platform?.os === 'linux' && entry?.platform?.architecture === 'amd64');
  return { indexDigest: digest, amd64ManifestDigest: amd64?.digest ?? null };
}

function imageInspect(reference) { return dockerJson(['image', 'inspect', '--format', '{{json .}}', reference]); }
/** File bytes are read with the qualified confinement: non-root, no caps, no network, read-only root. */
function imageFileHashes(image, paths) {
  const output = docker(['run', '--rm', '--pull=never', '--network=none', '--read-only', '--user=65532:65532', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--security-opt', `seccomp=${join(here, 'seccomp.json')}`, '--pids-limit=32', '--memory=256m', '--memory-swap=256m', '--ulimit=nofile=64:64', '--ulimit=core=0:0', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=8388608,mode=1777', '--entrypoint=/usr/bin/sha256sum', image, ...paths]);
  const hashes = {};
  for (const line of output.split('\n')) {
    const [digest, path] = line.trim().split(/\s+/);
    if (path) hashes[path] = digest;
  }
  return hashes;
}

/**
 * No-rebuild verification that the locally present pack still matches the lock. Uses only
 * `docker image inspect` and a read-only, non-root, capability-dropped sha256sum probe:
 * nothing is built, pulled, tagged or started as a workload.
 */
async function verifyLockedPack(lock) {
  if (!lock) fail('No pack.lock.json to verify; run a prepare first');
  if (!Array.isArray(lock.image?.rootfsLayers) || lock.image.rootfsLayers.length === 0) fail('Lock records no image.rootfsLayers content pin; re-run prepare in the dedicated lab instead of hand-editing the lock');
  step(`Verify locked pack ${lock.image.pin} against the local engine (no build, no pull)`);
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}\n`); };
  const image = imageInspect(lock.image.pin);
  check('image-pin', image.Id === lock.image.pin, `lock=${lock.image.pin} local=${image.Id}`);
  const expectedLabels = lock.image?.labels ?? {};
  const labels = image.Config?.Labels ?? {};
  const labelDrift = Object.entries(expectedLabels).filter(([key, value]) => labels[key] !== value).map(([key]) => key);
  check('image-labels', Object.keys(expectedLabels).length > 0 && labelDrift.length === 0, labelDrift.length ? `drifted labels: ${labelDrift.join(', ')}` : `${Object.keys(expectedLabels).length} pack labels match`);
  const marker = (image.Config?.Env ?? []).includes('P2O_OFFLINE_PACK=1');
  check('image-runtime-config', image.Config?.User === '65532:65532' && image.Config?.WorkingDir === '/outputs' && marker, `user=${JSON.stringify(image.Config?.User)} workdir=${JSON.stringify(image.Config?.WorkingDir)} offline-marker=${marker}`);
  const layers = Array.isArray(image.RootFS?.Layers) ? image.RootFS.Layers : [];
  const layersIdentical = layers.length > 0 && JSON.stringify(layers) === JSON.stringify(lock.image.rootfsLayers);
  check('image-layer-pin', layersIdentical, `locked=${lock.image.rootfsLayers.length} local=${layers.length} identical=${layersIdentical} (content addresses, not tags or labels)`);
  const inImage = imageFileHashes(lock.image.pin, ['/opt/p2o/offline-worker.mjs', '/opt/p2o/tools/source.js', '/opt/p2o/package.json', '/usr/local/bin/node']);
  const bytesOk = inImage['/opt/p2o/offline-worker.mjs'] === lock.image?.inImage?.worker && inImage['/opt/p2o/tools/source.js'] === lock.image?.inImage?.source && inImage['/usr/local/bin/node'] === lock.base?.nodeBinarySha256;
  check('image-in-image-bytes', bytesOk, `worker=${String(inImage['/opt/p2o/offline-worker.mjs']).slice(0, 16)}… source=${String(inImage['/opt/p2o/tools/source.js']).slice(0, 16)}… node=${String(inImage['/usr/local/bin/node']).slice(0, 16)}… package=${String(inImage['/opt/p2o/package.json']).slice(0, 16)}…`);
  const base = imageInspect(lock.base.imageRef);
  check('base-image-id', base.Id === lock.base.localBaseImageId, `lock=${lock.base.localBaseImageId} local=${base.Id}`);
  const baseLayers = Array.isArray(base.RootFS?.Layers) ? base.RootFS.Layers : [];
  const lockedBaseLayers = Array.isArray(lock.base?.rootfsLayers) ? lock.base.rootfsLayers : [];
  check('base-layer-pin', lockedBaseLayers.length > 0 && JSON.stringify(baseLayers) === JSON.stringify(lockedBaseLayers), `locked=${lockedBaseLayers.length} local=${baseLayers.length}`);
  const descent = baseLayers.length > 0 && layers.length > baseLayers.length && baseLayers.every((layer, index) => layers[index] === layer);
  check('pack-descends-from-base', descent, descent ? `pack rootfs starts with the ${baseLayers.length} layers of ${lock.base.imageRef}` : 'pack rootfs does not start with the locally resolved base layers');
  const consistent = expectedLabels['org.pi-p2o.worker.sha256'] === lock.sources?.workerSha256 && expectedLabels['org.pi-p2o.source.sha256'] === lock.sources?.sourceSha256 && lock.image?.inImage?.worker === lock.sources?.workerSha256 && lock.image?.inImage?.source === lock.sources?.sourceSha256;
  check('lock-self-consistency', consistent, 'pack labels, sources and inImage identities agree inside the lock');
  const failed = results.filter(entry => !entry.ok);
  process.stdout.write(`\n${failed.length ? 'FAIL' : 'PASS'} verify: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) fail(`Locked pack ${lock.image?.pin} did not verify against the local engine (${failed.map(entry => entry.name).join(', ')}); re-qualify in the dedicated lab instead of editing the lock by hand`);
}

async function main() {
  const lock = existsSync(lockPath) ? JSON.parse(await readFile(lockPath, 'utf8')) : null;
  const receipt = { packVersion: '1.0.0', nodeVersion: 'v22.14.0', preparedAt: new Date().toISOString(), checkOnly };

  step(`Engine ${enginePath}`);
  const version = docker(['version', '--format', '{{.Client.Version}}/{{.Server.Version}}']);
  const [clientVersion, serverVersion] = version.split('/');
  if (clientVersion !== serverVersion) fail(`Client/server release mismatch: ${version}`);
  if (lock && lock.engineVersion && lock.engineVersion !== clientVersion) {
    if (checkOnly || verifyOnly) fail(`Engine ${clientVersion} does not match the locked qualified release ${lock.engineVersion}`);
    console.log(`WARNING: engine ${clientVersion} differs from the locked ${lock.engineVersion}; the pack lock will be updated`);
  }
  receipt.engineVersion = clientVersion;
  console.log(`client=server=${clientVersion}`);
  if (verifyOnly) { await verifyLockedPack(lock); return; }

  step('Base image pin');
  const baseTag = lock?.base?.tag ?? 'node:22.14.0-bookworm-slim';
  const resolved = offline ? { indexDigest: lock?.base?.indexDigest ?? null, amd64ManifestDigest: lock?.base?.amd64ManifestDigest ?? null } : await resolveTagDigest(baseTag);
  if (!resolved.indexDigest) fail(`No pinned index digest available for ${baseTag}; rerun without --offline`);
  const baseMoved = Boolean(lock?.base?.indexDigest && lock.base.indexDigest !== resolved.indexDigest) || Boolean(lock?.base?.amd64ManifestDigest && resolved.amd64ManifestDigest && lock.base.amd64ManifestDigest !== resolved.amd64ManifestDigest);
  if (baseMoved) {
    if (!rebase) fail(`Base tag ${baseTag} resolves to ${resolved.indexDigest}/${resolved.amd64ManifestDigest}, locked to ${lock.base.indexDigest}/${lock.base.amd64ManifestDigest}; re-run with --rebase to re-qualify explicitly`);
    console.log('WARNING: --rebase adopted a new base digest; the previous qualification is superseded');
  }
  const baseRef = !rebase && lock?.base?.imageRef ? lock.base.imageRef : `node@${resolved.amd64ManifestDigest ?? resolved.indexDigest}`;
  receipt.base = { tag: baseTag, indexDigest: resolved.indexDigest, amd64ManifestDigest: resolved.amd64ManifestDigest, imageRef: baseRef };
  console.log(`${baseTag} -> index ${resolved.indexDigest}${resolved.amd64ManifestDigest ? `, linux/amd64 ${resolved.amd64ManifestDigest}` : ''}`);

  let baseExists = true;
  try { imageInspect(baseRef); } catch { baseExists = false; }
  if (!baseExists) {
    if (!allowPull) fail(`Pinned base ${baseRef} is not present locally. Re-run with --allow-pull to pull this exact digest (never a tag).`);
    step('Pulling pinned base by digest');
    docker(['pull', baseRef], { stdio: 'inherit' });
  }
  const base = imageInspect(baseRef);
  receipt.base.localBaseImageId = base.Id;
  receipt.base.rootfsLayers = Array.isArray(base.RootFS?.Layers) ? base.RootFS.Layers : [];
  if (receipt.base.rootfsLayers.length === 0) fail('Pinned base image exposes no content-addressed layers; identity cannot be pinned');
  const baseNodeVersion = docker(['run', '--rm', '--pull=never', '--network=none', '--entrypoint=/usr/local/bin/node', baseRef, '--version']).trim();
  if (baseNodeVersion !== 'v22.14.0') fail(`Pinned base reports ${baseNodeVersion}, expected v22.14.0`);
  receipt.base.nodeBinarySha256 = imageFileHashes(baseRef, ['/usr/local/bin/node'])['/usr/local/bin/node'];
  console.log(`base image id ${base.Id}, ${baseNodeVersion}, node binary ${receipt.base.nodeBinarySha256.slice(0, 16)}…`);

  step('Compile owned TypeScript with the pinned compiler');
  const compilerEntry = join(repo, 'node_modules/typescript/bin/tsc');
  if (!existsSync(compilerEntry)) fail('Provisioned TypeScript compiler missing; no auto-installation');
  const compilerKind = run(process.execPath, [compilerEntry, '--version']).stdout.trim();
  const compilerPackage = JSON.parse(await readFile(join(repo, 'node_modules/typescript/package.json'), 'utf8'));
  receipt.compiler = { entry: 'node_modules/typescript/bin/tsc', kind: compilerKind, version: compilerPackage.version, binSha256: await fileSha(compilerEntry), libSha256: await fileSha(join(repo, 'node_modules/typescript/lib/typescript.js')), hostNode: process.version };
  if (lock?.compiler && checkOnly) {
    if (lock.compiler.version !== receipt.compiler.version) fail(`Compiler ${receipt.compiler.version} does not match the locked ${lock.compiler.version}`);
    if (lock.compiler.binSha256 !== receipt.compiler.binSha256) fail('Provisioned compiler bytes differ from the locked compiler');
    if (lock.compiler.libSha256 !== receipt.compiler.libSha256) fail('Provisioned compiler library differs from the locked compiler library');
  } else if (lock?.compiler && lock.compiler.version !== receipt.compiler.version) console.log(`WARNING: compiler ${receipt.compiler.version} differs from the locked ${lock.compiler.version}; the pack lock will be updated`);
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  const sources = [];
  for (const dir of ['src/policy', 'src/tools']) for (const name of (await readdir(join(repo, dir))).sort()) if (name.endsWith('.ts')) sources.push(join(repo, dir, name));
  const compile = run(process.execPath, [compilerEntry, '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck', '--esModuleInterop', '--types', 'node', '--rootDir', join(repo, 'src'), '--outDir', buildDir, ...sources], { cwd: repo });
  if (compile.status !== 0) fail(`Compile failed:\n${compile.stdout}${compile.stderr}`);
  await writeFile(join(buildDir, 'package.json'), '{"type":"module"}\n');
  console.log(`compiled ${sources.length} sources with ${compilerKind} (${receipt.compiler.version})`);

  step('Pin build input bytes');
  const workerSha256 = await fileSha(join(here, 'offline-worker.mjs'));
  const sourceSha256 = await fileSha(join(buildDir, 'tools/source.js'));
  const seccompSha256 = await fileSha(join(here, 'seccomp.json'));
  receipt.sources = { workerSha256, sourceSha256, seccompSha256 };
  console.log(`worker=${workerSha256}\nsource=${sourceSha256}\nseccomp=${seccompSha256}`);

  step('Build pack (no cache, no pull, verification labels)');
  const iidFile = join(await mkdtemp(join(tmpdir(), 'p2o-iid-')), 'image-id');
  const buildArgs = [
    'build', '--no-cache', '--pull=false', '--progress=plain', '--iidfile', iidFile,
    '--build-arg', `NODE_IMAGE=${baseRef}`,
    '--build-arg', `WORKER_SHA256=${workerSha256}`,
    '--build-arg', `SOURCE_SHA256=${sourceSha256}`,
    '--platform', 'linux/amd64',
    '-t', 'p2o-offline-pack:22.14.0',
    here,
  ];
  const build = run(enginePath, buildArgs, { stdio: 'inherit', env: { ...process.env, SOURCE_DATE_EPOCH: '0' } });
  if (build.status !== 0) fail(`Pack build failed (${build.status})`);
  const imageId = (await readFile(iidFile, 'utf8')).trim();
  receipt.image = { pin: imageId, tag: 'p2o-offline-pack:22.14.0' };
  const image = imageInspect(imageId);
  const labels = image.Config?.Labels ?? {};
  const expectedLabels = {
    'org.pi-p2o.pack.version': '1.0.0',
    'org.pi-p2o.node.version': '22.14.0',
    'org.pi-p2o.base.image': baseRef,
    'org.pi-p2o.worker.sha256': workerSha256,
    'org.pi-p2o.source.sha256': sourceSha256,
  };
  for (const [key, value] of Object.entries(expectedLabels)) if (labels[key] !== value) fail(`Image label ${key}=${labels[key]} does not match ${value}`);
  if (image.Config?.User !== '65532:65532' || image.Config?.WorkingDir !== '/outputs') fail('Image does not pin the non-root /outputs runtime config');
  const inImage = imageFileHashes(imageId, ['/opt/p2o/offline-worker.mjs', '/opt/p2o/tools/source.js', '/opt/p2o/package.json']);
  if (inImage['/opt/p2o/offline-worker.mjs'] !== workerSha256 || inImage['/opt/p2o/tools/source.js'] !== sourceSha256) fail('Image file bytes do not match the pinned inputs');
  const packNodeVersion = docker(['run', '--rm', '--pull=never', '--network=none', '--read-only', '--entrypoint=/usr/local/bin/node', imageId, '--version']).trim();
  if (packNodeVersion !== 'v22.14.0') fail(`Image node reports ${packNodeVersion}`);
  receipt.image.labels = labels;
  receipt.image.inImage = inImage;
  receipt.image.rootfsLayers = Array.isArray(image.RootFS?.Layers) ? image.RootFS.Layers : [];
  if (receipt.image.rootfsLayers.length === 0) fail('Built image exposes no content-addressed rootfs layers; there is nothing to pin');
  console.log(`image ${imageId}\nlabels and /opt/p2o bytes verified, node ${packNodeVersion}`);

  if (checkOnly && lock) {
    for (const [key, value] of Object.entries(expectedLabels)) if (lock.image?.labels?.[key] !== value) fail(`Locked label ${key} differs from this build`);
    if (lock.image?.inImage?.source !== inImage['/opt/p2o/tools/source.js'] || lock.image?.inImage?.worker !== inImage['/opt/p2o/offline-worker.mjs']) fail('Locked /opt/p2o bytes differ from this build');
    // Byte-level reproducibility is asserted only from the content addresses, never from labels alone.
    const lockedLayers = Array.isArray(lock.image?.rootfsLayers) ? lock.image.rootfsLayers : null;
    const layersIdentical = Array.isArray(lockedLayers) && JSON.stringify(lockedLayers) === JSON.stringify(receipt.image.rootfsLayers);
    const differing = Array.isArray(lockedLayers) ? lockedLayers.filter(layer => !receipt.image.rootfsLayers.includes(layer)).length : null;
    receipt.reproducibility = { lockedImageId: lock.image?.pin, rebuiltImageId: imageId, identicalImageId: lock.image?.pin === imageId, layerPinRecorded: Array.isArray(lockedLayers), layersIdentical, differingLayers: differing, labelsIdentical: true, inImageBytesIdentical: true };
    console.log(`locked image ${lock.image?.pin}\nrebuilt image ${imageId}\nlabels and /opt/p2o bytes identical: yes; layer content identical: ${layersIdentical ? 'yes' : `no (${differing} of ${Array.isArray(lockedLayers) ? lockedLayers.length : 0} locked layers are absent from the rebuild)`}`);
    if (!layersIdentical) fail('Rebuild is NOT byte-reproducible against image.rootfsLayers: the docker exporter rewrites layer mtimes, so every rebuild yields new content addresses. `--check` refuses to call that content equivalence; re-run without --check to re-qualify and record a new pin, or use `--verify` for a no-rebuild check');
  }
  if (!checkOnly && lock && lock.image?.pin !== imageId) console.log(`re-qualified: previous pack pin ${lock.image?.pin} -> new pin ${imageId}`);
  if (!checkOnly) {
    await writeFile(lockPath, `${JSON.stringify({
      lockVersion: 2, packVersion: '1.0.0', nodeVersion: 'v22.14.0', engineVersion: clientVersion,
      base: { ...receipt.base, nodeBinarySha256: receipt.base.nodeBinarySha256 },
      compiler: receipt.compiler,
      sources: { ...receipt.sources },
      image: { pin: imageId, tag: receipt.image.tag, platform: `${image.Os}/${image.Architecture}`, rootfsLayers: receipt.image.rootfsLayers, labels: expectedLabels, inImage: { worker: inImage['/opt/p2o/offline-worker.mjs'], source: inImage['/opt/p2o/tools/source.js'] } },
      verifiedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    console.log(`wrote ${lockPath}`);
  }
  if (printJson) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`\nOK ${checkOnly ? 'check' : 'prepare'}: pack ${receipt.image.pin}\n`);
}

main().catch(error => { process.stderr.write(`\nFAIL: ${error.message}\n`); process.exitCode = 1; });
