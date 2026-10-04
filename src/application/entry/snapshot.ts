/** One bounded source view for preparation, acquisition and container binding. Never executes source. */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson } from '../../contracts/index.js';
import { entryFail, safeText } from './errors.js';
import type { EntryBounds, EntryObserver } from './types.js';

export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage',
  '.cache', '.next', '.nuxt', '.turbo', '.parcel-cache', '__pycache__', '.venv', 'venv', '.tox',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.terraform', '.gradle', '.mvn', '.idea', '.vscode',
  '.aws', '.ssh', '.gnupg', '.docker', '.kube', '.npm', '.yarn', '.pnpm-store', '.gitlab',
]);
const EXCLUDED_FILES: ReadonlyArray<RegExp> = [
  /^\.env(?:\.|$)/i,
  /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.jks$/i, /\.keystore$/i, /\.kdbx$/i, /\.ppk$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i,
  /^\.npmrc$/i, /^\.netrc$/i, /^\.git-credentials$/i, /^\.htpasswd$/i, /^\.pgpass$/i, /^\.my\.cnf$/i,
  /^\.pypirc$/i, /^\.envrc$/i, /^\.direnv$/i, /^auth\.json$/i, /^credentials(?:\.json)?$/i,
  /^secrets?(?:\.|$)/i, /\.secret$/i, /\.secrets$/i, /^service-account.*\.json$/i, /\.jwt$/i,
  /^terraform\.tfstate/i, /\.tfvars$/i,
];
// Same unambiguous names the broker accepts. Avoid silently acquiring unaddressable source paths.
const UNSAFE_NAME = /[/\\:%\u0000-\u001f\u007f]/;
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function isExcludedRelativePath(path: string): boolean {
  const segments = path.split('/');
  return segments.some(segment => EXCLUDED_DIRECTORIES.has(segment)) || EXCLUDED_FILES.some(pattern => pattern.test(segments.at(-1) ?? ''));
}
export interface EntryTreeFingerprint {
  digest: string;
  files: number;
  bytes: number;
  samplePaths: string[];
  skippedSymlinks: number;
  skippedUnsafePaths: number;
  skippedDeep: number;
}
/** Host identity is separate from the portable approved content manifest. Detects even identical swaps. */
export interface EntrySnapshotSeal {
  readonly root: string;
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
  readonly treeIdentity: string;
  readonly bounds: Readonly<EntryBounds>;
  readonly containerReadable: boolean;
}
interface WalkEntry { relative: string; size: number; hash: string }
const identity = (s: Stats) => ({ dev: s.dev, ino: s.ino, size: s.size, mode: s.mode, uid: s.uid, nlink: s.nlink, mtime: s.mtimeMs, ctime: s.ctimeMs });
const unchanged = (a: Stats, b: Stats): boolean => canonicalJson(identity(a)) === canonicalJson(identity(b));
const cancelled = (signal?: AbortSignal): void => { if (signal?.aborted) entryFail('ENTRY_FAILED', 'source acquisition was cancelled'); };
export function validateEntryBounds(bounds: EntryBounds): void {
  for (const value of Object.values(bounds)) if (!Number.isSafeInteger(value) || value < 0) entryFail('ENTRY_FAILED', 'source bounds must be non-negative safe integers');
  if (bounds.maxFiles < 1 || bounds.maxFiles > 100_000 || bounds.maxFileBytes < 1 || bounds.maxFileBytes > 64 * 1024 * 1024 || bounds.maxTotalBytes < 1 || bounds.maxTotalBytes > 1024 * 1024 * 1024 || bounds.maxDepth > 64 || bounds.maxPathChars < 1 || bounds.maxPathChars > 4096 || bounds.maxSamplePaths > 1024) {
    entryFail('ENTRY_FAILED', 'source bounds exceed the acquisition hard limits');
  }
}
/** No-follow component checks. Node cannot provide openat2 isolation from a malicious same-uid host. */
export async function assertNoSymlinkComponents(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) entryFail('TARGET_DENIED', 'source paths must be canonical absolute paths');
  let current: string = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) entryFail('TARGET_DENIED', 'symlink path components are forbidden');
  }
}
/** Creates controller-owned parents only. Does not chmod an existing path (especially original source). */
export async function ensurePrivateSourceDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || path === sep) entryFail('TARGET_DENIED', 'private source directory must be canonical and absolute');
  let current: string = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) entryFail('TARGET_DENIED', 'private directory has an unsafe component');
  }
  const info = await lstat(path);
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) entryFail('TARGET_DENIED', 'private source parent must be owner-only and controller-owned');
}

