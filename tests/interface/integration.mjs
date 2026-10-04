#!/usr/bin/env node
// REQUIRED seam smoke test for the p2o interface slice (npm run test:integration).
//
// Scope: proves the interface ↔ real `src/orchestrator` supervisor wiring with inert fixtures:
// admission, launch, status, events, resume guards, report port and verified stop. It admits
// ZERO tasks by design and is NOT an end-to-end assessment; the full fixture workflow is owned
// by the application slice. There is no SKIP or BLOCKED success path: a missing orchestrator,
// missing provisioned tooling, a compile failure or a scenario failure all exit nonzero.
// Never installs anything.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkPiDependencies, resolveTooling } from './provisioning.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fail = message => { console.error(`INTEGRATION: FAIL — ${message}`); process.exitCode = 1; };

if (!existsSync(join(repo, 'src/orchestrator/index.ts'))) {
  fail('src/orchestrator/index.ts (createSupervisor) is required for this seam smoke test; it is not an optional dependency.');
  process.exit(1);
}

const build = await mkdtemp(join(tmpdir(), 'p2o-interface-integration-'));
const source = join(build, 'source');
const output = join(build, 'out');
try {
  const { pi, compiler, typeRoots, globalRoot } = resolveTooling(repo);
  const dependencies = join(build, 'node_modules');
  await mkdir(join(dependencies, '@earendil-works'), { recursive: true });
  await linkPiDependencies(pi, dependencies, globalRoot);
  await cp(join(repo, 'src'), join(source, 'src'), { recursive: true });
  await cp(join(repo, 'extensions/p2o'), join(source, 'extensions/p2o'), { recursive: true });
  await mkdir(join(source, 'tests/interface'), { recursive: true });
  for (const name of ['helpers.ts', 'integration.scenario.ts']) await cp(join(repo, 'tests/interface', name), join(source, 'tests/interface', name));

  // Compile only the scenario's import graph. Unrelated in-flight modules owned by other slices
  // must not block this seam check; anything the scenario actually reaches is strict and required.
  const files = [join(source, 'tests/interface/integration.scenario.ts')];
  const compile = spawnSync(compiler, ['--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'bundler', '--strict',
    '--skipLibCheck', '--types', 'node', '--typeRoots', typeRoots, '--rootDir', source, '--outDir', output, ...files], { cwd: source, stdio: 'pipe', shell: false, encoding: 'utf8' });
  if (compile.status !== 0) {
    fail('TypeScript compilation of the scenario import graph did not succeed.');
    console.error(`${compile.stdout ?? ''}${compile.stderr ?? ''}`.split('\n').slice(0, 40).join('\n'));
    process.exitCode = 1;
  } else {
    await writeFile(join(output, 'package.json'), '{"type":"module"}\n');
    const run = spawnSync(process.execPath, [join(output, 'tests/interface/integration.scenario.js')], { cwd: output, stdio: 'inherit', shell: false });
    if (run.status !== 0) fail('the interface/seam scenario did not pass.');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await rm(build, { recursive: true, force: true });
}
