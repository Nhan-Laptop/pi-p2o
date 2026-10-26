import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { authorityCounters } from '../../src/authority.js';
import { indexRecords, type AssessmentRecord } from '../../src/records.js';
import {
  ALL_TOOLS, HIDDEN_TOOLS, LAB_TOOLS, MODEL_TOOLS, PLANNER_TOOLS, REPORTER_TOOLS, TARGET_TOOLS, VALIDATION_TOOLS, WORKER_TOOLS,
  plannerTools, reporterTools, workerTools,
} from '../../src/tool-policy.js';
import { TOOL_BOUNDARIES } from '../../src/tool-guidelines.js';
import { plannerInstructions, reporterInstructions, workerInstructions } from '../../src/prompts.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox, sandboxFactory } from './helpers/fake-pi.js';

/**
 * planning_update.md P0/A1 — "Authority and one path".
 *
 * Hermetic evidence for the phase gate: planner/worker/reporter tool matrices; removed tools absent from the model surface,
 * docs and tool boundaries; worker-only candidate; and a parity test that every registered tool belongs to exactly one
 * declared role (or to the explicit hidden-legacy set). No paid run, model call or target contact.
 */
// Two distinct removal shapes: hidden-but-registered legacy verbs, and verbs deleted from the surface entirely (A3 derives
// coverage cells in the host, so no model-authored cell verb exists any more).
const HIDDEN = ['p2o_delegate', 'p2o_task_start'];
const DELETED = ['p2o_coverage_cell', 'p2o_coverage_cell_retire'];
const REMOVED = [...HIDDEN, ...DELETED];
const PLANNER_MUST_NOT_HAVE = [...TARGET_TOOLS, ...LAB_TOOLS, 'p2o_candidate', 'p2o_note', 'p2o_surface', 'p2o_report',
  'p2o_request_subtask', ...REMOVED];
const ONE_PATH = ['p2o_task_create', 'p2o_task_dispatch', 'p2o_workers', 'p2o_loop'];
const mentioned = (text: string) => new Set(text.match(/\bp2o_[a-z_]+\b/g) ?? []);
const ticket = (role: string) => ({ workerId: 'worker-1', role, depth: 1, parentWorkerId: null, target: { kind: 'directory', label: '/home/x/repo' }, executorMode: 'shared' } as never);

const registrations = () => {
  const pi = createFakePi();
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH } as any);
  return pi.tools;
};

