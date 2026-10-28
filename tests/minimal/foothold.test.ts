import { describe, expect, it } from 'vitest';
import {
  Foothold, FOOTHOLD_ACTIONS, FOOTHOLD_PREVIEW_BYTES, FOOTHOLD_RELAY_SCRIPT, FOOTHOLD_TRANSPORT_COMMAND_BYTES,
  isFootholdAction, shellIdentity, validationMayUseSession, type FootholdTransport,
} from '../../src/foothold.js';

/**
 * P17.7/A17.8 (D40, owner decision A5): the interactive foothold state machine, inert.
 *
 * The transport is scripted, so this suite pins the rules the container cannot be asked about hermetically: the relay
 * accepts exactly ONE connection and relays both directions; the identity gate (`whoami; id` through the shell, recorded)
 * is required before any interactive send/read; the model preview is bounded and the cursor advances by bytes; close kills
 * and verifies removal. No Docker, no target, no connection.
 */
class ScriptedTransport implements FootholdTransport {
  commands: Array<{ command: string; seconds: number | undefined }> = [];
  log = '';
  peer = false;
  pid = '4242';
  health = 0;
  sendCode = 0;
  closeKill = 0;
  closeVerify = 0;
  async exec(command: string, seconds?: number) {
    this.commands.push({ command, seconds });
    const reply = (code: number, stdout = '', stderr = '') => ({ code, stdout, stderr });
    if (command.includes("<<'P2O_FOOTHOLD'")) return reply(0);
    if (command.includes('while [ $i -lt 20 ]')) return reply(this.health);
    if (command.startsWith('test -f ')) return reply(this.peer ? 0 : 1);
    if (command.includes('b64decode')) return reply(this.sendCode);
    if (command.includes('"capturedBytes"')) {
      const args = / (\d+) (\d+)$/.exec(command);
      if (!args) return reply(2, '', 'missing read args');
      const bytes = Buffer.from(this.log, 'utf8');
      const start = Math.min(Number(args[1]), bytes.length);
      const data = bytes.subarray(start, start + Number(args[2]));
      return reply(0, `${JSON.stringify({ totalBytes: bytes.length, offset: start, capturedBytes: data.length })}\n${data.toString('utf8')}`);
    }
    if (command.startsWith('cat foothold/') && command.endsWith('.pid 2>/dev/null')) return reply(0, `${this.pid}\n`);
    if (command.includes('kill -0')) return reply(this.closeKill);
    if (command.includes('rm -f') && command.includes('test ! -e')) return reply(this.closeVerify);
    return reply(0);
  }
  get writes(): string[] { return this.commands.filter(entry => entry.command.includes('b64decode')).map(entry => entry.command); }
}

const MARKER = '[p2o] listening on 0.0.0.0:4444\n';
const IDENTITY = 'root\nuid=0(root) gid=0(root) groups=0(root)\n';

async function opened(transport = new ScriptedTransport(), port = 4444) {
  transport.log = port === 4444 ? MARKER : `[p2o] listening on 0.0.0.0:${port}\n`;
  const foothold = new Foothold(transport, { container: 'p2o-session-fixture', quietMs: 20, deadlineMs: 500 });
  await foothold.open(port);
  return { transport, foothold };
}
const payload = (command: string) => {
  const match = /'([A-Za-z0-9+/=]+)'$/.exec(command);
  if (!match) throw new Error(`no base64 argv in ${command}`);
  return Buffer.from(match[1], 'base64').toString('utf8');
};