async function walkTree(input: {
  root: string; bounds: EntryBounds; signal?: AbortSignal; observer?: EntryObserver;
  onFile?: (entry: WalkEntry, content: Buffer) => Promise<void>;
  strict?: { containerReadable: boolean };
}): Promise<{ fingerprint: EntryTreeFingerprint; treeIdentity: string }> {
  const { root, bounds } = input;
  validateEntryBounds(bounds);
  await assertNoSymlinkComponents(root);
  const entries: WalkEntry[] = [], nodes: unknown[] = [], samplePaths: string[] = [];
  let bytes = 0, seen = 0, skippedSymlinks = 0, skippedUnsafePaths = 0, skippedDeep = 0;
  const changed = (): never => entryFail('SCOPE_DIGEST_MISMATCH', 'source tree identity changed during its bounded read');
  const checkMode = (s: Stats, dir: boolean): void => {
    if (!input.strict) return;
    const expected = dir ? (input.strict.containerReadable ? 0o555 : 0o500) : (input.strict.containerReadable ? 0o444 : 0o400);
    if ((s.mode & 0o7777) !== expected || (process.getuid && s.uid !== process.getuid())) entryFail('TARGET_DENIED', 'source snapshot is not sealed with the required read-only identity');
  };
  const visit = async (directory: string, depth: number): Promise<void> => {
    cancelled(input.signal);
    await assertNoSymlinkComponents(directory);
    const beforeDir = await lstat(directory);
    if (!beforeDir.isDirectory() || beforeDir.isSymbolicLink()) changed();
    checkMode(beforeDir, true);
    nodes.push({ p: relative(root, directory), ...identity(beforeDir) });
    input.observer?.io?.({ kind: 'readdir', locator: directory });
    const dirents = [];
    const handle = await opendir(directory);
    // Bound directories/ignored entries too, not just accepted files. opendir avoids unbounded readdir.
    for await (const dirent of handle) {
      if (++seen > Math.max(128, bounds.maxFiles * 8)) entryFail('TARGET_TOO_LARGE', 'source directory-entry bound exceeded');
      dirents.push(dirent);
    }
    dirents.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const dirent of dirents) {
      cancelled(input.signal);
      const absolute = join(directory, dirent.name), rel = relative(root, absolute).split(sep).join('/');
      if (UNSAFE_NAME.test(dirent.name) || rel.length > bounds.maxPathChars || !rel) {
        if (input.strict) entryFail('TARGET_DENIED', 'snapshot contains an unaddressable path');
        skippedUnsafePaths++; continue;
      }
      if (isExcludedRelativePath(rel)) {
        if (input.strict) entryFail('TARGET_DENIED', 'snapshot contains excluded metadata or secret-like paths');
        continue;
      }
      if (dirent.isSymbolicLink()) {
        if (input.strict) entryFail('TARGET_DENIED', 'snapshot contains a symlink');
        skippedSymlinks++; continue;
      }
      const before = await lstat(absolute);
      if (before.isSymbolicLink() || before.isDirectory() !== dirent.isDirectory() || before.isFile() !== dirent.isFile()) changed();
      if (before.isDirectory()) {
        if (depth + 1 > bounds.maxDepth) {
          if (input.strict) entryFail('TARGET_TOO_LARGE', 'snapshot depth bound exceeded');
          skippedDeep++; continue;
        }
        await visit(absolute, depth + 1); continue;
      }
      if (!before.isFile() || before.nlink !== 1) {
        if (input.strict) entryFail('TARGET_DENIED', 'snapshot contains non-regular or hard-linked input');
        skippedUnsafePaths++; continue;
      }
      checkMode(before, false);
      if (before.size > bounds.maxFileBytes || entries.length >= bounds.maxFiles || bytes + before.size > bounds.maxTotalBytes) {
        entryFail('TARGET_TOO_LARGE', `source exceeds file/count/byte bound at ${safeText(rel, 200)}`);
      }
      input.observer?.io?.({ kind: 'read', locator: absolute });
      // Hash and copy the SAME bounded buffer, never stat/readFile/copyFile through a second pathname open.
      const fd = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let content: Buffer;
      try {
        const opened = await fd.stat();
        if (!unchanged(before, opened)) changed();
        const buffer = Buffer.alloc(opened.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          cancelled(input.signal);
          const read = await fd.read(buffer, offset, buffer.length - offset, offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        await assertNoSymlinkComponents(absolute);
        if (offset !== opened.size || !unchanged(opened, await fd.stat()) || !unchanged(opened, await lstat(absolute))) changed();
        content = buffer.subarray(0, offset);
      } finally { await fd.close(); }
      const entry = { relative: rel, size: content.length, hash: sha(content) };
      entries.push(entry); bytes += content.length;
      nodes.push({ p: rel, ...identity(before) });
      if (samplePaths.length < bounds.maxSamplePaths) samplePaths.push(rel);
      await input.onFile?.(entry, content);
    }
    await assertNoSymlinkComponents(directory);
    if (!unchanged(beforeDir, await lstat(directory))) changed();
  };
  await visit(root, 0);
  const digest = sha(canonicalJson({ version: 1, entries: entries.map(entry => ({ p: entry.relative, s: entry.size, h: entry.hash })) }));
  return { fingerprint: { digest, files: entries.length, bytes, samplePaths, skippedSymlinks, skippedUnsafePaths, skippedDeep }, treeIdentity: sha(canonicalJson(nodes)) };
}
export async function fingerprintTree(input: { root: string; bounds: EntryBounds; signal?: AbortSignal; observer?: EntryObserver }): Promise<EntryTreeFingerprint> {
  return (await walkTree(input)).fingerprint;
}
function assertOutside(root: string, destination: string): void {
  if (root === sep || destination === sep || destination === root || destination.startsWith(`${root}${sep}`) || root.startsWith(`${destination}${sep}`)) entryFail('TARGET_DENIED', 'snapshot and original source roots must be disjoint');
}
/** Cleanup ONLY a newly created controller tree. Never follows links and never chmods the original. */
export async function removePrivateSourceTree(root: string): Promise<void> {
  const s = await lstat(root).catch(() => undefined);
  if (!s) return;
  if (s.isDirectory() && !s.isSymbolicLink()) {
    await chmod(root, 0o700);
    const dir = await opendir(root);
    for await (const entry of dir) if (entry.isDirectory() && !entry.isSymbolicLink()) await removePrivateSourceTree(join(root, entry.name));
  }
  await rm(root, { recursive: true, force: true });
}
export async function createReadOnlySnapshot(input: {
  root: string; destination: string; bounds: EntryBounds; expectedDigest?: string;
  /** Only under an owner-only parent: the mounted tree must be readable by container uid 65532. */
  containerReadable?: boolean; signal?: AbortSignal; observer?: EntryObserver;
}): Promise<EntryTreeFingerprint> {
  const { root, destination } = input;
  await assertNoSymlinkComponents(root);
  if (!isAbsolute(destination) || resolve(destination) !== destination) entryFail('TARGET_DENIED', 'snapshot destination must be canonical and absolute');
  assertOutside(await realpath(root), destination);
  // Validate components before making parents; symlink aliases never redirect acquisition writes.
  await ensurePrivateSourceDirectory(dirname(destination));
  await assertNoSymlinkComponents(dirname(destination));
  input.observer?.io?.({ kind: 'copy', locator: destination });
  try { await mkdir(destination, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') entryFail('TARGET_DENIED', 'snapshot destination already exists; never overwrite a view'); throw error; }
  const directories = new Set<string>([destination]);
  try {
    const { fingerprint } = await walkTree({
      ...input,
      onFile: async (entry, content) => {
        const path = join(destination, entry.relative), parent = dirname(path);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        let current = parent;
        while (current !== dirname(destination)) { directories.add(current); if (current === destination) break; current = dirname(current); }
        const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); }
        await chmod(path, input.containerReadable ? 0o444 : 0o400);
      },
    });
    if (input.expectedDigest !== undefined && fingerprint.digest !== input.expectedDigest) entryFail('SCOPE_DIGEST_MISMATCH', 'target content changed; the approved digest no longer matches');
    const copied = await fingerprintTree({ root: destination, bounds: input.bounds, signal: input.signal });
    if (copied.digest !== fingerprint.digest) entryFail('SCOPE_DIGEST_MISMATCH', 'copied snapshot bytes differ from the approved view');
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) await chmod(directory, input.containerReadable ? 0o555 : 0o500);
    return fingerprint;
  } catch (error) { await removePrivateSourceTree(destination); throw error; }
}
export async function sealSnapshot(input: { root: string; bounds: EntryBounds; expectedDigest: string; containerReadable?: boolean; signal?: AbortSignal }): Promise<EntrySnapshotSeal> {
  await ensurePrivateSourceDirectory(dirname(input.root));
  const tree = await walkTree({ ...input, strict: { containerReadable: input.containerReadable === true } });
  if (tree.fingerprint.digest !== input.expectedDigest) entryFail('SCOPE_DIGEST_MISMATCH', 'private snapshot does not match the acquired digest');
  return Object.freeze({ root: input.root, digest: tree.fingerprint.digest, files: tree.fingerprint.files, bytes: tree.fingerprint.bytes, treeIdentity: tree.treeIdentity, bounds: Object.freeze({ ...input.bounds }), containerReadable: input.containerReadable === true });
}
export async function assertSnapshotSeal(seal: EntrySnapshotSeal, signal?: AbortSignal): Promise<void> {
  const now = await sealSnapshot({ root: seal.root, bounds: seal.bounds, expectedDigest: seal.digest, containerReadable: seal.containerReadable, signal });
  if (now.treeIdentity !== seal.treeIdentity) entryFail('SCOPE_DIGEST_MISMATCH', 'private source snapshot identity changed; identical replacement trees are not accepted');
}
