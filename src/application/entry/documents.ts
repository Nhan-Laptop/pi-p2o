/**
 * Bounded owner-document reader.
 *
 * Approval documents used by the execution adapters are owner-authored files. The entry workflow never
 * writes, edits or mints them; it only reads a canonical, owner-only, same-UID regular file and hands the
 * parsed bytes to the existing ledger, which performs the digest binding itself.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { canonicalJson, runSchema, type RunManifest } from '../../contracts/index.js';
import { entryFail, safeText } from './errors.js';

const MAX_RUN_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * The composed `ControlBackend` re-reads the owner run document by path and compares it field-for-field with
 * the composition's owner run. `createP2OBackend` therefore either verifies an operator-pinned owner run
 * manifest or materializes a derived copy under the private control root. A derived copy follows the owner
 * document (it is exactly that document's run, re-written when the owner changes it); an operator-pinned
 * document is never written, and one that does not exist or does not match is refused.
 */
export function ensureOwnerRunManifest(input: { path: string; run: RunManifest; derived: boolean }): string {
  if (!isAbsolute(input.path) || resolve(input.path) !== input.path) {
    entryFail('ENTRY_INTEGRATION_REQUIRED', 'the owner run manifest path must be a canonical absolute path');
  }
  const expected = canonicalJson(runSchema.parse(input.run));
  let stat;
  try { stat = lstatSync(input.path); }
  catch { stat = undefined; }
  if (stat && !input.derived) {
    const parsed = runSchema.parse(readOwnerDocument(input.path, 'owner run manifest', MAX_RUN_MANIFEST_BYTES));
    if (canonicalJson(parsed) !== expected) {
      entryFail('ENTRY_INTEGRATION_REQUIRED', `the owner run manifest ${safeText(input.path, 300)} differs from the owner run document; it is never overwritten`);
    }
    return input.path;
  }
  if (!stat && !input.derived) {
    entryFail('ENTRY_INTEGRATION_REQUIRED', `the owner run manifest ${safeText(input.path, 300)} does not exist; an operator-pinned document must be owner-authored`);
  }
  if (stat) {
    // A derived copy always reflects the current owner run document; a stale copy would make the composed
    // backend's identity check refuse every admission after an owner edit.
    const current = readFileSync(input.path, 'utf8');
    if (current === `${expected}\n`) return input.path;
  }
  mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
  const temporary = `${input.path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${expected}\n`, { mode: 0o600 });
  renameSync(temporary, input.path);
  return input.path;
}
export const MAX_OWNER_DOCUMENT_BYTES = 1024 * 1024;

export function readOwnerDocument(path: string, label: string, maxBytes = MAX_OWNER_DOCUMENT_BYTES): unknown {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    entryFail('ENTRY_INTEGRATION_REQUIRED', `${label} must be a canonical absolute path`);
  }
  let stat;
  try { stat = lstatSync(path); }
  catch { entryFail('ENTRY_INTEGRATION_REQUIRED', `${label} ${safeText(path, 300)} does not exist or is not readable`); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    entryFail('ENTRY_INTEGRATION_REQUIRED', `${label} ${safeText(path, 300)} must be a regular file, not a link`);
  }
  if ((stat.mode & 0o022) !== 0) {
    entryFail('ENTRY_INTEGRATION_REQUIRED', `${label} ${safeText(path, 300)} must not be group/world writable`);
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    entryFail('ENTRY_INTEGRATION_REQUIRED', `${label} ${safeText(path, 300)} must be owned by the current user`);
  }
  if (stat.size === 0 || stat.size > maxBytes) {
    entryFail('ENTRY_INTEGRATION_REQUIRED', `${label} must be a non-empty file under ${maxBytes} bytes`);
  }
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { entryFail('ENTRY_INTEGRATION_REQUIRED', `${label} is not valid JSON`); }
}
