import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, stat, symlink, link, unlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { AssessmentStore, type StoreManifest } from '../../src/state/store.js';
import { LEGACY_SCHEMA_VERSIONS, readRecordsReadOnly } from '../../src/state/legacy.js';
import { sha256Hex } from '../../src/validate.js';
import type { AssessmentRecord } from '../../src/records.js';

/**
 * planning_update.md P24 §3.8: a run this build does not own is readable through a raw, bounded, read-only path — never a
 * migration and never a hidden write. The reader exists for the inherited-graph loader and an explicit operator upgrade; these
 * tests pin the version window, the FD containment (no symlink, one hard link), the DELETE journal and the read bounds.
 */
const manifest: StoreManifest = { runId: 'run-legacy', retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture-target',
  targetDisplay: 'inert fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } };
const note = (id: string, text = 'bounded inert observation'): AssessmentRecord =>
  ({ id, version: 2, runId: manifest.runId, at: '2030', by: 'owner', kind: 'note', text });

async function fixture(records = 2): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-legacy-'));
  const store = AssessmentStore.create(root, manifest);
  try { store.commitRecords(Array.from({ length: records }, (_, index) => note(`note-${index}`))); } finally { store.close(); }
  return { root, path: join(root, manifest.runId, 'assessment.sqlite') };
}
async function flipVersion(path: string, version: number): Promise<void> {
  const db = new DatabaseSync(path);
  try { db.exec(`PRAGMA user_version=${version}`); } finally { db.close(); }
}
const sha = async (path: string) => sha256Hex(await readFile(path));

describe('raw read-only legacy store reader (P24/B §3.8)', () => {
  it('reads this build’s own schema-8 ledger through the immutable index path and writes nothing', async () => {
    const { root, path } = await fixture();
    try {
      const before = await sha(path), files = (await readdir(join(root, manifest.runId))).sort();
      const store = readRecordsReadOnly(path);
      expect(store).toMatchObject({ schemaVersion: 8, runId: manifest.runId, journal: 'delete' });
      expect(LEGACY_SCHEMA_VERSIONS).toEqual([7, 8]);
      expect(store.records.map(record => record.id)).toEqual(['note-0', 'note-1']);
      expect(store.manifest).toEqual(manifest);
      expect(store.bytes).toBe((await stat(path)).size);
      expect(await sha(path)).toBe(before);
      expect((await readdir(join(root, manifest.runId))).sort()).toEqual(files);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reads a schema-7 run without migrating it, and refuses a version outside the window by name', async () => {
    const { root, path } = await fixture();
    try {
      await flipVersion(path, 7);
      expect(readRecordsReadOnly(path)).toMatchObject({ schemaVersion: 7, runId: manifest.runId });
      await flipVersion(path, 6);
      expect(() => readRecordsReadOnly(path)).toThrow('Unsupported legacy store schema 6; expected 7 or 8');
      await flipVersion(path, 8);
      expect(readRecordsReadOnly(path).records).toHaveLength(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses an unexpected sidecar file instead of reading past a hidden write path', async () => {
    const { root, path } = await fixture();
    try {
      await writeFile(join(root, manifest.runId, 'stray-journal.txt'), 'not ours', { mode: 0o600 });
      expect(() => readRecordsReadOnly(path)).toThrow(/Foreign store file/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a symlink substitution without touching the bytes outside', async () => {
    const { root, path } = await fixture();
    try {
      const outside = join(root, 'outside.sqlite');
      await writeFile(outside, 'do not read or change', { mode: 0o600 });
      await unlink(path); await symlink(outside, path);
      expect(() => readRecordsReadOnly(path)).toThrow();
      expect(await readFile(outside, 'utf8')).toBe('do not read or change');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a second hard link to the database file', async () => {
    const { root, path } = await fixture();
    try {
      await link(path, join(root, 'second-link.sqlite'));
      expect(() => readRecordsReadOnly(path)).toThrow(/single-link/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('enforces the record and byte read bounds rather than returning an unbounded page', async () => {
    const { root, path } = await fixture(3);
    try {
      expect(() => readRecordsReadOnly(path, { maxRecords: 2 })).toThrow('Legacy store exceeds the read record bound');
      expect(() => readRecordsReadOnly(path, { maxBytes: 4096 })).toThrow('Legacy store exceeds the read byte bound');
      expect(() => readRecordsReadOnly(path, { maxRecords: 0 })).toThrow('Invalid legacy read bound');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
