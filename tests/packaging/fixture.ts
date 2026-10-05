/**
 * Shared packaging fixtures. A git install of pi-p2o (`pi install git:…`) is a clone plus
 * `npm install --omit=dev --legacy-peer-deps` (Pi 1.0.0 `dist/core/package-manager.js`), so it ships the
 * source tree with neither `dist/` nor `node_modules/`. These helpers reproduce that layout faithfully and
 * are used by the installed-layout and CLI regressions. No install, build, model call or target request.
 */
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Build output, dependencies and local scratch are exactly what a git install does NOT contain. */
const ABSENT_FROM_GIT_INSTALL = new Set(['.git', 'node_modules', 'dist', 'tmp', '.p2o-build', '.vite-cache', 'coverage']);

export function scratchDirectory(prefix = 'p2o-packaging-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Scratch root that also satisfies the owner-storage ancestor rules (root-owned sticky /tmp on POSIX). */
export function privateScratchDirectory(prefix = 'p2o-packaging-private-'): string {
  for (const base of ['/tmp', tmpdir()]) {
    try { return realpathSync(mkdtempSync(join(base, prefix))); } catch { /* next base */ }
  }
  throw new Error(`no writable private scratch directory (tried /tmp and ${tmpdir()})`);
}
export function removeScratch(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

export function executableFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

/** Copy the shipped tree as a git install leaves it: no `dist/`, no `node_modules/`, kept live-run scratch. */
export function installedLayoutFixture(): string {
  const root = scratchDirectory('p2o-installed-');
  cpSync(repoRoot, root, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(repoRoot.length + 1);
      if (relative === '') return true;
      if (relative.startsWith('examples/live-lab/.runs')) return false;
      return !ABSENT_FROM_GIT_INSTALL.has(relative.split('/')[0]!);
    },
  });
  return root;
}

/** A `P2O_RUNTIME_DIST`-shaped built dist root (`<root>/src/runtime/{guardian,pi-receipts}.js`). */
export function builtDistFixture(root: string): string {
  for (const name of ['guardian.js', 'pi-receipts.js']) {
    const file = join(root, 'src/runtime', name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '// packaging fixture: inert dist file, never executed\n');
  }
  return root;
}
