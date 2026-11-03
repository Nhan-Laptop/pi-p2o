import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DASHBOARD_LIMITS } from '../../src/dashboard/contract.js';
import { buildDashboard } from '../../src/dashboard/read-model.js';
import { sha256Hex } from '../../src/validate.js';

/**
 * planning_update.md P4: the read model is a bounded scan, not a walk of whatever happens to be on disk. These tests pin the
 * bounds that make a large or hand-written root finish with stated omissions instead of hanging: runs per root set, directory
 * entries examined per root, the per-run data bound on a report file (checked against the real file size, not just the
 * manifest's claim) and byte determinism across two scans of the same root.
 */
const finding = (index: number): Record<string, unknown> => ({
  ref: `F-${index}`, caseId: `case-${index}`, revision: 1, title: `Bounded synthetic finding ${index}`, severity: 'medium',
  verdict: 'confirmed', reviewStatus: 'accepted', currentness: 'current', findingId: sha256Hex(`identity-${index}`).slice(0, 32),
  policyKey: `policy:${index}`, rootCauseKey: `root:${index}`, remediation: { status: 'unplanned', reason: '' }, retest: null,
  cvss: null, cwe: [], wstg: [], techniques: [], assets: [], reproduction: [],
});
const findingsBody = (runId: string, items: unknown[]): string =>
  `${JSON.stringify({ format: 'p2o-findings', version: 2, runId, asOfSequence: 10, complete: true, endReason: 'manual', findings: items }, null, 2)}\n`;

/** A hand-written report bundle; `declaredBytes` lets a test make the manifest disagree with what is on disk. */
async function bundle(root: string, runId: string, body: string, declaredBytes?: number): Promise<string> {
  const directory = join(root, `report-${runId}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'findings.json'), body);
  const manifest = { format: 'p2o-report', version: 2, runId, asOfSequence: 10, records: 3, complete: true, endReason: 'manual',
    files: [{ name: 'findings.json', bytes: declaredBytes ?? Buffer.byteLength(body), sha256: sha256Hex(body) }] };
  await writeFile(join(directory, 'report-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

describe('dashboard scan bounds on a many-run root', () => {
  it('reads at most the run bound, states the omission, and produces the same bounded tree twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-dashboard-many-'));
    try {
      const reports = join(root, 'reports');
      await mkdir(reports);
      for (let index = 0; index < 210; index += 1) {
        const runId = `run-${String(index).padStart(4, '0')}`;
        await bundle(reports, runId, findingsBody(runId, [finding(index)]));
      }
      const started = process.hrtime.bigint();
      const built = await buildDashboard({ reportRoots: [{ path: reports }] });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      // The scan is bounded, so 210 bundles finish in one pass with a stated cap rather than growing with the directory.
      expect(elapsedMs).toBeLessThan(30_000);
      expect(built.index.runs).toHaveLength(DASHBOARD_LIMITS.runs);
      expect(built.runs).toHaveLength(DASHBOARD_LIMITS.runs);
      const codes = built.index.warnings.map(warning => warning.code);
      expect(codes).toContain('reports-truncated');
      expect(built.index.warnings.find(warning => warning.code === 'reports-truncated')!.detail).toContain('10 omitted');
      expect(built.index.findings).toHaveLength(200);
      expect(built.index.totals).toMatchObject({ runs: 200, findings: 200, accepted: 200 });
      // Every run file stays inside the per-run byte bound, and the aggregate stays inside the snapshot bound.
      for (const file of built.runs) expect(Buffer.byteLength(JSON.stringify(file))).toBeLessThanOrEqual(DASHBOARD_LIMITS.dataBytesPerRun);
      expect(Buffer.byteLength(JSON.stringify(built.index))).toBeLessThanOrEqual(DASHBOARD_LIMITS.snapshotBytes);
      expect(await buildDashboard({ reportRoots: [{ path: reports }] })).toEqual(built);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it('opens at most the directory-entry bound of a root and says how many entries it did not examine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-dashboard-entries-'));
    try {
      const reports = join(root, 'reports');
      await mkdir(reports);
      for (let index = 0; index < 5; index += 1) {
        const runId = `run-${String(index).padStart(4, '0')}`;
        await bundle(reports, runId, findingsBody(runId, [finding(index)]));
      }
      const built = await buildDashboard({ reportRoots: [{ path: reports }], limits: { runs: 10, directoryEntries: 2 } });
      expect(built.index.runs).toHaveLength(2);
      const truncated = built.index.warnings.find(warning => warning.code === 'root-entries-truncated')!;
      expect(truncated.detail).toContain('2 of 5');
      // A state root is bounded by the same entry cap, with no store needed to prove it.
      const state = join(root, 'state');
      await mkdir(state);
      for (let index = 0; index < 5; index += 1) await mkdir(join(state, `run-${String(index).padStart(4, '0')}`));
      const empty = await buildDashboard({ stateRoots: [{ path: state }], limits: { directoryEntries: 3 } });
      expect(empty.index.runs).toEqual([]);
      expect(empty.index.warnings.find(warning => warning.code === 'root-entries-truncated')!.detail).toContain('3 of 5');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses an oversized findings.json before reading it, using the real file size rather than the manifest claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-dashboard-oversize-'));
    try {
      const reports = join(root, 'reports');
      await mkdir(reports);
      const padding = 'x'.repeat(5000);
      const honest = `run-honest`;
      await bundle(reports, honest, `${JSON.stringify({ format: 'p2o-findings', version: 2, runId: honest, findings: [{ title: padding }] })}`);
      // A manifest that understates the file is why the bound is checked against stat, not the claim.
      const lying = `run-lying`;
      await bundle(reports, lying, `${JSON.stringify({ format: 'p2o-findings', version: 2, runId: lying, findings: [{ title: padding }] })}`, 10);
      const built = await buildDashboard({ reportRoots: [{ path: reports }], limits: { dataBytesPerRun: 1024 } });
      expect(built.index.runs).toHaveLength(2);
      for (const run of built.runs) expect(run.findings).toEqual([]);
      const tooLarge = built.index.warnings.filter(warning => warning.code === 'report-file-too-large');
      expect(tooLarge).toHaveLength(2);
      for (const warning of tooLarge) expect(warning.detail).toContain('was not read');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
