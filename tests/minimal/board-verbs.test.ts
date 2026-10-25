import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import {
  BOARD_ACTION_VERBS, BOARD_VERB_NAMES, CASE_VERB_NAMES, COVERAGE_VERB_NAMES, PLAN_VERB_NAMES,
  TASK_VERB_NAMES,
} from '../../src/board-verbs.js';
import { ALL_TOOLS, OWNER_TOOLS, WORKER_TOOLS, workerTools } from '../../src/tool-policy.js';
import { TOOL_BOUNDARIES } from '../../src/tool-guidelines.js';
import { createFakePi, EXTENSION_PATH } from './helpers/fake-pi.js';
import { fixture } from './helpers/report-fixture.js';

const WORKER_LOADOUT = [
  'p2o_skill_list', 'p2o_skill_read', 'p2o_research', 'p2o_candidate', 'p2o_lab', 'p2o_shell', 'p2o_net', 'p2o_http',
  'p2o_capture', 'p2o_note', 'p2o_surface', 'p2o_ledger', 'p2o_state', 'p2o_graph', 'p2o_artifact', 'p2o_request_subtask', 'p2o_report',
];

/** A removal guard that fails for either a removed action bag or the old solo vocabulary. */
function parityViolations(names: readonly string[], prose: string): string[] {
  const found = names.filter(name => /^(p2o_task|p2o_case|p2o_coverage|p2o_plan)$/.test(name));
  if (/\bsolo\b/i.test(prose)) found.push('solo');
  if (/\bp2o_(task|case|coverage|plan)\b/.test(prose)) found.push('removed action bag');
  return [...new Set(found)];
}

describe('L1/W2 board verbs', () => {
  it('maps every old board action to one verb and composes 16 verbs from 4 bags', () => {
    expect(TASK_VERB_NAMES).toHaveLength(6);
    expect(CASE_VERB_NAMES).toHaveLength(3);
    expect(COVERAGE_VERB_NAMES).toHaveLength(4);
    expect(PLAN_VERB_NAMES).toHaveLength(2);
    expect(BOARD_VERB_NAMES).toHaveLength(16);
    expect(new Set(BOARD_VERB_NAMES).size).toBe(16);

    for (const [oldTool, actions] of Object.entries(BOARD_ACTION_VERBS)) for (const [action, verb] of Object.entries(actions)) {
      expect(verb, `${oldTool} ${action}`).not.toBeUndefined();
      if (verb !== null) expect(BOARD_VERB_NAMES, `${oldTool} ${action}`).toContain(verb);
    }
    expect(BOARD_ACTION_VERBS.p2o_task.match).toBe('p2o_board');
    expect(BOARD_ACTION_VERBS.p2o_task.start).toBe('p2o_task_start');
    expect(BOARD_ACTION_VERBS.p2o_case.view).toBe('p2o_board');
    expect(BOARD_ACTION_VERBS.p2o_coverage.suggest).toBe('p2o_coverage_suggest');
  });

  it('keeps the worker loadout unchanged while the owner surface becomes 35 active / 37 registered tools', () => {
    expect(OWNER_TOOLS).toHaveLength(35);
    expect(ALL_TOOLS).toHaveLength(37);
    expect(WORKER_TOOLS).toHaveLength(17);
    expect(workerTools('discovery')).toEqual(WORKER_LOADOUT);
    expect(workerTools('reporting')).toEqual(WORKER_LOADOUT);
    expect(WORKER_TOOLS).toEqual(WORKER_LOADOUT);
    expect(OWNER_TOOLS.filter(name => /^(p2o_task|p2o_case|p2o_coverage|p2o_plan)$/.test(name))).toEqual([]);

    const pi = createFakePi();
    registerP2O(pi.pi, { extensionPath: EXTENSION_PATH });
    expect([...pi.tools.keys()].sort()).toEqual([...ALL_TOOLS].sort());
    for (const name of Object.keys(TOOL_BOUNDARIES)) expect(pi.tools.get(name), name).toBeDefined();
  });

  it('returns the held revision and the legal next verb for a stale revision', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const entry = { kind: 'goal', title: 'L1 stale revision fixture', status: 'active', reason: 'Explicit local fixture with no target execution', criteria: ['Owner must review the retained limitations'], proof: { kind: 'capability', capability: { kind: 'http.request', subject: 'fixture' } } };
      const plan = (await h.call('p2o_plan_create', { entry, requestId: 'board-verbs-plan' })).details;
      await expect(h.call('p2o_plan_revise', { id: plan.id, revision: plan.revision + 5, entry: { ...entry, title: 'L1 stale revision fixture revised' } }))
        .rejects.toThrow(new RegExp(`currentRevision=${plan.revision}.*legalNext=p2o_plan_revise`));
    });
  });


  it('names the current plan revision when a coverage cell is created against a stale plan', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const plan = (await h.call('p2o_coverage_plan', { plan: { title: 'Stale cell plan hint', status: 'active', reason: 'One explicit local denominator for the cell hint', exclusions: [], unknownScope: [] } })).details;
      const cell = { actorContext: 'anonymous', questionKey: 'wstg-info-05', assetRef: { id: 'asset-000000000000000000000000', revision: 1 },
        execution: 'blocked', assessment: 'open_gap', evidenceRefs: [], negativeControlRefs: [], caseRefs: [], claimRefs: [], gapRefs: [], taskRefs: [],
        limitations: 'Local fixture only', reason: 'The stale plan revision is refused before any coverage claim', methodFamily: 'static-source-review', tenantContext: 'fixture' };
      await expect(h.call('p2o_coverage_cell', { planId: plan.id, planRevision: plan.revision + 5, cell }))
        .rejects.toThrow(new RegExp(`currentRevision=${plan.revision}.*legalNext=p2o_coverage_cell \\(planId=${plan.id}, planRevision=${plan.revision}\\)`));
    });
  });

  it('routes settle and coverage authoring through their verb actions', async () => {
    await fixture(async h => {
      await h.command('--target ./source');
      const draft = { question: 'Does the board verb fixture settle one task?', surface: '/board-verb-fixture', risk: 'coordination', role: 'general', roleReason: 'Bounded local fixture with no target work', expectedTrue: 'The settle verb reaches the cancelled transition', expectedFalse: 'The action bag is required again', stopCondition: 'Stop after one local transition', evidenceIds: [], prerequisites: [], skills: [], methodReason: 'No target or model work' };
      const task = (await h.call('p2o_task_create', { draft })).details;
      const settled = (await h.call('p2o_task_settle', { outcome: 'cancelled', id: task.id, revision: task.revision, reason: 'Owner cancelled the local board-verb fixture' })).details;
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
    expect(parityViolations(ALL_TOOLS, descriptions)).toEqual([]);
    expect(parityViolations(ALL_TOOLS, prompts)).toEqual([]);
  });
});
