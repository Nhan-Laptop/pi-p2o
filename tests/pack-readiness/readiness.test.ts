import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ home: '', docker: 'missing-image' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }));
vi.mock('../../src/tools/process.js', async original => {
  const actual = await original<typeof import('../../src/tools/process.js')>();
  return { ...actual, runFixedProcess: vi.fn(async (...args: Parameters<typeof actual.runFixedProcess>) => {
    if (args[0] === '/usr/bin/mkdir') return actual.runFixedProcess(...args);
    if (args[0].endsWith('/docker')) return args[1][0] === 'version' ? { code: state.docker === 'permission' ? 1 : 0, stdout: '{}', stderr: state.docker === 'permission' ? 'permission denied on Docker socket' : '' } : { code: 1, stdout: '', stderr: 'No such image' };
    throw new Error('Unexpected executable');
  }) };
});
import { fixture } from './helpers.js';
import { ContractUI } from '../onboarding/helpers.js';
import { ensurePackConsent, type PackConsent } from '../../src/application/onboarding/packs.js';
import { checkPackReadiness, materializePackGrant, packConfigurationDigest, classifyPackFailure, prepareLocalPackAction, describeLocalPreparation, planOperatorSetup, type PackBoundaryConfiguration, type QualifiedPacks } from '../../src/application/pack-readiness/index.js';
import { runFixedProcess } from '../../src/tools/process.js';
import { probeProxyPort } from '../../src/application/pack-readiness/probes.js';

