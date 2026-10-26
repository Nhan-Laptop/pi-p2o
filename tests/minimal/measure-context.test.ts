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

    for (const [label, item] of Object.entries<any>(report.lead)) expect(item.toolNames, label).toEqual([]);

    // Workers: six roles on two target kinds (P14.4 added `exploit`); the recon contract once; no tool outside the role's loadout.
    expect(report.workers).toHaveLength(12);
    for (const worker of report.workers) { expect(worker.reconBlocks, `${worker.role}/${worker.kind}`).toBe(1); expect(worker.toolNamesOutsideLoadout, `${worker.role}/${worker.kind}`).toEqual([]); expect(worker.total).toBe(worker.system + worker.brief); }

    // Declarations: 35 registered tools (L1/W2: four board bags became 16 verbs; A3 removed the two coverage-cell verbs) and the three loadouts of workflow-policy.test.ts.
    expect(report.declarations.registered, 'L1/W2 board verbs').toBe(35);
    expect(Object.fromEntries(Object.entries<any>(report.declarations.loadouts).map(([label, item]) => [label, item.tools]))).toEqual({ planner: 23, worker: 17, 'reporting worker': 6 });
    // Skills: the lead pages through the catalog and each role has a default skill whose first page is inlined.
    expect(report.skills.listPages.length).toBeGreaterThanOrEqual(3); expect(report.skills.listTotal).toBe(report.skills.listPages.reduce((sum: number, n: number) => sum + n, 0));
    // P15 (W5): validation and reporting ship no default method skill, so only the two role defaults with a skill appear here.
    expect(Object.keys(report.skills.roleDefaults).sort()).toEqual(['discovery', 'recon']);
  }, 200_000);
});
