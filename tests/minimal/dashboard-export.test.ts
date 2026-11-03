import { describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as HostContract from '../../src/dashboard/contract.js';
import type * as ClientContract from '../../dashboard/lib/model.js';
import { buildDashboard } from '../../src/dashboard/read-model.js';
import { writeDashboardSnapshot } from '../../src/dashboard/snapshot.js';
import { sha256Hex } from '../../src/validate.js';
import { EXPLORATION_NODE_KINDS, EXPLORATION_RELATIONS } from '../../src/exploration-graph.js';
import { FINDING_SEVERITIES } from '../../src/case-types.js';
import { KIND_ORDER, RELATION_ORDER, COLUMN_BANDS } from '../../dashboard/lib/vocabulary.js';
import { SEVERITY_ORDER } from '../../dashboard/lib/format.js';
import { clientFixture, snapshotTree, tempRoot } from './helpers/dashboard-client.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * planning_update.md P2: the frozen artifact is the data tree plus the copied static client, deterministic and new-directory
 * only; the frozen-mode server serves exactly that directory on loopback, GET/HEAD only. The client is a separate build, so
 * these tests also pin its contract mirror and its source intake (no external URL, no HTML injection) against the host code.
 */
const dashboardRoot = fileURLToPath(new URL('../../dashboard/', import.meta.url));

const emptyBuild = () => buildDashboard({
  stateRoots: [{ path: join(dashboardRoot, '..', '.p2o-state-does-not-exist'), optional: true }],
  reportRoots: [{ path: join(dashboardRoot, '..', '.p2o-reports-does-not-exist'), optional: true }],
});

describe('frozen snapshot: data tree plus copied client', () => {
  it('copies the client next to the data tree byte-identically and reports both halves', async () => {
    const root = await tempRoot();
    try {
      const client = await clientFixture(root);
      const build = await emptyBuild();
      const first = join(root, 'snap-a'), second = join(root, 'snap-b');
      const written = await writeDashboardSnapshot(first, build, { clientRoot: client });
      await writeDashboardSnapshot(second, build, { clientRoot: client });
      expect(await snapshotTree(first)).toEqual(await snapshotTree(second));
      expect(written.files.map(file => file.name).sort()).toEqual(Object.keys(await snapshotTree(first)).sort());
      expect((await readdir(first)).sort()).toEqual(['404.html', '_next', 'graph', 'index.html', 'index.json']);
      expect(written.client).toMatchObject({ root: client, files: 4 });
      expect(written.bytes).toBeGreaterThan(written.client!.bytes);
      expect((await stat(first)).mode & 0o777).toBe(0o700);
      expect((await stat(join(first, 'index.html'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(first, '_next'))).mode & 0o777).toBe(0o700);
      expect(JSON.parse(await readFile(join(first, 'index.json'), 'utf8'))).toMatchObject({ format: 'p2o-dashboard', version: 1, runs: [] });
      await expect(writeDashboardSnapshot(first, build, { clientRoot: client })).rejects.toThrow(/new directory/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a missing client root, a client file that shadows the data tree and a symlink, all before writing', async () => {
    const root = await tempRoot();
    try {
      const build = await emptyBuild();
      const missingTarget = join(root, 'snap-missing');
      await expect(writeDashboardSnapshot(missingTarget, build, { clientRoot: join(root, 'no-client') })).rejects.toThrow(/does not exist; run npm run dashboard:build/);
      await expect(stat(missingTarget)).rejects.toThrow();

      const shadow = join(root, 'client-shadow');
      await mkdir(shadow);
      await writeFile(join(shadow, 'index.json'), '{}\n');
      const shadowTarget = join(root, 'snap-shadow');
      await expect(writeDashboardSnapshot(shadowTarget, build, { clientRoot: shadow })).rejects.toThrow(/collides with the dashboard data tree/);
      await expect(stat(shadowTarget)).rejects.toThrow();

      const reportsShadow = join(root, 'client-reports');
      await mkdir(join(reportsShadow, 'reports'), { recursive: true });
      await writeFile(join(reportsShadow, 'reports', 'run-a.md'), '# shadow\n');
      const reportsShadowTarget = join(root, 'snap-reports-shadow');
      await expect(writeDashboardSnapshot(reportsShadowTarget, build, { clientRoot: reportsShadow })).rejects.toThrow(/collides with the dashboard data tree/);
      await expect(stat(reportsShadowTarget)).rejects.toThrow();

      const linked = await clientFixture(join(root, 'linked-root'));
      await symlink('/etc/hostname', join(linked, 'escape.txt'));
      const linkTarget = join(root, 'snap-link');
      await expect(writeDashboardSnapshot(linkTarget, build, { clientRoot: linked })).rejects.toThrow(/symlink/);
      await expect(stat(linkTarget)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a snapshot above the byte bound before creating the directory', async () => {
    const root = await tempRoot();
    try {
      const client = await clientFixture(root);
      const bounded = await buildDashboard({ stateRoots: [{ path: join(root, 'missing'), optional: true }], limits: { snapshotBytes: 64 } });
      const target = join(root, 'snap-tight');
      await expect(writeDashboardSnapshot(target, bounded, { clientRoot: client })).rejects.toThrow(/above the 64 byte bound/);
      await expect(stat(target)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('writes the cited artifact bodies next to the data tree and counts them against the same byte bound', async () => {
    const root = await tempRoot();
    try {
      const build = await emptyBuild();
      const body = Buffer.from('redacted capture bytes\n');
      const artifactId = 'artifact-11111111-1111-1111-1111-111111111111';
      const artifactBuild = { ...build, artifacts: [{ runId: 'run-a', artifactId, bytes: body,
        ref: { artifactId, bytes: body.length, sha256: sha256Hex(body), truncated: false, file: `artifacts/run-a/${artifactId}.txt` } }] };
      const client = await clientFixture(root);
      const written = await writeDashboardSnapshot(join(root, 'snap-artifacts'), artifactBuild, { clientRoot: client });
      expect(written.files.map(file => file.name)).toContain(`artifacts/run-a/${artifactId}.txt`);
      expect(await readFile(join(root, 'snap-artifacts', 'artifacts', 'run-a', `${artifactId}.txt`), 'utf8')).toBe('redacted capture bytes\n');
      const tight = { ...artifactBuild, index: { ...artifactBuild.index, limits: { ...artifactBuild.index.limits, snapshotBytes: 16 } } };
      await expect(writeDashboardSnapshot(join(root, 'snap-tight'), tight)).rejects.toThrow(/above the 16 byte bound/);
      await expect(stat(join(root, 'snap-tight'))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('writes the run file the client fetches, and the run file type stays assignable to the client mirror', async () => {
    await fixture(async h => {
      await populate(h);
      const build = await buildDashboard({ stateRoots: [{ path: join(h.root, '.p2o-state') }] });
      const mirroredRun: ClientContract.DashboardRunFile = build.runs[0]!;
      const client = await clientFixture(h.root);
      const out = join(h.root, 'snap');
      await writeDashboardSnapshot(out, build, { clientRoot: client });
      const onDisk = JSON.parse(await readFile(join(out, 'runs', `${build.runs[0]!.runId}.json`), 'utf8'));
      expect(onDisk).toMatchObject({ format: 'p2o-dashboard-run', version: 1, runId: build.runs[0]!.runId });
      expect(mirroredRun.graph.nodes.length).toBe(onDisk.graph.nodes.length);
      expect(mirroredRun.run.counts.findingsAccepted).toBe(1);
    });
  });
});

describe('client intake and contract mirror', () => {
  const readAll = async (files: readonly string[]): Promise<string> =>
    (await Promise.all(files.map(file => readFile(join(dashboardRoot, file), 'utf8')))).join('\n');

  it('contains no external URL, no HTML injection path and no fetch to another origin', async () => {
    const source = await readAll([
      'app/layout.tsx', 'app/page.tsx', 'app/graph/page.tsx', 'app/findings/page.tsx', 'app/globals.css',
      'components/DatasetHeader.tsx', 'components/GraphScreen.tsx', 'components/GraphCanvas.tsx', 'components/GraphDetail.tsx',
      'components/FindingsScreen.tsx', 'components/FindingDetail.tsx', 'components/ArtifactViewer.tsx',
      'components/States.tsx', 'components/WarningsList.tsx', 'components/ReportScreen.tsx', 'components/ReportFactsScreen.tsx',
      'app/report/page.tsx',
      'lib/model.ts', 'lib/format.ts', 'lib/report.ts', 'lib/layout.ts', 'lib/vocabulary.ts', 'lib/use-json.ts', 'lib/findings.ts', 'lib/auth.ts',
      'next.config.mjs', 'package.json',
    ]);
    expect(source).not.toMatch(/https?:\/\//i);
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    expect(source).not.toMatch(/eval\(|new Function\(/);
    expect(source).not.toMatch(/fetch\(\s*["'`]https?:/);
    expect(source).not.toMatch(/<script/);
  });

  it('mirrors the host contract, the projection vocabulary and the severity order', async () => {
    const build = await emptyBuild();
    const mirroredIndex: ClientContract.DashboardIndexFile = build.index;
    expect(mirroredIndex.format).toBe('p2o-dashboard');
    expect(mirroredIndex.version).toBe(1);
    expect(mirroredIndex.labels.projection.length).toBeGreaterThan(0);
    expect([...KIND_ORDER].sort()).toEqual([...EXPLORATION_NODE_KINDS].sort());
    expect([...RELATION_ORDER].sort()).toEqual([...EXPLORATION_RELATIONS].sort());
    expect([...SEVERITY_ORDER].sort()).toEqual([...FINDING_SEVERITIES, 'not rated'].sort());
    expect(COLUMN_BANDS).toHaveLength(5);
  });
});

/** A compile-time-only assertion kept in a value position so the type check cannot be dropped by the bundler. */
const hostTypesAgree = (index: HostContract.DashboardIndexFile): void => {
  const mirrored: ClientContract.DashboardIndexFile = index;
  void mirrored;
};
void hostTypesAgree;
