import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerP2O } from '../../extensions/p2o/index.js';
import {
  ALL_TOOLS, HIDDEN_TOOLS, LAB_TOOLS, MODEL_TOOLS, REPORTER_TOOLS, TARGET_TOOLS, VALIDATION_TOOLS, WORKER_TOOLS,
  plannerTools, reporterTools, workerTools,
} from '../../src/tool-policy.js';
import { TOOL_BOUNDARIES } from '../../src/tool-guidelines.js';
import { plannerInstructions, workerBrief, workerInstructions } from '../../src/prompts.js';
import { createFakePi, EXTENSION_PATH } from './helpers/fake-pi.js';

/**
 * planning_update.md A1 (P0): the model is taught the role split through the tool loadout and short per-tool boundaries.
 * The planner owns intent/review/proof and holds no target, lab, claim, note or surface tool; the worker executes; the
 * reporter is a read-only second reader. Tool and guideline names cannot drift, and a removed tool leaves the surface.
 */
const registry = () => {
  const pi = createFakePi();
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH } as any);
  return pi.tools;
};
const facts = (enabled: boolean) => ({ runId: 'run-x', targetLabel: '/home/x/repo', targetKind: 'directory' as const, sourceSkipped: 0, delegation: { enabled, maxWorkers: enabled ? 3 : 0, maxDepth: enabled ? 2 : 0, reason: enabled ? undefined : 'no-worker-backend' }, workerBudget: 600, phase: 'active' as const, loopMode: 'event-driven' as const, executorMode: 'isolated' as const });
const ticket = (role: string) => ({ workerId: 'worker-1', role, depth: 1, parentWorkerId: null, target: { kind: 'directory', label: '/home/x/repo' }, executorMode: 'shared' } as any);
const mentioned = (text: string) => new Set(text.match(/\bp2o_[a-z_]+\b/g) ?? []);

describe('tool descriptions carry the boundary (A1: no separate guidance layer)', () => {
  it('folds every boundary sentence into the registered description and never sets promptGuidelines', () => {
    const tools = registry();
    for (const name of MODEL_TOOLS) {
      const tool = tools.get(name);
      expect(tool, name).toBeDefined();
      for (const line of TOOL_BOUNDARIES[name] ?? []) expect(tool.description, name).toContain(line);
      expect(tool.promptGuidelines, name).toBeUndefined();
    }
    // Every registered tool is either model-visible or an explicitly hidden legacy verb; hidden verbs have no boundary.
    for (const name of HIDDEN_TOOLS) {
      expect(tools.get(name), name).toBeDefined();
      expect(tools.get(name).exposure, name).toBe('hidden');
      expect(TOOL_BOUNDARIES[name], name).toBeUndefined();
    }
    for (const [name, lines] of Object.entries(TOOL_BOUNDARIES)) for (const named of mentioned(lines.join(' '))) expect(MODEL_TOOLS, `${name} names ${named}`).toContain(named);
    // L1/W2: a verb inherits its family boundary; the legacy family key itself is no longer a tool.
    for (const [name, lines] of Object.entries(TOOL_BOUNDARIES)) {
      const named = MODEL_TOOLS.find(tool => tool === name) ?? MODEL_TOOLS.find(tool => tool.startsWith(`${name}_`));
      expect(named, name).toBeDefined();
      for (const line of lines) expect(tools.get(named!).description, name).toContain(line);
    }
  });

  it('names only tools its own role can call, in the system instructions and in the brief', () => {
    for (const kind of ['directory', 'url'] as const) for (const role of ['recon', 'discovery', 'validation', 'reporting', 'general']) {
      const worker = { ...ticket(role), target: { kind, label: kind === 'url' ? 'https://example.invalid' : '/home/x/repo' } };
      const text = `${workerInstructions(worker)}\n${workerBrief({ ticket: worker, focus: 'surface-recon', task: 'Map authorized inputs', context: 'No previous work' })}`;
      for (const named of mentioned(text)) expect(workerTools(role), `${role}/${kind}: the worker prompt names ${named}`).toContain(named);
    }
  });

  it('leaves the lead policy section free of tool names', () => {
    for (const enabled of [true, false]) expect(plannerInstructions(facts(enabled))).not.toMatch(/\bp2o_[a-z_]+\b/);
  });

  it('no longer advertises the removed 60 s / 300 s command ceilings', () => {
    const tools = registry();
    for (const name of ['p2o_shell', 'p2o_net', 'p2o_http']) expect(tools.get(name).description, name).not.toMatch(/60-second|300-second|ceiling of 60|ceiling of 300/i);
  });
});

describe('authority split: planner intent, worker execution, reporter read (P0/A1)', () => {
  it('gives the planner intent tools and the worker execution tools', () => {
    expect(plannerTools()).toHaveLength(new Set(plannerTools()).size);
    for (const name of ['p2o_task_create', 'p2o_task_dispatch', 'p2o_task_review', 'p2o_workers', 'p2o_loop', 'p2o_finish', 'p2o_plan_create', 'p2o_case_create', 'p2o_coverage_plan']) expect(plannerTools(), name).toContain(name);
    for (const name of [...TARGET_TOOLS, ...LAB_TOOLS, 'p2o_candidate', 'p2o_note', 'p2o_surface', 'p2o_report', 'p2o_request_subtask', ...HIDDEN_TOOLS]) expect(plannerTools(), name).not.toContain(name);
    for (const name of [...TARGET_TOOLS, ...LAB_TOOLS, 'p2o_candidate', 'p2o_note', 'p2o_surface', 'p2o_report']) expect(workerTools('discovery'), name).toContain(name);
    for (const name of ['p2o_task_create', 'p2o_task_dispatch', 'p2o_task_review', 'p2o_plan_create', 'p2o_case_create', 'p2o_finish', ...HIDDEN_TOOLS]) expect(workerTools('discovery'), name).not.toContain(name);
    expect(VALIDATION_TOOLS).toEqual(WORKER_TOOLS.filter(name => name !== 'p2o_surface'));
    expect(workerTools('validation')).toEqual(VALIDATION_TOOLS);
    expect(workerTools('reporting')).toEqual(reporterTools());
    expect(new Set(workerTools('reporting'))).toEqual(new Set(REPORTER_TOOLS));
    for (const name of [...TARGET_TOOLS, ...LAB_TOOLS, 'p2o_candidate', 'p2o_note', 'p2o_surface']) expect(REPORTER_TOOLS, name).not.toContain(name);
    expect(ALL_TOOLS).toHaveLength(MODEL_TOOLS.length + HIDDEN_TOOLS.length);
    expect(HIDDEN_TOOLS).toEqual(['p2o_delegate', 'p2o_task_start']);
    for (const name of HIDDEN_TOOLS) expect(MODEL_TOOLS, name).not.toContain(name);
  });

  it('keeps removed tool names out of the model prompts and tool boundaries', async () => {
    const promptsSource = await readFile(resolve(import.meta.dirname, '../../src/prompts.ts'), 'utf8');
    for (const name of HIDDEN_TOOLS) {
      expect(promptsSource, name).not.toContain(name);
      expect(Object.keys(TOOL_BOUNDARIES), name).not.toContain(name);
    }
    // The planner never executes and the worker never plans: the generated prompts state the same split.
    expect(plannerInstructions(facts(true))).toMatch(/no target, lab or claim tools/i);
    expect(plannerInstructions(facts(true))).not.toMatch(/may execute directly/i);
    expect(workerInstructions(ticket('discovery'))).not.toMatch(/p2o_task_create|p2o_task_dispatch|p2o_workers/);
  });
});
