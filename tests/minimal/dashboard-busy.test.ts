import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildDashboard } from '../../src/dashboard/read-model.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * planning_update.md §6.3: the store opens read-only with `busy_timeout=0`, so a concurrent writer makes a reader fail with
 * SQLITE_BUSY. The dashboard may not silently drop that run or fail the whole view: it retries a bounded number of times, then
 * states the run as busy and still serves every other run.
 */
describe('dashboard concurrent-writer handling', () => {
  it('lists a run whose store stayed locked as busy instead of dropping it or failing the scan', async () => {
    await fixture(async h => {
      await populate(h);
      const stateRoot = join(h.root, '.p2o-state'), runId = await h.runId();
      const writer = new DatabaseSync(join(stateRoot, runId, 'assessment.sqlite'));
      writer.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      let built;
      try {
        built = await buildDashboard({ stateRoots: [{ path: stateRoot }] });
      } finally {
        writer.exec('ROLLBACK');
        writer.close();
      }
      expect(built.index.runs).toHaveLength(1);
      expect(built.index.runs[0]).toMatchObject({ runId, source: 'store', live: true, busy: true, records: 0, sequence: null });
      expect(built.index.runs[0]!.warnings.join('\n')).toContain('store-busy');
      expect(built.index.warnings.map(warning => warning.code)).toContain('store-busy');
      const run = built.runs[0]!;
      expect(run.graph.nodes).toEqual([]);
      expect(run.findings).toEqual([]);
      expect(run.omitted).toMatchObject({ cases: 0, findings: 0 });
      // Nothing was written and the same state is clean again once the writer releases the lock.
      const after = await buildDashboard({ stateRoots: [{ path: stateRoot }] });
      expect(after.index.runs[0]).toMatchObject({ runId, live: true });
      expect(after.index.runs[0]!.busy).toBeUndefined();
      expect(after.index.runs[0]!.records).toBeGreaterThan(0);
      expect(after.runs[0]!.findings).toHaveLength(1);
    });
  });
});
