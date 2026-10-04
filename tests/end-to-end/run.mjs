#!/usr/bin/env node
// Offline end-to-end job: compile this owned slice with the already provisioned toolchain, run the node:test
// suite (which itself runs the loopback fixture) and remove the private build. Nothing is installed.
import { chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { compileSlice, repoRoot } from './compile.mjs';

const build = await compileSlice({ entries: ['tests/end-to-end/end-to-end.test.ts'], label: 'p2o-end-to-end' });
try {
  const worker = join(repoRoot, 'examples/local-assessment/inert-worker.mjs');
  if (existsSync(worker)) chmodSync(worker, 0o700);
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', join(build.out, 'tests/end-to-end/end-to-end.test.js')], {
    cwd: build.out,
    stdio: 'inherit',
    timeout: 600_000,
    env: { ...process.env, P2O_EXAMPLE_SOURCE: join(repoRoot, 'examples/local-assessment') },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await build.cleanup();
}
