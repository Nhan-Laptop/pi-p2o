import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * planning_update.md P2: a stand-in for the built Next.js client. The root suite does not build the dashboard (the real build
 * is `npm run dashboard:build`), so the export/server tests copy this fixture client instead: same tree shape (an HTML route
 * per page, hashed assets under `_next/static`), no external references.
 */
export async function clientFixture(root: string): Promise<string> {
  const directory = join(root, 'client');
  await mkdir(join(directory, '_next', 'static', 'chunks'), { recursive: true });
  await mkdir(join(directory, 'graph'), { recursive: true });
  await writeFile(join(directory, '404.html'), '<!doctype html><html lang="en"><body>missing fixture</body></html>\n');
  await writeFile(join(directory, 'index.html'), '<!doctype html><html lang="en"><body>overview fixture</body></html>\n');
  await writeFile(join(directory, 'graph', 'index.html'), '<!doctype html><html lang="en"><body>graph fixture</body></html>\n');
  await writeFile(join(directory, '_next', 'static', 'chunks', 'main.js'), 'console.log("fixture client");\n');
  return directory;
}

/** Recursive file map, used to compare two snapshot trees byte for byte. */
export async function snapshotTree(directory: string, relative = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = (await readdir(join(directory, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) Object.assign(out, await snapshotTree(directory, name));
    else out[name] = await readFile(path, 'utf8');
  }
  return out;
}

/** A temporary directory removed by the caller's `finally`, so a failing assertion cannot leak it. */
export async function tempRoot(prefix = 'p2o-dashboard-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export { rm };
