import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { Broker, BrokerClient, type WorkerRegistration } from '../../src/broker.js';
import { ExecutorPool } from '../../src/executors.js';
import { Sandbox, type SandboxOptions } from '../../src/sandbox.js';
import type { PtyChild, PtySpawner } from '../../src/pty.js';
import type { RunProcess } from '../../src/process.js';
import { AssessmentStore } from '../../src/state/store.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

const target = { kind: 'directory' as const, path: '/inert' };
const urlTarget = { kind: 'url' as const, url: 'https://example.com', origin: 'https://example.com' };

/** A fake session sandbox that records its label, its provisioned path and its PTY bytes; no Docker, no child process. */
class SessionSandbox extends InertSandbox {
  readonly sessionId?: string;
  readonly provisionPaths: string[] = [];
  ptyWrites: string[] = [];
  ptyPending = '';
  ptyKilled = 0;
  constructor(options?: SandboxOptions) { super(target, undefined, undefined, options); this.sessionId = options?.session; }
  override async provision(assignment: string, root = '/work') { this.provisionPaths.push(`${root}/${assignment}`); this.provisionCount += 1; }
  override async exec(command: string, seconds = 0, signal?: AbortSignal, workdir = '/work', onRunning?: () => void, onOutput?: any) {
    const result = await super.exec(command, seconds, signal, workdir, onRunning, onOutput);
    return { ...result, ...(this.session ? { sessionRef: this.session } : {}) };
  }
  override async ptySend(data: string) {
    this.ptyWrites.push(data);
    const stdout = this.ptyPending; this.ptyPending = '';
    return { code: 0, stdout, stderr: '', truncated: false, ...(this.session ? { sessionRef: this.session } : {}) };
  }
  override async ptyRead() {
    const stdout = this.ptyPending; this.ptyPending = '';
    return { code: 0, stdout, stderr: '', truncated: false, ...(this.session ? { sessionRef: this.session } : {}) };
  }
}

function poolFixture(mode: 'shared' | 'isolated' | 'session' = 'session', cap = 2, sessionLimit?: number) {
  const primary = new InertSandbox(target), children: SessionSandbox[] = [];
  let active = true;
  const pool = new ExecutorPool(mode, cap, primary, session => { const sandbox = new SessionSandbox(session ? { session } : undefined); children.push(sandbox); return sandbox; }, () => active, sessionLimit);
  return { pool, primary, children, deactivate: () => { active = false; } };
}

