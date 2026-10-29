import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * S1/A1: the surface audit pins what each role is actually given and that a tool's own text never points at a tool its
 * holding role cannot call. It registers the real extension against a stub Pi API (scripts/audit-surface.mjs), so the
 * text it scans is the final description with its boundary lines, not the authoring string. Never starts a run or a model.
 *
 * The declaration totals are a floor for tranches A and B of planning_update.md S1: the budget may fall, never rise,
 * until the C re-pin.
 */
const root = resolve(import.meta.dirname, '../..');
const BASELINE = { planner: 49_294, worker: 42_808, validation: 42_000, reporting: 6_551 };

describe('scripts/audit-surface.mjs', () => {
  it('gives every role only tools it holds and keeps every declaration total at or under its S1 baseline', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/audit-surface.mjs', '--json'], { cwd: root, timeout: 150_000, maxBuffer: 8 * 1024 * 1024 });
    const report = JSON.parse(stdout.slice(stdout.indexOf('{')));

    // A registered tool named in a role's own tool text but missing from its loadout is a guaranteed blocked call.
    expect(report.contradictions, 'tool text names a tool its holder role cannot call').toEqual([]);

    // The counts every authority/board test relies on: 35 registered (33 model-visible + 2 hidden legacy verbs), 12 verbs.
    expect(report.counts).toEqual({ registered: 35, modelVisible: 33, hidden: 2, boardVerbs: 12, planner: 22 });

    // The hidden legacy verbs are registered but in no role loadout (B10 later deletes them; this pin moves with it).
    for (const hidden of ['p2o_delegate', 'p2o_task_start']) {
      const tool = report.tools.find((item: { name: string }) => item.name === hidden);
      expect(tool, `${hidden} must stay registered`).toBeTruthy();
      expect(tool.holders, `${hidden} must be in no role loadout`).toEqual([]);
    }

    // Tranches A and B may shrink declarations, never grow them past the audited baseline.
    for (const [role, ceiling] of Object.entries(BASELINE)) {
      expect(report.roleTotals[role].chars, `${role} declares more than its S1 baseline`).toBeLessThanOrEqual(ceiling);
      expect(report.roleTotals[role].tools, role).toBeGreaterThan(0);
    }
  }, 200_000);
});
