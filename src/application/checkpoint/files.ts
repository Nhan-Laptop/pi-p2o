import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export class CheckpointError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'CheckpointError'; }
}
export function deny(code: string, message: string): never { throw new CheckpointError(code, message); }
export const MAX_CHECKPOINT_BYTES = 256 * 1024;
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
/** Roots come from controller configuration, never the checkpoint. */
export async function checkpointDirectory(root: string, forbiddenRoots: readonly string[], create = false): Promise<void> {
  if (resolve(root) !== root || root === sep || forbiddenRoots.some(p => overlaps(resolve(p), root))) deny('CHECKPOINT_ROOT', 'checkpoint must be outside target and worker write roots');
  const chain: string[] = [];
  for (let p = root; p !== dirname(p); p = dirname(p)) chain.unshift(p);
  for (const p of chain) {
    if (create) { try { await mkdir(p, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
    const s = await lstat(p);
    const uid = process.getuid?.();
    if (!s.isDirectory() || s.isSymbolicLink() || await realpath(p) !== p || (s.uid !== uid && s.uid !== 0) ||
        ((s.mode & 0o022) !== 0 && !(s.uid === 0 && (s.mode & 0o1000) !== 0 && p !== root)) ||
        (p === root && (s.uid !== uid || (s.mode & 0o077) !== 0))) deny('CHECKPOINT_ROOT', 'unsafe controller directory');
  }
}
export async function readBounded(path: string): Promise<string> {
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await h.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0 || s.size > MAX_CHECKPOINT_BYTES) deny('CHECKPOINT_FILE', 'unsafe or oversized checkpoint');
    const b = Buffer.alloc(MAX_CHECKPOINT_BYTES + 1);
    let n = 0;
    while (n < b.length) { const r = await h.read(b, n, b.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; }
    if (n > MAX_CHECKPOINT_BYTES) deny('CHECKPOINT_FILE', 'checkpoint exceeds byte limit');
    return b.subarray(0, n).toString('utf8');
  } finally { await h.close(); }
}
export async function atomicCheckpoint(root: string, bytes: string): Promise<void> {
  if (Buffer.byteLength(bytes) > MAX_CHECKPOINT_BYTES) deny('CHECKPOINT_SIZE', 'checkpoint exceeds byte limit');
  const path = join(root, `.pending-${randomUUID()}`);
  try {
    const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
    await rename(path, join(root, 'checkpoint.json'));
    const dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await rm(path, { force: true }); }
}
/** Deliberately no PID-based stale lock takeover. A crash requires explicit controller/operator recovery. */
export async function controllerClaim(root: string): Promise<() => Promise<void>> {
  const path = join(root, '.controller-claim');
  try { await mkdir(path, { mode: 0o700 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') deny('CHECKPOINT_BUSY', 'controller claim exists; reconcile ownership before explicit recovery');
    throw e;
  }
  let closed = false;
  return async () => { if (!closed) { closed = true; await rm(path, { recursive: true }); } };
}
