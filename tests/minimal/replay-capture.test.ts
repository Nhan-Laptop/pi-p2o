import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendRecord, readLedger } from '../../src/records.js';
import { replayCommandUnit, replayEnvironmentFingerprint, replayRequestUnit, storeReplayUnit } from '../../src/replay.js';
import { isReplayable } from '../../src/claims.js';
import { isPayloadId, PayloadStore } from '../../src/lab.js';
import { EvidenceStore } from '../../src/evidence.js';
import { independentReceiptCurrent } from '../../src/cases.js';
import { situationLine, summarizeSituation } from '../../src/situation.js';
import { evidenceFor, fixture } from './helpers/report-fixture.js';

/**
 * planning_update.md P21/A1+А2: the host records the admitted replay unit and the claim inherits it, so a tested claim is
 * replayable with zero model `p2o_lab` calls, and a validation worker records its reproduction with one field.
 *
 * Hermetic: the inert sandbox stands in for Docker, and no model runs. The private payload bytes are read through the same
 * `PayloadStore` the host uses, because the point of the test is that the host, not the model, stored them.
 */

const REPLAY_IDENTITY = { runtime: 'p2o-test', extensionSha: 'sha-fixture', image: 'p2o-sandbox:fixture', executorMode: 'shared' };
async function runDirectory(h: any): Promise<string> {
  const name = (await readdir(join(h.root, 'control'))).find(entry => entry.startsWith('p2o-run-'));
  if (!name) throw new Error('no active control run');
  return join(h.root, 'control', name);
}
const receiptsOf = async (h: any) => {
  const directory = await runDirectory(h);
  return (await readLedger(join(directory, 'records.sqlite'))).records;
};
const payloadStoreFor = async (h: any) => new PayloadStore(join(await runDirectory(h), 'records.sqlite'));

