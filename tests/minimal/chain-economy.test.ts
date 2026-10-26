import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { Broker, BrokerClient, consumeHeldContinuation, continuationRefusal, normalizeReport, type WorkerRegistration } from '../../src/broker.js';
import { finishPreflight } from '../../src/finish-preflight.js';
import { indexRecords } from '../../src/records.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, InertSandbox, type FakePi } from './helpers/fake-pi.js';
import { fixture as reportFixture, seedClaim } from './helpers/report-fixture.js';

/**
 * A7.5/D19 (planning_update.md P7.6): the chain economy. Reusing a reported worker's ticket, pane and session is how a second
 * step is cheap; it is never a parking spot and it never buys a second replay. Hermetic: inert sandboxes, no model, no target.
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const registration = (patch: Partial<WorkerRegistration> = {}): WorkerRegistration => ({
  workerId: 'p2o-general-aaaaaa', name: 'p2o-general-aaaaaa', paneId: 'w1T:p9', role: 'general', depth: 1,
  parentWorkerId: null, token: 'c'.repeat(32), used: 0, startedAt: Date.now(), stopped: false, ...patch,
});

/** The exact registration state a committed report-with-hold leaves behind (the broker's own commit path is asserted below). */
const held = (brief: string): WorkerRegistration => {
  const value = registration({ reported: normalizeReport({ summary: 'held report', confidence: 'high', holdFor: { brief } }) });
  value.holdBrief = value.reported!.holdFor!.brief;
  value.holdConsumed = false;
  return value;
};

describe('A7.5 hold state machine (pure)', () => {
  it('allows a reported worker exactly one continuation and refuses the second', () => {
    const value = held('take the demonstrated session one step further');
    expect(continuationRefusal(value)).toBeUndefined();
    expect(consumeHeldContinuation(value)).toBe('take the demonstrated session one step further');
    expect(value.holdBrief).toBeUndefined();
    expect(value.holdConsumed).toBe(true);
    expect(value.continues).toBe(1);
    expect(continuationRefusal(value)).toMatch(/^HELD_CONTINUATION_USED:/);
    // Consuming twice cannot buy two successors.
    expect(consumeHeldContinuation(value)).toBeUndefined();
    expect(value.continues).toBe(1);
  });

  it('keeps the ordinary conversation rules: live workers continue freely, closed or unheld reported workers do not', () => {
    expect(continuationRefusal(registration())).toBeUndefined();
    expect(continuationRefusal(registration({ stopped: true }))).toMatch(/^WORKER_CLOSED:/);
    expect(continuationRefusal(registration({ paneClosed: true }))).toMatch(/^WORKER_CLOSED:/);
    const unheld = registration({ reported: normalizeReport({ summary: 'no hold', confidence: 'low' }) });
    expect(continuationRefusal(unheld)).toMatch(/^WORKER_CLOSED:/);
    // A hold on a stopped registration is not a licence to revive it.
    const closedHold = held('continue this step');
    closedHold.stopped = true;
    expect(continuationRefusal(closedHold)).toMatch(/^WORKER_CLOSED:/);
    // Consuming nothing is a no-op, not a silent increment.
    expect(consumeHeldContinuation(registration())).toBeUndefined();
  });

  it('bounds a hold brief to one sentence and drops a malformed request', () => {
    const collapsed = normalizeReport({ summary: 's', confidence: 'high', holdFor: { brief: '  continue\n\tonto   the session  ' } });
    expect(collapsed.holdFor).toEqual({ brief: 'continue onto the session' });
    expect(normalizeReport({ summary: 's', confidence: 'low', holdFor: { brief: '   ' } }).holdFor).toBeUndefined();
    expect(normalizeReport({ summary: 's', confidence: 'low', holdFor: { brief: 5 } }).holdFor).toBeUndefined();
    expect(normalizeReport({ summary: 's', confidence: 'low', holdFor: 'continue' }).holdFor).toBeUndefined();
    expect(normalizeReport({ summary: 's', confidence: 'low', holdFor: { brief: 'a'.repeat(400) } }).holdFor?.brief).toHaveLength(300);
    expect(normalizeReport({ summary: 's', confidence: 'low' }).holdFor).toBeUndefined();
  });

  it('names a hold left without a successor as an advisory preflight fact, never as an obligation', () => {
    const index = indexRecords([], 'run-hold');
    expect(finishPreflight(index).advisory.map(item => item.code)).not.toContain('HELD_WITHOUT_SUCCESSOR');
    const preflight = finishPreflight(index, { heldWorkers: [{ workerId: 'p2o-general-aaaaaa', brief: 'continue this step' }] });
    expect(preflight.obligations.map(item => item.code)).not.toContain('HELD_WITHOUT_SUCCESSOR');
    const item = preflight.advisory.find(entry => entry.code === 'HELD_WITHOUT_SUCCESSOR');
    expect(item).toMatchObject({ level: 'advisory', count: 1, ids: ['p2o-general-aaaaaa'] });
    expect(item!.message).toContain('hold');
    // Two holds are two named workers, not a single aggregate sentence.
    const both = finishPreflight(index, { heldWorkers: [{ workerId: 'p2o-general-aaaaaa' }, { workerId: 'p2o-recon-bbbbbb', brief: 'x' }] });
    expect(both.advisory.find(entry => entry.code === 'HELD_WITHOUT_SUCCESSOR')?.ids).toEqual(['p2o-general-aaaaaa', 'p2o-recon-bbbbbb']);
  });
});

