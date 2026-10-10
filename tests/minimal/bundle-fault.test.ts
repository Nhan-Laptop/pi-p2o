import { constants } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { AssessmentStore, type StoreManifest } from '../../src/state/store.js';
import { exportBundle, inspectBundle, publishReportFiles } from '../../src/state/bundle.js';
import type { AssessmentRecord } from '../../src/records.js';

/**
 * Disk-full fault injection for the portable bundle exporter. Only file opens inside the exporter's temporary directory are
 * counted, so the store's own I/O is never disturbed; the failing write surfaces ENOSPC exactly as a full device would.
 */
const fault = vi.hoisted(() => ({ writes: 0, failAt: Number.POSITIVE_INFINITY }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const flags = await import('node:fs');
  return { ...actual, open: async (path: unknown, mode?: unknown, permission?: unknown) => {
    const handle = await (actual.open as (...args: unknown[]) => Promise<import('node:fs/promises').FileHandle>)(path, mode, permission);
    if (typeof path === 'string' && path.includes('.p2o-tmp-') && typeof mode === 'number' && (mode & flags.constants.O_CREAT)) {
      fault.writes += 1;
      if (fault.writes === fault.failAt) handle.writeFile = async () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' }); };
    }
    return handle;
  } };
});

const manifest: StoreManifest = { runId: 'run-fault', retention: 'durable-local', targetKind: 'directory', targetIdentity: 'bundle-fault', targetDisplay: 'inert fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } };
const note = (text: string): AssessmentRecord => ({ at: '2030', by: 'owner', runId: manifest.runId, kind: 'note', text });

async function fixture(work: (root: string, store: AssessmentStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-bundle-fault-')), store = AssessmentStore.create(join(root, 'state'), manifest);
  store.commitRecords([note('retained observation one'), note('retained observation two')]);
  store.ingestArtifact('owner', Buffer.from('retained artifact body'), { kind: 'output' });
  try { await work(root, store); } finally { fault.writes = 0; fault.failAt = Number.POSITIVE_INFINITY; store.close(); await rm(root, { recursive: true, force: true }); }
}
const leftovers = async (root: string) => (await readdir(root)).filter(name => name !== 'state');

describe('portable bundle export under a full disk (K7 fixture: disk full during export)', () => {
  it('fails closed on ENOSPC at any file write: no destination, no manifest, no temporary directory, and a retry exports a complete bundle', async () => {
    await fixture(async (root, store) => {
      const destination = join(root, 'bundle');
      fault.writes = 0; fault.failAt = Number.POSITIVE_INFINITY; await exportBundle(store, join(root, 'probe')); const files = fault.writes; // every file write of one clean export
      await rm(join(root, 'probe'), { recursive: true, force: true });
      expect(files, 'segments, artifact, marker, .npmignore and manifest are all written').toBeGreaterThanOrEqual(5);
      for (let failAt = 1; failAt <= files; failAt++) {
        fault.writes = 0; fault.failAt = failAt;
        await expect(exportBundle(store, destination), `write ${failAt}/${files}`).rejects.toThrow('ENOSPC');
        expect(await stat(destination).catch(() => undefined), `no success claim after write ${failAt}`).toBeUndefined();
        expect(await leftovers(root), `no partial bundle or temporary directory after write ${failAt}`).toEqual([]);
      }
      fault.writes = 0; fault.failAt = Number.POSITIVE_INFINITY;
      const exported = await exportBundle(store, destination); // nothing was consumed by the failed attempts
      const inspected = await inspectBundle(destination);
      expect(inspected.integrityStatus).toBe('complete'); expect(inspected.missing).toEqual([]); expect(inspected.tampered).toEqual([]);
      expect(exported.manifest.counts).toMatchObject({ records: 2, artifacts: 1 }); expect(exported.manifest.authorityRestored).toBe(false);
    });
  }, 60_000);

  it('does not let a failed attempt block or contaminate a later export to the same destination', async () => {
    await fixture(async (root, store) => {
      const destination = join(root, 'again');
      fault.writes = 0; fault.failAt = 2; await expect(exportBundle(store, destination)).rejects.toThrow('ENOSPC');
      fault.failAt = Number.POSITIVE_INFINITY; fault.writes = 0;
      await exportBundle(store, destination); expect((await inspectBundle(destination)).integrityStatus).toBe('complete');
      await expect(exportBundle(store, destination)).rejects.toThrow('already exists'); // a successful export is still never overwritten
      expect(constants.O_CREAT).toBeGreaterThan(0);
    });
  });

  it('fails closed on ENOSPC at any file write of a report export and a retry publishes every file (plan F-W5-5)', async () => {
    await fixture(async (root, store) => {
      const files = ['REPORT.md', 'cases.csv', 'coverage.csv', 'report-manifest.json'].map(name => ({ name, body: `body of ${name}\n` }));
      const destination = join(root, 'report');
      fault.writes = 0; fault.failAt = Number.POSITIVE_INFINITY; await publishReportFiles(store, join(root, 'probe'), files); const writes = fault.writes;
      await rm(join(root, 'probe'), { recursive: true, force: true });
      expect(writes, 'four files, the private marker and .npmignore').toBe(6);
      for (let failAt = 1; failAt <= writes; failAt++) {
        fault.writes = 0; fault.failAt = failAt;
        await expect(publishReportFiles(store, destination, files), `write ${failAt}/${writes}`).rejects.toThrow('ENOSPC');
        expect(await stat(destination).catch(() => undefined), `no success claim after write ${failAt}`).toBeUndefined();
        expect(await leftovers(root), `no partial report or temporary directory after write ${failAt}`).toEqual([]);
      }
      fault.writes = 0; fault.failAt = Number.POSITIVE_INFINITY;
      expect(await publishReportFiles(store, destination, files)).toMatchObject({ files: 4 });
      expect((await readdir(destination)).sort()).toEqual(['.npmignore', '.p2o-knowledge-bundle', 'REPORT.md', 'cases.csv', 'coverage.csv', 'report-manifest.json']);
      await expect(publishReportFiles(store, destination, files)).rejects.toThrow('already exists'); // a published report is never overwritten
    });
  }, 60_000);
});
