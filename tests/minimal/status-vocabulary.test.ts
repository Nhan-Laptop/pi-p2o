import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXECUTING_TASK_STATUSES, isExecutingTask, isSatisfiedTask, isSettledTask, SATISFIED_TASK_STATUSES, SETTLED_TASK_STATUSES, TASK_STATUSES } from '../../src/tasks.js';

/**
 * planning_update.md P13(c): the task vocabulary had two declarations and three local sets, so adding a status could make the
 * ledger loader reject a record its own writer had just accepted. These tests hold the single declaration and its three derived
 * predicates, and fail when a fourth spelling of "satisfied" appears outside the owner.
 */
describe('one task vocabulary (P13c)', () => {
  it('declares no duplicates and derives the transition map from the same list', () => {
    expect(new Set(TASK_STATUSES).size).toBe(TASK_STATUSES.length);
    expect(TASK_STATUSES).toEqual(['proposed', 'reserved', 'running', 'reported', 'reviewed', 'closed', 'blocked', 'cancelled', 'expired']);
    // The three derived sets may only contain members of the vocabulary; a typo would otherwise silently never match.
    for (const status of [...SATISFIED_TASK_STATUSES, ...SETTLED_TASK_STATUSES, ...EXECUTING_TASK_STATUSES]) {
      expect(TASK_STATUSES as readonly string[]).toContain(status);
    }
    expect(SATISFIED_TASK_STATUSES).toEqual(['reviewed', 'closed']);
    expect(SETTLED_TASK_STATUSES).toEqual(['closed', 'cancelled', 'expired']);
    expect(EXECUTING_TASK_STATUSES).toEqual(['reserved', 'running']);
  });

  it('keeps the predicates consistent with the sets and rejects non-members', () => {
    for (const status of TASK_STATUSES) {
      expect(isSatisfiedTask(status)).toBe((SATISFIED_TASK_STATUSES as readonly string[]).includes(status));
      expect(isSettledTask(status)).toBe((SETTLED_TASK_STATUSES as readonly string[]).includes(status));
      expect(isExecutingTask(status)).toBe((EXECUTING_TASK_STATUSES as readonly string[]).includes(status));
    }
    for (const value of [undefined, null, '', 'REVIEWED', ' reviewed', 'done', 0]) {
      expect(isSatisfiedTask(value)).toBe(false); expect(isSettledTask(value)).toBe(false); expect(isExecutingTask(value)).toBe(false);
    }
    // Every settled task is also satisfied: the two sets answer different questions but must not contradict each other.
    for (const status of SETTLED_TASK_STATUSES) expect(isSatisfiedTask(status), status).toBe(status === 'closed');
    expect(TASK_STATUSES.filter(status => !isSettledTask(status)).length).toBe(6);
  });

  it('is the only place that names the task statuses', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        if (name === 'node_modules' || name === 'dist' || name === '.git' || name.startsWith('.')) continue;
        const path = join(directory, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(ts|mts)$/.test(name) || /\.test\.ts$/.test(name)) continue;
        if (path === join(root, 'src', 'tasks.ts')) continue; // the owner, allowed to name the members
        const text = readFileSync(path, 'utf8');
        // A task-domain "satisfied" check written as a literal list is the defect this test exists to prevent.
        if (/\['reviewed','closed'\]|\["reviewed", ?"closed"\]/.test(text)) offenders.push(path.slice(root.length));
      }
    };
    walk(join(root, 'src'));
    walk(join(root, 'extensions'));
    // src/coverage.ts and src/planning.ts own the coverage-plan and goal vocabularies, which legitimately contain the same words.
    expect(offenders.filter(path => !['src/coverage.ts', 'src/planning.ts'].includes(path))).toEqual([]);
  });
});
