import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestJson } from '../../src/contracts/index.js';
import { EvidenceError, openEvidenceVault, sha256 } from '../../src/evidence/index.js';
import { createHarness, INPUT, NOW, SOURCE } from './fixtures.js';

test('vault admits only authenticated, hash-verified artifacts and replays idempotently', () => {
  const h = createHarness();
  try {
    const handle = h.vault.issueCollector(h.grant());
    const submission = h.submission('source-1');
    const first = h.vault.admit(handle, submission);
    assert.equal(first.duplicate, false);
    assert.equal(first.receipt.provenance.trust, 'collector');
    assert.equal(first.receipt.digest, sha256(SOURCE));
    const replay = h.vault.admit(handle, submission);
    assert.equal(replay.duplicate, true);
    assert.equal(digestJson(replay.receipt), digestJson(first.receipt));
    assert.equal(h.vault.read('source-1').toString('utf8'), SOURCE);
    assert.equal(h.vault.inspect('source-1')!.collector.toolImplementationDigest, h.grant().tool.implementationDigest);
    assert.equal(h.vault.list(h.run.runId).length, 1);
  } finally { h.dispose(); }
});

test('a different artifact under the same idempotency key is rejected, never re-admitted', () => {
  const h = createHarness();
  try {
    const handle = h.vault.issueCollector(h.grant());
    h.vault.admit(handle, h.submission('source-1'));
    const forged = h.submission('source-1', 'source', { summary: 'changed content' }, 'export const handler = () => null;\n');
    const outcome = h.vault.tryAdmit(handle, forged);
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.status === 'rejected' && outcome.code, 'idempotency-conflict');
    assert.equal(h.vault.read('source-1').toString('utf8'), SOURCE);
  } finally { h.dispose(); }
});

