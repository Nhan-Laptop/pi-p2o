import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import {
  AUTHORING_VERBS, BOARD_VERB_NAMES, CASE_VERB_NAMES, COVERAGE_VERB_NAMES, PLAN_VERB_NAMES,
  TASK_VERB_NAMES, authoringAction,
} from '../../src/board-verbs.js';
import { MODEL_TOOLS, PLANNER_TOOLS, REPORTER_TOOLS, VALIDATION_TOOLS, WORKER_TOOLS, workerTools } from '../../src/tool-policy.js';
import { TOOL_BOUNDARIES } from '../../src/tool-guidelines.js';
import { createFakePi, EXTENSION_PATH } from './helpers/fake-pi.js';
import { fixture, seedImpactGoal } from './helpers/report-fixture.js';

const WORKER_LOADOUT = [
  'p2o_skill_list', 'p2o_skill_read', 'p2o_secret', 'p2o_research', 'p2o_candidate', 'p2o_lab', 'p2o_shell', 'p2o_net', 'p2o_http',
  'p2o_capture', 'p2o_session', 'p2o_note', 'p2o_surface', 'p2o_ledger', 'p2o_state', 'p2o_graph', 'p2o_artifact', 'p2o_request_subtask', 'p2o_report',
];

/** A removal guard that fails for either a removed action bag or the old solo vocabulary. */
function parityViolations(names: readonly string[], prose: string): string[] {
  const found = names.filter(name => /^(p2o_task|p2o_case|p2o_coverage|p2o_plan)$/.test(name));
  if (/\bsolo\b/i.test(prose)) found.push('solo');
  if (/\bp2o_(task|case|coverage|plan)\b/.test(prose)) found.push('removed action bag');
  return [...new Set(found)];
}