describe('A7.5 hold across the broker socket', () => {
  async function brokerFixture() {
    const control = await mkdtemp(join(tmpdir(), 'p2o-chain-broker-'));
    const value = registration();
    const broker = new Broker(control, {
      exec: async command => ({ code: 0, stdout: command, stderr: '', truncated: false }),
      http: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
      note: async () => undefined,
      ledger: async () => [],
      delegate: async (input, parent) => ({ workerId: 'p2o-general-bbbbbb', name: 'p2o-general-bbbbbb', paneId: 'w1T:p10', role: input.role ?? 'general', depth: parent.depth + 1 }),
      report: async () => undefined,
    }, {});
    broker.register(value);
    const socket = await broker.start();
    return { control, broker, registration: value, socket, close: async () => { await broker.stop(); await rm(control, { recursive: true, force: true }); } };
  }

  it('keeps a held ticket alive after its report and retires a report that asked for nothing', async () => {
    const f = await brokerFixture();
    const client = new BrokerClient(f.socket, f.registration.token, { requestMs: 2000 });
    try {
      await client.request('report', { report: { summary: 'held report', confidence: 'high', holdFor: { brief: 'continue the chain on this ticket' } } });
      expect(f.registration.reported?.summary).toBe('held report');
      expect(f.registration).toMatchObject({ holdBrief: 'continue the chain on this ticket', holdConsumed: false, stopped: false });
      // The token still works: reporting with a hold is state reuse, not a second authority.
      await expect(client.request('status')).resolves.toMatchObject({ workerId: f.registration.workerId });
      // A held worker cannot report again instead of waiting for the lead brief.
      await expect(client.request('report', { report: { summary: 'again', confidence: 'low' } })).rejects.toThrow(/held for one continuation/);
      // Once the owner consumes the hold, the successor may report; without another hold the ticket is retired as usual.
      expect(consumeHeldContinuation(f.registration)).toBe('continue the chain on this ticket');
      await client.request('report', { report: { summary: 'successor report', confidence: 'medium' } });
      expect(f.registration.reported?.summary).toBe('successor report');
      expect(f.registration.stopped).toBe(true);
      await expect(client.request('exec', { command: 'id' })).rejects.toThrow(/stopped by the owner/);
    } finally { client.close(); await f.close(); }
  });
});

