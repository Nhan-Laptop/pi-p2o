#!/usr/bin/env node
// Compile/test only this owned slice with already provisioned dependencies. No installation.
// Required check: missing tooling, compile failure, test failure or jiti-probe failure all exit
// nonzero. Tooling resolves through explicit P2O_* overrides, repository-local packages, the
// `npm root -g` prefix and the Pi PATH install; no user-specific absolute paths.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkPiDependencies, resolveTooling } from './provisioning.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fail = message => { console.error(`INTERFACE-TESTS: FAIL — ${message}`); process.exitCode = 1; };
const build = await mkdtemp(join(tmpdir(), 'p2o-interface-test-'));
try {
  const { pi, compiler, typeRoots, globalRoot } = resolveTooling(repo);
  const dependencies = join(build, 'node_modules');
  await mkdir(join(dependencies, '@earendil-works'), { recursive: true });
  await linkPiDependencies(pi, dependencies, globalRoot);
  const source = join(build, 'source');
  await cp(join(repo, 'src'), join(source, 'src'), { recursive: true }); // Read-only snapshot of concurrent dependencies.
  await cp(join(repo, 'extensions/p2o'), join(source, 'extensions/p2o'), { recursive: true });
  await cp(join(repo, 'tests/interface'), join(source, 'tests/interface'), { recursive: true });
  // Packaged-layout parity: the shipped default composition resolves its pinned container pack from the
  // package root. The fixture must carry the same directory so the default backend is exercised as installed
  // rather than failing at module load on a fixture-only omission.
  await cp(join(repo, 'containers'), join(source, 'containers'), { recursive: true });
  // The compiled slice runs from <build>/out/src/**, so its package root is <build>; keep the same pack
  // layout there too (the default composition resolves the pack relative to the loaded module).
  await cp(join(repo, 'containers'), join(build, 'containers'), { recursive: true });
  const directories = ['extensions/p2o', 'src/interface', 'tests/interface'];
  const files = [];
  for (const dir of directories) for (const name of (await readdir(join(source, dir))).sort()) {
    // integration.scenario.ts belongs to the separate seam smoke test (integration.mjs).
    if (name.endsWith('.ts') && !name.startsWith('integration.')) files.push(join(source, dir, name));
  }
  const output = join(build, 'out');
  const compile = spawnSync(compiler, ['--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'bundler', '--strict', '--noUnusedLocals', '--noUnusedParameters',
    '--skipLibCheck', '--types', 'node', '--typeRoots', typeRoots, '--rootDir', source, '--outDir', output, ...files], { cwd: source, stdio: 'inherit', shell: false });
  if (compile.status !== 0) fail('strict compilation of the interface slice did not succeed.');
  else {
    await writeFile(join(build, 'package.json'), '{"type":"module"}\n');
    const tests = (await readdir(join(output, 'tests/interface'))).filter(n => n.endsWith('.node.js')).sort().map(n => join(output, 'tests/interface', n));
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: output, stdio: 'inherit', shell: false });
    process.exitCode = result.status === 0 ? 0 : 1;
    // Real-loader check: Pi loads extensions through jiti, so the TS entry point is probed with it.
    const jiti = spawnSync(process.execPath, [join(repo, 'tests/interface/jiti-smoke.mjs'), source, pi], { cwd: repo, stdio: 'inherit', shell: false });
    if (jiti.status !== 0) process.exitCode = 1;
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally { await rm(build, { recursive: true, force: true }); }