describe('P21/A1 replay unit (pure)', () => {
  it('canonicalizes equivalent requests to one unit and keeps operator placeholders verbatim', () => {
    const first = replayRequestUnit({ method: 'POST', url: 'http://fixture.test/login', headers: { 'X-Test': 'b', Authorization: 'Bearer ${P2O_SECRET:api}' }, body: 'user=${P2O_SECRET:db}' });
    const second = replayRequestUnit({ url: 'http://fixture.test/login', method: 'POST', body: 'user=${P2O_SECRET:db}', headers: { Authorization: 'Bearer ${P2O_SECRET:api}', 'X-Test': 'b' } });
    expect(first).toEqual(second);
    expect(first.kind).toBe('request');
    expect(first.name.length).toBeLessThanOrEqual(120);
    expect(JSON.parse(first.body)).toEqual({ version: 1, method: 'POST', url: 'http://fixture.test/login', headers: { Authorization: 'Bearer ${P2O_SECRET:api}', 'X-Test': 'b' }, body: 'user=${P2O_SECRET:db}' });
    expect(JSON.stringify(first.body)).not.toContain('tok-');
    // A shell command is its own unit, named by its first line only.
    expect(replayCommandUnit('shell', 'printf one\nprintf two')).toMatchObject({ kind: 'command', body: 'printf one\nprintf two' });
    expect(replayCommandUnit('shell', 'printf one\nprintf two').name).not.toContain('\n');
  });

  it('derives one environment fingerprint per runtime identity and changes when the identity changes', () => {
    const base = replayEnvironmentFingerprint(REPLAY_IDENTITY);
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(replayEnvironmentFingerprint({ ...REPLAY_IDENTITY })).toBe(base);
    expect(replayEnvironmentFingerprint({ ...REPLAY_IDENTITY, image: 'p2o-sandbox:other' })).not.toBe(base);
    expect(replayEnvironmentFingerprint({ ...REPLAY_IDENTITY, executorMode: 'isolated' })).not.toBe(base);
    expect(replayEnvironmentFingerprint({ ...REPLAY_IDENTITY, runtime: 'p2o-test-2' })).not.toBe(base);
  });

  it('stores bytes privately, fails closed over the payload bound, and never throws at the seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-replay-'));
    try {
      const records = join(root, 'records.sqlite');
      const unit = replayRequestUnit({ method: 'GET', url: 'http://fixture.test/orders/7' });
      const stamp = await storeReplayUnit(records, 'worker-a', unit, REPLAY_IDENTITY.image);
      expect(stamp).toMatchObject({ captured: true, bytes: Buffer.byteLength(unit.body), kind: 'request' });
      expect(isPayloadId(stamp.payloadRef)).toBe(true);
      const stored = await new PayloadStore(records).get(stamp.payloadRef);
      expect(stored.body).toBe(unit.body);
      expect(stored.ref.sha256).toBe(stamp.sha256);
      // 48 KiB of body plus the canonical envelope is over the payload bound: a recorded gap, never a thrown operation error.
      const oversized = await storeReplayUnit(records, 'worker-a', replayRequestUnit({ method: 'POST', url: 'http://fixture.test/big', body: 'x'.repeat(48 * 1024) }), 'f'.repeat(64));
      expect(oversized).toMatchObject({ captured: false, environmentFingerprint: 'f'.repeat(64) });
      expect(oversized.reason).toMatch(/payload bound/);
      expect(oversized.payloadRef).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('stamps the receipt with the reference and keeps the bytes out of an export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-replay-export-'));
    try {
      const records = join(root, 'records.jsonl');
      const runId = 'run-replay-export';
      await appendRecord(records, { id: randomUUID(), runId, at: '2030-01-01', by: 'owner', kind: 'lifecycle', text: 'test start' });
      const store = new EvidenceStore(runId, records, 'fixture');
      const stamp = await storeReplayUnit(records, 'worker-a', replayRequestUnit({ method: 'POST', url: 'http://fixture.test/secret', headers: { 'X-Marker': 'MARKER-PAYLOAD-BYTES' } }), 'e'.repeat(64));
      expect(stamp.captured).toBe(true);
      const id = await store.receipt('worker-a', 'http', 'POST /secret', { code: 0, stdout: 'ok', stderr: '', truncated: false }, '2030-01-01', undefined, stamp);
      const ledger = await readLedger(records, runId);
      expect(ledger.byId.get(id)?.data?.replay).toEqual(stamp);
      const cwd = join(root, 'cwd');
      await (await import('node:fs/promises')).mkdir(cwd);
      const exported = await store.exportTo(cwd, { runId });
      const text = await readFile(exported, 'utf8');
      expect(text).toContain(stamp.payloadRef!);
      expect(text).toContain(stamp.sha256!);
      // The whole export, not just the ledger row: the private control bytes must never be copied into it.
      expect(text).not.toContain('MARKER-PAYLOAD-BYTES');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('P21/A1+A2 replay capture and claim inheritance (extension)', () => {
  it('stamps owner http and shell receipts, stores the pre-substitution unit, and stamps a claim without any p2o_lab call', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const http = (await h.call('p2o_http', { url: 'http://fixture.test/login', method: 'POST', body: 'user=fixture', headers: { 'X-Test': 'header' } })).details;
      const shell = (await h.call('p2o_shell', { command: 'printf replay-unit' })).details;
      const receipts: any[] = (await receiptsOf(h)).filter((row: any) => row.kind === 'evidence');
      const httpReceipt: any = receipts.find((row: any) => row.id === http.evidenceId)!;
      const shellReceipt: any = receipts.find((row: any) => row.id === shell.evidenceId)!;
      expect(httpReceipt.data.replay).toMatchObject({ captured: true, kind: 'request', bytes: expect.any(Number) });
      expect(shellReceipt.data.replay).toMatchObject({ captured: true, kind: 'command' });
      const fingerprint = httpReceipt.data.replay.environmentFingerprint;
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(shellReceipt.data.replay.environmentFingerprint).toBe(fingerprint);
      const payload = await (await payloadStoreFor(h)).get(httpReceipt.data.replay.payloadRef);
      expect(JSON.parse(payload.body)).toMatchObject({ method: 'POST', url: 'http://fixture.test/login', headers: { 'X-Test': 'header' }, body: 'user=fixture' });

      // P21/A2: the claim cites the receipts; the host stamps the canonical replay instead of asking for p2o_lab calls.
      const evidence = await evidenceFor(h);
      const claim = await evidence.candidate('worker-a', { candidate: 'replay-inherited-claim', surface: '/login', risk: 'authorization',
        closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', evidenceRefs: [http.evidenceId, shell.evidenceId], negativeControls: [],
        policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor boundary', limitations: 'One inert fixture request only' } as never);
      expect(claim.data?.payloadSha256).toBe(httpReceipt.data.replay.sha256);
      expect(claim.data?.payloadRef).toBe(httpReceipt.data.replay.payloadRef);
      expect(claim.data?.environmentFingerprint).toBe(fingerprint);
      expect(claim.data?.replayUnits).toHaveLength(2);
      expect(isReplayable(claim.data ?? {})).toBe(true);
      expect(claim.data?.admissionWarnings).toBeUndefined();
    });
  });

  it('records a >48 KiB unit as a visible gap instead of failing the request', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const result = (await h.call('p2o_http', { url: 'http://fixture.test/big', method: 'POST', body: 'x'.repeat(48 * 1024) })).details;
      const receipt: any = (await receiptsOf(h)).find((row: any) => row.id === result.evidenceId)!;
      expect(receipt.data.replay).toMatchObject({ captured: false });
      expect(receipt.data.replay.reason).toMatch(/payload bound/);
    });
  });

  it('stores the placeholder, never the substituted operator value', async () => {
    await fixture(async h => {
      const identity = join(h.root, 'identity.json');
      await writeFile(identity, JSON.stringify({ secrets: [{ id: 'api', kind: 'token', value: 'tok-must-not-be-stored' }] }));
      await h.command(`--target ./source --identity ${identity}`);
      const result = (await h.call('p2o_http', { url: 'http://fixture.test/login', method: 'POST', headers: { Authorization: 'Bearer ${P2O_SECRET:api}' }, body: 'token=${P2O_SECRET:api}' })).details;
      const receipt: any = (await receiptsOf(h)).find((row: any) => row.id === result.evidenceId)!;
      expect(receipt.data.replay.captured).toBe(true);
      const payload = await (await payloadStoreFor(h)).get(receipt.data.replay.payloadRef);
      expect(payload.body).toContain('${P2O_SECRET:api}');
      expect(payload.body).not.toContain('tok-must-not-be-stored');
      expect(JSON.stringify(receipt)).not.toContain('tok-must-not-be-stored');
    });
  });
});

