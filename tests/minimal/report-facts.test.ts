import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { renderReport } from '../../src/report-export.js';
import { indexRecords } from '../../src/records.js';
import { buildDashboard } from '../../src/dashboard/read-model.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * P5b: the structured report view reads a bounded facts object computed inside the same renderReport call as the document.
 * These tests pin the guarantees that make that safe: the facts exist and are versioned, they never change the rendered bytes,
 * and the dashboard carries them for a retained store (a report bundle cannot: facts are dashboard-only, not exported).
 */
describe('report facts: structured view data beside the document', () => {
  it('builds bounded facts without changing the rendered bytes', () => {
    const meta = { runId: 'run-facts', target: 'inert', retention: 'durable-local' as const, historical: false, asOfSequence: 1,
      storeSchema: 8, runtime: { version: '0.5.0', hash: 'f'.repeat(64) }, complete: true, format: 2 as const, endReason: 'finished' };
    const index = indexRecords([], meta.runId);
    const rendered = renderReport(index, {}, meta);
    const facts = rendered.facts!;
    expect(facts).toMatchObject({ format: 'p2o-report-facts', version: 1, runId: 'run-facts', asOfSequence: 1, storeSchema: 8, endReason: 'finished' });
    expect(facts.summary).toMatchObject({ acceptedCurrent: 0, otherCases: 0, coverageCells: 0, openGaps: 0 });
    expect(facts.findings).toEqual([]);
    expect(facts.plans).toEqual([]);
    expect(facts.remainingWork.state).toBe(facts.completion.state);
    expect(facts.limits).toEqual({ rows: 200, caseRows: 500, note: expect.stringContaining('document remains the authority') });
    // Derived, not rendered: the same inputs still produce the exact same files.
    expect(renderReport(indexRecords([], meta.runId), {}, meta).files).toEqual(rendered.files);
  });

  it('matches the document counts for a populated store run carried by the dashboard', async () => {
    await fixture(async h => {
      await populate(h);
      const built = await buildDashboard({ stateRoots: [{ path: join(h.root, '.p2o-state') }] });
      const run = built.runs[0]!;
      const facts = run.reportFacts!;
      expect(run.run.hasFacts).toBe(true);
      expect(facts).toMatchObject({ format: 'p2o-report-facts', version: 1, runId: run.runId });
      expect(facts.summary.acceptedCurrent).toBe(run.findings.length);
      expect(facts.findings).toHaveLength(run.findings.length);
      if (run.findings.length) {
        expect(facts.findings[0]).toMatchObject({ caseId: run.findings[0]!.caseId, revision: run.findings[0]!.caseRevision });
        expect(facts.findings[0]!.severity).toBe(run.findings[0]!.severity);
      }
      expect(facts.authority.roles.planner).toBeGreaterThan(0);
      expect(facts.authority.tasksCreated).toBeGreaterThan(0);
      expect(facts.summary.acceptedCurrent).toBe(run.run.counts.findingsAccepted);
      expect(facts.remainingWork.remaining).toBe(facts.completion.remaining);
      expect(facts.limits.note).toContain('authority');
    });
  });
});
