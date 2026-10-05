/**
 * Real `pi` CLI checks: the documented dev invocation loads exactly one extension copy and dispatches `/p2o`,
 * and an installed (git) layout fails closed with BUNDLED_RUNTIME_MISSING instead of a raw ENOENT.
 *
 * No provider is configured in the scratch HOME, no prompt ever reaches a model, and `/p2o` help plus the
 * fail-closed refusal make zero target requests and write zero consent artifacts. If no `pi` binary is
 * available the CLI cases skip with a message; the precedence/layout assertions still run in that case
 * (see `runtime-prerequisites.test.ts` and `installed-layout.test.ts`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolveWorkerPiBinary } from '../../src/application/onboarding/runtime-prerequisites.js';
import { installedLayoutFixture, removeScratch, repoRoot, scratchDirectory } from './fixture.js';

const piBinary = resolveWorkerPiBinary(repoRoot, { PATH: process.env.PATH ?? '' }).resolved?.piBinary;
const cliAvailable = piBinary !== undefined;
const CLI_TIMEOUT_MS = 180_000;

interface CustomMessage { customType?: string; content?: string }
interface CliRun { status: number | null; signal: string | null; stdout: string; stderr: string; error?: string }

function runCli(args: string[], home: string, cwd: string): CliRun {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  for (const key of ['P2O_PI_BINARY', 'P2O_RUNTIME_DIST', 'P2O_APP_CONFIG', 'P2O_CONTROL_MODULE', 'P2O_PLAN_AUTHOR_MODULE', 'PI_MANAGED_INSTALL_ROOT']) delete env[key];
  const result: SpawnSyncReturns<string> = spawnSync(piBinary!, args, { cwd, env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}) };
}

function customMessages(stdout: string): CustomMessage[] {
  const messages: CustomMessage[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try { const event = JSON.parse(line) as { type?: string; message?: CustomMessage }; if (event?.type === 'message_start' && event.message?.customType) messages.push(event.message); }
    catch { /* non-JSON CLI line */ }
  }
  return messages;
}

/** `-ne -e <absolute package>` is the documented single-copy dev/one-shot invocation. */
function devArgs(packagePath: string, prompt: string): string[] {
  return ['--no-extensions', '-e', packagePath, '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--offline', '--no-session', '--no-approve', '--mode', 'json', '-p', prompt];
}

const scratch: string[] = [];
afterEach(() => { for (const directory of scratch.splice(0)) removeScratch(directory); });
function scratchRoot(prefix?: string): string { const directory = scratchDirectory(prefix); scratch.push(directory); return directory; }

describe.runIf(cliAvailable)('real pi CLI (no model call)', () => {
  it('loads one extension copy with --no-extensions -e <abs> and dispatches /p2o without a tool conflict', () => {
    const home = scratchRoot('p2o-cli-home-');
    const run = runCli(devArgs(repoRoot, '/p2o'), home, home);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/conflicts with/);
    expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/ENOENT/);
    const results = customMessages(run.stdout).filter(message => message.customType === 'p2o_result');
    expect(results).toHaveLength(1);
    expect(String(results[0]!.content)).toContain('/p2o --target');
    expect(customMessages(run.stdout).filter(message => message.customType === 'p2o_error')).toEqual([]);
  });

  it('refuses an installed layout with BUNDLED_RUNTIME_MISSING before consent, never an ENOENT', () => {
    const fixture = installedLayoutFixture();
    scratch.push(fixture);
    const home = scratchRoot('p2o-cli-home-');
    const target = join(home, 'target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'index.ts'), 'export const fixture = true;\n');
    expect(existsSync(join(fixture, 'dist'))).toBe(false);
    expect(existsSync(join(fixture, 'node_modules'))).toBe(false);
    const run = runCli(devArgs(fixture, `/p2o --target ${target} --plan-only`), home, home);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    const errors = customMessages(run.stdout).filter(message => message.customType === 'p2o_error');
    expect(errors).toHaveLength(1);
    const message = String(errors[0]!.content);
    expect(message).toMatch(/^BUNDLED_RUNTIME_MISSING:/);
    expect(message).toContain(join(fixture, 'dist/src/runtime/guardian.js'));
    expect(message).toContain(join(fixture, 'dist/src/runtime/pi-receipts.js'));
    expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/ENOENT/);
    expect(customMessages(run.stdout).filter(entry => entry.customType === 'p2o_result')).toEqual([]);
    expect(existsSync(join(home, '.p2o'))).toBe(false);
  });
});

describe.runIf(!cliAvailable)('real pi CLI (no binary available)', () => {
  it.skip('skipped: no pi binary resolvable from the package or PATH; supply node_modules (npm ci) to enable the CLI cases', () => {});
});
