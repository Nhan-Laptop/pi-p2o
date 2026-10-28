/**
 * planning_update.md P17.7/A17.8 (D40, owner decision A5): the interactive foothold.
 *
 * `p2o_session action=listen` is a callback recorder: it logs bytes and never answers. The foothold is the other
 * transport — ONE persistent peer connection per session, driven by the model, kept across steps and worker reports.
 * This module is the pure state machine over an injectable transport, so every rule is testable without Docker:
 *
 *  - the in-container relay is host-authored fixed bytes: bind 0.0.0.0, accept exactly ONE connection, then relay
 *    socket→log and fifo→socket. It never starts a shell and never answers on its own; only host-written bytes reach
 *    the peer, and peer output is appended to the transcript log.
 *  - the identity gate: send/read refuse until `identify()` has sent the fixed `whoami; id` probe through the shell and
 *    recorded the observation. `identify` itself requires a connected peer, and concurrent calls share one probe.
 *  - interaction is uncapped: no per-send size or idle timeout is imposed here. The transport's own 32 KiB `/bin/sh -c`
 *    bound is the only bound, and the refusal says so rather than inventing a smaller cap.
 *  - the transcript is the log. `read()` returns a bounded preview (8 KiB) from a host cursor; the caller retains the
 *    full log through the run's existing capture path. No host port is published and no tunnel/pivot subsystem exists.
 */

export const FOOTHOLD_PREVIEW_BYTES = 8 * 1024;
/** The sandbox transport's own command bound (`Sandbox.exec`), not a foothold cap; the send refusal names it. */
export const FOOTHOLD_TRANSPORT_COMMAND_BYTES = 32 * 1024;
/** A recorded identity observation is a fact row, not a transcript: whoami/id output is tiny, so 2 KiB is generous. */
export const FOOTHOLD_IDENTITY_BYTES = 2 * 1024;
export const FOOTHOLD_ACTIONS = ['foothold-open', 'foothold-identify', 'foothold-send', 'foothold-read', 'foothold-close'] as const;
export type FootholdAction = typeof FOOTHOLD_ACTIONS[number];
export const isFootholdAction = (value: string): value is FootholdAction => (FOOTHOLD_ACTIONS as readonly string[]).includes(value);
/** A validation worker gets `open` only (A7.2); every foothold action is a non-open action and inherits that refusal. */
export const validationMayUseSession = (action: string): boolean => action === 'open';

/** One command seam. Production wires this to the session container; the state-machine tests script it. */
export interface FootholdTransport { exec(command: string, seconds?: number): Promise<{ code: number; stdout: string; stderr: string }> }
export interface FootholdState {
  port: number; address: string; log: string; upFifo: string; pidFile: string;
  connected: boolean; offset: number;
  identified?: FootholdIdentity;
}
export interface FootholdRead { preview: string; nextOffset: number; totalBytes: number; truncated: boolean }
/** D40/A5: the recorded identity a task or brief can cite. `observation` is the raw `whoami; id` text; the parsed fields are
 * best-effort citations of those same bytes (never a second probe), and a field that did not parse stays absent. */
export interface FootholdIdentity { at: string; observation: string; method: 'listener'; user?: string; uid?: number; gid?: number }
export interface FootholdClose { port: number; address: string; verified: boolean; log: string }
export interface FootholdOptions {
  /** The container name a lab-network peer resolves; the address to hand the target is `<container>:<port>`. */
  container?: string;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  /** "Reads until quiet" for the identity probe; injectable so tests do not wait. */
  quietMs?: number; deadlineMs?: number;
}

export function footholdPaths(port: number) {
  const base = `foothold/foothold-${port}`;
  return { script: `${base}.py`, log: `${base}.log`, upFifo: `${base}.up.fifo`, pidFile: `${base}.pid`, peerFile: `${base}.peer`, osLog: `${base}.os.log`, base };
}

/**
 * The relay. Fixed bytes, validated integer argv only. The listening socket is closed after the single accept, so a
 * second peer can never connect; the peer marker file is the connection fact the host refreshes. The up thread keeps
 * the FIFO open O_RDWR so a host send never races a reopen, and every byte it forwards was written by the host.
 */