describe('A7.2 session executor pool', () => {
  it('opens one container per session, provisions the session workdir and reuses it across assignments', async () => {
    const f = poolFixture();
    await f.pool.openSession('session-11111111');
    await f.pool.openSession('session-22222222');
    expect(f.children.map(child => child.sessionId)).toEqual(['session-11111111', 'session-22222222']);
    expect(f.children[0].provisionPaths).toEqual(['/work/sessions/session-11111111']);
    expect(f.primary.stopCount).toBe(0);
    f.pool.bind('p2o-recon-aaaaaa', 'session-11111111');
    expect(f.pool.bound('p2o-recon-aaaaaa')).toBe('session-11111111');
    await f.pool.use('p2o-recon-aaaaaa', undefined, sandbox => sandbox.exec('id', 0, undefined, sandbox.sessionWorkdir));
    await f.pool.use('p2o-recon-aaaaaa', undefined, sandbox => sandbox.exec('id', 0, undefined, sandbox.sessionWorkdir));
    expect(f.children[0].commands.map(command => command.workdir)).toEqual(['/work/sessions/session-11111111', '/work/sessions/session-11111111']);
    expect(f.children).toHaveLength(2); // no third container for two steps of the same session
    expect(f.pool.snapshot().openSessions).toEqual(['session-11111111', 'session-22222222']);
    await f.pool.stop();
    expect(f.children.every(child => child.stopCount === 1)).toBe(true);
    expect(f.primary.stopCount).toBe(0);
  });

  it('counts session operations against the same target-operation gate', async () => {
    const f = poolFixture('session', 1);
    await f.pool.openSession('session-11111111');
    await f.pool.openSession('session-22222222').catch(() => undefined); // capped at 1
    expect(f.children).toHaveLength(1);
    let release!: () => void;
    const first = f.pool.use('session-11111111', undefined, () => new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController();
    const second = f.pool.use('session-11111111', controller.signal, () => Promise.resolve('must not run'));
    expect(f.pool.snapshot()).toMatchObject({ runningTargetOperations: 1, waitingTargetOperations: 1 });
    controller.abort();
    await expect(second).rejects.toThrow('Cancelled');
    release(); await first;
    await f.pool.stop();
  });

  it('caps open sessions at the target-operation ceiling and names the cap', async () => {
    const f = poolFixture('session', 2, 2);
    await f.pool.openSession('session-11111111');
    await f.pool.openSession('session-22222222');
    await expect(f.pool.openSession('session-33333333')).rejects.toThrow('SESSION_LIMIT: 2 open session(s)');
    await expect(f.pool.openSession('session-11111111')).rejects.toThrow('SESSION_EXISTS');
    await f.pool.stop();
  });

  it('closes a session exactly once with verified removal and refuses to route it afterwards', async () => {
    const f = poolFixture();
    await f.pool.openSession('session-11111111');
    f.pool.bind('p2o-recon-aaaaaa', 'session-11111111');
    await f.pool.release('session-11111111');
    expect(f.children[0].stopCount).toBe(1);
    expect(f.pool.openSessions()).toEqual([]);
    await expect(f.pool.use('p2o-recon-aaaaaa', undefined, () => Promise.resolve('no'))).rejects.toThrow('SESSION_UNAVAILABLE');
    await f.pool.release('session-11111111'); // idempotent: no second stop, no throw
    expect(f.children[0].stopCount).toBe(1);
    await f.pool.stop();
  });

  it('keeps a lease when container removal is unverified, so /p2o stop can retry', async () => {
    const f = poolFixture();
    await f.pool.openSession('session-11111111');
    f.children[0].cleanupFailure = true;
    await expect(f.pool.release('session-11111111')).rejects.toThrow('cleanup not verified');
    expect(f.pool.openSessions()).toEqual(['session-11111111']);
    f.children[0].cleanupFailure = false;
    await f.pool.release('session-11111111');
    expect(f.pool.openSessions()).toEqual([]);
    expect(f.children[0].stopCount).toBe(2);
  });

  it('never routes a session after the owner stops, and refuses sessions in shared/isolated mode', async () => {
    const f = poolFixture();
    await f.pool.openSession('session-11111111');
    f.deactivate();
    await expect(f.pool.use('session-11111111', undefined, () => Promise.resolve('no'))).rejects.toThrow('Executor ownership inactive');
    await expect(f.pool.stop()).resolves.toBeUndefined();
    const shared = poolFixture('shared');
    await expect(shared.pool.openSession('session-11111111')).rejects.toThrow('SESSION_MODE');
    const isolated = poolFixture('isolated');
    await expect(isolated.pool.openSession('session-11111111')).rejects.toThrow('SESSION_MODE');
    await expect(isolated.pool.acquire('p2o-recon-aaaaaa').then(() => isolated.pool.openSession('session-11111111'))).rejects.toThrow('SESSION_MODE');
  });

  it('fails closed on a changed source snapshot without leaking a session lease', async () => {
    const f = poolFixture();
    f.primary.sourceManifest = { file: 'initial' };
    await expect(f.pool.openSession('session-11111111')).rejects.toThrow('SESSION_OPEN_FAILED');
    expect(f.pool.openSessions()).toEqual([]);
    expect(f.children[0].stopCount).toBe(1);
  });
});

/** A fake docker runner good enough for Sandbox.start/stop with no daemon. */
function dockerDriver() {
  const names = new Set<string>();
  const run: RunProcess = async args => {
    const flags = args[0] === '--host' ? args.slice(2) : args;
    let stdout = '';
    if (flags[0] === 'context') stdout = '"unix:///var/run/docker.sock"';
    if (flags[0] === 'info') stdout = 'linux';
    if (flags[0] === 'create') names.add(flags[flags.indexOf('--name') + 1]);
    if (flags[0] === 'inspect') stdout = 'true';
    if (flags[0] === 'rm') names.delete(flags.at(-1)!);
    if (flags[0] === 'container') stdout = [...names].join('\n');
    return { code: 0, stdout, stderr: '', truncated: false };
  };
  return { run, names };
}

class FakePtyChild implements PtyChild {
  written: string[] = [];
  killed: Array<NodeJS.Signals | undefined> = [];
  private readonly data: Array<(chunk: string) => void> = [];
  private readonly exits: Array<(code: number | null) => void> = [];
  write(data: string): void { this.written.push(data); }
  kill(signal?: NodeJS.Signals): void { this.killed.push(signal); }
  onData(listener: (chunk: string) => void): void { this.data.push(listener); }
  onExit(listener: (code: number | null) => void): void { this.exits.push(listener); }
  emit(chunk: string): void { for (const listener of this.data) listener(chunk); }
  exit(code: number | null = 0): void { for (const listener of this.exits) listener(code); }
}

describe('A7.3 sandbox PTY (no Docker)', () => {
  it('writes raw bytes into the session PTY, reads from the host cursor and kills the child before removal', async () => {
    const driver = dockerDriver(), children: FakePtyChild[] = [], args: string[][] = [];
    const spawn: PtySpawner = childArgs => { args.push([...childArgs]); const child = new FakePtyChild(); children.push(child); return child; };
    const sandbox = new Sandbox(urlTarget, driver.run, undefined, { session: 'session-aaaaaaaa', ptySpawn: spawn });
    await sandbox.start();
    const pending = sandbox.ptySend('id\n', 2000, undefined, 120);
    children[0].emit('uid=0(root)\r\n');
    const sent = await pending;
    expect(children[0].written).toEqual(['id\n']);
    expect(sent).toMatchObject({ code: 0, stdout: 'uid=0(root)\r\n', truncated: false, sessionRef: 'session-aaaaaaaa' });
    expect(args[0][2]).toBe('exec');
    expect(args[0].slice(3)).toEqual(['-i', '-t', '-w', '/work/sessions/session-aaaaaaaa', args[0].at(-2), '/bin/sh']);
    children[0].emit('second chunk\r\n');
    const read = await sandbox.ptyRead(1000);
    expect(read).toMatchObject({ stdout: 'second chunk\r\n', sessionRef: 'session-aaaaaaaa' });
    expect(await sandbox.ptyRead(100)).toMatchObject({ stdout: '' });
    await sandbox.stop();
    expect(children[0].killed).toEqual(['SIGTERM']);
    expect(driver.names.size).toBe(0); // verified removal after the PTY child was killed
    await expect(sandbox.ptySend('x', 1000)).rejects.toThrow('No active sandbox');
  });

  it('fails closed when the PTY child dies: no silent re-exec', async () => {
    const driver = dockerDriver(), children: FakePtyChild[] = [];
    const sandbox = new Sandbox(urlTarget, driver.run, undefined, { session: 'session-bbbbbbbb', ptySpawn: () => { const child = new FakePtyChild(); children.push(child); return child; } });
    await sandbox.start();
    await sandbox.ptySend('\n', 1000, undefined, 120);
    children[0].exit(3);
    await expect(sandbox.ptySend('again\n', 1000)).rejects.toThrow('PTY_DEAD');
    expect(children).toHaveLength(1);
    await sandbox.stop();
  });

  it('refuses a PTY on a non-session executor', async () => {
    const driver = dockerDriver();
    const sandbox = new Sandbox(urlTarget, driver.run);
    await sandbox.start();
    await expect(sandbox.ptySend('id\n', 1000)).rejects.toThrow('PTY_UNAVAILABLE');
    await sandbox.stop();
  });
});

/** Extension-level fixture: an owner run over inert sandboxes, a real SQLite store and the real PTY-routing code paths. */
async function sessionFixture(work: (h: any) => Promise<void>, options: { settings?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-session-'));
  await mkdir(join(root, 'source'));
  const settingsPath = join(root, 'settings.json');
  if (options.settings) await writeFile(settingsPath, JSON.stringify(options.settings), { mode: 0o600 });
  const pi = createFakePi(), ctx = createContext({ cwd: root }), herdr = createSimpleHerdr(), sandboxes: SessionSandbox[] = [];
  registerP2O(pi.pi, {
    extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath, herdr: herdr.client,
    createSandbox: (sandboxTarget: any, profile: SandboxOptions) => { const sandbox = new SessionSandbox(profile); sandboxes.push(sandbox); return sandbox; },
  });
  const command = (text: string) => pi.commands.get('p2o').handler(text, ctx.ctx);
  const call = (name: string, params: any = {}) => pi.tools.get(name).execute(randomUUID(), params, undefined, undefined, ctx.ctx);
  const reader = async () => AssessmentStore.open(join(root, '.p2o-state'), (await readdir(join(root, '.p2o-state')))[0]);
  try { await work({ root, pi, ctx, sandboxes, command, call, reader }); }
  finally { await command('stop').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
}

describe('A7.2 session tool and lifecycle', () => {
  it('refuses a session in a run without the session executor', async () => {
    await sessionFixture(async h => {
      await h.command('--target ./source');
      await expect(h.call('p2o_session', { action: 'open' })).rejects.toThrow('SESSION_MODE');
      await expect(h.call('p2o_session', { action: 'list' })).rejects.toThrow('SESSION_MODE');
    });
  });

  it('opens, lists, executes in and closes one verified session, reusing its container', async () => {
    await sessionFixture(async h => {
      await h.command('--target ./source --executors session');
      expect(h.sandboxes).toHaveLength(1); // the run's primary shell only
      const opened = await h.call('p2o_session', { action: 'open', purpose: 'credentialed foothold' });
      const session = opened.details.session as string;
      expect(session).toMatch(/^session-[a-f0-9]{8}$/);
      expect(h.sandboxes).toHaveLength(2);
      expect(h.sandboxes[1].sessionId).toBe(session);
      expect(h.sandboxes[1].provisionPaths).toEqual([`/work/sessions/${session}`]);
      const listed = await h.call('p2o_session', { action: 'list' });
      expect(listed.details.sessions).toEqual([expect.objectContaining({ session, openedBy: 'owner', purpose: 'credentialed foothold', pty: false })]);
      const snapshot = await h.call('p2o_session', { action: 'snapshot' });
      expect(snapshot.details).toMatchObject({ mode: 'session', openSessions: [session], ownedAssignmentExecutors: 1 });
      const first = await h.call('p2o_session', { action: 'exec', session, command: 'id' });
      const second = await h.call('p2o_shell', { session, command: 'whoami' });
      expect(first.content[0].text).toContain('id');
      expect(second.content[0].text).toContain('whoami');
      expect(h.sandboxes[1].commands.map((command: any) => command.workdir)).toEqual([`/work/sessions/${session}`, `/work/sessions/${session}`]);
      expect(h.sandboxes).toHaveLength(2); // both steps reused the session container, no fresh executor
      const closeMessage = await h.call('p2o_session', { action: 'close', session });
      expect(closeMessage.content[0].text).toContain('container removal is verified');
      expect(h.sandboxes[1].stopCount).toBe(1);
      // The receipt carries the session fact next to the operation, and the lifecycle records say open/close were verified.
      const store = await h.reader();
      try {
        const receipts = store.records().filter((record: any) => record.kind === 'evidence');
        expect(receipts.some((record: any) => record.data?.sessionRef === session)).toBe(true);
        const facts = store.records().flatMap((record: any) => record.data?.session ? [record.data.session] : []);
        expect(facts).toContainEqual(expect.objectContaining({ id: session, event: 'opened' }));
        expect(facts).toContainEqual(expect.objectContaining({ id: session, event: 'closed', verified: true }));
      } finally { store.close(); }
      const closed = await h.call('p2o_session', { action: 'list' });
      expect(closed.details.sessions).toEqual([]);
      await expect(h.call('p2o_shell', { session, command: 'id' })).rejects.toThrow('SESSION_UNKNOWN');
    });
  });

  it('caps open sessions at the target-operation ceiling', async () => {
    await sessionFixture(async h => {
      await h.command('--target ./source --executors session --target-ops 2');
      await h.call('p2o_session', { action: 'open' });
      await h.call('p2o_session', { action: 'open' });
      await expect(h.call('p2o_session', { action: 'open' })).rejects.toThrow('SESSION_LIMIT');
      expect(h.sandboxes).toHaveLength(3);
    });
  });

  it('policy-evaluates every PTY send before bytes reach the session, and read drains the host cursor', async () => {
    const settings = { p2o: { commandPolicy: { rules: [{ action: 'deny', match: 'PTY_PAYLOAD', reason: 'denied by the operator fixture' }] } } };
    await sessionFixture(async h => {
      await h.command('--target ./source --executors session');
      const session = (await h.call('p2o_session', { action: 'open' })).details.session as string;
      await expect(h.call('p2o_shell', { session, send: 'echo PTY_PAYLOAD\n' })).rejects.toThrow('POLICY_DENY');
      expect(h.sandboxes[1].ptyWrites).toEqual([]); // nothing reached the PTY before the decision
      h.sandboxes[1].ptyPending = 'root@target:/# ';
      const sent = await h.call('p2o_shell', { session, send: 'sudo -S id\n', timeout: 1 });
      expect(h.sandboxes[1].ptyWrites).toEqual(['sudo -S id\n']);
      expect(sent.content[0].text).toContain('root@target:/#');
      h.sandboxes[1].ptyPending = 'uid=0(root)\r\n';
      const read = await h.call('p2o_shell', { session, read: true, timeout: 1 });
      expect(read.content[0].text).toContain('uid=0(root)');
      // The send itself is receipted as one shell operation that names the session; the read is a separate pty-read operation.
      const store = await h.reader();
      try {
        const receipts = store.records().filter((record: any) => record.kind === 'evidence');
        expect(receipts.some((record: any) => record.data?.operation === 'pty-read' && record.data?.sessionRef === session)).toBe(true);
      } finally { store.close(); }
    }, { settings });
  });

  it('holds session scratch: upload materializes bounded text and download returns a retained artifact', async () => {
    await sessionFixture(async h => {
      await h.command('--target ./source --executors session');
      const session = (await h.call('p2o_session', { action: 'open' })).details.session as string;
      const uploaded = await h.call('p2o_session', { action: 'upload', session, path: 'payload/tool.sh', content: '#!/bin/sh\necho hi\n' });
      expect(uploaded.details).toMatchObject({ path: 'payload/tool.sh', root: `/work/sessions/${session}`, bytes: 18 });
      expect(h.sandboxes[1].writes).toEqual([expect.objectContaining({ path: 'payload/tool.sh', workdir: `/work/sessions/${session}`, mode: 0o600 })]);
      await expect(h.call('p2o_session', { action: 'upload', session, path: '/etc/passwd', content: 'x' })).rejects.toThrow('relative UTF-8 path');
      await expect(h.call('p2o_session', { action: 'download', session, path: '../secret' })).rejects.toThrow('traversal');
    });
  });

  it('lists opened and verified-closed sessions in the report', async () => {
    await sessionFixture(async h => {
      await h.command('--target ./source --executors session');
      const session = (await h.call('p2o_session', { action: 'open', purpose: 'report fixture' })).details.session as string;
      await h.call('p2o_session', { action: 'close', session });
      const out = join(h.root, 'out');
      await h.command(`report export ${out}`);
      const report = await readFile(join(out, 'REPORT.md'), 'utf8');
      expect(report).toContain('- Sessions: 1 opened');
      expect(report).toContain(session);
      expect(report).toContain('1 closed with verified container removal');
    });
  });

  it('force-closes every open session at stop and records the verified removal', async () => {
    await sessionFixture(async h => {
      await h.command('--target ./source --executors session');
      const session = (await h.call('p2o_session', { action: 'open', purpose: 'stop fixture' })).details.session as string;
      await h.command('stop');
      expect(h.sandboxes[1].stopCount).toBe(1);
      const store = await h.reader();
      try {
        const facts = store.records().flatMap((record: any) => record.data?.session ? [record.data.session] : []);
        expect(facts).toContainEqual(expect.objectContaining({ event: 'closed', ids: [session], by: 'stopped', verified: true }));
      } finally { store.close(); }
    });
  });
});

describe('A7.2 ticket-bound sessions (broker)', () => {
  const registration = (patch: Partial<WorkerRegistration> = {}): WorkerRegistration => ({
    workerId: 'p2o-recon-aaaaaa', name: 'p2o-recon-aaaaaa', paneId: 'w1T:p9', role: 'recon', depth: 1,
    parentWorkerId: null, token: 'c'.repeat(32), used: 0, startedAt: Date.now(), stopped: false, ...patch,
  });
  async function brokerFixture(patch: Partial<WorkerRegistration> = {}) {
    const control = await mkdtemp(join(tmpdir(), 'p2o-session-broker-'));
    const calls: string[] = [];
    const broker = new Broker(control, {
      exec: async (command, _seconds, workdir) => { calls.push(`exec ${workdir} ${command}`); return { code: 0, stdout: command, stderr: '', truncated: false }; },
      http: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
      note: async () => undefined,
      ledger: async () => [],
      delegate: async (input, parent) => ({ workerId: 'p2o-general-bbbbbb', name: 'p2o-general-bbbbbb', paneId: 'w1T:p10', role: input.role ?? 'general', depth: parent.depth + 1 }),
      report: async () => undefined,
      session: async (action, request, worker) => { calls.push(`session ${action} ${String(request.session)} ${worker.workerId}`); return { action, session: request.session }; },
      pty: async (action, request, worker) => { calls.push(`pty ${action} ${String(request.session)} ${worker.workerId}`); return { code: 0, stdout: '', stderr: '', truncated: false }; },
    }, {});
    broker.register(registration(patch));
    const socket = await broker.start();
    return { control, calls, socket, close: async () => { await broker.stop(); await rm(control, { recursive: true, force: true }); } };
  }

  it('refuses a session id the ticket does not hold', async () => {
    const f = await brokerFixture({ session: 'session-11111111' });
    const client = new BrokerClient(f.socket, 'c'.repeat(32), { requestMs: 2000 });
    try {
      await expect(client.request('session', { action: 'exec', session: 'session-22222222', command: 'id' })).rejects.toThrow('SESSION_NOT_HELD');
      await expect(client.request('pty', { action: 'send', session: 'session-22222222', data: 'id\n' })).rejects.toThrow('SESSION_NOT_HELD');
      const held = await client.request('session', { action: 'exec', command: 'id' });
      expect(held.ok).toBe(true);
      expect(f.calls).toContain('session exec session-11111111 p2o-recon-aaaaaa');
    } finally { client.close(); await f.close(); }
  });

  it('refuses session I/O when the ticket holds no session yet', async () => {
    const f = await brokerFixture();
    const client = new BrokerClient(f.socket, 'c'.repeat(32), { requestMs: 2000 });
    try {
      await expect(client.request('session', { action: 'exec', command: 'id' })).rejects.toThrow('SESSION_UNBOUND');
      const opened = await client.request('session', { action: 'open', purpose: 'own session' });
      expect(opened.ok).toBe(true);
    } finally { client.close(); await f.close(); }
  });
});
