import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostBrowserBoundary } from '../../tools/sandbox.js';
import type { PreflightReport } from '../../tools/types.js';

type Check = PreflightReport['checks'][number];
/** Bounded loopback bind/close probe, never accepts traffic or contacts a target. */
export async function probeProxyPort(port = 0): Promise<Check> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { name: 'proxy-config', ok: false, detail: 'Invalid loopback port' };
  return new Promise(resolve => {
    const server = createServer(socket => socket.destroy());
    const timer = setTimeout(() => { server.close(); resolve({ name: 'proxy-port', ok: false, detail: 'Loopback bind timed out' }); }, 2000);
    server.once('error', () => { clearTimeout(timer); resolve({ name: 'proxy-port', ok: false, detail: 'Loopback port unavailable / permission denied' }); });
    server.listen(port, '127.0.0.1', () => server.close(() => { clearTimeout(timer); resolve({ name: 'proxy-port', ok: true, detail: `Observed bind and release on 127.0.0.1:${port}; production pack uses ephemeral port 0` }); }));
  });
}
/** Fixed local Chrome internal sandbox page; no --no-sandbox, remote URL, JS eval or inherited profile. */
export async function probeChromeSandbox(browser: HostBrowserBoundary, signal?: AbortSignal): Promise<Check> {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) return { name: 'browser-user-sandbox', ok: false, detail: 'Chrome sandbox requires a non-root user; no sandbox bypass attempted' };
  const profile = await mkdtemp(join(browser.profileRoot, 'readiness-'));
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(browser.identity.launcher, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND', '--proxy-server=http://127.0.0.1:9', `--user-data-dir=${profile}`, '--dump-dom', 'chrome://sandbox/'], { detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: profile, LANG: 'C.UTF-8' } });
      let text = '', bytes = 0, failed = false;
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already absent */ } } };
      const stop = () => { failed = true; kill(); };
      const timer = setTimeout(stop, 8000);
      signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 131072) stop(); else text += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 131072) stop(); });
      child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error); });
      child.once('close', async code => {
        kill(); clearTimeout(timer); signal?.removeEventListener('abort', stop);
        let absent = child.pid === undefined;
        for (let round = 0; !absent && round < 10; round++) {
          try { process.kill(-child.pid!, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
          if (!absent) await new Promise(done => setTimeout(done, 50));
        }
        if (failed || code !== 0 || !absent) reject(new Error('sandbox probe failed or process group termination unresolved')); else resolve(text);
      });
      if (signal?.aborted) stop();
    });
    const yes = (label: string) => new RegExp(`${label}</td>\\s*<td[^>]*>Yes</td>`, 'i').test(output);
    return { name: 'browser-user-sandbox', ok: yes('Namespace sandbox') && yes('Seccomp-BPF sandbox'), detail: 'Internal Chrome sandbox page must report Namespace and Seccomp-BPF sandbox Yes; unknown page format fails closed' };
  } catch { return { name: 'browser-user-sandbox', ok: false, detail: 'Bounded local sandbox probe failed; no --no-sandbox fallback' }; }
  finally { await rm(profile, { recursive: true, force: true }); }
}
