#!/usr/bin/env node
// Real headless-browser pack tests: compile the owned slice (policy + tools + browser tests) with the
// already provisioned toolchain, run the node:test suite against local loopback fixtures with the host
// Chrome, and remove the private build. Nothing is installed and no repository file is written.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const build = await mkdtemp(join(tmpdir(), 'p2o-browser-test-'));
try {
  const directories = ['src/policy', 'src/tools', 'tests/policy', 'tests/browser'];
  const files = [];
  for (const dir of directories) for (const name of (await readdir(join(repo, dir))).sort()) if (name.endsWith('.ts')) files.push(join(repo, dir, name));
  const localCompiler = join(repo, 'node_modules/typescript/bin/tsc');
  const compiler = process.env.P2O_TSC ?? (existsSync(localCompiler) ? localCompiler : '/usr/bin/tsc');
  const typeRoots = process.env.P2O_NODE_TYPE_ROOT ?? [
    join(repo, 'node_modules/@types'), '/usr/share/nodejs/@types', join(repo, '../pi-ctf-solver/node_modules/@types'),
  ].find(candidate => existsSync(join(candidate, 'node')));
  if (!typeRoots || !existsSync(compiler)) throw new Error('Provisioned TypeScript/Node types unavailable; no auto-installation');
  const compiled = spawnSync(compiler, [
    '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck',
    '--esModuleInterop', '--types', 'node', '--typeRoots', typeRoots, '--rootDir', repo, '--outDir', build, ...files,
  ], { cwd: repo, stdio: 'inherit', shell: false });
  if (compiled.status !== 0) process.exitCode = 1;
  else {
    await writeFile(join(build, 'package.json'), '{"type":"module"}\n');
    const tests = (await readdir(join(build, 'tests/browser'))).filter(name => name.endsWith('.node.js')).sort()
      .map(name => join(build, 'tests/browser', name));
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
      cwd: build, stdio: 'inherit', shell: false, timeout: 900_000,
    });
    process.exitCode = result.status === 0 ? 0 : 1;
  }
} finally {
  await rm(build, { recursive: true, force: true });
}
