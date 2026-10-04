import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, dirname, join } from 'node:path';
import { invariant, PolicyError } from '../policy/errors.js';
import { deepFreeze, digest, text } from '../policy/validation.js';

/**
 * Pinned identity of the browser the host-browser boundary may execute. Two files are pinned because
 * every shipped launcher (`/usr/bin/google-chrome`, `/usr/bin/chromium`, ...) is a shell wrapper around a
 * real ELF binary: hashing only the wrapper would not notice a replaced browser, hashing only the ELF
 * would not notice a replaced launcher. `version` is cross-checked against both `--version` and the
 * CDP `Browser.getVersion` product string, so a binary that lies about its identity is refused too.
 */
export interface ChromeIdentity {
  /** Absolute path of the launcher that is actually spawned (`--version` is read from it). */
  readonly launcher: string;
  readonly launcherSha256: string;
  /** Absolute path of the ELF executable the launcher resolves to. */
  readonly executable: string;
  readonly executableSha256: string;
  /** e.g. `153.0.8010.52`; must match the launcher's `--version` and the CDP product version. */
  readonly version: string;
  /** Expected CDP product prefix, e.g. `Chrome/153.0.8010.52`. */
  readonly product: string;
}
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const VERSION_PATTERN = /(\d+\.\d+\.\d+\.\d+)/;
// No cache: the pin is a security control, so every preflight/open re-hashes the real bytes. A cache keyed
// on size/mtime could be defeated by a same-size replacement that preserves timestamps.
async function hashFile(path: string): Promise<string> {
  const before = await lstat(path);
  invariant(before.isFile() && before.nlink >= 1 && before.size > 0, 'UNAVAILABLE', 'Pinned browser file is not a readable regular file');
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', () => reject(new PolicyError('UNAVAILABLE', 'Pinned browser file could not be read')));
    stream.once('end', () => resolve());
  });
  const after = await lstat(path);
  invariant(after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs, 'UNAVAILABLE', 'Pinned browser file changed while it was being hashed');
  return hash.digest('hex');
}

function launcherVersion(launcher: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(launcher, ['--version'], { timeout: timeoutMs, maxBuffer: 16384, signal, windowsHide: true, env: {} }, (error, stdout, stderr) => {
      if (error) { reject(new PolicyError('UNAVAILABLE', 'Pinned browser launcher did not report a version')); return; }
      const match = VERSION_PATTERN.exec(`${stdout}\n${stderr}`);
      if (!match) { reject(new PolicyError('UNAVAILABLE', 'Pinned browser launcher did not report a recognizable version')); return; }
      resolve(match[1]!);
    });
    child.on('error', () => reject(new PolicyError('UNAVAILABLE', 'Pinned browser launcher could not be executed')));
  });
}

async function isElf(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size < 1_000_000 || (stat.mode & 0o111) === 0) return false;
    const handle = await access(path, constants.X_OK).then(() => true, () => false);
    if (!handle) return false;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path, { start: 0, end: 3 });
      stream.on('data', chunk => chunks.push(chunk as Buffer));
      stream.once('error', () => reject(new Error('unreadable')));
      stream.once('end', () => resolve());
    });
    const head = Buffer.concat(chunks);
    return head.length === 4 && head.equals(ELF);
  } catch { return false; }
}

/**
 * Discover and pin the launcher and the ELF binary behind it. Fails closed when no executable browser can
 * be identified; no fallback browser is ever selected silently.
 */
export async function discoverChromeIdentity(launcher = '/usr/bin/google-chrome', options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ChromeIdentity> {
  invariant(isAbsolute(launcher), 'INVALID_INPUT', 'Browser launcher must be an absolute path');
  const resolved = await realpath(launcher).catch(() => { throw new PolicyError('UNAVAILABLE', 'Browser launcher is missing'); });
  invariant(isAbsolute(resolved), 'UNAVAILABLE', 'Browser launcher could not be resolved');
  const candidates = [...new Set([resolved, join(dirname(resolved), 'chrome'), join(dirname(resolved), 'chromium'), '/opt/google/chrome/chrome', '/usr/lib/chromium/chromium', '/usr/lib/chromium-browser/chromium'])];
  let executable: string | undefined;
  for (const candidate of candidates) if (await isElf(candidate)) { executable = candidate; break; }
  invariant(executable, 'UNAVAILABLE', 'No pinned browser ELF executable found behind the launcher; refusing to guess');
  const version = await launcherVersion(launcher, options.timeoutMs ?? 5000, options.signal);
  return deepFreeze({
    launcher: resolved, launcherSha256: await hashFile(resolved),
    executable, executableSha256: await hashFile(executable),
    version, product: `Chrome/${version}`,
  });
}

/**
 * Re-prove the pin at preflight/launch time: both files must still hash to the pinned digests and the
 * launcher must still report the pinned version. Identity drift is refused before a process is spawned.
 */
export async function verifyChromeIdentity(identity: ChromeIdentity, signal?: AbortSignal): Promise<void> {
  invariant(identity && typeof identity === 'object', 'INVALID_INPUT', 'Pinned browser identity is required');
  for (const [label, value] of [['launcherSha256', identity.launcherSha256], ['executableSha256', identity.executableSha256]] as const) invariant(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_INPUT', `Pinned ${label} must be a sha256 hex digest`);
  text(identity.version, 'browser.identity.version', 64);
  const [launcherSha256, executableSha256] = await Promise.all([hashFile(identity.launcher), hashFile(identity.executable)]);
  invariant(launcherSha256 === identity.launcherSha256 && executableSha256 === identity.executableSha256, 'UNAVAILABLE', 'Pinned browser binary identity changed; refusing to launch');
  const version = await launcherVersion(identity.launcher, 5000, signal);
  invariant(version === identity.version, 'UNAVAILABLE', 'Pinned browser version changed; refusing to launch');
}
/** Stable digest of the pin; recorded in receipts so a browser observation names the exact binary identity. */
export function chromeIdentityDigest(identity: ChromeIdentity): string {
  return digest({ launcher: identity.launcher, launcherSha256: identity.launcherSha256, executable: identity.executable, executableSha256: identity.executableSha256, version: identity.version, product: identity.product });
}
