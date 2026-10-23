import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SkillLibrary, readPackageFile } from '../../src/skills.js';
import { EvidenceStore, redact, type Candidate } from '../../src/evidence.js';
import { appendRecord, readRecords, summarizeRecords } from '../../src/records.js';
import { EnvironmentStore, PayloadStore, normalizeRecipe } from '../../src/lab.js';

const IMAGE = 'p2o-target:fixture';

const ROOT = resolve(import.meta.dirname, '../..');
describe('approved knowledge', () => {
  it('reads every document and resolves handoffs, scope and evidence links', async () => {
    const library = new SkillLibrary(ROOT);
    const c = await library.load();
    expect(c.skills.length).toBeGreaterThanOrEqual(21);
    for (const d of c.documents) {
      let page = await library.read(d.id);
      let text = page.text;
      while (page.nextOffset !== undefined) { page = await library.read(d.id, page.nextOffset); text += page.text; }
      expect(text.length, d.id).toBeGreaterThan(0);
      expect(page.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect((await library.read('source-code-auditing')).text).toContain('p2o-skill:shared:handoffs');
    expect((await library.read('source-code-auditing')).text).toContain('p2o-skill:evidence:b068');
    const list = await library.list();
    expect(list.nextOffset).toBe(8);
    expect(list.entries[0].kind).toBe('playbook');
    expect((await library.list(0, 'route')).entries.some(s => s.name === 'web-route-input-inventory')).toBe(true);
    expect((await library.list(0, 'nonexistent-term')).total).toBe(0);
    expect(JSON.stringify(list)).not.toContain(ROOT);
    await expect(library.read('../../etc/passwd')).rejects.toThrow('Unknown document');
    await expect(library.read('/etc/passwd')).rejects.toThrow('Unknown document');
    await expect(library.read('source-code-auditing', -1)).rejects.toThrow();
  });
  it('rejects symlinks, special files, escapes and oversized input; pagination is byte-bounded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-knowledge-'));
    try {
      await mkdir(join(root, 'skills'));
      await symlink('/etc/passwd', join(root, 'link.md'));
      await expect(readPackageFile(root, 'link.md')).rejects.toThrow();
      await symlink('/etc', join(root, 'escape'));
      await expect(readPackageFile(root, 'escape/passwd')).rejects.toThrow();
      await expect(readPackageFile(root, '../etc/passwd')).rejects.toThrow();
      await expect(readPackageFile(root, '/etc/passwd')).rejects.toThrow();
      await expect(readPackageFile(root, 'skills')).rejects.toThrow();
      await writeFile(join(root, 'huge.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
      await expect(readPackageFile(root, 'huge.md')).rejects.toThrow();
      const text = ('測定😀'.repeat(1000) + '\n\n').repeat(10);
      await writeFile(join(root, 'text.md'), text);
      await writeFile(join(root, 'skills/catalog.json'), JSON.stringify({ version: 1, skills: [], documents: [{ id: 'test', path: 'text.md' }] }));
      const lib = new SkillLibrary(root); let offset: number | undefined = 0, assembled = '';
      while (offset !== undefined) { const page = await lib.read('test', offset); assembled += page.text; offset = page.nextOffset; expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64000); }
      expect(assembled).toBe(text);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
describe('evidence contracts and export', () => {
  it('validates real references, revisions and independent provenance; preserves receipts after cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-evidence-'));
    try {
      const records = join(root, 'records.jsonl'); const store = new EvidenceStore('run-test', records, '/target');
      const receipt = await store.receipt('owner', 'shell', 'read source', { code: 0, stdout: 'observation', stderr: '', truncated: false }, new Date().toISOString());
      const c: Candidate = { candidate: 'candidate-a', surface: '/x', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'static_trace', evidenceRefs: [receipt], negativeControls: [], policyBasis: 'explicit_contract', expectedPolicy: 'Local test contract: protected object belongs to its owner', limitations: 'Static only; no live proof' };
      await expect(store.candidate('owner', { ...c, policyBasis: 'inferred' })).rejects.toThrow('Inferred policy');
      await expect(store.candidate('owner', { ...c, policyBasis: 'inferred', closure: 'ruled_out', control: 'a sibling is safe' })).rejects.toThrow('Inferred policy');
      await expect(store.candidate('owner', { ...c, evidenceRefs: ['missing'] })).rejects.toThrow('Unknown same-run');
      await expect(store.candidate('owner', { ...c, closure: 'ruled_out' })).rejects.toThrow('specific control');
      await expect(store.candidate('owner', { ...c, execution: 'blocked', requirement: 'http.authenticated' })).rejects.toThrow('Blocked');
      await expect(store.candidate('owner', { ...c, independentEvidenceRef: receipt })).rejects.toThrow('different worker');
      await appendRecord(records, { id: 'open-item-1', runId: 'run-test', at: new Date().toISOString(), by: 'owner', kind: 'open', text: 'Unresolved hypothesis' });
      const one = await store.candidate('owner', { ...c, closure: 'open_proof_gap' });
      await expect(store.candidate('owner', c)).rejects.toThrow('supersede');
      const two = await store.candidate('owner', { ...c, supersedes: one.id, resolves: ['open-item-1'] });
      const summary = summarizeRecords(await readRecords(records));
      expect(summary.open).toEqual([]);
      expect(summary.coverage.map(r => r.id)).toEqual([two.id]);
      const exported = await store.exportTo(root, { test: true });
      await rm(records);
      expect(JSON.parse(await readFile(exported, 'utf8')).records).toHaveLength(4);
      await expect(store.exportTo(root, {})).rejects.toThrow();
      const malicious = join(root, 'malicious'); await mkdir(malicious); await symlink('/tmp', join(malicious, '.p2o-reports'));
      await expect(store.exportTo(malicious, {})).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('stamps what ran on a claim and refuses an independence claim whose peer ran something else (P14.12)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-replay-'));
    try {
      const records = join(root, 'records.jsonl'), store = new EvidenceStore('run-replay', records, '/target');
      const payload = await new PayloadStore(records).put('worker-a', { kind: 'request', name: 'replayed request', body: 'GET /x HTTP/1.1\n\n' });
      const other = await new PayloadStore(records).put('worker-a', { kind: 'request', name: 'unrelated request', body: 'GET /y HTTP/1.1\n\n' });
      const environment = await new EnvironmentStore(records).put('worker-a', 'fixture-app', normalizeRecipe({ setup: ['true'] }, IMAGE));
      const drift = await new EnvironmentStore(records).put('worker-a', 'fixture-other', normalizeRecipe({ setup: ['false'] }, IMAGE));
      const base: Candidate = { candidate: 'replayed-effect', surface: '/x', risk: 'authorization', closure: 'confirmed', execution: 'tested',
        proof: 'live_reproduction', evidenceRefs: [], negativeControls: [], policyBasis: 'explicit_contract',
        expectedPolicy: 'Declared fixture boundary', limitations: 'Fixture only; no live target', payloadRef: payload.id, environmentRef: environment.ref.id };
      // Two independent productions of the same bytes: the peer stores its own copy, and the sha256 is what makes them the same effect.
      const peerPayload = await new PayloadStore(records).put('worker-b', { kind: 'request', name: 'replayed request', body: 'GET /x HTTP/1.1\n\n' });
      expect(peerPayload.sha256).toBe(payload.sha256); expect(peerPayload.id).not.toBe(payload.id);
      const peerReceipt = await store.receipt('worker-b', 'shell', 'replay', { code: 0, stdout: 'reflected', stderr: '', truncated: false }, new Date().toISOString());
      const peer = await store.candidate('worker-b', { ...base, candidate: 'peer-replay', evidenceRefs: [peerReceipt], payloadRef: peerPayload.id });
      expect(peer.data).toMatchObject({ payloadSha256: payload.sha256, environmentFingerprint: environment.ref.fingerprint });
      const author = await store.candidate('worker-a', { ...base, evidenceRefs: [peerReceipt], independentEvidenceRef: peerReceipt });
      expect(author.data).toMatchObject({ payloadSha256: payload.sha256, environmentFingerprint: environment.ref.fingerprint });
      // Fail closed, with the field that differs named: a drifted payload, a drifted recipe, and a claim that names nothing at all.
      await expect(store.candidate('worker-a', { ...base, supersedes: author.id, payloadRef: other.id, evidenceRefs: [peerReceipt], independentEvidenceRef: peerReceipt })).rejects.toThrow(/Independent replay mismatch/);
      await expect(store.candidate('worker-a', { ...base, supersedes: author.id, environmentRef: drift.ref.id, evidenceRefs: [peerReceipt], independentEvidenceRef: peerReceipt })).rejects.toThrow(/environment drifted/);
      await expect(store.candidate('worker-a', { ...base, supersedes: author.id, payloadRef: undefined, evidenceRefs: [peerReceipt], independentEvidenceRef: peerReceipt })).rejects.toThrow(/needs the payload that ran/);
      // A single-actor run cannot declare itself independent, whatever it stamps.
      await expect(store.candidate('worker-b', { ...base, candidate: 'peer-replay', supersedes: peer.id, evidenceRefs: [peerReceipt], independentEvidenceRef: peerReceipt })).rejects.toThrow(/different worker/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('redacts common credentials without treating redaction as a guarantee', () => {
    expect(redact('Authorization: Bearer abc\npassword=secret\nCookie: sid=x')).not.toContain('abc');
    expect(redact('Authorization: Bearer abc\npassword=secret\nCookie: sid=x')).not.toContain('sid=x');
  });
});