interface OwnerFixture {
  root: string; pi: ReturnType<typeof createFakePi>; ctx: ReturnType<typeof createContext>; sandboxes: InertSandbox[];
  emit: (event: string, payload?: any) => Promise<any>; command: (args: string) => Promise<void>;
}
async function ownerFixture(): Promise<OwnerFixture> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-authority-'));
  await mkdir(join(root, 'source'));
  const pi = createFakePi(), ctx = createContext({ cwd: root }), sandboxes: InertSandbox[] = [];
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'settings.json'), herdr: createSimpleHerdr().client, createSandbox: sandboxFactory(sandboxes) });
  const emit = async (event: string, payload: any = {}) => {
    let result: unknown;
    for (const handler of pi.events.get(event) ?? []) result = await handler(payload, ctx.ctx);
    return result;
  };
  const command = (args: string) => pi.commands.get('p2o').handler(args, ctx.ctx);
  await command('--target ./source');
  return { root, pi, ctx, sandboxes, emit, command };
}
describe('P0/A1 tool matrices', () => {
  it('pins the planner, worker, validation and reporter matrices and the one delegation path', () => {
    expect(new Set(PLANNER_TOOLS)).toEqual(new Set([
      'p2o_task_create', 'p2o_task_revise', 'p2o_task_dispatch', 'p2o_task_review', 'p2o_task_settle',
      'p2o_plan_create', 'p2o_plan_revise', 'p2o_case_create', 'p2o_case_revise', 'p2o_case_rate',
      'p2o_coverage_plan', 'p2o_coverage_suggest', 'p2o_board', 'p2o_ledger', 'p2o_state', 'p2o_artifact', 'p2o_graph',
      'p2o_skill_list', 'p2o_skill_read', 'p2o_secret', 'p2o_research', 'p2o_workers', 'p2o_loop', 'p2o_finish',
    ]));
    expect([...WORKER_TOOLS].sort()).toEqual(['p2o_artifact', 'p2o_candidate', 'p2o_capture', 'p2o_graph', 'p2o_http', 'p2o_lab', 'p2o_ledger', 'p2o_net', 'p2o_note', 'p2o_report', 'p2o_request_subtask', 'p2o_research', 'p2o_secret', 'p2o_session', 'p2o_shell', 'p2o_skill_list', 'p2o_skill_read', 'p2o_state', 'p2o_surface']);
    expect(VALIDATION_TOOLS).toEqual(WORKER_TOOLS.filter(name => name !== 'p2o_surface'));
    expect([...REPORTER_TOOLS].sort()).toEqual(['p2o_artifact', 'p2o_ledger', 'p2o_report', 'p2o_skill_list', 'p2o_skill_read', 'p2o_state']);
    expect(HIDDEN_TOOLS).toEqual(HIDDEN);
    expect(MODEL_TOOLS).toHaveLength(35);
    expect(ALL_TOOLS).toHaveLength(37);
    for (const name of DELETED) {
      expect(ALL_TOOLS, name).not.toContain(name);
      expect(TOOL_BOUNDARIES[name], name).toBeUndefined();
    }
    expect(plannerTools()).toEqual(PLANNER_TOOLS);
    expect(reporterTools()).toEqual(REPORTER_TOOLS);
    expect(workerTools('reporting')).toEqual(REPORTER_TOOLS);
    expect(workerTools('validation')).toEqual(VALIDATION_TOOLS);
    expect(workerTools()).toEqual(WORKER_TOOLS);
    expect(workerTools('general')).toEqual(WORKER_TOOLS);
  });

  it('removes target, lab, claim, note, surface and one-path authority from the planner', () => {
    for (const name of PLANNER_MUST_NOT_HAVE) expect(PLANNER_TOOLS, name).not.toContain(name);
    for (const name of ONE_PATH) expect(PLANNER_TOOLS, name).toContain(name);
    // Worker-only claim authoring: candidate is reachable by an executing worker, never by the planner or the reporter.
    expect(WORKER_TOOLS).toContain('p2o_candidate');
    expect(VALIDATION_TOOLS).toContain('p2o_candidate');
    expect(PLANNER_TOOLS).not.toContain('p2o_candidate');
    expect(REPORTER_TOOLS).not.toContain('p2o_candidate');
    // The reporter is read-only: it cannot execute, claim, plan or finish the run.
    for (const name of [...TARGET_TOOLS, ...LAB_TOOLS, 'p2o_candidate', 'p2o_note', 'p2o_surface', 'p2o_graph', 'p2o_task_create', 'p2o_plan_create', 'p2o_case_create', 'p2o_finish']) expect(REPORTER_TOOLS, name).not.toContain(name);
  });

  it('registers 35 tools: 33 model-visible role tools plus 2 explicitly hidden legacy verbs', () => {
    const tools = registrations();
    expect([...tools.keys()].sort()).toEqual([...ALL_TOOLS].sort());
    for (const name of HIDDEN_TOOLS) expect(tools.get(name).exposure, name).toBe('hidden');
    // A3: the model-authored coverage-cell verbs are gone from the surface, not merely hidden.
    for (const name of DELETED) expect(tools.has(name), name).toBe(false);
    for (const name of MODEL_TOOLS) expect(tools.get(name).exposure, name).not.toBe('hidden');
    for (const [name, lines] of Object.entries(TOOL_BOUNDARIES)) {
      expect(MODEL_TOOLS, name).toContain(name);
      for (const named of mentioned(lines.join(' '))) expect(MODEL_TOOLS, `${name} names ${named}`).toContain(named);
    }
    for (const name of HIDDEN_TOOLS) expect(TOOL_BOUNDARIES[name], name).toBeUndefined();
  });
});