describe('A17.8 interactive foothold state machine', () => {
  it('starts one host-authored relay that binds 0.0.0.0, accepts exactly one peer and relays both directions', async () => {
    const { transport, foothold } = await opened();
    const start = transport.commands.find(entry => entry.command.includes("<<'P2O_FOOTHOLD'"))!.command;
    expect(start).toContain("cat > foothold/foothold-4444.py <<'P2O_FOOTHOLD'");
    expect(start).toContain('exec /usr/bin/python3 -I -S foothold/foothold-4444.py 4444 foothold/foothold-4444.up.fifo foothold/foothold-4444.log foothold/foothold-4444.peer');
    expect(start).toContain('nohup sh -c');
    // One connection: one listen(1), one accept, no re-accept loop. Two relay threads, socket→log and fifo→socket.
    expect(FOOTHOLD_RELAY_SCRIPT).toContain('server.listen(1)');
    expect(FOOTHOLD_RELAY_SCRIPT.match(/\.accept\(\)/g)).toHaveLength(1);
    expect(FOOTHOLD_RELAY_SCRIPT.match(/server\.close\(\)/g)).toHaveLength(1);
    expect(FOOTHOLD_RELAY_SCRIPT).toContain('threading.Thread(target=down).start()');
    expect(FOOTHOLD_RELAY_SCRIPT).toContain('threading.Thread(target=up).start()');
    expect(FOOTHOLD_RELAY_SCRIPT).toContain('with open(log, "ab", buffering=0)');
    expect(FOOTHOLD_RELAY_SCRIPT).toContain('connection.sendall(data)');
    expect(FOOTHOLD_RELAY_SCRIPT).toContain('server.bind(("0.0.0.0", port))');
    // The relay never starts a shell and never answers on its own: only host-authored bytes reach the peer.
    expect(FOOTHOLD_RELAY_SCRIPT).not.toMatch(/subprocess|os\.system|popen|\/bin\/sh|\/bin\/bash/);
    expect(foothold.state()).toMatchObject({ port: 4444, address: 'p2o-session-fixture:4444', log: 'foothold/foothold-4444.log', connected: false, offset: Buffer.byteLength(MARKER) });
    await expect(foothold.open(4444)).rejects.toThrow('FOOTHOLD_EXISTS');
    await expect(foothold.open(0)).rejects.toThrow('FOOTHOLD_INVALID_PORT');
  });

  it('binds only the lab-network path: no published host port and no tunnel or pivot command anywhere', async () => {
    const { transport, foothold } = await opened();
    transport.peer = true;
    transport.log += IDENTITY;
    await foothold.identify();
    await foothold.send('id');
    await foothold.close();
    for (const { command } of transport.commands) {
      expect(command).not.toMatch(/--publish|--network[ =]host|docker (?:run|create)|socat|\bssh\b|tunnel|pivot/i);
    }
  });

  it('refuses identify without a peer, then send/read before the identity gate names whoami and id', async () => {
    const { transport, foothold } = await opened();
    await expect(foothold.identify()).rejects.toThrow('FOOTHOLD_NOT_CONNECTED');
    transport.peer = true;
    await expect(foothold.send('id')).rejects.toThrow(/FOOTHOLD_NEEDS_IDENTITY:.*foothold-identify.*whoami; id/);
    await expect(foothold.read()).rejects.toThrow('FOOTHOLD_NEEDS_IDENTITY');
    expect(transport.writes).toEqual([]); // no model bytes reached the peer before the identity gate
  });

  it('confirms identity through the shell with one fixed probe, records the observation, and serializes concurrent probes', async () => {
    const { transport, foothold } = await opened();
    transport.peer = true;
    transport.log += '[p2o] connection from 10.0.0.5:4444\n' + IDENTITY;
    const [first, second] = await Promise.all([foothold.identify(), foothold.identify()]);
    expect(first).toEqual(second);
    expect(first.observation).toContain('uid=0(root)');
    expect(first.observation).not.toContain('[p2o]'); // host relay markers are not peer identity
    // D40/A5: the recorded identity is also parsed so a task or brief can cite it without re-reading prose.
    expect(first).toMatchObject({ user: 'root', uid: 0, gid: 0, method: 'listener' });
    expect(foothold.state()!.identified).toEqual(first);
    // The probe is exactly the fixed `whoami; id` line and it was written once, not once per caller.
    expect(transport.writes).toHaveLength(1);
    expect(payload(transport.writes[0])).toBe('whoami; id\n');
    // The identity confirmation did not consume the transcript cursor.
    expect(foothold.state()!.offset).toBe(Buffer.byteLength(MARKER));
  });

  it('records no identity when the peer produced nothing: relay markers alone are not confirmation', async () => {
    const { transport, foothold } = await opened();
    transport.peer = true;
    transport.log += '[p2o] connection from 10.0.0.5:4444\n[p2o] peer closed the connection\n';
    await expect(foothold.identify()).rejects.toThrow('FOOTHOLD_NO_OUTPUT');
    expect(foothold.state()!.identified).toBeUndefined();
  });

  it('returns a bounded preview, advances the cursor by captured bytes and flags a larger transcript', async () => {
    const { transport, foothold } = await opened();
    transport.peer = true;
    transport.log += IDENTITY;
    await foothold.identify();
    transport.log = MARKER + 'A'.repeat(2 * FOOTHOLD_PREVIEW_BYTES) + 'TAIL';
    const first = await foothold.read(4096);
    expect(first.preview).toBe('A'.repeat(4096));
    expect(first.totalBytes).toBe(Buffer.byteLength(transport.log));
    expect(first.nextOffset).toBe(Buffer.byteLength(MARKER) + 4096);
    expect(first.truncated).toBe(true);
    const second = await foothold.read(FOOTHOLD_PREVIEW_BYTES);
    expect(second.preview).toBe('A'.repeat(FOOTHOLD_PREVIEW_BYTES));
    expect(second.nextOffset).toBe(first.nextOffset + FOOTHOLD_PREVIEW_BYTES);
    expect(second.truncated).toBe(true);
    const third = await foothold.read();
    expect(third).toMatchObject({ preview: 'A'.repeat(FOOTHOLD_PREVIEW_BYTES - 4096) + 'TAIL', truncated: false });
    expect(third.nextOffset).toBe(third.totalBytes);
    await expect(foothold.read()).resolves.toEqual({ preview: '', nextOffset: third.totalBytes, totalBytes: third.totalBytes, truncated: false });
    await expect(foothold.read(FOOTHOLD_PREVIEW_BYTES + 1)).rejects.toThrow('FOOTHOLD_BOUND');
  });

  it('sends interactive bytes with no foothold cap smaller than the transport command bound', async () => {
    const { transport, foothold } = await opened();
    transport.peer = true;
    transport.log += IDENTITY;
    await foothold.identify();
    const sent = await foothold.send('cd /tmp; id');
    expect(sent.bytes).toBe(Buffer.byteLength('cd /tmp; id\n')); // trailing newline added when missing
    expect(payload(transport.writes.at(-1)!)).toBe('cd /tmp; id\n');
    // 20 KiB is well past any per-send cap the old catcher implied; only the 32 KiB command transport bounds it.
    expect((await foothold.send('B'.repeat(20 * 1024))).bytes).toBe(20 * 1024 + 1);
    await expect(foothold.send('C'.repeat(FOOTHOLD_TRANSPORT_COMMAND_BYTES))).rejects.toThrow(/FOOTHOLD_SEND_TOO_LARGE:.*32768-byte \/bin\/sh -c bound/);
    expect(transport.writes).toHaveLength(3); // one identity probe + two sends; the refused send wrote nothing
    transport.sendCode = 4; // a stalled reader is a fault, never a silent partial line
    await expect(foothold.send('id')).rejects.toThrow(/FOOTHOLD_SEND_BLOCKED:.*stayed full/);
    transport.sendCode = 3; // relay reader gone: the peer dropped
    await expect(foothold.send('id')).rejects.toThrow('FOOTHOLD_NOT_CONNECTED');
    expect(foothold.state()!.connected).toBe(false);
  });

  it('kills the relay and verifies removal, and reports an unverified close as unverified', async () => {
    const { transport, foothold } = await opened();
    transport.peer = true;
    transport.log += IDENTITY;
    await foothold.identify();
    transport.closeVerify = 1;
    await expect(foothold.close()).rejects.toThrow('FOOTHOLD_CLOSE_UNVERIFIED');
    expect(foothold.isOpen).toBe(true);
    transport.closeVerify = 0;
    const closed = await foothold.close();
    expect(closed).toEqual({ port: 4444, address: 'p2o-session-fixture:4444', verified: true, log: 'foothold/foothold-4444.log' });
    expect(transport.commands.some(entry => entry.command.includes('kill 4242'))).toBe(true);
    expect(transport.commands.at(-1)!.command).toContain('test ! -e foothold/foothold-4444.pid');
    expect(foothold.state()!.connected).toBe(false);
    expect(foothold.isOpen).toBe(false);
    await expect(foothold.send('id')).rejects.toThrow('FOOTHOLD_NOT_OPEN');
    // The transcript log is kept for its capture path; nothing else of the relay is.
    expect(transport.commands.at(-1)!.command).not.toContain('foothold-4444.log');
    // A closed foothold may be opened again (a new target connection), but never two at once.
    await foothold.open(4445);
    expect(foothold.state()!.port).toBe(4445);
  });

  it('refuses to start when the relay never reports listening, and leaves no open state', async () => {
    const transport = new ScriptedTransport();
    transport.health = 1;
    transport.log = 'Traceback: address already in use\n';
    const foothold = new Foothold(transport, { container: 'p2o-session-fixture' });
    await expect(foothold.open(4444)).rejects.toThrow(/FOOTHOLD_UNHEALTHY:.*0\.0\.0\.0:4444/);
    expect(foothold.state()).toBeUndefined();
    expect(transport.commands.some(entry => entry.command.includes('rm -f foothold/foothold-4444.pid'))).toBe(true);
  });

  it('parses the identity a brief can cite from the probe bytes, without inventing a field', () => {
    expect(shellIdentity('root\nuid=0(root) gid=0(root) groups=0(root)')).toEqual({ user: 'root', uid: 0, gid: 0 });
    expect(shellIdentity('www-data\nuid=33(www-data) gid=33(www-data) groups=33(www-data)')).toEqual({ user: 'www-data', uid: 33, gid: 33 });
    expect(shellIdentity('uid=1000(deploy)\ngid=1000(deploy)')).toEqual({ uid: 1000, gid: 1000 });
    expect(shellIdentity('not a shell prompt')).toEqual({});
  });

  it('exposes the action vocabulary and keeps every foothold action off the validation-worker allowlist', () => {
    expect([...FOOTHOLD_ACTIONS]).toEqual(['foothold-open', 'foothold-identify', 'foothold-send', 'foothold-read', 'foothold-close']);
    for (const action of FOOTHOLD_ACTIONS) {
      expect(isFootholdAction(action)).toBe(true);
      expect(validationMayUseSession(action), action).toBe(false); // a validation worker gets open only
    }
    expect(isFootholdAction('listen')).toBe(false);
    expect(validationMayUseSession('open')).toBe(true);
  });
});
