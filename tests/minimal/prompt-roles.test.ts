import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { AssessmentEngine, type EngineDeps, type PlannerWake } from '../../src/engine.js';
import { plannerInstructions, reporterInstructions, workerInstructions, type PlannerPromptFacts } from '../../src/prompts.js';
import { TOOL_BOUNDARIES } from '../../src/tool-guidelines.js';
import { authorityCounters, authorityReport, ROLE_COUNTS } from '../../src/authority.js';
import { indexRecords, readLedger, type AssessmentRecord } from '../../src/records.js';
import { reportProjection } from '../../src/report.js';
import { renderReport } from '../../src/report-export.js';
import { statusView, type ViewProfile } from '../../src/ui/state.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, type FakePi } from './helpers/fake-pi.js';

/**
 * planning_update.md P3/A4 — "Prompt and reporting roles".
 *
 * Hermetic evidence for the phase gate: the planner/worker/reporter prompt rules and tool boundaries, the durable
 * `planner.stalled` report fact, and the authority counters/mode/role matrix the report and status expose. No paid model,
 * no target contact, no new authority.
 */
const plannerFacts = (overrides: Partial<PlannerPromptFacts> = {}): PlannerPromptFacts => ({
  runId: 'run-a4', targetLabel: '/fixture', targetKind: 'directory', sourceSkipped: 0,
  delegation: { enabled: true, maxWorkers: 3, maxDepth: 2 }, phase: 'active', loopMode: 'manual', executorMode: 'shared', ...overrides,
});
const ticket = (role: string) => ({ workerId: 'worker-1', role, depth: 1, parentWorkerId: null, target: { kind: 'directory', label: '/fixture' }, executorMode: 'shared' } as never);

describe('A4 prompt rules and tool boundaries', () => {
  it('states the planner first-action, no-target, no-claim, zero-intent and projection rules', () => {
    const planner = plannerInstructions(plannerFacts());
    expect(planner).toContain('First action: create and dispatch one recon/mapping intent.');
    expect(planner).toContain('No target operations');
    expect(planner).toContain('No claims');
    expect(planner).toContain('no target, lab or claim tools');
    expect(planner).toContain('A zero-intent round is not progress');
    expect(planner).toContain('Coverage is a projection of reviewed work');
    expect(planner).not.toMatch(/may execute directly/i);
    // The planner prompt names no tool: enforcement is the loadout, not prose.
    expect(planner).not.toMatch(/\bp2o_[a-z_]+\b/);
  });

  it('gives the worker the one-intent write-back rule and the reporter a read-only rule', () => {
    const worker = workerInstructions(ticket('recon'));
    expect(worker).toContain('One intent, write back, report, stop');
    const reporter = reporterInstructions(ticket('reporting'));
    expect(reporter).toContain('Read-only second reader');
    expect(reporter).toContain('no target operations');
    expect(reporter).toContain('no candidate authorship');
    // The reporter never receives the claim-writing rule.
    expect(reporter).not.toContain('Use p2o_candidate for candidate closure');
    expect(workerInstructions(ticket('reporting'))).toBe(reporter);
  });

  it('carries the role split on the tool boundaries and keeps removed verbs out of them', () => {
    expect(TOOL_BOUNDARIES.p2o_task_create.join(' ')).toContain('planner has no target or claim tools');
    expect(TOOL_BOUNDARIES.p2o_report.join(' ')).toContain('one intent, write back, report, stop');
    expect(TOOL_BOUNDARIES.p2o_report.join(' ')).toContain('read-only second reader');
    for (const name of ['p2o_delegate', 'p2o_task_start', 'p2o_coverage_cell', 'p2o_coverage_cell_retire']) expect(TOOL_BOUNDARIES[name]).toBeUndefined();
  });
});

function engineFixture() {
  const journal: Array<{ text: string; data: unknown }> = [], wakes: PlannerWake[] = [], problems: string[] = [];
  const deps: EngineDeps = {
    active: () => true, list: async () => [], readiness: async () => ({ ready: true }), capacity: () => 3, reap: async () => true,
    spawn: async () => undefined, persist: async (text, data) => { journal.push({ text, data }); }, wake: wake => { wakes.push(wake); },
    idle: () => true, problem: reason => { problems.push(reason); },
  };
  return { engine: new AssessmentEngine('run-a4', 'manual', deps, 10), journal, wakes, problems };
}

