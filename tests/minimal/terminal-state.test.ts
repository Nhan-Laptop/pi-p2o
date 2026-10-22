import { describe, expect, it } from 'vitest';
import { terminalCounts, terminalState } from '../../src/tasks.js';
import { summarizeSituation, situationLine } from '../../src/situation.js';
import { fixture, populate } from './helpers/report-fixture.js';

/**
 * planning_update.md P10: how a task ended is a closed vocabulary, not a free-text reason. ARTEX's taxonomy is the model
 * (`server/engine.go:1135-1145`): "hit the step ceiling" is not "finished". `AssessmentTask.outcome` already holds the human
 * reason for a transition, so it cannot double as the taxonomy — the state is derived, and the two call sites supply the one
 * piece of evidence a task record does not carry (the worker's `budget-exhausted` progress outcome).
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

  it('turns a cut-short task into exhausted only when the budget evidence says so', () => {
    // A blocked task is something the lead can unblock; one whose allowance ran out is not. Same status, different next action.
    expect(terminalState({ status: 'blocked' }, { budgetExhausted: true })).toBe('exhausted');
    expect(terminalState({ status: 'blocked' }, { budgetExhausted: false })).toBe('blocked');
    expect(terminalState({ status: 'cancelled' }, { budgetExhausted: true })).toBe('exhausted');
    expect(terminalState({ status: 'cancelled' }, { budgetExhausted: false })).toBe('stopped');
    // A satisfied task stays done: reporting after the allowance ran out still answered the question.
    expect(terminalState({ status: 'reviewed' }, { budgetExhausted: true })).toBe('done');
  });

  it('counts each task exactly once', () => {
    const tasks = [{ status: 'proposed' }, { id: 'a', status: 'closed' }, { id: 'b', status: 'expired' }, { id: 'c', status: 'blocked' }, { id: 'd', status: 'cancelled' }, { id: 'e', status: 'running' }];
    expect(terminalCounts(tasks)).toEqual({ done: 1, exhausted: 1, blocked: 1, stopped: 1 });
    const counted = terminalCounts(tasks, task => (task as { id?: string }).id === 'c');
    expect(counted).toEqual({ done: 1, exhausted: 2, blocked: 0, stopped: 1 });
  });

  it('renders exhausted next to the work and keeps it out of the blocked count', () => {
    const tasks = [
      { id: 't1', status: 'blocked', role: 'discovery', assignee: 'worker-a', prerequisites: [] },
      { id: 't2', status: 'expired', role: 'discovery', assignee: 'worker-b', prerequisites: [] },
      { id: 't3', status: 'closed', role: 'validation', prerequisites: [] },
    ];
    const snapshot = summarizeSituation({ tasks, cases: [], coverage: [], claims: [], budgetExhausted: (task: { assignee?: string }) => task.assignee === 'worker-a' } as never);
    // `expired` is settled, so `open` counts only the blocked task; `exhausted` still counts both cut-short tasks.
    expect(snapshot).toMatchObject({ exhausted: 2, blocked: 0, open: 1 });
    expect(situationLine(snapshot)).toContain('2 exhausted');
    // Without the budget evidence the same records read as one blocked task and one expired one.
    const plain = summarizeSituation({ tasks, cases: [], coverage: [], claims: [] } as never);
    expect(plain).toMatchObject({ exhausted: 1, blocked: 1 });
    expect(situationLine(plain)).toContain('1 exhausted');
    expect(situationLine(plain)).toContain('1 blocked');
  });

  it('carries the state in the task list projection', async () => fixture(async h => {
    const built = await populate(h); // its task is reviewed, so it must read as done rather than merely settled
    const list: any = (await h.call('p2o_task', { action: 'list' })).details;
    const row = list.tasks.find((entry: any) => entry.id === built.task.id);
    expect(row).toMatchObject({ status: 'reviewed', terminal: 'done' });
    // An open task states no terminal state at all, so an empty field cannot be read as "done".
    const created: any = (await h.call('p2o_task', { action: 'create', draft: { role: 'recon', surface: '/projection', risk: 'recon', question: 'Second bounded mapping question for the projection', expectedTrue: 'A surface list', expectedFalse: 'No surface', stopCondition: 'One review', roleReason: 'Mapping needs a recon worker', methodReason: 'Reading routes is the smallest mapping method', prerequisites: [], evidenceIds: [] } })).details;
    const after: any = (await h.call('p2o_task', { action: 'list' })).details;
    expect(after.tasks.find((entry: any) => entry.id === created.id).terminal).toBeUndefined();
  }));
});