test('forged digests, worker-authored receipts and unknown evidence IDs never become trusted', () => {
  const h = createHarness();
  try {
    const handle = h.vault.issueCollector(h.grant());
    const forged = h.submission('source-1');
    forged.artifact.expectedDigest = 'a'.repeat(64);
    assert.equal(h.vault.tryAdmit(handle, forged).status, 'rejected');
    assert.equal(h.vault.get('source-1'), undefined);
    assert.throws(() => h.vault.issueCollector(h.grant({ validFrom: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-02T00:00:00.000Z' })), (e: unknown) => e instanceof EvidenceError && e.code === 'collector-expired');
    assert.equal(h.vault.get('missing-evidence'), undefined);
    assert.throws(() => h.vault.read('missing-evidence'), (e: unknown) => e instanceof EvidenceError && e.code === 'missing-evidence');
    // A fabricated capability object is not authentication.
    assert.throws(() => h.vault.admit({ capability: 'supervisor-collector' } as never, h.submission('source-2')), (e: unknown) => e instanceof EvidenceError && e.code === 'collector-authentication');
  } finally { h.dispose(); }
});

test('stale, future-dated and out-of-window collection times are rejected', () => {
  let clock = NOW;
  const h = createHarness({ clock: () => clock });
  try {
    const handle = h.vault.issueCollector(h.grant({ expiresAt: new Date(Date.parse(NOW) + 2_000).toISOString() }));
    assert.equal(h.vault.tryAdmit(handle, h.submission('future', 'source', { collectedAt: new Date(Date.parse(NOW) + 60_000).toISOString() })).status, 'rejected');
    clock = new Date(Date.parse(NOW) + 10_000).toISOString();
    assert.equal(h.vault.tryAdmit(handle, h.submission('outside', 'source', { collectedAt: NOW })).status, 'rejected');
    const longLived = h.vault.issueCollector(h.grant());
    clock = new Date(Date.parse(NOW) + 400_000).toISOString();
    const aged = h.vault.tryAdmit(longLived, h.submission('aged', 'source', { collectedAt: NOW }));
    assert.equal(aged.status, 'rejected');
    assert.equal(aged.status === 'rejected' && aged.code, 'stale-evidence');
  } finally { h.dispose(); }
});

test('collector kind, classification, root and environment identities are enforced', () => {
  const h = createHarness();
  try {
    const readOnly = h.vault.issueCollector(h.grant({ allowedKinds: ['source'], allowedClassifications: ['static-inference'] }));
    assert.equal(h.vault.tryAdmit(readOnly, h.submission('bad-kind', 'reproduction')).status, 'rejected');
    const elsewhere = h.vault.issueCollector(h.grant({ artifactRootIds: ['staging'], originalEnvironment: true, modifications: ['patched debug build'] }));
    assert.equal(h.vault.tryAdmit(elsewhere, h.submission('undisclosed-modification', 'source')).status, 'rejected');
    assert.throws(() => h.vault.issueCollector(h.grant({ artifactRootIds: ['unknown-root'] })), (e: unknown) => e instanceof EvidenceError && e.code === 'collector-root');
  } finally { h.dispose(); }
});

test('paths, symlinks and hardlink aliases cannot escape the collection root', () => {
  const h = createHarness();
  try {
    const handle = h.vault.issueCollector(h.grant());
    const outside = join(h.base, 'outside.txt');
    writeFileSync(outside, SOURCE, { mode: 0o600 });
    symlinkSync(outside, join(h.staging, 'link.txt'));
    const link = h.submission('source-link');
    link.artifact.path = 'link.txt';
    assert.equal(h.vault.tryAdmit(handle, link).status, 'rejected');
    const traverse = h.submission('source-traverse');
    traverse.artifact.path = '../outside.txt';
    assert.equal(h.vault.tryAdmit(handle, traverse).status, 'rejected');
    mkdirSync(join(h.staging, 'nested'), { mode: 0o700 });
    symlinkSync(outside, join(h.staging, 'nested', 'deep-link.txt'));
    const deep = h.submission('source-deep');
    deep.artifact.path = 'nested/deep-link.txt';
    assert.equal(h.vault.tryAdmit(handle, deep).status, 'rejected');
  } finally { h.dispose(); }
});

test('worker-writable roots cannot host the evidence vault', () => {
  const h = createHarness();
  try {
    assert.throws(() => openEvidenceVault({ root: join(h.worker, 'vault'), artifactRoots: { staging: h.staging }, workerWriteRoots: [h.worker] }),
      (e: unknown) => e instanceof EvidenceError && (e.code === 'private-root' || e.code === 'vault-busy'));
  } finally { h.dispose(); }
});

test('redaction removes secrets before preservation while preserving original identity', () => {
  const secret = 'sup3r-secret-token-value';
  const h = createHarness({ secrets: [secret] });
  try {
    const content = JSON.stringify({ token: secret, note: `password=${secret}` });
    const receipt = h.collect('log-1', 'log', {}, { allowedKinds: ['log'] }, content);
    const preserved = h.vault.read('log-1').toString('utf8');
    assert.equal(preserved.includes(secret), false);
    assert.match(preserved, /\[REDACTED\]/);
    assert.equal(receipt.redacted, true);
    const record = h.vault.inspect('log-1')!;
    assert.equal(record.originalDigest, sha256(content));
    assert.notEqual(receipt.digest, record.originalDigest);
  } finally { h.dispose(); }
});

test('binary, BOM, unknown media types and oversized artifacts are refused', () => {
  const h = createHarness({ limits: { maxArtifactBytes: 256 } });
  try {
    const handle = h.vault.issueCollector(h.grant());
    const binary = h.submission('binary-1', 'log');
    writeFileSync(join(h.staging, 'binary-1.log'), Buffer.from([0, 1, 2, 3]));
    binary.artifact = { rootId: 'staging', path: 'binary-1.log', expectedDigest: sha256(Buffer.from([0, 1, 2, 3])), expectedBytes: 4, mediaType: 'text/plain' };
    assert.equal(h.vault.tryAdmit(handle, binary).status, 'rejected');
    const bom = h.submission('bom-1', 'log');
    const bomContent = `\uFEFFsecret=1`;
    writeFileSync(join(h.staging, 'bom-1.log'), bomContent);
    bom.artifact = { rootId: 'staging', path: 'bom-1.log', expectedDigest: sha256(bomContent), expectedBytes: Buffer.byteLength(bomContent), mediaType: 'text/plain' };
    assert.equal(h.vault.tryAdmit(handle, bom).status, 'rejected');
    const unknown = h.submission('media-1', 'log');
    unknown.artifact.mediaType = 'application/octet-stream';
    assert.equal(h.vault.tryAdmit(handle, unknown).status, 'rejected');
    const large = h.submission('large-1', 'log', {}, 'x'.repeat(1024));
    assert.equal(h.vault.tryAdmit(handle, large).status, 'rejected');
  } finally { h.dispose(); }
});

test('tampered, substituted and stale preserved artifacts fail closed on read', () => {
  const h = createHarness();
  try {
    h.collect('source-1');
    const artifact = join(h.vaultRoot, 'artifacts', `${sha256(SOURCE)}.blob`);
    chmodSync(artifact, 0o600);
    writeFileSync(artifact, 'export const handler = () => compromised;\n');
    assert.throws(() => h.vault.get('source-1'), (e: unknown) => e instanceof EvidenceError && e.code === 'artifact-integrity');
    assert.throws(() => h.vault.read('source-1'), () => true);
  } finally { h.dispose(); }
});

test('receipt and artifact budgets are bounded before publication', () => {
  const h = createHarness({ limits: { maxReceipts: 2, maxTotalBytes: 512, maxArtifactBytes: 512 } });
  try {
    h.collect('source-1'); h.collect('source-2', 'source', {}, {}, 'export const a = 1;\n');
    assert.equal(h.vault.tryAdmit(h.vault.issueCollector(h.grant()), h.submission('source-3', 'source', {}, 'export const b = 2;\n')).status, 'rejected');
  } finally { h.dispose(); }
});

test('the byte budget is enforced before publication', () => {
  const h = createHarness({ limits: { maxTotalBytes: Buffer.byteLength(SOURCE), maxArtifactBytes: Buffer.byteLength(SOURCE) } });
  try {
    h.collect('source-1');
    const outcome = h.vault.tryAdmit(h.vault.issueCollector(h.grant()), h.submission('source-2', 'source', {}, 'export function extra() {}\n'));
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.status === 'rejected' && outcome.code, 'vault-limit');
  } finally { h.dispose(); }
});

test('vault state survives reopen, rejects a second writer, and detects modified records', () => {
  const h = createHarness();
  try {
    h.collect('source-1');
    const hash = sha256(SOURCE);
    assert.throws(() => openEvidenceVault({ root: h.vaultRoot, artifactRoots: { staging: h.staging }, workerWriteRoots: [h.worker] }), (e: unknown) => e instanceof EvidenceError && e.code === 'vault-busy');
    h.vault.close();
    const reopened = openEvidenceVault({ root: h.vaultRoot, artifactRoots: { staging: h.staging }, workerWriteRoots: [h.worker] });
    assert.equal(reopened.get('source-1')!.digest, hash);
    assert.equal(reopened.read('source-1').toString('utf8'), SOURCE);
    reopened.close();
    const recordPath = join(h.vaultRoot, 'records', `${digestJson({ runId: h.run.runId, collectorId: 'collector-1', idempotencyKey: 'source-1' })}.json`);
    chmodSync(recordPath, 0o600);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    record.body.receipt.summary = 'forged summary';
    writeFileSync(recordPath, JSON.stringify(record));
    assert.throws(() => openEvidenceVault({ root: h.vaultRoot, artifactRoots: { staging: h.staging }, workerWriteRoots: [h.worker] }), (e: unknown) => e instanceof EvidenceError && e.code === 'vault-integrity');
  } finally { rmSync(h.base, { recursive: true, force: true }); }
});

test('symlinked and non-canonical roots are refused', () => {
  const h = createHarness();
  try {
    symlinkSync(h.base, join(h.base, 'linked-root'));
    assert.throws(() => openEvidenceVault({ root: join(h.base, 'linked-root', 'vault-linked'), artifactRoots: { staging: h.staging }, workerWriteRoots: [h.worker] }), (e: unknown) => e instanceof EvidenceError && (e.code === 'symlink-denied' || e.code === 'path-denied'));
    assert.equal(INPUT, sha256(SOURCE));
  } finally { h.dispose(); }
});