describe('A4 stalled round is a report fact, never a wake', () => {
  it('records exactly the open-goal/no-intent/no-blocked rounds and nothing else', async () => {
    const f = engineFixture();
    expect(await f.engine.stallRound({ openGoal: false, openIntents: 0 })).toBe(false);
    expect(await f.engine.stallRound({ openGoal: true, openIntents: 1 })).toBe(false);
    expect(f.journal).toHaveLength(0);
    expect(await f.engine.stallRound({ openGoal: true, openIntents: 0 })).toBe(true);
    expect(f.journal).toHaveLength(1);
    expect(f.journal[0].text).toContain('planner.stalled');
    expect(f.journal[0].data).toMatchObject({ event: 'planner.stalled', openGoal: true, openIntents: 0, stalls: 1 });
    // No wake, no queue entry, no pause: a stall only adds a fact.
    expect(f.wakes).toEqual([]);
    expect(f.problems).toEqual([]);
    expect(f.engine.snapshot()).toMatchObject({ stalls: 1, pendingEvents: 0, pendingIntents: 0, state: 'waiting' });
    // A recorded blocked declaration is not a stall; after resume the next stalled round is recorded too.
    await f.engine.disposition('blocked', 'Human prerequisite is missing');
    expect(await f.engine.stallRound({ openGoal: true, openIntents: 0 })).toBe(false);
    f.engine.resume();
    expect(await f.engine.stallRound({ openGoal: true, openIntents: 0 })).toBe(true);
    expect(f.engine.snapshot().stalls).toBe(2);
    f.engine.stop();
  });
});

interface Harness {
  root: string; pi: FakePi;
  start: () => Promise<void>;
  call: (name: string, params?: unknown) => Promise<any>;
  emit: (event: string, payload?: unknown) => Promise<any>;
  command: (args: string) => Promise<void>;
  records: () => Promise<AssessmentRecord[]>;
}
async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-a4-'));
  await mkdir(join(root, 'repo'), { recursive: true });
  const pi = createFakePi(), context = createContext({ cwd: root });
  registerP2O(pi.pi, { createSandbox: sandboxFactory([]), herdr: createSimpleHerdr().client, settingsPath: join(root, 'settings.json'), controlRoot: join(root, 'control'), extensionPath: EXTENSION_PATH });
  const runDirectory = async () => {
    const entries = await readdir(join(root, 'control')), created = entries.find(name => name.startsWith('p2o-run-'));
    if (!created) throw new Error('no control directory was created');
    return join(root, 'control', created);
  };
  const call = (name: string, params: unknown = {}) => pi.tools.get(name)!.execute('call', params, undefined, undefined, context.ctx);
  return {
    root, pi,
    async start() { await pi.commands.get('p2o')!.handler('--target ./repo', context.ctx); },
    call,
    async emit(event, payload = {}) { let result: unknown; for (const handler of pi.events.get(event) ?? []) result = await handler(payload, context.ctx); return result; },
    command: args => pi.commands.get('p2o')!.handler(args, context.ctx),
    records: async () => (await readLedger(join(await runDirectory(), 'records.sqlite'))).records,
  };
}

describe('A4 extension round ACK', () => {
  it('writes planner.stalled for a zero-intent round with an open goal, and not while an intent is open', async () => {
    const h = await harness();
    try {
      await h.start();
      const round = async () => {
        await h.emit('context', { messages: [{ role: 'user', content: 'continue the assessment', timestamp: 0 }] });
        await h.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: 'no new intent' } });
      };
      const stalls = async () => (await h.records()).filter(row => row.kind === 'lifecycle' && (row.data?.engine as { event?: unknown } | undefined)?.event === 'planner.stalled');
      // No open goal → the round is not a stall.
      await round();
      expect(await stalls()).toHaveLength(0);
      // An active goal with no open/running intent → one durable stall fact.
      await h.call('p2o_plan_create', { entry: { kind: 'goal', title: 'Bound the fixture question', status: 'active', reason: 'A4 stall fixture goal', criteria: ['one bounded fixture observation'], proof: { kind: 'capability', capability: 'net.egress' } }, requestId: 'a4-goal' });
      await round();
      const first = await stalls();
      expect(first).toHaveLength(1);
      expect(first[0].text).toContain('planner.stalled');
      // A proposed intent is open work, so the same round is not a stall.
      await h.call('p2o_task_create', { draft: { question: 'Does the bounded fixture observation match the declared policy?', surface: '/a', risk: 'authorization', role: 'recon', evidenceIds: [], prerequisites: [] } });
      await round();
      expect(await stalls()).toHaveLength(1);
    } finally { await h.command('stop').catch(() => {}); await rm(h.root, { recursive: true, force: true }); }
  }, 60_000);
});

