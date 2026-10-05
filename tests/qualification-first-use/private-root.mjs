import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Match the owner-store ancestor fence; never trust only the immediate directory. */
export function assertPrivateRoot(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))) {
      throw new Error(`QUALIFICATION_UNSAFE_PRIVATE_ROOT: ${current}`);
    }
    if (dirname(current) === current) return path;
  }
}

export function privateBase(candidates) {
  for (const base of candidates) {
    try { return assertPrivateRoot(base); } catch { /* try the next ancestor-safe base */ }
  }
  throw new Error('QUALIFICATION_NO_PRIVATE_BASE: no ancestor-safe owner storage directory');
}
