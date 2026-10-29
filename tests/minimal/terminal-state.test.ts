import { describe, expect, it } from 'vitest';
import { terminalCounts, terminalState } from '../../src/tasks.js';
import { summarizeSituation, situationLine } from '../../src/situation.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * planning_update.md P10: how a task ended is a closed vocabulary, not a free-text reason. ARTEX's taxonomy is the model
 * (`server/engine.go:1135-1145`): "hit the step ceiling" is not "finished". `AssessmentTask.outcome` already holds the human
 * reason for a transition, so it cannot double as the taxonomy — the state is derived from the record alone.
 */
describe('one terminal state per settled task (P10)', () => {
  it('derives done / exhausted / blocked / stopped from the status and leaves open work unstated', () => {
    expect(terminalState({ status: 'reviewed' })).toBe('done');
    expect(terminalState({ status: 'closed' })).toBe('done');
    expect(terminalState({ status: 'expired' })).toBe('exhausted');
    expect(terminalState({ status: 'blocked' })).toBe('blocked');
    expect(terminalState({ status: 'cancelled' })).toBe('stopped');
    // Open work is deliberately not a terminal state: the situation line counts it separately as open/running/ready.
    for (const status of ['proposed', 'reserved', 'running', 'reported']) expect(terminalState({ status })).toBeUndefined();
    // The free-text reason never decides the state.
    expect(terminalState({ status: 'closed', outcome: 'ran out of commands' })).toBe('done');
  });

  it('never reads a command allowance into the state, because a run has none', () => {
    // Owner decision 2026-10-24: `exhausted` means the lease expired before the task reported, never "ran out of commands".
    expect(terminalState({ status: 'blocked' })).toBe('blocked');
    expect(terminalState({ status: 'cancelled' })).toBe('stopped');
    expect(terminalState({ status: 'expired' })).toBe('exhausted');
    expect(terminalState({ status: 'reviewed' })).toBe('done');
  });

  it('counts each task exactly once', () => {
    const tasks = [{ status: 'proposed' }, { id: 'a', status: 'closed' }, { id: 'b', status: 'expired' }, { id: 'c', status: 'blocked' }, { id: 'd', status: 'cancelled' }, { id: 'e', status: 'running' }];
    expect(terminalCounts(tasks)).toEqual({ done: 1, exhausted: 1, blocked: 1, stopped: 1 });
    expect(terminalCounts(tasks)).toEqual({ done: 1, exhausted: 1, blocked: 1, stopped: 1 });
  });

  it('renders exhausted next to the work and keeps it out of the blocked count', () => {
    const tasks = [
      { id: 't1', status: 'blocked', role: 'discovery', assignee: 'worker-a', prerequisites: [] },
      { id: 't2', status: 'expired', role: 'discovery', assignee: 'worker-b', prerequisites: [] },
      { id: 't3', status: 'closed', role: 'validation', prerequisites: [] },
    ];
    const snapshot = summarizeSituation({ tasks, cases: [], coverage: [], claims: [] } as never);
    // `expired` is settled, so `open` counts only the blocked task; only the expired one reads as exhausted.
    expect(snapshot).toMatchObject({ exhausted: 1, blocked: 1, open: 1 });
    expect(situationLine(snapshot)).toContain('1 exhausted');
    expect(situationLine(snapshot)).toContain('1 blocked');
  });

  it('carries the state in the task list projection', async () => fixture(async h => {
    const built = await populate(h); // its task is reviewed, so it must read as done rather than merely settled
    const list: any = (await h.call('p2o_board', { board: 'tasks' })).details;
    const row = list.tasks.find((entry: any) => entry.id === built.task.id);
    expect(row).toMatchObject({ status: 'reviewed', terminal: 'done' });
    // An open task states no terminal state at all, so an empty field cannot be read as "done".
    const created: any = (await h.call('p2o_task_author', {entry: { role: 'recon', surface: '/projection', risk: 'recon', question: 'Second bounded mapping question for the projection', expectedTrue: 'A surface list', expectedFalse: 'No surface', stopCondition: 'One review', roleReason: 'Mapping needs a recon worker', methodReason: 'Reading routes is the smallest mapping method', prerequisites: [], evidenceIds: [] } })).details;
    const after: any = (await h.call('p2o_board', { board: 'tasks' })).details;
    expect(after.tasks.find((entry: any) => entry.id === created.id).terminal).toBeUndefined();
  }));
});