export const FOOTHOLD_RELAY_SCRIPT = [
  'import os, socket, sys, threading',
  'port = int(sys.argv[1])',
  'fifo, log, peerfile = sys.argv[2], sys.argv[3], sys.argv[4]',
  'def append(data):',
  '    with open(log, "ab", buffering=0) as target:',
  '        target.write(data)',
  'try:',
  '    os.mkfifo(fifo)',
  'except FileExistsError:',
  '    pass',
  'server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
  'server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
  'server.bind(("0.0.0.0", port))',
  'server.listen(1)',
  'append(("[p2o] listening on 0.0.0.0:%d%s" % (port, chr(10))).encode())',
  'connection, peer = server.accept()',
  'server.close()',
  'upfd = os.open(fifo, os.O_RDWR)',
  'connection.settimeout(None)',
  'with open(peerfile, "w") as marker:',
  '    marker.write("%s:%d%s" % (peer[0], peer[1], chr(10)))',
  'append(("[p2o] connection from %s:%d%s" % (peer[0], peer[1], chr(10))).encode())',
  'def down():',
  '    try:',
  '        while True:',
  '            data = connection.recv(65536)',
  '            if not data:',
  '                break',
  '            append(data)',
  '    except OSError:',
  '        pass',
  '    try:',
  '        append(("[p2o] peer closed the connection%s" % chr(10)).encode())',
  '    except OSError:',
  '        pass',
  '    try:',
  '        os.unlink(peerfile)',
  '    except OSError:',
  '        pass',
  '    os._exit(0)',
  'def up():',
  '    while True:',
  '        try:',
  '            data = os.read(upfd, 65536)',
  '        except OSError:',
  '            break',
  '        if not data:',
  '            break',
  '        try:',
  '            connection.sendall(data)',
  '        except OSError:',
  '            break',
  '    os._exit(0)',
  'threading.Thread(target=down).start()',
  'threading.Thread(target=up).start()',
  'threading.Event().wait()',
].join('\n');

/** Base64 argv only, no shell quoting of peer bytes, and O_NONBLOCK so a dead relay refuses instead of hanging.
 * A slow peer is backpressure: the write loops until the bytes are queued, and a pipe that stays full for five seconds
 * is a fault (exit 4) rather than a silent partial line. */
export const FOOTHOLD_SEND_SCRIPT = [
  'import base64, os, sys, time',
  'data = base64.b64decode(sys.argv[2], validate=True)',
  'try:',
  '    fd = os.open(sys.argv[1], os.O_WRONLY | os.O_NONBLOCK | os.O_APPEND)',
  'except OSError:',
  '    raise SystemExit(3)',
  'try:',
  '    view = memoryview(data)',
  '    deadline = time.monotonic() + 5',
  '    while view:',
  '        try:',
  '            written = os.write(fd, view)',
  '        except BlockingIOError:',
  '            if time.monotonic() >= deadline:',
  '                raise SystemExit(4)',
  '            time.sleep(0.05)',
  '            continue',
  '        view = view[written:]',
  'finally:',
  '    os.close(fd)',
].join('\n');

/** One bounded page from the transcript log: an ASCII metadata frame, then the raw bytes. */
export const FOOTHOLD_READ_SCRIPT = [
  'import json, os, sys',
  'path, offset, cap = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])',
  'size = os.path.getsize(path) if os.path.isfile(path) else 0',
  'start = min(offset, size)',
  'data = b""',
  'try:',
  '    with open(path, "rb") as source:',
  '        source.seek(start)',
  '        data = source.read(cap)',
  'except OSError:',
  '    data = b""',
  'sys.stdout.write(json.dumps({"totalBytes": size, "offset": start, "capturedBytes": len(data)}, separators=(",", ":")) + chr(10))',
  'sys.stdout.flush()',
  'sys.stdout.buffer.write(data)',
  'sys.stdout.buffer.flush()',
].join('\n');

export class FootholdError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'FootholdError'; }
}

const tail = (text: string) => text.trim().split('\n').slice(-1)[0]?.slice(-400) ?? 'no output';
/** Every host-written relay line starts with this; the identity gate strips them so only peer bytes are recorded. */
export const FOOTHOLD_MARKER = '[p2o] ';

/** `whoami` prints one plain name and `id` prints uid=/gid=; anything else stays in the raw observation instead of a guess. */
export function shellIdentity(observation: string): { user?: string; uid?: number; gid?: number } {
  const user = /^([A-Za-z0-9._][A-Za-z0-9._-]{0,31})\s*$/m.exec(observation)?.[1];
  const uid = /uid=(\d{1,10})\b/.exec(observation)?.[1];
  const gid = /gid=(\d{1,10})\b/.exec(observation)?.[1];
  return { ...(user ? { user } : {}), ...(uid !== undefined ? { uid: Number(uid) } : {}), ...(gid !== undefined ? { gid: Number(gid) } : {}) };
}

