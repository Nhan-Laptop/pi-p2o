#!/usr/bin/env node
// Standalone owned-scope test runner: no installation, root-package edits, or external targets.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const build = await mkdtemp(join(tmpdir(), 'p2o-policy-tools-build-'));
try {
  const directories = ['src/policy', 'src/tools', 'tests/policy', 'tests/tools'];
  const files = [];
  for (const dir of directories) for (const file of (await readdir(join(repo, dir))).sort()) if (file.endsWith('.ts')) files.push(join(repo, dir, file));
  const localCompiler = join(repo, 'node_modules/typescript/bin/tsc');
  const compiler = process.env.P2O_TSC ?? (existsSync(localCompiler) ? localCompiler : '/usr/bin/tsc');
  const typeRoots = process.env.P2O_NODE_TYPE_ROOT ?? [join(repo, 'node_modules/@types'), '/usr/share/nodejs/@types', join(repo, '../pi-ctf-solver/node_modules/@types')].find(p => existsSync(join(p, 'node')));
  if (!typeRoots || !existsSync(compiler)) throw new Error('Provisioned TypeScript/Node types unavailable; no auto-installation');
  const compiled = spawnSync(compiler, ['--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck', '--esModuleInterop', '--types', 'node', '--typeRoots', typeRoots, '--rootDir', repo, '--outDir', build, ...files], { cwd: repo, stdio: 'inherit', shell: false });
  if (compiled.status !== 0) { process.exitCode = 1; }
  else {
    await writeFile(join(build, 'package.json'), '{"type":"module"}\n');
    await mkdir(join(build, 'containers'));
    for (const name of ['offline-worker.mjs', 'seccomp.json']) await cp(join(repo, 'containers', name), join(build, 'containers', name));
    const tests = [];
    for (const dir of ['tests/policy', 'tests/tools']) for (const name of (await readdir(join(build, dir))).sort()) if (name.endsWith('.node.js')) tests.push(join(build, dir, name));
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: build, stdio: 'inherit', shell: false });
    process.exitCode = result.status === 0 ? 0 : 1;
  }
} finally { await rm(build, { recursive: true, force: true }); }