describe('P0/A1 active surface', () => {
  it('starts the planner with only the planner loadout; execution and claim tools cannot be seen or called', async () => {
    const fixture = await ownerFixture();
    try {
      expect(fixture.pi.active).toEqual(plannerTools());
      // Pi only declares active tools; a call to an undeclared tool resolves to the agent loop's `Tool <name> not found`
      // before any extension handler or permission check can run. The native test asserts the same text against real Pi.
      for (const name of PLANNER_MUST_NOT_HAVE) expect(fixture.pi.active, name).not.toContain(name);
      for (const name of TARGET_TOOLS) expect(fixture.pi.active, name).not.toContain(name);
      // Defense in depth: a tool injected back into a turn is refused with the legal next verb, never a lead-exec hatch.
      for (const name of PLANNER_MUST_NOT_HAVE) {
        const result = await fixture.emit('tool_call', { toolName: name });
        expect(result, name).toMatchObject({ block: true, reason: expect.stringContaining('Create and dispatch an intent') });
      }
      for (const name of ONE_PATH) expect(await fixture.emit('tool_call', { toolName: name }), name).toBeUndefined();
    } finally {
      await fixture.command('stop').catch(() => {});
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps the removed verbs out of docs, prompts and tool boundaries', async () => {
    const root = resolve(import.meta.dirname, '../..');
    const docs = [...(await readdir(join(root, 'docs'))).filter(name => name.endsWith('.md')).map(name => join('docs', name)), 'README.md', 'HANDOFFS.md'];
    for (const relative of docs) {
      const text = await readFile(join(root, relative), 'utf8');
      for (const name of REMOVED) expect(text, `${relative} names ${name}`).not.toContain(name);
    }
    for (const relative of ['src/prompts.ts', 'src/tool-guidelines.ts']) {
      const text = await readFile(join(root, relative), 'utf8');
      for (const name of REMOVED) expect(text, `${relative} names ${name}`).not.toContain(name);
    }
    // One model-facing delegation path: the planner prompt names neither removed verb nor a target tool, and the
    // reporter/worker prompts name only tools their own loadout contains.
    const planner = plannerInstructions({ runId: 'run-x', targetLabel: '/home/x/repo', targetKind: 'directory', sourceSkipped: 0, delegation: { enabled: true, maxWorkers: 3, maxDepth: 2 }, phase: 'active', loopMode: 'manual', executorMode: 'shared' });
    expect(planner).toMatch(/no target, lab or claim tools/i);
    expect(planner).not.toMatch(/may execute directly/i);
    for (const name of REMOVED) expect(planner, name).not.toContain(name);
    for (const role of ['recon', 'discovery', 'validation', 'reporting', 'general'] as const) {
      const text = role === 'reporting' ? reporterInstructions(ticket(role)) : workerInstructions(ticket(role));
      for (const named of mentioned(text)) expect(workerTools(role), `${role} prompt names ${named}`).toContain(named);
    }
  });
});

describe('P1 campaign observability counters', () => {
  it('counts human resumes and stall escalations from lifecycle records, never from prose', () => {
    const lifecycle = (at: string, text: string, data: Record<string, unknown>): AssessmentRecord => ({ at, runId: 'run-p1', by: 'owner', kind: 'lifecycle', text, data } as AssessmentRecord);
    const rows = [
      // P1.1: the `/p2o resume` branch appends exactly this envelope, once per human resume.
      lifecycle('2026-01-01T00:00:01.000Z', 'campaign.resumed: human resumed the loop; no budgets or authority renewed', { event: 'campaign.resumed' }),
      lifecycle('2026-01-01T00:00:02.000Z', 'campaign.resumed: human resumed the loop; no budgets or authority renewed', { event: 'campaign.resumed' }),
      // A6.3: the engine persists this fact under data.engine, like planner.wake and planner.stalled.
      lifecycle('2026-01-01T00:00:03.000Z', 'planner.stall-escalation: three stalled rounds while research debt remains', { engine: { event: 'planner.stall-escalation', stalls: 3, debt: { gateable: 1, total: 1 } } }),
      // A prose mention and a neighbouring lifecycle event are not facts, and must not move a counter.
      lifecycle('2026-01-01T00:00:04.000Z', 'campaign.resumed mentioned in passing', {}),
      lifecycle('2026-01-01T00:00:05.000Z', 'planner.stalled: a zero-intent round', { engine: { event: 'planner.stalled' } }),
    ];
    // P1 counts only the recorded facts; the A4/A6 counters keep reading the same ledger rows unchanged.
    const counters = authorityCounters(indexRecords(rows, 'run-p1'));
    expect(counters).toMatchObject({ campaignResumes: 2, stallEscalations: 1 });
    expect(counters).toMatchObject({ stalledRounds: 1, campaignPartial: 0, debtWakes: 0, heartbeatWakes: 0 });
  });
});
