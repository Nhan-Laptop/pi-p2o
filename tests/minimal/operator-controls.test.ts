import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { registerP2O } from '../../extensions/p2o/index.js';
import { BrokerClient } from '../../src/broker.js';
import { AssessmentStore } from '../../src/state/store.js';
import { parseOperatorCommand } from '../../src/ui/operator.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

/**
 * W2 (plan): human-only run controls. Inert sandbox and in-memory Herdr; real SQLite store and real Unix broker.
 * `hold` closes the target-operation gate (broker, owner tools, executor queue, worker launch); it never touches models, scope or budgets.
 */
const draft = { question: 'Inspect the fixture boundary', surface: 'fixture', risk: 'policy', role: 'general', roleReason: 'Controlled local fixture observation', expectedTrue: 'Specific observable support', expectedFalse: 'Specific contradictory support', stopCondition: 'Stop after the bounded observation', evidenceIds: [], prerequisites: [], skills: [], methodReason: 'Controlled inert fixture, not security proof' };

async function fixture(work: (h: any) => Promise<void>, settings?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-operator-'));
  await mkdir(join(root, 'source'));
  const pi = createFakePi(), ctx = createContext({ cwd: root }), herdr = createSimpleHerdr(), sandboxes: InertSandbox[] = [];
  if (settings) await (await import('node:fs/promises')).writeFile(join(root, 'settings.json'), JSON.stringify(settings));
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'settings.json'), herdr: herdr.client,
    createSandbox: (target: any) => { const sandbox = new InertSandbox(target); sandboxes.push(sandbox); return sandbox; } });
  const command = (text: string) => pi.commands.get('p2o').handler(text, ctx.ctx);
  const call = (name: string, params: any = {}) => pi.tools.get(name).execute(randomUUID(), params, undefined, undefined, ctx.ctx);
  const screen = () => ctx.screens.at(-1).render(200).join('\n');
  const runId = async () => (await readdir(join(root, '.p2o-state')))[0];
  const reader = async () => AssessmentStore.open(join(root, '.p2o-state'), await runId());
  const ticket = async (id: string) => JSON.parse(await readFile(join(root, 'control', (await readdir(join(root, 'control')))[0], `ticket-${id}.json`), 'utf8'));
  const connect = async (workerId: string) => { const t = await ticket(workerId), client = new BrokerClient(t.socket, t.token); await client.request('runtime', { model: t.requestedRuntime?.model, thinking: t.requestedRuntime?.thinking }); return client; };
  try { await work({ root, pi, ctx, herdr, sandboxes, command, call, screen, runId, reader, ticket, connect }); }
  finally { await command('stop'); await command('close'); await rm(root, { recursive: true, force: true }); }
}
const spawn = async (h: any, focus: string) => (await h.call('p2o_delegate', { focus, task: 'Observe the inert fixture and report', role: 'discovery' })).details;
const kinds = async (h: any) => { const store: AssessmentStore = await h.reader(); try { return store.events({ limit: 100 }).rows; } finally { store.close(); } };

describe('operator command parsing', () => {
  it('accepts only the four human controls with bounded printable reasons and valid worker IDs', () => {
    expect(parseOperatorCommand('workers')).toEqual({ action: 'workers' });
    expect(parseOperatorCommand('hold')).toEqual({ action: 'hold', reason: 'Held by human' });
    expect(parseOperatorCommand('hold target is fragile now')).toEqual({ action: 'hold', reason: 'target is fragile now' });
    expect(parseOperatorCommand('release')).toEqual({ action: 'release' });
    expect(parseOperatorCommand('stop-worker worker-discovery-1 too noisy')).toEqual({ action: 'stop-worker', workerId: 'worker-discovery-1', reason: 'too noisy' });
    expect(parseOperatorCommand('stop-worker worker-discovery-1')).toEqual({ action: 'stop-worker', workerId: 'worker-discovery-1', reason: 'Withdrawn by human' });
    expect(parseOperatorCommand('status')).toBeUndefined(); expect(parseOperatorCommand('--target ./x')).toBeUndefined(); expect(parseOperatorCommand('stop')).toBeUndefined();
    for (const bad of ['workers now', 'release now', 'stop-worker', 'stop-worker ../x', 'stop-worker Worker_1', 'stop-worker a/b why', `hold ${'x'.repeat(501)}`, 'hold bad\u001b[31m', 'hold bidi‮reason'])
      expect(() => parseOperatorCommand(bad), bad).toThrow(/Usage|Reason/);
  });
});