/** Two roles in one process over a real socket and a real ticket file, like the worker suite, plus the Herdr call journal. */
interface ChainHarness {
  root: string; owner: FakePi; worker: FakePi; ownerCtx: ReturnType<typeof createContext>; workerCtx: ReturnType<typeof createContext>;
  sandboxes: InertSandbox[]; herdr: ReturnType<typeof createSimpleHerdr>;
  runDir: () => Promise<string>;
  start: (args?: string) => Promise<void>;
  delegate: (focus?: string) => Promise<string>;
  activate: (ticketPath: string) => Promise<void>;
  call: (name: string, params?: any, which?: 'owner' | 'worker') => Promise<any>;
  emit: (event: string, payload?: any, which?: 'owner' | 'worker') => Promise<any>;
  tickets: () => Promise<string[]>;
  records: () => Promise<any[]>;
}

async function chainHarness(): Promise<ChainHarness> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-chain-'));
  await mkdir(join(root, 'repo'), { recursive: true });
  const owner = createFakePi(); const worker = createFakePi();
  const sandboxes: InertSandbox[] = [];
  const herdr = createSimpleHerdr();
  const ownerContext = createContext({ cwd: root });
  const workerContext = createContext({ cwd: root });
  registerP2O(owner.pi, { createSandbox: sandboxFactory(sandboxes), herdr: herdr.client, controlRoot: join(root, 'control'), settingsPath: join(root, 'fixture-settings.json'), extensionPath: EXTENSION_PATH });
  registerP2O(worker.pi, { extensionPath: EXTENSION_PATH });
  const runDir = async () => {
    const entries = await readdir(join(root, 'control'));
    const created = entries.find(name => name.startsWith('p2o-run-'));
    if (!created) throw new Error('no control directory');
    return join(root, 'control', created);
  };
  const emit = async (event: string, payload: any = {}, which: 'owner' | 'worker' = 'owner') => {
    const pi = which === 'owner' ? owner : worker;
    const ctx = (which === 'owner' ? ownerContext : workerContext).ctx;
    let result: unknown;
    for (const handler of pi.events.get(event) ?? []) result = await handler(payload, ctx);
    return result;
  };
  const call = (name: string, params: any = {}, which: 'owner' | 'worker' = 'owner') => {
    const pi = which === 'owner' ? owner : worker;
    const ctx = (which === 'owner' ? ownerContext : workerContext).ctx;
    return pi.tools.get(name).execute('call', params, undefined, undefined, ctx);
  };
  return {
    root, owner, worker, ownerCtx: ownerContext, workerCtx: workerContext, sandboxes, herdr, runDir,
    async start(args = '--target ./repo') { await owner.commands.get('p2o').handler(args, ownerContext.ctx); },
    async delegate(focus = 'surface-recon') {
      const result = await call('p2o_delegate', { focus, task: 'Inspect /target/code.txt', context: 'nothing known yet' });
      return result.details.workerId as string;
    },
    async activate(ticketPath: string) { worker.flags['p2o-worker'] = ticketPath; await emit('session_start', {}, 'worker'); },
    call, emit,
    async tickets() { return (await readdir(await runDir())).filter(name => name.startsWith('ticket-')); },
    async records() {
      const { readLedger } = await import('../../src/records.js');
      return (await readLedger(join(await runDir(), 'records.sqlite'))).records;
    },
  };
}

