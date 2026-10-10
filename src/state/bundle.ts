import { sha256Hex as sha } from '../validate.js';
import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { MAX_ARTIFACT_BYTES, type AssessmentStore } from './store.js';
import { cleanText } from '../process.js';
import { PRIVATE_KNOWLEDGE_MARKER } from '../source.js';

export const BUNDLE_VERSION = 2;
export const BUNDLE_SOURCE_MARKER = PRIVATE_KNOWLEDGE_MARKER;
export const BUNDLE_SEGMENT_BYTES = 4 * 1024 * 1024;
export const BUNDLE_TOTAL_BYTES = 64 * 1024 * 1024;
export const BUNDLE_FILES = 4096;
const INDEX_BYTES = 1024 * 1024;
const NAME_PATTERN = /^(?:manifest\.json|segments\/(?:records|events|graph)-[0-9]{5}\.ndjson|artifacts\/artifact-[a-f0-9-]{36}\.txt)$/;

export interface BundleFile { name: string; kind: 'records' | 'events' | 'graph' | 'artifact'; bytes: number; sha256: string; sourceId?: string }
export interface BundleManifest {
  version: 1 | 2; runId: string; createdAt: string; bundleSha256: string; redactionVersion: 2;
  authorityRestored: false; retention: 'durable-local' | 'ephemeral'; targetIdentity: string;
  counts: { records: number; events: number; artifacts: number; files: number; bytes: number; graph?:number };
  files: BundleFile[]; omissions: string[]; warning: string;
}
/** Owner-selected absolute host path. Human commands only; never model tool input. */
export function bundlePath(value: unknown, label: 'export' | 'import'): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !isAbsolute(value) || value !== value.normalize('NFC') || /[\x00-\x1f\x7f]/.test(value)) throw Error(`Bundle ${label} needs an absolute host directory path (1..4096 characters)`);
  return value;
}
const canonicalIndex = (manifest: Omit<BundleManifest,'bundleSha256'>) => sha(JSON.stringify({ version: manifest.version, runId: manifest.runId, createdAt: manifest.createdAt,
  counts: manifest.counts, files: manifest.files }));
