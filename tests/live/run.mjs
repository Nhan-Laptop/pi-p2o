#!/usr/bin/env node
// Offline live-lab job: compile this owned slice with the already provisioned toolchain, run the node:test
// suite (loopback lab target, owner document, leak audit, pinned extension identity) and remove the private
// build. Nothing is installed and no model, provider, container or credential is contacted.
//
//   node tests/live/run.mjs                 # offline checks only (no live path)
//   node tests/live/run.mjs --require-live  # additionally run examples/live-lab/run.mjs --require-live
//
// The private build is assembled here (source copy + provisioned node_modules link) because the live-lab
// slice owns its own test tree; nothing outside this directory is modified.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilerPath, nodeTypeRoots, repoRoot } from '../end-to-end/compile.mjs';

const requireLive = process.argv.includes('--require-live');

async function compileLiveSlice() {
  const build = await mkdtemp(join(tmpdir(), 'p2o-live-'));
  const source = join(build, 'source');
  const out = join(build, 'out');
  await mkdir(source, { recursive: true });
  for (const directory of ['src', 'examples', 'tests/live']) {
    if (!existsSync(join(repoRoot, directory))) continue;
    await cp(join(repoRoot, directory), join(source, directory), { recursive: true });
  }
  const provisionedModules = join(repoRoot, 'node_modules');
  if (existsSync(provisionedModules) && !existsSync(join(source, 'node_modules'))) await symlink(provisionedModules, join(source, 'node_modules'), 'dir');
  const files = ['tests/live/live-lab.test.ts', 'src/runtime/guardian.ts', 'src/runtime/pi-receipts.ts'].map(entry => join(source, entry));
  for (const file of files) if (!existsSync(file)) throw new Error(`Missing compile entry ${file}`);
  const compile = spawnSync(compilerPath(), [
    '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'bundler',
    '--strict', '--noUnusedLocals', '--noUnusedParameters', '--skipLibCheck',
    '--types', 'node', '--typeRoots', nodeTypeRoots(),
    '--rootDir', source, '--outDir', out, ...files,
  ], { cwd: source, stdio: 'inherit', shell: false });
  if (compile.status !== 0) {
    await rm(build, { recursive: true, force: true });
    throw new Error(`Compilation failed with exit ${compile.status}`);
  }
  await writeFile(join(out, 'package.json'), '{"type":"module"}\n');
  return { build, out, cleanup: async () => { await rm(build, { recursive: true, force: true }); } };
}

const build = await compileLiveSlice();
try {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', join(build.out, 'tests/live/live-lab.test.js')], {
    cwd: build.out,
    stdio: 'inherit',
    timeout: 600_000,
    env: {
      ...process.env,
      P2O_REPO_ROOT: repoRoot,
      P2O_EXAMPLE_SOURCE: join(repoRoot, 'examples', 'live-lab'),
    },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await build.cleanup();
}

if (process.exitCode === 0 && requireLive) {
  const runner = join(repoRoot, 'examples', 'live-lab', 'run.mjs');
  if (!existsSync(runner)) {
    process.stderr.write(`FAIL (--require-live): live runner missing at ${runner}\n`);
    process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath, [runner, '--require-live'], { cwd: repoRoot, stdio: 'inherit', timeout: 3_600_000, env: { ...process.env } });
    process.exitCode = result.status ?? 1;
  }
}
