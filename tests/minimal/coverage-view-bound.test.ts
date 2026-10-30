import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { coverageFingerprint } from '../../src/coverage.js';
import { appendRecord } from '../../src/records.js';
import type { CoverageCellDraft } from '../../src/coverage-types.js';
import { fixture } from './helpers/report-fixture.js';

/**
 * A5-fix-5 (planning_update.md P23 §2 S5, measured on run-06fde84d at 05:56Z): the coverage view pages its cells, so the 24 KiB
 * result bound has to cover the frame *and* the page. The old branch capped the cell array at 23 KiB on its own, so a large frame
 * pushed the combined result over the bound and refused the whole read — even though the paged design promised the read would fit.
 * The frame below is real: a plan carries its title, reason, exclusions and unknown scope, and a legacy plan carries stored cells.
 */
describe('A5-fix-5 coverage view byte budget', () => {
  it('A5-fix-5: fits a large frame and pages the cells under the 24 KiB read bound with a stable cursor walk', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const asset = (await h.call('p2o_graph_record', { batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /p23-bound' } }] } })).details.acks[0],
        run = await h.runId(), reader = await h.reader(), targetRevision = reader.graphScope();
      // The extension holds the writable store; its private broker alias is bound to that same store, so a canonical append here is
      // a same-run record the tools read. A pre-A3 stored plan is the only way to hold this many large cells without dozens of tasks.
      const [control] = (await readdir(join(h.root, 'control'))).filter((name: string) => name.startsWith('p2o-run-')),
        ledger = join(h.root, 'control', control, 'records.sqlite'), planId = 'coverage-plan-p23-bound',
        prose = (prefix: string) => `${prefix} ${'x'.repeat(480)}`,
        draft = (index: number): CoverageCellDraft => ({
          assetRef: { id: asset.entityId, revision: 1 }, questionKey: `question:p23-bound-${index}`, policyKey: 'policy:p23',
          actorContext: 'actor:a', tenantContext: 'tenant:a', methodFamily: 'offline-observation', execution: 'planned', assessment: 'unreviewed',
          taskRefs: [], claimRefs: [], caseRefs: [], evidenceRefs: [], negativeControlRefs: [], gapRefs: [],
          reason: 'r'.repeat(1500), limitations: 'l'.repeat(2000),
        }),
        cells = Array.from({ length: 6 }, (_, index) => { const input = draft(index), id = `coverage-cell-p23-${index}`; return { id, input, fingerprint: coverageFingerprint(targetRevision, input) }; });
      reader.close();
      await appendRecord(ledger, { id: randomUUID(), runId: run, at: '2030', by: 'owner', kind: 'note', text: 'A5-fix-5 large-frame coverage plan',
        data: { coveragePlan: { id: planId, runId: run, revision: 1, title: 'P23 bound plan', status: 'active', reason: 'r'.repeat(1500),
          exclusions: Array.from({ length: 10 }, (_, index) => prose(`P23 exclusion ${index}`)), unknownScope: Array.from({ length: 10 }, (_, index) => prose(`P23 unknown ${index}`)),
          targetRevision, cellIds: cells.map(cell => cell.id) } } });
      for (const cell of cells) await appendRecord(ledger, { id: cell.id, runId: run, at: '2030', by: 'owner', kind: 'note', text: 'A5-fix-5 stored large cell',
        data: { coverageCell: { ...cell.input, id: cell.id, runId: run, revision: 1, planId, planRevision: 1, targetRevision, fingerprint: cell.fingerprint, retired: false } } });
      const first = (await h.call('p2o_board', { board: 'coverage', id: planId })).details as any;
      // The read itself must be under the bound the tool refuses above; the totals are the whole denominator and the walk reaches all cells.
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(24 * 1024);
      expect(first).toMatchObject({ total: 6, cursor: 0, counts: { execution: { planned: 6 }, assessment: { unreviewed: 6 } } });
      expect(first.shown).toBeGreaterThan(0);
      expect(first.shown).toBeLessThan(6);
      expect(first.warning).toContain('Cells are paged');
      const ids: string[] = [...first.cells.map((cell: any) => cell.id)];
      let cursor: number | undefined = first.nextCursor;
      while (cursor !== undefined) {
        const page = (await h.call('p2o_board', { board: 'coverage', id: planId, cursor })).details as any;
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(24 * 1024);
        expect(page).toMatchObject({ total: 6, cursor });
        expect(page.shown).toBeGreaterThan(0);
        ids.push(...page.cells.map((cell: any) => cell.id));
        cursor = page.nextCursor;
      }
      expect(ids).toEqual(cells.map(cell => cell.id));
    });
  }, 60_000);

  it('A5-fix-5: a frame that cannot carry a single cell returns its counters and the remedy instead of refusing the read', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const run = await h.runId(), reader = await h.reader(), targetRevision = reader.graphScope();
      const [control] = (await readdir(join(h.root, 'control'))).filter((name: string) => name.startsWith('p2o-run-')),
        ledger = join(h.root, 'control', control, 'records.sqlite'), planId = 'coverage-plan-p23-unmapped';
      reader.close();
      // A projected plan derives its frame from the whole task frontier: tasks with no work identity are reported as unmapped rows, so a
      // run whose tasks lack asset identity can outgrow the read budget before a single cell is added.
      for (let index = 0; index < 20; index++) await appendRecord(ledger, { id: randomUUID(), runId: run, at: '2030', by: 'owner', kind: 'task', text: 'A5-fix-5 unmapped task',
        data: { task: { id: `task-p23-unmapped-${index}`, runId: run, revision: 1, question: `q${index} ${'q'.repeat(1480)}`, surface: '/p23', risk: 'authorization', role: 'general', status: 'proposed', prerequisites: [] } } });
      await appendRecord(ledger, { id: randomUUID(), runId: run, at: '2030', by: 'owner', kind: 'note', text: 'A5-fix-5 unmapped-heavy projected plan',
        data: { coveragePlan: { id: planId, runId: run, revision: 1, title: 'P23 unmapped plan', status: 'active', reason: 'Projected plan with an unmapped-heavy task frontier',
          exclusions: [], unknownScope: [], targetRevision, cellIds: [], derivation: 'projected' } } });
      const view = (await h.call('p2o_board', { board: 'coverage', id: planId })).details as any;
      expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(24 * 1024);
      expect(view).toMatchObject({ id: planId, revision: 1, status: 'active', total: 0, shown: 0, omitted: 0 });
      expect(view.warning).toMatch(/frame takes \d+ of the 24 KiB read budget/);
      expect(view.warning).toContain('retained ledger revision');
    });
  }, 60_000);
});