const row = (input: Partial<AssessmentRecord> & Pick<AssessmentRecord, 'at' | 'by' | 'kind' | 'text'>): AssessmentRecord => ({ runId: 'run-a4', ...input } as AssessmentRecord);
const taskRow = (id: string, role: string, status: string, at: string): AssessmentRecord => row({
  at, by: 'owner', kind: 'task', text: `${id}: ${status}`,
  data: { task: { id, runId: 'run-a4', revision: 1, status, role, prerequisites: [] } },
});
const authorityRows = (): AssessmentRecord[] => [
  taskRow('task-1', 'recon', 'running', '2026-01-01T00:00:00.000Z'),
  taskRow('task-2', 'validation', 'proposed', '2026-01-01T00:00:01.000Z'),
  row({ at: '2026-01-01T00:00:02.000Z', by: 'worker-a', workerId: 'worker-a', kind: 'evidence', text: 'shell exit 0' }),
  row({ at: '2026-01-01T00:00:03.000Z', by: 'owner', kind: 'evidence', text: 'legacy owner shell receipt' }),
  row({ at: '2026-01-01T00:00:04.000Z', by: 'worker-a', workerId: 'worker-a', kind: 'candidate', text: 'worker claim' }),
  row({ at: '2026-01-01T00:00:05.000Z', by: 'owner', kind: 'candidate', text: 'legacy owner claim' }),
  row({ at: '2026-01-01T00:00:06.000Z', by: 'owner', kind: 'lifecycle', text: 'planner.stalled: a zero-intent round', data: { engine: { event: 'planner.stalled' } } }),
];

describe('A4 authority counters in report and status', () => {
  it('derives target ops, task/claim/validation counters and stalled rounds from the ledger', () => {
    const counters = authorityCounters(indexRecords(authorityRows(), 'run-a4'));
    expect(counters).toMatchObject({
      plannerTargetOps: 1, workerTargetOps: 1, tasksCreated: 2, tasksDispatched: 1, firstDispatchAt: '2026-01-01T00:00:00.000Z',
      ownerClaims: 1, workerClaims: 1, validationTasks: 1, stalledRounds: 1,
    });
    // A clean post-A1/A2 run has zero planner target operations and zero owner claims.
    const clean = authorityReport(indexRecords(authorityRows().filter(entry => entry.by !== 'owner' || !['evidence', 'candidate'].includes(entry.kind)), 'run-a4'));
    expect(clean).toMatchObject({ plannerTargetOps: 0, ownerClaims: 0, roles: ROLE_COUNTS });
  });

  it('exposes the counters, mode and role matrix in the report projection, status view and REPORT.md provenance', () => {
    const index = indexRecords(authorityRows(), 'run-a4'), mode = { loopMode: 'manual', executorMode: 'shared' };
    const projection = reportProjection(index, { mode });
    expect(projection.authority).toMatchObject({ plannerTargetOps: 1, workerTargetOps: 1, firstDispatchAt: '2026-01-01T00:00:00.000Z', ownerClaims: 1, workerClaims: 1, validationTasks: 1, stalledRounds: 1, mode, roles: ROLE_COUNTS });
    const profile = {
      runId: 'run-a4', target: '/fixture', lifecycle: 'active', delegation: true, maxWorkers: 3, exportEnabled: false,
      engine: { mode: 'manual', pendingIntents: 0, rounds: 0, stalls: 1, sequence: 0, consumedSequence: 0, pendingEvents: 0 },
      executor: { mode: 'shared', maxTargetOperations: 3 }, retention: 'ephemeral',
    } as unknown as ViewProfile;
    const status = statusView(index, profile);
    expect(status.authority).toMatchObject({ plannerTargetOps: 1, ownerClaims: 1, stalledRounds: 1, mode });
    expect(status.lines.join('\n')).toContain('Authority: planner target ops 1 (must be 0)');
    expect(status.lines.join('\n')).toContain('mode manual/shared');
    const rendered = renderReport(index, {}, {
      runId: 'run-a4', target: '/fixture', retention: 'durable-local', historical: false, asOfSequence: 0, storeSchema: 3,
      runtime: { hash: 'a'.repeat(64) }, complete: true, mode,
    });
    const body = rendered.files.find(file => file.name === 'REPORT.md')!.body;
    expect(body).toContain('Authority: planner target operations 1 (must be 0)');
    expect(body).toContain('stalled rounds 1');
    expect(body).toContain('Mode and role matrix: manual loop / shared executor; planner 23 tools (no target or claim tool), worker 17, validation 16, reporter 6 (read-only)');
  });
});
