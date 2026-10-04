import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalJSON, configurationDigest, consentCovers, ownerUid, scopeKey, validateOwnerConfiguration } from './configuration.js';
import { OnboardingError, type OwnerConfiguration, type OwnerConsentBundle, type OwnerLimits, type OwnerPermissions, type OwnerScope } from './types.js';

export function defaultOwnerStorageRoot(): string { return join(homedir(), '.p2o', 'onboarding'); }
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === '' || (!suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && suffix !== '..' && !isAbsolute(suffix));
}
/** Lexical scope checks only; inspecting the target to choose where to save would violate plan-only. */
export function assertStorageOutsideTarget(root: string, cwd: string, scope: OwnerScope): void {
  if (!isAbsolute(root) || resolve(root) !== root || root === '/') unsafe('storage root must be a canonical absolute private path');
  const local = scope.target.kind === 'local-dir' ? scope.target.locator : undefined;
  if (contains(resolve(cwd), root) || contains(root, resolve(cwd)) ||
    (local && (contains(local, root) || contains(root, local)))) unsafe('owner storage must be outside the working directory and target tree');
}
function unsafe(message: string): never { throw new OnboardingError('ONBOARDING_STORAGE_UNSAFE', message); }
async function directory(path: string, privateRoot = false): Promise<boolean> {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (missing(error)) return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe('owner storage may not traverse links or non-directories');
  const uid = ownerUid();
  if (privateRoot && (stat.uid !== uid || (stat.mode & 0o077) !== 0)) unsafe('owner storage directory must be owner-only (0700)');
  if (!privateRoot && stat.uid !== uid && stat.uid !== 0) unsafe('owner storage ancestors must be controlled by the owner or root');
  // A root-owned sticky /tmp is safe as an ancestor, not as the private root itself.
  if ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0 && !privateRoot)) unsafe('owner storage has a writable ancestor');
  if (await realpath(path) !== path) unsafe('owner storage path must be canonical with no symlink ancestors');
  return true;
}
async function checkRoot(root: string, create = false): Promise<boolean> {
  if (!isAbsolute(root) || resolve(root) !== root || root === '/') unsafe('owner storage path must be canonical and absolute');
  const chain: string[] = [];
  for (let path = root; path !== dirname(path); path = dirname(path)) chain.unshift(path);
  let exists = true;
  for (const path of chain) {
    if (await directory(path, path === root)) continue;
    exists = false;
    if (!create) continue;
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await directory(path, true);
  }
  return create || exists;
}
export function ownerConfigPath(root: string, scope: OwnerScope): string { return join(root, `${scopeKey(scope)}.json`); }
async function readBundle(path: string): Promise<OwnerConsentBundle | null> {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== ownerUid() || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024) {
    unsafe('owner configuration must be a bounded owner-only regular file (0600), not a link');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.uid !== ownerUid() || (opened.mode & 0o077) !== 0 || opened.nlink !== 1) unsafe('owner configuration changed while opening');
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const bytes = buffer.subarray(0, total);
    if (bytes.byteLength > 64 * 1024) unsafe('owner configuration exceeds 64KiB');
    let bundle: OwnerConsentBundle;
    try { bundle = JSON.parse(bytes.toString('utf8')) as OwnerConsentBundle; }
    catch { throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'owner configuration is not valid JSON'); }
    if (!bundle || Object.keys(bundle).sort().join('|') !== 'configuration|receipt|schemaVersion' || bundle.schemaVersion !== 1) {
      throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'unsupported owner consent bundle');
    }
    const configuration = validateOwnerConfiguration(bundle.configuration);
    const receipt = bundle.receipt;
    const keys = ['schemaVersion', 'receiptId', 'source', 'kind', 'ownerUid', 'confirmedAt', 'configurationDigest', 'previousConfigurationDigest', 'disclosureVersion'];
    if (!receipt || Object.keys(receipt).sort().join('|') !== keys.sort().join('|') || receipt.schemaVersion !== 1 ||
      receipt.source !== 'human-ui' || receipt.kind !== 'scope-consent-not-plan-approval' || receipt.ownerUid !== ownerUid() || receipt.disclosureVersion !== 1 ||
      typeof receipt.receiptId !== 'string' || !/^consent-[0-9a-f-]{36}$/.test(receipt.receiptId) ||
      typeof receipt.confirmedAt !== 'string' || !Number.isFinite(Date.parse(receipt.confirmedAt)) || new Date(receipt.confirmedAt).toISOString() !== receipt.confirmedAt ||
      configuration.limits.deadlineMs <= Date.parse(receipt.confirmedAt) || receipt.configurationDigest !== configurationDigest(configuration) ||
      (receipt.previousConfigurationDigest !== null && (typeof receipt.previousConfigurationDigest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.previousConfigurationDigest)))) {
      throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'consent receipt provenance or configuration digest is invalid');
    }
    if (ownerConfigPath(dirname(path), configuration.scope) !== path) throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 'configuration filename is not bound to its scope');
    return { schemaVersion: 1, configuration, receipt: Object.freeze(receipt) };
  } finally { await handle.close(); }
}
/** Read both records and validate permissions, provenance, canonical schema and the configuration digest. */
export async function readOwnerConsent(path: string): Promise<OwnerConsentBundle> {
  if (!isAbsolute(path) || resolve(path) !== path || !/^[a-f0-9]{64}\.json$/.test(path.slice(path.lastIndexOf('/') + 1))) unsafe('configuration path must be canonical');
  if (!(await checkRoot(dirname(path)))) throw new OnboardingError('ONBOARDING_CONFIG_NOT_FOUND', 'owner storage does not exist');
  const bundle = await readBundle(path);
  if (!bundle) throw new OnboardingError('ONBOARDING_CONFIG_NOT_FOUND', 'owner configuration does not exist');
  return bundle;
}
export async function readOwnerConfiguration(path: string): Promise<OwnerConfiguration> { return (await readOwnerConsent(path)).configuration; }
export async function findOwnerConsent(root: string, scope: OwnerScope, limits?: Partial<OwnerLimits>, permissions?: Partial<OwnerPermissions>, now?: number): Promise<OwnerConsentBundle | null> {
  if (!(await checkRoot(root))) return null;
  const exact = await readBundle(ownerConfigPath(root, scope));
  if (exact || scope.target.kind !== 'local-dir') return exact;
  // Inspect ONLY owner-private records, never the target, to reuse a parent directory's narrowing grant.
  const names = (await readdir(root)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  if (names.length > 1024) throw new OnboardingError('ONBOARDING_CONFIG_LIMIT', 'too many owner profiles for bounded scope lookup');
  const candidates: OwnerConsentBundle[] = [];
  for (const name of names) {
    const bundle = await readBundle(join(root, name));
    if (bundle && consentCovers(bundle.configuration, scope, limits, permissions, now)) candidates.push(bundle);
  }
  return candidates.sort((a, b) => b.configuration.scope.target.locator.length - a.configuration.scope.target.locator.length)[0] ?? null;
}
/** Internal UI service publication. No model-callable surface. One rename publishes config + receipt together. */
export async function publishOwnerConsent(root: string, configuration: OwnerConfiguration, previousDigest: string | null, now: number): Promise<string> {
  configuration = validateOwnerConfiguration(configuration);
  if (configuration.limits.deadlineMs <= now) throw new OnboardingError('ONBOARDING_INVALID_INPUT', 'consent deadline expired before publication');
  await checkRoot(root, true);
  const lock = join(root, '.publish-lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new OnboardingError('ONBOARDING_CONFIG_BUSY', 'another owner consent publication is in progress; retry interactively');
    throw error;
  }
  const path = ownerConfigPath(root, configuration.scope), temporary = join(root, `.pending-${randomUUID()}`);
  try {
    const current = await readBundle(path);
    if ((current?.receipt.configurationDigest ?? null) !== previousDigest) throw new OnboardingError('ONBOARDING_CONFIG_CHANGED', 'consent changed during the dialog; review it again');
    const bundle: OwnerConsentBundle = { schemaVersion: 1, configuration, receipt: {
      schemaVersion: 1, receiptId: `consent-${randomUUID()}`, source: 'human-ui', kind: 'scope-consent-not-plan-approval',
      ownerUid: ownerUid(), confirmedAt: new Date(now).toISOString(), configurationDigest: configurationDigest(configuration),
      previousConfigurationDigest: previousDigest, disclosureVersion: 1,
    } };
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${canonicalJSON(bundle)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    const dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await dir.sync(); } finally { await dir.close(); }
    return path;
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

/** Separate pack-consent data, using the same private root/atomic publication rules. No executable config. */
export async function readOwnerDocument(root: string, key: string): Promise<unknown | null> {
  if (!/^packs-[a-f0-9]{64}$/.test(key)) unsafe('invalid pack document key');
  if (!await checkRoot(root)) return null;
  const path = join(root, `${key}.json`);
  let stat;
  try { stat = await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== ownerUid() || (stat.mode & 0o077) !== 0 || stat.size > 65536) unsafe('unsafe pack document');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 65536) unsafe('pack document changed');
    const buffer = Buffer.alloc(65537);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > 65536) unsafe('oversized pack document');
    return JSON.parse(buffer.subarray(0, total).toString('utf8')) as unknown;
  } finally { await handle.close(); }
}
export async function publishOwnerDocument(root: string, key: string, value: unknown): Promise<void> {
  if (!/^packs-[a-f0-9]{64}$/.test(key)) unsafe('invalid pack document key');
  const bytes = canonicalJSON(value);
  if (Buffer.byteLength(bytes) > 65536) unsafe('oversized pack document');
  await checkRoot(root, true);
  const temporary = join(root, `.pending-${randomUUID()}`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(root, `${key}.json`));
    const dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await rm(temporary, { force: true }); }
}
