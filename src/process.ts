import { spawn } from 'node:child_process';

export const OUTPUT_LIMIT = 48 * 1024;
export interface ProcessResult { code: number; stdout: string; stderr: string; truncated: boolean }
export type RunProcess = (args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<ProcessResult>;

/** Fixed executable, argument arrays only; never run a model-supplied host shell. */
export const runDocker: RunProcess = (args, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new Error('Cancelled')); return; }
  const env = { ...process.env };
  // A local daemon is required for local bind mounts; these cannot redirect our selected socket.
  delete env.DOCKER_HOST; delete env.DOCKER_CONTEXT; delete env.DOCKER_TLS_VERIFY; delete env.DOCKER_CERT_PATH;
  const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  let bytes = 0; let truncated = false; let failure: Error | undefined;
  const collect = (chunks: Buffer[], data: Buffer) => {
    const remaining = Math.max(0, OUTPUT_LIMIT - bytes);
    if (data.length > remaining) truncated = true;
    const chunk = data.subarray(0, remaining); chunks.push(chunk); bytes += chunk.length;
  };
  child.stdout.on('data', (data: Buffer) => collect(stdout, data));
  child.stderr.on('data', (data: Buffer) => collect(stderr, data));
  const kill = (message: string) => { failure = new Error(message); child.kill('SIGKILL'); };
  const abort = () => kill('Cancelled');
  const timer = setTimeout(() => kill('Docker operation timed out'), options.timeoutMs ?? 30_000);
  options.signal?.addEventListener('abort', abort, { once: true });
  const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
  child.once('error', error => { cleanup(); reject(error); });
  child.once('close', code => {
    cleanup();
    if (failure) reject(failure);
    else resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), truncated });
  });
});

export function checked(result: ProcessResult): ProcessResult {
  if (result.code !== 0) throw new Error(cleanText(result.stderr || result.stdout || `Docker exited ${result.code}`));
  return result;
}

/** Prevent target-controlled terminal escape sequences in notifications and tool text. */
export function cleanText(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').slice(0, OUTPUT_LIMIT);
}
