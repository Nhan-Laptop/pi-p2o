import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { BrokerClient } from '../../src/broker.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, InertSandbox, type FakePi } from './helpers/fake-pi.js';

/**
 * Two roles in one process, over a real unix socket and a real ticket file: the owner serves its
 * sandbox, the worker reaches it only through the broker, and the ledger carries the report.
 */
interface WorkerHarness {
  root: string; owner: FakePi; worker: FakePi; sandbox: InertSandbox;
  ownerCtx: ReturnType<typeof createContext>; workerCtx: ReturnType<typeof createContext>;
  runDir: () => Promise<string>;
  start: (args?: string) => Promise<void>;
  delegate: (focus?: string) => Promise<string>;
  activate: (ticketPath: string) => Promise<void>;
  call: (name: string, params?: any, which?: 'owner' | 'worker') => Promise<any>;
  emit: (event: string, payload?: any, which?: 'owner' | 'worker') => Promise<any>;
  command: (args: string, which?: 'owner' | 'worker') => Promise<void>;
  tickets: () => Promise<string[]>;
  records: () => Promise<any[]>;
}

async function harness(): Promise<WorkerHarness> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-worker-'));
  await mkdir(join(root, 'repo'), { recursive: true });
  const owner = createFakePi(); const worker = createFakePi();
  const sandboxes: InertSandbox[] = [];
  const herdr = createSimpleHerdr();
  const ownerContext = createContext({ cwd: root });
  const workerContext = createContext({ cwd: root });
  registerP2O(owner.pi, { createSandbox: sandboxFactory(sandboxes), herdr: herdr.client, controlRoot: join(root, 'control'), settingsPath: join(root, 'fixture-settings.json'), extensionPath: EXTENSION_PATH });
  registerP2O(worker.pi, { extensionPath: EXTENSION_PATH });
  const runDir = async () => {
    const { readdir } = await import('node:fs/promises');
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
    root, owner, worker, ownerCtx: ownerContext, workerCtx: workerContext, runDir,
    get sandbox() { return sandboxes[0] as InertSandbox; },
    async start(args = '--target ./repo') { await owner.commands.get('p2o').handler(args, ownerContext.ctx); },
    async delegate(focus = 'surface-recon') {
      const result = await call('p2o_delegate', { focus, task: 'Inspect /target/code.txt', context: 'nothing known yet' });
      return result.details.workerId as string;
    },
    async activate(ticketPath: string) { worker.flags['p2o-worker'] = ticketPath; await emit('session_start', {}, 'worker'); },
    call, emit,
    command: (args: string, which: 'owner' | 'worker' = 'owner') => (which === 'owner' ? owner : worker).commands.get('p2o').handler(args, (which === 'owner' ? ownerContext : workerContext).ctx),
    async tickets() { const { readdir } = await import('node:fs/promises'); return (await readdir(await runDir())).filter(name => name.startsWith('ticket-')); },
    async records() {
      const { readFile } = await import('node:fs/promises');
      const {readLedger} = await import('../../src/records.js');
      return (await readLedger(join(await runDir(),'records.sqlite'))).records;
    },
  } as WorkerHarness;
}

