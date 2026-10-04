#!/usr/bin/env node
// Runnable local assessment fixture: compile this slice with the already provisioned toolchain and run
// examples/local-assessment/main.ts. Loopback only; no model call, no external target, no installation.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compileSlice, repoRoot } from '../../tests/end-to-end/compile.mjs';

const build = await compileSlice({ entries: ['examples/local-assessment/main.ts'], label: 'p2o-local-assessment' });
try {
  const worker = join(repoRoot, 'examples/local-assessment/inert-worker.mjs');
  if (existsSync(worker)) chmodSync(worker, 0o700);
  const result = spawnSync(process.execPath, [join(build.out, 'examples/local-assessment/main.js'), ...process.argv.slice(2)], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, P2O_EXAMPLE_SOURCE: join(repoRoot, 'examples/local-assessment') },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await build.cleanup();
}
