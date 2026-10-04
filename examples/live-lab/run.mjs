#!/usr/bin/env node
// Live-lab runner: verify every live precondition, compile this owned slice with the already provisioned
// toolchain, run the real composition (controller gateway -> real pinned `pi` workers -> brokered tools ->
// evidence vault -> verifier -> report) against the loopback live lab, print the raw evidence, and remove the
// private build. Nothing is installed, no root package file is edited, and no credential is ever printed.
//
//   node examples/live-lab/run.mjs                  # honest SKIP (exit 0) when a live precondition is missing
//   node examples/live-lab/run.mjs --require-live   # a missing precondition is a FAIL (exit 1)
//   node examples/live-lab/run.mjs --keep           # keep the full run directory (evidence) on disk
//
// Exit codes: 0 live run met the acceptance bar (or an honest SKIP without --require-live); 1 preconditions
// unavailable; 2 the live run ran but did not meet the acceptance bar.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSlice, repoRoot } from '../../tests/end-to-end/compile.mjs';

const requireLive = process.argv.includes('--require-live');
const keep = process.argv.includes('--keep');
const provider = 'deepseek';
const skips = [];

function report(ok, detail) {
  process.stdout.write(`[live-check] ${ok ? 'PASS' : 'SKIP'} ${detail}\n`);
}

/** Missing live preconditions are reported one by one; nothing is faked and no fallback is selected. */
function checkDocker() {
  const lock = JSON.parse(readFileSync(join(repoRoot, 'containers', 'pack.lock.json'), 'utf8'));
  const version = spawnSync('/usr/bin/docker', ['version', '--format', '{{.Client.Version}}/{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 });
  if (version.status !== 0) return `docker engine unavailable: ${(version.stderr ?? '').trim().split('\n').slice(-1)[0] ?? 'no engine'}`;
  if ((version.stdout ?? '').trim() !== `${lock.engineVersion}/${lock.engineVersion}`) return `docker engine release ${(version.stdout ?? '').trim()} is not the pinned ${lock.engineVersion}`;
  const image = spawnSync('/usr/bin/docker', ['image', 'inspect', '--format', '{{.Id}}', lock.image.pin], { encoding: 'utf8', timeout: 20_000 });
  if (image.status !== 0 || (image.stdout ?? '').trim() !== lock.image.pin) return 'the pinned offline pack image is not present locally (run containers/prepare.mjs; the runner never pulls)';
  const seccomp = createHash('sha256').update(readFileSync(join(repoRoot, 'containers', 'seccomp.json'))).digest('hex');
  if (seccomp !== lock.sources.seccompSha256) return 'containers/seccomp.json no longer matches the locked pack digest';
  return undefined;
}

async function checkUpstream() {
  return await new Promise(resolveCheck => {
    const socket = connect({ host: 'api.deepseek.com', port: 443 });
    const done = (error) => { socket.destroy(); resolveCheck(error ? `api.deepseek.com:443 unreachable (${error.code ?? error.message})` : undefined); };
    socket.setTimeout(8_000);
    socket.once('connect', () => done());
    socket.once('timeout', () => done(new Error('ETIMEDOUT')));
    socket.once('error', error => done(error));
  });
}

function checkWorker() {
  const binary = join(repoRoot, 'node_modules', '.bin', 'pi');
  if (!existsSync(binary)) return `pinned worker binary missing: ${binary}`;
  const pkg = join(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
  const version = existsSync(pkg) ? JSON.parse(readFileSync(pkg, 'utf8')).version : undefined;
  if (version !== '1.0.0') return `worker package version ${String(version)} is not the pinned 1.0.0`;
  return undefined;
}

async function main() {
  for (const [check, label] of [[checkDocker, 'pinned docker engine + offline pack image + seccomp digest'], [checkWorker, 'pinned pi worker binary 1.0.0']]) {
    const detail = check();
    if (detail) skips.push(detail); else report(true, label);
  }
  const network = await checkUpstream();
  if (network) skips.push(network); else report(true, 'api.deepseek.com:443 reachable');

  const build = await compileSlice({ entries: ['examples/live-lab/main.ts'], label: 'p2o-live-lab' });
  try {
    const main = await import(pathToFileURL(join(build.out, 'examples/live-lab/main.js')).href);
    const credential = main.resolveProviderCredential(join(repoRoot, 'node_modules', '.bin', 'pi'), provider);
    if (!credential.key) skips.push(`provider credential unavailable: ${credential.detail}`);
    else report(true, credential.detail);

    if (skips.length) {
      for (const detail of skips) process.stderr.write(`SKIP (live precondition unavailable): ${detail}\n`);
      if (requireLive) {
        process.stderr.write('FAIL (--require-live): the live vertical slice cannot run here; nothing was faked and no fallback was selected\n');
        process.exitCode = 1;
      } else {
        process.stdout.write('SKIP: live vertical slice not run (honest skip; use --require-live to fail instead)\n');
        process.exitCode = 0;
      }
      return;
    }

    const runId = `live-lab-${Date.now().toString(36)}`;
    const result = await main.runLiveLab({
      apiKey: credential.key,
      repoRoot,
      sourceRoot: join(repoRoot, 'examples', 'live-lab'),
      runId,
      keep,
      ...(keep ? { runRoot: join(repoRoot, 'examples', 'live-lab', '.runs') } : {}),
      log: (message) => process.stdout.write(`${message}\n`),
    });
    process.stdout.write(`\n=== live vertical slice evidence ===\n${main.formatLiveResult(result)}\n`);
    process.exitCode = result.acceptance.ok ? 0 : 2;
    if (!result.acceptance.ok) process.stderr.write(`LIVE RUN DID NOT MEET THE ACCEPTANCE BAR: ${result.acceptance.reasons.join(' | ')}\n`);
  } finally {
    await build.cleanup();
  }
}

await main();
