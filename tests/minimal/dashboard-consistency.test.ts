import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AssessmentStore } from '../../src/state/store.js';
import { caseViews } from '../../src/cases.js';
import { indexRecords } from '../../src/records.js';
import { buildDashboard } from '../../src/dashboard/read-model.js';
import { sha256Hex } from '../../src/validate.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * planning_update.md P3 exit gate: the finding screen must not become a second opinion. Three copies of "what a finding is"
 * exist — the report (`findings.json`), the retained store (every case) and the dashboard aggregate — and these tests pin the
 * first two against the dashboard rows instead of trusting the shared builder by convention.
 */
const reportFindings = async (bundle: string): Promise<{ items: Array<Record<string, unknown>>; runId: string }> => {
  const body = JSON.parse(await readFile(join(bundle, 'findings.json'), 'utf8')) as { runId: string; findings: Array<Record<string, unknown>> };
  return { items: body.findings, runId: body.runId };
};

describe('dashboard/report parity for accepted-current findings', () => {
  it('projects the same accepted findings, identity and evidence fields the report bundle records', async () => {
    await fixture(async h => {
      await populate(h);
      h.ctx.setConfirm(true);
      const bundle = join(h.root, 'report-out');
      await h.command(`report export ${bundle}`);
      const stateRoot = join(h.root, '.p2o-state');
      const built = await buildDashboard({ stateRoots: [{ path: stateRoot }] });
      const run = built.runs[0]!;
      const report = await reportFindings(bundle);
      expect(run.runId).toBe(report.runId);
      expect(run.findings).toHaveLength(report.items.length);
      expect(report.items.length).toBe(1);
      for (const [position, item] of report.items.entries()) {
        const row = run.findings[position]!;
        const wstg = (Array.isArray(item.wstg) ? item.wstg : []).flatMap(entry => typeof entry === 'object' && entry !== null && typeof (entry as { key?: unknown }).key === 'string' ? [(entry as { key: string }).key] : []);
        expect(row).toMatchObject({
          caseId: item.caseId, caseRevision: item.revision, title: item.title, findingId: item.findingId,
          severity: item.severity ?? null, verdict: item.verdict, reviewStatus: item.reviewStatus, currentness: item.currentness,
          policyKey: item.policyKey, rootCauseKey: item.rootCauseKey ?? null,
          cvss: item.cvss ?? null, cwe: item.cwe ?? [], techniques: item.techniques ?? [], assets: item.assets ?? [],
        });
        expect(row.wstg.map(entry => entry.key)).toEqual(wstg);
        expect(row.reproduction.map(step => step.evidenceId)).toEqual((item.reproduction as Array<{ evidenceId: string }> | undefined ?? []).map(step => step.evidenceId));
        expect(row.remediation.status).toBe((item.remediation as { status: string }).status);
        expect(row.claims).toEqual(item.claims ?? []);
        expect(row.independentEvidence).toEqual(item.independentEvidence ?? []);
        expect(row.references).toEqual(item.references ?? []);
        expect(row.contradictions).toEqual(item.contradictions ?? []);
        expect(row.limitations).toBe(item.limitations ?? null);
        expect(row.independenceWaiver).toBe(item.independenceWaiver ?? null);
        expect(item.independentValidationCurrent).toBe(row.independentValidationCurrent);
        // The report's item counts as accepted-current, so the dashboard row must too.
        expect(row.accepted).toBe(true);
        expect(run.cases.some(entry => entry.id === row.caseId && entry.revision === row.caseRevision && entry.accepted)).toBe(true);
      }
      const reportOnly = await buildDashboard({ reportRoots: [{ path: bundle }] });
      const reportRow = reportOnly.runs[0]!.findings[0]!;
      const storeRow = run.findings[0]!;
      expect(reportRow).toMatchObject({ caseId: storeRow.caseId, title: storeRow.title, severity: storeRow.severity, policyKey: storeRow.policyKey });
      expect(reportRow.time).toBeNull(); // a report bundle records no per-finding time; the store row has one
      expect(storeRow.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // P5a: the report tab reads one document. A store body is rendered with default settings and says it is not the export;
      // the bundle copy is byte-identical to the exported REPORT.md, so the screen cannot show a different document.
      const exportedReport = await readFile(join(bundle, 'REPORT.md'), 'utf8');
      expect(run.report).toMatchObject({ file: 'REPORT.md', origin: 'store', exportEquivalent: false });
      expect(run.report!.sha256).toBe(sha256Hex(run.report!.text));
      expect(run.report!.bytes).toBe(Buffer.byteLength(run.report!.text, 'utf8'));
      expect(run.report!.asOfSequence).toBe(run.run.sequence);
      expect(reportOnly.runs[0]!.report).toMatchObject({ origin: 'bundle', exportEquivalent: true });
      expect(reportOnly.runs[0]!.report!.text).toBe(exportedReport);
      expect(reportOnly.runs[0]!.report!.sha256).toBe(sha256Hex(exportedReport));
    });
  });

  it('lists every retained case, not only the accepted ones, and marks the accepted subset exactly', async () => {
    await fixture(async h => {
      await populate(h);
      const stateRoot = join(h.root, '.p2o-state'), runId = await h.runId();
      const built = await buildDashboard({ stateRoots: [{ path: stateRoot }] });
      const run = built.runs[0]!;
      const store = AssessmentStore.open(stateRoot, runId, { readOnly: true });
      let expected;
      try {
        const index = indexRecords(store.records(), runId), context = store.reviewContext();
        expected = caseViews(index, context.cases);
      } finally { store.close(); }
      expect(run.omitted.cases).toBe(0);
      expect(run.cases).toHaveLength(expected.length);
      const byKey = new Map(run.cases.map(row => [`${row.id}\u0000${row.revision}`, row]));
      for (const view of expected) {
        const row = byKey.get(`${view.id}\u0000${view.revision}`);
        expect(row, `${view.id}@${view.revision}`).toBeDefined();
        expect(row).toMatchObject({ title: view.title, verdict: view.verdict, reviewStatus: view.reviewStatus, currentness: view.currentness,
          accepted: view.acceptedFinding, policyKey: view.policyKey, canonicalCaseId: view.canonicalCaseId });
      }
      expect(run.cases.filter(row => row.accepted)).toHaveLength(1);
      expect(run.findings).toHaveLength(run.cases.filter(row => row.accepted).length);
    });
  });

  it('carries the case record time into the cross-run occurrence so first/last seen are committed facts, not wall-clock reads', async () => {
    await fixture(async h => {
      await populate(h);
      const built = await buildDashboard({ stateRoots: [{ path: join(h.root, '.p2o-state') }] });
      const aggregate = built.index.findings[0]!;
      expect(aggregate.occurrences).toHaveLength(1);
      expect(aggregate.occurrences[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(aggregate.firstSeen).toBe(aggregate.occurrences[0]!.time);
      expect(aggregate.lastSeen).toBe(aggregate.occurrences[0]!.time);
      expect(built.index.generatedAt).toBe(built.index.runs[0]!.lastRecordAt);
      expect(aggregate.lastSeen! >= aggregate.firstSeen!).toBe(true);
      expect(aggregate.lastSeen! <= built.index.generatedAt!).toBe(true);
    });
  });
});
