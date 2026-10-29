import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerP2O, testSeamFor } from '../../extensions/p2o/index.js';
import { BrokerClient } from '../../src/broker.js';
import { AssessmentStore } from '../../src/state/store.js';
import { USAGE_ACTORS, USAGE_REPORTS_PER_ACTOR, UsageLedger, compactUsage, usageDelta, usageLines } from '../../src/usage.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

/** W6a (plan): usage is displayed, never limited. Counters come from Pi's per-message `usage`; absence is `unknown`, not zero or an estimate. */
const usage = (over: Record<string, unknown> = {}, cost = 0.01) => ({ input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, reasoning: 80, totalTokens: 1550, cost: { input: 0.004, output: 0.004, cacheRead: 0.001, cacheWrite: 0.001, total: cost }, ...over });

describe('usage counters', () => {
  it('sums validated counters per role and counts messages without usable usage as unknown instead of zero or an estimate', () => {
    const ledger = new UsageLedger();
    ledger.record('planner', 'planner', usage()); ledger.record('planner', 'planner', usage({ input: 10, output: 5, totalTokens: 15 }, 0.002));
    ledger.record('worker-discovery-1', 'discovery', usage()); ledger.record('worker-discovery-2', 'discovery', usage());
    for (const bad of [undefined, null, 'x', {}, usage({ input: -1 }), usage({ output: Number.NaN }), usage({ cacheRead: '3' }), usage({ totalTokens: Infinity }), usage({ input: 1e13 })]) ledger.record('worker-discovery-2', 'discovery', bad);
    const roles = Object.fromEntries(ledger.byRole().map(role => [role.role, role]));
    expect(roles.planner).toMatchObject({ actors: 1, messages: 2, unknownMessages: 0, input: 1010, output: 205, totalTokens: 1565, priced: 2 });
    expect(roles.planner.cost).toBeCloseTo(0.012, 6);
    expect(roles.discovery).toMatchObject({ actors: 2, messages: 2, unknownMessages: 9, input: 2000 }); // the nine malformed reports added nothing to any sum
    expect(ledger.totals()).toMatchObject({ messages: 4, unknownMessages: 9, input: 3010 });
  });

  it('keeps an unpriced model unpriced and never shows an estimate as a measurement', () => {
    const ledger = new UsageLedger(); ledger.record('planner', 'planner', usage({}, 0));
    expect(ledger.totals()).toMatchObject({ messages: 1, priced: 0, cost: 0 });
    const text = usageLines(ledger).join('\n'); expect(text).toContain('in 1,000'); expect(text).not.toContain('cost as priced'); expect(text).toContain('no cap, no retry, no limit');
    expect(usageLines(new UsageLedger())[0]).toContain('nothing reported yet');
    expect(usageLines((() => { const l = new UsageLedger(); l.record('p', 'planner', undefined); return l; })()).join('\n')).toContain('1 message(s) with no usage reported');
  });

  it('forwards only validated numbers from a worker and bounds actors and reports without ever throwing', () => {
    expect(compactUsage({ ...usage(), secret: 'x', text: 'leak' })).toEqual({ input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, reasoning: 80, totalTokens: 1550, cost: { total: 0.01 } });
    expect(compactUsage({ input: 'a' })).toBeUndefined(); expect(usageDelta(usage())).toMatchObject({ priced: 1 });
    const ledger = new UsageLedger();
    for (let n = 0; n < USAGE_ACTORS; n++) expect(ledger.record(`a-${n}`, 'discovery', usage())).toBe(true);
    expect(ledger.record('one-too-many', 'discovery', usage())).toBe(false); expect(ledger.rows()).toHaveLength(USAGE_ACTORS);
    const single = new UsageLedger(); for (let n = 0; n < USAGE_REPORTS_PER_ACTOR; n++) single.record('w', 'discovery', undefined);
    expect(single.record('w', 'discovery', usage())).toBe(false); expect(single.totals().messages).toBe(0);
  });
});

async function fixture(work: (h: any) => Promise<void>, args = '') {
  const root = await mkdtemp(join(tmpdir(), 'p2o-usage-')); await mkdir(join(root, 'source'));
  const pi = createFakePi(), ctx = createContext({ cwd: root }), herdr = createSimpleHerdr(), sandboxes: InertSandbox[] = [];
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'settings.json'), herdr: herdr.client, createSandbox: (target: any) => { const sandbox = new InertSandbox(target); sandboxes.push(sandbox); return sandbox; } });
  // S1/B10: the hidden delegate/task-start verbs are gone; the harness runs their code through the registration seam.
  const seam = (name: string, params: any) => name === 'p2o_delegate' ? testSeamFor(pi.pi).spawn(params) : name === 'p2o_task_start' ? testSeamFor(pi.pi).startTask(params) : undefined;
  const command = (text: string) => pi.commands.get('p2o').handler(text, ctx.ctx), call = (name: string, params: any = {}) => seam(name, params) ?? pi.tools.get(name).execute(randomUUID(), params, undefined, undefined, ctx.ctx);
  const screen = () => ctx.screens.at(-1).render(220).join('\n');
  const emit = async (event: string, payload: any) => { for (const handler of pi.events.get(event) ?? []) await handler(payload, ctx.ctx); };
  const assistant = (extra: Record<string, unknown>) => emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'inert' }], stopReason: 'stop', ...extra } });
  const ticket = async (id: string) => JSON.parse(await readFile(join(root, 'control', (await readdir(join(root, 'control')))[0], `ticket-${id}.json`), 'utf8'));
  const connect = async (workerId: string) => { const t = await ticket(workerId), client = new BrokerClient(t.socket, t.token); await client.request('runtime', { model: t.requestedRuntime?.model, thinking: t.requestedRuntime?.thinking }); return client; };
  const events = async () => { const store = AssessmentStore.open(join(root, '.p2o-state'), (await readdir(join(root, '.p2o-state')))[0]); try { return store.events({ limit: 100 }).rows; } finally { store.close(); } };
  try { await command(`--target ./source ${args}`); await work({ root, pi, ctx, command, call, screen, assistant, emit, connect, events, sandboxes }); }
  finally { await command('stop'); await command('close'); await rm(root, { recursive: true, force: true }); }
}