describe('A7.5 report-with-hold keeps a ticket, pane and session', () => {
  let h: ChainHarness;
  beforeEach(async () => { h = await chainHarness(); });
  afterEach(async () => { await rm(h.root, { recursive: true, force: true }); });

  it('keeps the held ticket and pane, refuses a second report, and names the missing successor at report time', async () => {
    await h.start();
    const workerId = await h.delegate();
    await h.activate(join(await h.runDir(), `ticket-${workerId}.json`));
    const reported = await h.call('p2o_report', { summary: 'HELD_REPORT', confidence: 'medium', holdFor: { brief: 'continue onto the demonstrated session' } }, 'worker');
    expect(reported.details).toMatchObject({ reported: true, held: true });
    expect(reported.content[0].text).toContain('held for exactly one continuation');
    // The ticket and its pane are live state now, not garbage the reaper may collect.
    expect(await h.tickets()).toHaveLength(1);
    expect(h.herdr.calls.filter(call => call.op === 'close')).toHaveLength(0);
    const view = (await h.call('p2o_workers', {})).details;
    expect(view.workers[0]).toMatchObject({ workerId, status: 'held', heldBrief: 'continue onto the demonstrated session', heldConsumed: false, reported: true, live: false });
    // Reporting again is not another turn: the broker refuses it while the hold is unconsumed.
    await expect(h.call('p2o_report', { summary: 'again', confidence: 'low' }, 'worker')).rejects.toThrow(/held for one continuation/);
    // Ending the run without dispatching the successor names the abandoned hold instead of silently releasing it.
    const exported = await h.call('p2o_finish', { export: true });
    expect(exported.content[0].text).toContain('HELD_WITHOUT_SUCCESSOR (1)');
    expect(exported.details.preflight.advisory.find((item: any) => item.code === 'HELD_WITHOUT_SUCCESSOR')).toMatchObject({ ids: [workerId] });
    expect(exported.details.preflight.obligations.map((item: any) => item.code)).not.toContain('HELD_WITHOUT_SUCCESSOR');
    // Export ends nothing: the ticket is still there after the report was written.
    expect(await h.tickets()).toHaveLength(1);
  });

  it('accepts exactly one continued brief on the held ticket and refuses the second', async () => {
    await h.start();
    const workerId = await h.delegate();
    await h.activate(join(await h.runDir(), `ticket-${workerId}.json`));
    await h.call('p2o_report', { summary: 'held for one brief', confidence: 'high', holdFor: { brief: 'open the second actor' } }, 'worker');
    const continued = await h.call('p2o_workers', { action: 'continue', workerId, brief: 'Open the second actor and replay the demonstrated step' });
    expect(continued.details).toMatchObject({ workerId, held: 'open the second actor' });
    expect(continued.content[0].text).toContain('its one hold is now consumed');
    expect(h.herdr.calls.some(call => call.op === 'prompt' && String(call.text).includes('Open the second actor and replay the demonstrated step'))).toBe(true);
    const notes = (await h.records()).filter(record => record.kind === 'lifecycle').map(record => record.text).join('\n');
    expect(notes).toContain('held continuation consumed');
    const view = (await h.call('p2o_workers', {})).details;
    expect(view.workers[0]).toMatchObject({ workerId, status: 'continued', heldConsumed: true, live: true, reported: true });
    expect(view.workers[0].heldBrief).toBeUndefined();
    // One hold, one continuation: the same ticket cannot be re-used for a third step.
    await expect(h.call('p2o_workers', { action: 'continue', workerId, brief: 'one more idea' })).rejects.toThrow(/HELD_CONTINUATION_USED/);
    // Reusing the conversation is a prompt, not a second worker.
    expect(h.herdr.calls.filter(call => call.op === 'start')).toHaveLength(1);
    expect(h.herdr.calls.filter(call => call.op === 'split')).toHaveLength(1);
  });

  it('still lets a live worker be continued, and refuses a reported worker that asked for no hold', async () => {
    await h.start();
    const workerId = await h.delegate();
    await h.activate(join(await h.runDir(), `ticket-${workerId}.json`));
    const live = await h.call('p2o_workers', { action: 'continue', workerId, brief: 'Narrow the question to one endpoint' });
    expect(live.details.workerId).toBe(workerId);
    expect(live.details.held).toBeUndefined(); // a live worker consumed no hold
    await h.call('p2o_report', { summary: 'no hold asked', confidence: 'low' }, 'worker');
    const view = (await h.call('p2o_workers', {})).details;
    expect(view.workers[0]).toMatchObject({ workerId, status: 'reported', live: false, heldConsumed: false });
    expect(view.workers[0].heldBrief).toBeUndefined();
    await expect(h.call('p2o_workers', { action: 'continue', workerId, brief: 'one more question' })).rejects.toThrow(/WORKER_CLOSED/);
    // Its target capability is retired with the ticket.
    await expect(h.call('p2o_shell', { command: 'id' }, 'worker')).rejects.toThrow(/finished or has no valid ticket/);
  });
});

