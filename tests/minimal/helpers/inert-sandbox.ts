import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Sandbox } from '../../../src/sandbox.js';
import { scratchBound, scratchPath, scratchPrefixHash, scratchRoot, type ScratchSnapshot } from '../../../src/scratch.js';
import type { HttpRequest } from '../../../src/target.js';
import type { OutputObserver } from '../../../src/process.js';

/** Real Pi, inert sandbox: no Docker, no live AI. Optionally journals calls for a test. */
export class InertSandbox extends Sandbox {
  commands: Array<{ command: string; workdir: string; timeout: number }> = [];
  httpCalls: Array<{ url: string; method: string; body?: string; headers?: Record<string, string>; principal?: string }> = [];
  override sourceSkipped = 0;
  stopCount = 0;
  failStart = false;
  cleanupFailure = false;
  /** Bytes written to scratch, keyed by workdir+path, so an inert capture can return them. */
  private scratchFiles = new Map<string, Buffer>();
  /** Reported capture roots and offsets, in call order. */
  captures: Array<{ path: string; workdir: string; maxBytes: number; offset: number; bytes: number; root: string }> = [];
  /** Set to report a different root than requested: the provenance-refusal probe. */
  captureRootOverride?: string;
  private journal(line: Record<string, unknown>): void {
    const path = process.env.P2O_TEST_SANDBOX_LOG;
    if (!path) return;
    try { appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...line })}\n`); } catch { /* journaling is best effort */ }
  }
  provisionCount = 0;
  failProvision = false;
  override async provision(assignment: string) {
    this.provisionCount += 1; this.journal({ op: 'provision', assignment });
    if (this.failProvision) throw new Error('assignment scratch is not writable');
  }
  override async start() { this.journal({ op: 'start' }); if (this.failStart) throw new Error('docker unavailable'); }
  override async stop() { this.stopCount += 1; this.journal({ op: 'stop' }); if (this.cleanupFailure) throw new Error('cleanup not verified'); }
  override async exec(command: string, seconds = 0, _signal?: AbortSignal, workdir = '/work', _onRunning?: () => void, onOutput?: OutputObserver) {
    _onRunning?.();
    this.commands.push({ command, workdir, timeout:seconds });
    this.journal({ op: 'exec', command, workdir, timeout:seconds });
    const stdout = `INERT_SANDBOX uid=65532\n${command}`; onOutput?.('stdout',Buffer.from(stdout));
    return { code: 0, stdout, stderr: '', truncated: false };
  }
  override async http(request: HttpRequest, _signal?:AbortSignal, onRunning?:()=>void, onOutput?:OutputObserver) {
    onRunning?.();
    this.httpCalls.push({ url: request.url, method: request.method, body: request.body, headers: request.headers, principal: request.principal });
    this.journal({ op: 'http', url: request.url, method: request.method, body: request.body ?? null, headers: request.headers ?? null });
    const stdout = `HTTP/1.1 200 OK\n${request.method} ${request.url}`; onOutput?.('stdout',Buffer.from(stdout));
    return { code: 0, stdout, stderr: '', truncated: false, hops: [`200 ${request.method} ${request.url}`] };
  }
  writes: Array<{ path: string; workdir: string; bytes: number; sha256: string; mode: number }> = [];
  override async writeScratch(path: string, bytes: Buffer, _signal?: AbortSignal, workdir = '/work', mode = 0o500) {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.scratchFiles.set(`${workdir}\u0000${path}`, Buffer.from(bytes));
    this.writes.push({ path, workdir, bytes: bytes.length, sha256, mode });
    this.journal({ op: 'writeScratch', path, workdir, bytes: bytes.length, sha256, mode });
    return { path, root: workdir, bytes: bytes.length, sha256, mode };
  }
  /** The fixed FD reader's observable result, without Docker: same snapshot shape the store validates. */
  override async captureScratch(path: string, maxBytes: number, _signal?: AbortSignal, workdir = '/work', onRunning?: () => void, onOutput?: OutputObserver, _seconds = 0, offsetBytes = 0) {
    const relative = scratchPath(path), requested = scratchRoot(workdir), bound = scratchBound(maxBytes);
    const root = this.captureRootOverride ?? requested, all = this.scratchFiles.get(`${requested}\u0000${relative}`) ?? Buffer.alloc(0);
    const offset = Math.min(offsetBytes, all.length), captured = all.subarray(offset, offset + bound);
    this.captures.push({ path: relative, workdir: requested, maxBytes: bound, offset, bytes: captured.length, root });
    this.journal({ op: 'captureScratch', path: relative, workdir: requested, root, bytes: captured.length, offset });
    onRunning?.(); onOutput?.('stdout', captured);
    const stat = { size: all.length, device: '1', inode: '2', mtimeNs: '3', ctimeNs: '4', links: 1 };
    const scratchSnapshot: ScratchSnapshot = { version: 1, path: relative, root, totalBytes: all.length, offset, capturedBytes: captured.length,
      prefixSha256: scratchPrefixHash(captured), before: stat, after: stat, stable: true, encoding: 'utf8-prefix' };
    return { code: 0, stdout: captured.subarray(0, 8192).toString('utf8'), stderr: '', truncated: false, scratchSnapshot, previewLimit: 8192 };
  }
  override async assertNoRunContainers() { this.journal({ op: 'sweep' }); }
}
