import { LEAD_CEILINGS } from './helpers/budgets.js';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * The numbers in planning_update.md come from scripts/measure-context.mjs. This keeps that script working (it loads the real prompts, the real
 * tool registration and the real skill library from source) and keeps the invariants those documents rely on. It never starts a run, a model or a target.
 */
const root = resolve(import.meta.dirname, '../..');

describe('scripts/measure-context.mjs', () => {
  it('reports what each role receives and the invariants the plan relies on', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/measure-context.mjs', '--source', '--json'], { cwd: root, timeout: 150_000, maxBuffer: 4 * 1024 * 1024 });
    const report = JSON.parse(stdout.slice(stdout.indexOf('{')));

    // Lead prompts: solo variants stay under the pinned 5,300; delegated ones under their recorded ceilings; none names a tool.
    // 2026-10-21 (chain capability): the DELEGATION block gained one line on dispatching chain steps serially, so every lead ceiling and the solo-owner
    // declaration budget moved on purpose (measured 5,051 / 5,202 solo, 5,446 / 5,597 / 5,842 delegated, 35,423 declaration bytes).
    // 2026-10-22 (planning_update.md P2): the delegated DELEGATION block gained the validation contract, so only the three delegated ceilings moved
    // (measured 5,697 / 5,848 / 6,093; solo is unchanged because a solo owner has no validation worker to contract with), and the delegated
    // declaration budget grew with p2o_delegate's purpose line.
    expect(report.lead['solo directory'].chars).toBeLessThan(LEAD_CEILINGS.soloDirectory); expect(report.lead['solo url'].chars).toBeLessThan(LEAD_CEILINGS.soloUrl);
    expect(report.lead['delegated directory'].chars).toBeLessThanOrEqual(LEAD_CEILINGS.delegatedDirectory); expect(report.lead['delegated url'].chars).toBeLessThanOrEqual(LEAD_CEILINGS.delegatedUrl); expect(report.lead['delegated url event-driven'].chars).toBeLessThanOrEqual(LEAD_CEILINGS.delegatedEventDriven);
    for (const [label, item] of Object.entries<any>(report.lead)) expect(item.toolNames, label).toEqual([]);

    // Workers: five roles on two target kinds; the recon contract once; no tool outside the role's loadout.
    expect(report.workers).toHaveLength(10);
    for (const worker of report.workers) { expect(worker.reconBlocks, `${worker.role}/${worker.kind}`).toBe(1); expect(worker.toolNamesOutsideLoadout, `${worker.role}/${worker.kind}`).toEqual([]); expect(worker.total).toBe(worker.system + worker.brief); }

    // Declarations: 23 registered tools (p2o_steer/p2o_stop_worker folded into p2o_workers, S2) and the four loadouts of workflow-policy.test.ts.
    expect(report.declarations.registered).toBe(23);
    expect(Object.fromEntries(Object.entries<any>(report.declarations.loadouts).map(([label, item]) => [label, item.tools]))).toEqual({ 'delegated Planner': 17, 'solo owner': 19, worker: 15, 'reporting worker': 10 });
    expect(report.declarations.loadouts['solo owner'].bytes).toBeLessThanOrEqual(Math.ceil(35_423 * 1.02)); // 33,328 before p2o_surface, 34,162 before the chain line (workflow-policy.test.ts)
    // Skills: the lead pages through the catalog and each role has a default skill whose first page is inlined.
    expect(report.skills.listPages.length).toBeGreaterThanOrEqual(3); expect(report.skills.listTotal).toBe(report.skills.listPages.reduce((sum: number, n: number) => sum + n, 0));
    expect(Object.keys(report.skills.roleDefaults).sort()).toEqual(['discovery', 'recon', 'reporting', 'validation']);
  }, 200_000);
});