describe('A7.5 successor dispatch on a held ticket, pane and session', () => {
  let h: ChainHarness;
  beforeEach(async () => { h = await chainHarness(); });
  afterEach(async () => { await rm(h.root, { recursive: true, force: true }); });

  it('dispatches one owner successor onto the predecessor session without a new worker, pane or ticket', async () => {
    await h.start('--target ./repo --executors session');
    const workerId = await h.delegate();
    await h.activate(join(await h.runDir(), `ticket-${workerId}.json`));
    // The worker opens the one session its ticket will hold, then demonstrates the primitive the successor must cite.
    const opened = await h.call('p2o_session', { action: 'open', purpose: 'credentialed chain' }, 'worker');
    const session = opened.details.session as string;
    const shell = await h.call('p2o_shell', { command: 'printf chain-surface' }, 'worker');
    await h.call('p2o_candidate', { candidate: 'chain-primitive', surface: '/chain-surface', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', evidenceRefs: [shell.details.evidenceId], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared session boundary', limitations: 'One inert fixture session only' }, 'worker');
    const claimId = (await h.records()).filter(record => record.kind === 'candidate').at(-1)!.id!;
    const reported = await h.call('p2o_report', { summary: 'primitive demonstrated on the session', confidence: 'medium', holdFor: { brief: 'use the demonstrated session for the next chain step' } }, 'worker');
    expect(reported.details).toMatchObject({ reported: true, held: true });
    // Held: the predecessor's ticket, pane, container and session are still state the successor can reuse.
    expect(await h.tickets()).toHaveLength(1);
    expect((await h.call('p2o_session', { action: 'snapshot' })).details.openSessions).toEqual([session]);
    const asset = (await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /chain-successor' } }] } })).details.acks[0];
    const splits = h.herdr.calls.filter(call => call.op === 'split').length;
    const starts = h.herdr.calls.filter(call => call.op === 'start').length;
    const successor = (await h.call('p2o_task_create', {
      draft: {
        question: 'Does the demonstrated session primitive carry the chain one step further?',
        surface: '/chain-surface', risk: 'authorization', role: 'general',
        roleReason: 'Bounded successor intent that consumes the claim demonstrated on this ticket',
        expectedTrue: 'The successor step acts through the demonstrated session primitive',
        expectedFalse: 'The successor step does not act through it and records the mismatch',
        stopCondition: 'Stop after one bounded successor observation or a concrete gap',
        evidenceIds: [], prerequisites: [], skills: [], methodReason: 'One inert step inside the already-open session',
        work: { assetRefs: [{ id: asset.entityId, revision: 1 }], questionKey: 'question:chain-successor', actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'offline-observation', purpose: 'investigation' as const, claimRefs: [claimId] },
        decision: { disposition: 'new' as const, reason: 'First bounded successor step for the demonstrated claim' },
        outputContract: { kind: 'investigation' as const, required: ['evidence' as const], partialAllowed: true, artifactPolicy: 'ids-only' as const },
      },
    })).details;
    expect(successor.status).toBe('proposed');
    await h.call('p2o_task_dispatch', { ids: [successor.id], workerId });
    // The Engine dispatches mechanically after its short debounce; no model turn is needed.
    let worker: any;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      worker = (await h.call('p2o_workers', {})).details.workers.find((entry: any) => entry.workerId === workerId);
      if (worker?.taskId === successor.id) break;
      await delay(25);
    }
    expect(worker).toMatchObject({ workerId, status: 'continued', heldConsumed: true, taskId: successor.id, reported: true });
    expect(worker.heldBrief).toBeUndefined();
    // Reuse, not a new worker: the pane, ticket and container count are unchanged and the session stayed open.
    expect(h.herdr.calls.filter(call => call.op === 'split')).toHaveLength(splits);
    expect(h.herdr.calls.filter(call => call.op === 'start')).toHaveLength(starts);
    expect(await h.tickets()).toHaveLength(1);
    expect(h.sandboxes).toHaveLength(2); // the run's primary shell plus the one session container
    expect((await h.call('p2o_session', { action: 'snapshot' })).details.openSessions).toEqual([session]);
    const briefs = h.herdr.calls.filter(call => call.op === 'prompt').map(call => String(call.text ?? ''));
    expect(briefs.some(text => text.includes(`[p2o successor ${successor.id}`))).toBe(true);
    expect(briefs.some(text => text.includes('same ticket, pane and session'))).toBe(true);
    const task = (await h.call('p2o_board', { board: 'tasks', id: successor.id })).details;
    expect(task).toMatchObject({ status: 'running', assignee: workerId });
    // The successor is its own task with its own receipt trail; only the state was reused.
    const records = await h.records();
    expect(records.some(record => record.kind === 'lifecycle' && String(record.text).includes(`successor ${successor.id} dispatched onto held ${workerId}`))).toBe(true);
    // A second successor on the same consumed hold is not admitted: the worker must report again first.
    const another = (await h.call('p2o_task_create', {
      draft: {
        question: 'Is a second step on the same consumed hold admissible?',
        surface: '/chain-surface-two', risk: 'authorization', role: 'general',
        roleReason: 'Second bounded successor intent for the same held ticket',
        expectedTrue: 'A second successor is admitted', expectedFalse: 'The hold refuses a second successor',
        stopCondition: 'Stop after the admission decision', evidenceIds: [], prerequisites: [], skills: [], methodReason: 'One inert admission probe',
        work: { assetRefs: [{ id: asset.entityId, revision: 1 }], questionKey: 'question:chain-second', actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'offline-observation', purpose: 'investigation' as const, claimRefs: [claimId] },
        decision: { disposition: 'new' as const, reason: 'Second bounded step for the same held ticket' },
        outputContract: { kind: 'investigation' as const, required: ['evidence' as const], partialAllowed: true, artifactPolicy: 'ids-only' as const },
      },
    })).details;
    await h.call('p2o_task_dispatch', { ids: [another.id], workerId });
    let refused = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const events = (await h.call('p2o_workers', {})).details.engine.events;
      if (events.some((event: any) => event.kind === 'intent-blocked' && String(event.reason).includes('WORKER_NOT_HELD'))) { refused = true; break; }
      await delay(25);
    }
    expect(refused).toBe(true);
    // The refused intent spawned nothing and reserved nothing: the successor task is still proposed.
    expect((await h.call('p2o_board', { board: 'tasks', id: another.id })).details.status).toBe('proposed');
    expect(h.herdr.calls.filter(call => call.op === 'split')).toHaveLength(splits);
    expect(await h.tickets()).toHaveLength(1);
  }, 20000);
});

