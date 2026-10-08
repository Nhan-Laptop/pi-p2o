import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, InertSandbox, type FakePi } from './helpers/fake-pi.js';

interface Harness {
  root: string; pi: FakePi; sandboxes: InertSandbox[]; herdr: ReturnType<typeof createSimpleHerdr>;
  start: (args?: string, confirm?: boolean) => Promise<ReturnType<typeof createContext>>;
  call: (name: string, params?: any, ctx?: any) => Promise<any>;
  emit: (event: string, payload?: any, ctx?: any) => Promise<any>;
  command: (args: string, ctx?: any) => Promise<void>;
  runDir: () => Promise<string>;
  tickets: () => Promise<string[]>;
  records: () => Promise<any[]>;
  readonly contexts: ReturnType<typeof createContext>;
}

async function harness(options: { settings?: unknown; herdrAvailable?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-owner-'));
  await mkdir(join(root, 'repo'), { recursive: true });
  const settingsPath = join(root, 'settings.json');
  if (options.settings) await writeFile(settingsPath, JSON.stringify(options.settings), { mode: 0o600 });
  const pi = createFakePi();
  const sandboxes: InertSandbox[] = [];
  const herdr = createSimpleHerdr({ available: options.herdrAvailable ?? true });
  registerP2O(pi.pi, {
    createSandbox: sandboxFactory(sandboxes), herdr: herdr.client,
    settingsPath, controlRoot: join(root, 'control'), extensionPath: EXTENSION_PATH,
  });
  let context: ReturnType<typeof createContext> | undefined;
  const contextFor = () => (context ??= createContext({ cwd: root }));
  const runDirectory = async () => {
    const entries = await readdir(join(root, 'control'));
    const created = entries.find(name => name.startsWith('p2o-run-'));
    if (!created) throw new Error('no control directory was created');
    return join(root, 'control', created);
  };
  return {
    root, pi, sandboxes, herdr, runDir: runDirectory,
    async start(args = '--target ./repo', confirm = true) {
      context = createContext({ cwd: root, confirm });
      await pi.commands.get('p2o').handler(args, context.ctx);
      if (pi.messages.length === 0 && context.notices.length) throw new Error(`start failed: ${context.notices.at(-1)}`);
      return context;
    },
    call(name, params = {}, ctx) {
      return pi.tools.get(name).execute('call', params, undefined, undefined, ctx ?? contextFor().ctx);
    },
    async emit(event, payload = {}, ctx) {
      const handlers = pi.events.get(event) ?? [];
      let result: unknown;
      for (const handler of handlers) result = await handler(payload, ctx ?? contextFor().ctx);
      return result;
    },
    command(args: string, ctx?: any) { return pi.commands.get('p2o').handler(args, ctx ?? contextFor().ctx); },
    get contexts() { return contextFor(); },
    async tickets() { return (await readdir(await runDirectory())).filter(name => name.startsWith('ticket-')); },
    async records(): Promise<any[]> {
      const file = join(await runDirectory(), 'records.jsonl');
      return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as any);
    },
  };
}

