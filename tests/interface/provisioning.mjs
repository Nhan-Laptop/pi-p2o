// Provisioned-tool resolution for the interface runners. No user-specific absolute paths and no
// auto-installation: explicit P2O_* overrides win, then repository-local packages, then the
// `npm root -g` prefix, then the Pi package root resolved from the `pi` executable on PATH.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** npm global prefix root, or undefined when npm is absent/broken. */
export function npmGlobalRoot() {
  try {
    const result = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim()) {
      const root = result.stdout.trim();
      if (existsSync(root)) return root;
    }
  } catch { /* npm is optional; explicit P2O_* overrides remain */ }
  return undefined;
}

/** Pi package root discovered from the `pi` launcher on PATH (never a hardcoded home path). */
export function piFromPath() {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, 'pi');
    if (!existsSync(candidate)) continue;
    let current;
    try { current = dirname(realpathSync(candidate)); } catch { continue; }
    for (let depth = 0; depth < 8; depth++) {
      const manifest = join(current, 'package.json');
      if (existsSync(manifest)) {
        try {
          if (JSON.parse(readFileSync(manifest, 'utf8')).name === '@earendil-works/pi-coding-agent') return current;
        } catch { /* keep walking up */ }
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return undefined;
}

/** Explicit env override wins; otherwise the first usable candidate, else a hard failure. */
export function provisioned(envName, explicit, candidates, usable, label) {
  if (explicit) {
    if (usable(explicit)) return explicit;
    throw new Error(`${envName}=${explicit} is not a usable ${label}`);
  }
  const found = candidates.find(usable);
  if (!found) throw new Error(`no provisioned ${label} found (repository-local, npm global root, Pi PATH install); set ${envName} explicitly. No auto-installation.`);
  return found;
}

export function resolveTooling(repo) {
  const globalRoot = npmGlobalRoot();
  const globalCandidates = (...segments) => globalRoot ? [join(globalRoot, ...segments)] : [];
  const pi = provisioned('P2O_PI_PACKAGE', process.env.P2O_PI_PACKAGE, [
    join(repo, 'node_modules/@earendil-works/pi-coding-agent'),
    ...globalCandidates('@earendil-works', 'pi-coding-agent'),
    ...(piFromPath() ? [piFromPath()] : []),
  ], p => existsSync(join(p, 'package.json')), 'Pi host package (@earendil-works/pi-coding-agent)');
  const compiler = provisioned('P2O_TSC', process.env.P2O_TSC, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    ...globalCandidates('typescript', 'bin', 'tsc'),
  ], existsSync, 'TypeScript compiler');
  const typeRoots = provisioned('P2O_NODE_TYPE_ROOT', process.env.P2O_NODE_TYPE_ROOT, [
    join(repo, 'node_modules/@types'),
    ...globalCandidates('@types'),
  ], p => existsSync(join(p, 'node')), 'Node type roots');
  return { pi, compiler, typeRoots, globalRoot };
}

/**
 * Links the Pi host and its runtime dependencies into a disposable node_modules. Each dependency
 * is taken from the Pi package first, then the npm global root; `typebox` and `pi-ai` are required
 * because the interface TypeScript imports them.
 */
export async function linkPiDependencies(pi, dependencies, globalRoot) {
  const link = async (target, candidates, label, required) => {
    const found = candidates.find(existsSync);
    if (!found) {
      if (required) throw new Error(`no provisioned ${label} found (Pi package and npm global root); no auto-installation`);
      return;
    }
    await symlink(found, target);
  };
  await link(join(dependencies, '@earendil-works/pi-coding-agent'), [pi], 'Pi host package', true);
  const globalCandidates = (...segments) => globalRoot ? [join(globalRoot, ...segments)] : [];
  await link(join(dependencies, '@earendil-works/pi-ai'),
    [join(pi, 'node_modules/@earendil-works/pi-ai'), ...globalCandidates('@earendil-works', 'pi-ai')], 'pi-ai', true);
  for (const name of ['pi-tui', 'pi-agent-core']) {
    await link(join(dependencies, '@earendil-works', name),
      [join(pi, 'node_modules/@earendil-works', name), ...globalCandidates('@earendil-works', name)], name, false);
  }
  await link(join(dependencies, 'typebox'), [join(pi, 'node_modules/typebox'), ...globalCandidates('typebox')], 'typebox', true);
}