describe('A7.5 validation economy', () => {
  it('keeps the deepest claim its replay and skips the intermediate claim the successor already covers', async () => {
    await reportFixture(async h => {
      await h.command('--target ./source --max-depth 0');
      const asset = (await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /chain-fixture' } }] } })).details.acks[0];
      const receipt = (await h.call('p2o_shell', { command: 'printf chain-receipt' })).details.evidenceId;
      const draft = (questionKey: string, question: string) => ({
        question, surface: '/chain-fixture', risk: 'authorization', role: 'general',
        roleReason: 'Bounded inert chain fixture step', expectedTrue: 'A bounded observation is recorded',
        expectedFalse: 'No bounded observation is recorded', stopCondition: 'Stop after one bounded observation',
        evidenceIds: [], prerequisites: [], skills: [], methodReason: 'One inert observation',
        work: { assetRefs: [{ id: asset.entityId, revision: 1 }], questionKey, actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'offline-observation', purpose: 'investigation' },
        decision: { disposition: 'new', reason: 'Bounded chain fixture step' },
        outputContract: { kind: 'investigation', required: ['evidence'], partialAllowed: true, artifactPolicy: 'ids-only' },
      });
      const intermediateTask = (await h.call('p2o_task_create', { draft: draft('question:chain-first', 'Does the first chain step demonstrate the session primitive?') })).details;
      const deepestTask = (await h.call('p2o_task_create', { draft: draft('question:chain-deepest', 'Does the deepest chain step consume the session primitive?') })).details;
      const runningIntermediate = (await h.call('p2o_task_start', { id: intermediateTask.id })).details;
      const runningDeepest = (await h.call('p2o_task_start', { id: deepestTask.id })).details;
      // The intermediate produced a capability the successor consumes; the successor produces the effect the case rests on.
      const intermediateClaim = await seedClaim(h, { candidate: 'chain-intermediate', surface: '/chain-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', evidenceRefs: [receipt], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture boundary', limitations: 'One inert fixture step', gained: [{ kind: 'cred.session', subject: 'alice' }] }, intermediateTask.id);
      const deepestClaim = await seedClaim(h, { candidate: 'chain-deepest', surface: '/chain-fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction', evidenceRefs: [receipt], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared fixture boundary', limitations: 'One inert fixture step', needs: [{ kind: 'cred.session', subject: 'alice' }], gained: [{ kind: 'code-execution', subject: 'shell-1' }] }, deepestTask.id);
      // One live successor task cites the intermediate primitive, so it is chained and admission is not what stops the replay;
      // the deepest claim is only ever consumed by its own replay, exactly the chain a lead records when taking the next step.
      await h.call('p2o_task_create', { draft: { ...draft('question:chain-successor', 'Does the recorded successor task consume the intermediate primitive?'), work: { assetRefs: [{ id: asset.entityId, revision: 1 }], questionKey: 'question:chain-successor', actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'offline-observation', purpose: 'investigation', claimRefs: [intermediateClaim.id] } } });
      // The deepest claim is reviewed first and keeps its one independent replay.
      await h.call('p2o_task_review', { id: deepestTask.id, revision: runningDeepest.revision, reason: 'Owner reviewed the deepest demonstrated fixture claim', evidenceIds: [receipt] });
      // The intermediate claim is covered by that replay; reviewing it must not buy a second one.
      await h.call('p2o_task_review', { id: intermediateTask.id, revision: runningIntermediate.revision, reason: 'Owner reviewed the intermediate demonstrated fixture claim', evidenceIds: [receipt] });
      const board = (await h.call('p2o_board', { board: 'tasks' })).details.tasks;
      const validations = board.filter((task: any) => task.role === 'validation');
      expect(validations).toHaveLength(1);
      const validation = (await h.call('p2o_board', { board: 'tasks', id: validations[0].id })).details;
      // No worker backend in this fixture, so the replay is a blocked task with its prerequisite named, never a waiver.
      expect(validation).toMatchObject({ role: 'validation', validationOf: deepestTask.id, status: 'blocked' });
      expect(validation.missingPrerequisites.join('\n')).toContain('Delegation unavailable');
      expect(validation.work?.claimRefs).toEqual([deepestClaim.id]);
      const store = await h.reader();
      try {
        const lifecycle = store.records().filter((record: any) => record.kind === 'lifecycle').map((record: any) => record.text).join('\n');
        expect(lifecycle).toContain('validation skipped for intermediate claim');
        expect(lifecycle).toContain(`successor claim ${deepestClaim.id}`);
        // The deepest claim did earn a validation; that one record names the only validation task the host created.
        const created = store.records().filter((record: any) => record.kind === 'lifecycle' && String(record.text).startsWith('host created validation'));
        expect(created).toHaveLength(1);
        expect(String(created[0].text)).toContain(validations[0].id);
      } finally { store.close(); }
    });
  }, 20000);
});
