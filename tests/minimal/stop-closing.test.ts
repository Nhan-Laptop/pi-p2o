import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { registerP2O } from '../../extensions/p2o/index.js';
import { BrokerClient } from '../../src/broker.js';
import { AssessmentStore } from '../../src/state/store.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';
import { seedImpactGoal } from './helpers/report-fixture.js';

/**
 * P18.7/D47: an operator stop is an evidence-preserving transition, not a kill. An in-flight round is paused so it can settle
 * (never nudged to continue), closed as `planner.round-end reason=operator-stop`, and live workers get a bounded window to
 * write the blocked report their own settle produces. The tests drive the real extension on the fake host: no model, no
 * Docker, no target traffic, no Herdr server.
 */
async function fixture(work: (h: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-stop-closing-'));
  await mkdir(join(root, 'source'));
  const pi = createFakePi(), ctx = createContext({ cwd: root }), herdr = createSimpleHerdr(), sandboxes: InertSandbox[] = [];
  // A bound command context is what makes the fake host dispatch the round opener and replace a session; without it the round
  // arrives as the in-session follow-up shape, which is the control arm exercised by the planner tests.
  pi.bind(ctx.ctx);
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'fixture-settings.json'), herdr: herdr.client, createSandbox: sandboxFactory(sandboxes) });
  const call = (name: string, params = {}) => pi.tools.get(name).execute('call', params, undefined, undefined, ctx.ctx);
  const command = (text: string) => pi.commands.get('p2o').handler(text, ctx.ctx);
  const emit = async (name: string, event: any = {}) => { let result: any; for (const handler of pi.events.get(name) ?? []) result = await handler(event, ctx.ctx); return result; };
  // After cleanup the private control directory is gone; the durable store is the retained ledger, so every assertion reads
  // the same records the run committed, whether the run is still active or already stopped.
  const records = async () => {
    const runId = (await readdir(join(root, '.p2o-state')))[0], store = AssessmentStore.open(join(root, '.p2o-state'), runId);
    try { return store.records(); } finally { store.close(); }
  };
  const connect = async (workerId: string) => {
    const control = join(root, 'control', (await readdir(join(root, 'control')))[0]);
    const ticket = JSON.parse(await readFile(join(control, `ticket-${workerId}.json`), 'utf8'));
    return new BrokerClient(ticket.socket, ticket.token);
  };
  const clients: BrokerClient[] = [];
  try {
    await command('--target ./source');
    await seedImpactGoal({ call, emit, pi, ctx });
    await work({ root, pi, ctx, herdr, sandboxes, call, command, emit, records, connect, clients });
  } finally {
    for (const client of clients) client.close();
    await command('stop');
    await command('close');
    await rm(root, { recursive: true, force: true });
  }
}
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 400; attempt++) { if (await predicate()) return; await delay(20); }
  throw Error('Fixture did not progress');
}
const eventRows = async (h: any, event: string) => ((await h.records()) as any[]).filter(row => row.data?.engine?.event === event);
async function handOff(h: any) {
  const spawned = (await h.call('p2o_delegate', { focus: 'stop-closing-fixture', task: 'Bounded observation before an operator stop' })).details;
  const client = await h.connect(spawned.workerId); h.clients.push(client);
  await client.request('report', { report: { summary: 'Bounded observation complete', confidence: 'low' } });
  return spawned;
}

describe('Operator stop closes the round instead of killing it (P18.7/D47)', () => {
  it('pauses the loop, lets the in-flight round settle and records the operator end instead of nudging it', async () => {
    await fixture(async h => {
      await handOff(h);
      await until(() => h.pi.sessions.length === 1);
      await h.emit('agent_start'); h.ctx.setIdle(false);
      const stopping = h.command('stop');
      // The stop paused the loop before waiting: the round must not be extended by the settlement nudge or by the P17 fallback
      // continuation, or the stop would never settle. Both drafts are suppressed by the stop marker, not by timing.
      expect(await h.emit('agent_before_settle', { outcome: 'completed', context: { pendingMessages: [], contextMessages: [] } })).toBeUndefined();
      await h.emit('agent_settled');
      await stopping;
      const ends = await eventRows(h, 'planner.round-end');
      expect(ends).toHaveLength(1);
      expect(ends[0].data.engine).toMatchObject({ round: 1, reason: 'operator-stop', settled: true });
      expect(await eventRows(h, 'planner.round-nudge')).toEqual([]);
      // Cleanup still verifies the sandbox and restores the ordinary tools; no authority survives the stop.
      expect(h.sandboxes[0].stopCount).toBe(1);
      expect(h.pi.active).toContain('bash');
      await expect(h.call('p2o_shell', { command: 'id' })).rejects.toThrow(/No active p2o assessment/);
      expect(h.ctx.notices.at(-1)).toContain('the in-flight round settled and recorded its end');
    });
  });

  it('drains a worker report inside the bounded stop window and commits it before cleanup', async () => {
    await fixture(async h => {
      const spawned = (await h.call('p2o_delegate', { focus: 'stop-drain-fixture', task: 'Bounded observation under a stop drain' })).details;
      const client = await h.connect(spawned.workerId); h.clients.push(client);
      const stopping = h.command('stop');
      // The stop interrupted the live pane and is waiting for the blocked report its own settle produces; delivering it now is
      // exactly what the 90 s window exists for, and it must reach the ledger before the hard teardown.
      await client.request('report', { report: { summary: 'Stopped worker wrote back before teardown', confidence: 'low' } });
      await stopping;
      expect(await eventRows(h, 'planner.round-end')).toEqual([]);
      const reports = ((await h.records()) as any[]).filter(row => row.kind === 'report');
      expect(reports.length).toBeGreaterThanOrEqual(1);
      expect(reports.some(row => String(row.text).includes('wrote back before teardown'))).toBe(true);
      expect(h.ctx.notices.at(-1)).toContain('worker report(s) drained after the stop request');
      expect(h.sandboxes[0].stopCount).toBe(1);
      await expect(h.call('p2o_shell', { command: 'id' })).rejects.toThrow(/No active p2o assessment/);
    });
  });

  it('keeps the hard path when no round is in flight: no closing-round record and a verified cleanup', async () => {
    await fixture(async h => {
      await h.command('stop');
      // Nothing was running, so no round-end fact is invented for a round that never existed.
      expect(await eventRows(h, 'planner.round-end')).toEqual([]);
      expect(h.sandboxes[0].stopCount).toBe(1);
      expect(h.ctx.notices.at(-1)).toContain('p2o stopped: sandbox removal verified');
    });
  });
});
