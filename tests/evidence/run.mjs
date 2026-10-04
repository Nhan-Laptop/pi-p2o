#!/usr/bin/env node
// Standalone owned-scope runner: no installation, root-package edits, external targets, or worker execution.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const build = await mkdtemp(join(tmpdir(), 'p2o-evidence-report-build-'));
try {
  const files = [join(repo, 'tests/contracts/fixtures.ts')];
  for (const dir of ['src/contracts', 'src/policy', 'src/store', 'src/tools', 'src/evidence', 'src/reporting', 'tests/evidence', 'tests/reporting']) {
    for (const file of (await readdir(join(repo, dir))).sort()) if (file.endsWith('.ts')) files.push(join(repo, dir, file));
  }
  // Integration surface: the real supervisor plus its inert test fixtures (read-only dependency for the bridge tests).
  for (const file of (await readdir(join(repo, 'src/orchestrator'))).sort()) if (file.endsWith('.ts')) files.push(join(repo, 'src/orchestrator', file));
  for (const file of ['tests/orchestrator/fixtures.ts', 'tests/orchestrator/fake-runtime.ts']) files.push(join(repo, file));
  const localCompiler = join(repo, 'node_modules/typescript/bin/tsc');
  const compiler = process.env.P2O_TSC ?? (existsSync(localCompiler) ? localCompiler : '/usr/bin/tsc');
  const typeRoots = process.env.P2O_NODE_TYPE_ROOT ?? [join(repo, 'node_modules/@types'), '/usr/share/nodejs/@types', join(repo, '../pi-ctf-solver/node_modules/@types')].find(p => existsSync(join(p, 'node')));
  if (!typeRoots || !existsSync(compiler)) throw new Error('Provisioned TypeScript/Node types unavailable; no auto-installation');
  const compiled = spawnSync(compiler, ['--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler', '--strict', '--noUnusedLocals', '--noUnusedParameters', '--skipLibCheck',
    '--types', 'node', '--typeRoots', typeRoots, '--rootDir', repo, '--outDir', build, ...files], { cwd: repo, stdio: 'inherit', shell: false });
  if (compiled.status !== 0) process.exitCode = 1;
  else {
    await writeFile(join(build, 'package.json'), '{"type":"module"}\n');
    const tests = [];
    for (const dir of ['tests/evidence', 'tests/reporting']) for (const name of (await readdir(join(build, dir))).sort()) if (name.endsWith('.node.js')) tests.push(join(build, dir, name));
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: build, stdio: 'inherit', shell: false });
    process.exitCode = result.status === 0 ? 0 : 1;
  }
} finally { await rm(build, { recursive: true, force: true }); }
