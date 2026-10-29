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
const BASELINE = { planner: 47_800, worker: 41_900, validation: 41_100, reporting: 6_450 };

import { execFileSync } from 'node:child_process';

/**
 * S1/B9 (D-S1-8): the two misleading tool names were renamed. A repository-wide grep keeps them from creeping back into
 * code, tests or current docs; `docs/HISTORY.md` keeps the historical rows and planning_update.md records the decision.
 */
const OLD_NAMES = ['p2o_plan_author', 'p2o_coverage_suggest'];
const CURRENT_SOURCES = ['src', 'extensions', 'tests', 'scripts', 'skills', 'knowledge', 'docs/KNOWLEDGE.md', 'docs/USAGE.md', 'docs/ARCHITECTURE.md', 'docs/WSTG_MAP.md', 'docs/ACCEPTANCE_MATRIX.md', 'README.md'];

describe('S1/B9 tool renames', () => {
  it('keeps the two renamed tool names out of the current surface and docs', () => {
    for (const name of OLD_NAMES) {
      let hits = '';
      try { hits = execFileSync('grep', ['-rln', '--exclude=surface-audit.test.ts', name, ...CURRENT_SOURCES], { cwd: root, encoding: 'utf8' }).trim(); }
      catch (error: any) { hits = String(error?.stdout ?? '').trim(); }
      expect(hits, `${name} survived the rename in ${hits}`).toBe('');
    }
  });
});

describe('scripts/audit-surface.mjs', () => {
  it('gives every role only tools it holds and keeps every declaration total at or under its S1 baseline', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/audit-surface.mjs', '--json'], { cwd: root, timeout: 150_000, maxBuffer: 8 * 1024 * 1024 });
    const report = JSON.parse(stdout.slice(stdout.indexOf('{')));

    // A registered tool named in a role's own tool text but missing from its loadout is a guaranteed blocked call.
    expect(report.contradictions, 'tool text names a tool its holder role cannot call').toEqual([]);

    // S1/B10 and S1/C1: registration and model visibility are the same surface — 35 registered, all model-visible, 10 board
    // verbs, and the planner holds the two graph review/coordination verbs next to the shared read.
    expect(report.counts).toEqual({ registered: 35, modelVisible: 35, hidden: 0, boardVerbs: 10, planner: 23 });

    // Nothing is registered outside the role loadouts any more: the two hidden legacy verbs are deleted, not hidden.
    expect(report.tools.every((item: { holders: string[] }) => item.holders.length > 0), 'every registered tool is held by a role').toBe(true);
    for (const name of ['p2o_delegate', 'p2o_task_start']) expect(report.tools.some((item: { name: string }) => item.name === name), name).toBe(false);

    // Tranches A and B may shrink declarations, never grow them past the audited baseline.
    for (const [role, ceiling] of Object.entries(BASELINE)) {
      expect(report.roleTotals[role].chars, `${role} declares more than its S1 baseline`).toBeLessThanOrEqual(ceiling);
      expect(report.roleTotals[role].tools, role).toBeGreaterThan(0);
    }
  }, 200_000);
});