/** Kill the relay pid and verify process death by `kill -0`; the pid is a validated decimal from the container file. */
const killCommand = (pid: string) => [
  `kill ${pid} 2>/dev/null; i=0`,
  `while [ $i -lt 20 ]; do kill -0 ${pid} 2>/dev/null || break; i=$((i+1)); sleep 0.1; done`,
  `if kill -0 ${pid} 2>/dev/null; then kill -9 ${pid} 2>/dev/null; sleep 0.2; fi`,
  `if kill -0 ${pid} 2>/dev/null; then exit 1; fi`,
  'exit 0',
].join('\n');

export class Foothold {
  private current?: FootholdState;
  private paths?: ReturnType<typeof footholdPaths>;
  private closed = true;
  private identifying?: Promise<FootholdIdentity>;
  private readonly container?: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly quietMs: number;
  private readonly deadlineMs: number;
  constructor(private readonly transport: FootholdTransport, options: FootholdOptions = {}) {
    this.container = options.container;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.quietMs = options.quietMs ?? 400;
    this.deadlineMs = options.deadlineMs ?? 5000;
  }
  get isOpen(): boolean { return this.current !== undefined && !this.closed; }
  /** A copy: a caller cannot mutate the cursor or the identity gate through the state reader. */
  state(): FootholdState | undefined {
    if (!this.current) return undefined;
    return { ...this.current, ...(this.current.identified ? { identified: { ...this.current.identified } } : {}) };
  }

