import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, parseServeArguments, parseSnapshotArguments } from '../../src/dashboard/main.js';
import { buildDashboard } from '../../src/dashboard/read-model.js';
import { snapshotDirectory, writeDashboardSnapshot } from '../../src/dashboard/snapshot.js';
import { clientFixture } from './helpers/dashboard-client.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * planning_update.md P1: the frozen data tree is deterministic byte-for-byte for one fixture, writes only into a new absolute
 * directory, and states a cap instead of writing an unbounded tree. The CLI parser refuses a relative or ambiguous invocation.
 */
const files = async (directory: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) { for (const child of (await readdir(path)).sort()) out[`${name}/${child}`] = await readFile(join(path, child), 'utf8'); }
    else out[name] = await readFile(path, 'utf8');
  }
  return out;
};

describe('dashboard snapshot writer', () => {
  it('writes two byte-identical trees for the same committed state and refuses to overwrite one', async () => {
    await fixture(async h => {
      await populate(h);
      const stateRoot = join(h.root, '.p2o-state'), build = await buildDashboard({ stateRoots: [{ path: stateRoot }] });
      const first = join(h.root, 'snap-a'), second = join(h.root, 'snap-b');
      const written = await writeDashboardSnapshot(first, build);
      await writeDashboardSnapshot(second, build);
      expect(await files(first)).toEqual(await files(second));
      expect(written.files.map(file => file.name)).toEqual(expect.arrayContaining(['index.json']));
      expect(written.files.some(file => file.name.startsWith('runs/') && file.name.endsWith('.json'))).toBe(true);
      expect(Object.keys(await files(first)).sort()).toEqual(written.files.map(file => file.name).sort());
      expect(((await stat(first)).mode & 0o777)).toBe(0o700);
      expect(((await stat(join(first, 'index.json'))).mode & 0o777)).toBe(0o600);
      expect(JSON.parse(await readFile(join(first, 'index.json'), 'utf8'))).toMatchObject({ format: 'p2o-dashboard', version: 1 });
      await expect(writeDashboardSnapshot(first, build)).rejects.toThrow(/new directory/);
    });
  });

  it('rejects a relative output path and a tree above the snapshot bound before writing anything', async () => {
    await fixture(async h => {
      const stateRoot = join(h.root, '.p2o-state'), build = await buildDashboard({ stateRoots: [{ path: stateRoot }] });
      expect(() => snapshotDirectory('relative/out')).toThrow(/absolute/);
      expect(() => snapshotDirectory('')).toThrow(/required/);
      const bounded = await buildDashboard({ stateRoots: [{ path: stateRoot }], limits: { snapshotBytes: 8 } });
      const target = join(h.root, 'snap-tight');
      await expect(writeDashboardSnapshot(target, bounded)).rejects.toThrow(/above the 8 byte bound/);
      await expect(stat(target)).rejects.toThrow(); // refused before mkdir
    });
  });

  it('runs the standalone entry end to end and prints the absolute path plus a one-line summary', async () => {
    await fixture(async h => {
      await populate(h);
      const out = join(h.root, 'snap'), reports = join(h.root, 'reports');
      await mkdir(reports);
      const client = await clientFixture(h.root);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const code = await main(['snapshot', '--out', out, '--state-root', join(h.root, '.p2o-state'), '--report-root', reports, '--client', client]);
        expect(code).toBe(0);
        const lines = log.mock.calls.map(call => String(call[0]));
        expect(lines[0]).toBe(`dashboard snapshot: ${out}`);
        expect(lines[1]).toMatch(/^runs: 1, findings: 1, warnings: 0, omissions: 0, files: 6, bytes: \d+$/);
        expect(lines[2]).toBe(`client assets: 4 files copied from ${client}`);
        expect(lines[3]).toBe(`open it with: node dist/src/dashboard/main.js serve --snapshot ${out}`);
      } finally { log.mockRestore(); }
      expect((await readdir(out)).sort()).toEqual(['404.html', '_next', 'graph', 'index.html', 'index.json', 'runs']);
    });
  });

  it('parses the snapshot command with an absolute output directory and a client override', () => {
    expect(parseSnapshotArguments(['snapshot', '--out', '/tmp/out', '--run', 'run-a'])).toMatchObject({ out: '/tmp/out', runs: ['run-a'], client: join(process.cwd(), 'dashboard', 'out') });
    expect(parseSnapshotArguments(['snapshot', '--out', '/tmp/out', '--client', '/tmp/client'])).toMatchObject({ client: '/tmp/client' });
    const explicit = parseSnapshotArguments(['snapshot', '--out', '/tmp/out', '--state-root', '/tmp/state', '--report-root', '/tmp/reports']);
    expect(explicit).toMatchObject({ out: '/tmp/out', stateRoots: [{ path: '/tmp/state' }], reportRoots: [{ path: '/tmp/reports' }] });
    const defaults = parseSnapshotArguments(['snapshot', '--out', '/tmp/out']);
    expect(defaults.stateRoots[0]!.optional).toBe(true);
    expect(defaults.reportRoots[0]!.optional).toBe(true);
    expect(() => parseSnapshotArguments([])).toThrow(/Expected the "snapshot" command/);
    expect(() => parseSnapshotArguments(['serve', '--out', '/tmp/out'])).toThrow(/Expected the "snapshot" command/);
    expect(() => parseSnapshotArguments(['snapshot'])).toThrow(/--out is required/);
    expect(() => parseSnapshotArguments(['snapshot', '--out', '/tmp/out', '--run', 'bad/id'])).toThrow(/Invalid run id/);
    expect(() => parseSnapshotArguments(['snapshot', '--out', '/tmp/out', '--state-root'])).toThrow(/Missing value/);
    expect(() => parseSnapshotArguments(['snapshot', '--out', '/tmp/out', '--nope', 'x'])).toThrow(/Unknown option/);
    expect(parseServeArguments(['serve', '--snapshot', '/tmp/snap'])).toEqual({ snapshot: '/tmp/snap', port: 0 });
    expect(parseServeArguments(['serve', '--snapshot', '/tmp/snap', '--port', '8080'])).toEqual({ snapshot: '/tmp/snap', port: 8080 });
    expect(() => parseServeArguments(['serve'])).toThrow(/--snapshot is required/);
    expect(() => parseServeArguments(['serve', '--snapshot', '/tmp/snap', '--port', 'nope'])).toThrow(/Invalid --port/);
    expect(() => parseServeArguments(['serve', '--snapshot', '/tmp/snap', '--port', '70000'])).toThrow(/Invalid --port/);
    expect(() => parseServeArguments(['snapshot', '--out', '/tmp/out'])).toThrow(/Expected the "serve" command/);
  });
});
