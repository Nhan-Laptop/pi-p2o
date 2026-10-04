#!/usr/bin/env node
// Live PLANNER demo runner (workstream P2).
//
// Verify every live precondition, compile this owned slice with the already provisioned toolchain, run the
// two-phase planner demo (real planner worker -> p2o_plan propose -> owner batch approval -> p2o_plan approve
// -> plan-materialized workers + owner-approved verifier -> coverage gate -> qualified report), print the raw
// evidence and remove the private build. Nothing is installed, no root package file is edited, and no
// credential is ever printed or written.
//
//   node examples/live-lab/plan.mjs                  # honest SKIP (exit 0) when a live precondition is missing
//   node examples/live-lab/plan.mjs --require-live   # a missing precondition is a FAIL (exit 1)
//   node examples/live-lab/plan.mjs --keep           # keep the full run directory (evidence) on disk
//
// Exit codes: 0 plan run met the acceptance bar (or an honest SKIP without --require-live); 1 preconditions
// unavailable; 2 the plan run ran but did not meet the acceptance bar.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { symlink } from 'node:fs/promises';
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
  const extension = join(repoRoot, 'examples', 'live-lab', 'plan-extension.mjs');
  if (!existsSync(extension)) return `pinned plan extension missing: ${extension}`;
  return undefined;
}

async function main() {
  for (const [check, label] of [[checkDocker, 'pinned docker engine + offline pack image + seccomp digest'], [checkWorker, 'pinned pi worker binary 1.0.0 + plan extension']]) {
    const detail = check();
    if (detail) skips.push(detail); else report(true, label);
  }
  const network = await checkUpstream();
  if (network) skips.push(network); else report(true, 'api.deepseek.com:443 reachable');

  const build = await compileSlice({ entries: ['examples/live-lab/plan-main.ts'], label: 'p2o-live-plan' });
  try {
    // The interface dispatch imports the pi peer packages; link the provisioned modules next to the build output
    // (the private build itself installs nothing).
    await symlink(join(repoRoot, 'node_modules'), join(build.out, 'node_modules'), 'dir');
    const main = await import(pathToFileURL(join(build.out, 'examples/live-lab/plan-main.js')).href);
    const credential = main.resolveProviderCredential(join(repoRoot, 'node_modules', '.bin', 'pi'), provider);
    if (!credential.key) skips.push(`provider credential unavailable: ${credential.detail}`);
    else report(true, credential.detail);

    if (skips.length) {
      for (const detail of skips) process.stderr.write(`SKIP (live precondition unavailable): ${detail}\n`);
      if (requireLive) {
        process.stderr.write('FAIL (--require-live): the live planner demo cannot run here; nothing was faked and no fallback was selected\n');
        process.exitCode = 1;
      } else {
        process.stdout.write('SKIP: live planner demo not run (honest skip; use --require-live to fail instead)\n');
        process.exitCode = 0;
      }
      return;
    }

    const runId = `live-plan-${Date.now().toString(36)}`;
    try {
      const result = await main.runLivePlan({
        apiKey: credential.key,
        repoRoot,
        sourceRoot: join(repoRoot, 'examples', 'live-lab'),
        runId,
        keep,
        ...(keep ? { runRoot: join(repoRoot, 'examples', 'live-lab', '.runs') } : {}),
        log: (message) => process.stdout.write(`${message}\n`),
      });
      process.stdout.write(`\n=== live planner demo evidence ===\n${main.formatPlanResult(result)}\n`);
      process.exitCode = result.acceptance.ok ? 0 : 2;
      if (!result.acceptance.ok) process.stderr.write(`LIVE PLAN RUN DID NOT MEET THE ACCEPTANCE BAR: ${result.acceptance.reasons.join(' | ')}\n`);
    } catch (error) {
      process.stderr.write(`LIVE PLAN RUN FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  } finally {
    await build.cleanup();
  }
}

await main();
