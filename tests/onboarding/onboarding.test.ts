// UI CONTRACT ONLY. Real owner-file permission/atomic-publication tests; no live UI/model/target execution.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
const home = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => home.path }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), realpath: vi.fn(actual.realpath),
    open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});
import { configurationDigest, defaultOwnerStorageRoot, ensureOwnerOnboarding, onboardingScopeFor, readOwnerConfiguration, readOwnerConsent, validateOwnerConfiguration, type OnboardingInput, type OnboardingReady } from '../../src/application/onboarding/index.js';
import { assertOwnerPreparation } from '../../src/interface/index.js';
import { ContractUI } from './helpers.js';

let root: string;
let previousEnv: Record<string, string | undefined>;
const envKeys = ['P2O_CONTROL_MODULE', 'P2O_APPLICATION_DOCUMENT', 'P2O_OWNER_CONFIG'];
beforeEach(async () => {
  root = await fs.mkdtemp('/tmp/p2o-onboarding-contract-'); home.path = root;
  previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  envKeys.forEach(key => { delete process.env[key]; });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('PAID/LIVE/TARGET CALL FORBIDDEN'); }));
});
afterEach(async () => {
  for (const key of envKeys) { if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]; }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true });
});
function input(ui = new ContractUI(), extra: Partial<OnboardingInput> = {}): OnboardingInput {
  return { target: { kind: 'local-dir', raw: './unread-repo', locator: './unread-repo' }, cwd: join(root, 'work'), hasUI: true, ui, ...extra };
}
async function ready(ui = new ContractUI(), extra: Partial<OnboardingInput> = {}): Promise<OnboardingReady> {
  const result = await ensureOwnerOnboarding(input(ui, extra));
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error('expected saved owner consent');
  return result;
}
describe('first-use owner onboarding — UI CONTRACT ONLY', () => {
  test('fresh session: no env/module/config path, no target I/O, readable safe owner-only bundle', async () => {
    const ui = new ContractUI();
    const lstat = vi.mocked(fs.lstat), realpath = vi.mocked(fs.realpath);
    lstat.mockClear(); realpath.mockClear(); vi.mocked(fs.open).mockClear(); vi.mocked(fs.readFile).mockClear();
    const result = await ready(ui);
    const target = join(root, 'work', 'unread-repo');
    expect(lstat.mock.calls.some(([path]) => String(path).startsWith(join(root, 'work')))).toBe(false);
    expect(realpath.mock.calls.some(([path]) => String(path).startsWith(join(root, 'work')))).toBe(false);
    expect(vi.mocked(fs.open).mock.calls.some(([path]) => String(path).startsWith(join(root, 'work')))).toBe(false);
    expect(vi.mocked(fs.readFile).mock.calls.some(([path]) => String(path).startsWith(join(root, 'work')))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.reused).toBe(false);
    expect(result.configPath).toBe(result.receiptPath);
    expect(defaultOwnerStorageRoot()).toBe(join(root, '.p2o', 'onboarding'));
    expect(result.configPath.startsWith(defaultOwnerStorageRoot())).toBe(true);
    const config = await readOwnerConfiguration(result.configPath), bundle = await readOwnerConsent(result.receiptPath);
    expect(config).toEqual(result.configuration);
    expect(config.scope.target.locator).toBe(target);
    expect(config.allowedActions).toEqual(['read', 'analyze']);
    expect(config.permissions).toEqual({ readStatic: true, repositoryScripts: false, stateChanges: false });
    expect(config.authorization.attestation).toBe('human-self-attested');
    expect(bundle.receipt).toMatchObject({ source: 'human-ui', kind: 'scope-consent-not-plan-approval', ownerUid: process.getuid!(), configurationDigest: configurationDigest(config), previousConfigurationDigest: null });
    expect((await fs.stat(result.configPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(defaultOwnerStorageRoot())).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(defaultOwnerStorageRoot())).toEqual([result.configPath.split('/').at(-1)]);
    expect(Object.isFrozen(config.permissions)).toBe(true);
    expect(ui.calls.at(-1)?.message).toMatch(/charges.*--plan-only/);
    expect(ui.calls.at(-1)?.message).toMatch(/no application token\/USD caps/);
    expect(ui.calls.at(-1)?.message).toMatch(/not independent ownership proof/);
    expect(ui.calls.at(-1)?.message).toMatch(/provider/);
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test.each(Array.from({ length: 11 }, (_, i) => i + 1))('cancel dialog %i writes absolutely nothing', async cancelAt => {
    const ui = new ContractUI(); ui.cancelAt = cancelAt;
    expect(await ensureOwnerOnboarding(input(ui))).toEqual({ status: 'cancelled' });
    expect(await fs.readdir(root)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('no UI or missing dialog APIs returns explicit unsupported, with no owner directory', async () => {
    for (const extra of [{ hasUI: false }, { ui: {} as ContractUI }]) {
      expect(await ensureOwnerOnboarding(input(new ContractUI(), extra))).toMatchObject({ status: 'unsupported', code: 'ONBOARDING_UI_UNSUPPORTED' });
    }
    expect(await fs.readdir(root)).toEqual([]);
  });
  test('abort during the final UI confirmation leaves nothing behind', async () => {
    const signal = new AbortController(), ui = new ContractUI();
    ui.confirmAnswer = title => { if (title.startsWith('Save')) signal.abort(); return true; };
    expect(await ensureOwnerOnboarding(input(ui, { signal: signal.signal }))).toEqual({ status: 'cancelled' });
    expect(await fs.readdir(root)).toEqual([]);
  });
  test('exact saved scope and narrowed operational limits/deadline reuse without onboarding questions in a fresh service call', async () => {
    const first = await ready();
    const bytes = await fs.readFile(first.configPath, 'utf8'), ui = new ContractUI();
    const second = await ready(ui, { limits: { maxRequests: 10, concurrency: 1, deadlineMs: first.configuration.limits.deadlineMs - 1_000 } });
    expect(second.reused).toBe(true); expect(ui.calls).toEqual([]);
    expect(second.effectiveLimits).toMatchObject({ maxRequests: 10, concurrency: 1, deadlineMs: first.configuration.limits.deadlineMs - 1_000, maxCostUsd: null, maxTokens: null });
    expect(second.configuration.limits).toEqual(first.configuration.limits);
    expect(await fs.readFile(first.configPath, 'utf8')).toBe(bytes);
    expect(ui.notifications.join('\n')).toMatch(/model.*charges/);
  });
  test('directory scope narrowing reuses the covering owner record, without reading target paths', async () => {
    const first = await ready(), ui = new ContractUI();
    const second = await ready(ui, { target: { kind: 'local-dir', raw: './unread-repo/src', locator: './unread-repo/src' } });
    expect(second.configPath).toBe(first.configPath); expect(second.reused).toBe(true); expect(ui.calls).toEqual([]);
    await expect(fs.lstat(join(root, 'work'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('the removed token/USD budget request is refused explicitly, never silently ignored', async () => {
    await ready();
    for (const limits of [{ maxCostUsd: 6 }, { maxTokens: 100_001 }, { maxCostUsd: 6, maxTokens: 100_001 }]) {
      await expect(ensureOwnerOnboarding(input(new ContractUI(), { limits }))).rejects.toThrow(/application token\/USD caps were removed/);
    }
  });
  test.each([
    { limits: { maxRequests: 21 } },
    { limits: { maxToolCalls: 21 } }, { limits: { maxAttempts: 3 } }, { limits: { concurrency: 2 } },
    { permissions: { repositoryScripts: true } }, { permissions: { stateChanges: true } },
  ])('rights/budget expansion re-prompts; flags/requests do not grant rights: %j', async extra => {
    const first = await ready(), ui = new ContractUI();
    const second = await ready(ui, extra);
    expect(second.reused).toBe(false); expect(ui.calls[0].title).toMatch(/expansion/);
    expect(second.configuration.permissions.repositoryScripts).toBe(false);
    expect(second.configuration.permissions.stateChanges).toBe(false);
    expect((await readOwnerConsent(second.configPath)).receipt.previousConfigurationDigest).toBe(configurationDigest(first.configuration));
  });
  test('deadline expansion and expiry require renewed human consent', async () => {
    const first = await ready(), ui = new ContractUI();
    await ready(ui, { limits: { deadlineMs: first.configuration.limits.deadlineMs + 60_000 } });
    expect(ui.calls).not.toHaveLength(0);
    const expiredUI = new ContractUI();
    const renewed = await ensureOwnerOnboarding(input(expiredUI), { now: () => Date.now() + 2 * 60 * 60_000 });
    expect(renewed.status).toBe('ready'); expect(expiredUI.calls[0].title).toMatch(/renewal/);
  });
  test('scope expansion prompts and cancellation leaves the prior record unchanged', async () => {
    const first = await ready(), bytes = await fs.readFile(first.configPath, 'utf8'), ui = new ContractUI(); ui.cancelAt = 1;
    const result = await ensureOwnerOnboarding(input(ui, { target: { kind: 'local-dir', raw: '../work', locator: '../work' } }));
    expect(result.status).toBe('cancelled'); expect(ui.calls).toHaveLength(1);
    expect(await fs.readFile(first.configPath, 'utf8')).toBe(bytes);
    expect(await fs.readdir(defaultOwnerStorageRoot())).toHaveLength(1);
  });
  test('repository scripts and state changes are genuinely separate human choices', async () => {
    const ui = new ContractUI();
    ui.selectAnswer = (title, choices) => title.includes('repository scripts?') ? choices[1] : choices[0];
    const result = await ready(ui);
    expect(result.configuration.permissions).toEqual({ readStatic: true, repositoryScripts: true, stateChanges: false });
    expect(result.configuration.allowedActions).toEqual(['read', 'analyze', 'repo-script']);
    const stateUI = new ContractUI();
    stateUI.selectAnswer = (title, choices) => title.includes('state-changing') ? choices[1] : choices[0];
    const changed = await ready(stateUI, { permissions: { stateChanges: true } });
    expect(changed.configuration.permissions).toEqual({ readStatic: true, repositoryScripts: false, stateChanges: true });
  });
  test('per-run rights can narrow without erasing or widening canonical saved consent', async () => {
    const ui = new ContractUI(); ui.selectAnswer = (title, choices) => title.includes('repository scripts?') ? choices[1] : choices[0];
    const first = await ready(ui), narrowedUI = new ContractUI();
    const narrowed = await ready(narrowedUI, { permissions: { repositoryScripts: false } });
    expect(narrowed.reused).toBe(true); expect(narrowedUI.calls).toEqual([]);
    expect(narrowed.configuration.permissions).toEqual(first.configuration.permissions);
    expect(narrowed.effectivePermissions.repositoryScripts).toBe(false);
  });
  test('written/program authorization needs a bounded human reference, never a fabricated default', async () => {
    for (const [index, basis] of [[1, 'written-permission'], [2, 'published-program']] as const) {
      const ui = new ContractUI();
      ui.selectAnswer = (title, choices) => title.includes('authorization basis') ? choices[index] : choices[0];
      ui.inputAnswer = title => title.startsWith('Authorization') ? 'Owner permission ticket TEST-42 (scope reviewed)' : '';
      const result = await ready(ui, { target: { kind: 'http-url', raw: `https://example.invalid/${index}`, locator: `https://example.invalid/${index}` } });
      expect(result.configuration.authorization).toMatchObject({ basis, reference: 'Owner permission ticket TEST-42 (scope reviewed)' });
    }
  });
  test('public source review is an honest static-only basis: read/analyze, no script/state dialogs, no host testing', async () => {
    const ui = new ContractUI();
    ui.selectAnswer = (title, choices) => title.includes('authorization basis') ? choices[3] : choices[0];
    const result = await ready(ui, { target: { kind: 'github-repo', raw: 'https://github.com/octocat/Hello-World', locator: 'https://github.com/octocat/Hello-World' } });
    expect(result.configuration.authorization.basis).toBe('public-source-review');
    expect(result.configuration.authorization.reference).toMatch(/no host testing, no repository scripts, no state changes/);
    expect(result.configuration.permissions).toEqual({ readStatic: true, repositoryScripts: false, stateChanges: false });
    expect(result.configuration.allowedActions).toEqual(['read', 'analyze']);
    expect(ui.calls.some(call => call.title.includes('repository scripts?'))).toBe(false);
    expect(ui.calls.some(call => call.title.includes('state-changing'))).toBe(false);
    expect(ui.calls.at(-1)?.message).toMatch(/static read\/clone and static analysis only/);
    expect(ui.calls.at(-1)?.message).toMatch(/no HTTP requests against the repository host/);
  });
  test('public source review cannot cover a single-URL target or a persisted script/state grant', async () => {
    const ui = new ContractUI();
    ui.selectAnswer = (title, choices) => title.includes('authorization basis') ? choices[3] : choices[0];
    await expect(ready(ui, { target: { kind: 'http-url', raw: 'https://example.invalid/public', locator: 'https://example.invalid/public' } }))
      .rejects.toThrow(/public source review is static read\/clone only/);
    expect(await fs.readdir(root)).toEqual([]);
    const saved = await ready(new ContractUI(), { target: { kind: 'github-repo', raw: 'https://github.com/octocat/Hello-World', locator: 'https://github.com/octocat/Hello-World' } });
    const grantedScript = { ...saved.configuration, authorization: { ...saved.configuration.authorization, basis: 'public-source-review' as const },
      permissions: { readStatic: true as const, repositoryScripts: true, stateChanges: false }, allowedActions: ['read', 'analyze', 'repo-script'] };
    expect(() => validateOwnerConfiguration(grantedScript)).toThrow(/ONBOARDING_CONFIG_INVALID/);
    const urlScope = { ...saved.configuration, authorization: { ...saved.configuration.authorization, basis: 'public-source-review' as const },
      scope: { target: { kind: 'http-url', raw: 'https://example.invalid/x', locator: 'https://example.invalid/x' }, boundary: 'exact-url-no-redirects' } };
    expect(() => validateOwnerConfiguration(urlScope)).toThrow(/ONBOARDING_CONFIG_INVALID/);
  });
  test('public source review cannot prepare an HTTP target at the command boundary', async () => {
    const saved = await ready(new ContractUI(), { target: { kind: 'github-repo', raw: 'https://github.com/octocat/Hello-World', locator: 'https://github.com/octocat/Hello-World' } });
    const owner = { ...saved, configuration: { ...saved.configuration, authorization: { ...saved.configuration.authorization, basis: 'public-source-review' as const } } } as OnboardingReady;
    const preparation = { runId: 'run-public-source', mode: 'assessment', scopeDigest: 'a'.repeat(64), actions: ['read', 'analyze'],
      spend: { maxCostUsd: 1, maxRequests: 1, maxTokens: 1_000, maxToolCalls: 1, maxAttempts: 1, deadlineMs: owner.effectiveLimits.deadlineMs },
      concurrency: 1, warnings: [], requiresHumanApproval: true as const, targetRequests: 0 as const, planOnly: false,
      target: { kind: 'http-url', raw: 'https://example.invalid/public', locator: 'https://example.invalid/public' } };
    expect(() => assertOwnerPreparation(owner, preparation as Parameters<typeof assertOwnerPreparation>[1], join(root, 'work'))).toThrow(/public source review/);
  });
  test('a credential-looking reference cannot be persisted', async () => {
    for (const reference of ['password=unsafe', 'https://user:pass@example.invalid/permission']) {
      const ui = new ContractUI(); ui.inputAnswer = title => title.startsWith('Authorization') ? reference : '';
      await expect(ensureOwnerOnboarding(input(ui))).rejects.toThrow(/ONBOARDING_INVALID_INPUT/);
      expect(await fs.readdir(root)).toEqual([]);
    }
  });
  test('CAS/atomic publication prevents a stale dialog from overwriting a newer consent', async () => {
    const first = await ready(), stale = new ContractUI();
    let release!: () => void, reached!: () => void;
    const barrier = new Promise<void>(resolve => { reached = resolve; });
    stale.confirmAnswer = async title => {
      if (title.startsWith('Save')) { reached(); await new Promise<void>(resolve => { release = resolve; }); }
      return true;
    };
    const pending = ready(stale, { limits: { maxRequests: 21 } });
    await barrier;
    expect(await readOwnerConfiguration(first.configPath)).toEqual(first.configuration);
    const newest = await ready(new ContractUI(), { limits: { maxRequests: 22 } });
    release(); await expect(pending).rejects.toThrow(/ONBOARDING_CONFIG_CHANGED/);
    expect(await readOwnerConfiguration(first.configPath)).toEqual(newest.configuration);
    expect(await fs.readdir(defaultOwnerStorageRoot())).toHaveLength(1);
  });
});
describe('owner configuration provenance and path safety — real filesystem, offline', () => {
  test.each(['file-mode', 'directory-mode', 'symlink', 'hardlink', 'owner-uid', 'receipt-source', 'receipt-digest', 'unknown-field', 'expanded-actions'] as const)('rejects %s instead of silently re-onboarding or trusting model JSON', async kind => {
    const saved = await ready();
    const bundle = JSON.parse(await fs.readFile(saved.configPath, 'utf8'));
    if (kind === 'file-mode') await fs.chmod(saved.configPath, 0o644);
    else if (kind === 'directory-mode') await fs.chmod(defaultOwnerStorageRoot(), 0o755);
    else if (kind === 'symlink') {
      await fs.rename(saved.configPath, `${saved.configPath}.moved`); await fs.symlink(`${saved.configPath}.moved`, saved.configPath);
    } else if (kind === 'hardlink') await fs.link(saved.configPath, join(root, 'copy.json'));
    else {
      if (kind === 'owner-uid') bundle.configuration.owner.uid += 1;
      if (kind === 'receipt-source') bundle.receipt.source = 'model';
      if (kind === 'receipt-digest') bundle.receipt.configurationDigest = '0'.repeat(64);
      if (kind === 'unknown-field') bundle.configuration.executableModule = '/untrusted/model.mjs';
      if (kind === 'expanded-actions') bundle.configuration.allowedActions.push('state-change');
      await fs.writeFile(saved.configPath, JSON.stringify(bundle));
    }
    await expect(readOwnerConfiguration(saved.configPath)).rejects.toThrow(/ONBOARDING_(STORAGE_UNSAFE|CONFIG_INVALID|CONFIG_UNTRUSTED)/);
    const ui = new ContractUI(); await expect(ensureOwnerOnboarding(input(ui))).rejects.toThrow(/ONBOARDING_/); expect(ui.calls).toEqual([]);
  });
  test('no in-repo config, link ancestors, relative paths, credential-bearing targets, or silent URL widening', async () => {
    const ui = new ContractUI(), target = onboardingScopeFor(input().target, input().cwd);
    for (const storageRoot of [join(root, 'work', 'owners'), target.target.locator, 'relative']) {
      await expect(ensureOwnerOnboarding(input(ui), { storageRoot })).rejects.toThrow(/ONBOARDING_STORAGE_UNSAFE/);
    }
    await fs.mkdir(join(root, 'real'), { mode: 0o700 }); await fs.symlink(join(root, 'real'), join(root, 'linked'));
    await expect(ensureOwnerOnboarding(input(ui), { storageRoot: join(root, 'linked', 'owners') })).rejects.toThrow(/ONBOARDING_STORAGE_UNSAFE/);
    for (const locator of ['https://user:password@example.invalid', 'https://example.invalid/?token=secret', 'https://example.invalid/#hidden']) {
      await expect(ensureOwnerOnboarding(input(ui, { target: { kind: 'http-url', raw: locator, locator } }))).rejects.toThrow(/ONBOARDING_INVALID_INPUT/);
    }
    for (const raw of ['https://github.com/owner/repo/tree/main', 'https://github.com/owner/repo?ref=main', 'https://github.com/owner/repo?%74oken=sensitive']) {
      await expect(ensureOwnerOnboarding(input(ui, { target: { kind: 'github-repo', raw, locator: 'https://github.com/owner/repo' } }))).rejects.toThrow(/ONBOARDING_INVALID_INPUT/);
    }
    expect(ui.calls).toEqual([]);
  });
});