describe('owner role', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await rm(h.root, { recursive: true, force: true }); });

  it('registers the owner and worker tools plus one command, and does no work before the command', () => {
    expect([...h.pi.tools.keys()].sort()).toEqual(['p2o_candidate', 'p2o_delegate', 'p2o_finish', 'p2o_http', 'p2o_ledger', 'p2o_note', 'p2o_report', 'p2o_shell', 'p2o_skill_list', 'p2o_skill_read', 'p2o_steer', 'p2o_stop_worker', 'p2o_workers']);
    expect(h.pi.messages).toEqual([]);
    expect(h.sandboxes).toEqual([]);
    expect([...h.pi.commands.keys()]).toEqual(['p2o']);
    expect(h.pi.flags['p2o-worker']).toBeDefined();
  });

  it('confirms once, names the delegation budget, and hands the task to the current agent', async () => {
    const started = await h.start();
    expect(started.dialogs).toEqual(['Start authorized assessment?']);
    expect(started.dialogs.join(' ')).toContain('Start authorized assessment');
    expect(h.pi.messages).toHaveLength(1);
    expect(h.pi.messages[0]).toContain('Begin the confirmed assessment');
    expect(h.pi.messages[0].length).toBeLessThan(200);
    expect(h.pi.messages[0]).not.toMatch(/p2o_|P2O ASSESSMENT|DELEGATION/);
    const event = { systemPrompt: 'BASE PROMPT', systemPromptOptions: { sections: { other: 'KEEP OTHER GUIDANCE' } as Record<string, string> } };
    expect(await h.emit('before_agent_start', event)).toBeUndefined();
    expect(event.systemPromptOptions.sections.p2o_assessment).toContain('P2O ASSESSMENT');
    expect(event.systemPromptOptions.sections.p2o_assessment).toContain('Only the human can change confirmed scope');
    expect(event.systemPromptOptions.sections.p2o_assessment).toContain('DELEGATION');
    expect(event.systemPromptOptions.sections.other).toBe('KEEP OTHER GUIDANCE');
    expect(h.sandboxes[0].stopCount).toBe(0);
    expect(h.pi.active).toEqual(['p2o_ledger', 'p2o_skill_list', 'p2o_skill_read', 'p2o_candidate', 'p2o_shell', 'p2o_http', 'p2o_note', 'p2o_delegate', 'p2o_workers', 'p2o_steer', 'p2o_stop_worker', 'p2o_finish']);
    expect(await h.tickets()).toEqual([]);
  });

  it('replaces only its own prompt section and clears active policy after finish, stop or replay', async () => {
    const options = { sections: { p2o_assessment: 'STALE', other: 'UNRELATED' } as Record<string, string>, selectedTools: ['read'], toolGuidelines: { read: ['READ_GUIDE'] } };
    const event = { systemPrompt: 'PI BASE PROMPT', systemPromptOptions: options };
    await h.emit('before_agent_start', event);
    expect(options.sections).toEqual({ other: 'UNRELATED' });
    await h.start('--target ./repo --solo');
    await h.emit('before_agent_start', event);
    const active = options.sections.p2o_assessment;
    expect(active).not.toMatch(/\bp2o_[a-z_]+\b|nextOffset|supersedes=|policyBasis=/);
    await h.emit('before_agent_start', event);
    expect(options.sections.p2o_assessment).toBe(active); // replacement, not appended copies
    expect(options.selectedTools).toEqual(['read']);
    expect(options.toolGuidelines).toEqual({ read: ['READ_GUIDE'] });
    expect(event.systemPrompt).toBe('PI BASE PROMPT');
    await h.call('p2o_finish');
    await h.emit('before_agent_start', event);
    expect(options.sections.p2o_assessment).toContain('P2O FINALIZATION');
    expect(options.sections.p2o_assessment).not.toContain('P2O ASSESSMENT');
    await h.emit('agent_before_settle', { outcome: 'completed' });
    await h.emit('before_agent_start', event);
    expect(options.sections).toEqual({ other: 'UNRELATED' });
    await h.start('--target ./repo --solo');
    await h.emit('before_agent_start', event);
    await h.command('stop');
    await h.emit('before_agent_start', event);
    expect(options.sections).toEqual({ other: 'UNRELATED' });
  });

  it('accepts only immutable operator-selected images and forwards the exact binding to workers', async () => {
    h.pi.flags['p2o-image'] = 'sha256:' + 'a'.repeat(64);
    await h.start();
    await h.call('p2o_delegate', { focus: 'image-binding', task: 'read source', role: 'general', model: 'openai-codex-account-3/gpt-6.1-sol', thinking: 'xhigh' });
    const args = h.herdr.calls.find(call => call.op === 'start')!.args!;
    expect(args[args.indexOf('--p2o-image') + 1]).toBe(h.pi.flags['p2o-image']);
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-6.1-sol');
    expect(args[args.indexOf('--provider') + 1]).toBe('openai-codex-account-3');
    expect(args[args.indexOf('--thinking') + 1]).toBe('xhigh');
    const ticket = JSON.parse(await readFile(join(await h.runDir(), (await h.tickets())[0]), 'utf8'));
    expect(ticket.image).toBe(h.pi.flags['p2o-image']);
    await h.command('stop');
    h.pi.flags['p2o-image'] = 'image:latest';
    await h.command('--target ./repo');
    expect(h.contexts.notices.at(-1)).toContain('immutable');
  });

  it('asks for confirmation with the worker plan, and declining starts nothing', async () => {
    h = await harness();
    const context = createContext({ cwd: h.root, confirm: false });
    await h.command('--target ./repo --workers 2 --max-depth 1', context.ctx);
    expect(h.sandboxes).toEqual([]); expect(h.pi.messages).toEqual([]);
    expect(context.dialogs).toEqual(['Start authorized assessment?']);
    expect(context.notices.at(-1)).toContain('Cancelled');
  });

  it('delegates a worker: mints a private ticket, starts a visible pi pane with the worker flag, and briefs it', async () => {
    await h.start();
    const result = await h.call('p2o_delegate', { focus: 'idor', task: 'Validate the idor claim', context: 'nothing known', role: 'validation', skills: ['exploitability-assessment'] });
    expect(result.details.workerId).toMatch(/^p2o-validation-[0-9a-f]{6}$/);
    expect(result.details.depth).toBe(1);
    const start = h.herdr.calls.find(call => call.op === 'start')!;
    expect(start.args).toContain('--p2o-worker');
    expect(start.args).toContain('--no-extensions');
    expect(start.args).toContain('--no-approve');
    expect(start.args?.[start.args.indexOf('-e') + 1]).toBe(EXTENSION_PATH);
    // A worker gets no skill index (it cannot read host files); the selected skill is inlined in the brief.
    expect(start.args).toContain('--no-skills');
    expect(start.args).toContain('--no-context-files');
    expect(start.args?.some(value => value.endsWith('exploitability-assessment'))).toBe(false);
    const ticketFiles = await h.tickets();
    expect(ticketFiles).toHaveLength(1);
    const ticket = JSON.parse(await readFile(join(await h.runDir(), ticketFiles[0]), 'utf8'));
    expect(ticket).toMatchObject({ depth: 1, role: 'validation', parentWorkerId: null, runId: expect.any(String) });
    expect(ticket.socket).toBe(join(await h.runDir(), 'sandbox.sock'));
    const briefing = h.herdr.calls.find(call => call.op === 'prompt')!;
    expect(briefing.text).toContain('FOCUS: idor');
    expect(briefing.text).toContain('background only');
    expect(briefing.text).toContain('p2o_report');
    expect(String(briefing.text)).toContain('== Given skills');
    expect(String(briefing.text)).toContain('exploitability-assessment');
    expect(String(briefing.text).toUpperCase()).toContain('EXPLOITABILITY');
    const records = await h.records();
    expect(records.some(entry => entry.kind === 'lifecycle' && String(entry.text).includes('delegated'))).toBe(true);
  });

  it('refuses delegation when solo, capped, too deep, without the skill, or without Herdr', async () => {
    await h.start('--target ./repo --solo');
    await expect(h.call('p2o_delegate', { focus: 'x', task: 'y' })).rejects.toThrow(/DELEGATION_UNAVAILABLE/);
    await h.command('stop');

    h = await harness({ herdrAvailable: false });
    await h.start();
    await expect(h.call('p2o_delegate', { focus: 'x', task: 'y' })).rejects.toThrow(/DELEGATION_UNAVAILABLE/);
    const event = { systemPrompt: 'BASE', systemPromptOptions: { sections: {} as Record<string, string> } };
    await h.emit('before_agent_start', event);
    expect(event.systemPromptOptions.sections.p2o_assessment).toContain('Delegation is NOT available');
    await h.command('stop');

    h = await harness({ settings: { p2o: { maxWorkers: 1, maxDepth: 1 } } });
    await h.start();
    await expect(h.call('p2o_delegate', { focus: 'x', task: 'y', skills: ['not-a-skill'] })).rejects.toThrow(/SKILL_UNKNOWN/);
    await h.call('p2o_delegate', { focus: 'one', task: 'first' });
    await expect(h.call('p2o_delegate', { focus: 'two', task: 'second' })).rejects.toThrow(/DELEGATION_CAP/);
  });

  it('enforces the depth cap for nested spawns requested by a worker and reports worker state to the owner', async () => {
    h = await harness({ settings: { p2o: { maxWorkers: 2, maxDepth: 1 } } });
    await h.start();
    await h.call('p2o_delegate', { focus: 'recon', task: 'map the surface' });
    const workerId = h.herdr.calls.find(call => call.op === 'start')!.name!;
    const ticket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${workerId}.json`), 'utf8'));
    const { BrokerClient } = await import('../../src/broker.js');
    const client = new BrokerClient(ticket.socket, ticket.token, { connectMs: 2000, requestMs: 5000 });
    try {
      await expect(client.request('delegate', { focus: 'deep', task: 'nested work', role: 'validation' })).rejects.toThrow(/depth limit/);
      const view = await h.call('p2o_workers', {});
      expect(view.details.workers).toHaveLength(1);
      expect(view.details.workers[0]).toMatchObject({ workerId, status: 'working', depth: 1 });
      expect(view.details.workers[0].role).toBe('general');
      await client.request('note', { kind: 'observation', text: 'worker observed /x' });
      await client.request('report', { report: { summary: 'WORKER_SAYS_DONE', confidence: 'high', findings: ['maybe an idor'], evidence: ['cmd'], coverage: [{ surface: '/x', risk: 'rce', outcome: 'clean' }], openItems: ['no auth surface tested'] } });
      const after = await h.call('p2o_workers', {});
      expect(after.details.workers[0]).toMatchObject({ reported: true, confidence: 'high' });
      expect(after.content[0].text).toContain('WORKER_SAYS_DONE');
      // The report's coverage lands in the shared ledger for the owner.
      expect(after.details.coverage).toHaveLength(1);
      expect(after.details.coverage[0]).toMatchObject({ surface: '/x', risk: 'rce', outcome: 'clean', by: workerId });
      expect(after.details.open).toHaveLength(1);
      expect(after.content[0].text).toContain('coverage: 1');
    } finally { client.close(); }
  });

  it('spawns a nested worker when depth allows, recording parentage and the grandchild ticket', async () => {
    h = await harness({ settings: { p2o: { maxWorkers: 3, maxDepth: 2 } } });
    await h.start();
    await h.call('p2o_delegate', { focus: 'recon', task: 'map the surface' });
    const parentId = h.herdr.calls.find(call => call.op === 'start')!.name!;
    const parentTicket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${parentId}.json`), 'utf8'));
    const { BrokerClient } = await import('../../src/broker.js');
    const client = new BrokerClient(parentTicket.socket, parentTicket.token, { connectMs: 2000, requestMs: 5000 });
    try {
      const spawned = await client.request('delegate', { focus: 'validate-idor', task: 'reproduce the candidate', role: 'validation', skills: ['exploitability-assessment'] });
      expect(spawned.worker).toMatchObject({ role: 'validation', depth: 2 });
      const starts = h.herdr.calls.filter(call => call.op === 'start');
      expect(starts).toHaveLength(2);
      expect(starts[1].name).toBe(spawned.worker.workerId);
      const childTicket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${spawned.worker.workerId}.json`), 'utf8'));
      expect(childTicket).toMatchObject({ depth: 2, parentWorkerId: parentId, workerId: spawned.worker.workerId });
      expect((await h.tickets()).length).toBe(2);
      // The worker's own request is refused with the worker cap in force, and the ledger records the parentage.
      const view = await h.call('p2o_workers', {});
      expect(view.details.workers.map((entry: any) => entry.depth).sort()).toEqual([1, 2]);
      expect(view.details.workers[1]).toMatchObject({ parentWorkerId: parentId });
      expect(JSON.stringify(await h.records())).toContain('delegated');
    } finally { client.close(); }
  });

  it('serializes parallel delegation so the worker cap and depth hold, and finish waits for in-flight spawns', async () => {
    h = await harness({ settings: { p2o: { maxWorkers: 1, maxDepth: 2 } } });
    await h.start();
    const [first, second] = await Promise.allSettled([
      h.call('p2o_delegate', { focus: 'one', task: 'first objective' }),
      h.call('p2o_delegate', { focus: 'two', task: 'second objective' }),
    ]);
    expect([first, second].filter(entry => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = [first, second].find(entry => entry.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/DELEGATION_CAP/);
    expect(h.herdr.calls.filter(call => call.op === 'start')).toHaveLength(1);
    expect(await h.tickets()).toHaveLength(1);
    // A finish issued while a spawn is still in flight must not report success for that worker.
    const spawning = h.call('p2o_delegate', { focus: 'late', task: 'races finish' });
    await expect(h.call('p2o_finish')).rejects.toThrow(/WORKERS_ACTIVE|DELEGATION_CAP|cap/);
    await spawning.catch(() => {});
  });

  it('reports a pane Herdr refused to close instead of claiming verified teardown', async () => {
    await h.start();
    await h.call('p2o_delegate', { focus: 'recon', task: 'map' });
    const workerId = h.herdr.calls.find(call => call.op === 'start')!.name!;
    const ticket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${workerId}.json`), 'utf8'));
    const { BrokerClient } = await import('../../src/broker.js');
    const client = new BrokerClient(ticket.socket, ticket.token, { connectMs: 2000, requestMs: 5000 });
    await client.request('report', { report: { summary: 'done', confidence: 'low' } });
    client.close();
    h.herdr.refuseClose();
    const finish = await h.call('p2o_finish', {});
    expect(finish.content[0].text).toContain('still present');
    expect(finish.details.panesClosed).toBe(0);
    expect(finish.details.unclosedPanes).toEqual([workerId]);
    expect(h.sandboxes[0].stopCount).toBe(1);
  });

  it('inlines the role default skill for a specialist and allows a skill-less general worker', async () => {
    h = await harness({ settings: { p2o: { maxWorkers: 2, maxDepth: 2 } } });
    await h.start();
    const specialist = await h.call('p2o_delegate', { focus: 'source', task: 'review it', role: 'discovery' });
    expect(specialist.details.role).toBe('discovery');
    const specialistBrief = String(h.herdr.calls.filter(call => call.op === 'prompt').at(-1)!.text);
    expect(specialistBrief).toContain('== Given skills');
    expect(specialistBrief).toContain('<source-code-auditing>');
    // A general worker is a valid skill-less worker: no skill section at all.
    await h.call('p2o_delegate', { focus: 'x', task: 'y', role: 'general' });
    const generalBrief = String(h.herdr.calls.filter(call => call.op === 'prompt').at(-1)!.text);
    expect(generalBrief).not.toContain('== Given skills');
    // An explicitly requested unknown skill is still refused before any pane is created.
    const panes = h.herdr.calls.filter(call => call.op === 'start').length;
    await expect(h.call('p2o_delegate', { focus: 'x', task: 'y', role: 'general', skills: ['not-a-skill'] })).rejects.toThrow(/SKILL_UNKNOWN|DELEGATION_CAP/);
    expect(h.herdr.calls.filter(call => call.op === 'start').length).toBe(panes);
  });

  it('steers a worker, refuses unknown ones, and stops one on request', async () => {
    await h.start();
    await expect(h.call('p2o_steer', { workerId: 'p2o-recon-000000', message: 'hi' })).rejects.toThrow(/WORKER_UNKNOWN/);
    await h.call('p2o_delegate', { focus: 'recon', task: 'map' });
    const workerId = h.herdr.calls.find(call => call.op === 'start')!.name!;
    await h.call('p2o_steer', { workerId, message: 'narrow to /login only' });
    const steer = h.herdr.calls.filter(call => call.op === 'prompt').at(-1)!;
    expect(steer.text).toContain('steer from the assessment lead');
    expect(steer.text).toContain('narrow to /login only');
    const stopped = await h.call('p2o_stop_worker', { workerId, reason: 'objective met' });
    expect(stopped.details.status).toBe('done');
    expect(h.herdr.calls.some(call => call.op === 'close')).toBe(true);
    await expect(h.call('p2o_steer', { workerId, message: 'again' })).rejects.toThrow(/WORKER_STOPPED/);
  });

  it('refuses to finish while a worker is still working, then cleans everything up', async () => {
    await h.start();
    await h.call('p2o_delegate', { focus: 'recon', task: 'map' });
    await expect(h.call('p2o_finish')).rejects.toThrow(/WORKERS_ACTIVE/);
    const workerId = h.herdr.calls.find(call => call.op === 'start')!.name!;
    const ticket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${workerId}.json`), 'utf8'));
    const { BrokerClient } = await import('../../src/broker.js');
    const client = new BrokerClient(ticket.socket, ticket.token, { connectMs: 2000, requestMs: 5000 });
    await client.request('report', { report: { summary: 'reported before finish', confidence: 'medium' } });
    client.close();
    await h.emit('agent_before_settle', { outcome: 'completed' });
    const finish = await h.call('p2o_finish', {});
    expect(finish.details.sandboxRemoved).toBe(true);
    expect(finish.content[0].text).toContain('Container removal verified');
    expect(h.sandboxes[0].stopCount).toBe(1);
    expect(h.herdr.calls.some(call => call.op === 'close')).toBe(true);
    expect((await readdir(join(h.root, 'control'))).filter(name => name.startsWith('p2o-run-'))).toEqual([]);
    // The gate holds through the final response, then ordinary tools come back.
    expect(await h.emit('tool_call', { toolName: 'bash' })).toMatchObject({ block: true });
    await expect(h.call('p2o_shell', { command: 'id' })).rejects.toThrow(/No active p2o assessment/);
    await h.emit('agent_before_settle', { outcome: 'completed' });
    expect(h.pi.active).toContain('bash');
    expect(await h.emit('tool_call', { toolName: 'bash' })).toBeUndefined();
  });

  it('blocks host, nested and other-extension tools while active, and no tool can reach the target after stop', async () => {
    await h.start();
    for (const toolName of ['read', 'bash', 'edit', 'write', 'codemode', 'herd_spawn', 'agent_browser']) {
      expect(await h.emit('tool_call', { toolName }), toolName).toMatchObject({ block: true });
    }
    expect(await h.emit('tool_call', { toolName: 'p2o_shell', input: { command: 'id' } })).toBeUndefined();
    expect(await h.emit('tool_call', { toolName: 'p2o_report' })).toMatchObject({ block: true });
    await expect(h.emit('user_bash')).rejects.toThrow(/Host shell is blocked/);
    await h.call('p2o_shell', { command: 'id -u' });
    expect(h.sandboxes[0].commands).toEqual([{ command: 'id -u', workdir: '/work' }]);
    await h.command('stop');
    await expect(h.call('p2o_shell', { command: 'id' })).rejects.toThrow(/No active p2o assessment/);
    expect(h.pi.active).toContain('bash');
  });

  it('records owner notes, requires coverage fields, and refuses nonsense kinds', async () => {
    await h.start();
    await h.call('p2o_note', { kind: 'note', text: 'recon started' });
    await expect(h.call('p2o_note', { kind: 'coverage', text: 'clean' })).rejects.toThrow(/needs surface, risk and outcome/);
    await h.call('p2o_note', { kind: 'coverage', text: 'clean surface', surface: '/x', risk: 'sqli', outcome: 'clean', refs: ['record-1'] });
    const records = await h.records();
    expect(records.map(entry => entry.kind)).toContain('note');
    expect(records.find(entry => entry.kind === 'coverage')).toMatchObject({ surface: '/x', risk: 'sqli', outcome: 'clean', by: 'owner' });
    expect(await h.tickets()).toEqual([]);
  });

  it('keeps the gate when cleanup cannot be verified and lets /p2o stop retry', async () => {
    await h.start();
    await h.call('p2o_delegate', { focus: 'recon', task: 'map' });
    const workerId = h.herdr.calls.find(call => call.op === 'start')!.name!;
    const ticket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${workerId}.json`), 'utf8'));
    const { BrokerClient } = await import('../../src/broker.js');
    const client = new BrokerClient(ticket.socket, ticket.token, { connectMs: 2000, requestMs: 5000 });
    await client.request('report', { report: { summary: 'done', confidence: 'low' } });
    client.close();
    h.sandboxes[0].cleanupFailure = true;
    await h.command('stop');
    expect(h.contexts.notices.at(-1)).toContain('cleanup not verified');
    expect(await h.emit('tool_call', { toolName: 'bash' })).toMatchObject({ block: true });
    expect(h.sandboxes[0].stopCount).toBe(1);
    // The retry must actually run cleanup again, not return early and claim success.
    h.sandboxes[0].cleanupFailure = false;
    await h.command('stop');
    expect(h.sandboxes[0].stopCount).toBe(2);
    expect(h.contexts.notices.at(-1)).toContain('sandbox removal verified');
    expect(h.pi.active).toContain('bash');
  });

  it('stops on agent failure, session navigation and replay attempts', async () => {
    await h.start();
    await h.emit('agent_before_settle', { outcome: 'error' });
    expect(h.sandboxes[0].stopCount).toBe(1);
    expect(h.pi.active).toContain('bash');

    h = await harness();
    await h.start();
    const leaving = await h.emit('session_before_switch');
    expect(leaving).toBeUndefined();
    expect(h.sandboxes[0].stopCount).toBe(1);

    // A fresh process never activates a run from history, and stale p2o tools stay blocked.
    h = await harness();
    await h.emit('session_start', {});
    expect(h.pi.active).not.toContain('p2o_shell');
    expect(await h.emit('tool_call', { toolName: 'p2o_shell' })).toMatchObject({ block: true });
    expect(await h.emit('tool_call', { toolName: 'p2o_delegate' })).toMatchObject({ block: true });
  });

  it('cleans up when the sandbox cannot start and never briefs the agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-failstart-'));
    try {
      const pi = createFakePi();
      const sandbox = Object.assign(new InertSandbox({ kind: 'url', url: 'https://example.com', origin: 'https://example.com' }), { failStart: true });
      const herdr = createSimpleHerdr();
      registerP2O(pi.pi, { createSandbox: () => sandbox, herdr: herdr.client, controlRoot: join(root, 'control'), extensionPath: EXTENSION_PATH });
      const context = createContext({ cwd: root });
      await pi.commands.get('p2o').handler('--target https://example.com', context.ctx);
      expect(pi.messages).toEqual([]);
      expect(sandbox.stopCount).toBeGreaterThan(0);
      expect(context.notices.at(-1)).toContain('docker pull');
      const handlers = pi.events.get('tool_call') ?? [];
      let blocked: unknown;
      for (const handler of handlers) blocked = await handler({ toolName: 'bash' }, context.ctx);
      expect(blocked).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);
});
