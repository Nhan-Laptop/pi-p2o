import { spawn } from 'node:child_process';

/**
 * Host-side handle for one long-lived interactive `docker exec` child (planning_update.md §A7.3, P7.4).
 *
 * The only child is `docker exec -i -t [-w <workdir>] <container> /bin/sh`: no host shell, fixed executable, argv array.
 * Output is retained in a bounded byte ring; every read is capped and carries a host-owned cursor. This module does not
 * interpret the stream: a shell, a `sudo -S` prompt, a database REPL and an SSH session each decide what their input means,
 * so the caller writes raw bytes and reads from a cursor instead of relying on an injected sentinel.
 */

export interface PtyChild {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
}

export type PtySpawner = (args: readonly string[]) => PtyChild;

export const PTY_RING_BYTES = 256 * 1024;
export const PTY_READ_BYTES = 64 * 1024;

const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const WORKDIR = /^\/work(?:\/sessions)?\/[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

/** Fixed argv for the interactive shell; the executable (`docker`) is added by the spawner. */
export function dockerPtyArgs(container: string, workdir?: string): string[] {
  if (typeof container !== 'string' || !CONTAINER_NAME.test(container)) throw new Error('Invalid container name for docker exec: expected 1-64 characters from [A-Za-z0-9_.-], starting with a letter or digit');
  const args = ['exec', '-i', '-t'];
  if (workdir !== undefined) {
    if (typeof workdir !== 'string' || !WORKDIR.test(workdir)) throw new Error('Invalid PTY working directory');
    args.push('-w', workdir);
  }
  return [...args, container, '/bin/sh'];
}

/** Production spawner. Pipes only; both streams belong to the same terminal session, so arrival order is the only order. */
export const dockerPtySpawner: PtySpawner = args => {
  const child = spawn('docker', [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const dataListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  let exited = false;
  const exit = (code: number | null) => { if (exited) return; exited = true; for (const listener of [...exitListeners]) listener(code); };
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (bytes: Buffer) => { const text = bytes.toString('utf8'); for (const listener of [...dataListeners]) listener(text); });
  child.once('exit', code => exit(code));
  child.once('error', () => exit(null));
  child.stdin?.on('error', () => exit(null)); // A broken stdin means the shell can no longer be driven.
  return {
    write(data: string) { child.stdin?.write(data); },
    kill(signal: NodeJS.Signals = 'SIGTERM') { child.kill(signal); },
    onData(listener: (chunk: string) => void) { dataListeners.add(listener); },
    onExit(listener: (code: number | null) => void) { exitListeners.add(listener); },
  };
};

export class PtySession {
  private readonly args: string[];
  private readonly ring = Buffer.alloc(PTY_RING_BYTES);
  private start = 0;
  private size = 0;
  private head = 0;
  private child?: PtyChild;
  private opened = false;
  private closedFlag = false;
  private exited = false;
  private exitCode: number | null = null;

  constructor(private readonly options: { container: string; spawn: PtySpawner; workdir?: string }) {
    this.args = dockerPtyArgs(options.container, options.workdir);
  }

  get closed(): boolean { return this.closedFlag; }
  get container(): string { return this.options.container; }
  /** Absolute byte count produced since open; the cursor space is 0..total. */
  get total(): number { return this.head; }

  /** Spawn the shell once. A closed or dead session never reopens; a second open on a live session is a no-op. */
  open(): void {
    if (this.closedFlag) throw new Error('PTY session is closed');
    if (this.opened) return;
    this.opened = true;
    try { this.child = this.options.spawn(this.args); }
    catch (error) { this.exited = true; this.closedFlag = true; throw Error(`PTY_DEAD: could not start docker exec (${error instanceof Error ? error.message : String(error)})`); }
    this.child.onData(chunk => this.receive(chunk));
    this.child.onExit(code => { this.exited = true; this.exitCode = code; });
  }

  /** Write bytes as-is. A dead or closed child fails closed; there is never a silent re-exec or retry. */
  write(data: string): void {
    this.requireLive();
    try { this.child!.write(typeof data === 'string' ? data : String(data)); }
    catch { this.exited = true; throw this.deadError(); }
  }

  /** Read at most PTY_READ_BYTES at absolute byte offset `cursor`; `dropped` counts bytes already discarded from the ring. */
  read(cursor = 0): { text: string; cursor: number; dropped: number } {
    this.requireLive();
    const dropped = this.head - this.size;
    let from = Number.isFinite(cursor) ? Math.floor(Number(cursor)) : 0;
    if (from < 0) from = 0;
    if (from > this.head) from = this.head;
    if (from < dropped) from = dropped;
    const end = Math.min(this.head, from + PTY_READ_BYTES);
    const text = end > from ? this.bytesBetween(from, end).toString('utf8') : '';
    return { text, cursor: end, dropped };
  }

  /** Idempotent; kills the child before its container is removed. Pending callers see a dead session, never a rerun. */
  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    try { this.child?.kill('SIGTERM'); } catch { /* already gone */ }
  }

  private requireLive(): PtyChild {
    if (this.closedFlag) throw new Error('PTY session is closed');
    if (!this.opened || !this.child) throw new Error('PTY session is not open');
    if (this.exited) throw this.deadError();
    return this.child;
  }

  private deadError(): Error {
    return new Error(`PTY_DEAD: docker exec shell exited${this.exitCode === null ? '' : ` with code ${this.exitCode}`}; open a new session instead of retrying`);
  }

  private receive(chunk: string): void {
    if (this.closedFlag || this.exited || typeof chunk !== 'string' || !chunk) return;
    this.append(Buffer.from(chunk, 'utf8'));
  }

  private append(bytes: Buffer): void {
    const capacity = PTY_RING_BYTES;
    this.head += bytes.length;
    if (bytes.length >= capacity) {
      bytes.copy(this.ring, 0, bytes.length - capacity);
      this.start = 0; this.size = capacity;
      return;
    }
    const overflow = this.size + bytes.length - capacity;
    if (overflow > 0) { this.start = (this.start + overflow) % capacity; this.size -= overflow; }
    const at = (this.start + this.size) % capacity;
    const first = Math.min(bytes.length, capacity - at);
    bytes.copy(this.ring, at, 0, first);
    if (first < bytes.length) bytes.copy(this.ring, 0, first);
    this.size += bytes.length;
  }

  private bytesBetween(from: number, to: number): Buffer {
    const length = to - from, retainedStart = this.head - this.size;
    const at = (this.start + (from - retainedStart)) % PTY_RING_BYTES;
    const first = Math.min(length, PTY_RING_BYTES - at);
    const out = Buffer.allocUnsafe(length);
    this.ring.copy(out, 0, at, at + first);
    if (first < length) this.ring.copy(out, first, 0, length - first);
    return out;
  }
}
