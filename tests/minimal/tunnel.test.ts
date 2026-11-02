import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { TUNNEL_ACTIONS, TUNNEL_SOCKS_SCRIPT, TUNNEL_TARGET_SCRIPT, Tunnel, TunnelError, targetTunnelCommand, tunnelStopCommand } from '../../src/tunnel.js';
import { validationMayUseSession } from '../../src/foothold.js';
import { TOOL_BOUNDARIES } from '../../src/tool-guidelines.js';
import { AssessmentStore } from '../../src/state/store.js';
import type { SandboxOptions } from '../../src/sandbox.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

/**
 * W-O/H7 (owner decision 2026-11-02, Option A): the managed reverse SOCKS5 pivot.
 *
 * Two layers are tested here. The relay scripts are host-authored Python, so the integration block runs the exact
 * exported bytes over loopback against a real destination (no Docker, no target): the SOCKS5 handshake, the dial-back
 * pairing, a refused destination and two concurrent clients all have to work for the feature to mean anything. The
 * state machine and the session action are tested over scripted transports, because a foothold inside a real container
 * cannot be reached from a hermetic suite — the gate, the lifecycle, the failure cleanup and the ledger rows are what a
 * unit test can honestly pin.
 */

const target = { kind: 'directory' as const, path: '/inert' };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await wait(50);
  }
}

/** A port the kernel just handed out: good enough for a loopback test, reclaimed by the test that binds it immediately. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

function reader(socket: Socket) {
  let buffer = Buffer.alloc(0);
  const pending: Array<{ size: number; resolve: (chunk: Buffer) => void; reject: (error: Error) => void }> = [];
  const pump = () => {
    while (pending.length && buffer.length >= pending[0].size) {
      const { size, resolve } = pending.shift()!;
      resolve(buffer.subarray(0, size));
      buffer = buffer.subarray(size);
    }
  };
  socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); pump(); });
  socket.on('error', error => { for (const item of pending.splice(0)) item.reject(error); });
  return (size: number) => new Promise<Buffer>((resolve, reject) => { pending.push({ size, resolve, reject }); pump(); });
}

/** The relay pair over loopback: the exported scripts exactly as production writes them, plus a fixture destination. */
class RelayPair {
  socksPort = 0;
  relayPort = 0;
  echoPort = 0;
  private readonly children: ChildProcess[] = [];
  private sandboxOutput = '';
  private dir = '';
  private echo?: ReturnType<typeof createServer>;

  async start(): Promise<void> {
    this.dir = await mkdtemp(join(tmpdir(), 'p2o-relay-'));
    const socksScript = join(this.dir, 'socks.py'), targetScript = join(this.dir, 'target.py');
    await writeFile(socksScript, TUNNEL_SOCKS_SCRIPT);
    await writeFile(targetScript, TUNNEL_TARGET_SCRIPT);
    this.socksPort = await freePort();
    const portFile = join(this.dir, 'relay.port');
    const sandbox = spawn('python3', ['-I', '-S', socksScript, String(this.socksPort), '0', portFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.push(sandbox);
    sandbox.stdout?.on('data', chunk => { this.sandboxOutput += String(chunk); });
    await waitFor(async () => (await readFile(portFile, 'utf8').catch(() => '')).trim().length > 0, 15_000, 'the reverse listener port file');
    this.relayPort = Number((await readFile(portFile, 'utf8')).trim());
    const target = spawn('python3', ['-I', '-S', targetScript, '127.0.0.1', String(this.relayPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.push(target);
    await waitFor(() => this.sandboxOutput.includes('target relay connected'), 15_000, 'the obtained host to dial back');
    const echo = createServer(socket => socket.on('data', data => socket.write(data)));
    this.echo = echo;
    await new Promise<void>(resolve => echo.listen(0, '127.0.0.1', resolve));
    this.echoPort = (echo.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const child of this.children.splice(0)) child.kill('SIGKILL');
    if (this.echo) await new Promise<void>(resolve => this.echo!.close(() => resolve()));
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }

  /** Open one SOCKS5 CONNECT through the pivot and return the reply code. */
  async connect(host: string, port: number): Promise<{ socket: Socket; read: (size: number) => Promise<Buffer>; code: number }> {
    const socket = createConnection({ host: '127.0.0.1', port: this.socksPort });
    const read = reader(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject); });
    socket.write(Buffer.from([5, 1, 0]));
    expect([...await read(2)]).toEqual([5, 0]);
    const ip = host.split('.').map(Number);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 1]), Buffer.from(ip), Buffer.from([port >> 8, port & 0xff])]));
    const reply = await read(10);
    return { socket, read, code: reply[1] };
  }
}

