#!/usr/bin/env node
// Offline real-Pi worker job: verify the pinned worker CLI by version AND content hash, compile this owned
// slice with the already provisioned toolchain, run the node:test suite (which itself starts the loopback
// fixture, the inert gateway and a real pinned `pi` worker process), and remove the private build. Nothing
// is installed and no provider is contacted.
//
// Usage:
//   node tests/real-worker/run.mjs                     # honest SKIP when the pinned pi binary is not provisioned
//   node tests/real-worker/run.mjs --require-real-pi    # strict: a missing pinned pi binary fails the job
//   node tests/real-worker/run.mjs --herdr              # additionally run the opt-in real-Herdr sanity job
//                                                       (needs a live local Herdr caller/socket context)
import { chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { compileSlice, repoRoot } from '../end-to-end/compile.mjs';
import { PI_PACKAGE, verifyPiCli } from './pi-pin.mjs';

const requireRealPi = process.argv.includes('--require-real-pi');
const withHerdr = process.argv.includes('--herdr');
const piBinary = join(repoRoot, 'node_modules', '.bin', 'pi');
if (!existsSync(piBinary)) {
  const reason = `the real-Pi harness needs the project-pinned worker binary at ${piBinary}; provision dev dependencies (npm ci) — this runner installs nothing`;
  if (requireRealPi) {
    process.stderr.write(`FAIL (--require-real-pi): ${reason}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`SKIP: ${reason}\n`);
    process.exitCode = 0;
  }
} else {
  // [T8/S3] A present-but-wrong worker is never an honest SKIP: verify the resolved package's own bin.pi,
  // its version and the exact CLI content hash before anything is compiled or launched.
  let pin;
  try {
    pin = verifyPiCli(piBinary);
    process.stdout.write(`worker pin package=${PI_PACKAGE} version=${pin.version} cli=${pin.cliPath} sha256=${pin.sha256}\n`);
  } catch (error) {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
  if (pin) {
    const entries = ['tests/real-worker/real-worker.test.ts', 'tests/real-worker/spend-gate.test.ts'];
    if (withHerdr) entries.push('tests/real-worker/herdr-sanity.ts');
    const build = await compileSlice({ entries, label: 'p2o-real-worker' });
    try {
      const worker = join(repoRoot, 'examples/local-assessment/inert-worker.mjs');
      if (existsSync(worker)) chmodSync(worker, 0o700);
      const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', join(build.out, 'tests/real-worker/real-worker.test.js'), join(build.out, 'tests/real-worker/spend-gate.test.js')], {
        cwd: build.out,
        stdio: 'inherit',
        timeout: 600_000,
        env: {
          ...process.env,
          PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
          P2O_REPO_ROOT: repoRoot,
          P2O_REAL_WORKER_SOURCE: join(repoRoot, 'tests/real-worker'),
        },
      });
      process.exitCode = result.status ?? 1;
      if (withHerdr && process.exitCode === 0) {
        // Opt-in real-Herdr sanity: the runtime's real herdr adapter, one worker, loopback providers only.
        const herdr = spawnSync(process.execPath, [join(build.out, 'tests/real-worker/herdr-sanity.js')], {
          cwd: build.out,
          stdio: 'inherit',
          timeout: 600_000,
          env: {
            ...process.env,
            PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
            P2O_REPO_ROOT: repoRoot,
            P2O_REAL_WORKER_SOURCE: join(repoRoot, 'tests/real-worker'),
          },
        });
        process.exitCode = herdr.status ?? 1;
      }
    } finally {
      await build.cleanup();
    }
  }
}
