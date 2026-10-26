import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFile as readFileText } from 'node:fs/promises';
import { indexRecords, type AssessmentRecord } from '../../src/records.js';
import { authorityCounters } from '../../src/authority.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * P5/A6.6 (planning_update.md §4, D9 approved 2026-10-26 = refuse): the final finish of a campaign cannot claim a frame it
 * never recorded, an incomplete campaign records why it stopped, and the report prints the campaign and the debt at stop.
 * Hermetic: in-process extension, fake Pi, real SQLite store, no model and no target.
 */
const text = (result: any) => result.content[0].text as string;
const finalReport = async (result: any) => readFileText(join(result.details.reportPath, 'REPORT.md'), 'utf8');

describe('campaign finish and report semantics (A6.6)', () => {
  it('refuses the final finish of a campaign that never recorded a goal, and names the three legal next calls', async () => fixture(async h => {
    await h.command('--target ./source --goal "Assess the fixture boundary"');
    await populate(h);
    // The export path stays unconditional: writing the report ends nothing and is one of the legal next calls.
    const exported = await h.call('p2o_finish', { export: true });
    expect(exported.details.state).toBe('incomplete');
    await expect(h.call('p2o_finish', {})).rejects.toThrow(/CAMPAIGN_FRAME_MISSING/);
    await expect(h.call('p2o_finish', {})).rejects.toThrow(/p2o_plan_create \{kind:"goal"/);
    await expect(h.call('p2o_finish', {})).rejects.toThrow(/p2o_finish \{export:true\}/);
    await expect(h.call('p2o_finish', {})).rejects.toThrow(/p2o_finish \{partial:/);
    // The refusal ends nothing: the run is still active and a goal makes the final path legal.
    expect((await h.call('p2o_board', { board: 'tasks' })).details.total).toBeGreaterThan(0);
    await h.call('p2o_plan_create', { entry: { kind: 'goal', title: 'Assess one bounded fixture boundary', status: 'proposed',
      reason: 'Campaign goal whose proof is the fixture accepted case', criteria: ['The fixture boundary is demonstrated by an accepted current case'],
      proof: { kind: 'case', ref: 'case-fixture' } } });
    const finished = await h.call('p2o_finish', { partial: 'The bounded fixture campaign stops after its declared coverage; the remaining debt is recorded' });
    expect(finished.details.state).toBe('incomplete');
    expect(finished.details.campaignPartial).toContain('bounded fixture campaign');
  }));

  it('lets a goal-less campaign stop by recording why, and still reports it incomplete', async () => fixture(async h => {
    await h.command('--target ./source --goal "Assess the fixture boundary"');
    await populate(h);
    // D9's third legal next call: partial is an explicit acknowledgment that the campaign recorded no goal, never a
    // silent complete finish, so it proceeds and is recorded like any other partial stop.
    const reason = 'The bounded fixture campaign never recorded a goal; it stops with the observation recorded';
    const result = await h.call('p2o_finish', { partial: reason });
    expect(result.details.state).toBe('incomplete');
    expect(result.details.campaignPartial).toBe(reason);
    const report = await finalReport(result);
    expect(report).toContain('### Why the run stopped');
    expect(report).toContain(reason);
    expect(report).toContain('A partial stop is not a completion and asserts nothing about coverage.');
    const store = await h.reader();
    try {
      expect(store.campaignPartial()?.reason).toBe(reason);
      expect((store.outcome() as { assessmentOutcome: string }).assessmentOutcome).toBe('incomplete');
    } finally { store.close(); }
  }));

  it('records campaign.partial once with the reason and prints it as why the run stopped', async () => fixture(async h => {
    await h.command('--target ./source --goal "Assess the fixture boundary"');
    await populate(h);
    await h.call('p2o_plan_create', { entry: { kind: 'goal', title: 'Assess one bounded fixture boundary', status: 'proposed',
      reason: 'Campaign goal whose proof is the fixture accepted case', criteria: ['The fixture boundary is demonstrated by an accepted current case'],
      proof: { kind: 'case', ref: 'case-fixture' } } });
    const reason = 'The operator narrowed the campaign to the reviewed fixture boundary; the remaining WSTG rows are out of scope for this run';
    const result = await h.call('p2o_finish', { partial: reason });
    expect(result.details.reportPath).toMatch(/-final$/);
    const report = await finalReport(result);
    expect(report).toContain('## Campaign');
    expect(report).toContain('Assess the fixture boundary');
    expect(report).toContain('### Why the run stopped');
    expect(report).toContain(reason);
    expect(report).toContain('A partial stop is not a completion and asserts nothing about coverage.');
    expect(report).toContain('## Research debt at stop');
    const store = await h.reader();
    try {
      expect(store.campaignPartial()?.reason).toBe(reason);
      const counters = authorityCounters(indexRecords(store.records(), await h.runId()));
      expect(counters.campaignPartial).toBe(1);
      // A final finish is still a finish: the stored outcome says incomplete, not complete.
      expect((store.outcome() as { assessmentOutcome: string }).assessmentOutcome).toBe('incomplete');
    } finally { store.close(); }
  }));

  it('keeps the export path refusal-free and writes the same campaign/debt sections deterministically', async () => fixture(async h => {
    await h.command('--target ./source --goal "Assess the fixture boundary"');
    await populate(h);
    const first = await h.call('p2o_finish', { export: true });
    const second = await h.call('p2o_finish', { export: true });
    expect(second.details.reportPath).not.toBe(first.details.reportPath);
    // Two renders over the same committed state produce the same report bytes.
    expect(await finalReport(second)).toBe(await finalReport(first));
    const report = await finalReport(first);
    expect(report).toContain('## Campaign');
    expect(report).toContain('## Research debt at stop');
    expect(report).not.toContain('### Why the run stopped');
    // Nothing was torn down or ended by either export.
    expect((await h.call('p2o_board', { board: 'tasks' })).details.total).toBeGreaterThan(0);
  }));

  it('leaves a run with no campaign exactly as before: no refusal and no campaign.partial', async () => fixture(async h => {
    await populate(h);
    const result = await h.call('p2o_finish', {});
    expect(result.details.reportPath).toMatch(/-final$/);
    expect(result.details.state).toBe('incomplete');
    const report = await finalReport(result);
    expect(report).not.toContain('## Campaign');
    expect(report).not.toContain('### Why the run stopped');
    const store = await h.reader();
    try { expect(store.campaign()).toBeUndefined(); expect(store.campaignPartial()).toBeUndefined(); } finally { store.close(); }
  }));

  it('counts automatic wakes by reason and campaign partial stops from the ledger, never from prose', () => {
    const lifecycle = (at: string, text: string, data: Record<string, unknown>): AssessmentRecord => ({ at, runId: 'run-campaign', by: 'owner', kind: 'lifecycle', text, data } as AssessmentRecord);
    const rows = [
      lifecycle('2026-01-01T00:00:01.000Z', 'planner.wake: debt round 2', { engine: { event: 'planner.wake', reason: 'debt', round: 2 } }),
      lifecycle('2026-01-01T00:00:02.000Z', 'planner.wake: heartbeat round 3', { engine: { event: 'planner.wake', reason: 'heartbeat', round: 3 } }),
      lifecycle('2026-01-01T00:00:03.000Z', 'planner.wake: event round 4', { engine: { event: 'planner.wake', reason: 'event', round: 4 } }),
      lifecycle('2026-01-01T00:00:04.000Z', 'campaign.partial: the fixture stop', { event: 'campaign.partial', campaignPartial: 'the fixture stop' }),
      // A row that merely mentions a campaign stop in prose is not a recorded partial stop.
      lifecycle('2026-01-01T00:00:05.000Z', 'campaign.partial mentioned in passing', {}),
    ];
    expect(authorityCounters(indexRecords(rows, 'run-campaign'))).toMatchObject({ debtWakes: 1, heartbeatWakes: 1, campaignPartial: 1 });
  });
});
