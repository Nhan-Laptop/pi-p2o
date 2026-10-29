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
import { FOOTHOLD_ACTIONS, validationMayUseSession } from '../../src/foothold.js';
import { TOOL_BOUNDARIES } from '../../src/tool-guidelines.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

const target = { kind: 'directory' as const, path: '/inert' };
const urlTarget = { kind: 'url' as const, url: 'https://example.com', origin: 'https://example.com' };

/** A fake session sandbox that records its label, its provisioned path, its PTY bytes and an inert foothold; no Docker. */
class SessionSandbox extends InertSandbox {
  readonly sessionId?: string;
  readonly provisionPaths: string[] = [];
  ptyWrites: string[] = [];
  ptyPending = '';
  ptyKilled = 0;
  /** A17.8: the fake relay's transcript and peer marker, so the real foothold state machine can run over it. */
  footholdLog = '';
  peerConnected = false;
  readonly footholdSends: string[] = [];
  constructor(options?: SandboxOptions) { super(target, undefined, undefined, options); this.sessionId = options?.session; }
  override get containerName(): string | undefined { return this.session ? `p2o-${this.session}` : undefined; }
  override async provision(assignment: string, root = '/work') { this.provisionPaths.push(`${root}/${assignment}`); this.provisionCount += 1; }
  override async exec(command: string, seconds = 0, signal?: AbortSignal, workdir = '/work', onRunning?: () => void, onOutput?: any) {
    if (this.session && command.includes("<<'P2O_FOOTHOLD'")) {
      this.commands.push({ command, workdir, timeout: seconds });
      const port = /foothold-(\d+)\.py/.exec(command)?.[1];
      this.footholdLog = `[p2o] listening on 0.0.0.0:${port}\n`;
      return { code: 0, stdout: '', stderr: '', truncated: false };
    }
    if (this.session && command.includes('while [ $i -lt 20 ]') && command.includes('listening on 0.0.0.0')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: 'listening', stderr: '', truncated: false };
    }
    if (this.session && command.startsWith('test -f ') && command.includes('.peer')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: this.peerConnected ? 0 : 1, stdout: '', stderr: '', truncated: false };
    }
    if (this.session && command.includes('b64decode')) {
      this.commands.push({ command, workdir, timeout: seconds });
      this.footholdSends.push(command);
      return { code: 0, stdout: '', stderr: '', truncated: false };
    }
    if (this.session && command.includes('"capturedBytes"')) {
      this.commands.push({ command, workdir, timeout: seconds });
      const args = / (\d+) (\d+)$/.exec(command)!;
      const bytes = Buffer.from(this.footholdLog, 'utf8');
      const start = Math.min(Number(args[1]), bytes.length);
      const data = bytes.subarray(start, start + Number(args[2]));
      return { code: 0, stdout: `${JSON.stringify({ totalBytes: bytes.length, offset: start, capturedBytes: data.length })}\n${data.toString('utf8')}`, stderr: '', truncated: false };
    }
    if (this.session && command.startsWith('cat foothold/') && command.endsWith('.log')) {
      this.commands.push({ command, workdir, timeout: seconds });
      onOutput?.('stdout', Buffer.from(this.footholdLog, 'utf8'));
      return { code: 0, stdout: this.footholdLog, stderr: '', truncated: false };
    }
    if (this.session && command.startsWith('cat foothold/') && command.endsWith('.pid 2>/dev/null')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: '4242\n', stderr: '', truncated: false };
    }
    if (this.session && command.includes('kill -0')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: '', stderr: '', truncated: false };
    }
    if (this.session && command.includes('rm -f foothold/') && command.includes('test ! -e')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: '', stderr: '', truncated: false };
    }
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
      expect(h.sandboxes[1].captures).toHaveLength(0); // a refused path never reaches the sandbox
      const downloaded = await h.call('p2o_session', { action: 'download', session, path: 'payload/tool.sh' });
      expect(downloaded.details).toMatchObject({ exitCode: 0 });
      expect(downloaded.details.capture.source).toMatchObject({ root: `/work/sessions/${session}`, path: 'payload/tool.sh' });
      expect(h.sandboxes[1].captures).toEqual([expect.objectContaining({ path: 'payload/tool.sh', workdir: `/work/sessions/${session}`, root: `/work/sessions/${session}` })]);
      const artifact = downloaded.details.capture.artifacts[0];
      expect(downloaded.content[0].text).toContain(`Artifact ID: ${artifact.id}`);
      expect(downloaded.content[0].text).toContain('echo hi');
      const store = await h.reader();
      try {
        // The retained manifest names the producer root and the session the capture came from, not just a loose path.
        expect(store.artifacts().find((row: any) => row.id === artifact.id)).toMatchObject({ producer: 'owner', kind: 'scratch-file',
          sessionId: session, captureSource: { root: `/work/sessions/${session}` } });
        expect(store.artifact(artifact.id, 0, 8192).text).toContain('#!/bin/sh');
      } finally { store.close(); }
    });
  });

  it('keeps execution authority when a session download is refused on provenance, instead of reporting a storage failure', async () => {
    await sessionFixture(async h => {
      await h.command('--target ./source --executors session');
      const session = (await h.call('p2o_session', { action: 'open' })).details.session as string;
      await h.call('p2o_session', { action: 'upload', session, path: 'note.txt', content: 'proof of concept\n' });
      // A capture that claims a root this run never assigned is refused by the store, after the executor returned.
      h.sandboxes[1].captureRootOverride = '/work/elsewhere';
      await expect(h.call('p2o_session', { action: 'download', session, path: 'note.txt' })).rejects.toThrow('producer');
      expect(h.ctx.notices.filter((notice: string) => notice.includes('Storage failed'))).toEqual([]);
      const after = await h.call('p2o_shell', { command: 'id' });
      expect(after.details.exitCode).toBe(0);
      const store = await h.reader();
      try {
        const returned = store.events({ limit: 100 }).rows.filter((event: any) => event.kind === 'operation.returned' && event.data?.retentionIncomplete);
        expect(returned).toHaveLength(1); // the operation reports an incomplete retention, not a closed authority
        expect(store.manifest().runId).toBeTruthy();
      } finally { store.close(); }
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

describe('A17.8 interactive foothold session actions', () => {
  it('refuses a foothold without --lab-network and names the exact legal next', async () => {
    await sessionFixture(async h => {
      await h.command('--target ./source --executors session');
      const session = (await h.call('p2o_session', { action: 'open' })).details.session as string;
      await expect(h.call('p2o_session', { action: 'foothold-open', session, port: 4444 })).rejects.toThrow(/INGRESS_UNAVAILABLE:.*--lab-network/);
      expect(h.sandboxes[1].commands.some((entry: any) => entry.command.includes('P2O_FOOTHOLD'))).toBe(false);
      // The catcher still needs the same ingress path; nothing else about `listen` moved.
      await expect(h.call('p2o_session', { action: 'listen', session, port: 4444 })).rejects.toThrow('INGRESS_UNAVAILABLE');
    });
  });

  it('drives one persistent foothold: identity gate, uncapped sends, bounded preview + transcript artifact, verified close', async () => {
    await sessionFixture(async h => {
      await h.command('--target ./source --executors session --lab-network operator-lab');
      const session = (await h.call('p2o_session', { action: 'open' })).details.session as string;
      const sandbox = h.sandboxes[1] as any;
      const address = `p2o-${session}:4444`;
      // A catcher on the intended port refuses the collision in both directions; the foothold is one per session.
      await h.call('p2o_session', { action: 'listen', session, port: 4445 });
      await expect(h.call('p2o_session', { action: 'foothold-open', session, port: 4445 })).rejects.toThrow('FOOTHOLD_PORT_CONFLICT');
      const opened = await h.call('p2o_session', { action: 'foothold-open', session, port: 4444 });
      expect(opened.details).toMatchObject({ session, port: 4444, address, log: 'foothold/foothold-4444.log', connected: false, labNetwork: 'operator-lab' });
      expect(opened.content[0].text).toContain('No host port is published');
      expect(opened.content[0].text).toContain('ONE connection');
      await expect(h.call('p2o_session', { action: 'foothold-open', session, port: 4446 })).rejects.toThrow('FOOTHOLD_EXISTS');
      await expect(h.call('p2o_session', { action: 'listen', session, port: 4444 })).rejects.toThrow('LISTEN_EXISTS');
      // No peer yet: identify refuses with the legal next; send/read are gated on the identity that cannot be made.
      await expect(h.call('p2o_session', { action: 'foothold-identify', session })).rejects.toThrow(/FOOTHOLD_NOT_CONNECTED:.*hand that address/);
      await expect(h.call('p2o_session', { action: 'foothold-send', session, text: 'id' })).rejects.toThrow('FOOTHOLD_NOT_CONNECTED');
      sandbox.peerConnected = true;
      sandbox.footholdLog += 'root\nuid=0(root) gid=0(root) groups=0(root)\n';
      // Connected but not identified: the identity gate names whoami/id and no model bytes reach the peer.
      await expect(h.call('p2o_session', { action: 'foothold-send', session, text: 'id' })).rejects.toThrow(/FOOTHOLD_NEEDS_IDENTITY:.*whoami; id/);
      await expect(h.call('p2o_session', { action: 'foothold-read', session })).rejects.toThrow('FOOTHOLD_NEEDS_IDENTITY');
      expect(sandbox.footholdSends).toEqual([]); // nothing model-authored reached the peer before the gate
      const identified = await h.call('p2o_session', { action: 'foothold-identify', session });
      expect(identified.details.identified.observation).toContain('uid=0(root)');
      expect(identified.details.identified.at).toMatch(/T/);
      // Sending is uncapped by the foothold: a 20 KiB line is one shell operation with a receipt.
      const sent = await h.call('p2o_session', { action: 'foothold-send', session, text: 'B'.repeat(20 * 1024) });
      expect(sent.details.bytes).toBe(20 * 1024 + 1);
      expect(sent.details.evidenceId).toMatch(/^[0-9a-f-]{36}$/); // one receipted shell operation, not a bare write
      expect(sandbox.footholdSends).toHaveLength(2); // the recorded whoami/id probe + this one send
      // The preview is bounded; the cursor advances; a larger transcript is retained through the capture path.
      const first = await h.call('p2o_session', { action: 'foothold-read', session });
      expect(first.details).toMatchObject({ session, port: 4444, truncated: false });
      expect(first.content[0].text).toContain('[foothold tcp 4444 at');
      sandbox.footholdLog += 'X'.repeat(9 * 1024);
      const large = await h.call('p2o_session', { action: 'foothold-read', session });
      expect(large.details.truncated).toBe(true);
      expect(large.details.artifact).toMatchObject({ id: expect.stringMatching(/^artifact-/), truncated: false });
      expect(large.content[0].text).toContain(`transcript ${large.details.artifact.id}`);
      const listed = (await h.call('p2o_session', { action: 'list' })).details.sessions as any[];
      expect(listed.find(row => row.session === session).footholds).toEqual([expect.objectContaining({ port: 4444, address, connected: true, identifiedAt: expect.any(String), observation: expect.stringContaining('uid=0(root)') })]);
      // Close kills the relay and verifies removal; the transcript log stays for its capture path.
      const closed = await h.call('p2o_session', { action: 'foothold-close', session });
      expect(closed.details).toMatchObject({ session, port: 4444, closed: true, verified: true });
      expect(sandbox.commands.some((entry: any) => entry.command.includes('kill 4242'))).toBe(true);
      expect(sandbox.commands.some((entry: any) => entry.command.includes('test ! -e foothold/foothold-4444.pid'))).toBe(true);
      await expect(h.call('p2o_session', { action: 'foothold-send', session, text: 'id' })).rejects.toThrow('FOOTHOLD_NOT_OPEN');
      const after = (await h.call('p2o_session', { action: 'list' })).details.sessions as any[];
      expect(after.find(row => row.session === session).footholds[0]).toMatchObject({ port: 4444, connected: false, closedAt: expect.any(String) });
      await h.command(`report export ${join(h.root, 'out')}`);
      const report = (await readFile(join(h.root, 'out', 'REPORT.md'), 'utf8')).replace(/\\([()])/g, '$1');
      expect(report).toContain('1 interactive foothold shell(s)');
      expect(report).toContain('1 identity confirmation(s) recorded');
      expect(report).toContain('1 relay removal(s) verified');
      expect(report).toContain(`tcp 4444 at ${address} (identity confirmed through the shell)`);
    });
  });

  it('keeps the foothold across steps and closes it with its session, recording every foothold operation', async () => {
    await sessionFixture(async h => {
      await h.command('--target ./source --executors session --lab-network operator-lab');
      const session = (await h.call('p2o_session', { action: 'open' })).details.session as string;
      const sandbox = h.sandboxes[1] as any;
      await h.call('p2o_session', { action: 'foothold-open', session, port: 4444 });
      // A later step in the same session does not tear the foothold down: the relay belongs to the session, not the step.
      await h.call('p2o_session', { action: 'exec', session, command: 'id' });
      sandbox.peerConnected = true;
      sandbox.footholdLog += 'root\nuid=0(root) gid=0(root) groups=0(root)\n';
      const identified = await h.call('p2o_session', { action: 'foothold-identify', session });
      expect(identified.details.identified).toMatchObject({ method: 'listener', user: 'root', uid: 0 });
      await h.call('p2o_session', { action: 'foothold-send', session, text: 'id' });
      await h.call('p2o_session', { action: 'foothold-read', session });
      // Every foothold operation is a session operation in the ledger, and the identity row is citable as fields.
      const store = await h.reader();
      try {
        const facts = store.records().flatMap((record: any) => record.data?.session ? [record.data.session] : []);
        expect(facts).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: session, event: 'foothold-open', port: 4444 }),
          expect.objectContaining({ id: session, event: 'foothold-identity', user: 'root', uid: 0, method: 'listener' }),
          expect.objectContaining({ id: session, event: 'foothold-send', bytes: 3 }),
          expect.objectContaining({ id: session, event: 'foothold-read', port: 4444 }),
        ]));
        expect(facts.find((fact: any) => fact.event === 'foothold-identity').observation).toContain('uid=0(root)');
      } finally { store.close(); }
      const listed = (await h.call('p2o_session', { action: 'list' })).details.sessions.find((row: any) => row.session === session);
      expect(listed.footholds[0]).toMatchObject({ port: 4444, connected: true, user: 'root', uid: 0, method: 'listener' });
      // Session end removes the container the relay lived in; the foothold cannot be driven afterwards.
      await h.call('p2o_session', { action: 'close', session });
      expect(sandbox.stopCount).toBe(1);
      await expect(h.call('p2o_session', { action: 'foothold-send', session, text: 'id' })).rejects.toThrow('SESSION_UNKNOWN');
      await expect(h.call('p2o_session', { action: 'foothold-read', session })).rejects.toThrow('SESSION_UNKNOWN');
    });
  });

  it('keeps the validation worker at action=open only for every new foothold action', async () => {
    await sessionFixture(async h => {
      await h.command('--target ./source --executors session --lab-network operator-lab');
      // A7.2 kept validation workers independent by allowing `open` alone; A17.8 extends that one predicate, so every
      // foothold action inherits the same refusal instead of opening a second path into a discovery session.
      expect(validationMayUseSession('open')).toBe(true);
      for (const action of FOOTHOLD_ACTIONS) expect(validationMayUseSession(action), action).toBe(false);
      const description = h.pi.tools.get('p2o_session').description as string;
      expect(description).toContain('a validation worker gets action=open only');
      // The broker handler still routes `open` before the foothold actions, and the predicate is what it calls.
      expect(description).not.toContain('validation worker gets action=foothold');
    });
  });

  it('documents the foothold honestly in the declaration and its boundary line', async () => {
    await sessionFixture(async h => {
      await h.command('--target ./source');
      const description = h.pi.tools.get('p2o_session').description as string;
      for (const phrase of ['action=foothold-open', 'ONE persistent interactive shell', 'whoami; id', 'one peer connection is kept', 'no per-send or idle cap',
        'max 8 KiB', 'capture artifact', 'no host port', 'no tunnel or pivot', 'kills the relay and verifies removal']) {
        expect(description, phrase).toContain(phrase);
      }
      const actions = (h.pi.tools.get('p2o_session').parameters as any).properties.action.enum as string[];
      expect(actions).toEqual(expect.arrayContaining([...FOOTHOLD_ACTIONS]));
      const boundary = TOOL_BOUNDARIES.p2o_session.join(' ');
      for (const phrase of ['not evidence', 'one connection per session', 'lab-network only', 'no host port', 'no tunnel or pivot', 'identity probe']) {
        expect(boundary, phrase).toContain(phrase);
      }
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

  it('routes every foothold action through the ticket-bound session instead of refusing it as unknown', async () => {
    // S1/A3 (planning_update.md F-02): the broker allow-list omitted FOOTHOLD_ACTIONS, so the only role that holds
    // p2o_session could not reach five declared actions. The whitelist now forwards them to the same ticket-bound session.
    const f = await brokerFixture({ session: 'session-11111111' });
    const client = new BrokerClient(f.socket, 'c'.repeat(32), { requestMs: 2000 });
    try {
      for (const [action, extra] of [['foothold-open', { port: 4444 }], ['foothold-identify', {}], ['foothold-send', { text: 'id' }], ['foothold-read', {}], ['foothold-close', {}]] as const) {
        const result = await client.request('session', { action, ...extra });
        expect(result.ok, action).toBe(true);
        expect(f.calls, action).toContain(`session ${action} session-11111111 p2o-recon-aaaaaa`);
      }
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
