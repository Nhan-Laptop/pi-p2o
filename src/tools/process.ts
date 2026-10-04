import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { checkCancelled, invariant, PolicyError } from '../policy/errors.js';

export interface FixedProcessResult { code: number; stdout: string; stderr: string }
/** Internal supervisor primitive. Not a tool: no shell, PATH search, or inherited secret environment. */
export function runFixedProcess(executable: string, args: readonly string[], options: { input?: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }): Promise<FixedProcessResult> {
  checkCancelled(options.signal);
  invariant(isAbsolute(executable) && args.every(a => typeof a === 'string' && !a.includes('\u0000')), 'INVALID_INPUT', 'Fixed executable and valid argv required');
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' }, windowsHide: true }); }
    catch { reject(new PolicyError('UNAVAILABLE', 'Execution engine unavailable')); return; }
    let stdout = '', stderr = '', bytes = 0, failure: PolicyError | undefined;
    const stop = (error: PolicyError) => { failure ??= error; child.kill('SIGKILL'); };
    const cancel = () => stop(new PolicyError('CANCELLED', 'Execution cancelled'));
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop(new PolicyError('TIMEOUT', 'Fixed process deadline exceeded')), options.timeoutMs);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); };
    child.stdout?.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxOutputBytes) stop(new PolicyError('OUTPUT_LIMIT', 'Process output limit exceeded')); else stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxOutputBytes) stop(new PolicyError('OUTPUT_LIMIT', 'Process output limit exceeded')); else stderr += chunk.toString('utf8'); });
    child.once('error', () => { cleanup(); reject(new PolicyError('UNAVAILABLE', 'Execution engine failed')); });
    child.once('close', (code) => { cleanup(); if (failure) reject(failure); else if (options.signal?.aborted) reject(new PolicyError('CANCELLED', 'Execution cancelled')); else resolve({ code: code ?? -1, stdout, stderr }); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
    if (options.signal?.aborted) cancel();
  });
}
