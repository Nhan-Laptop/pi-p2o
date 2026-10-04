import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ID_PATTERN } from '../contracts/index.js';
import { SupervisorError, assert } from './validation.js';

/**
 * Controller-owned restart metadata: atomic, bounded, owner-only JSON files.
 * Authoritative lifecycle/fencing/budget state still lives in the durable store.
 */
export class ControlFiles {
  constructor(readonly root: string) {
    assert(root.startsWith('/'), 'state-root', 'Control root must be absolute');
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private file(kind: string, key: string): string {
    assert(ID_PATTERN.test(key), 'state-key', `Invalid ${kind} key`);
    return join(this.root, kind, `${key}.json`);
  }
  write(kind: string, key: string, value: unknown, maxBytes = 512 * 1024): void {
    this.writeRaw(kind, key, `${JSON.stringify(value)}\n`, maxBytes);
  }
  /** Exact bytes; callers that publish digests must hash the same buffer. */
  writeRaw(kind: string, key: string, payload: string | Buffer, maxBytes = 512 * 1024): void {
    assert(Buffer.byteLength(payload) <= maxBytes, 'state-limit', `${kind} state exceeds its bound`);
    const directory = join(this.root, kind);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = this.file(kind, key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, payload, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  }
  read<T>(kind: string, key: string, maxBytes = 2 * 1024 * 1024): T | undefined {
    const target = this.file(kind, key);
    let raw: string;
    try { raw = readFileSync(target, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    assert(raw.length <= maxBytes, 'state-limit', `${kind} state exceeds its bound`);
    try { return JSON.parse(raw) as T; }
    catch { throw new SupervisorError('state-corrupt', `${kind} state is not valid JSON`); }
  }
}
