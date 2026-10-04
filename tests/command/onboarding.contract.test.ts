// CONTRACT ONLY: Pi dialogs, model-author and backend are doubles. No live/model/target execution claim.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
const home = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => home.path }));
import { registerP2O } from '../../extensions/p2o/index.js';
import { readOwnerConfiguration } from '../../src/application/onboarding/index.js';
import { consumeHumanConfirmationCapability } from '../../src/interface/human-approval.js';
import type { BackendFactoryContext } from '../../src/interface/types.js';
import { FakeBackend, FakeEntry, fakePi } from '../interface/helpers.js';
import { ContractUI } from '../onboarding/helpers.js';
import { parseP2OArgs } from '../../src/interface/argv.js';

let root: string, previousModule: string | undefined;
const controllers: Array<{ close(): Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp('/tmp/p2o-command-onboarding-'); home.path = root;
  previousModule = process.env.P2O_CONTROL_MODULE; delete process.env.P2O_CONTROL_MODULE;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('PAID/LIVE/TARGET CALL FORBIDDEN'); }));
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close();
  if (previousModule === undefined) delete process.env.P2O_CONTROL_MODULE; else process.env.P2O_CONTROL_MODULE = previousModule;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true });
});
function setup(hasUI = true, ui = new ContractUI()) {
  const pi = fakePi(hasUI), backend = new FakeBackend(), entry = new FakeEntry(); backend.entry = entry;
  Object.assign(pi.context, { cwd: join(root, 'work'), ui: { ...pi.context.ui,
    confirm: ui.confirm.bind(ui), select: ui.select.bind(ui), input: ui.input.bind(ui), notify: ui.notify.bind(ui) } });
  const contexts: BackendFactoryContext[] = [];
  const planAuthorFor = vi.fn(() => ({ marker: 'CONTRACT ONLY model author; no completion' }));
  const backendFactory = vi.fn((context: BackendFactoryContext) => { contexts.push(context); return backend; });
  const controller = registerP2O(pi.api, { backendFactory, planAuthorFor }); controllers.push(controller);
  return { pi, backend, entry, ui, contexts, controller, planAuthorFor, backendFactory };
}
const last = (s: ReturnType<typeof setup>): string => String(s.pi.messages.at(-1)?.content ?? '');
function changeUI(s: ReturnType<typeof setup>, ui: ContractUI): void {
  Object.assign(s.pi.context.ui, { confirm: ui.confirm.bind(ui), select: ui.select.bind(ui), input: ui.input.bind(ui), notify: ui.notify.bind(ui) });
}
describe('/p2o first-use onboarding — CONTRACT ONLY', () => {
  test('default registration collects consent but refuses an unsupported host model API before provider or target I/O', async () => {
    const pi = fakePi(), ui = new ContractUI();
    Object.assign(pi.context, { cwd: join(root, 'work'), ui: { ...pi.context.ui,
      confirm: ui.confirm.bind(ui), select: ui.select.bind(ui), input: ui.input.bind(ui), notify: ui.notify.bind(ui) } });
    const controller = registerP2O(pi.api); controllers.push(controller);
    await pi.command('p2o', '--target ./repo --plan-only');
    expect(ui.calls.at(-1)?.title).toBe('First-use owner consent: save this scope, rights and limits?');
    expect(String(pi.messages.at(-1)?.content)).toMatch(/PI_MODEL_API_UNSUPPORTED/);
    expect(await readdir(join(root, '.p2o', 'onboarding'))).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each(['./repo-never-read', 'https://github.com/owner/repo', 'https://example.invalid/app'])('fresh session/no environment path: %s drives UI BEFORE factory/author; plan-only zero I/O', async target => {
    const s = setup();
    expect([...s.pi.commands.keys()]).toEqual(['p2o']); expect(s.backendFactory).not.toHaveBeenCalled();
    await s.pi.command('p2o', `--target ${target} --plan-only`);
    expect(s.pi.messages.at(-1)?.customType).toBe('p2o_result');
    expect(s.ui.calls.at(-1)?.title).toBe('First-use owner consent: save this scope, rights and limits?');
    expect(s.ui.calls.at(-1)?.message).toMatch(/charges.*--plan-only/);
    expect(s.backendFactory).toHaveBeenCalledTimes(1); expect(s.planAuthorFor).toHaveBeenCalledTimes(1);
    const owner = s.contexts[0].onboarding!;
    expect(owner.status).toBe('ready'); expect(owner.reused).toBe(false);
    expect(await readOwnerConfiguration(owner.configPath)).toEqual(owner.configuration);
    expect(s.contexts[0].onboardingSlot?.current).toBe(owner);
    expect(s.entry.calls).toEqual([`prepare:${owner.configuration.scope.target.kind}`, 'plan']);
    expect(s.entry.targetRequests).toBe(0); expect(s.backend.calls).toEqual([]);
    expect(last(s)).toMatch(/no target request.*no worker/i);
    expect(fetch).not.toHaveBeenCalled();
    await expect(lstat(join(root, 'work'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  // The guided questionnaire still asks every question; cancelling any one of them must write/plan/launch nothing.
  test.each(Array.from({ length: 13 }, (_, index) => index + 1))('cancelling guided first-use question %i writes nothing, constructs/plans/launches nothing', async cancelAt => {
    const s = setup(); s.ui.cancelAt = cancelAt;
    await s.pi.command('p2o', '--target ./repo-never-read --advanced');
    expect(last(s)).toMatch(/ONBOARDING_CANCELLED/);
    expect(s.backendFactory).not.toHaveBeenCalled(); expect(s.planAuthorFor).not.toHaveBeenCalled();
    expect(s.entry.calls).toEqual([]); expect(s.backend.calls).toEqual([]);
    expect(s.pi.sessionEntries).toEqual([]); expect(await readdir(root)).toEqual([]);
  });
  // Default quick consent asks exactly one dialog: cancelling it must also write/plan/launch nothing.
  test('cancelling the single quick consent dialog writes nothing and launches nothing', async () => {
    const s = setup(); s.ui.cancelAt = 1;
    await s.pi.command('p2o', '--target ./repo-never-read');
    expect(s.ui.calls.map(call => call.method)).toEqual(['confirm']);
    expect(last(s)).toMatch(/ONBOARDING_CANCELLED/);
    expect(s.backendFactory).not.toHaveBeenCalled(); expect(s.planAuthorFor).not.toHaveBeenCalled();
    expect(s.entry.calls).toEqual([]); expect(s.backend.calls).toEqual([]);
    expect(s.pi.sessionEntries).toEqual([]); expect(await readdir(root)).toEqual([]);
  });
  test.each(['--target ./repo', '--target ./repo --plan-only'])('fresh no-UI is explicit unsupported BEFORE backend/model: %s', async args => {
    const s = setup(false); await s.pi.command('p2o', args);
    expect(last(s)).toMatch(/ONBOARDING_UI_UNSUPPORTED/); expect(s.backendFactory).not.toHaveBeenCalled();
    expect(s.planAuthorFor).not.toHaveBeenCalled(); expect(s.ui.calls).toEqual([]); expect(await readdir(root)).toEqual([]);
  });
  test('fresh Pi session reuses persisted approved scope and does not ask onboarding again', async () => {
    const s = setup(); await s.pi.command('p2o', '--target ./repo --plan-only');
    const next = setup(); await next.pi.command('p2o', '--target ./repo --plan-only');
    expect(next.ui.calls).toEqual([]); expect(next.contexts[0].onboarding?.reused).toBe(true);
    expect(next.contexts[0].onboarding?.configPath).toBe(s.contexts[0].onboarding?.configPath);
  });
  test('reuse narrows argv budget and directory target; the command never widens back to the saved parent', async () => {
    const s = setup(); await s.pi.command('p2o', '--target ./repo --plan-only');
    const next = setup(); await next.pi.command('p2o', '--target ./repo/src --budget 2 --plan-only');
    expect(next.ui.calls).toEqual([]);
    const savedPlan = next.entry.plans.get('plan-1')!;
    expect(savedPlan.preparation.target.locator).toBe(join(root, 'work', 'repo', 'src'));
    expect(savedPlan.preparation.spend.maxCostUsd).toBe(2);
  });
  test('shorter per-run deadline is forwarded through effective limits, not discarded during consent reuse', async () => {
    const s = setup(); await s.pi.command('p2o', '--target ./repo --plan-only');
    const ui = new ContractUI(); changeUI(s, ui);
    const before = Date.now(); await s.pi.command('p2o', '--target ./repo --deadline 30 --plan-only');
    const owner = s.contexts[0].onboardingSlot?.current!;
    expect(ui.calls).toEqual([]);
    expect(owner.effectiveLimits.deadlineMs).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(owner.effectiveLimits.deadlineMs).toBeLessThan(owner.configuration.limits.deadlineMs);
  });
  test('scope/budget/rights expansions ask HUMAN again; late-bound factory slot updates', async () => {
    const s = setup(); await s.pi.command('p2o', '--target ./repo --plan-only');
    const secondUI = new ContractUI(); changeUI(s, secondUI);
    await s.pi.command('p2o', '--target ./repo --budget 6 --concurrency 2 --deadline 120 --repo-scripts --state-changes --plan-only');
    expect(secondUI.calls[0].title).toMatch(/expansion/); expect(s.backendFactory).toHaveBeenCalledTimes(1);
    expect(s.contexts[0].onboardingSlot?.current?.configuration.limits).toMatchObject({ maxCostUsd: 6, concurrency: 2 });
    // Quick consent does not let a flag grant a right by itself: the dialog that carries the request is what the
    // human approves, and cancelling it grants nothing (covered by the cancellation cases).
    expect(secondUI.calls[0].message).toMatch(/repository scripts ON, state changes ON/);
    expect(s.contexts[0].onboardingSlot?.current?.configuration.permissions).toMatchObject({ repositoryScripts: true, stateChanges: true });
    const scopeUI = new ContractUI(); scopeUI.cancelAt = 1; changeUI(s, scopeUI);
    const callsBefore = [...s.entry.calls];
    await s.pi.command('p2o', '--target ./second-repo --plan-only');
    expect(last(s)).toMatch(/ONBOARDING_CANCELLED/); expect(s.entry.calls).toEqual(callsBefore);
  });
  test('existing model plan approval is human-only, digest-bound, single use; no self-approval tools', async () => {
    const s = setup(); await s.pi.command('p2o', '--target ./repo');
    expect(s.entry.calls.at(-1)).toBe('start');
    const approval = s.entry.lastApproval!;
    expect(s.ui.calls.at(-1)?.title).toMatch(/Approve p2o run/);
    expect(s.ui.calls.at(-1)?.message).toContain('b'.repeat(64));
    expect(s.ui.calls.at(-1)?.message).toMatch(/actions:.*read, analyze/);
    expect(s.ui.calls.at(-1)?.message).toMatch(/steps:.*snapshot.*delegate/);
    expect(JSON.stringify(approval.authority)).toBe('{}');
    const binding = { runId: 'run-1', scopeDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64) };
    expect(consumeHumanConfirmationCapability(approval.authority, binding).approvalRef).toBe(approval.approvalRef);
    expect(() => consumeHumanConfirmationCapability(approval.authority, binding)).toThrow(/already used/);
    await expect(s.pi.call('p2o_plan', { action: 'approve', runId: 'run-1', proposalDigest: 'b'.repeat(64), approvalPath: '/untrusted/model.json' })).rejects.toThrow(/APPROVAL_HUMAN_ONLY/);
    expect([...s.pi.tools.keys()].some(name => /onboard|consent|approve/.test(name))).toBe(false);
  });
  test('plan-only can later be approved without repeating saved scope questions, but still requires exact digest confirmation', async () => {
    const s = setup(); await s.pi.command('p2o', '--target ./repo --plan-only');
    const ui = new ContractUI(); changeUI(s, ui);
    await s.pi.command('p2o', 'approve plan-1');
    expect(ui.calls).toHaveLength(1); expect(ui.calls[0].title).toMatch(/Approve plan/);
    expect(s.entry.calls.at(-1)).toBe('approve:plan-1');
  });
  test('declining MODEL PLAN confirmation launches nothing; previously HUMAN-confirmed scope consent remains distinct', async () => {
    const s = setup(); s.ui.confirmAnswer = title => !title.startsWith('Approve p2o');
    await s.pi.command('p2o', '--target ./repo');
    expect(last(s)).toMatch(/NOT_APPROVED/); expect(s.entry.calls).not.toContain('start');
    expect(await readOwnerConfiguration(s.contexts[0].onboarding!.configPath)).toBeDefined();
  });
  test('abort during MODEL PLAN UI confirmation never mints a launch approval', async () => {
    const s = setup(), signal = new AbortController(); Object.assign(s.pi.context, { signal: signal.signal });
    s.ui.confirmAnswer = title => { if (title.startsWith('Approve p2o')) signal.abort(); return true; };
    await s.pi.command('p2o', '--target ./repo');
    expect(last(s)).toMatch(/CANCELLED/); expect(s.entry.calls).not.toContain('start');
    expect(s.entry.lastApproval).toBeUndefined();
  });
  test.each([
    { actions: ['state-change'] }, { spend: { maxCostUsd: 6, maxRequests: 20, maxTokens: 100_000, maxToolCalls: 20, maxAttempts: 2 } },
    { concurrency: 2 }, { target: { kind: 'local-dir', raw: './other', locator: './other' } },
  ])('prepared scope/rights/spend expansion is refused BEFORE model planning/launch: %j', async overrides => {
    // Consent is deliberately narrow here so the prepared values are a real expansion beyond it.
    const s = setup(); s.entry.prepareOverrides = overrides;
    await s.pi.command('p2o', '--target ./repo --profile conservative');
    expect(last(s)).toMatch(/ONBOARDING_(SCOPE|RIGHTS|BUDGET)_EXPANSION/);
    expect(s.entry.calls).not.toContain('plan'); expect(s.entry.calls).not.toContain('start');
  });
  test('a forged backend can neither skip consent nor substitute a different model-plan digest shape', async () => {
    const s = setup(); s.entry.planOverrides = { digest: 'model-says-approved' };
    await s.pi.command('p2o', '--target ./repo');
    expect(last(s)).toMatch(/ENTRY_CONTRACT_VIOLATION/); expect(s.entry.calls).not.toContain('start');
  });
  test('factory constructed by a read earlier still receives the later owner consent through its slot', async () => {
    const s = setup(); await s.pi.call('p2o_status', { runId: 'run-1' });
    expect(s.contexts[0].onboarding).toBeUndefined();
    await s.pi.command('p2o', '--target ./repo --plan-only');
    expect(s.backendFactory).toHaveBeenCalledTimes(1); expect(s.contexts[0].onboardingSlot?.current?.status).toBe('ready');
  });
  test('request flags are typed, bounded and cannot carry owner config, approval or code paths', () => {
    expect(parseP2OArgs('--target ./repo --repo-scripts --state-changes --deadline 120')).toMatchObject({ repositoryScripts: true, stateChanges: true, deadlineMinutes: 120 });
    for (const args of ['--target ./repo --deadline 0', '--target ./repo --deadline 10081', '--target ./repo --repo-scripts=true', '--target ./repo --state-changes --state-changes', '--target ./repo --config /untrusted/model.json']) {
      expect(() => parseP2OArgs(args)).toThrow();
    }
  });
});
