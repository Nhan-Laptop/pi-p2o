import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerP2O, testSeamFor } from '../../extensions/p2o/index.js';
import { campaignFrom, campaignStartLine, ingressFacts, ingressLines, parseCampaign } from '../../src/campaign.js';
import type { OutputObserver, RunProcess } from '../../src/process.js';
import { Sandbox, type SandboxOptions } from '../../src/sandbox.js';
import { AssessmentStore } from '../../src/state/store.js';
import { parseCommand } from '../../src/target.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

/**
 * A7.8/D22 (planning_update.md P7.7): ingress. The operator can name one out-of-band callback destination and/or a lab network
 * the sandboxes join; a listener is then startable and healthchecked inside a session, never published to the host. Hermetic:
 * fake docker/inert sandboxes, a real SQLite store, no model and no target.
 */
const URL_TARGET = { kind: 'url' as const, url: 'https://example.com', origin: 'https://example.com' };

/** A sandbox double that keeps the profile it was created with and can fail the loopback healthcheck on demand. */
class IngressSandbox extends InertSandbox {
  readonly sessionId?: string;
  readonly network?: string;
  failProbe = false;
  override get containerName(): string | undefined { return 'p2o-fixture-container'; }
  constructor(target: any, options?: SandboxOptions) {
    super(target, undefined, undefined, options);
    this.sessionId = options?.session;
    this.network = options?.network;
  }
  override async exec(command: string, seconds = 0, signal?: AbortSignal, workdir = '/work', onRunning?: () => void, onOutput?: OutputObserver) {
    if (this.failProbe && command.includes('while [ $i -lt 20 ]')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 1, stdout: '', stderr: 'connection refused', truncated: false };
    }
    return super.exec(command, seconds, signal, workdir, onRunning, onOutput);
  }
}

