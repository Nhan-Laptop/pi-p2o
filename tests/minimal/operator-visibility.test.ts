import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { visibleWidth } from '@earendil-works/pi-tui';
import { registerP2O, testSeamFor } from '../../extensions/p2o/index.js';
import { indexRecords } from '../../src/records.js';
import { AssessmentStore, type StoreManifest } from '../../src/state/store.js';
import { eventLines } from '../../src/ui/workspace.js';
import { parseStateCommand, statusView, type ViewProfile, type WorkerView } from '../../src/ui/state.js';
import { widgetComponent } from '../../src/ui/screen.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, type InertSandbox } from './helpers/fake-pi.js';

/** W1 (plan): human log filters and the worker panel. Read-only views; none of them may call a model or touch the target. */
const manifest: StoreManifest = { runId: 'run-w1', retention: 'durable-local', targetKind: 'directory', targetIdentity: 'w1', targetDisplay: 'inert fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } };

async function withStore(work: (store: AssessmentStore, root: string) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-w1-')), store = AssessmentStore.create(join(root, 'state'), manifest);
  try { await work(store, root); } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}
const event = (store: AssessmentStore, actorId: string, taskId: string | undefined, operationId: string | undefined, n: number) =>
  store.event({ actorId, kind: 'operation.started', occurredAt: '2030', summary: `marker-${n} ${actorId}`, ...(taskId ? { taskId } : {}), ...(operationId ? { operationId } : {}) });
const rowsOf = (lines: string[]) => lines.filter(line => /^\d+ /.test(line));

describe('/p2o log filters', () => {
  it('parses task/actor/operation filters with an optional cursor in any order and rejects everything else', () => {
    expect(parseStateCommand('log')).toEqual({ action: 'log' });
    expect(parseStateCommand('log 0')).toEqual({ action: 'log', cursor: 0 });
    expect(parseStateCommand('log task=task-1 actor=worker-a 7')).toEqual({ action: 'log', cursor: 7, taskId: 'task-1', actorId: 'worker-a' });
    expect(parseStateCommand('log 3 operation=op:1.x')).toEqual({ action: 'log', cursor: 3, operationId: 'op:1.x' });
    for (const bad of ['log 1 2', 'log task=a task=b', 'log task=', 'log task=../x', 'log task=a/b', 'log kind=x', 'log task', 'log actor=a;rm', `log task=${'a'.repeat(81)}`, 'log -1', 'log 1.5', 'log operation=a b'])
      expect(() => parseStateCommand(bad), bad).toThrow(/Usage|Cursor/);
  });

  it('keeps the unfiltered view unchanged and shows the newest matching events for a filtered default', async () => {
    await withStore(store => {
      for (let n = 0; n < 60; n++) event(store, n % 3 === 0 ? 'worker-a' : 'worker-b', n % 3 === 0 ? 'task-a' : undefined, n % 2 === 0 ? 'op-even' : undefined, n);
      const plain = eventLines(store);
      expect(plain[0]).toBe(`Committed checklog @60; cursor 40; matching total 20, displayed 20, omitted 0`);
      expect(plain.at(-1)).toBe('Stable sequence cursor; timestamps are not authority. Use /p2o log 0 for all retained events.');
      expect(rowsOf(plain)).toHaveLength(20);

      const mine = eventLines(store, undefined, { actorId: 'worker-a' });
      expect(mine[0]).toContain('matching total 20, displayed 20, omitted 0; filter actor=worker-a');
      expect(rowsOf(mine).every(line => line.includes('actor=worker-a'))).toBe(true);
      const tail = eventLines(store, undefined, { actorId: 'worker-b' }); // 40 matching, newest 20 shown
      expect(tail[0]).toContain('matching total 40, displayed 20, omitted 20; filter actor=worker-b');
      expect(tail).toContain('Showing the newest 20 matching events; /p2o log 0 actor=worker-b pages from the oldest.');
      expect(rowsOf(tail).map(line => Number(line.split(' ')[0]))).toEqual([...rowsOf(tail).map(line => Number(line.split(' ')[0]))].sort((a, b) => a - b));
      expect(rowsOf(tail).at(-1)).toContain('marker-59'); expect(tail.some(line => line.startsWith('Next:'))).toBe(false);
    });
  });

  it('pages a filtered view forward with an exact total, a stable cursor and the filter carried in Next', async () => {
    await withStore(store => {
      for (let n = 0; n < 50; n++) event(store, n % 2 ? 'worker-a' : 'owner', n % 2 ? 'task-1' : 'task-2', undefined, n);
      let cursor = 0; const seen: number[] = [];
      for (let guard = 0; guard < 5; guard++) {
        const page = eventLines(store, cursor, { taskId: 'task-1' });
        expect(page[0]).toContain('matching total'); const total = Number(/matching total (\d+)/.exec(page[0])![1]);
        expect(total).toBeLessThanOrEqual(25); seen.push(...rowsOf(page).map(line => Number(line.split(' ')[0])));
        const next = page.find(line => line.startsWith('Next:'));
        if (!next) break;
        expect(next).toMatch(/^Next: \/p2o log \d+ task=task-1$/); cursor = Number(/log (\d+)/.exec(next)![1]);
      }
      expect(seen).toHaveLength(25); expect(new Set(seen).size).toBe(25); expect(seen).toEqual([...seen].sort((a, b) => a - b));
      expect(eventLines(store, 0, { taskId: 'no-such-task' })[0]).toContain('matching total 0, displayed 0, omitted 0; filter task=no-such-task');
    });
  });

  it('refuses malformed filters at the store and answers filtered counts from the existing indexes', async () => {
    await withStore(async (store, root) => {
      for (let n = 0; n < 5; n++) event(store, 'worker-a', 'task-1', 'op-1', n);
      expect(() => store.events({ actorId: '../x' })).toThrow('Invalid event filter');
      expect(() => eventLines(store, undefined, { taskId: "x' OR 1=1 --" })).toThrow('Invalid event filter');
      const database = new DatabaseSync(join(root, 'state', manifest.runId, 'assessment.sqlite'), { readOnly: true });
      try {
        for (const [column, index] of [['actor_id', 'events_actor'], ['task_id', 'events_task'], ['operation_id', 'events_operation']] as const) {
          const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT count(*) FROM events WHERE sequence>? AND sequence<=? AND ${column}=?`).all(0, 10, 'x').map(row => String(row.detail)).join(' | ');
          expect(plan, column).toContain(index);
        }
      } finally { database.close(); }
    });
  });
});

describe('worker panel in status and widget', () => {
  const profile = (workers: WorkerView[]): ViewProfile => ({ runId: 'run-x', target: 'fixture', lifecycle: 'active', delegation: true, maxWorkers: 3, exportEnabled: false,
    engine: { mode: 'manual', pendingIntents: 0, rounds: 0, paused: undefined, decision: undefined } as ViewProfile['engine'], executor: { mode: 'shared', maxTargetOperations: 1 }, retention: 'ephemeral', workers });
  const worker = (over: Partial<WorkerView>): WorkerView => ({ id: 'worker-discovery-1', role: 'discovery', taskId: 'task-1', state: 'running', commandsUsed: 12, idleMs: 4_000, quiet: false, reported: false, stopped: false, ...over });

  it('lists live workers with state, command count and idle age, flags quiet ones as observation only, and stays compact in the widget', () => {
    const view = statusView(indexRecords([]), profile([worker({}), worker({ id: 'worker-recon-2', role: 'recon', taskId: undefined, state: 'queued', idleMs: 4 * 60_000 + 5_000, quiet: true }), worker({ id: 'worker-validation-3', reported: true, state: 'reported' }), worker({ id: 'worker-general-4', stopped: true, state: 'stopped' })]));
    const text = view.lines.join('\n');
    expect(text).toContain('Workers: live 2/3 slots (quiet 1) | reported 1 | stopped 1');
    expect(text).toContain('worker-discovery-1 · discovery · task task-1 · running · 12 cmds · idle 4s');
    expect(text).toContain('worker-recon-2 · recon · task none · queued · 12 cmds · idle 4m · QUIET');
    expect(text).not.toContain('worker-validation-3 ·'); // finished workers are counted, not listed
    expect(text).toContain('not proof of failure, not a timeout and wakes no model');
    expect(view.widget.join('\n')).toContain('Workers: live 2 (quiet 1) | reported 1');
    expect(view.widget.length).toBeLessThanOrEqual(8);
    expect(widgetComponent(view.widget).render(40).every(line => visibleWidth(line) <= 40)).toBe(true);
  });

  it('omits the panel without workers, caps the listing and neutralizes control characters in worker-supplied labels', () => {
    expect(statusView(indexRecords([]), profile([])).lines.join('\n')).not.toContain('Workers:');
    const many = Array.from({ length: 30 }, (_, n) => worker({ id: `worker-discovery-${n}`, state: 'running' }));
    const lines = statusView(indexRecords([]), profile(many)).lines;
    expect(lines.filter(line => line.startsWith('  worker-discovery-'))).toHaveLength(12);
    expect(lines.join('\n')).toContain('… 18 more live workers; /p2o log actor=<worker-id>');
    const hostile = statusView(indexRecords([]), profile([worker({ taskId: 'task\u001b[31m-x', role: 'dis\ncovery' })])).lines.join('\n');
    expect(hostile).not.toContain('\u001b'); expect(hostile).not.toMatch(/dis\ncovery/);
  });
});

describe('runtime commands (no model, no target work)', () => {
  it('filters the live checklog and lists a spawned worker without calling a model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-w1-run-'));
    await mkdir(join(root, 'source'));
    const pi = createFakePi(), ctx = createContext({ cwd: root }), herdr = createSimpleHerdr(), sandboxes: InertSandbox[] = [];
    registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'nonexistent-test-settings.json'), herdr: herdr.client, createSandbox: sandboxFactory(sandboxes) });
    // S1/B10: the hidden delegate/task-start verbs are gone; the harness runs their code through the registration seam.
    const seam = (name: string, params: any) => name === 'p2o_delegate' ? testSeamFor(pi.pi).spawn(params) : name === 'p2o_task_start' ? testSeamFor(pi.pi).startTask(params) : undefined;
    const command = (text: string) => pi.commands.get('p2o').handler(text, ctx.ctx), call = (name: string, params = {}) => seam(name, params) ?? pi.tools.get(name).execute('call', params, undefined, undefined, ctx.ctx);
    const screen = () => ctx.screens.at(-1).render(160).join('\n');
    try {
      await command('--target ./source'); expect(pi.messages).toHaveLength(1);
      const spawned = (await call('p2o_delegate', { focus: 'panel', task: 'Observe the inert fixture boundary and report', role: 'discovery' })).details;
      const taskId = (await readdir(join(root, 'control'))).length ? spawned.taskId ?? undefined : undefined;
      await command('status'); expect(screen()).toContain('Workers: live 1/3 slots (quiet 0) | reported 0 | stopped 0'); expect(screen()).toContain(`${spawned.workerId} · discovery`);
      await command(`log actor=${spawned.workerId}`); expect(screen()).toContain(`filter actor=${spawned.workerId}`);
      await command('log actor=nobody'); expect(screen()).toContain('matching total 0, displayed 0, omitted 0; filter actor=nobody');
      await command('log task=../x'); expect(ctx.notices.at(-1)).toContain('Usage: /p2o log');
      if (taskId) { await command(`log task=${taskId}`); expect(screen()).toContain(`filter task=${taskId}`); }
      expect(pi.messages).toHaveLength(1); // no extra model prompt from any read-only view
    } finally { await command('stop'); await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it('shows the Planner context usage Pi reports as a measurement, unknown when Pi gives none, and never starts a model turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-w1-ctx-'));
    await mkdir(join(root, 'source'));
    const pi = createFakePi(), ctx = createContext({ cwd: root }), herdr = createSimpleHerdr(), sandboxes: InertSandbox[] = [];
    registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'nonexistent-test-settings.json'), herdr: herdr.client, createSandbox: sandboxFactory(sandboxes) });
    const command = (text: string) => pi.commands.get('p2o').handler(text, ctx.ctx), screen = () => ctx.screens.at(-1).render(200).join('\n');
    const emit = async (event: string, payload: any, context: any) => { let result: any; for (const handler of pi.events.get(event) ?? []) result = await handler(payload, context); return result; };
    try {
      await command('--target ./source'); const messages = pi.messages.length;
      await command('status'); expect(screen()).toContain('Planner context: not reported yet; measurement only');
      expect(screen()).toMatch(/Runtime: p2o \S+ · [0-9a-f]{12} \(digest of the entry file \+ src closure; identifies code, not safety\)/);
      await emit('context', { messages: [] }, { ...ctx.ctx, getContextUsage: () => ({ tokens: 1234, contextWindow: 10_000, percent: 12.34 }) });
      await command('status'); expect(screen()).toContain('Planner context: 12% (1234 of 10000 tokens) at the last request; measurement only, p2o never compacts or summarizes');
      await emit('context', { messages: [] }, { ...ctx.ctx, getContextUsage: () => ({ tokens: null, contextWindow: 10_000, percent: null }) });
      await command('status'); expect(screen()).toContain('Planner context: unknown right now (window 10000 tokens)');
      await emit('context', { messages: [] }, { ...ctx.ctx, getContextUsage: () => { throw new Error('usage unavailable'); } });
      await command('status'); expect(screen()).toContain('unknown right now'); // a failing probe keeps the previous reading and never throws into the turn
      expect(pi.messages).toHaveLength(messages); // measurement only
    } finally { await command('stop'); await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});
