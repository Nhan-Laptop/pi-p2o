#!/usr/bin/env node
// [F3/F4] Offline integration job: compile the owned slice with the already provisioned toolchain, run the
// application-level pack wiring suite against real loopback fixtures and the pinned host Chrome, and remove the
// private build. Nothing is installed, no repository file is written, and no model/provider/credential is used.
//
//   node tests/integration-packs/run.mjs            # full suite
//   node tests/integration-packs/run.mjs --keep     # keep the private build for inspection
//
// The runner needs the host Chrome for the host-browser case; without it that single case skips with an explicit
// message (the rest of the suite still runs and still has to pass).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilerPath, nodeTypeRoots, repoRoot } from '../end-to-end/compile.mjs';

const keep = process.argv.includes('--keep');
const build = await mkdtemp(join(tmpdir(), 'p2o-integration-packs-'));
const source = join(build, 'source');
const out = join(build, 'out');
try {
  await mkdir(source, { recursive: true });
  for (const directory of ['src', 'examples', 'tests/integration-packs', 'tests/fuzz']) {
    if (!existsSync(join(repoRoot, directory))) continue;
    await cp(join(repoRoot, directory), join(source, directory), { recursive: true });
  }
  const provisionedModules = join(repoRoot, 'node_modules');
  if (existsSync(provisionedModules) && !existsSync(join(source, 'node_modules'))) await symlink(provisionedModules, join(source, 'node_modules'), 'dir');
  // Standalone runtime entry points are spawned by path and are not imported by the composition.
  const implicit = ['src/runtime/guardian.ts', 'src/runtime/pi-receipts.ts'].filter(entry => existsSync(join(source, entry)));
  const files = ['tests/integration-packs/integration-packs.test.ts', ...implicit].map(entry => join(source, entry));
  for (const file of files) if (!existsSync(file)) throw new Error(`Missing compile entry ${file}`);
  const compile = spawnSync(compilerPath(), [
    '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'bundler',
    '--strict', '--noUnusedLocals', '--noUnusedParameters', '--skipLibCheck',
    '--types', 'node', '--typeRoots', nodeTypeRoots(),
    '--rootDir', source, '--outDir', out, ...files,
  ], { cwd: source, stdio: 'inherit', shell: false });
  if (compile.status !== 0) {
    process.exitCode = compile.status ?? 1;
  } else {
    await writeFile(join(out, 'package.json'), '{"type":"module"}\n');
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', join(out, 'tests/integration-packs/integration-packs.test.js')], {
      cwd: out,
      stdio: 'inherit',
      timeout: 1_800_000,
      env: { ...process.env, P2O_REPO_ROOT: repoRoot, P2O_EXAMPLE_SOURCE: join(repoRoot, 'examples', 'local-assessment') },
    });
    process.exitCode = result.status ?? 1;
  }
} finally {
  if (keep) process.stdout.write(`integration-packs build kept at ${build}\n`);
  else await rm(build, { recursive: true, force: true });
}
