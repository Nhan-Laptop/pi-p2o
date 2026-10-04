#!/usr/bin/env node
// Compile an owned slice into an owner-private temporary ESM build. Nothing is installed and no root
// package file is edited; the caller removes the build unless it explicitly keeps it.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function provisioned(name, candidates) {
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error(`Missing provisioned ${name}; this runner installs nothing`);
  return found;
}

export function compilerPath() {
  return process.env.P2O_TSC ?? provisioned('TypeScript', [
    join(repoRoot, 'node_modules/typescript/bin/tsc'),
    join(repoRoot, '../pi-ctf-solver/node_modules/typescript/bin/tsc'),
    '/usr/bin/tsc',
  ]);
}

export function nodeTypeRoots() {
  return process.env.P2O_NODE_TYPE_ROOT ?? provisioned('Node types', [
    join(repoRoot, 'node_modules/@types'),
    join(repoRoot, '../pi-ctf-solver/node_modules/@types'),
    '/usr/share/nodejs/@types',
  ]);
}

/**
 * Copy the owned sources into a private build directory and compile the given entry points.
 * Returns the build directory, compiled output directory and a cleanup function.
 */
export async function compileSlice({ entries, label = 'p2o-slice' }) {
  const build = await mkdtemp(join(tmpdir(), `${label}-`));
  const source = join(build, 'source');
  const out = join(build, 'out');
  await mkdir(source, { recursive: true });
  for (const directory of ['src', 'examples', 'tests/end-to-end', 'tests/real-worker']) {
    if (!existsSync(join(repoRoot, directory))) continue;
    await cp(join(repoRoot, directory), join(source, directory), { recursive: true });
  }
  // The private build has no node_modules of its own: link the repository's provisioned one so that the
  // host peer imports (@earendil-works/pi-ai, typebox) resolve during compilation. Nothing is installed.
  const provisionedModules = join(repoRoot, 'node_modules');
  if (existsSync(provisionedModules) && !existsSync(join(source, 'node_modules'))) {
    await symlink(provisionedModules, join(source, 'node_modules'), 'dir');
  }
  // Standalone runtime entry points are spawned by path and are not imported by the composition.
  const implicit = ['src/runtime/guardian.ts', 'src/runtime/pi-receipts.ts'].filter(entry => existsSync(join(source, entry)));
  const files = [...entries, ...implicit].map(entry => join(source, entry));
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
  return {
    build,
    source,
    out,
    async cleanup() { await rm(build, { recursive: true, force: true }); },
  };
}