async function ingressFixture(work: (h: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-ingress-'));
  await mkdir(join(root, 'source'));
  const pi = createFakePi(), worker = createFakePi(), ctx = createContext({ cwd: root }), workerCtx = createContext({ cwd: root });
  const herdr = createSimpleHerdr(), sandboxes: IngressSandbox[] = [];
  registerP2O(pi.pi, {
    extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'settings.json'), herdr: herdr.client,
    createSandbox: (target: any, options: any) => { const sandbox = new IngressSandbox(target, options); sandboxes.push(sandbox); return sandbox; },
  });
  registerP2O(worker.pi, { extensionPath: EXTENSION_PATH });
  const command = (text: string, which: 'owner' | 'worker' = 'owner') => (which === 'owner' ? pi : worker).commands.get('p2o').handler(text, (which === 'owner' ? ctx : workerCtx).ctx);
  // S1/B10: the hidden delegate/task-start verbs are gone; the harness runs their code through the registration seam.
  const seam = (name: string, params: any) => name === 'p2o_delegate' ? testSeamFor(pi.pi).spawn(params) : name === 'p2o_task_start' ? testSeamFor(pi.pi).startTask(params) : undefined;
  const call = (name: string, params: any = {}, which: 'owner' | 'worker' = 'owner') => seam(name, params) ?? (which === 'owner' ? pi : worker).tools.get(name).execute(randomUUID(), params, undefined, undefined, (which === 'owner' ? ctx : workerCtx).ctx);
  const emit = async (event: string, payload: any = {}, which: 'owner' | 'worker' = 'owner') => {
    const selected = which === 'owner' ? pi : worker, active = (which === 'owner' ? ctx : workerCtx).ctx;
    let result: unknown;
    for (const handler of selected.events.get(event) ?? []) result = await handler(payload, active);
    return result;
  };
  const runDir = async () => {
    const created = (await readdir(join(root, 'control'))).find(name => name.startsWith('p2o-run-'));
    if (!created) throw new Error('no control directory');
    return join(root, 'control', created);
  };
  const reader = async () => AssessmentStore.open(join(root, '.p2o-state'), (await readdir(join(root, '.p2o-state')))[0]);
  const prompt = async () => {
    const event = { systemPromptOptions: { sections: {} as Record<string, string> }, prompt: '' };
    for (const handler of pi.events.get('before_agent_start') ?? []) await handler(event, ctx.ctx);
    return event.systemPromptOptions.sections['p2o_assessment'];
  };
  try {
    await work({ root, pi, worker, ctx, workerCtx, herdr, sandboxes, command, call, emit, runDir, reader, prompt });
  } finally { await command('stop').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
}

describe('A7.8 ingress flags', () => {
  it('parses one callback destination and one operator network, refusing malformed values', () => {
    const parsed = parseCommand('--target ./source --callback https://cb.example/p2o/proof?run=1 --lab-network operator-lab');
    expect(parsed).toMatchObject({ action: 'start', options: { callback: 'https://cb.example/p2o/proof?run=1', labNetwork: 'operator-lab' } });
    for (const bad of ['https://user:pw@cb.example/x', 'https://cb.example/x#fragment', 'ftp://cb.example/x', 'cb.example/x', 'https://cb.example/a b']) {
      expect(() => parseCommand(`--target ./source --callback ${bad}`), bad).toThrow(/--callback/);
    }
    for (const bad of ['host', 'none', 'bridge', '-lab', 'a'.repeat(65), 'bad network']) {
      expect(() => parseCommand(`--target ./source --lab-network ${bad}`), bad).toThrow(/--lab-network/);
    }
    expect(() => parseCommand('--target ./source --callback https://a.example --callback https://b.example')).toThrow(/--callback may be given only once/);
    expect(() => parseCommand('--target ./source --lab-network one --lab-network two')).toThrow(/--lab-network may be given only once/);
    expect(() => parseCommand('--target ./source --callback')).toThrow(/--callback/);
  });

  it('records the ingress path in the campaign frame v2 and rejects a stored record that carries a malformed one', () => {
    const record = campaignFrom({ target: 'https://cart.example', at: '2026-01-01T00:00:00.000Z', goal: 'Assess the fixture cart', callback: 'https://cb.example/proof', labNetwork: 'operator-lab' });
    expect(record).toMatchObject({ v: 2, callback: 'https://cb.example/proof', labNetwork: 'operator-lab' });
    expect(parseCampaign(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(campaignStartLine(record)).toContain('ingress: callback https://cb.example/proof, lab network operator-lab');
    expect(ingressFacts(record)).toEqual({ callback: 'https://cb.example/proof', labNetwork: 'operator-lab' });
    expect(ingressFacts(campaignFrom({ target: 'x', at: '2026-01-01T00:00:00.000Z' }))).toBeUndefined();
    // A stored frame is one authority: a destination that could not be printed is not silently dropped.
    expect(parseCampaign({ ...record, callback: 'https://user:pw@cb.example/x' })).toBeUndefined();
    expect(parseCampaign({ ...record, labNetwork: 'host' })).toBeUndefined();
    // A pre-mode record reads as assess and has no ingress fields.
    const v1 = parseCampaign({ v: 1, objective: 'read only', constraints: [], targetRevision: '', heartbeatSeconds: 0, startedAt: '2026-01-01T00:00:00.000Z', createdBy: 'operator' });
    expect(v1).toMatchObject({ v: 2, mode: 'assess', effectClasses: [] });
    expect(ingressFacts(v1)).toBeUndefined();
  });

  it('states honestly what each path can and cannot prove', () => {
    const none = ingressLines(undefined).join('\n');
    expect(none).toContain('INGRESS — none configured');
    expect(none).toContain('open gap');
    const callback = ingressLines({ callback: 'https://cb.example/x' }).join('\n');
    expect(callback).toContain('DESTINATION the target reaches out to, not a listener');
    const lab = ingressLines({ labNetwork: 'operator-lab' }).join('\n');
    expect(lab).toContain('operator lab network "operator-lab"');
    expect(lab).toContain('no port is published to the host');
    expect(lab).toContain('p2o_session action=listen');
  });

  it('verifies an operator network with docker before creating anything, and never publishes a port', async () => {
    function driver(networkExists: boolean) {
      const calls: string[][] = [];
      const run: RunProcess = async (args) => {
        calls.push(args);
        const flags = args[0] === '--host' ? args.slice(2) : args;
        let stdout = '', code = 0, stderr = '';
        if (flags[0] === 'context') stdout = '"unix:///var/run/docker.sock"';
        else if (flags[0] === 'info') stdout = 'linux';
        else if (flags[0] === 'network' && flags[1] === 'inspect') { if (!networkExists) { code = 1; stderr = 'Error response from daemon: network operator-lab not found'; } }
        else if (flags[0] === 'inspect') stdout = 'true';
        return { code, stdout, stderr, truncated: false };
      };
      return { calls, run };
    }
    const present = driver(true);
    const sandbox = new Sandbox(URL_TARGET, present.run, undefined, { runId: 'ingress-test', network: 'operator-lab' });
    await sandbox.start();
    expect(present.calls.some(args => (args[0] === '--host' ? args.slice(2) : args).join(' ') === 'network inspect operator-lab')).toBe(true);
    const create = present.calls.find(args => (args[0] === '--host' ? args[2] : args[0]) === 'create')!;
    expect(create).toContain('--network');
    expect(create[create.indexOf('--network') + 1]).toBe('operator-lab');
    for (const arg of present.calls.flat()) expect(['-p', '--publish']).not.toContain(arg);
    await sandbox.stop();

    const absent = driver(false);
    const refused = new Sandbox(URL_TARGET, absent.run, undefined, { runId: 'ingress-test', network: 'operator-lab' });
    await expect(refused.start()).rejects.toThrow(/network operator-lab not found/);
    expect(absent.calls.some(args => (args[0] === '--host' ? args[2] : args[0]) === 'create')).toBe(false);
  });
});

describe('A7.8 ingress in prompts, tickets and reports', () => {
  it('records the path, passes the network to the sandbox and states it in the planner prompt and every worker ticket', async () => ingressFixture(async h => {
    await h.command('--target ./source --lab-network operator-lab --callback https://cb.example/p2o/proof');
    const confirmation = h.ctx.confirmBodies.at(-1) as string;
    expect(confirmation).toContain('Ingress:');
    expect(confirmation).toContain('operator callback https://cb.example/p2o/proof');
    expect(confirmation).toContain('operator lab network "operator-lab"');
    expect(confirmation).toMatch(/no host port is published/);
    expect(h.sandboxes[0].network).toBe('operator-lab');
    const planner = await h.prompt();
    expect(planner).toContain('INGRESS — operator callback https://cb.example/p2o/proof');
    expect(planner).toContain('INGRESS — operator lab network "operator-lab"');
    const store = await h.reader();
    try { expect(store.campaign()).toMatchObject({ v: 2, callback: 'https://cb.example/p2o/proof', labNetwork: 'operator-lab', mode: 'exploit' }); } finally { store.close(); }
    // Every worker ticket carries the same two facts, and its system prompt states the same path.
    const workerId = (await h.call('p2o_delegate', { focus: 'surface-recon', task: 'Inspect the fixture source', context: 'nothing known yet' })).details.workerId;
    const ticketPath = join(await h.runDir(), `ticket-${workerId}.json`);
    expect(JSON.parse(await readFile(ticketPath, 'utf8')).ingress).toEqual({ callback: 'https://cb.example/p2o/proof', labNetwork: 'operator-lab' });
    h.worker.flags['p2o-worker'] = ticketPath;
    await h.emit('session_start', {}, 'worker');
    const event = { systemPromptOptions: { sections: {} as Record<string, string> }, systemPrompt: 'base', prompt: '' };
    let workerPrompt: string | undefined;
    for (const handler of h.worker.events.get('before_agent_start') ?? []) { const output = await handler(event, h.workerCtx.ctx); if (output?.systemPrompt) workerPrompt = output.systemPrompt; }
    expect(workerPrompt).toContain('INGRESS — operator lab network "operator-lab"');
    expect(workerPrompt).toContain('INGRESS — operator callback https://cb.example/p2o/proof');
  }));

  it('leaves both surfaces unchanged when the operator configured no ingress path', async () => ingressFixture(async h => {
    await h.command('--target ./source');
    const planner = await h.prompt();
    expect(planner).not.toContain('INGRESS —');
    expect((h.sandboxes[0] as IngressSandbox).network).toBeUndefined();
    const store = await h.reader();
    // P18/A9: the default campaign exists, and it records no ingress path the operator never configured.
    try { expect(store.campaign()).toMatchObject({ createdBy: 'default' }); expect(store.campaign()).not.toHaveProperty('callback'); expect(store.campaign()).not.toHaveProperty('labNetwork'); } finally { store.close(); }
  }));
});

describe('A7.8 in-sandbox listener', () => {
  it('starts and healthchecks one listener in a session, lists it, and states the ingress path in the report', async () => ingressFixture(async h => {
    await h.command('--target ./source --executors session --lab-network operator-lab');
    const session = (await h.call('p2o_session', { action: 'open', purpose: 'reverse shell catcher' })).details.session as string;
    const listener = await h.call('p2o_session', { action: 'listen', session, port: 4444 });
    expect(listener.details).toMatchObject({ session, port: 4444, protocol: 'tcp', address: 'p2o-fixture-container:4444', labNetwork: 'operator-lab' });
    expect(listener.content[0].text).toContain('p2o-fixture-container:4444');
    expect(listener.details.note).toContain('no host port was published');
    const child = h.sandboxes[1] as IngressSandbox;
    expect(child.sessionId).toBe(session);
    expect(child.commands.some(entry => entry.command.includes("cat > listeners/listen-4444.py <<'P2O_LISTENER'"))).toBe(true);
    expect(child.commands.some(entry => entry.command.includes('while [ $i -lt 20 ]'))).toBe(true); // loopback healthcheck
    const listed = (await h.call('p2o_session', { action: 'list' })).details.sessions;
    expect(listed.find((entry: any) => entry.session === session).listens).toEqual([{ port: 4444, protocol: 'tcp', address: 'p2o-fixture-container:4444', log: 'listeners/listen-4444.log' }]);
    // Bounded reuse rules: one listener per port, tcp only, an integer port.
    await expect(h.call('p2o_session', { action: 'listen', session, port: 4444 })).rejects.toThrow('LISTEN_EXISTS');
    await expect(h.call('p2o_session', { action: 'listen', session, port: 4445, protocol: 'udp' })).rejects.toThrow('INGRESS_UNAVAILABLE');
    await expect(h.call('p2o_session', { action: 'listen', session, port: 0 })).rejects.toThrow('INVALID_INPUT');
    // The report states which path existed and which listener it carried, from committed records.
    await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await readFile(join(h.root, 'out', 'REPORT.md'), 'utf8')).replace(/\\([()])/g, '$1');
    expect(report).toContain('- Callback endpoint: lab network "operator-lab"');
    expect(report).toContain('tcp 4444 at p2o-fixture-container:4444');
    // A7.10 truth: with a lab network the scope section must state that path instead of repeating the default "no inbound".
    expect(report).toContain('joined the operator lab network "operator-lab"');
    expect(report).toContain('no tunnel or pivot exists');
    expect(report).not.toContain('There is no inbound path, so a target cannot call back to the sandbox.');
    const store = await h.reader();
    try {
      const fact = store.records().find((record: any) => record.kind === 'lifecycle' && record.data?.session?.event === 'listen');
      expect(fact?.data?.session).toMatchObject({ port: 4444, protocol: 'tcp', address: 'p2o-fixture-container:4444', healthy: true });
    } finally { store.close(); }
    // The listener dies with its container (no leftover listener and no host port was ever added).
    await h.call('p2o_session', { action: 'close', session });
    expect(child.stopCount).toBe(1);
    await expect(h.call('p2o_session', { action: 'listen', session, port: 4446 })).rejects.toThrow('SESSION_UNKNOWN');
  }));

  it('stops an unhealthy listener and records no address', async () => ingressFixture(async h => {
    await h.command('--target ./source --executors session --lab-network operator-lab');
    const session = (await h.call('p2o_session', { action: 'open' })).details.session as string;
    const child = h.sandboxes[1] as IngressSandbox;
    child.failProbe = true;
    await expect(h.call('p2o_session', { action: 'listen', session, port: 4444 })).rejects.toThrow('INGRESS_UNHEALTHY');
    expect(child.commands.some(entry => entry.command.includes('kill "$(cat listeners/listen-4444.pid)"'))).toBe(true);
    const listed = (await h.call('p2o_session', { action: 'list' })).details.sessions;
    expect(listed[0].listens).toBeUndefined();
  }));

  it('refuses a listener that no path can reach, and lets a ticket-bound worker start one on its own session', async () => {
    await ingressFixture(async h => {
      await h.command('--target ./source --executors session --callback https://cb.example/proof');
      const session = (await h.call('p2o_session', { action: 'open' })).details.session as string;
      await expect(h.call('p2o_session', { action: 'listen', session, port: 4444 })).rejects.toThrow(/destination the target reaches/);
      expect(h.sandboxes[1].commands.some((entry: { command: string }) => entry.command.includes('P2O_LISTENER'))).toBe(false);
    });
    await ingressFixture(async h => {
      await h.command('--target ./source --executors session');
      const session = (await h.call('p2o_session', { action: 'open' })).details.session as string;
      await expect(h.call('p2o_session', { action: 'listen', session, port: 4444 })).rejects.toThrow(/--lab-network/);
    });
    // A worker reaches listenFor through its own ticket-bound session; the owner sees the same fact.
    await ingressFixture(async h => {
      await h.command('--target ./source --executors session --lab-network operator-lab');
      const workerId = (await h.call('p2o_delegate', { focus: 'surface-recon', task: 'Prepare the reverse-shell catcher', context: 'nothing known yet' })).details.workerId;
      h.worker.flags['p2o-worker'] = join(await h.runDir(), `ticket-${workerId}.json`);
      await h.emit('session_start', {}, 'worker');
      const opened = await h.call('p2o_session', { action: 'open', purpose: 'catcher' }, 'worker');
      expect(opened.details.session).toMatch(/^session-[a-f0-9]{8}$/);
      const listener = await h.call('p2o_session', { action: 'listen', session: opened.details.session, port: 4444 }, 'worker');
      expect(listener.details.address).toBe('p2o-fixture-container:4444');
      const listed = (await h.call('p2o_session', { action: 'list' })).details.sessions;
      expect(listed[0]).toMatchObject({ openedBy: workerId, listens: [expect.objectContaining({ port: 4444 })] });
    });
  });
});
