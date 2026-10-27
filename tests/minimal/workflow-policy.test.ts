import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerP2O } from '../../extensions/p2o/index.js';
import {
  ALL_TOOLS, HIDDEN_TOOLS, LAB_TOOLS, MODEL_TOOLS, REPORTER_TOOLS, TARGET_TOOLS, VALIDATION_TOOLS, WORKER_TOOLS,
  plannerTools, reporterTools, workerTools,
} from '../../src/tool-policy.js';
import { TOOL_BOUNDARIES } from '../../src/tool-guidelines.js';
import { artifactParameters, captureParameters, execParameters, httpParameters, labParameters, sessionParameters, taskDraftSchema } from '../../src/tool-schemas.js';
import { PAYLOAD_BYTES } from '../../src/lab.js';
import { MAX_BODY_BYTES } from '../../src/target.js';
import { taskDispatchParameters } from '../../src/board-verbs.js';
import { SEARCH_LIMIT_MAX } from '../../src/search.js';
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

  it('P10/WF-02 (Q28): names the configured per-task worker runtime only when the host supplies it', () => {
    const base = facts(true);
    const body = plannerInstructions({ ...base, delegation: { ...base.delegation, runtimeModels: ['opencode-go/deepseek-v4-flash', 'opencode-go/kimi-k3'] } });
    expect(body).toContain('runtime.model to one of opencode-go/deepseek-v4-flash, opencode-go/kimi-k3');
    expect(body).toContain('runtime.thinking to one of off/minimal/low/medium/high/xhigh/max');
    expect(body).toContain('a held ticket keeps the runtime it started with');
    // Without a delegation backend there is no worker runtime to choose, so the line is absent rather than misleading.
    expect(plannerInstructions(base)).not.toContain('runtime.model to one of');
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

describe('P9 capability ceilings (owner-chosen option A)', () => {
  it('declares the raised artifact, redirect, dispatch and search caps where the host enforces them (P9)', () => {
    // The schema is the declaration Pi validates before a handler sees it; each value below now matches the host's own
    // ceiling instead of sitting below it (a 8 KiB artifact read against a 48 KiB store, 5 redirects against 20, a
    // dispatch batch with no declared maximum against the engine's 1..25, and a 20-hit search against the state
    // schema's 100).
    const artifact = (artifactParameters as unknown as { properties: Record<string, { maximum?: number }> }).properties;
    expect(artifact.length.maximum).toBe(48 * 1024);
    const http = (httpParameters as unknown as { properties: Record<string, { maximum?: number }> }).properties;
    expect(http.maxRedirects.maximum).toBe(20);
    const dispatch = (taskDispatchParameters as unknown as { properties: Record<string, { maxItems?: number }> }).properties;
    expect(dispatch.ids.maxItems).toBe(25);
    expect(SEARCH_LIMIT_MAX).toBe(100);
  });
  it('raises the remaining request ceilings to the broker-safe maxima (P9/B)', async () => {
    // P9/B (owner chose raised constants, not settings): each schema maximum now matches its handler/broker bound.
    const properties = (schema: unknown) => (schema as { properties: Record<string, { maximum?: number; maxLength?: number }> }).properties;
    expect(properties(execParameters).command.maxLength).toBe(32 * 1024);
    expect(properties(execParameters).send.maxLength).toBe(16 * 1024);
    expect(properties(sessionParameters).command.maxLength).toBe(32 * 1024);
    expect(properties(sessionParameters).content.maxLength).toBe(48 * 1024);
    expect(properties(httpParameters).body.maxLength).toBe(48 * 1024);
    expect(properties(httpParameters).url.maxLength).toBe(8 * 1024);
    expect(properties(labParameters).body.maxLength).toBe(PAYLOAD_BYTES);
    expect(PAYLOAD_BYTES).toBe(48 * 1024);
    expect(MAX_BODY_BYTES).toBe(48 * 1024);
    // TR-S07: a per-call capture bound exists in the schema and the handler clamps it to the run setting.
    expect(properties(captureParameters).maxKiB.maximum).toBe(8192);
    // The operator documents and the tool descriptions state the raised numbers, so a model or human reads the real ceiling.
    const doc = (name: string) => readFile(resolve(import.meta.dirname, `../../docs/${name}`), 'utf8');
    expect(await doc('HTTP_TRANSPORT.md')).toContain('body 48 KiB');
    expect(await doc('USAGE.md')).toContain('graphCapacity');
    expect(await doc('EVIDENCE.md')).toContain('≤48 KiB');
  });
});

describe('task draft schema caps (P2: cosmetic prose is clamped, semantic prose is refused)', () => {
  it('declares risk/surface caps above the admission clamp so argument validation cannot pre-empt truncation', () => {
    const properties = (taskDraftSchema as unknown as { properties: Record<string, { maxLength?: number }> }).properties;
    // The host clamps risk/surface to 200 at admission and records `truncated:<field>`; Pi must let the draft reach that code.
    expect(properties.risk.maxLength).toBeGreaterThan(200);
    expect(properties.surface.maxLength).toBeGreaterThan(200);
    // Semantic fields keep their exact caps: the host refuses those rather than truncating what a review matches on.
    expect(properties.question.maxLength).toBe(1500);
    expect(properties.roleReason.maxLength).toBe(1000);
    expect(properties.expectedTrue.maxLength).toBe(1000);
    expect(properties.stopCondition.maxLength).toBe(1000);
  });
});
