import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AssessmentStore, type ArtifactManifest, type StoreManifest } from '../../src/state/store.js';
import type { AssessmentRecord } from '../../src/records.js';
import { extract } from '../../src/extract/index.js';
import { ingestExtract } from '../../src/graph-ingest.js';

/**
 * R2.3/R2.4: the extractor writer is host code with a host producer. These tests pin what a write can and cannot do: rows are
 * attributed and unverified, they cite the receipt that produced the artifact, they never create a claim/case, a re-ingest of
 * the same artifact adds an observation instead of a revision, and a component row is its canonical identity.
 */
const manifest = (runId: string): StoreManifest => ({ runId, retention: 'durable-local', targetKind: 'directory',
  targetIdentity: 'inert fixture', targetDisplay: 'inert fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } });

async function fixture(work: (store: AssessmentStore, evidence: (text?: string) => string, artifact: (text: string, kind?: string) => ArtifactManifest) => void | Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-ingest-'));
  let store: AssessmentStore | undefined;
  try {
    store = AssessmentStore.create(root, manifest('run-ingest'));
    const evidence = (text = 'bounded inert receipt') => store!.commitRecords([{ at: '2030', by: 'owner', runId: 'run-ingest', kind: 'evidence', text } as AssessmentRecord])[0].recordId;
    const artifact = (text: string, kind = 'shell-stdout') => store!.ingestArtifact('owner', Buffer.from(text, 'utf8'), { kind, mediaType: 'text/plain' });
    await work(store, evidence, artifact);
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
}

const nmap = `<nmaprun><host><status state="up"/><address addr="10.0.0.5" addrtype="ipv4"/><ports>
<port protocol="tcp" portid="22"><state state="open"/><service name="ssh" product="OpenSSH" version="8.9p1"/></port></ports></host></nmaprun>`;
const nuclei = JSON.stringify({ 'template-id': 'CVE-2021-41773', info: { name: 'Apache path traversal', severity: 'high' }, 'matched-at': 'https://portal.lab.test/cgi-bin/.%2e/bin/sh' }) + '\n';
const httpx = JSON.stringify({ url: 'https://portal.lab.test/login', status_code: 200, title: 'Portal' }) + '\n';
const lockfile = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21' }, 'node_modules/@scope/pkg': { version: '2.0.0' } } });

describe('ingest writes attributed, unverified knowledge (R2.3)', () => {
  it('writes assets, facts and an artifact anchor through the extractor producer, and no claim or case', async () => fixture(async (store, evidence, artifact) => {
    const file = artifact(nmap), parsed = extract({ text: nmap, kind: file.kind })!;
    const outcome = ingestExtract(store, parsed, { artifact: file, evidenceRefs: [evidence()] });
    expect(outcome).toMatchObject({ extractor: 'nmap', assets: 2, facts: 2, hypotheses: 0, batches: 3 });
    expect(parsed.omitted).toEqual({ assets: 0, facts: 0, hypotheses: 0, components: 0 });
    const exported = store.graphExport({ limit: 50 }).json;
    const host = exported.assets.find(row => row.kind === 'host')!;
    expect(host).toMatchObject({ recordedBy: 'extractor', kind: 'host', key: '10.0.0.5' });
    const anchors = exported.anchors.filter(row => row.assetEntity === host.entityId);
    expect(anchors[0]).toMatchObject({ kind: 'artifact', artifactId: file.id });
    const facts = exported.assertions.filter(row => String(row.kind).startsWith('fact:'));
    expect(facts).toHaveLength(2);
    for (const fact of facts) expect(fact).toMatchObject({ unverified: true });
    // The evidence ladder is unchanged: the extractor wrote rows, not observations about its own claims.
    expect(store.records().filter(record => record.kind === 'candidate')).toHaveLength(0);
  }));

  it('records a nuclei match as an open hypothesis with the receipt, never as a fact or a claim', async () => fixture(async (store, evidence, artifact) => {
    const file = artifact(nuclei), parsed = extract({ text: nuclei, kind: file.kind })!;
    expect(parsed.facts).toEqual([]);
    const outcome = ingestExtract(store, parsed, { artifact: file, evidenceRefs: [evidence()] });
    expect(outcome).toMatchObject({ assets: 1, hypotheses: 1, facts: 0 });
    const assertion = store.graphExport({ limit: 50 }).json.assertions.find(row => row.kind === 'hypothesis')!;
    expect(assertion).toMatchObject({ status: 'open', unverified: true, producerRole: 'extractor', evidenceRefs: [expect.stringMatching(/^[a-f0-9-]{36}$/)] });
  }));

  it('refuses to write rows that cite no same-run receipt', async () => fixture(async (store, _evidence, artifact) => {
    const file = artifact(nmap), parsed = extract({ text: nmap, kind: file.kind })!;
    expect(() => ingestExtract(store, parsed, { artifact: file, evidenceRefs: [] })).toThrow('INGEST_WITHOUT_EVIDENCE');
    expect(store.graphPage({ limit: 1 }).rows).toHaveLength(0);
  }));

  it('turns a re-ingest of the same artifact into an observation, and a changed artifact into a new revision', async () => fixture(async (store, evidence, artifact) => {
    const receipt = evidence();
    const first = artifact(httpx), parsed = extract({ text: httpx, kind: first.kind })!;
    ingestExtract(store, parsed, { artifact: first, evidenceRefs: [receipt] });
    const revisionOf = () => store.graphQuery({ kind: 'endpoint' }).rows[0]?.revision;
    expect(revisionOf()).toBe(1);
    const again = ingestExtract(store, parsed, { artifact: first, evidenceRefs: [receipt] });
    expect(again.assets).toBe(1);
    expect(revisionOf()).toBe(1);
    // A newer capture of the same URL with a different title is a changed row: new revision, new observation.
    const changed = JSON.stringify({ url: 'https://portal.lab.test/login', status_code: 200, title: 'Portal (staging)' }) + '\n';
    const second = artifact(changed), reparsed = extract({ text: changed, kind: second.kind })!;
    ingestExtract(store, reparsed, { artifact: second, evidenceRefs: [receipt] });
    expect(revisionOf()).toBe(2);
    expect(store.graphExport({ limit: 50 }).json.assertions.filter(row => String(row.kind).startsWith('fact:')).length).toBe(2);
  }));

  it('chunks rows past the store batch cap and keeps every row', async () => fixture(async (store, evidence, artifact) => {
    const hosts = Array.from({ length: 150 }, (_, index) => `<host><status state="up"/><address addr="10.1.${Math.floor(index / 250)}.${index % 250}" addrtype="ipv4"/></host>`);
    const xml = `<nmaprun>${hosts.join('')}</nmaprun>`, file = artifact(xml), parsed = extract({ text: xml, kind: file.kind })!;
    const outcome = ingestExtract(store, parsed, { artifact: file, evidenceRefs: [evidence()] });
    expect(outcome.assets).toBe(150);
    expect(outcome.batches).toBeGreaterThan(1);
    expect(store.graphSummary().assets).toBe(150);
  }));

  it('stops at a store refusal, reports the committed counts and never pretends the write completed', async () => {
    const parsed = extract({ text: nmap })!;
    let calls = 0;
    const fake = { recordGraph: () => { calls += 1; if (calls > 1) throw Error('Graph assets capacity reached'); return [{ kind: 'asset', entityId: 'asset-aaaaaaaaaaaaaaaaaaaaaaaa', id: 'asset-aaaaaaaaaaaaaaaaaaaaaaaa-r1', revision: 1, sequence: calls, created: true, observationSequence: calls, storeVersion: 7 }]; } } as unknown as AssessmentStore;
    const outcome = ingestExtract(fake, parsed, { artifact: { id: 'artifact-11111111-1111-1111-1111-111111111111', kind: 'shell-stdout', sha256: 'a'.repeat(64) } as ArtifactManifest, evidenceRefs: ['evidence-1'] });
    expect(outcome.error).toMatch(/capacity/);
    expect(outcome.warnings.join(' ')).toMatch(/committed/);
    expect(outcome.assets).toBeLessThanOrEqual(1);
  });
});

describe('component inventory rows (R2.4)', () => {
  it('requires the canonical component identity and rejects an unversioned package', async () => fixture(async (store) => {
    expect(() => store.recordGraph({ assets: [{ asset: { kind: 'package', key: 'lodash', attributes: { name: 'lodash', version: '4.17.21', ecosystem: 'npm' } } }] }))
      .toThrow(/canonical component identity npm:lodash@4\.17\.21; got lodash/);
    expect(() => store.recordGraph({ assets: [{ asset: { kind: 'package', key: 'npm:lodash@4.17.21', attributes: { name: 'lodash', ecosystem: 'npm' } } }] }))
      .toThrow(/attributes.version/);
    expect(() => store.recordGraph({ assets: [{ asset: { kind: 'package', key: 'npm:lodash@4.17.21', attributes: { name: 'lodash', version: '4.17.21', ecosystem: 'maven-ish' } } }] }))
      .toThrow(/attributes.ecosystem/);
  }));

  it('merges duplicate package/version identities and exposes them as components with attributes', async () => fixture(async (store, evidence, artifact) => {
    const file = artifact(lockfile), parsed = extract({ text: lockfile, kind: file.kind })!;
    ingestExtract(store, parsed, { artifact: file, evidenceRefs: [evidence()] });
    // A second ingest of the same lockfile converges on the same two identities instead of adding rows.
    ingestExtract(store, parsed, { artifact: file, evidenceRefs: [evidence()] });
    const inventory = store.componentInventory(20);
    expect(inventory.total).toBe(2);
    expect(inventory.rows.map(row => `${row.ecosystem}:${row.name}@${row.version}`)).toEqual(['npm:@scope/pkg@2.0.0', 'npm:lodash@4.17.21']);
    const lodash = inventory.rows.find(row => row.name === 'lodash')!;
    expect(store.component(lodash.entityId)).toMatchObject({ name: 'lodash', version: '4.17.21', ecosystem: 'npm' });
    expect(store.component('asset-000000000000000000000000')).toBeUndefined();
    // The R1 query keeps its row shape for other kinds, and a package row carries the version it was recorded at.
    const rows = store.graphQuery({ kind: 'package' }).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.attributes).toMatchObject({ ecosystem: 'npm' });
  }));

  it('accepts the extractor role as a producer and refuses an unknown role', async () => fixture(async (store) => {
    const request = { actorId: 'extractor', requestId: 'extract-role-1', payload: {} };
    expect(() => store.recordGraph({ assets: [{ asset: { kind: 'host', key: '10.0.0.9' } }] }, request, { actorId: 'extractor', role: 'extractor', depth: 0 })).not.toThrow();
    expect(() => store.recordGraph({ assets: [{ asset: { kind: 'host', key: '10.0.0.10' } }] }, { actorId: 'owner', requestId: 'extract-role-2', payload: {} }, { actorId: 'owner', role: 'scanner' as never })).toThrow('Invalid host graph provenance');
  }));
});
