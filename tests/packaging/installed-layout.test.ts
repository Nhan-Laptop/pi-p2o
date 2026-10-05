/**
 * Consent must never be collected on an install that cannot reach prepare(). The fixture is a faithful
 * git-install layout (shipped tree without `dist/` or `node_modules/`); the UI recorder proves zero dialogs
 * are shown, and the contrasting built fixture proves the same call still reaches the normal consent path.
 * Model-inert: no provider, no worker, no target request.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureOwnerOnboarding } from '../../src/application/onboarding/index.js';
import { BUNDLED_RUNTIME_MISSING } from '../../src/application/onboarding/runtime-prerequisites.js';
import { builtDistFixture, executableFile, installedLayoutFixture, privateScratchDirectory, removeScratch, scratchDirectory } from './fixture.js';

const scratch: string[] = [];
afterEach(() => { for (const directory of scratch.splice(0)) removeScratch(directory); });
function scratchRoot(prefix?: string): string { const directory = scratchDirectory(prefix); scratch.push(directory); return directory; }

interface UiRecorder { calls: string[]; confirm(title: string): Promise<boolean> }
function recordingUi(approve: boolean): UiRecorder {
  const calls: string[] = [];
  return { calls, async confirm(): Promise<boolean> { calls.push('confirm'); return approve; } };
}

function onboardingInput(target: string, cwd: string, ui: UiRecorder) {
  return { target: { kind: 'local-dir' as const, raw: target, locator: target }, cwd, hasUI: true, ui: { ...ui, async select() { ui.calls.push('select'); return undefined; }, async input() { ui.calls.push('input'); return undefined; } }, mode: 'quick' as const, profile: 'conservative' as const };
}

describe('installed (git) layout: fail closed before consent', () => {
  it('refuses with BUNDLED_RUNTIME_MISSING naming both dist paths and shows no consent dialog', async () => {
    const fixture = installedLayoutFixture();
    scratch.push(fixture);
    const hostBin = scratchRoot();
    executableFile(join(hostBin, 'pi'));
    const home = scratchRoot();
    const target = join(home, 'target');
    mkdirSync(target, { recursive: true });
    const ui = recordingUi(true);
    const storageRoot = join(home, 'owner-consent');
    const failure = await ensureOwnerOnboarding(
      onboardingInput(target, home, ui),
      { storageRoot, runtime: { packageRoot: fixture, env: { PATH: hostBin } } },
    ).then((result: unknown) => result, (error: unknown) => error);
    expect(failure).toMatchObject({ code: BUNDLED_RUNTIME_MISSING, missing: [
      join(fixture, 'dist/src/runtime/guardian.js'),
      join(fixture, 'dist/src/runtime/pi-receipts.js'),
    ] });
    expect(ui.calls).toEqual([]);
    expect(existsSync(storageRoot)).toBe(false);
    expect(existsSync(join(home, '.p2o'))).toBe(false);
  });

  it('proceeds to the normal consent path once the bundled dist exists', async () => {
    const fixture = installedLayoutFixture();
    scratch.push(fixture);
    builtDistFixture(join(fixture, 'dist'));
    const hostBin = scratchRoot();
    executableFile(join(hostBin, 'pi'));
    const cwd = scratchRoot();
    const target = join(cwd, 'target');
    mkdirSync(target, { recursive: true });
    const storageRoot = privateScratchDirectory();
    scratch.push(storageRoot);
    const ui = recordingUi(false);
    const result = await ensureOwnerOnboarding(
      onboardingInput(target, cwd, ui),
      { storageRoot, runtime: { packageRoot: fixture, env: { PATH: hostBin } } },
    );
    expect(result).toEqual({ status: 'cancelled' });
    expect(ui.calls).toEqual(['confirm']);
  });
});
