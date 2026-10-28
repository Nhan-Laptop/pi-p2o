import { describe, expect, it } from 'vitest';
import { claimHeadClaims } from '../../src/chain-view.js';
import { completionDemand, completionLine, deriveCompletion } from '../../src/completion.js';
import { debtFor, debtSummary, deriveDebt, isDebtId, type DebtInput } from '../../src/debt.js';
import { finishPreflight } from '../../src/finish-preflight.js';
import { planFrontier } from '../../src/planning.js';
import { indexRecords, type AssessmentRecord } from '../../src/records.js';
import { taskFrontier } from '../../src/tasks.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * P5/A6.2 (planning_update.md §4): research debt is derived from committed state, bounded, and discharged by a record.
 * The fixture reuses the report harness, which produces the observed campaign shape: reviewed work, a post-hoc coverage
 * plan, one open gap nobody referenced and one demonstrated primitive with no successor. Hermetic: no model, no target.
 */

/** Read the live ledger once, derive the debt report and the two consumers that must agree with it, then close the store. */
async function inspect(h: any, extra: Partial<DebtInput> = {}) {
  const store = await h.reader();
  try {
    const index = indexRecords(store.records(), await h.runId());
    const { coverage, cases } = store.reviewContext();
    const featureAssets = store.recordedFeatureAssets();
    const report = deriveDebt(index, { coverage, cases, features: store.recordedFeatureValues(), ...(featureAssets.length ? { featureAssets } : {}), ...extra });
    const completion = deriveCompletion({ plans: planFrontier(index), claims: claimHeadClaims(index), tasks: taskFrontier(index), debt: debtFor(report) });
    const preflight = finishPreflight(index, { coverage, cases, debt: report });
    return { report, completion, preflight, kinds: new Set(report.items.map(item => item.kind)) };
  } finally { store.close(); }
}

const items = (report: ReturnType<typeof deriveDebt>, kind: string) => report.items.filter(item => item.kind === kind);

