/**
 * planning_update.md P2/P3 (path "a"): write the dashboard to a frozen directory — the data tree (`index.json` and
 * `runs/<runId>.json`), the bounded artifact bodies the cited findings need (owner decision m4, under `artifacts/`), plus, when
 * the caller passes the built client, the static export under the same root. One directory is the whole artifact: it zips, and
 * any static file server (or our `serve --snapshot`) opens it (owner decision m6).
 *
 * The writer stays dumb: the read model already produced a bounded, deterministic data tree, and this module only checks the
 * output path the operator chose, refuses to overwrite anything, and copies real files. A symlink in the client tree is
 * refused, never followed: a snapshot is handed to other people, so it must contain what it says it contains.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { DashboardBuild } from './read-model.js';

export interface DashboardSnapshotFile { name: string; bytes: number }
export interface DashboardSnapshotClient { root: string; files: number; bytes: number }
export interface DashboardSnapshot { directory: string; files: DashboardSnapshotFile[]; bytes: number; client: DashboardSnapshotClient | null }
export interface DashboardSnapshotOptions { clientRoot?: string }

/** A copy above this many files is not a Next export; the bound keeps a mistaken `--client` from filling the disk. */
export const DASHBOARD_SNAPSHOT_CLIENT_FILES_MAX = 5000;
/** Nested client trees deeper than this are refused rather than walked without limit. */
export const DASHBOARD_SNAPSHOT_CLIENT_DEPTH_MAX = 24;

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** An absolute, normalized, control-free directory; a relative path would make the artifact depend on the caller's cwd. */
export function absoluteDirectory(value: string, label: string): string {
  if (typeof value !== 'string' || !value.length) throw Error(`${label} is required`);
  const normalized = value.normalize('NFC');
  if (!isAbsolute(normalized) || normalized.length > 4096 || /[\x00-\x1f\x7f]/.test(normalized)) throw Error(`${label} must be an absolute normalized path (NFC, no control characters)`);
  return resolve(normalized);
}

export const snapshotDirectory = (out: string): string => absoluteDirectory(out, 'Snapshot output directory');
export const clientDirectory = (root: string): string => absoluteDirectory(root, 'Client assets directory');

interface SnapshotEntry { name: string; body: Buffer }

const encode = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const reservedName = (name: string): boolean =>
  name === 'index.json' || name === 'runs' || name.startsWith('runs/') || name === 'artifacts' || name.startsWith('artifacts/')
  || name === 'reports' || name.startsWith('reports/');

/** Read the built client tree into memory, sorting every directory so two snapshots of the same build are byte-identical. */
async function readClientTree(root: string, relative = '', depth = 0): Promise<SnapshotEntry[]> {
  if (depth > DASHBOARD_SNAPSHOT_CLIENT_DEPTH_MAX) throw Error(`Client assets are nested deeper than ${DASHBOARD_SNAPSHOT_CLIENT_DEPTH_MAX} levels; refusing to copy`);
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: SnapshotEntry[] = [];
  for (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw Error(`Client assets contain a symlink (${name}); a snapshot copies real files only`);
    if (entry.isDirectory()) { files.push(...await readClientTree(root, name, depth + 1)); continue; }
    if (!entry.isFile()) throw Error(`Client assets contain a non-regular entry (${name})`);
    if (reservedName(name)) throw Error(`Client assets file ${name} collides with the dashboard data tree`);
    files.push({ name, body: await readFile(join(root, relative, entry.name)) });
  }
  return files;
}

async function assertClientRoot(root: string): Promise<void> {
  const info = await stat(root).catch(() => null);
  if (!info) throw Error(`Client assets directory ${root} does not exist; run npm run dashboard:build first`);
  if (!info.isDirectory()) throw Error(`Client assets path ${root} is not a directory`);
}

/** Write the frozen dashboard into a new directory. An existing path is refused, never merged into. */
export async function writeDashboardSnapshot(out: string, build: DashboardBuild, options: DashboardSnapshotOptions = {}): Promise<DashboardSnapshot> {
  const directory = snapshotDirectory(out);
  const data: SnapshotEntry[] = [
    { name: 'index.json', body: encode(build.index) },
    ...build.runs.map(run => ({ name: `runs/${run.runId}.json`, body: encode(run) })),
    // P5a: the report document as its own file, so a snapshot can be read without parsing the run JSON and the served route is
    // a plain file read. It is the same bounded body the run file carries; the snapshot byte cap counts it once per file.
    ...build.runs.flatMap(run => run.report === undefined ? [] : [{ name: `reports/${run.runId}.md`, body: Buffer.from(run.report.text, 'utf8') }]),
    // Bodies were already bounded and redacted at commit; the run file lists bytes/sha256/truncated for each copy it names.
    ...build.artifacts.map(artifact => ({ name: artifact.ref.file, body: artifact.bytes })).sort((left, right) => left.name.localeCompare(right.name)),
  ];
  const clientRoot = options.clientRoot === undefined ? null : clientDirectory(options.clientRoot);
  const client = clientRoot === null ? [] : (await assertClientRoot(clientRoot), await readClientTree(clientRoot));
  if (client.length > DASHBOARD_SNAPSHOT_CLIENT_FILES_MAX) throw Error(`Client assets hold ${client.length} files, above the ${DASHBOARD_SNAPSHOT_CLIENT_FILES_MAX} file bound`);
  const entries = [...data, ...client];
  const bytes = entries.reduce((total, entry) => total + entry.body.byteLength, 0);
  const cap = build.index.limits.snapshotBytes;
  if (bytes > cap) throw Error(`Snapshot would be ${bytes} bytes, above the ${cap} byte bound; narrow the scan with --run or fewer roots`);
  try { await mkdir(directory, { recursive: false, mode: 0o700 }); }
  catch (error) { throw Error(`Snapshot directory must be a new directory: ${messageOf(error)}`); }
  for (const entry of entries) {
    const target = join(directory, entry.name);
    // Paths come from validated run ids and a sorted walk of the client tree (no `..`), so the join cannot leave the new directory.
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, entry.body, { flag: 'wx', mode: 0o600 });
  }
  return {
    directory,
    files: entries.map(entry => ({ name: entry.name, bytes: entry.body.byteLength })).sort((left, right) => left.name.localeCompare(right.name)),
    bytes,
    client: clientRoot === null ? null : { root: clientRoot, files: client.length, bytes: client.reduce((total, entry) => total + entry.body.byteLength, 0) },
  };
}
