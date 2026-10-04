import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { EvidenceError, requireEvidence } from './common.js';

export function relativeArtifactPath(value: string): string {
  requireEvidence(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !isAbsolute(value) && !/[\\:%\u0000-\u001f\u007f]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..'), 'path-denied', 'Artifact path must be unambiguous and relative');
  return value;
}
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function identity(a: Stats, b: Stats): boolean { return a.ino === b.ino && a.dev === b.dev && a.isDirectory() === b.isDirectory(); }
export function checkedComponents(path: string): { path: string; stat: Stats }[] {
  requireEvidence(isAbsolute(path) && resolve(path) === path, 'path-denied', 'Root must be an absolute canonical path');
  let at = parse(path).root;
  const components = [{ path: at, stat: lstatSync(at) }];
  for (const part of path.slice(at.length).split(sep).filter(Boolean)) {
    at = join(at, part);
    const stat = lstatSync(at);
    requireEvidence(!stat.isSymbolicLink(), 'symlink-denied', 'Symlink artifact files and ancestors are forbidden');
    components.push({ path: at, stat });
  }
  return components;
}
export function checkedDirectory(path: string, privateOwner = false): Stats {
  checkedComponents(path);
  const stat = lstatSync(path);
  requireEvidence(stat.isDirectory() && realpathSync(path) === path, 'path-denied', 'Expected a canonical directory');
  if (privateOwner) requireEvidence((stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid()), 'private-root', 'Evidence directory must be supervisor-owned and owner-only');
  return stat;
}
export function makePrivateDirectory(path: string): void {
  checkedDirectory(dirname(path));
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  checkedDirectory(path, true);
}
/** Bounded no-follow read. Requires trusted immutable ancestors; not a kernel sandbox/openat2 substitute. */
export function readBoundedArtifact(root: string, path: string, maxBytes: number, privateOwner = false): Buffer {
  relativeArtifactPath(path);
  requireEvidence(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= 16_777_216, 'limit', 'Invalid artifact byte limit');
  const absolute = join(root, path);
  requireEvidence(isWithin(root, absolute), 'path-denied', 'Artifact escapes its collection root');
  let fd: number | undefined;
  try {
    checkedDirectory(root, privateOwner);
    const beforeComponents = checkedComponents(absolute);
    const before = beforeComponents[beforeComponents.length - 1].stat;
    requireEvidence(before.isFile() && before.nlink === 1, 'file-denied', 'Artifact must be a non-linked regular file');
    requireEvidence(before.size <= maxBytes, 'artifact-limit', 'Artifact exceeds the byte limit');
    if (privateOwner) requireEvidence((before.mode & 0o077) === 0 && (!process.getuid || before.uid === process.getuid()), 'private-root', 'Evidence file is not private');
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    requireEvidence(identity(before, opened) && opened.isFile() && opened.nlink === 1 && opened.size === before.size, 'artifact-changed', 'Artifact changed before open');
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!n) break;
      offset += n;
    }
    const after = fstatSync(fd), afterComponents = checkedComponents(absolute);
    requireEvidence(offset === opened.size && after.size === opened.size && after.nlink === 1 && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs && beforeComponents.length === afterComponents.length && beforeComponents.every((c, i) => identity(c.stat, afterComponents[i].stat)), 'artifact-changed', 'Artifact or ancestor changed during collection');
    return buffer.subarray(0, offset);
  } catch (e) {
    if (e instanceof EvidenceError) throw e;
    throw new EvidenceError('artifact-unavailable', 'Artifact is unavailable or unsafe');
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function writeExclusive(path: string, bytes: Uint8Array, mode = 0o400): void {
  checkedDirectory(dirname(path), true);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
