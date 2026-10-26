import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendRecord, readLedger } from '../../src/records.js';
import { EvidenceStore, RECEIPT_INPUT_BYTES, RECEIPT_STDERR_BYTES, RECEIPT_STDOUT_BYTES } from '../../src/evidence.js';
import type { CaptureReceipt } from '../../src/artifacts.js';

/**
 * A7.6 (planning_update.md P7.2): the receipt ceiling. The excerpt a receipt keeps is the citable record, so it must be large enough for a
 * proof (16 KiB stdout / 4 KiB stderr, up from 4000/1000) while the input bound, the redaction path and the visible cap stay where they were.
 * Anything larger belongs in a `p2o_capture` artifact, whose ID the receipt already stores.
 */
async function fixture(work: (store: EvidenceStore, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-ceiling-'));
  const path = join(root, 'records.jsonl');
  await appendRecord(path, { id: randomUUID(), runId: 'run-ceiling', by: 'owner', at: '2030', kind: 'lifecycle', text: 'test start' });
  try { await work(new EvidenceStore('run-ceiling', path, 'fixture'), path); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const result = (stdout: string, stderr = '') => ({ code: 0, stdout, stderr, truncated: false });
const dataFor = async (path: string, id: string) => {
  const index = await readLedger(path, 'run-ceiling');
  expect(index.complete).toBe(true);
  return index.byId.get(id)!.data as Record<string, any>;
};
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe('evidence receipt ceiling (A7.6)', () => {
  it('keeps the raised bounds and the unchanged input bound', () => {
    expect([RECEIPT_STDOUT_BYTES, RECEIPT_STDERR_BYTES, RECEIPT_INPUT_BYTES]).toEqual([16384, 4096, 2000]);
  });

  it('retains proofs the old 4000/1000 bounds cut, and marks a larger observation as bounded', async () => fixture(async (store, path) => {
    const kept = await store.receipt('owner', 'shell', 'inert fixture', result(`${'A'.repeat(11990)}STDOUT-END`, `${'E'.repeat(2990)}STDERR-END`), '2030');
    const data = await dataFor(path, kept);
    expect(data.stdout).toBe(`${'A'.repeat(11990)}STDOUT-END`); // would have stopped at 4000 before this change
    expect(data.stderr).toBe(`${'E'.repeat(2990)}STDERR-END`);   // would have stopped at 1000
    expect(data.truncated).toBe(false);
    const cut = await store.receipt('owner', 'shell', 'inert fixture', result('A'.repeat(40000), 'E'.repeat(20000)), '2030');
    const bounded = await dataFor(path, cut);
    expect(jsonBytes(bounded.stdout)).toBeLessThanOrEqual(RECEIPT_STDOUT_BYTES);
    expect(jsonBytes(bounded.stderr)).toBeLessThanOrEqual(RECEIPT_STDERR_BYTES);
    expect(bounded.stdout.length).toBeLessThan(40000);
    expect(bounded.truncated).toBe(true);
  }));

  it('still bounds the recorded command and still redacts secrets inside the larger excerpt', async () => fixture(async (store, path) => {
    const id = await store.receipt('owner', 'shell', `curl -H "Authorization: Bearer abcdefghijklmnop" ${'x'.repeat(9000)}`,
      result(`${'a'.repeat(8000)} password=hunter2secret ${'b'.repeat(4000)}`, 'Set-Cookie: session=cookiesecretvalue'), '2030');
    const data = await dataFor(path, id);
    expect(jsonBytes(data.input)).toBeLessThanOrEqual(RECEIPT_INPUT_BYTES);
    expect(data.stdout).toContain('password=[REDACTED]');
    expect(data.stdout).not.toContain('hunter2secret');
    expect(data.stderr).toMatch(/set-cookie: \[REDACTED\]/i);
    expect(data.stderr).not.toContain('cookiesecretvalue');
    // The excerpt below the ceiling is kept whole: 8000 + 'password=hunter2secret' (21) + 1 + 4000, with 2 bytes removed by redaction.
    expect(data.stdout.length).toBe(12021);
  }));

  it('stores the capture artifact a receipt was taken with, so the ID is citable next to the receipt', async () => fixture(async (store, path) => {
    const artifact = { id: `artifact-${randomUUID()}`, stream: 'stdout' as const, totalBytes: 200000, capturedInputBytes: 16384, bytes: 16384,
      sha256: 'a'.repeat(64), truncated: true, captureOutcome: 'returned' as const };
    const capture: CaptureReceipt = { available: true, maxBytes: 8 * 1024 * 1024, observedBytes: 200000, capturedBytes: 16384, artifacts: [artifact] };
    const id = await store.receipt('worker-a', 'capture', 'report.txt', result('retained prefix'), '2030', capture);
    const data = await dataFor(path, id);
    expect(data.capture.artifacts[0]).toMatchObject({ id: artifact.id, sha256: artifact.sha256, truncated: true });
  }));
});