async function consent(f: Awaited<ReturnType<typeof fixture>>, configuration: PackBoundaryConfiguration = f.boundary, packs = f.selection.packs) {
  const actions = packs.includes('static') ? ['read', 'analyze'] as const : packs.includes('differential') ? ['analyze'] as const : ['read'] as const;
  const result = await ensurePackConsent({ ...f, boundaryConfiguration: configuration, selection: { ...f.selection, packs, actions: [...actions], configurationDigest: packConfigurationDigest(configuration) }, ui: new ContractUI() });
  if (result.status !== 'consented') throw new Error('test consent failed');
  return result.consent;
}
function container(f: Awaited<ReturnType<typeof fixture>>): PackBoundaryConfiguration {
  return { kind: 'container', settings: { inputRoot: f.target, outputRoot: f.outputRoot, trustedInputSnapshot: true, enginePath: '/usr/bin/docker', engineVersion: '28.0.4', image: `sha256:${'a'.repeat(64)}`, imageRootfsLayers: [`sha256:${'b'.repeat(64)}`], workerSha256: 'c'.repeat(64), sourceSha256: 'd'.repeat(64), seccompPath: join(f.base, 'seccomp.json'), seccompSha256: 'e'.repeat(64), qualification: { acknowledgement: 'containers-share-host-kernel-not-hostile-code-isolation', dedicatedLab: true, approvedBy: 'test-owner', expiresAt: new Date(f.selection.deadlineMs).toISOString(), nativeEnabled: false } } };
}
beforeEach(() => { vi.mocked(runFixedProcess).mockClear(); state.docker = 'missing-image'; });
describe('actual readiness and safe preparation', () => {
  it('cannot forge readiness or invoke any check without issued consent', async () => {
    const f = await fixture();
    try {
      await expect(checkPackReadiness({ consent: {} as PackConsent, configuration: f.boundary })).rejects.toThrow('CONSENT_REQUIRED');
      expect(() => materializePackGrant({ status: 'ready', report: { ok: true } } as QualifiedPacks)).toThrow('ACTUAL_READINESS_REQUIRED');
      expect(runFixedProcess).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it('expired consent and pre-aborted checks cannot launch setup or materialize grants', async () => {
    const f = await fixture();
    try {
      const c = await consent(f);
      const controller = new AbortController(); controller.abort();
      await expect(checkPackReadiness({ consent: c, configuration: f.boundary, signal: controller.signal })).rejects.toThrow('CANCELLED');
      const clock = vi.spyOn(Date, 'now').mockReturnValue(c.selection.deadlineMs + 1);
      try {
        await expect(checkPackReadiness({ consent: c, configuration: f.boundary })).rejects.toThrow('CONSENT_REQUIRED');
        await expect(prepareLocalPackAction({ consent: c, action: 'create-private-browser-profile-root', ui: new ContractUI() })).rejects.toThrow('CONSENT_REQUIRED');
      } finally { clock.mockRestore(); }
      expect(runFixedProcess).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it('real static filesystem/registry preflight succeeds without importing arbitrary repository JS', async () => {
    const f = await fixture();
    try {
      const marker = join(f.base, 'executed');
      await writeFile(join(f.target, 'untrusted.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'BAD'); throw new Error('imported');`);
      const result = await checkPackReadiness({ consent: await consent(f), configuration: f.boundary });
      expect(result.status).toBe('ready');
      if (result.status === 'ready') {
        expect(materializePackGrant(result).capabilities).toEqual(['source.analyze']);
        expect(result.report.checks.some(c => c.name === 'filesystem' && c.ok)).toBe(true);
        expect(() => materializePackGrant(structuredClone(result))).toThrow('ACTUAL_READINESS_REQUIRED');
      }
      expect(await readdir(f.base)).not.toContain('executed');
      expect(runFixedProcess).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it('missing image and permission refusal block, never prepare, download, repin or fake tools', async () => {
    const f = await fixture();
    try {
      const config = container(f), c = await consent(f, config);
      const before = JSON.stringify(config);
      const missing = await checkPackReadiness({ consent: c, configuration: config });
      expect(missing.status).toBe('blocked');
      if (missing.status === 'blocked') { expect(missing.blockers.some(b => b.category === 'image')).toBe(true); expect(missing.requiresUpdatedPlanApproval).toBe(true); expect(planOperatorSetup(missing.blockers).some(s => s.requiresSeparateParentApproval)).toBe(true); }
      state.docker = 'permission';
      const refused = await checkPackReadiness({ consent: c, configuration: config });
      expect(refused.status).toBe('blocked');
      if (refused.status === 'blocked') expect(refused.blockers.some(b => b.category === 'permission')).toBe(true);
      expect(JSON.stringify(config)).toBe(before);
      expect(vi.mocked(runFixedProcess).mock.calls.every(call => ['version', 'image'].includes(call[1][0]!))).toBe(true);
    } finally { await f.cleanup(); }
  });
  it('invalid image/layer pins fail before any engine command; callback configs refused', async () => {
    const f = await fixture();
    try {
      const config = container(f);
      if (config.kind !== 'container') throw new Error();
      config.settings.image = 'latest; touch /tmp/injected';
      const result = await checkPackReadiness({ consent: await consent(f, config), configuration: config });
      expect(result.status).toBe('blocked'); expect(runFixedProcess).not.toHaveBeenCalled();
      expect(() => packConfigurationDigest({ ...config, settings: { ...config.settings, runner: () => ({ code: 0 }) } } as unknown as PackBoundaryConfiguration)).toThrow('NOT_DATA');
      let accessed = false;
      expect(() => packConfigurationDigest({ ...config, settings: { ...config.settings, get image() { accessed = true; return 'malicious'; } } })).toThrow('NOT_DATA');
      expect(accessed).toBe(false);
      const good = container(f); if (good.kind === 'container') good.settings.imageRootfsLayers = [];
      expect((await checkPackReadiness({ consent: await consent(f, good), configuration: good })).status).toBe('blocked');
      expect(runFixedProcess).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it('repository executable pretending to be Chrome is refused before launch', async () => {
    const f = await fixture();
    try {
      const launcher = join(f.target, 'fake-chrome');
      await writeFile(launcher, '#!/bin/sh\ntouch "' + join(f.base, 'EXECUTED') + '"\n', { mode: 0o700 });
      const config: PackBoundaryConfiguration = { kind: 'host-browser', settings: { ...f.boundary.settings, browser: { acknowledgement: 'host-browser-not-container-isolated', approvedBy: 'owner', expiresAt: new Date(f.selection.deadlineMs).toISOString(), egress: 'loopback-only', profileRoot: join(f.base, 'profiles'), identity: { launcher, executable: launcher, launcherSha256: 'a'.repeat(64), executableSha256: 'b'.repeat(64), version: '1.2.3.4', product: 'Chrome/1.2.3.4' } } } };
      const result = await checkPackReadiness({ consent: await consent(f, config, ['browser']), configuration: config });
      expect(result.status).toBe('blocked');
      expect(await readdir(f.base)).not.toContain('EXECUTED');
      expect(runFixedProcess).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it('browser on wrong boundary blocks; differential never imports during preflight', async () => {
    const f = await fixture();
    try {
      const result = await checkPackReadiness({ consent: await consent(f, f.boundary, ['browser']), configuration: f.boundary });
      expect(result.status).toBe('blocked');
      const c = await consent(f, f.boundary, ['differential']);
      const trusted = await checkPackReadiness({ consent: c, configuration: f.boundary });
      expect(trusted.status).toBe('ready'); // qualification only, not execution
      expect(runFixedProcess).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it('cancel/headless prepare do nothing; explicit local preparation uses fixed argv without injection', async () => {
    const f = await fixture(); state.home = join(f.base, 'home;touch-INJECTED');
    try {
      await mkdir(state.home, { mode: 0o700 });
      await mkdir(join(state.home, '.p2o'), { mode: 0o700 });
      const c = await consent(f, f.boundary, ['browser']);
      const cancel = new ContractUI(); cancel.cancelAt = 1;
      expect(await prepareLocalPackAction({ consent: c, action: 'create-private-browser-profile-root', ui: cancel })).toBe('cancelled');
      expect(await prepareLocalPackAction({ consent: c, action: 'create-private-browser-profile-root' })).toBe('unsupported');
      expect(runFixedProcess).not.toHaveBeenCalled();
      await expect(prepareLocalPackAction({ consent: c, action: 'mkdir; echo INJECTED' as never, ui: new ContractUI() })).rejects.toThrow('UNKNOWN_RECIPE');
      await expect(prepareLocalPackAction({ consent: c, action: 'create-private-browser-profile-root', ui: new ContractUI(), argv: [';touch /tmp/evil'] } as Parameters<typeof prepareLocalPackAction>[0])).rejects.toThrow('FIXED_RECIPE_ONLY');
      expect(await prepareLocalPackAction({ consent: c, action: 'create-private-browser-profile-root', ui: new ContractUI() })).toBe('prepared');
      const shipped = describeLocalPreparation('create-private-browser-profile-root');
      expect(runFixedProcess).toHaveBeenCalledExactlyOnceWith('/usr/bin/mkdir', ['-m', '700', '--', join(state.home, '.p2o', 'browser-profiles')], expect.objectContaining({ timeoutMs: 2000 }));
      expect(shipped.argv).not.toContain(';touch /tmp/evil');
      await expect(readFile(join(f.base, 'evil'))).rejects.toThrow();
    } finally { await f.cleanup(); }
  });
  it('bounded proxy bind is actual and classification preserves distinct failures', async () => {
    expect((await probeProxyPort()).ok).toBe(true);
    expect((await probeProxyPort(-1)).ok).toBe(false);
    for (const [text, category] of [['permission denied', 'permission'], ['daemon not running', 'docker-daemon'], ['image missing', 'image'], ['rootfs layer mismatch', 'layer'], ['engine version', 'engine'], ['seccomp mismatch', 'seccomp'], ['browser-identity', 'chrome-identity'], ['browser-user-sandbox', 'user-sandbox'], ['proxy-port', 'proxy-config']] as const) expect(classifyPackFailure(text, '').category).toBe(category);
  });
});