describe('L1/W2 board verbs', () => {
  it('composes 10 verbs from 4 bags and keeps every authoring pair on one verb', () => {
    expect(TASK_VERB_NAMES).toHaveLength(3);
    expect(CASE_VERB_NAMES).toHaveLength(3);
    expect(COVERAGE_VERB_NAMES).toHaveLength(2);
    expect(PLAN_VERB_NAMES).toHaveLength(1);
    expect(BOARD_VERB_NAMES).toHaveLength(10);
    expect(new Set(BOARD_VERB_NAMES).size).toBe(10);

    // The authoring pairs share one verb each: the identity picks create or revise, never a second action field.
    for (const verb of Object.values(AUTHORING_VERBS)) expect(BOARD_VERB_NAMES).toContain(verb);
    // S1/B10 deleted the hidden task-start verb, so the one delegation path is author -> dispatch -> review.
    expect(TASK_VERB_NAMES).toEqual([AUTHORING_VERBS.task, 'p2o_task_dispatch', 'p2o_task_review']);
    expect(BOARD_VERB_NAMES).not.toContain('p2o_task_start');
  });

  it('derives create from no identity and revise from id+revision, refusing a half identity with the legal verb', () => {
    expect(authoringAction('task', {})).toBe('create');
    expect(authoringAction('plan', { id: 'plan-1', revision: 2 })).toBe('revise');
    // A second action field is host-owned: the identity picks the action, so an injected one is refused rather than ignored.
    expect(() => authoringAction('task', { id: 'task-1', revision: 1, action: 'create' })).toThrow(/host-owned/);
    // revision without id: create takes no revision, so the refusal names the id/revision pair the verb expects.
    expect(() => authoringAction('task', { revision: 2 })).toThrow(/^INVALID_INPUT: p2o_task_author got revision=2 without an id/);
    expect(() => authoringAction('task', { revision: 2 })).toThrow(/id=<task id> with revision=<currentRevision>/);
    // id without revision: the refusal names the board read that yields the revision and the merged verb that takes it.
    for (const [kind, verb] of [['task', 'p2o_task_author'], ['case', 'p2o_case_author'], ['plan', 'p2o_goal_author']] as const) {
      expect(() => authoringAction(kind, { id: `${kind}-1` })).toThrow(new RegExp(`^INVALID_INPUT: ${verb} got id=${kind}-1 without a usable revision`));
      expect(() => authoringAction(kind, { id: `${kind}-1` })).toThrow(new RegExp(`p2o_board board=${kind}s id=${kind}-1`));
    }
  });

  it('pins the planner surface and keeps the worker loadout unchanged (P0/A1)', () => {
    // A1: the planner plans, reviews and proves; it holds no target, lab, claim, note, surface, report or removed verb.
    expect(new Set(PLANNER_TOOLS)).toEqual(new Set([
      'p2o_task_author', 'p2o_task_dispatch', 'p2o_task_review',
      'p2o_goal_author', 'p2o_case_author', 'p2o_case_rate', 'p2o_case_retest',
      'p2o_coverage_plan', 'p2o_wstg_suggest', 'p2o_board', 'p2o_ledger', 'p2o_state', 'p2o_artifact', 'p2o_graph',
      'p2o_skill_list', 'p2o_skill_read', 'p2o_secret', 'p2o_research', 'p2o_workers', 'p2o_loop', 'p2o_finish',
    ]));
    expect(workerTools('discovery')).toEqual(WORKER_LOADOUT);
    expect(workerTools('general')).toEqual(WORKER_LOADOUT);
    expect(WORKER_TOOLS).toEqual(WORKER_LOADOUT);
    expect(workerTools('validation')).toEqual(WORKER_LOADOUT.filter(name => name !== 'p2o_surface'));
    expect(new Set(workerTools('reporting'))).toEqual(new Set(REPORTER_TOOLS));
    expect(PLANNER_TOOLS).toHaveLength(21);
    expect(WORKER_TOOLS).toHaveLength(19);
    expect(VALIDATION_TOOLS).toHaveLength(18);
    expect(REPORTER_TOOLS).toHaveLength(6);
    expect(MODEL_TOOLS).toHaveLength(32);
    for (const name of ['p2o_task', 'p2o_case', 'p2o_coverage', 'p2o_plan']) expect(MODEL_TOOLS).not.toContain(name);

    const pi = createFakePi();
    registerP2O(pi.pi, { extensionPath: EXTENSION_PATH });
    // S1/B10: registration and model visibility are the same surface, so the registered set is the declared model set.
    expect([...pi.tools.keys()].sort()).toEqual([...MODEL_TOOLS].sort());
    for (const name of Object.keys(TOOL_BOUNDARIES)) expect(MODEL_TOOLS, name).toContain(name);
    for (const name of ['p2o_delegate', 'p2o_task_start']) expect(TOOL_BOUNDARIES[name], name).toBeUndefined();
  });

  it('returns the held revision and the legal next verb for a stale revision', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const entry = { kind: 'goal', title: 'L1 stale revision fixture', status: 'active', reason: 'Explicit local fixture with no target execution', criteria: ['Owner must review the retained limitations'], proof: { kind: 'capability', capability: { kind: 'http.request', subject: 'fixture' } } };
      const plan = (await h.call('p2o_goal_author', { entry, requestId: 'board-verbs-plan' })).details;
      await expect(h.call('p2o_goal_author', { id: plan.id, revision: plan.revision + 5, entry: { ...entry, title: 'L1 stale revision fixture revised' } }))
        .rejects.toThrow(new RegExp(`currentRevision=${plan.revision}.*legalNext=p2o_goal_author`));
    });
  });


  it('names the current plan revision when a coverage cell is created against a stale plan', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const planInput = { title: 'Stale cell plan hint', status: 'active', reason: 'One explicit local denominator for the cell hint', exclusions: [], unknownScope: [] };
      const plan = (await h.call('p2o_coverage_plan', { plan: planInput })).details;
      // A3: there is no cell write verb, so the stale-revision hint is pinned on the plan write that does exist.
      await expect(h.call('p2o_coverage_plan', { id: plan.id, revision: plan.revision + 5, plan: { ...planInput, title: 'Stale cell plan hint revised' } }))
        .rejects.toThrow(new RegExp(`currentRevision=${plan.revision}.*legalNext=p2o_coverage_plan \\(id=${plan.id}, revision=${plan.revision}\\)`));
      // The host derives the denominator from reviewed work; a model-authored cell verb is not registered at all.
      for (const name of ['p2o_coverage_cell', 'p2o_coverage_cell_retire']) expect(h.pi.tools.has(name), name).toBe(false);
    });
  });

  it('routes settle and coverage authoring through their verb actions', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      await seedImpactGoal(h);
      const draft = { question: 'Does the board verb fixture settle one task?', surface: '/board-verb-fixture', risk: 'coordination', role: 'general', roleReason: 'Bounded local fixture with no target work', expectedTrue: 'The settle verb reaches the cancelled transition', expectedFalse: 'The action bag is required again', stopCondition: 'Stop after one local transition', evidenceIds: [], prerequisites: [], skills: [], methodReason: 'No target or model work' };
      const task = (await h.call('p2o_task_author', { draft })).details;
      const settled = (await h.call('p2o_task_review', { outcome: 'cancelled', id: task.id, revision: task.revision, reason: 'Owner cancelled the local board-verb fixture' })).details;
      expect(settled).toMatchObject({ id: task.id, status: 'cancelled' });

      const planInput = { title: 'Board verb coverage fixture', status: 'active', reason: 'One explicit local denominator for the verb fixture', exclusions: [], unknownScope: [] };
      const plan = (await h.call('p2o_coverage_plan', { plan: planInput, requestId: 'board-verb-coverage' })).details;
      const revised = (await h.call('p2o_coverage_plan', { plan: { ...planInput, title: 'Board verb coverage fixture revised' }, id: plan.id, revision: plan.revision })).details;
      expect(revised).toMatchObject({ id: plan.id, revision: plan.revision + 1 });
    });
  });

  it('parity fails on a removed tool or solo wording and is clean for the active surface', async () => {
    expect(parityViolations(['p2o_task'], '')).toContain('p2o_task');
    expect(parityViolations([], 'solo mode')).toContain('solo');
    expect(parityViolations([], 'p2o_task action=create')).toContain('removed action bag');

    const pi = createFakePi();
    registerP2O(pi.pi, { extensionPath: EXTENSION_PATH });
    const descriptions = [...pi.tools.values()].map(tool => tool.description).join('\n');
    const prompts = await readFile(resolve(import.meta.dirname, '../../src/prompts.ts'), 'utf8');
    expect(parityViolations(MODEL_TOOLS, descriptions)).toEqual([]);
    expect(parityViolations(MODEL_TOOLS, prompts)).toEqual([]);
    for (const name of ['p2o_delegate', 'p2o_task_start']) { expect(pi.tools.has(name), name).toBe(false); expect(prompts, name).not.toContain(name); }
    // A3 deleted the model-authored coverage-cell verbs: they are neither registered nor mentioned in the prompt surface.
    for (const name of ['p2o_coverage_cell', 'p2o_coverage_cell_retire']) { expect(pi.tools.has(name), name).toBe(false); expect(prompts, name).not.toContain(name); }
  });
});
