#!/usr/bin/env node
// Compile and run only the orchestrator slice with already provisioned dependencies. No installation,
// no package edits, no target traffic and no live agent launches.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const build = await mkdtemp(join(tmpdir(), 'p2o-orchestrator-test-'));
try {
  const compiler = process.env.P2O_TSC ?? [
    join(repo, 'node_modules/typescript/bin/tsc'),
    join(repo, '../pi-ctf-solver/node_modules/typescript/bin/tsc'),
  ].find(existsSync);
  const typeRoots = process.env.P2O_NODE_TYPE_ROOT ?? [
    join(repo, 'node_modules/@types'),
    join(repo, '../pi-ctf-solver/node_modules/@types'),
  ].find(existsSync);
  if (!compiler || !typeRoots) throw new Error('Missing provisioned TypeScript compiler or Node types; no auto-installation');

  const source = join(build, 'source');
  await cp(join(repo, 'src'), join(source, 'src'), { recursive: true });
  await cp(join(repo, 'tests/orchestrator'), join(source, 'tests/orchestrator'), { recursive: true });

  const files = [];
  for (const dir of ['src/orchestrator', 'tests/orchestrator']) {
    for (const name of (await readdir(join(source, dir))).sort()) if (name.endsWith('.ts')) files.push(join(source, dir, name));
  }
  const output = join(build, 'out');
  const compile = spawnSync(compiler, [
    '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'bundler', '--strict',
    '--noUnusedLocals', '--noUnusedParameters', '--skipLibCheck', '--types', 'node',
    '--typeRoots', typeRoots, '--rootDir', source, '--outDir', output, ...files,
  ], { cwd: source, stdio: 'inherit', shell: false });
  if (compile.status !== 0) process.exitCode = 1;
  else {
    await writeFile(join(build, 'package.json'), '{"type":"module"}\n');
    const tests = (await readdir(join(output, 'tests/orchestrator')))
      .filter(name => name.endsWith('.test.js')).sort().map(name => join(output, 'tests/orchestrator', name));
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
      cwd: output, stdio: 'inherit', shell: false,
    });
    process.exitCode = result.status === 0 ? 0 : 1;
  }
} finally {
  await rm(build, { recursive: true, force: true });
}
