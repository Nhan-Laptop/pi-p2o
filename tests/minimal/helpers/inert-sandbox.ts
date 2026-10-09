import { appendFileSync } from 'node:fs';
import { Sandbox } from '../../../src/sandbox.js';
import type { HttpRequest } from '../../../src/target.js';

/** Real Pi, inert sandbox: no Docker, no live AI. Optionally journals calls for a test. */
export class InertSandbox extends Sandbox {
  commands: Array<{ command: string; workdir: string; timeout: number }> = [];
  httpCalls: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }> = [];
  override sourceSkipped = 0;
  stopCount = 0;
  failStart = false;
  cleanupFailure = false;
  private journal(line: Record<string, unknown>): void {
    const path = process.env.P2O_TEST_SANDBOX_LOG;
    if (!path) return;
    try { appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...line })}\n`); } catch { /* journaling is best effort */ }
  }
  override async start() { this.journal({ op: 'start' }); if (this.failStart) throw new Error('docker unavailable'); }
  override async stop() { this.stopCount += 1; this.journal({ op: 'stop' }); if (this.cleanupFailure) throw new Error('cleanup not verified'); }
  override async exec(command: string, seconds = 0, _signal?: AbortSignal, workdir = '/work', _onRunning?: () => void) {
    this.commands.push({ command, workdir, timeout:seconds });
    this.journal({ op: 'exec', command, workdir, timeout:seconds });
    return { code: 0, stdout: `INERT_SANDBOX uid=65532\n${command}`, stderr: '', truncated: false };
  }
  override async http(request: HttpRequest) {
    this.httpCalls.push({ url: request.url, method: request.method, body: request.body, headers: request.headers });
    this.journal({ op: 'http', url: request.url, method: request.method, body: request.body ?? null, headers: request.headers ?? null });
    return { code: 0, stdout: `HTTP/1.1 200 OK\n${request.method} ${request.url}`, stderr: '', truncated: false, hops: [`200 ${request.method} ${request.url}`] };
  }
  override async assertNoRunContainers() { this.journal({ op: 'sweep' }); }
}
