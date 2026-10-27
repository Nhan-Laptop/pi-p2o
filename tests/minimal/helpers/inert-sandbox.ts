import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Sandbox } from '../../../src/sandbox.js';
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
    this.writes.push({ path, workdir, bytes: bytes.length, sha256, mode });
    this.journal({ op: 'writeScratch', path, workdir, bytes: bytes.length, sha256, mode });
    return { path, root: workdir, bytes: bytes.length, sha256, mode };
  }
  override async assertNoRunContainers() { this.journal({ op: 'sweep' }); }
}
