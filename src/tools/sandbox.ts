import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { checkCancelled, invariant, PolicyError } from '../policy/errors.js';
import { digest, deepFreeze, integer, text, timestamp } from '../policy/validation.js';
import { isForbiddenAddress, isLoopback } from '../policy/network.js';
import { SandboxFilesystem, type FilesystemOptions } from './filesystem.js';
import { verifyChromeIdentity, type ChromeIdentity } from './browser-identity.js';
import { analyzeSourceFiles } from './source.js';
import type { IsolationMode } from '../policy/index.js';
import type { PreflightReport, SourceEvidence, SourceFile } from './types.js';

export interface ExecutionSandbox {
  readonly mode: IsolationMode;
  readonly boundary: string;
  readonly configurationDigest: string;
  readonly filesystem: SandboxFilesystem;
  readonly nativeEnabled: boolean;
  /**
   * What code this boundary may execute. `trusted-local-modules` means owner-supplied modules may be
   * imported from the trusted read-only input snapshot into the controller process (the local-fixture
   * acknowledgement); it is NOT isolation from hostile code. Absent means `none`, so a custom boundary
   * fails closed for `fuzz.differential`.
   */
  readonly codeExecution?: 'none' | 'trusted-local-modules';
  /**
   * Present only for `host-browser`: the pinned browser identity and the explicit acknowledgement that
   * this boundary is a host process, not container isolation. `doctor` fails closed for browser
   * capabilities without it.
   */
  readonly browser?: HostBrowserBoundary;
  preflight(signal?: AbortSignal): Promise<PreflightReport>;
  assertEgress(address: string): void;
  analyzeSource(files: readonly SourceFile[], contains?: string, signal?: AbortSignal): Promise<SourceEvidence>;
  inspectNative(path: string, signal?: AbortSignal): Promise<unknown>;
}
export interface FixtureSandboxOptions extends FilesystemOptions {
  acknowledgement: 'local-fixtures-only-not-hostile-code-isolation';
}
/** Safe only for inert local fixtures and trusted broker code. Never executes target code. */
export function createLocalFixtureSandbox(options: FixtureSandboxOptions): ExecutionSandbox {
  invariant(options.acknowledgement === 'local-fixtures-only-not-hostile-code-isolation', 'UNAVAILABLE', 'Local fixture mode requires explicit limited-isolation acknowledgement');
  const filesystem = new SandboxFilesystem(options);
  let ready = false;
  const boundary = 'local-fixture:trusted-broker-only:no-hostile-code-isolation';
  return Object.freeze({
    mode: 'local-fixture', boundary, configurationDigest: digest({ mode: 'local-fixture', ...options }), filesystem, nativeEnabled: false, codeExecution: 'trusted-local-modules',
    async preflight(signal?: AbortSignal) {
      checkCancelled(signal);
      const report = await filesystem.preflight(); checkCancelled(signal); ready = report.ok;
      return deepFreeze({ ...report, boundary, checks: [...report.checks, { name: 'fixture-limits', ok: true, detail: 'Loopback HTTP only; no process execution, JS browser or hostile workers' }] });
    },
    assertEgress(address: string) { invariant(ready && isLoopback(address), 'ADDRESS_DENIED', 'Local fixture egress is loopback-only'); },
    async analyzeSource(files: readonly SourceFile[], contains?: string, signal?: AbortSignal) {
      invariant(ready, 'UNAVAILABLE', 'Sandbox has not passed preflight'); checkCancelled(signal);
      return analyzeSourceFiles(files, contains, signal);
    },
    async inspectNative() { throw new PolicyError('UNAVAILABLE', 'Native tools require an explicitly qualified dedicated container/VM lab'); },
  });
}

/**
 * Real headless browser on the host. This boundary is deliberately not `container`: the pinned Chrome
 * binary executes with host kernel privileges inside a private throwaway profile. Containment is
 * provided by (a) the broker capability gate, (b) per-navigation/per-request scope authorization at the
 * CDP layer, (c) a mandatory loopback egress proxy that pins DNS/IP and refuses non-scope requests, and
 * (d) an attempt-bound, TTL-bounded session lifetime. It is never a fallback for failed container
 * isolation and never reported as one.
 */
