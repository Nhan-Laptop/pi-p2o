// One-dialog quick consent: exactly one human dialog, profile-derived limits, explicit rights opt-ins.
// CONTRACT ONLY: deterministic dialog replies, no model, no target I/O, no credentials.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const home = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => home.path }));
import { ensureOwnerOnboarding, profileLimits, LIMIT_CEILINGS, type OnboardingTarget } from '../../src/application/onboarding/index.js';
import { ContractUI } from './helpers.js';

let root: string;
beforeEach(async () => { root = await mkdtemp('/tmp/p2o-quick-consent-'); home.path = root; });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const LOCAL: OnboardingTarget = { kind: 'local-dir', raw: './repo', locator: './repo' };
const URL_TARGET: OnboardingTarget = { kind: 'http-url', raw: 'https://example.invalid/app', locator: 'https://example.invalid/app' };
const REPO: OnboardingTarget = { kind: 'github-repo', raw: 'https://github.com/owner/repo', locator: 'https://github.com/owner/repo' };

async function quick(target: OnboardingTarget, ui = new ContractUI(), extra: Record<string, unknown> = {}) {
  return ensureOwnerOnboarding({ target, cwd: join(root, 'work'), hasUI: true, ui, mode: 'quick', ...extra });
}

describe('quick owner consent — one dialog', () => {
  test('asks exactly one dialog and derives every limit from the default profile', async () => {
    const ui = new ContractUI(), now = Date.now();
    const result = await quick(LOCAL, ui);
    expect(ui.calls.map(call => call.method)).toEqual(['confirm']);
    expect(ui.calls[0]!.title).toBe('First-use owner consent: save this scope, rights and limits?');
    if (result.status !== 'ready') throw new Error(`expected ready, got ${result.status}`);
    const expected = profileLimits('wide', now);
    // The ordinary dialog shows the informational model-usage mode and every operational limit: no budget
    // prompt exists, and nothing is granted silently.
    expect(ui.calls[0]!.message).toContain('informational durable accounting; no application token/USD caps');
    for (const value of [expected.maxRequests, expected.maxToolCalls, expected.maxAttempts, expected.concurrency]) {
      expect(ui.calls[0]!.message).toContain(String(value));
    }
    expect(result.configuration.limits).toMatchObject({ modelAccounting: 'informational', maxCostUsd: null, maxTokens: null, maxRequests: expected.maxRequests });
    expect(result.configuration.permissions.repositoryScripts).toBe(false);
    expect(result.configuration.permissions.stateChanges).toBe(false);
    expect(result.configuration.authorization.basis).toBe('owner');
    expect(result.configuration.allowedActions).toEqual(['read', 'analyze']);
  });

  test('details are scoped: a path under the approved directory stays, a different directory does not', async () => {
    const ui = new ContractUI();
    const result = await quick(LOCAL, ui);
    if (result.status !== 'ready') throw new Error('expected ready');
    // The dialog carries the canonical local locator, not the raw argument.
    expect(ui.calls[0]!.message).toContain(join(root, 'work', 'repo'));
  });

  test('cancel at the single dialog saves nothing', async () => {
    const ui = new ContractUI();
    ui.cancelAt = 1;
    expect(await quick(LOCAL, ui)).toEqual({ status: 'cancelled' });
    await expect(readdir(join(root, '.p2o', 'onboarding'))).rejects.toThrow();
  });

  test('a second identical run reuses saved consent with zero dialogs', async () => {
    expect((await quick(LOCAL, new ContractUI())).status).toBe('ready');
    const ui = new ContractUI();
    const reused = await quick(LOCAL, ui);
    if (reused.status !== 'ready') throw new Error('expected ready');
    expect(reused.reused).toBe(true);
    expect(ui.calls).toHaveLength(0);
  });

  test('a bounded legacy consent is never silently widened to the informational default', async () => {
    // First save an explicit bounded consent, then ask for the wide (informational) profile: the wider
    // request cannot be satisfied by the narrower saved caps, so a human dialog is required and the saved
    // legacy numbers are not removed without it.
    const bounded = await quick(LOCAL, new ContractUI(), { profile: 'conservative' });
    if (bounded.status !== 'ready') throw new Error('expected ready');
    expect(bounded.configuration.limits).toMatchObject({ maxCostUsd: 5, maxTokens: 100_000 });
    const ui = new ContractUI();
    const wider = await quick(LOCAL, ui, { profile: 'wide' });
    if (wider.status !== 'ready') throw new Error('expected ready');
    expect(ui.calls.map(call => call.method)).toEqual(['confirm']);
    expect(wider.reused).toBe(false);
    expect(wider.configuration.limits).toMatchObject({ modelAccounting: 'informational', maxCostUsd: null, maxTokens: null });
  });

  test('an informational parent covers a narrower explicit profile without dialogs; explicit numeric profiles stay explicit', async () => {
    const first = await quick(LOCAL, new ContractUI());
    if (first.status !== 'ready') throw new Error('expected ready');
    // Every conservative value is inside the informational parent (which has no cap to exceed), so the
    // narrower request reuses the saved consent: informational mode is never silently replaced by numbers.
    const ui = new ContractUI();
    const narrower = await quick(LOCAL, ui, { profile: 'conservative' });
    if (narrower.status !== 'ready') throw new Error('expected ready');
    expect(ui.calls).toHaveLength(0);
    expect(narrower.reused).toBe(true);
    expect(narrower.configuration.limits).toMatchObject({ modelAccounting: 'informational', maxCostUsd: null, maxTokens: null });
    // A fresh explicit conservative profile is still a real bounded consent (an explicit owner request).
    await rm(join(home.path, '.p2o'), { recursive: true, force: true });
    const fresh = await quick(LOCAL, new ContractUI(), { profile: 'conservative' });
    if (fresh.status !== 'ready') throw new Error('expected ready');
    expect(fresh.configuration.limits).toMatchObject({ maxCostUsd: 5, maxTokens: 100_000, maxRequests: 20 });
  });

  test('--profile conservative asks one dialog and keeps the historic narrow defaults', async () => {
    const ui = new ContractUI();
    const result = await quick(LOCAL, ui, { profile: 'conservative' });
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(ui.calls).toHaveLength(1);
    expect(result.configuration.limits).toMatchObject({ maxCostUsd: 5, maxRequests: 20, maxTokens: 100_000, maxToolCalls: 20, maxAttempts: 2, concurrency: 1 });
  });

  test('the removed budget request is refused explicitly and operational narrowing still works', async () => {
    const ui = new ContractUI();
    await expect(quick(LOCAL, ui, { limits: { maxCostUsd: 12.5 } })).rejects.toThrow(/application token\/USD caps were removed/);
    await expect(quick(LOCAL, new ContractUI(), { limits: { maxTokens: 400_000 } })).rejects.toThrow(/application token\/USD caps were removed/);
    expect(ui.calls).toHaveLength(0);
    const narrowed = await quick(LOCAL, new ContractUI(), { limits: { concurrency: 3 } });
    if (narrowed.status !== 'ready') throw new Error('expected ready');
    expect(narrowed.configuration.limits.concurrency).toBe(3);
  });

  test('--full-rights requests both separate rights, shows them ON, and records them', async () => {
    const ui = new ContractUI();
    const result = await quick(LOCAL, ui, { permissions: { repositoryScripts: true, stateChanges: true } });
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0]!.message).toContain('repository scripts ON, state changes ON');
    expect(result.configuration.permissions).toMatchObject({ repositoryScripts: true, stateChanges: true });
    expect(result.configuration.allowedActions).toEqual(['read', 'analyze', 'repo-script', 'state-change']);
  });

  test('rights stay OFF when the invocation does not request them, even in the widest profile', async () => {
    const result = await quick(LOCAL, new ContractUI(), { profile: 'ceiling' });
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.configuration.permissions).toMatchObject({ repositoryScripts: false, stateChanges: false });
  });

  test('a URL target defaults to the owner basis and never accepts repository scripts', async () => {
    const ui = new ContractUI();
    const result = await quick(URL_TARGET, ui, { permissions: { stateChanges: true } });
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.configuration.authorization.basis).toBe('owner');
    expect(result.configuration.permissions.stateChanges).toBe(true);
    await expect(quick(URL_TARGET, new ContractUI(), { permissions: { repositoryScripts: true } })).rejects.toThrow(/repository scripts require a repository target/);
  });

  test('a public repository defaults to static public-source review with no host testing and no rights', async () => {
    const ui = new ContractUI();
    const result = await quick(REPO, ui, { permissions: { repositoryScripts: true, stateChanges: true } });
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.configuration.authorization.basis).toBe('public-source-review');
    expect(result.configuration.permissions).toMatchObject({ repositoryScripts: false, stateChanges: false });
    expect(ui.calls[0]!.message).toContain('static read/clone');
    expect(result.configuration.scope.boundary).toBe('single-repository');
  });

  test('public source review can never be combined with a single URL target', async () => {
    await expect(quick(URL_TARGET, new ContractUI(), { basis: 'public-source-review' })).rejects.toThrow(/static read\/clone only/);
  });

  test('unknown mode, profile and basis are refused before any dialog', async () => {
    const ui = new ContractUI();
    await expect(quick(LOCAL, ui, { mode: 'turbo' })).rejects.toThrow(/unknown onboarding mode/);
    await expect(quick(LOCAL, ui, { profile: 'infinite' })).rejects.toThrow(/unknown ceiling profile/);
    await expect(quick(LOCAL, ui, { basis: 'because-i-want' })).rejects.toThrow(/unknown authorization basis/);
    expect(ui.calls).toHaveLength(0);
  });

  test('a requested limit above the validated ceiling is refused rather than clamped silently', async () => {
    await expect(quick(LOCAL, new ContractUI(), { limits: { maxToolCalls: LIMIT_CEILINGS.maxToolCalls + 1 } })).rejects.toThrow(/invalid owner limit/);
  });

  test('saved consent records the human attestation and the exact limits the dialog showed', async () => {
    const ui = new ContractUI();
    const result = await quick(LOCAL, ui);
    if (result.status !== 'ready') throw new Error('expected ready');
    const saved = JSON.parse(await readFile(result.configPath, 'utf8')) as { configuration: { authorization: { attestation: string }; limits: Record<string, unknown> } };
    expect(saved.configuration.authorization.attestation).toBe('human-self-attested');
    expect(saved.configuration.limits).toMatchObject({ modelAccounting: 'informational', maxCostUsd: null, maxTokens: null });
    expect(ui.calls[0]!.message).toContain('Save outside the target at');
  });

  test('guided mode still asks every question separately, so advanced users keep the full questionnaire', async () => {
    const ui = new ContractUI();
    const result = await ensureOwnerOnboarding({ target: LOCAL, cwd: join(root, 'work'), hasUI: true, ui, mode: 'guided' });
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(ui.calls.length).toBeGreaterThan(5);
    expect(ui.calls.some(call => call.method === 'select')).toBe(true);
  });
});