describe('hold and release (inert executor, real broker)', () => {
  it('refuses new worker commands without spending budget, lets reporting through, and resumes after a confirmed release', async () => fixture(async h => {
    await h.command('--target ./source');
    const worker = await spawn(h, 'hold-a'), client = await h.connect(worker.workerId);
    try {
      expect((await client.request('exec', { command: 'before hold' })).ok).toBe(true);
      const usedBefore = (await client.request('status')).used;
      await h.command('hold the target is fragile');
      for (const op of ['exec', 'net']) await expect(client.request(op, { command: 'during hold' })).rejects.toThrow('TARGET_OPS_HELD');
      await expect(client.request('http', { method: 'GET', url: 'http://127.0.0.1/' })).rejects.toThrow();
      await expect(client.request('capture', { path: 'x.txt' })).rejects.toThrow('TARGET_OPS_HELD');
      expect((await client.request('status')).used).toBe(usedBefore); // refused before the allowance is touched
      expect(h.sandboxes[0].commands.filter((c: any) => c.command === 'during hold')).toHaveLength(0);
      await expect(spawn(h, 'hold-b')).rejects.toThrow('TARGET_OPS_HELD');
      expect((await h.call('p2o_loop', { action: 'status' })).details.paused).toBeUndefined(); // hold is not pause
      expect((await h.call('p2o_loop', { action: 'status' })).details.workers ?? true).toBeTruthy();
      const notes = (await client.request('note', { kind: 'observation', text: 'notes stay open while held' })); expect(notes.ok).toBe(true);
      await h.command('status'); expect(h.screen()).toContain('HOLD: new target commands and worker launches are refused until /p2o release — the target is fragile');
      let widget = ''; for (let i = 0; i < 100 && !widget.includes('HOLD:'); i++) { await delay(20); const factory = h.ctx.widgets.get('p2o-progress'); if (factory) widget = factory().render(120).join('\n'); }
      expect(widget).toContain('HOLD: the target is fragile'); // the widget is paced locally and updates without a model message
      h.ctx.setConfirm(false); await h.command('release'); await expect(client.request('exec', { command: 'still held' })).rejects.toThrow('TARGET_OPS_HELD'); // declined release keeps the gate
      h.ctx.setConfirm(true); await h.command('release');
      expect((await client.request('exec', { command: 'after release' })).ok).toBe(true);
      await client.request('report', { report: { summary: 'reported after the hold', confidence: 'low' } }); // reporting path never depended on the gate
      const events = await kinds(h);
      expect(events.filter(e => e.kind === 'run.held')).toHaveLength(1); expect(events.find(e => e.kind === 'run.held')).toMatchObject({ actorId: 'human', summary: expect.stringContaining('the target is fragile') });
      expect(events.filter(e => e.kind === 'run.released')).toHaveLength(1);
    } finally { client.close(); }
  }));

  it('also gates the solo owner path (shell, net, http, capture) and the Planner learns of the hold', async () => fixture(async h => {
    await h.command('--target ./source --solo');
    await h.call('p2o_shell', { command: 'echo before' });
    await h.command('hold');
    for (const [tool, params] of [['p2o_shell', { command: 'echo no' }], ['p2o_net', { command: 'echo no' }], ['p2o_capture', { path: 'a.txt' }]] as const)
      await expect(h.call(tool, params), tool).rejects.toThrow('TARGET_OPS_HELD');
    expect(h.sandboxes[0].commands.filter((c: any) => c.command === 'echo no')).toHaveLength(0);
    const context = await h.pi.events.get('context')[0]({ messages: [] }, h.ctx.ctx);
    const plannerState = context.messages.find((m: any) => m.customType === 'p2o_planner_state');
    expect(JSON.parse(plannerState.content.slice(plannerState.content.indexOf('{')))).toMatchObject({ operatorHold: 'Held by human' });
    await h.command('hold again'); expect(h.ctx.notices.at(-1)).toContain('Already held');
    h.ctx.setConfirm(true); await h.command('release'); await h.call('p2o_shell', { command: 'echo after' });
    expect(h.sandboxes[0].commands.map((c: any) => c.command)).toContain('echo after');
    await h.command('release'); expect(h.ctx.notices.at(-1)).toContain('No hold is active');
  }));

  it('stops a command that was queued for the executor before the hold, while a running one finishes', async () => fixture(async h => {
    await h.command('--target ./source');
    const first = await spawn(h, 'queue-a'), second = await spawn(h, 'queue-b'), a = await h.connect(first.workerId), b = await h.connect(second.workerId);
    try {
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const started: string[] = [];
      h.sandboxes[0].exec = async (command: string, _s: number, _signal: AbortSignal, _w: string, onRunning: () => void) => { started.push(command); onRunning(); if (command === 'long') await gate; return { code: 0, stdout: command, stderr: '', truncated: false }; };
      const running = a.request('exec', { command: 'long' }); for (let i = 0; i < 100 && !started.includes('long'); i++) await delay(5);
      const queued = b.request('exec', { command: 'queued-before-hold' }).then(() => 'ran', (error: Error) => error.message); await delay(40);
      await h.command('hold queued commands too');
      release();
      expect((await running).ok).toBe(true); // already running: allowed to finish, no data loss
      expect(await queued).toContain('TARGET_OPS_HELD');
      expect(started).toEqual(['long']);
    } finally { a.close(); b.close(); }
  }, 30_000));

  it('keeps accepted queued tasks waiting during a hold instead of dropping them, and admits them after release', async () => fixture(async h => {
    await h.command('--target ./source');
    await h.command('hold');
    const task = (await h.call('p2o_task', { action: 'create', draft })).details;
    await h.call('p2o_task', { action: 'dispatch', ids: [task.id] }); await delay(400);
    expect((await h.call('p2o_workers')).details.workers).toHaveLength(0);
    expect((await h.call('p2o_loop', { action: 'status' })).details.pendingIntents).toBe(1); // still accepted and queued, not invalidated
    h.ctx.setConfirm(true); await h.command('release');
    for (let i = 0; i < 100; i++) { if ((await h.call('p2o_workers')).details.workers.length) break; await delay(10); }
    expect((await h.call('p2o_workers')).details.workers).toHaveLength(1);
  }));

  it('does not trap the run: stop works during a hold, revokes the workers and verifies cleanup', async () => fixture(async h => {
    await h.command('--target ./source');
    const worker = await spawn(h, 'stop-under-hold'), client = await h.connect(worker.workerId);
    try {
      await h.command('hold stop must still work');
      await h.command('stop'); expect(h.ctx.notices.at(-1)).toContain('p2o stopped: sandbox removal verified');
      await expect(client.request('exec', { command: 'after stop' })).rejects.toThrow();
      const events = await kinds(h); expect(events.some(e => e.kind === 'run.held')).toBe(true); expect(events.some(e => e.kind === 'run.stopped')).toBe(true);
    } finally { client.close(); }
  }));
  it('is available only to the human: no tool exists for hold, release or approval, and a worker session cannot use the commands', async () => fixture(async h => {
    expect([...h.pi.tools.keys()].filter((name: string) => /hold|release|approve/.test(name))).toEqual([]);
    expect(h.pi.tools.has('p2o_stop_worker')).toBe(true); // the model's own withdrawal tool remains
    await h.command('hold'); expect(h.ctx.notices.at(-1)).toContain('No active assessment');
    await h.command('workers'); expect(h.ctx.notices.at(-1)).toContain('No active assessment');
  }));
});