  async open(port: number): Promise<FootholdState> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new FootholdError('FOOTHOLD_INVALID_PORT', 'a foothold port is an integer 1..65535');
    if (this.current && !this.closed) throw new FootholdError('FOOTHOLD_EXISTS', `a foothold is already open on tcp ${this.current.port}; one connection per session, so close it before opening another`);
    const paths = footholdPaths(port);
    const start = [
      'mkdir -p foothold',
      `rm -f ${paths.log} ${paths.osLog} ${paths.pidFile} ${paths.upFifo} ${paths.peerFile} ${paths.script}`,
      `cat > ${paths.script} <<'P2O_FOOTHOLD'`,
      FOOTHOLD_RELAY_SCRIPT,
      'P2O_FOOTHOLD',
      `nohup sh -c 'echo $$ > ${paths.pidFile}; exec /usr/bin/python3 -I -S ${paths.script} ${port} ${paths.upFifo} ${paths.log} ${paths.peerFile}' > ${paths.osLog} 2>&1 &`,
      'sleep 0.2',
    ].join('\n');
    const started = await this.transport.exec(start, 30);
    if (started.code !== 0) throw new FootholdError('FOOTHOLD_UNHEALTHY', `could not start the relay (exit ${started.code}): ${tail(started.stderr || started.stdout)}`);
    // A loopback connect would consume the ONE accepted connection, so liveness is the listening marker plus the pid.
    const health = await this.transport.exec([
      'i=0',
      'while [ $i -lt 20 ]; do',
      `  if kill -0 "$(cat ${paths.pidFile} 2>/dev/null)" 2>/dev/null && grep -q 'listening on 0.0.0.0:${port}' ${paths.log} 2>/dev/null; then exit 0; fi`,
      '  i=$((i+1)); sleep 0.3',
      'done',
      'exit 1',
    ].join('\n'), 20);
    if (health.code !== 0) {
      const log = await this.transport.exec(`tail -c 8192 ${paths.osLog} 2>/dev/null`, 10).catch(() => undefined);
      await this.transport.exec(`kill "$(cat ${paths.pidFile} 2>/dev/null)" 2>/dev/null; rm -f ${paths.pidFile} ${paths.upFifo} ${paths.peerFile} ${paths.script}`, 10).catch(() => undefined);
      throw new FootholdError('FOOTHOLD_UNHEALTHY', `the relay did not report listening on 0.0.0.0:${port} and was stopped; no address is recorded${log?.stdout?.trim() ? ` (log: ${tail(log.stdout)})` : ''}`);
    }
    this.paths = paths;
    this.current = { port, address: this.container ? `${this.container}:${port}` : `0.0.0.0:${port}`, log: paths.log, upFifo: paths.upFifo, pidFile: paths.pidFile, connected: false, offset: 0 };
    this.closed = false;
    // Start the model cursor at the end: the startup marker is host output, not peer transcript.
    const page = await this.page(0, 1);
    this.current.offset = page.totalBytes;
    return this.state()!;
  }

  /** Fixed `whoami; id` probe through the shell, read until quiet, recorded. Concurrent callers share one probe. */
  async identify(): Promise<FootholdIdentity> {
    const current = this.requireOpen();
    if (current.identified) return { ...current.identified };
    if (this.identifying) return this.identifying;
    const task = (async (): Promise<FootholdIdentity> => {
      if (!await this.refresh()) throw new FootholdError('FOOTHOLD_NOT_CONNECTED', this.notConnected(current));
      await this.write('whoami; id');
      let cursor = current.offset, observation = '', lastOutput = this.now();
      const deadline = lastOutput + this.deadlineMs;
      for (;;) {
        const page = await this.page(cursor, FOOTHOLD_PREVIEW_BYTES);
        if (page.capturedBytes > 0) {
          observation = (observation + page.preview).slice(0, FOOTHOLD_IDENTITY_BYTES);
          cursor = page.offset + page.capturedBytes;
          lastOutput = this.now();
        }
        if (this.now() - lastOutput >= this.quietMs || this.now() >= deadline) break;
        await this.sleep(100);
      }
      // Host relay markers are not peer identity: strip them, so a peer that connected and died before the probe
      // cannot be recorded as confirmed. A shell that printed nothing is an honest NO_OUTPUT, not a recorded identity.
      const text = observation.split('\n').filter(line => !line.startsWith(FOOTHOLD_MARKER)).join('\n').trim();
      if (!text) throw new FootholdError('FOOTHOLD_NO_OUTPUT', 'the identity probe (whoami; id) produced no peer output through the shell; the connection may be one-way or the peer is not a shell. Nothing was recorded as confirmed.');
      current.identified = { at: new Date(this.now()).toISOString(), observation: text.slice(0, FOOTHOLD_IDENTITY_BYTES), method: 'listener', ...shellIdentity(text) };
      return { ...current.identified };
    })();
    this.identifying = task;
    try { return await task; } finally { this.identifying = undefined; }
  }

  /** Peer → shell; a trailing newline is added when missing so one send runs one line. No foothold size/idle cap. */
  async send(text: string): Promise<{ bytes: number }> {
    await this.requireInteraction();
    return this.write(text);
  }

  /** The next bounded page after the host cursor. The full log is retained by the caller's capture path. */
  async read(maxBytes = FOOTHOLD_PREVIEW_BYTES): Promise<FootholdRead> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > FOOTHOLD_PREVIEW_BYTES) throw new FootholdError('FOOTHOLD_BOUND', `a transcript preview is 1..${FOOTHOLD_PREVIEW_BYTES} bytes; the full log is retained as an artifact instead of a larger inline preview`);
    const current = await this.requireInteraction();
    const page = await this.page(current.offset, maxBytes);
    current.offset = page.offset + page.capturedBytes;
    return { preview: page.preview, nextOffset: current.offset, totalBytes: page.totalBytes, truncated: current.offset < page.totalBytes };
  }

  /** Kill the relay and verify both process death and control-file removal. The log stays for its capture path. */
  async close(): Promise<FootholdClose> {
    const current = this.requireOpen();
    const paths = this.paths!;
    const pid = await this.transport.exec(`cat ${current.pidFile} 2>/dev/null`, 10);
    const parsed = pid.code === 0 ? pid.stdout.trim() : '';
    if (!/^[0-9]{1,10}$/.test(parsed)) throw new FootholdError('FOOTHOLD_CLOSE_UNVERIFIED', 'the relay pid file is missing or unreadable, so process death cannot be verified; closing the session container is the only removal guarantee');
    const killed = await this.transport.exec(killCommand(parsed), 15);
    if (killed.code !== 0) throw new FootholdError('FOOTHOLD_CLOSE_UNVERIFIED', `the relay did not stop (exit ${killed.code}): ${tail(killed.stderr || killed.stdout)}. Nothing is claimed closed.`);
    const removed = await this.transport.exec(`rm -f ${current.pidFile} ${current.upFifo} ${paths.peerFile}; test ! -e ${current.pidFile} && test ! -e ${current.upFifo} && test ! -e ${paths.peerFile}`, 10);
    if (removed.code !== 0) throw new FootholdError('FOOTHOLD_CLOSE_UNVERIFIED', 'the relay stopped but its pid/fifo/peer files are still present; removal is not verified');
    current.connected = false;
    this.closed = true;
    return { port: current.port, address: current.address, verified: true, log: current.log };
  }

  private requireOpen(): FootholdState {
    if (!this.current || this.closed) throw new FootholdError('FOOTHOLD_NOT_OPEN', 'this foothold is not open; start one with p2o_session action=foothold-open port=<port> (it needs --lab-network)');
    return this.current;
  }
  private async requireInteraction(): Promise<FootholdState> {
    const current = this.requireOpen();
    if (!await this.refresh()) throw new FootholdError('FOOTHOLD_NOT_CONNECTED', this.notConnected(current));
    if (!current.identified) throw new FootholdError('FOOTHOLD_NEEDS_IDENTITY', 'identity is not confirmed through the shell yet: run p2o_session action=foothold-identify (it sends whoami; id through the foothold and records the observation) before send or read');
    return current;
  }
  private notConnected(current: FootholdState): string {
    return `no peer is connected to ${current.address} yet: hand that address to the target and retry. ONE connection is accepted; if the peer dropped, close this foothold and open a new one`;
  }
  private async refresh(): Promise<boolean> {
    const current = this.requireOpen();
    const probe = await this.transport.exec(`test -f ${this.paths!.peerFile} && kill -0 "$(cat ${current.pidFile})" 2>/dev/null`, 10);
    current.connected = probe.code === 0;
    return current.connected;
  }
  private async write(text: string): Promise<{ bytes: number }> {
    const current = this.requireOpen();
    if (typeof text !== 'string' || !text || text.includes('\u0000')) throw new FootholdError('FOOTHOLD_SEND_INVALID', 'a foothold send needs 1..N bytes of text without NUL');
    const payload = text.endsWith('\n') ? text : `${text}\n`;
    const encoded = Buffer.from(payload, 'utf8').toString('base64');
    const command = `/usr/bin/python3 -I -S -c '${FOOTHOLD_SEND_SCRIPT}' '${current.upFifo}' '${encoded}'`;
    if (command.length > FOOTHOLD_TRANSPORT_COMMAND_BYTES) throw new FootholdError('FOOTHOLD_SEND_TOO_LARGE', `this send needs a ${command.length}-byte command, above the sandbox transport's ${FOOTHOLD_TRANSPORT_COMMAND_BYTES}-byte /bin/sh -c bound; the foothold adds no smaller cap, so send a smaller chunk into the same shell`);
    const result = await this.transport.exec(command);
    if (result.code === 3) { current.connected = false; throw new FootholdError('FOOTHOLD_NOT_CONNECTED', 'the relay has no reader for host input: the peer connection is gone. Close and reopen the foothold; no second peer is accepted'); }
    if (result.code === 4) throw new FootholdError('FOOTHOLD_SEND_BLOCKED', 'the peer stopped reading: its input pipe stayed full for five seconds. Some bytes may have reached it, so do not assume this line arrived whole; read the transcript or close and reopen the foothold');
    if (result.code !== 0) throw new FootholdError('FOOTHOLD_SEND_FAILED', `the relay write returned ${result.code}: ${tail(result.stderr || result.stdout)}`);
    return { bytes: Buffer.byteLength(payload) };
  }
  /** One page of the transcript; `offset`/`maxBytes` are validated integers, so no model bytes reach the command. */
  private async page(offset: number, maxBytes: number): Promise<{ preview: string; totalBytes: number; capturedBytes: number; offset: number }> {
    const current = this.requireOpen();
    const result = await this.transport.exec(`/usr/bin/python3 -I -S -c '${FOOTHOLD_READ_SCRIPT}' '${current.log}' ${offset} ${maxBytes}`, 10);
    if (result.code !== 0) throw new FootholdError('FOOTHOLD_READ_FAILED', `the transcript reader returned ${result.code}: ${tail(result.stderr || result.stdout)}`);
    const newline = result.stdout.indexOf('\n');
    if (newline < 0) throw new FootholdError('FOOTHOLD_READ_FAILED', 'the transcript reader returned no metadata frame; nothing is claimed read');
    let meta: { totalBytes?: unknown; capturedBytes?: unknown; offset?: unknown };
    try { meta = JSON.parse(result.stdout.slice(0, newline)); } catch { throw new FootholdError('FOOTHOLD_READ_FAILED', 'the transcript metadata frame was not JSON; nothing is claimed read'); }
    const totalBytes = Number(meta.totalBytes), capturedBytes = Number(meta.capturedBytes), start = Number(meta.offset);
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(capturedBytes) || !Number.isSafeInteger(start) || totalBytes < 0 || capturedBytes < 0 || start < 0 || start + capturedBytes > totalBytes || capturedBytes > maxBytes) {
      throw new FootholdError('FOOTHOLD_READ_FAILED', 'the transcript metadata frame is inconsistent with the request; nothing is claimed read');
    }
    return { preview: result.stdout.slice(newline + 1), totalBytes, capturedBytes, offset: start };
  }
}
