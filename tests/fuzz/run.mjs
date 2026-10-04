#!/usr/bin/env node
// B3 fuzz-pack tests: compile the owned slice (policy + tools + fuzz tests) with the already
// provisioned toolchain, copy the local module fixtures (the pack imports them from a trusted input
// snapshot at runtime), run the node:test suite, and remove the private build. Nothing is installed
// and no repository file is written.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const build = await mkdtemp(join(tmpdir(), 'p2o-fuzz-test-'));
try {
  const directories = ['src/policy', 'src/tools', 'tests/policy', 'tests/fuzz'];
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
    await mkdir(join(build, 'tests/fuzz'), { recursive: true });
    await cp(join(repo, 'tests/fuzz/fixtures'), join(build, 'tests/fuzz/fixtures'), { recursive: true });
    const tests = (await readdir(join(build, 'tests/fuzz'))).filter(name => name.endsWith('.node.js')).sort()
      .map(name => join(build, 'tests/fuzz', name));
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
      cwd: build, stdio: 'inherit', shell: false, timeout: 300_000,
    });
    process.exitCode = result.status === 0 ? 0 : 1;
  }
} finally {
  await rm(build, { recursive: true, force: true });
}