describe('W-O reverse SOCKS5 relay (real scripts over loopback)', () => {
  it('carries a CONNECT and its bytes to a destination through the obtained-host relay', async () => {
    const relays = new RelayPair();
    try {
      await relays.start();
      const { socket, read, code } = await relays.connect('127.0.0.1', relays.echoPort);
      expect(code).toBe(0);
      socket.write('pivot works');
      expect((await read(11)).toString('utf8')).toBe('pivot works');
      // A second request on a fresh client uses another pooled reverse connection.
      const second = await relays.connect('127.0.0.1', relays.echoPort);
      second.socket.write('again');
      expect((await second.read(5)).toString('utf8')).toBe('again');
      socket.destroy(); second.socket.destroy();
    } finally { await relays.stop(); }
  });

  it('serves two concurrent clients and reports an unreachable destination as a failure, never as success', async () => {
    const relays = new RelayPair();
    try {
      await relays.start();
      const first = await relays.connect('127.0.0.1', relays.echoPort);
      const second = await relays.connect('127.0.0.1', relays.echoPort);
      expect([first.code, second.code]).toEqual([0, 0]);
      first.socket.write('one'); second.socket.write('two');
      expect([(await first.read(3)).toString('utf8'), (await second.read(3)).toString('utf8')]).toEqual(['one', 'two']);
      // A port with no listener behind the obtained host: the SOCKS5 reply is a non-zero REP, so a caller cannot read a
      // refused destination as a clean one.
      const closed = await freePort();
      const refused = await relays.connect('127.0.0.1', closed);
      expect(refused.code).not.toBe(0);
      first.socket.destroy(); second.socket.destroy(); refused.socket.destroy();
    } finally { await relays.stop(); }
  });

  it('refuses a SOCKS command other than CONNECT with the standard reply instead of guessing', async () => {
    const relays = new RelayPair();
    try {
      await relays.start();
      const socket = createConnection({ host: '127.0.0.1', port: relays.socksPort });
      const read = reader(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      socket.write(Buffer.from([5, 1, 0]));
      expect([...await read(2)]).toEqual([5, 0]);
      // BIND (command 2) is not a pivot shape this relay implements.
      socket.write(Buffer.concat([Buffer.from([5, 2, 0, 1]), Buffer.from([127, 0, 0, 1]), Buffer.from([0, 80])]));
      expect((await read(10))[1]).toBe(7);
      socket.destroy();
    } finally { await relays.stop(); }
  });
});

/** Scripted transport for the state machine: records commands, answers the probes the class actually issues. */
class ScriptedTransport {
  commands: string[] = [];
  sends: string[] = [];
  constructor(private readonly answer: (command: string) => { code: number; stdout: string; stderr: string }) {}
  async exec(command: string) { this.commands.push(command); return this.answer(command); }
  async send(text: string) { this.sends.push(text); return { bytes: Buffer.byteLength(text) }; }
}

const tunnelAnswer = (override: { relayReady?: boolean; dial?: 'connected' | 'no-python' | 'timeout'; removeFails?: boolean; pid?: string } = {}) => (command: string) => {
  if (command.startsWith('mkdir -p tunnels')) return { code: 0, stdout: '', stderr: '' };
  if (command.includes('relay=$(cat')) return override.relayReady === false ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '54321\n', stderr: '' };
  if (command.includes('socket.create_connection(("127.0.0.1"')) return { code: 0, stdout: '', stderr: '' };
  if (command.includes("grep -q 'target relay connected'")) {
    const dial = override.dial ?? 'connected';
    if (dial === 'connected') return { code: 0, stdout: 'connected', stderr: '' };
    if (dial === 'no-python') return { code: 2, stdout: 'no-python', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  }
  if (command.startsWith('tail -c 8192 tunnels/') || command.startsWith('tail -c 2048 foothold/')) return { code: 0, stdout: 'relay started\n', stderr: '' };
  if (command.includes("grep -q 'P2O_TUNNEL_") && command.includes('_STOPPED')) return { code: 0, stdout: '', stderr: '' };
  if (command.startsWith('cat tunnels/') && command.endsWith('.pid 2>/dev/null')) return { code: 0, stdout: `${override.pid ?? '4343'}\n`, stderr: '' };
  if (command.includes('kill -0')) return { code: 0, stdout: '', stderr: '' };
  if (command.startsWith('rm -f tunnels/') && command.includes('test ! -e')) return { code: override.removeFails ? 1 : 0, stdout: '', stderr: '' };
  if (command.includes('kill 4343') || command.includes('kill "$(cat') || command.includes('kill ')) return { code: 0, stdout: '', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

describe('W-O tunnel state machine (scripted transport)', () => {
  it('opens one pivot: loopback SOCKS5 port, kernel-chosen relay port, recorded dial-back address', async () => {
    const transport = new ScriptedTransport(tunnelAnswer());
    const tunnel = new Tunnel(transport, { container: 'p2o-session-aaaaaaaa', footholdLog: 'foothold/foothold-4444.log', token: 'deadbeef01', readyMs: 1_000, dialMs: 1_000, closeMs: 1_000, sleep: async () => undefined });
    const opened = await tunnel.open(1080);
    expect(opened).toMatchObject({ port: 1080, relayPort: 54321, socks: '127.0.0.1:1080', address: 'p2o-session-aaaaaaaa:54321', log: 'tunnels/tunnel-1080.log', targetScript: '/tmp/p2o-tunnel-deadbeef01.py' });
    expect(opened.openedAt).toMatch(/T/);
    // The push is a fixed relay plus validated argv, and it names where the obtained host must dial back.
    expect(transport.sends).toHaveLength(1);
    expect(transport.sends[0]).toContain('P2O_TUNNEL_deadbeef01_NO_PY');
    expect(transport.sends[0]).toContain('p2o-session-aaaaaaaa 54321');
    expect(transport.commands.some(command => command.includes("<<'P2O_TUNNEL'"))).toBe(true);
    expect(tunnel.state()).toMatchObject({ port: 1080, relayPort: 54321 });
    await expect(tunnel.open(1081)).rejects.toThrow('TUNNEL_EXISTS');
  });

  it('refuses a second open and an invalid port, and claims nothing when the session relay never listens', async () => {
    const transport = new ScriptedTransport(tunnelAnswer({ relayReady: false }));
    const tunnel = new Tunnel(transport, { container: 'c', footholdLog: 'foothold/foothold-4444.log', token: 'deadbeef02', readyMs: 1_000, dialMs: 1_000, sleep: async () => undefined });
    await expect(tunnel.open(0)).rejects.toThrow('TUNNEL_INVALID_PORT');
    await expect(tunnel.open(1080)).rejects.toThrow('TUNNEL_UNHEALTHY');
    expect(tunnel.state()).toBeUndefined();
    // The failed start was cleaned up, not left behind: the host removed the pid/relay/script it wrote.
    expect(transport.commands.some(command => command.includes('rm -f tunnels/tunnel-1080.pid'))).toBe(true);
    await expect(tunnel.close()).rejects.toThrow('TUNNEL_NOT_OPEN');
  });

  it('reports the obtained host that cannot start the relay, and cleans the session side up', async () => {
    const transport = new ScriptedTransport(tunnelAnswer({ dial: 'no-python' }));
    const tunnel = new Tunnel(transport, { container: 'c', footholdLog: 'foothold/foothold-4444.log', token: 'deadbeef03', readyMs: 1_000, dialMs: 1_000, sleep: async () => undefined });
    await expect(tunnel.open(1080)).rejects.toThrow(/TUNNEL_TARGET_START_REFUSED:.*python3/);
    expect(tunnel.state()).toBeUndefined();
    // The fixed relay copy was pushed before the host reported it could not run it; the session side is cleaned up and no
    // pivot is recorded, so nothing is claimed live.
    expect(transport.sends).toHaveLength(1);
    expect(transport.commands.some(command => command.includes('rm -f tunnels/tunnel-1080.pid'))).toBe(true);
  });

  it('closes both relays, verifies the session side and reads the obtained host stop marker from the shell transcript', async () => {
    const transport = new ScriptedTransport(tunnelAnswer());
    const tunnel = new Tunnel(transport, { container: 'c', footholdLog: 'foothold/foothold-4444.log', token: 'deadbeef04', readyMs: 1_000, dialMs: 1_000, closeMs: 1_000, sleep: async () => undefined });
    await tunnel.open(1080);
    const closed = await tunnel.close();
    expect(closed).toMatchObject({ port: 1080, socks: '127.0.0.1:1080', verified: true, targetStopped: true });
    expect(transport.sends.some(text => text.includes('P2O_TUNNEL_deadbeef04_STOPPED'))).toBe(true);
    expect(transport.commands.some(command => command.includes('kill 4343'))).toBe(true);
    expect(transport.commands.some(command => command.includes('test ! -e tunnels/tunnel-1080.pid'))).toBe(true);
    expect(tunnel.state()?.targetStopped).toBe(true);
    await expect(tunnel.close()).rejects.toThrow('TUNNEL_NOT_OPEN');
  });

  it('refuses to claim a close it could not verify, and keeps the pivot registered for a retry', async () => {
    const transport = new ScriptedTransport(tunnelAnswer({ removeFails: true }));
    const tunnel = new Tunnel(transport, { container: 'c', footholdLog: 'foothold/foothold-4444.log', token: 'deadbeef05', readyMs: 1_000, dialMs: 1_000, closeMs: 1_000, sleep: async () => undefined });
    await tunnel.open(1080);
    await expect(tunnel.close()).rejects.toThrow('TUNNEL_CLOSE_UNVERIFIED');
    expect(tunnel.isOpen).toBe(true);
  });

  it('builds a start line and a stop line from validated arguments only and bounds the pushed relay', async () => {
    const pushed = targetTunnelCommand({ token: 'deadbeef06', relayHost: 'p2o-session-aaaaaaaa', relayPort: 54321 });
    expect(pushed.bytes).toBeLessThan(16 * 1024);
    expect(pushed.command).toContain('P2O_TUNNEL_deadbeef06_NO_PY');
    expect(pushed.command).toContain("pathlib.Path('/tmp/p2o-tunnel-deadbeef06.py')");
    expect(pushed.command).toContain('nohup python3 /tmp/p2o-tunnel-deadbeef06.py p2o-session-aaaaaaaa 54321');
    expect(tunnelStopCommand('deadbeef06')).toContain('P2O_TUNNEL_deadbeef06_STOPPED');
    expect(tunnelStopCommand('deadbeef06')).toContain('rm -f /tmp/p2o-tunnel-deadbeef06.pid');
  });
});

/** The extension's session sandbox, with the foothold state machine and the tunnel relays simulated from committed commands. */
class TunnelSandbox extends InertSandbox {
  readonly sessionId?: string;
  readonly provisionPaths: string[] = [];
  footholdLog = '';
  peerConnected = false;
  readonly footholdSends: string[] = [];
  tunnelLog = '';
  relayPort = 54321;
  noPython = false;
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
    if (this.session && command.includes('"capturedBytes"')) {
      this.commands.push({ command, workdir, timeout: seconds });
      const args = / (\d+) (\d+)$/.exec(command)!;
      const bytes = Buffer.from(this.footholdLog, 'utf8');
      const start = Math.min(Number(args[1]), bytes.length);
      const data = bytes.subarray(start, start + Number(args[2]));
      return { code: 0, stdout: `${JSON.stringify({ totalBytes: bytes.length, offset: start, capturedBytes: data.length })}\n${data.toString('utf8')}`, stderr: '', truncated: false };
    }
    if (this.session && command.includes('b64decode')) {
      this.commands.push({ command, workdir, timeout: seconds });
      this.footholdSends.push(command);
      const encoded = /'([A-Za-z0-9+/=]{20,})'/.exec(command)?.[1];
      const text = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
      if (this.noPython) this.footholdLog += `${/P2O_TUNNEL_([a-z0-9]+)_NO_PY/.exec(text)?.[0] ?? 'P2O_TUNNEL_none_NO_PY'}\n`;
      else this.tunnelLog += '[p2o] target relay connected\n';
      return { code: 0, stdout: '', stderr: '', truncated: false };
    }
    if (this.session && command.includes("<<'P2O_TUNNEL'")) {
      this.commands.push({ command, workdir, timeout: seconds });
      const port = /tunnels\/tunnel-(\d+)\.py/.exec(command)?.[1];
      this.tunnelLog = `[p2o] relay listening on 0.0.0.0:54321\n[p2o] socks5 listening on 127.0.0.1:${port}\n`;
      return { code: 0, stdout: '', stderr: '', truncated: false };
    }
    if (this.session && command.includes('relay=$(cat')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: `${this.relayPort}\n`, stderr: '', truncated: false };
    }
    if (this.session && command.includes('socket.create_connection(("127.0.0.1"')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: '', stderr: '', truncated: false };
    }
    if (this.session && command.includes("grep -q 'target relay connected'")) {
      this.commands.push({ command, workdir, timeout: seconds });
      return this.tunnelLog.includes('target relay connected') ? { code: 0, stdout: 'connected', stderr: '', truncated: false } : { code: 1, stdout: '', stderr: '', truncated: false };
    }
    if (this.session && command.includes("grep -q 'P2O_TUNNEL_") && command.includes('_STOPPED')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: '', stderr: '', truncated: false };
    }
    if (this.session && command.startsWith('tail -c 8192 tunnels/')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: this.tunnelLog, stderr: '', truncated: false };
    }
    if (this.session && command.startsWith('tail -c 2048 foothold/')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: this.footholdLog, stderr: '', truncated: false };
    }
    if (this.session && command.startsWith('cat tunnels/') && command.endsWith('.pid 2>/dev/null')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: '4343\n', stderr: '', truncated: false };
    }
    if (this.session && command.startsWith('rm -f tunnels/') && command.includes('test ! -e')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: '', stderr: '', truncated: false };
    }
    if (this.session && command.includes('kill -0')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: '', stderr: '', truncated: false };
    }
    if (this.session && command.startsWith('cat foothold/') && command.endsWith('.pid 2>/dev/null')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: '4242\n', stderr: '', truncated: false };
    }
    if (this.session && command.includes('rm -f foothold/') && command.includes('test ! -e')) {
      this.commands.push({ command, workdir, timeout: seconds });
      return { code: 0, stdout: '', stderr: '', truncated: false };
    }
    const result = await super.exec(command, seconds, signal, workdir, onRunning, onOutput);
    return { ...result, ...(this.session ? { sessionRef: this.session } : {}) };
  }
}