describe('usage in a running assessment', () => {
  it('shows the Planner usage in status, counts failed and unreported messages, ignores other roles and never limits work', async () => fixture(async h => {
    await h.command('status'); expect(h.screen()).toContain('Model usage: nothing reported yet');
    await h.assistant({ usage: usage() }); await h.assistant({ usage: usage({ input: 5, output: 5, totalTokens: 10 }), stopReason: 'error' }); await h.assistant({}); // errored and unreported messages
    await h.emit('message_end', { message: { role: 'user', content: 'hello', usage: usage() } }); await h.emit('message_end', { message: { role: 'toolResult', usage: usage() } });
    await h.command('status');
    expect(h.screen()).toContain('planner: 2 message(s): in 1,005 · out 205'); expect(h.screen()).toContain('1 message(s) with no usage reported'); expect(h.screen()).toContain('cost as priced by Pi 0.0200');
    for (let n = 0; n < 50; n++) await h.assistant({ usage: usage({ input: 9e11, output: 9e11, totalTokens: 1.8e12 }) }); // absurd spend is displayed, never acted on
    expect((await h.call('p2o_delegate', { focus: 'still-allowed', task: 'Usage never gates delegation or commands', role: 'discovery' })).details.workerId).toBeTruthy();
    expect((await h.call('p2o_workers', {})).details.engine.paused).toBeUndefined();
  }, ''));

  it('collects worker usage over the authenticated broker, attributes it by registration, spends no command budget and is allowed for every role', async () => fixture(async h => {
    const first = (await h.call('p2o_delegate', { focus: 'usage-a', task: 'Observe the inert fixture and report', role: 'discovery' })).details;
    const second = (await h.call('p2o_delegate', { focus: 'usage-b', task: 'Synthesize existing receipts', role: 'reporting' })).details;
    const a = await h.connect(first.workerId), b = await h.connect(second.workerId);
    try {
      const before = (await a.request('status')).used;
      expect((await a.request('usage', { usage: compactUsage(usage()) })).recorded).toBe(true);
      expect((await a.request('usage', { usage: { ...compactUsage(usage()), actor: 'planner', role: 'planner' } })).recorded).toBe(true); // forged attribution fields are ignored
      expect((await a.request('usage', { usage: 'not an object' })).recorded).toBe(true); // recorded as unknown, not rejected
      expect((await b.request('usage', { usage: compactUsage(usage({ input: 7, output: 7, totalTokens: 14 }, 0)) })).recorded).toBe(true);
      expect((await a.request('status')).used).toBe(before); // no command allowance is touched
      await h.command('status'); const screen = h.screen();
      expect(screen).toContain('discovery: 2 message(s)'); expect(screen).toContain('1 message(s) with no usage reported');
      expect(screen).toContain('reporting: 1 message(s): in 7 · out 7'); expect(screen).not.toMatch(/planner:/); // nothing was credited to the Planner by a worker
      expect(screen).toContain('total:');
    } finally { a.close(); b.close(); }
  }));

  it('keeps what a worker reported when it is withdrawn, rejects reports after revocation, and writes one bounded summary event at the end', async () => fixture(async h => {
    const worker = (await h.call('p2o_delegate', { focus: 'usage-kept', task: 'Observe the inert fixture and report', role: 'discovery' })).details, client = await h.connect(worker.workerId);
    await h.assistant({ usage: usage() });
    try {
      await client.request('usage', { usage: compactUsage(usage()) });
      h.ctx.setConfirm(true); await h.command(`stop-worker ${worker.workerId} done`);
      await expect(client.request('usage', { usage: compactUsage(usage()) })).rejects.toThrow(); // revoked sessions cannot add more
    } finally { client.close(); }
    await h.command('status'); expect(h.screen()).toContain('discovery: 1 message(s)');
    await h.command('stop');
    const summary = (await h.events()).filter((event: any) => event.kind === 'usage.reported');
    expect(summary).toHaveLength(1); expect(summary[0].data.usage.totals).toMatchObject({ messages: 2, input: 2000 });
    expect(summary[0].data.usage.roles.map((role: any) => role.role).sort()).toEqual(['discovery', 'planner']);
    expect(JSON.stringify(summary[0])).not.toMatch(/inert|leak|secret/); expect(Buffer.byteLength(JSON.stringify(summary[0]))).toBeLessThan(16 * 1024);
  }));

  it('writes no summary event when no usage was ever reported', async () => fixture(async h => {
    await h.command('stop'); expect((await h.events()).filter((event: any) => event.kind === 'usage.reported')).toHaveLength(0);
  }));
});
