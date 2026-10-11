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

    // Lead prompts: solo variants stay under the pinned 5,000; delegated ones under their recorded ceilings; none names a tool.
    expect(report.lead['solo directory'].chars).toBeLessThan(5000); expect(report.lead['solo url'].chars).toBeLessThan(5000);
    expect(report.lead['delegated directory'].chars).toBeLessThanOrEqual(5326); expect(report.lead['delegated url'].chars).toBeLessThanOrEqual(5480); expect(report.lead['delegated url event-driven'].chars).toBeLessThanOrEqual(5730);
    for (const [label, item] of Object.entries<any>(report.lead)) expect(item.toolNames, label).toEqual([]);

    // Workers: five roles on two target kinds; the recon contract once; no tool outside the role's loadout.
    expect(report.workers).toHaveLength(10);
    for (const worker of report.workers) { expect(worker.reconBlocks, `${worker.role}/${worker.kind}`).toBe(1); expect(worker.toolNamesOutsideLoadout, `${worker.role}/${worker.kind}`).toEqual([]); expect(worker.total).toBe(worker.system + worker.brief); }

    // Declarations: 24 registered tools and the four loadouts of workflow-policy.test.ts.
    expect(report.declarations.registered).toBe(24);
    expect(Object.fromEntries(Object.entries<any>(report.declarations.loadouts).map(([label, item]) => [label, item.tools]))).toEqual({ 'delegated Planner': 18, 'solo owner': 18, worker: 14, 'reporting worker': 9 });
    expect(report.declarations.loadouts['solo owner'].bytes).toBeLessThanOrEqual(Math.ceil(38_355 * 1.02)); // raised on purpose from 36,967 by the rate/suggest/narrative additions (workflow-policy.test.ts)

    // Skills: the lead pages through the catalog and each role has a default skill whose first page is inlined.
    expect(report.skills.listPages.length).toBeGreaterThanOrEqual(3); expect(report.skills.listTotal).toBe(report.skills.listPages.reduce((sum: number, n: number) => sum + n, 0));
    expect(Object.keys(report.skills.roleDefaults).sort()).toEqual(['discovery', 'recon', 'reporting', 'validation']);
  }, 200_000);
});