async function tunnelFixture(work: (h: any) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-tunnel-ext-'));
  await mkdir(join(root, 'source'));
  const pi = createFakePi(), ctx = createContext({ cwd: root }), herdr = createSimpleHerdr(), sandboxes: TunnelSandbox[] = [];
  registerP2O(pi.pi, {
    extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'settings.json'), herdr: herdr.client,
    createSandbox: (_target: any, profile: SandboxOptions) => { const sandbox = new TunnelSandbox(profile); sandboxes.push(sandbox); return sandbox; },
  });
  const command = (text: string) => pi.commands.get('p2o').handler(text, ctx.ctx);
  const call = (name: string, params: any = {}) => pi.tools.get(name).execute(randomUUID(), params, undefined, undefined, ctx.ctx);
  const reader = async () => AssessmentStore.open(join(root, '.p2o-state'), (await readdir(join(root, '.p2o-state')))[0]);
  try { await work({ root, pi, ctx, sandboxes, command, call, reader }); }
  finally { await command('stop').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
}

/** One session with a connected, identified foothold, ready for the pivot. */
async function identifiedFoothold(h: any): Promise<{ session: string; sandbox: TunnelSandbox }> {
  await h.command('--target ./source --executors session --lab-network operator-lab');
  const session = (await h.call('p2o_session', { action: 'open', purpose: 'pivot' })).details.session as string;
  const sandbox = h.sandboxes[1] as TunnelSandbox;
  await h.call('p2o_session', { action: 'foothold-open', session, port: 4444 });
  sandbox.peerConnected = true;
  sandbox.footholdLog += 'root\nuid=0(root) gid=0(root) groups=0(root)\n';
  await h.call('p2o_session', { action: 'foothold-identify', session });
  return { session, sandbox };
}