describe('stop-worker and workers (human)', () => {
  it('lists workers, confirms before withdrawing one, revokes its access and keeps the others', async () => fixture(async h => {
    await h.command('--target ./source');
    const first = await spawn(h, 'stop-a'), second = await spawn(h, 'stop-b'), a = await h.connect(first.workerId), b = await h.connect(second.workerId);
    try {
      await h.command('workers'); expect(h.screen()).toContain('Workers 2'); expect(h.screen()).toContain(first.workerId); expect(h.screen()).toContain(second.workerId);
      h.ctx.setConfirm(false); await h.command(`stop-worker ${first.workerId} not needed`);
      expect((await a.request('exec', { command: 'still allowed' })).ok).toBe(true); expect(h.ctx.notices.at(-1)).toContain('Worker kept');
      expect(h.ctx.confirmBodies.at(-1)).toContain('Shared executor');
      let aborted = false;
      h.sandboxes[0].exec = async (command: string, _s: number, signal: AbortSignal, _w: string, onRunning: () => void) => {
        onRunning(); if (command !== 'in-flight') return { code: 0, stdout: command, stderr: '', truncated: false };
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted by revoke')); }, { once: true }));
        return { code: 0, stdout: '', stderr: '', truncated: false };
      };
      const inFlight = a.request('exec', { command: 'in-flight' }).then(() => 'completed', (error: Error) => error.message); await delay(60);
      h.ctx.setConfirm(true); await h.command(`stop-worker ${first.workerId} not needed`);
      expect(h.ctx.notices.at(-1)).toContain(`Stopped ${first.workerId}`);
      expect(aborted).toBe(true); expect(await inFlight).not.toBe('completed'); // the withdrawal cancels the operation that was running
      await expect(a.request('exec', { command: 'revoked' })).rejects.toThrow();
      expect((await b.request('exec', { command: 'peer unaffected' })).ok).toBe(true);
      await h.command('workers'); expect(h.screen()).toMatch(new RegExp(`Workers: live 1/3 slots \\(quiet 0\\) \\| reported 0 \\| stopped 1`));
      expect(h.herdr.calls.some((c: any) => c.op === 'close')).toBe(true);
      await h.command(`stop-worker ${first.workerId}`); expect(h.ctx.notices.at(-1)).toContain('already stopped');
      await h.command('stop-worker worker-nobody-9'); expect(h.ctx.notices.at(-1)).toContain('No worker worker-nobody-9');
      const store: AssessmentStore = await h.reader(); try { expect(store.records().some(r => r.kind === 'lifecycle' && r.text.includes(`stopped ${first.workerId}: human: not needed`))).toBe(true); } finally { store.close(); }
    } finally { a.close(); b.close(); }
  }));
});