describe('worker role', () => {
  let h: WorkerHarness;
  beforeEach(async () => { h = await harness(); await h.start(); });
  afterEach(async () => { await rm(h.root, { recursive: true, force: true }); });

  it('activates only with a valid owner ticket and then reaches the target only through the broker', async () => {
    const workerId = await h.delegate();
    expect(await h.tickets()).toHaveLength(1);
    // A missing ticket leaves no capability at all.
    await h.activate(join(h.root, 'control', 'nope.json'));
    expect(h.worker.active).toEqual([]);
    expect(h.workerCtx.notices.join('\n')).toContain('ticket rejected');

    const clean = createFakePi();
    registerP2O(clean.pi, { extensionPath: EXTENSION_PATH });
    clean.flags['p2o-worker'] = join(h.root, 'control', 'p2o-run-missing', `ticket-${workerId}.json`);
    await (clean.events.get('session_start') ?? [])[0]({}, createContext({ cwd: h.root }).ctx);
    expect(clean.active).toEqual([]);

    // The real ticket activates the worker tool set.
    const worker = createFakePi();
    registerP2O(worker.pi, { extensionPath: EXTENSION_PATH });
    worker.flags['p2o-worker'] = join(await h.runDir(), `ticket-${workerId}.json`);
    const freshContext = createContext({ cwd: h.root });
    await worker.events.get('session_start')![0]({}, freshContext.ctx);
    expect(worker.active).toEqual(['p2o_skill_list', 'p2o_skill_read', 'p2o_research', 'p2o_candidate', 'p2o_lab', 'p2o_shell', 'p2o_net', 'p2o_http', 'p2o_capture', 'p2o_note', 'p2o_surface', 'p2o_ledger', 'p2o_state', 'p2o_graph', 'p2o_artifact', 'p2o_request_subtask', 'p2o_report']);
    expect(freshContext.notices.join('\n')).not.toContain('rejected');

    // Host tools are blocked; sandbox tools run in the owner's container with the worker's own scratch.
    const shell = worker.pi; void shell;
    const blocked = await (worker.events.get('tool_call') ?? []).reduce(async (previous: any, handler: any) => previous ?? handler({ toolName: 'bash' }, freshContext.ctx), undefined);
    expect(blocked).toMatchObject({ block: true });
    const executed = await worker.tools.get('p2o_shell').execute('call', { command: 'cat /target/code.txt' }, undefined, undefined, freshContext.ctx);
    expect(executed.content[0].text).toContain('INERT_SANDBOX');
    expect(h.sandbox.commands).toEqual([{ command: 'cat /target/code.txt', workdir: `/work/${workerId}`, timeout: 0 }]);
    // Network shares the unlimited executor; this probe explicitly opts into a timeout and a separate receipt label.
    const scanned = await worker.tools.get('p2o_net').execute('call', { command: 'nmap -sT 127.0.0.1', timeout: 120 }, undefined, undefined, freshContext.ctx);
    expect(scanned.content[0].text).toContain('INERT_SANDBOX');
    expect(h.sandbox.commands.at(-1)).toEqual({ command: 'nmap -sT 127.0.0.1', workdir: `/work/${workerId}`, timeout: 120 });
    expect((await h.records()).some((record: any) => record.kind === 'evidence' && record.data?.operation === 'net' && String(record.data?.input).includes('nmap'))).toBe(true);
    const posted = await worker.tools.get('p2o_http').execute('call', { url: '/login', method: 'POST', body: 'user=a', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, followRedirects: false }, undefined, undefined, freshContext.ctx);
    expect(posted.content[0].text).toContain('Hops: 200 POST /login');
    expect(h.sandbox.httpCalls.at(-1)).toMatchObject({ url: '/login', method: 'POST', body: 'user=a' });
    await expect(worker.tools.get('p2o_finish').execute('call', {}, undefined, undefined, freshContext.ctx)).rejects.toThrow(/No active p2o assessment/);
  });

  it('reports into the owner ledger exactly once and cannot escalate or finish', async () => {
    const workerId = await h.delegate();
    const runDir = await h.runDir();
    await h.activate(join(runDir, `ticket-${workerId}.json`));
    await h.call('p2o_note', { kind: 'coverage', text: 'clean', surface: '/target/code.txt', risk: 'unintended exposure', outcome: 'clean' }, 'worker');
    const ledger = await h.call('p2o_ledger', { limit: 10 }, 'worker');
    expect(ledger.content[0].text).toContain('unintended exposure');
    expect(ledger.details.count).toBeGreaterThan(0);
    // The lead's own records are visible to the worker, so it does not repeat known work.
    await h.call('p2o_note', { kind: 'note', text: 'LEAD_KNOWN_FACT' });
    const shared = await h.call('p2o_ledger', {}, 'worker');
    expect(shared.content[0].text).toContain('LEAD_KNOWN_FACT');
    const report = await h.call('p2o_report', {
      summary: 'WORKER_SUMMARY_TEXT', findings: ['candidate x'], evidence: ['cmd: cat /target/code.txt'],
      coverage: [{ surface: '/target/code.txt', risk: 'unintended exposure', outcome: 'clean' }], openItems: ['nothing else tested'], confidence: 'medium',
    }, 'worker');
    expect(report.details.reported).toBe(true);
    await expect(h.call('p2o_report', { summary: 'again', confidence: 'low' }, 'worker')).rejects.toThrow(/already reported|finished or has no valid ticket/);
    const records = await h.records();
    expect(records.some(entry => entry.kind === 'report' && entry.text === 'WORKER_SUMMARY_TEXT' && entry.by === workerId)).toBe(true);
    expect(records.filter(entry => entry.kind === 'coverage').every(entry => entry.by === workerId)).toBe(true);
    expect(records.some(entry => entry.kind === 'open' && entry.text === 'nothing else tested')).toBe(true);
    // After reporting, the worker keeps no target capability.
    await expect(h.call('p2o_shell', { command: 'id' }, 'worker')).rejects.toThrow(/finished or has no valid ticket/);
  });

  it('records a worker surface-inventory entry through the broker and flags the owner-recorded duplicate (planning_update.md P1.2)', async () => {
    const workerId = await h.delegate();
    const runDir = await h.runDir();
    await h.activate(join(runDir, `ticket-${workerId}.json`));
    const owned = (await h.call('p2o_surface', { component: 'Admin panel', entryPoint: '/admin' })).details;
    expect(owned.duplicate).toBe(false);
    const fromWorker = (await h.call('p2o_surface', { component: ' admin panel ', entryPoint: '/admin' }, 'worker')).details;
    expect(fromWorker.duplicate).toBe(true); expect(fromWorker.priorRecordId).toBe(owned.recordId);
    const records = await h.records();
    expect(records.some((entry: any) => entry.kind === 'surface' && entry.by === workerId)).toBe(true);
  });

  it('lets the owner see the worker report and refuses owner-only tools in the worker', async () => {
    const workerId = await h.delegate();
    const runDir = await h.runDir();
    await h.activate(join(runDir, `ticket-${workerId}.json`));
    await expect(h.call('p2o_workers', {}, 'worker')).rejects.toThrow(/No active p2o assessment/);
    await expect(h.call('p2o_workers', { action: 'stop', workerId, reason: 'x' }, 'worker')).rejects.toThrow(/No active p2o assessment/);
    await h.call('p2o_report', { summary: 'visible to lead', confidence: 'high' }, 'worker');
    const view = await h.call('p2o_workers', {});
    expect(view.content[0].text).toContain('visible to lead');
    // A reported worker is shown as reported (its token is already revoked).
    expect(view.details.workers[0]).toMatchObject({ workerId, reported: true, status: 'reported', live: false });
  });

  it('loses all target access when the owner stops, and cannot mint tickets', async () => {
    const workerId = await h.delegate();
    const runDir = await h.runDir();
    const ticket = JSON.parse(await (await import('node:fs/promises')).readFile(join(runDir, `ticket-${workerId}.json`), 'utf8'));
    await h.activate(join(runDir, `ticket-${workerId}.json`));
    await h.call('p2o_shell', { command: 'id' }, 'worker');
    // A second process holding the same token is refused once the owner revokes the worker.
    const replay = new BrokerClient(ticket.socket, ticket.token, { connectMs: 2000, requestMs: 3000 });
    await expect(replay.request('status')).resolves.toMatchObject({ workerId });
    await h.call('p2o_workers', { action: 'stop', workerId, reason: 'done' });
    await expect(replay.request('exec', { command: 'id' })).rejects.toThrow(/stopped by the owner/);
    replay.close();
    await expect(h.call('p2o_shell', { command: 'id' }, 'worker')).rejects.toThrow(/finished or has no valid ticket|Do not retry|stopped by the owner/);
  });

  it('serves approved knowledge through the real broker with identical hashes', async () => {
    const workerId = await h.delegate();
    await h.activate(join(await h.runDir(), `ticket-${workerId}.json`));
    const ownerRead = await h.call('p2o_skill_read', { id: 'shared:handoffs' });
    const workerRead = await h.call('p2o_skill_read', { id: 'shared:handoffs' }, 'worker');
    expect(workerRead.details.sha256).toBe(ownerRead.details.sha256);
    await expect(h.call('p2o_skill_read', { id: '/etc/passwd' }, 'worker')).rejects.toThrow('Unknown document');
    const shell = await h.call('p2o_shell', { command: 'cat /target/code.txt' }, 'worker');
    expect(shell.details.evidenceId).toBeDefined();
    const candidate = await h.call('p2o_candidate', { candidate: 'test-case', surface: '/target/code.txt', risk: 'example', closure: 'open_proof_gap', execution: 'blocked', proof: 'static_trace', evidenceRefs: [shell.details.evidenceId], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Intended policy needs confirmation', limitations: 'No authenticated comparison', requirement: 'No authorized authenticated transport for this source assessment' }, 'worker');
    expect(candidate.details.by).toBe(workerId);
    const view = await h.call('p2o_workers');
    expect(view.details.open.some((r: any) => r.kind === 'candidate')).toBe(true);
    expect(view.details.workers[0].commandsUsed).toBe(1);
  });

  it('delivers a blocked lifecycle report on settled provider failure without a model tool call', async () => {
    const workerId = await h.delegate();
    await h.activate(join(await h.runDir(), `ticket-${workerId}.json`));
    await h.emit('agent_before_settle', { outcome: 'error', continue: false, context: { pendingMessages: [], contextMessages: [{ role: 'assistant', errorMessage: '429 GoUsageLimitError: usage limit exceeded' }] } }, 'worker');
    const view = await h.call('p2o_workers', { waitFor: 'all-report', timeoutSeconds: 5 });
    expect(view.details.workers[0]).toMatchObject({ reported: true, live: false });
    expect(view.details.workers[0].blocked).toContain('429');
    await expect(h.call('p2o_shell', { command: 'id' }, 'worker')).rejects.toThrow();
    await h.emit('agent_before_settle', { outcome: 'error' }, 'worker');
    expect((await h.records()).filter(r => r.kind === 'report')).toHaveLength(1);
    await h.call('p2o_finish');
  });

  it('does not close a worker while an automatic continuation is still pending', async () => {
    const workerId = await h.delegate();
    await h.activate(join(await h.runDir(), `ticket-${workerId}.json`));
    await h.emit('agent_before_settle', { outcome: 'error', continue: true }, 'worker');
    expect((await h.call('p2o_workers')).details.workers[0].reported).toBe(false);
  });

  it('never activates a worker gate from session replay alone', async () => {
    const replay = createFakePi();
    registerP2O(replay.pi, { extensionPath: EXTENSION_PATH });
    const ctx = createContext({ cwd: h.root });
    await replay.events.get('session_start')![0]({}, ctx);
    expect(replay.active).not.toContain('p2o_shell');
    const blocked = await (replay.events.get('tool_call') ?? []).reduce(async (previous: any, handler: any) => previous ?? handler({ toolName: 'p2o_shell' }, ctx), undefined);
    expect(blocked).toMatchObject({ block: true });
  });
});
