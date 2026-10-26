import { describe, expect, it } from 'vitest';
import { PtySession, PTY_READ_BYTES, PTY_RING_BYTES, dockerPtyArgs, type PtyChild, type PtySpawner } from '../../src/pty.js';

class FakeChild implements PtyChild {
  written: string[] = [];
  killed: Array<NodeJS.Signals | undefined> = [];
  failWrite = false;
  private readonly dataListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(code: number | null) => void> = [];
  write(data: string): void { if (this.failWrite) throw new Error('stdin closed'); this.written.push(data); }
  kill(signal?: NodeJS.Signals): void { this.killed.push(signal); }
  onData(listener: (chunk: string) => void): void { this.dataListeners.push(listener); }
  onExit(listener: (code: number | null) => void): void { this.exitListeners.push(listener); }
  emit(chunk: string): void { for (const listener of this.dataListeners) listener(chunk); }
  exit(code: number | null = 0): void { for (const listener of this.exitListeners) listener(code); }
}

function fixture(options: { workdir?: string; spawn?: PtySpawner } = {}) {
  const children: FakeChild[] = [], spawns: string[][] = [];
  const spawn: PtySpawner = options.spawn ?? (args => { spawns.push([...args]); const child = new FakeChild(); children.push(child); return child; });
  const session = new PtySession({ container: 'p2o-abc123', spawn, ...(options.workdir ? { workdir: options.workdir } : {}) });
  return { session, children, spawns };
}

describe('interactive session PTY (A7.3)', () => {
  it('builds fixed docker exec argv and refuses a foreign container or workdir', () => {
    expect(dockerPtyArgs('p2o-abc123')).toEqual(['exec', '-i', '-t', 'p2o-abc123', '/bin/sh']);
    expect(dockerPtyArgs('p2o-abc123', '/work/sessions/session-0123abcd')).toEqual(['exec', '-i', '-t', '-w', '/work/sessions/session-0123abcd', 'p2o-abc123', '/bin/sh']);
    expect(dockerPtyArgs('p2o-abc123', '/work/worker-a')).toEqual(['exec', '-i', '-t', '-w', '/work/worker-a', 'p2o-abc123', '/bin/sh']);
    expect(() => dockerPtyArgs('--privileged')).toThrow('Invalid container name');
    expect(() => dockerPtyArgs('p2o-abc; rm -rf /')).toThrow('Invalid container name');
    expect(() => dockerPtyArgs('p2o-abc123', '/etc')).toThrow('Invalid PTY working directory');
    expect(() => dockerPtyArgs('p2o-abc123', '/work/../etc')).toThrow('Invalid PTY working directory');
  });

  it('spawns exactly one child and passes the workdir through', () => {
    const f = fixture({ workdir: '/work/sessions/session-0123abcd' });
    f.session.open();
    expect(f.spawns).toHaveLength(1);
    expect(f.spawns[0]).toEqual(['exec', '-i', '-t', '-w', '/work/sessions/session-0123abcd', 'p2o-abc123', '/bin/sh']);
    f.session.open();
    expect(f.spawns).toHaveLength(1);
    expect(f.children).toHaveLength(1);
  });

  it('writes raw bytes and reads from the host-owned cursor', () => {
    const f = fixture();
    expect(() => f.session.read(0)).toThrow('not open');
    f.session.open();
    f.session.write('id\n');
    expect(f.children[0].written).toEqual(['id\n']);
    f.children[0].emit('uid=0(root)\r\n');
    const first = f.session.read(0);
    expect(first).toMatchObject({ text: 'uid=0(root)\r\n', cursor: 13, dropped: 0 });
    const again = f.session.read(first.cursor);
    expect(again).toMatchObject({ text: '', cursor: 13, dropped: 0 });
    f.children[0].emit('second line\r\n');
    const second = f.session.read(13);
    expect(second.text).toBe('second line\r\n');
    expect(second.cursor).toBe(26);
  });

  it('caps one read at PTY_READ_BYTES without losing the rest', () => {
    const f = fixture();
    f.session.open();
    f.children[0].emit('a'.repeat(100 * 1024));
    const first = f.session.read(0);
    expect(Buffer.byteLength(first.text)).toBe(PTY_READ_BYTES);
    expect(first.cursor).toBe(PTY_READ_BYTES);
    const second = f.session.read(first.cursor);
    expect(Buffer.byteLength(second.text)).toBe(100 * 1024 - PTY_READ_BYTES);
    expect(second.cursor).toBe(100 * 1024);
  });

  it('reports dropped bytes when the bounded ring wrapped past the cursor', () => {
    const f = fixture();
    f.session.open();
    f.children[0].emit('x'.repeat(PTY_RING_BYTES + 44 * 1024));
    const page = f.session.read(0);
    expect(page.dropped).toBe(44 * 1024);
    expect(Buffer.byteLength(page.text)).toBe(PTY_READ_BYTES);
    expect(page.cursor).toBe(44 * 1024 + PTY_READ_BYTES);
    // The rest of the retained ring is still readable from the returned cursor; only the dropped prefix is gone.
    const rest = f.session.read(page.cursor);
    expect(Buffer.byteLength(rest.text)).toBe(PTY_READ_BYTES);
    expect(rest.cursor).toBe(page.cursor + PTY_READ_BYTES);
  });

  it('closes idempotently, kills once, and refuses reads/writes after close', () => {
    const f = fixture();
    f.session.open();
    f.session.close();
    f.session.close();
    expect(f.session.closed).toBe(true);
    expect(f.children[0].killed).toEqual(['SIGTERM']);
    expect(() => f.session.write('x')).toThrow('PTY session is closed');
    expect(() => f.session.read(0)).toThrow('PTY session is closed');
    expect(() => f.session.open()).toThrow('PTY session is closed');
  });

  it('fails closed when the child exits: no silent re-exec, no retry', () => {
    const f = fixture();
    f.session.open();
    f.children[0].emit('before exit\r\n');
    f.children[0].exit(1);
    expect(() => f.session.write('after')).toThrow('PTY_DEAD: docker exec shell exited with code 1');
    expect(() => f.session.read(0)).toThrow('PTY_DEAD');
    f.session.close();
    expect(f.children).toHaveLength(1);
    expect(f.spawns).toHaveLength(1);
  });

  it('fails closed when the spawner itself cannot start', () => {
    const f = fixture({ spawn: () => { throw new Error('docker missing'); } });
    expect(() => f.session.open()).toThrow('PTY_DEAD: could not start docker exec');
    expect(f.session.closed).toBe(true);
  });
});
