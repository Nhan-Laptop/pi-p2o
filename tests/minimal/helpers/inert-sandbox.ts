import { appendFileSync } from 'node:fs';
import { Sandbox } from '../../../src/sandbox.js';

/** Real Pi, inert sandbox: no Docker, no network, no live AI. Optionally journals calls for a test. */
export class InertSandbox extends Sandbox {
  commands: Array<{ command: string; workdir: string }> = [];
  httpCalls: Array<{ url: string; method: string }> = [];
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
  override async exec(command: string, _seconds?: number, _signal?: AbortSignal, workdir = '/work') {
    this.commands.push({ command, workdir });
    this.journal({ op: 'exec', command, workdir });
    return { code: 0, stdout: `INERT_SANDBOX uid=65532\n${command}`, stderr: '', truncated: false };
  }
  override async http(url: string, method: 'GET' | 'HEAD' = 'GET') {
    this.httpCalls.push({ url, method });
    this.journal({ op: 'http', url, method });
    return { code: 0, stdout: `HTTP/1.1 200 OK\n${method} ${url}`, stderr: '', truncated: false };
  }
  override async assertNoRunContainers() { this.journal({ op: 'sweep' }); }
}
