/**
 * planning_update.md P24 §3.8: a raw, read-only reader for a stored run this build does not own.
 *
 * The store's normal lifecycle is unchanged: a writable open refuses a foreign schema version and a read-only open of one is
 * metadata-only (`AssessmentStore.records()` throws by name). That is deliberate — "inspect read-only, never migrate in
 * place". But the inherited-graph loader and an explicit operator upgrade still have to read the ledger of an older run, and
 * they must do it without a migration path, a hidden writer, or a second interpretation of the record format.
 *
 * This reader therefore opens the sqlite file through the same `PrivateDirectory` FD containment the store uses (no symlink
 * substitution, one hard link, private mode), refuses a non-DELETE journal and any sidecar file, verifies the schema version
 * is one of the versions this reader understands, and validates every row through the immutable `indexRecords` path. It never
 * writes: `PRAGMA query_only` is on and the connection is opened read-only.
 */
import { DatabaseSync } from 'node:sqlite';
import { closeSync, fstatSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { indexRecords, LEDGER_BYTES, LEDGER_RECORDS, type AssessmentRecord } from '../records.js';
import { validId } from '../validate.js';
import { PrivateDirectory } from './files.js';
import type { StoreManifest } from './store.js';

/** Schema versions whose record format this reader accepts. A newer/older file is refused by name, never guessed. */
export const LEGACY_SCHEMA_VERSIONS = [7, 8] as const;
/** A stored run owns exactly these files under the DELETE journal policy; anything else may be a hidden write path. */
const LEGACY_FILES = ['assessment.sqlite', 'writer.lock'];
export interface LegacyStore {
  path: string;
  schemaVersion: (typeof LEGACY_SCHEMA_VERSIONS)[number];
  runId: string;
  manifest: StoreManifest;
  records: AssessmentRecord[];
  journal: 'delete';
  bytes: number;
}

export function readRecordsReadOnly(path: string, options: { maxRecords?: number; maxBytes?: number } = {}): LegacyStore {
  if (!isAbsolute(path) || path.includes('\0')) throw Error('Legacy store path must be an absolute host path');
  if (basename(path) !== 'assessment.sqlite') throw Error('Legacy store path must name assessment.sqlite');
  const runId = basename(dirname(path)), stateRoot = dirname(dirname(path));
  if (!/^run-/.test(runId) || !validId(runId) || stateRoot === '/' || stateRoot === '.') throw Error('Invalid legacy run directory');
  const maxRecords = options.maxRecords ?? LEDGER_RECORDS, maxBytes = options.maxBytes ?? LEDGER_BYTES;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > LEDGER_RECORDS
    || !Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > LEDGER_BYTES) throw Error('Invalid legacy read bound');
  const parent = PrivateDirectory.open(stateRoot);
  let directory: PrivateDirectory | undefined, fd: number | undefined, db: DatabaseSync | undefined;
  try {
    directory = parent.child(runId);
    const foreign = readdirSync(`/proc/self/fd/${directory.fd}`).filter(name => !LEGACY_FILES.includes(name)).sort();
    if (foreign.length) throw Error(`Foreign store file(s) refuse a read-only legacy open: ${foreign.slice(0, 3).join(', ')}`);
    fd = directory.file('assessment.sqlite');
    const size = fstatSync(fd).size;
    if (size > maxBytes) throw Error('Legacy store exceeds the read byte bound');
    // The pinned FD is the file we verified; SQLite opens the same inode through /proc rather than re-resolving the name.
    db = new DatabaseSync(`/proc/self/fd/${fd}`, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0');
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (!(LEGACY_SCHEMA_VERSIONS as readonly number[]).includes(version)) throw Error(`Unsupported legacy store schema ${version}; expected 7 or 8`);
    const journal = String(db.prepare('PRAGMA journal_mode').get()!.journal_mode);
    if (journal !== 'delete') throw Error(`Unsupported legacy store journal mode ${journal}; expected DELETE`);
    const stored = db.prepare("SELECT body FROM metadata WHERE key='manifest'").get();
    if (!stored) throw Error('Legacy store has no manifest');
    const manifest = JSON.parse(String(stored.body)) as StoreManifest;
    if (!manifest || manifest.runId !== runId || !validId(manifest.runId)) throw Error('Legacy store manifest does not belong to this run');
    const rows = db.prepare('SELECT body FROM records ORDER BY sequence LIMIT ?').all(maxRecords + 1)
      .map(row => JSON.parse(String(row.body)) as AssessmentRecord);
    if (rows.length > maxRecords) throw Error('Legacy store exceeds the read record bound');
    // The same immutable integrity checks the canonical projection uses; a malformed old ledger is refused, not half-read.
    const index = indexRecords(rows, runId);
    if (!index.complete || index.issueCount) throw Error('Legacy store records failed the immutable integrity checks');
    return { path, schemaVersion: version as LegacyStore['schemaVersion'], runId, manifest, records: index.records, journal: 'delete', bytes: size };
  } finally {
    try { db?.close(); } finally { try { if (fd !== undefined) closeSync(fd); } finally { directory?.close(); parent.close(); } }
  }
}
