/**
 * Worker-binary precedence, dist resolution order and the named fail-closed refusal for an incomplete
 * bundled runtime. Pure filesystem fixtures: no Pi process, no model call, no install, no target request.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUNDLED_RUNTIME_MISSING, PI_BINARY_OVERRIDE_ENV, RUNTIME_DIST_OVERRIDE_ENV,
  assertBundledRuntimeReady, discoverPackageRoot, inspectBundledRuntime, resolveRuntimeDist, resolveWorkerPiBinary,
} from '../../src/application/onboarding/runtime-prerequisites.js';
import { builtDistFixture, executableFile, installedLayoutFixture, repoRoot, removeScratch, scratchDirectory } from './fixture.js';

const scratch: string[] = [];
afterEach(() => { for (const directory of scratch.splice(0)) removeScratch(directory); });
function scratchRoot(prefix?: string): string { const directory = scratchDirectory(prefix); scratch.push(directory); return directory; }

describe('worker pi binary precedence', () => {
  it('tier 1: an explicit owner override wins over package-local and PATH binaries', () => {
    const root = scratchRoot();
    const override = executableFile(join(root, 'owner-override/pi-custom'));
    executableFile(join(root, 'node_modules/.bin/pi'));
    const hostBin = scratchRoot();
    executableFile(join(hostBin, 'pi'));
    const resolved = resolveWorkerPiBinary(root, { [PI_BINARY_OVERRIDE_ENV]: override, PATH: hostBin });
    expect(resolved.invalidOverride).toBeUndefined();
    expect(resolved.resolved).toEqual({ piBinary: realpathSync(override), source: 'override' });
  });

  it('tier 2: the package-local devDependency is used when no override is set, even with a host pi on PATH', () => {
    const root = scratchRoot();
    const local = executableFile(join(root, 'node_modules/.bin/pi'));
    const hostBin = scratchRoot();
    executableFile(join(hostBin, 'pi'));
    const resolved = resolveWorkerPiBinary(root, { PATH: hostBin });
    expect(resolved.resolved).toEqual({ piBinary: realpathSync(local), source: 'package-local' });
  });

  it('tier 3: host `pi` is resolved from PATH without a shell', () => {
    const root = scratchRoot();
    const hostBin = scratchRoot();
    const hostPi = executableFile(join(hostBin, 'pi'));
    const resolved = resolveWorkerPiBinary(root, { PATH: `/nonexistent-empty:${hostBin}` });
    expect(resolved.resolved).toEqual({ piBinary: realpathSync(hostPi), source: 'host-path' });
  });

  it('fails closed when no tier resolves, naming the unresolvable binary', () => {
    const root = scratchRoot();
    const emptyPath = scratchRoot();
    expect(resolveWorkerPiBinary(root, { PATH: emptyPath }).resolved).toBeUndefined();
    expect(resolveWorkerPiBinary(root, { PATH: '' }).resolved).toBeUndefined();
  });

  it('a set-but-unusable owner override is refused instead of silently falling through to another binary', () => {
    const root = scratchRoot();
    const hostBin = scratchRoot();
    executableFile(join(hostBin, 'pi'));
    const missing = join(root, 'not-there/pi');
    const resolved = resolveWorkerPiBinary(root, { [PI_BINARY_OVERRIDE_ENV]: missing, PATH: hostBin });
    expect(resolved.resolved).toBeUndefined();
    expect(resolved.invalidOverride).toContain(missing);
    expect(resolved.invalidOverride).toContain(PI_BINARY_OVERRIDE_ENV);
  });
});

describe('guardian/receipt dist resolution order', () => {
  it('prefers the package-local dist even when an override dist exists', () => {
    const root = scratchRoot();
    builtDistFixture(join(root, 'dist'));
    builtDistFixture(join(root, 'override-dist'));
    const resolved = resolveRuntimeDist(root, { [RUNTIME_DIST_OVERRIDE_ENV]: join(root, 'override-dist') });
    expect(resolved.resolved?.source).toBe('package-local-dist');
    expect(resolved.resolved?.guardianPath).toBe(join(root, 'dist/src/runtime/guardian.js'));
  });

  it('uses the explicit owner override only when the package-local dist is absent', () => {
    const root = scratchRoot();
    builtDistFixture(join(root, 'shared-built-dist'));
    const resolved = resolveRuntimeDist(root, { [RUNTIME_DIST_OVERRIDE_ENV]: join(root, 'shared-built-dist') });
    expect(resolved.resolved?.source).toBe('override-dist');
    expect(resolved.resolved?.guardianPath).toBe(join(root, 'shared-built-dist/src/runtime/guardian.js'));
    expect(resolved.resolved?.receiptExtensionPath).toBe(join(root, 'shared-built-dist/src/runtime/pi-receipts.js'));
  });

  it('lists the package-local and override paths it tried when neither exists', () => {
    const root = scratchRoot();
    builtDistFixture(join(root, 'empty-override'));
    const resolved = resolveRuntimeDist(root, { [RUNTIME_DIST_OVERRIDE_ENV]: join(root, 'missing-override') });
    expect(resolved.resolved).toBeUndefined();
    expect(resolved.searched).toEqual([
      join(root, 'dist/src/runtime/guardian.js'),
      join(root, 'dist/src/runtime/pi-receipts.js'),
      join(root, 'missing-override/src/runtime/guardian.js'),
      join(root, 'missing-override/src/runtime/pi-receipts.js'),
    ]);
  });
});

describe('bundled runtime inspection', () => {
  it('finds the package root from both the source and the compiled module layout', () => {
    const root = scratchRoot();
    mkdirSync(join(root, 'containers'), { recursive: true });
    writeFileSync(join(root, 'containers/pack.lock.json'), '{}');
    expect(discoverPackageRoot(join(root, 'src/application/onboarding/runtime-prerequisites.ts'))).toBe(root);
    expect(discoverPackageRoot(join(root, 'dist/src/application/onboarding/runtime-prerequisites.js'))).toBe(root);
    const isolated = scratchRoot();
    expect(discoverPackageRoot(join(isolated, 'unrelated/deep/module.js'))).toBeUndefined();
    expect(discoverPackageRoot(join(repoRoot, 'src/application/onboarding/runtime-prerequisites.ts'))).toBe(repoRoot);
  });

  it('reports an incomplete install with every missing path and the named code, never an ENOENT', () => {
    const fixture = installedLayoutFixture();
    scratch.push(fixture);
    const hostBin = scratchRoot();
    executableFile(join(hostBin, 'pi'));
    expect(existsSync(join(fixture, 'dist'))).toBe(false);
    expect(existsSync(join(fixture, 'node_modules'))).toBe(false);
    const inspected = inspectBundledRuntime({ packageRoot: fixture, env: { PATH: hostBin } });
    expect(inspected.ok).toBe(false);
    if (inspected.ok) throw new Error('expected the git-install layout to fail closed');
    expect(inspected.code).toBe(BUNDLED_RUNTIME_MISSING);
    expect(inspected.missing).toEqual([
      join(fixture, 'dist/src/runtime/guardian.js'),
      join(fixture, 'dist/src/runtime/pi-receipts.js'),
    ]);
    expect(inspected.message).toMatch(/missing:/);
    expect(inspected.message).toMatch(/npm install --include=dev/);
    expect(inspected.message).toMatch(/npm run build/);
    expect(inspected.message).toMatch(new RegExp(RUNTIME_DIST_OVERRIDE_ENV));
    expect(inspected.message).not.toMatch(/ENOENT/);
    expect(() => assertBundledRuntimeReady({ packageRoot: fixture, env: { PATH: hostBin } }))
      .toThrowError(expect.objectContaining({ code: BUNDLED_RUNTIME_MISSING }));
  });

  it('resolves a complete layout (host pi fallback + package-local dist) into absolute plan paths', () => {
    const fixture = installedLayoutFixture();
    scratch.push(fixture);
    builtDistFixture(join(fixture, 'dist'));
    const hostBin = scratchRoot();
    const hostPi = executableFile(join(hostBin, 'pi'));
    const inspected = inspectBundledRuntime({ packageRoot: fixture, env: { PATH: hostBin } });
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error(inspected.message);
    expect(inspected.plan.packageRoot).toBe(fixture);
    expect(inspected.plan.piBinary).toBe(realpathSync(hostPi));
    expect(inspected.plan.piBinarySource).toBe('host-path');
    expect(inspected.plan.guardianPath).toBe(join(fixture, 'dist/src/runtime/guardian.js'));
    expect(inspected.plan.receiptExtensionPath).toBe(join(fixture, 'dist/src/runtime/pi-receipts.js'));
    expect(inspected.plan.guardianPathSource).toBe('package-local-dist');
    expect(inspected.plan.containerLockPath).toBe(join(fixture, 'containers/pack.lock.json'));
    expect(inspected.plan.seccompPath).toBe(join(fixture, 'containers/seccomp.json'));
    expect(inspected.plan.bridgeExtensionPath).toBe(realpathSync(join(fixture, 'examples/local-assessment/bridge-extension.js')));
  });

  it('lists shipped files, dist paths and the worker binary together when all of them are missing', () => {
    const fixture = installedLayoutFixture();
    scratch.push(fixture);
    rmSync(join(fixture, 'containers/seccomp.json'));
    rmSync(join(fixture, 'examples/local-assessment/bridge-extension.js'));
    const inspected = inspectBundledRuntime({ packageRoot: fixture, env: {} });
    expect(inspected.ok).toBe(false);
    if (inspected.ok) throw new Error('expected failure');
    expect(inspected.missing).toContain(join(fixture, 'containers/seccomp.json'));
    expect(inspected.missing).toContain(join(fixture, 'examples/local-assessment/bridge-extension.js'));
    expect(inspected.missing).toContain(join(fixture, 'dist/src/runtime/guardian.js'));
    expect(inspected.missing).toContain(join(fixture, 'dist/src/runtime/pi-receipts.js'));
    expect(inspected.missing.some(entry => entry.includes(join(fixture, 'node_modules/.bin/pi')))).toBe(true);
    expect(inspected.missing).toHaveLength(5);
    expect(inspected.message).not.toMatch(/ENOENT/);
  });

  it('names a non-executable explicit override and every missing runtime path together', () => {
    const fixture = installedLayoutFixture();
    scratch.push(fixture);
    const inspected = inspectBundledRuntime({ packageRoot: fixture, env: { [PI_BINARY_OVERRIDE_ENV]: join(fixture, 'nope/pi') } });
    expect(inspected.ok).toBe(false);
    if (inspected.ok) throw new Error('expected failure');
    expect(inspected.missing).toContain(`${PI_BINARY_OVERRIDE_ENV}=${join(fixture, 'nope/pi')} (not an executable absolute file)`);
    expect(inspected.missing).toContain(join(fixture, 'dist/src/runtime/guardian.js'));
    expect(inspected.missing).toContain(join(fixture, 'dist/src/runtime/pi-receipts.js'));
  });
});