describe('P21/A2 reproduces write-back', () => {
  it('accepts a reproduction with one field, stamps the author receipt, and refuses the four illegal shapes', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const records = join(await runDirectory(h), 'records.sqlite');
      const runId = (await receiptsOf(h))[0].runId;
      const sha = 'a'.repeat(64), fingerprint = 'e'.repeat(64);
      const receipt = async (by: string, digest: string) => {
        const id = randomUUID();
        await appendRecord(records, { id, runId, at: new Date().toISOString(), by, workerId: by, kind: 'evidence',
          text: 'http exit 0; untrusted observation, not a finding', data: { operation: 'http', replay: { captured: true, payloadRef: `payload-${randomUUID()}`, sha256: digest, bytes: 42, kind: 'request', environmentFingerprint: fingerprint } } });
        return id;
      };
      const authorReceipt = await receipt('worker-a', sha), ownReceipt = await receipt('worker-b', sha), otherReceipt = await receipt('worker-b', 'd'.repeat(64));
      const evidence = await evidenceFor(h);
      const base = { surface: '/login', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', negativeControls: [],
        policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture actor boundary', limitations: 'One inert fixture request only' } as const;
      const original = await evidence.candidate('worker-a', { ...base, candidate: 'reproduced-effect', evidenceRefs: [authorReceipt] } as never);
      expect(original.data?.payloadSha256).toBe(sha);
      const reproduction = await evidence.candidate('worker-b', { ...base, candidate: 'reproduction-of-effect', evidenceRefs: [ownReceipt], reproduces: original.id } as never);
      expect(reproduction.data).toMatchObject({ reproducedClaimRef: original.id, independentEvidenceRef: authorReceipt, payloadSha256: sha, environmentFingerprint: fingerprint });
      // The case-level independence predicate reads exactly these fields.
      const index = await readLedger(records, runId);
      expect(independentReceiptCurrent(index, reproduction, authorReceipt)).toEqual({ ok: true });
      // Same actor.
      await expect(evidence.candidate('worker-a', { ...base, candidate: 'self-reproduction', evidenceRefs: [await receipt('worker-a', sha)], reproduces: original.id } as never)).rejects.toThrow(/cannot be reproduced by you/);
      // Wrong surface/risk names the claim.
      await expect(evidence.candidate('worker-b', { ...base, candidate: 'wrong-surface-reproduction', surface: '/elsewhere', evidenceRefs: [await receipt('worker-b', sha)], reproduces: original.id } as never)).rejects.toThrow(/keeps the claim's surface and risk: reproduced-effect/);
      // A replay of different bytes is refused with both hashes named.
      await expect(evidence.candidate('worker-b', { ...base, candidate: 'different-bytes-reproduction', evidenceRefs: [otherReceipt], reproduces: original.id } as never)).rejects.toThrow(/did not run the claim's payload/);
      // The two independence paths are alternatives, not a pair.
      await expect(evidence.candidate('worker-b', { ...base, candidate: 'both-paths-reproduction', evidenceRefs: [ownReceipt], reproduces: original.id, independentEvidenceRef: authorReceipt } as never)).rejects.toThrow(/one independence path/);
      // A reproduction without its own receipt is a copy.
      await expect(evidence.candidate('worker-b', { ...base, candidate: 'copy-reproduction', evidenceRefs: [authorReceipt], reproduces: original.id } as never)).rejects.toThrow(/needs your own receipt/);
      // An unknown claim fails closed instead of becoming an unattached claim.
      await expect(evidence.candidate('worker-b', { ...base, candidate: 'unknown-reproduction', evidenceRefs: [ownReceipt], reproduces: 'no-such-claim' } as never)).rejects.toThrow(/Unknown reproduced claim/);
      // The legacy path still works, and no longer cross-matches the latest claim when one author files two.
      const authorOfReceipt = 'worker-c', shared = await receipt(authorOfReceipt, 'f'.repeat(64));
      const first = await evidence.candidate(authorOfReceipt, { ...base, candidate: 'first-author-claim', evidenceRefs: [shared], surface: '/first' } as never);
      await evidence.candidate(authorOfReceipt, { ...base, candidate: 'second-author-claim', evidenceRefs: [shared], surface: '/second' } as never);
      const callerReceipt = await receipt('worker-d', '1'.repeat(64));
      const legacy = await evidence.candidate('worker-d', { ...base, candidate: 'legacy-peer-reproduction', surface: '/first', risk: 'authorization', evidenceRefs: [callerReceipt, shared], independentEvidenceRef: shared } as never);
      expect(legacy.surface).toBe('/first');
      expect(first.surface).toBe('/first');
    });
  });
});

describe('P21/A5 read surfaces', () => {
  it('prints the host replay reference in the report and the new counters in the situation line', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const http = (await h.call('p2o_http', { url: 'http://fixture.test/replay-report', method: 'GET' })).details;
      const evidence = await evidenceFor(h);
      const claim = await evidence.candidate('worker-a', { candidate: 'replayable-report-claim', surface: '/replay-report', risk: 'authorization',
        closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', evidenceRefs: [http.evidenceId], negativeControls: [],
        policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture boundary', limitations: 'One inert fixture request only' } as never);
      h.ctx.setConfirm(true);
      await h.command(`report export ${join(h.root, 'out')}`);
      const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
      expect(report).toContain('host replay `payload-');
      expect(report).not.toContain('| not replayable |');
      const decision = summarizeSituation({ tasks: [], cases: [], coverage: [], claims: [claim.data as never], derivedEdges: 3 });
      expect(decision.replayableClaims).toBe(1);
      expect(decision.derivedEdges).toBe(3);
      const line = situationLine(decision);
      expect(line).toContain('replay: 1 replayable claim, 3 derived edges');
      expect(line).not.toContain('derived edges is evidence');
      expect(line.length).toBeLessThanOrEqual(240);
    });
  });
});