describe('W-O tunnel session action (extension)', () => {
  it('refuses tunnel-open without --lab-network before any relay leaves the host', async () => {
    await tunnelFixture(async h => {
      await h.command('--target ./source --executors session');
      const session = (await h.call('p2o_session', { action: 'open' })).details.session as string;
      await expect(h.call('p2o_session', { action: 'tunnel-open', session, port: 1080 })).rejects.toThrow(/INGRESS_UNAVAILABLE:.*--lab-network/);
      expect(h.sandboxes[1].commands.some((entry: any) => entry.command.includes("<<'P2O_TUNNEL'"))).toBe(false);
    });
  });

  it('refuses a pivot without a foothold, and before the foothold identity is confirmed', async () => {
    await tunnelFixture(async h => {
      await h.command('--target ./source --executors session --lab-network operator-lab');
      const session = (await h.call('p2o_session', { action: 'open' })).details.session as string;
      await expect(h.call('p2o_session', { action: 'tunnel-open', session, port: 1080 })).rejects.toThrow(/TUNNEL_NEEDS_FOOTHOLD:.*foothold-open/);
      const sandbox = h.sandboxes[1] as TunnelSandbox;
      await h.call('p2o_session', { action: 'foothold-open', session, port: 4444 });
      sandbox.peerConnected = true;
      sandbox.footholdLog += 'root\nuid=0(root) gid=0(root) groups=0(root)\n';
      await expect(h.call('p2o_session', { action: 'tunnel-open', session, port: 1080 })).rejects.toThrow(/TUNNEL_NEEDS_FOOTHOLD:.*foothold-identify/);
      expect(h.sandboxes[1].commands.some((entry: any) => entry.command.includes("<<'P2O_TUNNEL'"))).toBe(false);
    });
  });

  it('opens, lists and closes one verified reverse SOCKS5 pivot, recording both lifecycle lines', async () => {
    await tunnelFixture(async h => {
      const { session, sandbox } = await identifiedFoothold(h);
      // A port the session already serves (a listener or the foothold's own peer port) is a caller error, never a guess.
      await h.call('p2o_session', { action: 'listen', session, port: 1090 });
      await expect(h.call('p2o_session', { action: 'tunnel-open', session, port: 1090 })).rejects.toThrow('TUNNEL_PORT_CONFLICT');
      await expect(h.call('p2o_session', { action: 'tunnel-open', session, port: 4444 })).rejects.toThrow('TUNNEL_PORT_CONFLICT');
      const opened = await h.call('p2o_session', { action: 'tunnel-open', session, port: 1081 });
      expect(opened.details).toMatchObject({ session, port: 1081, relayPort: 54321, socks: '127.0.0.1:1081', address: `p2o-${session}:54321`, labNetwork: 'operator-lab' });
      expect(opened.content[0].text).toContain('--socks5-hostname 127.0.0.1:1081');
      await expect(h.call('p2o_session', { action: 'tunnel-open', session, port: 1082 })).rejects.toThrow('TUNNEL_EXISTS');
      const listed = (await h.call('p2o_session', { action: 'tunnel-list', session })).details;
      expect(listed).toMatchObject({ session, open: true });
      expect(listed.tunnels[0]).toMatchObject({ port: 1081, relayPort: 54321, socks: '127.0.0.1:1081', address: `p2o-${session}:54321` });
      // The session list carries the pivot fact too, so one read shows the whole session surface.
      const sessions = (await h.call('p2o_session', { action: 'list' })).details.sessions as any[];
      expect(sessions.find(row => row.session === session).tunnels[0]).toMatchObject({ port: 1081, socks: '127.0.0.1:1081' });
      const closed = await h.call('p2o_session', { action: 'tunnel-close', session });
      expect(closed.details).toMatchObject({ session, port: 1081, closed: true, verified: true, targetStopped: true });
      expect(sandbox.commands.some((entry: any) => entry.command.includes('kill 4343'))).toBe(true);
      const after = (await h.call('p2o_session', { action: 'tunnel-list', session })).details;
      expect(after.open).toBe(false);
      expect(after.tunnels[0]).toMatchObject({ port: 1081, closedAt: expect.any(String), closeVerified: true, targetStopped: true });
      await expect(h.call('p2o_session', { action: 'tunnel-close', session })).rejects.toThrow('TUNNEL_NOT_OPEN');
      // Both lifecycle lines are session facts in the ledger, and the fixed relay really reached the obtained host.
      const store = await h.reader();
      try {
        const facts = store.records().flatMap((record: any) => record.data?.session ? [record.data.session] : []);
        expect(facts).toContainEqual(expect.objectContaining({ id: session, event: 'tunnel-open', port: 1081, relayPort: 54321, socks: '127.0.0.1:1081', labNetwork: 'operator-lab' }));
        expect(facts).toContainEqual(expect.objectContaining({ id: session, event: 'tunnel-close', port: 1081, verified: true, targetStopped: true }));
      } finally { store.close(); }
      expect(sandbox.footholdSends.length).toBeGreaterThanOrEqual(3); // whoami probe, relay copy, stop line
      // The report states the pivot from committed facts on both the session line and the ingress line.
      await h.command(`report export ${join(h.root, 'out')}`);
      const report = (await readFile(join(h.root, 'out', 'REPORT.md'), 'utf8')).replace(/\\([()])/g, '$1');
      expect(report).toContain('1 reverse SOCKS5 pivot(s) opened through an identified foothold');
      expect(report).toContain('reverse SOCKS5 pivot inside that session');
    });
  });

  it('keeps a session close as the implicit removal path and refuses the pivot afterwards', async () => {
    await tunnelFixture(async h => {
      const { session } = await identifiedFoothold(h);
      await h.call('p2o_session', { action: 'tunnel-open', session, port: 1080 });
      // Closing the session kills both relays with the server container; no separate close line is invented.
      await h.call('p2o_session', { action: 'close', session });
      await expect(h.call('p2o_session', { action: 'tunnel-close', session })).rejects.toThrow('SESSION_UNKNOWN');
    });
  });

  it('stops the validation worker at action=open and documents the pivot in the declaration and boundary line', async () => {
    await tunnelFixture(async h => {
      await h.command('--target ./source');
      expect(validationMayUseSession('open')).toBe(true);
      for (const action of TUNNEL_ACTIONS) expect(validationMayUseSession(action), action).toBe(false);
      const description = h.pi.tools.get('p2o_session').description as string;
      const actions = (h.pi.tools.get('p2o_session').parameters as any).properties.action.enum as string[];
      expect(actions).toEqual(expect.arrayContaining([...TUNNEL_ACTIONS]));
      for (const phrase of ['action=tunnel-open', 'reverse SOCKS5 pivot', '127.0.0.1:<port>', '--socks5-hostname', 'python3', 'One pivot per session', 'No host port is published']) {
        expect(description, phrase).toContain(phrase);
      }
      const boundary = TOOL_BOUNDARIES.p2o_session.join(' ');
      for (const phrase of ['not evidence', 'one connection per session', 'lab-network only', 'no host port', 'reverse SOCKS5 pivot', 'tunnel-open', 'stays a gap']) {
        expect(boundary, phrase).toContain(phrase);
      }
    });
  });

});
