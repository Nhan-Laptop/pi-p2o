import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DASHBOARD_FORMAT_VERSION, DASHBOARD_LIMITS } from '../../src/dashboard/contract.js';
import { buildDashboard } from '../../src/dashboard/read-model.js';
import { sha256Hex } from '../../src/validate.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * planning_update.md P1: the read model is a bounded, deterministic, read-only projection of committed stores and exported
 * report bundles. These tests pin discovery, the projection-v3 hint rows, report parity, cross-run aggregation/conflict rules,
 * the report hash check, truncation warnings and the no-write invariant.
 */
const hashFile = async (path: string): Promise<string> => sha256Hex(await readFile(path));
const missingRoot = (): string => join(tmpdir(), `p2o-dashboard-missing-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 12)}`);

/** One hand-written report bundle: lets a test arrange two runs that share a finding identity without a second live harness. */
async function syntheticBundle(root: string, runId: string, item: Record<string, unknown>, options: { asOfSequence?: number; extraFiles?: boolean } = {}): Promise<string> {
  const findings = `${JSON.stringify({ format: 'p2o-findings', version: 2, runId, asOfSequence: options.asOfSequence ?? 10, complete: true, endReason: 'manual', findings: [item] }, null, 2)}\n`;
  const directory = join(root, `report-${runId}`);
  await mkdir(directory, { recursive: true });
  const files: Array<{ name: string; body: string }> = options.extraFiles === false ? [{ name: 'REPORT.md', body: '# synthetic\n' }]
    : [{ name: 'REPORT.md', body: '# synthetic\n' }, { name: 'findings.json', body: findings }];
  for (const file of files) await writeFile(join(directory, file.name), file.body);
  const manifest = { format: 'p2o-report', version: 2, runId, asOfSequence: options.asOfSequence ?? 10, records: 3, complete: true, endReason: 'manual',
    files: files.map(file => ({ name: file.name, bytes: Buffer.byteLength(file.body), sha256: sha256Hex(file.body) })) };
  await writeFile(join(directory, 'report-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}
const findingItem = (runId: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  ref: 'F-1', caseId: 'case-synthetic', revision: 1, title: 'Synthetic shared finding', severity: 'high', verdict: 'confirmed',
  reviewStatus: 'accepted', currentness: 'current', findingId: sha256Hex('shared-finding-identity').slice(0, 32), policyKey: 'policy:shared',
  rootCauseKey: 'root:shared', remediation: { status: 'unplanned', reason: '' }, retest: null,
  cvss: { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', baseScore: 7.5, severity: 'high' },
  cwe: ['CWE-200'], wstg: [{ key: 'wstg-athn-01', page: null }], techniques: [], assets: ['asset-a'], reproduction: [], ...patch,
});

describe('dashboard read model discovery', () => {
  it('returns an empty, versioned tree for roots that do not exist yet', async () => {
    const built = await buildDashboard({ stateRoots: [{ path: missingRoot(), optional: true }], reportRoots: [{ path: missingRoot(), optional: true }] });
    expect(built.index).toMatchObject({ format: 'p2o-dashboard', version: DASHBOARD_FORMAT_VERSION, generatedAt: null, runs: [], findings: [], warnings: [] });
    expect(built.index.totals).toEqual({ runs: 0, findings: 0, accepted: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, informational: 0, 'not rated': 0 } });
    expect(built.index.limits).toEqual(DASHBOARD_LIMITS);
    expect(built.runs).toEqual([]);
  });

  it('reports a non-optional missing root instead of presenting an empty scan as complete', async () => {
    const built = await buildDashboard({ stateRoots: [{ path: missingRoot() }] });
    expect(built.index.warnings.map(warning => warning.code)).toContain('root-unreadable');
  });
});

describe('dashboard store run: derivation, report parity and no writes', () => {
  it('projects one run, its hint rows, all cases and the report\'s accepted-current findings without touching the store', async () => {
    await fixture(async h => {
      await populate(h);
      await h.call('p2o_loop', { action: 'hint', text: 'Prefer the recorded fixture route over brute force' });
      const runId = await h.runId(), stateRoot = join(h.root, '.p2o-state'), storeFile = join(stateRoot, runId, 'assessment.sqlite');
      const before = await hashFile(storeFile), filesBefore = await readdir(join(stateRoot, runId));
      const built = await buildDashboard({ stateRoots: [{ path: stateRoot }], reportRoots: [{ path: missingRoot(), optional: true }] });
      expect(await hashFile(storeFile)).toBe(before);
      expect(await readdir(join(stateRoot, runId))).toEqual(filesBefore);
      expect(built.index.runs).toHaveLength(1);
      const summary = built.index.runs[0]!;
      expect(summary).toMatchObject({ runId, source: 'store', retention: 'durable-local', live: true, schemaVersion: 8, graphVersion: 3 });
      expect(summary.counts.cases).toBe(2);
      expect(summary.counts.findingsAccepted).toBe(1);
      expect(built.index.generatedAt).toBe(summary.lastRecordAt);
      const run = built.runs.find(file => file.runId === runId)!;
      const hint = run.graph.nodes.find(node => node.kind === 'hint')!;
      expect(hint).toMatchObject({ kind: 'hint', state: 'active' });
      expect(hint.text).toContain('hint: Prefer the recorded fixture route over brute force');
      expect(run.graph.edges.filter(edge => edge.srcId === hint.id || edge.dstId === hint.id)).toEqual([]);
      expect(run.graph.counts.nodes).toBe(run.graph.nodes.length);
      // Every case is listed for a retained store; only the accepted one reaches findings (the report's own rule).
      expect(run.cases.map(row => row.reviewStatus).sort()).toEqual(['accepted', 'pending']);
      const acceptedCase = run.cases.find(row => row.accepted)!;
      expect(acceptedCase).toMatchObject({ verdict: 'confirmed', currentness: 'current' });
      expect(run.findings).toHaveLength(1);
      expect(run.findings[0]).toMatchObject({ caseId: acceptedCase.id, severity: null, identity: 'findingId' });
      expect(run.findings[0]!.findingId).toMatch(/^[a-f0-9]{32}$/);
      expect(built.index.findings[0]).toMatchObject({ identity: 'findingId', severity: 'not rated', runs: [runId] });
      expect(built.index.findings[0]!.occurrences[0]).toMatchObject({ runId, source: 'store', caseId: acceptedCase.id });
      expect(built.index.totals).toMatchObject({ runs: 1, findings: 1, accepted: 1 });
      expect(built.index.omitted).toEqual({ findings: 0 });
      expect(run.omitted).toMatchObject({ cases: 0, findings: 0 });
      // The same on-disk state yields the same tree, byte for byte, on a second scan.
      expect(await buildDashboard({ stateRoots: [{ path: stateRoot }] })).toEqual(built);
    });
  });

  it('bounds the case rows and says so when the bound binds', async () => {
    await fixture(async h => {
      await populate(h);
      const built = await buildDashboard({ stateRoots: [{ path: join(h.root, '.p2o-state') }], limits: { casesPerRun: 1 } });
      const run = built.runs[0]!;
      expect(run.cases).toHaveLength(1);
      expect(run.omitted.cases).toBe(1);
      expect(run.run.counts.cases).toBe(2);
    });
  });
});

describe('dashboard report bundles: discovery, parity and the manifest hash check', () => {
  it('reads a report-only run, marks the missing store scope and keeps the findings accepted-current only', async () => {
    await fixture(async h => {
      await populate(h);
      h.ctx.setConfirm(true);
      const out = join(h.root, 'out');
      await h.command(`report export ${out}`);
      const built = await buildDashboard({ reportRoots: [{ path: out }] });
      expect(built.index.runs).toHaveLength(1);
      const summary = built.index.runs[0]!;
      expect(summary).toMatchObject({ source: 'report', retention: 'unknown', sequence: null, target: null, live: false, graphVersion: 0 });
      expect(summary.asOfSequence).toBeGreaterThan(0);
      expect(summary.counts.findingsAccepted).toBe(1);
      const run = built.runs[0]!;
      expect(run.graph).toMatchObject({ graphVersion: 0, nodes: [], edges: [], counts: { nodes: 0, edges: 0, anchors: 0 } });
      expect(run.cases).toEqual([]);
      expect(run.findings).toHaveLength(1);
      expect(run.findings[0]!.severity).toBeNull();
      expect(built.index.findings[0]!.occurrences.map(occurrence => occurrence.source)).toEqual(['report']);
    });
  });

  it('merges a store and its own bundle into one source "both" run without duplicating the occurrence', async () => {
    await fixture(async h => {
      await populate(h);
      h.ctx.setConfirm(true);
      const stateRoot = join(h.root, '.p2o-state'), out = join(h.root, 'out');
      await h.command(`report export ${out}`);
      const runId = await h.runId();
      const built = await buildDashboard({ stateRoots: [{ path: stateRoot }], reportRoots: [{ path: out }] });
      expect(built.index.runs).toHaveLength(1);
      expect(built.index.runs[0]).toMatchObject({ runId, source: 'both' });
      expect(built.index.findings).toHaveLength(1);
      expect(built.index.findings[0]!.occurrences).toHaveLength(1);
      expect(built.index.findings[0]!.occurrences[0]!.source).toBe('store');
      expect(built.runs[0]!.cases).toHaveLength(2);
    });
  });

  it('skips a findings.json that no longer matches the sha256 its manifest recorded, with a warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-dashboard-synthetic-'));
    try {
      const bundle = await syntheticBundle(root, 'run-tampered', findingItem('run-tampered'));
      const path = join(bundle, 'findings.json');
      const original = await readFile(path, 'utf8');
      // Same length, different bytes: the size still matches the manifest, only the sha256 check can catch it.
      await writeFile(path, original.replace('Synthetic shared finding', 'synthetic shared finding'));
      const built = await buildDashboard({ reportRoots: [{ path: root }] });
      expect(built.index.runs).toHaveLength(1);
      expect(built.index.findings).toEqual([]);
      expect(built.runs[0]!.findings).toEqual([]);
      const codes = built.index.warnings.map(warning => warning.code);
      expect(codes).toContain('report-file-hash');
      expect(codes).not.toContain('report-file-size');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('lists a report-format-1 bundle by its manifest and states that it carries no findings file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-dashboard-format1-'));
    try {
      await syntheticBundle(root, 'run-format1', findingItem('run-format1'), { extraFiles: false });
      const built = await buildDashboard({ reportRoots: [{ path: root }] });
      expect(built.index.runs[0]).toMatchObject({ runId: 'run-format1', source: 'report' });
      expect(built.runs[0]!.findings).toEqual([]);
      expect(built.index.warnings.map(warning => warning.code)).toContain('report-no-findings');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('dashboard cross-run aggregation: conflicts, fallback identity and the aggregate finding cap', () => {
  it('keeps divergent severities and titles visible as conflicts instead of picking one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-dashboard-conflict-'));
    try {
      await syntheticBundle(root, 'run-conflict-a', findingItem('run-conflict-a'));
      await syntheticBundle(root, 'run-conflict-b', findingItem('run-conflict-b', { severity: 'low', title: 'Synthetic shared finding, restated' }));
      const built = await buildDashboard({ reportRoots: [{ path: root }] });
      expect(built.index.findings).toHaveLength(1);
      const aggregate = built.index.findings[0]!;
      expect(aggregate.runs).toEqual(['run-conflict-a', 'run-conflict-b']);
      expect(aggregate.severity).toBe('high'); // worst severity across occurrences, not the first
      expect(aggregate.occurrences).toHaveLength(2);
      expect(aggregate.conflicts.map(conflict => conflict.field).sort()).toEqual(['severity', 'title']);
      expect(aggregate.conflicts.find(conflict => conflict.field === 'severity')!.values.map(value => value.value).sort()).toEqual(['high', 'low']);
      expect(built.index.totals.bySeverity.high).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('falls back to the target/policy/root-cause/title identity when a bundle predates host finding ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-dashboard-fallback-'));
    try {
      await syntheticBundle(root, 'run-fallback-a', findingItem('run-fallback-a', { findingId: null }));
      await syntheticBundle(root, 'run-fallback-b', findingItem('run-fallback-b', { findingId: undefined, title: 'Synthetic shared finding' }));
      const built = await buildDashboard({ reportRoots: [{ path: root }] });
      expect(built.index.findings).toHaveLength(1);
      expect(built.index.findings[0]).toMatchObject({ identity: 'fallback', runs: ['run-fallback-a', 'run-fallback-b'] });
      expect(built.index.findings[0]!.id).toMatch(/^fallback-[a-f0-9]{32}$/);
      expect(built.index.findings[0]!.occurrences.map(occurrence => occurrence.identity)).toEqual(['fallback', 'fallback']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('caps the aggregate finding rows and counts what it omitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-dashboard-cap-'));
    try {
      await syntheticBundle(root, 'run-cap-a', findingItem('run-cap-a'));
      await syntheticBundle(root, 'run-cap-b', findingItem('run-cap-b', { findingId: sha256Hex('second-identity').slice(0, 32), title: 'Second synthetic finding' }));
      const built = await buildDashboard({ reportRoots: [{ path: root }], limits: { findings: 1 } });
      expect(built.index.findings).toHaveLength(1);
      expect(built.index.omitted.findings).toBe(1);
      expect(built.index.totals.findings).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