async function privateFile(directory: string, name: string, body: Buffer | string): Promise<void> {
  const file = await open(`${directory}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
}
function segments(prefix: 'records' | 'events' | 'graph', lines: string[]): Array<{ name: string; body: string }> {
  const parts: Array<{ name: string; body: string }> = []; let current: string[] = [], bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (size > BUNDLE_SEGMENT_BYTES) throw Error(`Bundle ${prefix} line exceeds the segment bound; export refused`);
    if (bytes + size > BUNDLE_SEGMENT_BYTES && current.length) { parts.push({ name: `${prefix}-${String(parts.length).padStart(5,'0')}.ndjson`, body: current.join('\n') + '\n' }); current = []; bytes = 0; }
    current.push(line); bytes += size;
  }
  if (current.length) parts.push({ name: `${prefix}-${String(parts.length).padStart(5,'0')}.ndjson`, body: current.join('\n') + '\n' });
  return parts.map(part => ({ ...part, name: `segments/${part.name}` }));
}
/** Read-only portable copy of committed knowledge. No execution authority, tickets, sockets or cookies. */
export async function exportBundle(store: AssessmentStore, destination: string): Promise<{ directory: string; manifest: BundleManifest }> {
  const target = bundlePath(destination,'export');
  for (const privatePath of [store.location, store.stateRoot]) {
    if (target === privatePath || target.startsWith(privatePath + '/') || privatePath.startsWith(target + '/')) throw Error('Bundle destination must be outside the private state directory');
  }
  const existing = await stat(target).catch(() => undefined);
  if (existing) throw Error('Bundle destination already exists; choose a new directory (no overwrite, no merge)');
  const manifest = store.manifest();
  const allEvents: unknown[] = []; let cursor = 0;
  for (;;) { const page = store.events({ since: cursor, limit: 100 }); allEvents.push(...page.rows); if (page.nextCursor === undefined) break; cursor = page.nextCursor; }
  const records = store.records(), artifacts = store.artifacts(), graph=store.graphSnapshot();
  const graphRows=(['assets','assertions','relations','anchors','provenance'] as const).flatMap(table=>graph[table].map(body=>JSON.stringify({table,scope:graph.scope,sourceRunId:graph.runId,body})));
  const parts: Array<{ name: string; body: string }> = [
    ...segments('records', records.map(row => JSON.stringify(row))),
    ...segments('events', allEvents.map(row => JSON.stringify(row))),
    ...segments('graph',graphRows),
  ];
  const artifactBodies = artifacts.map(a => {
    // Read verified retained bytes once. Decoding independent ranges corrupts split UTF-8 sequences.
    const body = store.artifactBytes(a.id).bytes;
    if (body.length !== a.bytes || sha(body) !== a.sha256) throw Error(`Artifact ${a.id} failed integrity during export; bundle refused`);
    return { name: `artifacts/${a.id}.txt`, body };
  });
  const total = parts.reduce((sum,p) => sum + Buffer.byteLength(p.body),0) + artifactBodies.reduce((sum,p) => sum + p.body.length,0);
  if (parts.length + artifactBodies.length > BUNDLE_FILES) throw Error('Bundle exceeds the file-count bound; no directory was created');
  if (total > BUNDLE_TOTAL_BYTES) throw Error('Bundle exceeds 64 MiB; segmented archive policy is not implemented yet, nothing was written');
  const files: BundleFile[] = [
    ...parts.map(p => ({ name: p.name, kind: p.name.startsWith('segments/records') ? 'records' as const : p.name.startsWith('segments/graph') ? 'graph' as const : 'events' as const, bytes: Buffer.byteLength(p.body), sha256: sha(p.body) })),
    ...artifactBodies.map((p,i) => ({ name: p.name, kind: 'artifact' as const, bytes: p.body.length, sha256: sha(p.body), sourceId: artifacts[i].id })),
  ];
  const pending: Omit<BundleManifest,'bundleSha256'> = { version: BUNDLE_VERSION, runId: manifest.runId, createdAt: new Date().toISOString(), redactionVersion: 2,
    authorityRestored: false, retention: manifest.retention, targetIdentity: manifest.targetIdentity,
    counts: { records: records.length, events: allEvents.length, artifacts: artifacts.length, files: files.length, bytes: total,graph:graphRows.length },
    files, omissions: ['No execution authority, tickets, tokens, cookies, sockets, queued requests, budgets or live assignments',
      'Bytes already lost to capture/display truncation cannot be reconstructed', 'Bundle content was redacted at capture/ingest time; no second redaction was applied'],
    warning: 'Portable copy of attributed claims, not verified findings. Redaction is best effort; review before sharing.' };
  const index: BundleManifest = { ...pending, bundleSha256: canonicalIndex(pending) };
  const temporary = `${target}.p2o-tmp-${index.runId}-${index.bundleSha256.slice(0,12)}`;
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    await mkdir(join(temporary,'segments'), { mode: 0o700 }); await mkdir(join(temporary,'artifacts'), { mode: 0o700 });
    for (const part of parts) await privateFile(temporary, part.name, part.body);
    for (const body of artifactBodies) await privateFile(temporary, body.name, body.body);
    await privateFile(temporary, BUNDLE_SOURCE_MARKER, 'pi-p2o private knowledge; never target source\n');
    await privateFile(temporary, '.npmignore', '*\n'); // even a bundle inside a broad package files/ directory stays private
    await privateFile(temporary, 'manifest.json', JSON.stringify(index, null, 2));
    const directory = await open(temporary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await directory.sync(); } finally { await directory.close(); }
    if (await stat(target).catch(() => undefined)) throw Error('Bundle destination appeared during export; refusing to overwrite');
    await rename(temporary, target);
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  return { directory: target, manifest: index };
}
/**
 * Publishes a flat set of private report files with the same discipline as a bundle: absolute new path outside the private state root,
 * 0700 temporary directory, 0600 files, fsync, then one rename. A failure removes the temporary directory and leaves no destination.
 * The private marker keeps the directory out of any later source clone.
 */
export async function publishReportFiles(store: AssessmentStore, destination: string, files: Array<{ name: string; body: string }>): Promise<{ directory: string; files: number; bytes: number }> {
  const target = bundlePath(destination, 'export');
  for (const privatePath of [store.location, store.stateRoot]) {
    if (target === privatePath || target.startsWith(privatePath + '/') || privatePath.startsWith(target + '/')) throw Error('Report destination must be outside the private state directory');
  }
  if (!files.length || files.length > 16 || files.some(file => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(file.name) || file.name === BUNDLE_SOURCE_MARKER || file.name === '.npmignore')) throw Error('Invalid report file set');
  if (await stat(target).catch(() => undefined)) throw Error('Report destination already exists; choose a new directory (no overwrite, no merge)');
  const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.body), 0);
  if (bytes > 16 * 1024 * 1024) throw Error('Report exceeds 16 MiB; nothing was written');
  const temporary = `${target}.p2o-tmp-report-${sha(files.map(file => `${file.name}\0${sha(file.body)}`).join('\n')).slice(0, 12)}`;
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const file of files) await privateFile(temporary, file.name, file.body);
    await privateFile(temporary, BUNDLE_SOURCE_MARKER, 'pi-p2o private report; never target source\n');
    await privateFile(temporary, '.npmignore', '*\n');
    const directory = await open(temporary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await directory.sync(); } finally { await directory.close(); }
    if (await stat(target).catch(() => undefined)) throw Error('Report destination appeared during export; refusing to overwrite');
    await rename(temporary, target);
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  return { directory: target, files: files.length, bytes };
}
/** Verify the index, every file hash/size and report extras. Integrity is not authority or currentness. */
export async function inspectBundle(directory: string): Promise<{ manifest: BundleManifest; integrityStatus: 'complete' | 'partial'; missing: string[]; tampered: string[]; extra: string[] }> {
  const root = bundlePath(directory,'import');
  const info = await stat(root).catch(() => undefined);
  if (!info?.isDirectory()) throw Error('Bundle directory is missing or not a directory');
  const indexFile = await open(`${root}/manifest.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (!indexFile) throw Error('Bundle manifest missing or oversized; partial bundles are never imported');
  let raw: Buffer;
  try { const size = (await indexFile.stat()).size; if (!size || size > INDEX_BYTES) throw Error('Bundle manifest missing or oversized'); raw = await indexFile.readFile(); } finally { await indexFile.close(); }
  const manifest = JSON.parse(raw.toString('utf8')) as BundleManifest;
  validateManifest(manifest);
  const missing: string[] = [], tampered: string[] = [];
  for (const file of manifest.files) {
    const handle = await open(`${root}/${file.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
    if (!handle) { missing.push(file.name); continue; }
    try { const body = await handle.readFile(); if (body.length !== file.bytes || sha(body) !== file.sha256) tampered.push(file.name); } finally { await handle.close(); }
  }
  const indexed = new Set(manifest.files.map(f => f.name));
  const listed = (await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])).filter(entry => entry.isFile()).map(entry => relative(root, join(entry.parentPath ?? root, entry.name)));
  const extra = listed.filter(name => name !== 'manifest.json' && name !== BUNDLE_SOURCE_MARKER && name !== '.npmignore' && !indexed.has(name));
  const recomputed = canonicalIndex({ ...manifest, bundleSha256: undefined as never } as Omit<BundleManifest,'bundleSha256'>);
  if (recomputed !== manifest.bundleSha256) tampered.push('manifest.json');
  return { manifest, integrityStatus: missing.length || tampered.length ? 'partial' : 'complete', missing, tampered, extra };
}
function validateManifest(value: unknown): asserts value is BundleManifest {
  const m = value as BundleManifest;
  if (!m || typeof m !== 'object' || Array.isArray(m) || ![1,BUNDLE_VERSION].includes(m.version) || m.redactionVersion !== 2 || m.authorityRestored !== false
    || typeof m.runId !== 'string' || !/^run-[a-zA-Z0-9-]{1,75}$/.test(m.runId) || typeof m.createdAt !== 'string' || m.createdAt.length > 64
    || typeof m.bundleSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.bundleSha256) || !['durable-local','ephemeral'].includes(m.retention)
    || typeof m.targetIdentity !== 'string' || m.targetIdentity.length > 256 || !Array.isArray(m.files) || m.files.length > BUNDLE_FILES
    || !Array.isArray(m.omissions) || m.omissions.length > 32 || typeof m.warning !== 'string' || m.warning.length > 2000) throw Error('Invalid bundle manifest shape');
  const counts = m.counts;
  if (!counts || typeof counts !== 'object' || Object.keys(counts).sort().join(',') !== (m.version===1?'artifacts,bytes,events,files,records':'artifacts,bytes,events,files,graph,records')
    || !(m.version===1?['records','events','artifacts','files','bytes']:['records','events','artifacts','files','bytes','graph']).every(key => Number.isSafeInteger(counts[key as keyof typeof counts]) && Number(counts[key as keyof typeof counts]) >= 0)) throw Error('Invalid bundle counts');
  if (counts.files !== m.files.length) throw Error('Bundle file count does not match the index');
  if(new Set(m.files.map(file=>file.name)).size!==m.files.length)throw Error('Duplicate bundle indexed path');
  if (counts.bytes > BUNDLE_TOTAL_BYTES) throw Error('Bundle exceeds 64 MiB; import refused');
  for (const file of m.files) {
    if (!file || typeof file !== 'object' || Object.keys(file).sort().join(',') !== (file.sourceId ? 'bytes,kind,name,sha256,sourceId' : 'bytes,kind,name,sha256')
      || typeof file.name !== 'string' || !NAME_PATTERN.test(file.name)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > (file.kind==='artifact'?MAX_ARTIFACT_BYTES:BUNDLE_SEGMENT_BYTES) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !['records','events','graph','artifact'].includes(file.kind) || (file.kind==='graph' && m.version!==2)
      || (file.kind === 'artifact' ? !file.sourceId || !/^artifact-[a-f0-9-]{36}$/.test(file.sourceId) : file.sourceId !== undefined)
      || (file.kind === 'artifact' ? file.name !== `artifacts/${file.sourceId}.txt` : !file.name.startsWith(`segments/${file.kind}-`))) throw Error('Invalid bundle file entry');
  }
  if (m.files.reduce((sum,file) => sum + file.bytes,0) !== counts.bytes) throw Error('Bundle byte total does not match the indexed files');
}
/** Preserve an external bundle inside this run as immutable artifacts plus one attributed provenance note.
 * Imported bytes never become same-run evidence, tickets or authority; every reference stays ID-based.
 */
export async function importBundle(store: AssessmentStore, directory: string, actorId = 'owner'): Promise<{ artifactIds: string[]; noteId: string; manifest: BundleManifest }> {
  const view = await inspectBundle(directory);
  if (view.integrityStatus !== 'complete') throw Error(`Bundle integrity is partial (missing: ${view.missing.length}, tampered: ${view.tampered.length}); import refused`);
  const already = store.records().some(row => row.data?.bundleSha256 === view.manifest.bundleSha256);
  if (already) throw Error('Bundle already imported in this run; identifiers and hashes were preserved, nothing was duplicated');
  const artifactIds: string[] = [];
  for (const file of view.manifest.files) {
    const handle = await open(join(directory, file.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let body: Buffer;
    try { const info = await handle.stat(); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== file.bytes) throw Error(`Bundle file ${file.name} changed after verification; import refused`); body = await handle.readFile(); } finally { await handle.close(); }
    if (sha(body) !== file.sha256) throw Error(`Bundle file ${file.name} changed after verification; import refused`);
    const artifact = store.ingestArtifact(actorId, body, { kind: `imported-${file.kind}`, mediaType: file.name.endsWith('.json') ? 'application/json' : 'text/plain',
      totalBytes: file.bytes, maxBytes: Math.max(file.bytes,1), captureOutcome: 'returned', preserveBytes: true,
      importedFrom: { bundleSha256: view.manifest.bundleSha256, file: file.name, sourceRunId: view.manifest.runId, originalSha256: file.sha256 } });
    artifactIds.push(artifact.id);
  }
  const note = await store.commitRecords([{ runId: store.manifest().runId, at: new Date().toISOString(), by: actorId, kind: 'note',
    text: cleanText(`Imported portable bundle ${view.manifest.bundleSha256.slice(0,12)} from run ${view.manifest.runId} (${view.manifest.counts.files} files, ${view.manifest.counts.bytes} bytes); knowledge only, no authority`),
    refs: artifactIds,
    data: { bundleSha256: view.manifest.bundleSha256, importedFrom: { runId: view.manifest.runId, createdAt: view.manifest.createdAt, retention: view.manifest.retention,
      counts: view.manifest.counts, integrityStatus: view.integrityStatus, extras: view.extra.length }, authorityRestored: false,
      note: 'Imported bytes are not same-run evidence; candidates, reviews and currentness still require this run\'s own receipts' } }]);
  return { artifactIds, noteId: note[0].recordId, manifest: view.manifest };
}
export async function bundleDirectoryInfo(directory: string): Promise<{ directory: string; bytes: number; files: number }> {
  const root = await realpath(directory);
  const listed = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
  let bytes = 0; for (const entry of listed) bytes += (await stat(join(entry.parentPath ?? root, entry.name))).size;
  return { directory: root, bytes, files: listed.length };
}
