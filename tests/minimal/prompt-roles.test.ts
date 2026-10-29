import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { AssessmentEngine, type EngineDeps, type PlannerWake } from '../../src/engine.js';
import { plannerInstructions, reporterInstructions, workerBrief, workerInstructions, type PlannerPromptFacts } from '../../src/prompts.js';
import type { Ticket } from '../../src/ticket.js';
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
  delegation: { enabled: true, maxWorkers: 3, maxDepth: 2 }, phase: 'active', executorMode: 'shared', ...overrides,
});
const ticket = (role: string) => ({ workerId: 'worker-1', role, depth: 1, parentWorkerId: null, target: { kind: 'directory', label: '/fixture' }, executorMode: 'shared' } as never);

describe('A4 prompt rules and tool boundaries', () => {
  it('states the planner first-action, no-target, no-claim, zero-intent and projection rules', () => {
    const planner = plannerInstructions(plannerFacts());
    // A17.2/D32: exploit mode authors the impact goal before the first dispatch, so the first-action pin names both modes.
    expect(planner).toContain('First action: in exploit mode record the impact goal first');
    // The 2026-10-27 dedupe folded the separate "No target operations"/"No claims" role lines into the sentences that state the
    // same rule without repeating it, so the pin moves to those surviving lines.
    expect(planner).toContain('Do not probe the target yourself');
    expect(planner).toContain('A confirmed or tested claim must come from a worker task');
    expect(planner).toContain('no target, lab or claim tools');
    expect(planner).toContain('A zero-intent round is not progress');
    expect(planner).toContain('Coverage is a projection of reviewed work');
    expect(planner).not.toMatch(/may execute directly/i);
    // The planner prompt names no tool: enforcement is the loadout, not prose.
    expect(planner).not.toMatch(/\bp2o_[a-z_]+\b/);
  });

  it('states the one-intent rule once on the report boundary and gives the reporter a read-only rule', () => {
    const worker = workerInstructions(ticket('recon'));
    // A17.0: the rule is canonical on the p2o_report boundary (pinned below); the worker prompt keeps only the operational
    // write-back and finish rules, so one prompt does not state it twice.
    expect(worker).not.toContain('One intent, write back, report, stop');
    expect(worker).toContain('Finish by calling p2o_report');
    const reporter = reporterInstructions(ticket('reporting'));
    expect(reporter).toContain('Read-only second reader');
    expect(reporter).toContain('no target operations');
    expect(reporter).toContain('no candidate authorship');
    // The reporter never receives the claim-writing rule.
    expect(reporter).not.toContain('Use p2o_candidate for candidate closure');
    expect(workerInstructions(ticket('reporting'))).toBe(reporter);
  });

  it('carries the operator frame into the worker brief and states the effective worker caps (P9)', () => {
    const ticket = { workerId: 'p2o-recon-aaaaaa', role: 'recon', runId: 'run-test', depth: 1, parentWorkerId: null,
      lifetime: 'until-stopped', target: { kind: 'directory', label: '/target' }, captureKiB: 1024,
      requestedRuntime: { model: 'p2o-inert/current-agent', thinking: 'off' } } as Ticket;
    const brief = workerBrief({ ticket, focus: 'surface-recon', task: 'Map authorized inputs', objective: 'Prove tenant isolation',
      permissions: ['test checkout'], constraints: ['no payment flows'], hints: ['start at login'] });
    // WF-01: the frame the planner holds travels to the worker as data, and each block keeps its own meaning (a permission
    // never widens, a constraint always narrows, a hint only guides).
    expect(brief).toContain('OPERATOR OBJECTIVE');
    expect(brief).toContain(JSON.stringify('Prove tenant isolation'));
    expect(brief).toContain('OPERATOR PERMISSIONS');
    expect(brief).toContain('- "test checkout"');
    expect(brief).toContain('OPERATOR CONSTRAINTS');
    expect(brief).toContain('OPERATOR HINTS');
    expect(brief.indexOf('OPERATOR HINTS')).toBeLessThan(brief.indexOf('TASK:'));
    expect(workerBrief({ ticket, focus: 'surface-recon', task: 'Map authorized inputs' })).not.toContain('OPERATOR OBJECTIVE');
    // WF-17: the worker is told the capture ceiling it actually got, not a hard-coded 8 MiB.
    const instructions = workerInstructions(ticket);
    expect(instructions).toContain('Capture cap: 1024 KiB');
    expect(instructions).toContain('Requested runtime: model p2o-inert/current-agent, thinking off');
    const legacy = { ...ticket, captureKiB: undefined, requestedRuntime: undefined } as Ticket;
    expect(workerInstructions(legacy)).not.toContain('Capture cap:');
  });

  // A17.5/D36 (2026-10-27): validation is a replay owed by a different worker and a case badge; it is no longer described as
  // the confirmation gate for the next rung, because a confirmed primitive can be chained and rated without waiting for it.
  it('keeps independent validation a badge, not the gate for the next rung (A17.5)', () => {
    const planner = plannerInstructions(plannerFacts());
    expect(planner).toContain('Independence hardens the case badge, not permission to take the next rung');
    expect(planner).toContain('a confirmed primitive is chained and rated without waiting for the replay');
    expect(planner).not.toContain('Only that closure counts as confirmed');
  });

  // A17.1/D33 (2026-10-27): the exploitation stance is conditional, so every other worker prompt pays nothing for it. The
  // ticket purpose is the switch; a ticket without one keeps the pre-P17 prompt byte for byte.
  it('adds the exploitation stance only to an exploitation or chaining ticket (A17.1)', () => {
    const withPurpose = (purpose: string) => ({ workerId: 'worker-1', role: 'general', depth: 1, parentWorkerId: null,
      target: { kind: 'directory', label: '/fixture' }, executorMode: 'shared', purpose } as never);
    for (const purpose of ['exploitation', 'chaining']) {
      const text = workerInstructions(withPurpose(purpose));
      expect(text, purpose).toContain('EXPLOITATION STANCE');
      expect(text, purpose).toContain('a wall is a refusal or an exhausted family, never one failed payload');
      expect(text, purpose).toContain('re-trigger independently (fresh session, payload or encoding)');
      expect(text, purpose).toContain('tee long output into a p2o_capture artifact');
      expect(text, purpose).toContain('gained/needs');
    }
    for (const purpose of ['mapping', 'discovery', 'validation', 'reporting']) expect(workerInstructions(withPurpose(purpose)), purpose).not.toContain('EXPLOITATION STANCE');
    expect(workerInstructions(ticket('recon'))).not.toContain('EXPLOITATION STANCE');
  });

  it('carries the role split on the tool boundaries and keeps removed verbs out of them', () => {
    expect(TOOL_BOUNDARIES.p2o_task_author.join(' ')).toContain('planner has no target or claim tools');
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
  return { engine: new AssessmentEngine('run-a4', 'event-driven', deps, 10), journal, wakes, problems };
}

describe('A4 stalled round is a report fact, never a wake', () => {
  it('records exactly the open-goal/no-intent/no-blocked rounds and nothing else', async () => {
    const f = engineFixture();
    // P5.1/P18/D48: only an admitted round can stall. There is no manual mode fallback any more, so admit round 1 first.
    f.engine.notify('worker-report', 'w0');
    f.engine.consume(f.engine.boundary()!.through);
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
    // P5.1: the engine counter is now the consecutive streak since the last human decision, not a lifetime total; the
    // cumulative count stays ledger-derived (`planner.stalled` records), which the report reads.
    expect(f.engine.snapshot().stalls).toBe(1);
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
  // P18.3/D47: this suite exercises round ACK accounting through the settle boundary continuation, which is the documented
  // single-session fallback; session rounds (the default) open the next round from the engine kick instead.
  const settingsPath = join(root, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ p2o: { roundSessions: false } }), { mode: 0o600 });
  registerP2O(pi.pi, { createSandbox: sandboxFactory([]), herdr: createSimpleHerdr().client, settingsPath, controlRoot: join(root, 'control'), extensionPath: EXTENSION_PATH });
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
  it('writes one planner.stalled per turn-final round, and not for an intermediate tool step or an open intent', async () => {
    const h = await harness();
    try {
      await h.start();
      // P5.1/P18/D48: a turn that ends before the first wake is not a campaign round, so admit round 1 through the same
      // automatic path the engine uses (a committed semantic event plus the settle boundary continuation).
      await h.call('p2o_loop', { action: 'hint', text: 'Bounded fixture hint so the first wake admits a round' });
      expect(await h.emit('agent_before_settle', { outcome: 'completed', continue: false, context: { pendingMessages: [] } }))
        .toMatchObject({ continue: true });
      const round = async () => {
        await h.emit('context', { messages: [{ role: 'user', content: 'continue the assessment', timestamp: 0 }] });
        await h.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: 'no new intent' } });
      };
      const stalls = async () => (await h.records()).filter(row => row.kind === 'lifecycle' && (row.data?.engine as { event?: unknown } | undefined)?.event === 'planner.stalled');
      // No open goal → the round is not a stall.
      await round();
      expect(await stalls()).toHaveLength(0);
      // An active goal with no open/running intent → one durable stall fact.
      await h.call('p2o_goal_author', { entry: { kind: 'goal', title: 'Bound the fixture question', status: 'active', reason: 'A4 stall fixture goal', criteria: ['one bounded fixture observation'], proof: { kind: 'capability', capability: 'net.egress' } }, requestId: 'a4-goal' });
      await round();
      const first = await stalls();
      expect(first).toHaveLength(1);
      expect(first[0].text).toContain('planner.stalled');
      // P5.1: an intermediate tool-calling assistant message does not end the round. The measured rerun recorded three
      // stalls 22 s apart inside one admitted round because every assistant step with no open intent was judged; only the
      // turn-final `stop` message decides, so a tool step records nothing and the following stop records the single fact.
      await h.emit('context', { messages: [{ role: 'user', content: 'continue the assessment', timestamp: 0 }] });
      await h.emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse', content: 'calling a tool' } });
      expect(await stalls()).toHaveLength(1);
      await round();
      expect(await stalls()).toHaveLength(2);
      // A proposed intent is open work, so the same round is not a stall.
      await h.call('p2o_task_author', { draft: { question: 'Does the bounded fixture observation match the declared policy?', surface: '/a', risk: 'authorization', role: 'recon', evidenceIds: [], prerequisites: [] } });
      await round();
      expect(await stalls()).toHaveLength(2);
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
    expect(body).toContain('Mode and role matrix: manual loop / shared executor; planner 21 tools (no target or claim tool), worker 19, validation 18, reporter 6 (read-only)');
  });
});
