import { spawn } from 'node:child_process';

export const OUTPUT_LIMIT = 48 * 1024;
export interface ProcessResult { code: number; stdout: string; stderr: string; truncated: boolean; evidenceId?: string; hops?: string[]; session?: string; redirectStopped?: string; cookieWarning?: string }
export type OutputStream = 'stdout' | 'stderr';
/** Trusted host callback only; raw bytes must never become serializable process/RPC metadata. */
export type OutputObserver = (stream: OutputStream, bytes: Buffer) => void;
/** `stdin` is passed once and closed immediately; it carries a request body, never a model-run host shell. */
export type RunProcess = (args: string[], options?: { timeoutMs?: number | null; signal?: AbortSignal; stdin?: string; onOutput?: OutputObserver }) => Promise<ProcessResult>;

/** Fixed executable, argument arrays only; never run a model-supplied host shell. */
export function runFixed(command: string, args: string[], options: { timeoutMs?: number | null; signal?: AbortSignal; env?: NodeJS.ProcessEnv; stdin?: string; onOutput?: OutputObserver } = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new Error('Cancelled')); return; }
  const child = spawn(command, args, { env: options.env ?? process.env, stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  let bytes = 0; let truncated = false; let failure: Error | undefined;
  const kill = (message: string) => { failure ??= new Error(message); child.kill('SIGKILL'); };
  const observe = (stream: OutputStream, data: Buffer) => {
    if (failure) return;
    try { options.onOutput?.(stream, data); } catch { kill('Output capture observer failed; remote outcome unknown'); }
  };
  const collect = (stream: OutputStream, chunks: Buffer[], data: Buffer) => {
    observe(stream, data); // Before the independent 48 KiB visible-output cap.
    const remaining = Math.max(0, OUTPUT_LIMIT - bytes);
    if (data.length > remaining) truncated = true;
    if (!remaining || !data.length) return; // Endless excess output must not accumulate empty chunk descriptors.
    const chunk = Buffer.from(data.subarray(0, remaining)); chunks.push(chunk); bytes += chunk.length;
  };
  child.once('spawn', () => observe('stdout', Buffer.alloc(0)));
  child.stdout?.on('data', (data: Buffer) => collect('stdout', stdout, data));
  child.stderr?.on('data', (data: Buffer) => collect('stderr', stderr, data));
  const abort = () => kill('Cancelled');
  child.stdin?.on('error', () => kill('Request input delivery failed'));
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  // null explicitly disables task duration limits; omitted keeps the infrastructure watchdog.
  const timer = options.timeoutMs === null ? undefined : setTimeout(() => kill('Docker operation timed out'), options.timeoutMs ?? 30_000);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const cleanup = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
  child.once('error', error => { cleanup(); reject(error); });
  child.once('close', code => {
    cleanup();
    if (failure) reject(failure);
    else resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), truncated });
  });
  });
}

/** Stop waiting on asynchronous setup (such as DNS) without reviving it after cancellation. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve,reject) => {
    const abort = () => { cleanup(); reject(new Error('Cancelled')); };
    const cleanup = () => signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    work.then(value => { cleanup(); resolve(value); },error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Keep target-controlled output from redirecting the daemon we selected. */
export function dockerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DOCKER_HOST; delete env.DOCKER_CONTEXT; delete env.DOCKER_TLS_VERIFY; delete env.DOCKER_CERT_PATH;
  return env;
}

const DOCKER_ENV = { get env() { return dockerEnvironment(); } };

/** Docker CLI with any daemon-redirecting variables removed. */
export const runDocker: RunProcess = (args, options = {}) => runFixed('docker', args, { ...options, env: DOCKER_ENV.env });

/** Herdr CLI. The caller supplies only fixed subcommands and validated arguments. */
export const runHerdr: RunProcess = (args, options = {}) => runFixed('herdr', args, options);

export function checked(result: ProcessResult): ProcessResult {
  if (result.code !== 0) throw new Error(cleanText(result.stderr || result.stdout || `Docker exited ${result.code}`));
  return result;
}

/** Prevent target-controlled terminal escape sequences in notifications and tool text. */
export function cleanText(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').slice(0, OUTPUT_LIMIT);
}
