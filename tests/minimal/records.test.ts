import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecord, readRecords, recordsSize, summarizeRecords, waitForRecordChange, type AssessmentRecord } from '../../src/records.js';

const record = (patch: Partial<AssessmentRecord> = {}): AssessmentRecord => ({ at: new Date().toISOString(), by: 'owner', kind: 'note', text: 'observed something', ...patch });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function delayThenAppend(path: string): Promise<void> { await sleep(200); await appendRecord(path, record({ text: 'later' })); }

describe('shared ledger', () => {
  it('appends and reads records, tolerating a truncated tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-records-'));
    const path = join(root, 'records.jsonl');
    try {
      await appendRecord(path, record({ text: 'first' }));
      await appendRecord(path, record({ kind: 'coverage', text: 'clean', surface: '/a', risk: 'rce', outcome: 'clean' }));
      await appendRecord(path, record({ workerId: 'p2o-recon-aaaaaa', role: 'recon', depth: 1, kind: 'observation', text: 'worker saw a thing' }));
      await writeFile(path, `${await (await import('node:fs/promises')).readFile(path, 'utf8')}{"at":"2026`, { flag: 'w' });
      const records = await readRecords(path);
      expect(records.map(entry => entry.text)).toEqual(['first', 'clean', 'worker saw a thing']);
      const summary = summarizeRecords(records);
      expect(summary.coverage).toHaveLength(1);
      expect(summary.workers[0]).toMatchObject({ workerId: 'p2o-recon-aaaaaa', notes: 1, depth: 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('blocks on ledger changes without model polling and honours the deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-records-wait-'));
    const path = join(root, 'records.jsonl');
    try {
      await appendRecord(path, record());
      const size = await recordsSize(path);
      const started = Date.now();
      const appended = delayThenAppend(path);
      const changed = await waitForRecordChange(path, { since: size, timeoutMs: 4000, pollMs: 100 });
      await appended;
      expect(changed).toBe(true);
      expect(Date.now() - started).toBeLessThan(4000);
      const timedOut = await waitForRecordChange(path, { since: await recordsSize(path), timeoutMs: 300, pollMs: 100 });
      expect(timedOut).toBe(false);
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 150);
      await expect(waitForRecordChange(path, { since: await recordsSize(path), timeoutMs: 5000, signal: abort.signal })).rejects.toThrow('Cancelled');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('summarizes reports, open items and lifecycle entries for the owner view', () => {
    const summary = summarizeRecords([
      record({ kind: 'coverage', surface: '/login', risk: 'sqli', outcome: 'ruled_out', workerId: 'p2o-discovery-aaaaaa' }),
      record({ kind: 'open', text: 'could not reach /admin', workerId: 'p2o-discovery-aaaaaa' }),
      record({ kind: 'report', text: 'summary', workerId: 'p2o-discovery-aaaaaa' }),
      record({ kind: 'lifecycle', text: 'delegated' }),
    ]);
    expect(summary.coverage).toHaveLength(1);
    expect(summary.open).toHaveLength(1);
    expect(summary.lifecycle).toHaveLength(1);
    expect(summary.workers[0]).toMatchObject({ reported: true, coverage: 1, open: 1 });
  });
});
