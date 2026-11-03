/**
 * planning_update.md P1 (path "a"): write the dashboard data tree to a frozen directory.
 *
 * The writer is deliberately dumb: the read model already produced a bounded, deterministic tree, and this module only checks
 * the output path the operator chose, refuses to overwrite anything, and writes two-space JSON with a trailing newline. No
 * artifact copies yet — owner decision m4 lands them in P3, together with the `artifacts/<runId>/<artifactId>.txt` files.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { DashboardBuild } from './read-model.js';

export interface DashboardSnapshotFile { name: string; bytes: number }
export interface DashboardSnapshot { directory: string; files: DashboardSnapshotFile[]; bytes: number }

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** An absolute, normalized, control-free directory; a relative path would make the snapshot depend on the caller's cwd. */
export function snapshotDirectory(out: string): string {
  if (typeof out !== 'string' || !out.length) throw Error('Snapshot output directory is required');
  const value = out.normalize('NFC');
  if (!isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw Error('Snapshot output directory must be an absolute normalized path (NFC, no control characters)');
  return resolve(value);
}

const encode = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Write `index.json` and `runs/<runId>.json` into a new directory. An existing path is refused, never merged into. */
export async function writeDashboardSnapshot(out: string, build: DashboardBuild): Promise<DashboardSnapshot> {
  const directory = snapshotDirectory(out);
  const entries: Array<{ name: string; body: string }> = [
    { name: 'index.json', body: encode(build.index) },
    ...build.runs.map(run => ({ name: `runs/${run.runId}.json`, body: encode(run) })),
  ];
  const bytes = entries.reduce((total, entry) => total + Buffer.byteLength(entry.body), 0);
  const cap = build.index.limits.snapshotBytes;
  if (bytes > cap) throw Error(`Snapshot data tree would be ${bytes} bytes, above the ${cap} byte bound; narrow the scan with --run or fewer roots`);
  try { await mkdir(directory, { recursive: false, mode: 0o700 }); }
  catch (error) { throw Error(`Snapshot directory must be a new directory: ${messageOf(error)}`); }
  if (entries.some(entry => entry.name.startsWith('runs/'))) await mkdir(join(directory, 'runs'), { mode: 0o700 });
  const files: DashboardSnapshotFile[] = [];
  for (const entry of entries) {
    // Paths are built from validated run ids only (no separators), so the join cannot leave the new directory.
    await writeFile(join(directory, entry.name), entry.body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    files.push({ name: entry.name, bytes: Buffer.byteLength(entry.body) });
  }
  return { directory, files: files.sort((left, right) => left.name.localeCompare(right.name)), bytes };
}