describe('research debt (A6.2)', () => {
  it('names the observed campaign debt: a post-hoc denominator, unrun cells, an unreferenced gap and an unchained primitive', async () => fixture(async h => {
    await populate(h);
    const { report, kinds } = await inspect(h);
    // The fixture records its coverage plan after the reviewed work, exactly like the 2026-10-26 run did at 03:59:54.
    expect(kinds.has('PLAN_MISSING')).toBe(true);
    expect(items(report, 'PLAN_MISSING')[0]!.detail).toMatch(/after the last reviewed task/);
    expect(items(report, 'CELL_NOT_RUN').length).toBeGreaterThan(0);
    expect(items(report, 'GAP_UNTRIAGED')).toHaveLength(1);
    expect(items(report, 'PRIMITIVE_UNCHAINED')).toHaveLength(1);
    // Advisory, never gateable: mapped work with no feature tag means applicable WSTG tests cannot be derived.
    expect(kinds.has('FEATURES_MISSING')).toBe(true);
    expect(report.items.find(item => item.kind === 'FEATURES_MISSING')!.gateable).toBe(false);
    expect(report.gateable).toBeGreaterThan(0);
    expect(debtSummary(report)).toMatch(/research debt item\(s\)/);
  }));

  it('derives the campaign frame kinds only when a campaign was promised or recorded', async () => {
    await fixture(async h => {
      await populate(h);
      const batch = await inspect(h);
      expect(batch.kinds.has('CAMPAIGN_MISSING')).toBe(false);
      // A3/D32: the populated fixture now carries the reviewed impact goal, so a recorded campaign has a goal to name.
      expect(batch.kinds.has('GOAL_MISSING')).toBe(false);
      const promised = await inspect(h, { expectCampaign: true });
      expect(promised.kinds.has('CAMPAIGN_MISSING')).toBe(true);
    });
    // 2026-10-27 (A3/D32): GOAL_MISSING needs a run with no plan goal at all, so this half starts its own fixture instead of
    // populating one; a campaign objective with nothing on the goal board is exactly the frame kind under test.
    await fixture(async h => {
      await h.command('--target ./source');
      const campaign = await inspect(h, { expectCampaign: true, campaign: { objective: 'Assess the fixture endpoint without changing state' } });
      expect(campaign.kinds.has('CAMPAIGN_MISSING')).toBe(false);
      expect(campaign.kinds.has('GOAL_MISSING')).toBe(true);
      expect(items(campaign.report, 'GOAL_MISSING')[0]!.detail).toContain('no goal on the plan board');
    });
  });

  it('keeps ids stable, formatted and bounded while totals stay true', async () => fixture(async h => {
    await populate(h);
    const first = await inspect(h), second = await inspect(h);
    expect(first.report.ids).toEqual(second.report.ids);
    expect(first.report.ids.every(isDebtId)).toBe(true);
    expect(first.report.items.length).toBeLessThanOrEqual(5 * 13);
    expect(first.report.gateable + (first.report.total - first.report.gateable)).toBe(first.report.total);
    // Every shown item's id is in the uncapped id list, and the cap only hides ids, never invents them.
    for (const item of first.report.items) expect(first.report.ids).toContain(item.id);
  }));

  it('discharges an item through a deferred todo that cites it, and only through that', async () => fixture(async h => {
    await populate(h);
    const before = await inspect(h);
    const primitive = items(before.report, 'PRIMITIVE_UNCHAINED')[0]!;
    await h.call('p2o_plan_author', {
      entry: {
        kind: 'todo', title: 'Take the demonstrated primitive to a successor step', status: 'deferred',
        reason: 'The successor needs a human-provided credential that the operator has not granted yet, so the link is deferred rather than dropped',
        debtRefs: [primitive.id],
      },
    });
    const after = await inspect(h);
    expect(after.report.ids).not.toContain(primitive.id);
    expect(items(after.report, 'PRIMITIVE_UNCHAINED')).toHaveLength(0);
    // The open gap is untouched: one wall discharges one named item, not the whole report.
    expect(after.report.ids.length).toBeGreaterThan(0);
  }));

  it('refuses a decision row in place of a wall and leaves the debt open', async () => fixture(async h => {
    await populate(h);
    const before = await inspect(h);
    const primitive = items(before.report, 'PRIMITIVE_UNCHAINED')[0]!;
    // The observed failure at 04:00:41: a decision row recorded and the obligation stayed open.
    await expect(h.call('p2o_plan_author', {
      entry: {
        kind: 'decision', title: 'Defer the primitive successor until a credential arrives', status: 'recorded',
        reason: 'No successor step is warranted without the human credential the run asked for',
        decision: { disposition: 'defer', chosenTaskIds: [], deferredTaskIds: [], revisitCondition: 'A human grants the credential or narrows the asset' },
        debtRefs: [primitive.id],
      },
    })).rejects.toThrow(/Only a todo discharges research debt/);
    const after = await inspect(h);
    expect(after.report.ids).toContain(primitive.id);
  }));

  it('refuses an unknown id and a goal row, so neither a stale wall nor a goal can read as a discharge', async () => fixture(async h => {
    await populate(h);
    const stale = 'debt-gap-untriaged-000000000000';
    // A wall must cite an id the run currently owes: a stale or mistyped one would otherwise mark arbitrary work discharged.
    await expect(h.call('p2o_plan_author', {
      entry: { kind: 'todo', title: 'Wall for a stale debt id', status: 'deferred', reason: 'Ruled-out successor recorded for the fixture', debtRefs: [stale] },
    })).rejects.toThrow(/Unknown research debt/);
    // Only a todo holds a wall: the goal/decision link fields stay chain-only.
    await expect(h.call('p2o_plan_author', {
      entry: { kind: 'goal', title: 'A goal that pretends to wall work', status: 'proposed', reason: 'Fixture goal for the debtRefs refusal',
        criteria: ['bounded'], proof: { kind: 'case', ref: 'case-fixture' }, debtRefs: [stale] },
    })).rejects.toThrow(/Only a todo discharges research debt/);
  }));

  it('feeds completion and the finish preflight from the same report, so the two sentences agree', async () => fixture(async h => {
    await populate(h);
    const { report, completion, preflight } = await inspect(h);
    const completionDebt = completion.items.find(item => item.code === 'RESEARCH_DEBT');
    expect(completionDebt).toBeDefined();
    expect(completionDebt!.count).toBe(report.gateable);
    expect(completion.state).toBe('incomplete');
    expect(completionLine(completion)).toContain('RESEARCH_DEBT');
    expect(completionDemand(completion, [])).toMatch(/research debt item\(s\) with no discharge/);
    const listed = preflight.advisory.find(item => item.code === 'RESEARCH_DEBT');
    expect(listed).toBeDefined();
    expect(listed!.count).toBe(report.gateable);
    // It is named, not enforced: the finish path never refuses because of debt.
    expect(preflight.obligations.some(item => item.code === 'RESEARCH_DEBT')).toBe(false);
  }));

  it('names the WSTG tests the per-asset recorded features make applicable (A6.4 matrix)', async () => fixture(async h => {
    await populate(h);
    await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /feature-fixture', attributes: { feature: 'cors, api' } } }] } });
    // `cors` triggers a browser-transport row (flags B). P11/A11: the shipped run carries that transport, so the default read
    // includes it instead of needing a caller grant.
    const { report } = await inspect(h);
    const rows = items(report, 'WSTG_UNPLANNED');
    // The matrix names the specific rows a recorded feature triggers, not a generic "more tests" hint.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(item => item.subject.startsWith('wstg-clnt-'))).toBe(true);
    expect(rows.some(item => item.subject.startsWith('wstg-apit-'))).toBe(true);
    expect(rows.every(item => /applies to recorded feature\(s\) on \d+ asset/.test(item.detail))).toBe(true);
  }));

  it('counts the browser and identity rows in the shipped matrix without a caller grant (P11/A11)', async () => fixture(async h => {
    await populate(h);
    await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /autonomy-fixture', attributes: { feature: 'cors, api' } } }] } });
    const full = items((await inspect(h)).report, 'WSTG_UNPLANNED').map(item => item.subject);
    // B row (cors) and I row (api,roles) are owed work out of the box: the image installs the browser and a worker provisions
    // its own principal, so neither flag is a reason to drop the row from the denominator.
    expect(full).toContain('wstg-clnt-07');
    expect(full).toContain('wstg-apit-04');
    // An explicit `false` still reduces the denominator for a caller that genuinely lacks the capability.
    expect(items((await inspect(h, { browser: false })).report, 'WSTG_UNPLANNED').map(item => item.subject)).not.toContain('wstg-clnt-07');
    expect(items((await inspect(h, { identity: false })).report, 'WSTG_UNPLANNED').map(item => item.subject)).not.toContain('wstg-apit-04');
  }));

  it('names a discovered asset that no derived cell covers', async () => fixture(async h => {
    await populate(h);
    await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /unplanned' } }] } });
    const { report } = await inspect(h);
    expect(items(report, 'SCOPE_UNPLANNED_ASSET')).toHaveLength(1);
    expect(items(report, 'SCOPE_UNPLANNED_ASSET')[0]!.detail).toMatch(/no derived coverage cell/);
  }));

  it('records the observed run\'s 25 unreferenced gaps as gateable debt while the shown page caps at five', () => {
    // The 2026-10-26 run closed with 26 gaps, 25 of them referenced by no plan row and no case (tmp/p2o-logs/session-postmortem.md).
    // The regression is that they were a passive count; A6.2 makes each one an obligation with a stable id.
    const rows: AssessmentRecord[] = Array.from({ length: 25 }, (_, index) => ({
      id: `gap-observed-${String(index + 1).padStart(2, '0')}`, runId: 'run-observed',
      at: `2026-10-26T04:00:${String(index).padStart(2, '0')}.000Z`, by: 'worker-a', workerId: 'worker-a',
      kind: 'open', text: `unreferenced gap ${index + 1}`,
    } as AssessmentRecord));
    const report = deriveDebt(indexRecords(rows, 'run-observed'), { coverage: { targetRevision: () => 'rev-observed', assetIds: () => [] }, cases: {} });
    expect(report.totals.GAP_UNTRIAGED).toBe(25);
    const shown = report.items.filter(item => item.kind === 'GAP_UNTRIAGED');
    expect(shown).toHaveLength(5); // bounded page, not a bounded obligation
    expect(shown.every(item => item.gateable && item.id.startsWith('debt-gap-untriaged-'))).toBe(true);
    expect(new Set(report.ids.filter(id => id.startsWith('debt-gap-untriaged-'))).size).toBe(25);
    expect(report.gateable).toBeGreaterThanOrEqual(25);
  });

  it('counts a worker hypothesis and an inferred relation as gateable review debt until the owner settles them (R1.4)', () => {
    const index = indexRecords([], 'run-graph-review');
    const report = deriveDebt(index, { graph: { hypotheses: [{ entityId: 'assertion-h1', assetId: 'asset-a1', statement: 'the admin path bypasses the gate' }], inferredRelations: 2 } });
    expect(report.totals.GRAPH_UNREVIEWED).toBe(2);
    const shown = report.items.filter(item => item.kind === 'GRAPH_UNREVIEWED');
    expect(shown.every(item => item.gateable && item.id.startsWith('debt-graph-unreviewed-'))).toBe(true);
    expect(shown[0]!.detail).toContain('the admin path bypasses the gate');
    expect(shown[1]!.detail).toContain('2 worker-inferred relation(s)');
    // Settled (or owner-authored) rows never reach the derivation: the store only passes current worker heads.
    expect(deriveDebt(index, { graph: { hypotheses: [], inferredRelations: 0 } }).totals.GRAPH_UNREVIEWED).toBe(0);
  });
});
