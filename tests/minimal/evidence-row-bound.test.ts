import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssessmentStore } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { EvidenceStore } from '../../src/evidence.js';
import { appendRecord, LEDGER_ROW_BYTES, RECORD_TOO_LARGE } from '../../src/records.js';
import type { CaptureReceipt } from '../../src/artifacts.js';

/**
 * A5-fix-1 (live run run-1b201c1a-ba04-4dd5-8aca-e0ed302c2904): the excerpt caps are per field, while the store admits a row of
 * at most `LEDGER_ROW_BYTES`. A 15,203-byte stdout passed the stdout cap (16 KiB) and still produced a 17,244-byte receipt row,
 * so the store refused the append after a successful return. The measured shape must now commit, be marked truncated, and keep
 * the capture artifact citable; the row itself must always fit the one bound the reader applies.
 */
const CAPTURE: CaptureReceipt = { available: true, maxBytes: 1024 * 1024, observedBytes: 15203, capturedBytes: 15203, artifacts: [
  { id: `artifact-${randomUUID()}`, stream: 'stdout', totalBytes: 15203, capturedInputBytes: 15203, bytes: 15203, sha256: 'a'.repeat(64), truncated: false, captureOutcome: 'returned' } ] };
const rowBytes = (row: unknown): number => Buffer.byteLength(JSON.stringify({ ...(row as Record<string, unknown>), version: 2 })) + 1;

async function fixture(work: (store: EvidenceStore, canonical: AssessmentStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-row-bound-'));
  const canonical = AssessmentStore.create(root, { runId: 'run-row-bound', retention: 'durable-local', targetKind: 'directory',
    targetIdentity: 'inert', targetDisplay: 'inert', profile: { runtimeHash: 'inert', image: 'inert', loopMode: 'manual', executorMode: 'shared' } });
  const path = join(root, 'alias.sqlite'), unbind = bindAssessmentStore(path, canonical);
  try { await work(new EvidenceStore('run-row-bound', path, 'https://fixture.invalid/'), canonical); }
  finally { unbind(); canonical.close(); await rm(root, { recursive: true, force: true }); }
}

describe('evidence receipt row bound (A5-fix-1)', () => {
  it('commits the measured oversized receipt and marks the shortened excerpt', async () => fixture(async (store, canonical) => {
    const id = await store.receipt('worker-a', 'net', 'c'.repeat(785), {
      code: 0, stdout: 'A'.repeat(15203), stderr: '', truncated: false }, '2030-10-30T00:28:02.117Z', CAPTURE);
    const row = canonical.record(id)!;
    expect(row.kind).toBe('evidence');
    expect(rowBytes(row)).toBeLessThanOrEqual(LEDGER_ROW_BYTES);
    expect(row.data!.truncated).toBe(true);
    expect(row.data!.capture).toMatchObject({ artifacts: [{ id: CAPTURE.artifacts[0].id }] });
    // The store is healthy: the next receipt commits too.
    await store.receipt('worker-a', 'shell', 'inert follow-up', { code: 0, stdout: 'ok', stderr: '', truncated: false }, '2030');
  }));

  it('fits the worst excerpt combination, keeping the command and both excerpts non-empty until empty', async () => fixture(async (store, canonical) => {
    const id = await store.receipt('worker-a', 'http', 'i'.repeat(2000), {
      code: 0, stdout: 'o'.repeat(48 * 1024), stderr: 'e'.repeat(48 * 1024), truncated: true,
      hops: Array.from({ length: 6 }, () => `h${'x'.repeat(300)}`) }, '2030', CAPTURE);
    const row = canonical.record(id)!;
    expect(rowBytes(row)).toBeLessThanOrEqual(LEDGER_ROW_BYTES);
    expect(row.data!.truncated).toBe(true);
    expect(row.data!.input).toBe('i'.repeat(1500)); // the command text is the last excerpt trimmed, not the first
  }));

  it('keeps the row refusal a coded, recognizable class for the retention path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-row-legacy-'));
    const path = join(root, 'records.jsonl');
    try {
      await expect(appendRecord(path, { id: randomUUID(), runId: 'run-row-bound', by: 'owner', at: '2030', kind: 'note', text: 'x'.repeat(20 * 1024) }))
        .rejects.toMatchObject({ message: 'Record is too large', code: RECORD_TOO_LARGE });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
