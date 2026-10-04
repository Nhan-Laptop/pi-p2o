import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createContainerSandbox, type ContainerSandboxOptions } from '../../tools/container.js';
import { createHostBrowserSandbox, createLocalFixtureSandbox } from '../../tools/sandbox.js';
import { createDefaultRegistry, doctor } from '../../tools/registry.js';
import { runFixedProcess } from '../../tools/process.js';
import { deepFreeze } from '../../policy/validation.js';
import { packConfigurationDigest, type PackBoundaryConfiguration } from './configuration.js';
export { packConfigurationDigest, type PackBoundaryConfiguration } from './configuration.js';
import type { TargetBudget } from '../../policy/budget.js';
import type { Action, Capability } from '../../policy/types.js';
import type { PreflightReport } from '../../tools/types.js';
import { assertPackConsent, type PackConsent } from '../onboarding/packs.js';
import { capabilitiesFor } from './catalog.js';
import { probeChromeSandbox, probeProxyPort } from './probes.js';

export interface QualifiedPacks {
  status: 'ready';
  consent: PackConsent;
  configuration: PackBoundaryConfiguration;
  capabilities: Capability[];
  report: PreflightReport;
  checkedAt: number;
  validUntil: number;
}
export interface PackBlocker { category: 'docker-daemon' | 'permission' | 'image' | 'layer' | 'engine' | 'seccomp' | 'chrome-identity' | 'user-sandbox' | 'proxy-config' | 'qualification'; check: string; detail: string }
export function classifyPackFailure(name: string, detail: string): PackBlocker {
  const text = `${name} ${detail}`.toLowerCase();
  const category: PackBlocker['category'] = /permission denied|eacces|eperm/.test(text) ? 'permission' : /seccomp/.test(text) ? 'seccomp' : /layer|rootfs/.test(text) ? 'layer' : /image|no such object/.test(text) ? 'image' : /daemon|cannot connect/.test(text) ? 'docker-daemon' : /engine|client|server version/.test(text) ? 'engine' : /user-sandbox/.test(text) ? 'user-sandbox' : /browser-identity|chrome/.test(text) ? 'chrome-identity' : /proxy|port/.test(text) ? 'proxy-config' : 'qualification';
  return { category, check: name, detail };
}
const verified = new WeakSet<object>();
/** Consent is required BEFORE all probes. Uses real shipped sandboxes and registry doctor; no injected success port. */
export async function checkPackReadiness(input: { consent: PackConsent; configuration: PackBoundaryConfiguration; budgets?: TargetBudget; signal?: AbortSignal;
  controllerLifecycle?: ContainerSandboxOptions['controllerLifecycle'] }): Promise<QualifiedPacks | { status: 'blocked'; report: PreflightReport; blockers: PackBlocker[]; requiresUpdatedPlanApproval: true }> {
  assertPackConsent(input.consent);
  if (packConfigurationDigest(input.configuration) !== input.consent.selection.configurationDigest) throw new Error('PACK_CONFIG_NOT_CONSENTED');
  const configuration = structuredClone(input.configuration);
  const deadlineSignal = AbortSignal.timeout(Math.min(2_147_483_647, Math.max(1, input.consent.selection.deadlineMs - Date.now())));
  const signal = input.signal ? AbortSignal.any([input.signal, deadlineSignal]) : deadlineSignal;
  let close: (() => Promise<void>) | undefined;
  const capabilities = capabilitiesFor(input.consent.selection);
  const checks: Array<PreflightReport['checks'][number]> = [];
  let boundary: string = configuration.kind;
  try {
    if (configuration.kind === 'container') {
      const s = configuration.settings;
      if (!/^(?:sha256:[a-f0-9]{64}|[\w./:-]+@sha256:[a-f0-9]{64})$/.test(s.image) ||
        !Array.isArray(s.imageRootfsLayers) || !s.imageRootfsLayers.length || s.imageRootfsLayers.length > 1024 || s.imageRootfsLayers.some(l => !/^sha256:[a-f0-9]{64}$/.test(l))) throw new Error('image layer pins missing/invalid; never re-pin');
      if (![s.workerSha256, s.sourceSha256, s.seccompSha256].every(pin => typeof pin === 'string' && /^[a-f0-9]{64}$/.test(pin))) throw new Error('pack/seccomp identity pins missing or invalid');
      if (s.baseImageId !== undefined && !/^sha256:[a-f0-9]{64}$/.test(s.baseImageId)) throw new Error('base image identity pin invalid');
      if (!['/usr/bin/docker', '/usr/local/bin/docker'].includes(s.enginePath)) throw new Error('engine path invalid');
      const version = await runFixedProcess(s.enginePath, ['version', '--format', '{{json .}}'], { timeoutMs: 5000, maxOutputBytes: 65536, signal });
      checks.push({ name: 'docker-daemon', ok: version.code === 0, detail: version.code === 0 ? 'Docker daemon responded' : version.stderr.slice(0, 1024) });
      if (version.code !== 0) throw new Error('docker daemon unavailable; permission refusal requires operator intervention');
      assertPackConsent(input.consent);
      const image = await runFixedProcess(s.enginePath, ['image', 'inspect', s.image], { timeoutMs: 5000, maxOutputBytes: 1048576, signal });
      checks.push({ name: 'image', ok: image.code === 0, detail: image.code === 0 ? 'Pinned image installed locally; no pull attempted' : image.stderr.slice(0, 1024) });
      if (image.code !== 0) throw new Error('image missing; separate parent approval required for downloads/builds');
      const seccomp = await readPinnedSeccomp(s.seccompPath);
      checks.push({ name: 'seccomp', ok: digestBytes(seccomp) === s.seccompSha256, detail: 'Pinned local seccomp bytes checked; no system policy changes' });
      if (digestBytes(seccomp) !== s.seccompSha256) throw new Error('seccomp pin mismatch');
    }
    if (configuration.kind === 'host-browser') {
      const id = configuration.settings.browser.identity;
      if (!id || !['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/google-chrome', '/opt/google/chrome/chrome'].includes(id.launcher) ||
        !['/opt/google/chrome/chrome', '/usr/lib/chromium/chromium', '/usr/lib/chromium-browser/chromium', '/usr/bin/chromium'].includes(id.executable)) throw new Error('Chrome identity must name an operator-installed shipped browser path, not repository code or arbitrary executable');
    }
    if (configuration.kind === 'trusted-local' && configuration.trustedOwnerModules !== true) throw new Error('trusted owner module acknowledgement required');
    if (capabilities.includes('fuzz.differential') && configuration.kind !== 'trusted-local') throw new Error('differential fuzz requires privileged trusted owner modules; untrusted repository JS refused');
    const sandbox = configuration.kind === 'container' ? createContainerSandbox({ ...configuration.settings, controllerLifecycle: input.controllerLifecycle }) : configuration.kind === 'host-browser' ? createHostBrowserSandbox(configuration.settings) : createLocalFixtureSandbox(configuration.settings);
    if (configuration.kind === 'container') close = () => sandboxClose(sandbox);
    boundary = sandbox.boundary;
    const registry = createDefaultRegistry({ browser: capabilities.some(c => c.startsWith('browser.')), fuzz: capabilities.some(c => c.startsWith('fuzz.')) });
    assertPackConsent(input.consent);
    const report = await doctor({ sandbox, registry, required: capabilities, budgets: input.budgets, signal });
    checks.push(...report.checks, { name: 'registry-doctor', ok: report.ok, detail: 'Actual shipped sandbox/registry qualification must pass' });
    assertPackConsent(input.consent);
    if (report.ok && sandbox.browser && capabilities.includes('browser.session')) checks.push(await probeChromeSandbox(sandbox.browser, signal));
    assertPackConsent(input.consent);
    if (report.ok && capabilities.some(c => c.startsWith('proxy.') || c.startsWith('browser.'))) checks.push(await probeProxyPort());
  } catch (error) {
    checks.push({ name: 'qualification', ok: false, detail: error instanceof Error ? error.message.slice(0, 2048) : 'Unknown preflight refusal' });
  } finally {
    if (close) {
      try { await close(); } catch { checks.push({ name: 'termination-verified', ok: false, detail: 'Container cleanup unresolved; readiness refused' }); }
    }
  }
  if (signal.aborted) throw new Error('PACK_CHECK_CANCELLED_OR_EXPIRED');
  assertPackConsent(input.consent);
  const report: PreflightReport = deepFreeze({ ok: checks.length > 0 && checks.every(c => c.ok), boundary, checks });
  if (!report.ok) return { status: 'blocked', report, blockers: checks.filter(c => !c.ok).map(c => classifyPackFailure(c.name, c.detail)), requiresUpdatedPlanApproval: true };
  const ready: QualifiedPacks = deepFreeze({ status: 'ready', consent: input.consent, configuration, capabilities, report, checkedAt: Date.now(), validUntil: Math.min(Date.now() + 60_000, input.consent.selection.deadlineMs) });
  verified.add(ready);
  return ready;
}
import { createHash } from 'node:crypto';
const digestBytes = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function readPinnedSeccomp(path: string): Promise<Buffer> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || await realpath(path) !== path) throw new Error();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 65536) throw new Error();
      const buffer = Buffer.alloc(65537);
      let total = 0;
      while (total < buffer.length) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total); if (!bytesRead) break; total += bytesRead; }
      if (total > 65536) throw new Error();
      return buffer.subarray(0, total);
    } finally { await handle.close(); }
  } catch { throw new Error('seccomp profile missing, unreadable, unbounded or unsafe'); }
}
async function sandboxClose(sandbox: unknown): Promise<void> { await (sandbox as { close(): Promise<void> }).close(); }
export interface PackGrantMaterial {
  scopeDigest: string; configurationDigest: string; consentDigest: string;
  capabilities: Capability[]; actions: Action[]; maxRequests: number; maxCalls: number; expiresAt: string;
}
/** Material only: integration binds target/account/task/attempt IDs AFTER separate exact plan approval. */
export function materializePackGrant(ready: QualifiedPacks): PackGrantMaterial {
  if (!verified.has(ready) || !ready.report.ok || Date.now() >= ready.validUntil) throw new Error('PACK_ACTUAL_READINESS_REQUIRED');
  assertPackConsent(ready.consent);
  const s = ready.consent.selection;
  return deepFreeze({ scopeDigest: ready.consent.scopeDigest, configurationDigest: s.configurationDigest, consentDigest: ready.consent.digest,
    capabilities: [...ready.capabilities], actions: [...s.actions], maxRequests: s.maxRequests, maxCalls: s.maxCalls, expiresAt: new Date(s.deadlineMs).toISOString() });
}