export interface HostBrowserBoundary {
  readonly enabled: true;
  readonly acknowledgement: 'host-browser-not-container-isolated';
  readonly approvedBy: string;
  readonly expiresAt: string;
  /** `loopback-only` is the fixture default; `policy-scope` allows approved CIDRs after policy checks. */
  readonly egress: 'loopback-only' | 'policy-scope';
  /** Private root for per-session `--user-data-dir` profiles; must be owner-only. */
  readonly profileRoot: string;
  readonly maxSessions: number;
  readonly sessionTtlMs: number;
  readonly maxActionsPerSession: number;
  readonly maxRequestsPerSession: number;
  readonly identity: ChromeIdentity;
}
export interface HostBrowserSandboxOptions extends FilesystemOptions {
  browser: {
    acknowledgement: 'host-browser-not-container-isolated';
    approvedBy: string;
    expiresAt: string;
    egress: 'loopback-only' | 'policy-scope';
    profileRoot: string;
    maxSessions?: number;
    sessionTtlMs?: number;
    maxActionsPerSession?: number;
    maxRequestsPerSession?: number;
    identity: ChromeIdentity;
  };
}
function boundaryOf(settings: HostBrowserSandboxOptions): HostBrowserBoundary {
  const b = settings.browser;
  invariant(b.acknowledgement === 'host-browser-not-container-isolated', 'UNAVAILABLE', 'Host browser mode requires the explicit not-container-isolation acknowledgement');
  text(b.approvedBy, 'browser.approvedBy', 128); timestamp(b.expiresAt, 'browser.expiresAt');
  invariant(b.egress === 'loopback-only' || b.egress === 'policy-scope', 'INVALID_INPUT', 'Unknown browser egress policy');
  const hostConfigRoots = [join(homedir(), '.config'), join(homedir(), '.local', 'share'), join(homedir(), '.mozilla'), join(homedir(), '.cache', 'google')];
  invariant(isAbsolute(b.profileRoot) && resolve(b.profileRoot) === b.profileRoot && b.profileRoot !== sep && b.profileRoot !== homedir() && hostConfigRoots.every(root => b.profileRoot !== root && !b.profileRoot.startsWith(`${root}${sep}`)) && ![sep, '/proc', '/sys', '/dev', '/run', '/var/run'].includes(b.profileRoot), 'FILESYSTEM_DENIED', 'Browser profile root must be a private absolute path that is not the host profile/config tree');
  const id = b.identity;
  invariant(id && typeof id === 'object', 'INVALID_INPUT', 'Pinned browser identity is required');
  invariant(isAbsolute(id.launcher) && isAbsolute(id.executable), 'INVALID_INPUT', 'Pinned browser paths must be absolute');
  for (const [label, value] of [['launcherSha256', id.launcherSha256], ['executableSha256', id.executableSha256]] as const) invariant(/^[a-f0-9]{64}$/.test(value), 'INVALID_INPUT', `Pinned ${label} must be a sha256 hex digest`);
  text(id.version, 'browser.identity.version', 64);
  text(id.product, 'browser.identity.product', 128);
  return deepFreeze({
    enabled: true as const, acknowledgement: b.acknowledgement, approvedBy: b.approvedBy, expiresAt: b.expiresAt, egress: b.egress, profileRoot: b.profileRoot,
    maxSessions: integer(b.maxSessions ?? 2, 'browser.maxSessions', 1, 8),
    sessionTtlMs: integer(b.sessionTtlMs ?? 300000, 'browser.sessionTtlMs', 1000, 3600000),
    maxActionsPerSession: integer(b.maxActionsPerSession ?? 64, 'browser.maxActionsPerSession', 1, 1024),
    maxRequestsPerSession: integer(b.maxRequestsPerSession ?? 256, 'browser.maxRequestsPerSession', 1, 4096),
    identity: deepFreeze({ ...id }),
  });
}
/** Explicitly acknowledged host-browser boundary; the p2o browser pack is the only capability family allowed on it. */
export function createHostBrowserSandbox(settings: HostBrowserSandboxOptions): ExecutionSandbox {
  const browser = boundaryOf(settings);
  const filesystem = new SandboxFilesystem(settings);
  let ready = false;
  let preflightFailure: string | undefined;
  const boundary = `host-browser:not-container-isolated:chrome-${browser.identity.version}:scope-enforced-at-cdp-and-egress-proxy`;
  const configurationDigest = digest({ mode: 'host-browser', inputRoot: filesystem.inputRoot, outputRoot: filesystem.outputRoot, browser: { ...browser, identity: browser.identity } });
  return Object.freeze({
    mode: 'host-browser' as const, boundary, configurationDigest, filesystem, nativeEnabled: false, browser, codeExecution: 'none',
    async preflight(signal?: AbortSignal) {
      checkCancelled(signal);
      const report = await filesystem.preflight(); checkCancelled(signal);
      const checks: { name: string; ok: boolean; detail: string }[] = [...report.checks];
      let identityOk = true;
      try { await verifyChromeIdentity(browser.identity, signal); } catch { identityOk = false; }
      checks.push({ name: 'browser-identity', ok: identityOk, detail: `Pinned Chrome ${browser.identity.version} re-hashed from disk (launcher + executable); identity drift is refused` });
      let profileOk = true;
      try {
        const stat = await lstat(browser.profileRoot);
        profileOk = stat.isDirectory() && (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid());
      } catch { profileOk = false; }
      checks.push({ name: 'browser-profile-root', ok: profileOk, detail: 'Per-session throwaway profiles live under an owner-only root; the host profile and credentials are never used' });
      const live = Date.now() < Date.parse(browser.expiresAt);
      checks.push({ name: 'browser-acknowledgement', ok: live, detail: `Host process is not container isolation; acknowledged by ${browser.approvedBy} until ${browser.expiresAt}` });
      ready = report.ok && identityOk && profileOk && live;
      if (!identityOk) preflightFailure = 'browser-identity';
      else if (!profileOk) preflightFailure = 'browser-profile';
      else if (!live) preflightFailure = 'browser-acknowledgement';
      return deepFreeze({ ok: ready, boundary, checks });
    },
    assertEgress(address: string) {
      invariant(ready && preflightFailure === undefined, 'UNAVAILABLE', `Host browser sandbox is not ready${preflightFailure ? ` (${preflightFailure})` : ''}`);
      invariant(browser.egress === 'loopback-only' ? isLoopback(address) : !isForbiddenAddress(address), 'ADDRESS_DENIED', 'Address is outside the host browser egress policy');
    },
    async analyzeSource(files: readonly SourceFile[], contains?: string, signal?: AbortSignal) {
      invariant(ready, 'UNAVAILABLE', 'Sandbox has not passed preflight'); checkCancelled(signal);
      return analyzeSourceFiles(files, contains, signal);
    },
    async inspectNative() { throw new PolicyError('UNAVAILABLE', 'Native tools require an explicitly qualified dedicated container/VM lab'); },
  });
}
