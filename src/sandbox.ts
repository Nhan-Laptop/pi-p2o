import { randomUUID } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { copySource } from './source.js';
import { checked, runDocker, type RunProcess, type ProcessResult } from './process.js';
import { scopedRequest, type ResolveAddress, type Target } from './target.js';

// Fixed content digest, not a mutable tag or a model-selected image. No automatic image pull.
export const IMAGE = 'ghcr.io/usestrix/strix-sandbox@sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331';
const LIMITS = (options: SandboxOptions) => ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--user', '65532:65532', '--pids-limit', '128', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1',
  '--ulimit', 'nofile=1024:1024', '--log-driver', 'none',
  '--tmpfs', `/tmp:rw,nosuid,nodev,size=${options.tmpBytes ?? '64m'},mode=1777`,
  '--tmpfs', `/work:rw,nosuid,nodev,size=${options.workBytes ?? '64m'},mode=1777`,
  '--workdir', '/work', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp'];

/** Optional sizing/labelling. Delegated runs get more scratch and a run label for verified sweeps. */
export interface SandboxOptions { tmpBytes?: string; workBytes?: string; runId?: string; image?: string }
export function validateImage(image: string): string {
  if (!/^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64})$/.test(image)) throw new Error('Sandbox image must be an immutable sha256 ID or repository@sha256 digest');
  return image;
}
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Docker containers are executors, never AI agents. All names are owned until removal is verified. */
export class Sandbox {
  private names = new Set<string>();
  private shell?: string;
  private source?: string;
  sourceSkipped = 0;
  sourceManifest: Record<string, string> = {};
  private endpoint?: string;
  private stopped = false;
  private pending: Promise<unknown> = Promise.resolve();
  private cancellation = new AbortController();
  private readonly workdirs = new Set<string>();
  constructor(readonly target: Target, private readonly run: RunProcess = runDocker, private readonly resolveIP?: ResolveAddress, private readonly options: SandboxOptions = {}) {
    validateImage(options.image ?? IMAGE);
    if (options.runId !== undefined && !ID_PATTERN.test(options.runId)) throw new Error('Invalid run id for container labels');
  }

  private async docker(args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ProcessResult> {
    return this.run(this.endpoint ? ['--host', this.endpoint, ...args] : args, options);
  }

  async start(): Promise<void> {
    // Select the real current local Docker context once. Never honor a remote daemon for host mounts.
    const endpoint = process.env.DOCKER_HOST || JSON.parse(checked(await this.run(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'])).stdout.trim()) as string;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:///') || /[\x00-\x1f]/.test(endpoint)) throw new Error('A local Unix-socket Docker daemon is required');
    this.endpoint = endpoint;
    const info = checked(await this.docker(['info', '--format', '{{.OSType}}']));
    if (info.stdout.trim() !== 'linux') throw new Error('A Linux Docker daemon is required');
    checked(await this.docker(['image', 'inspect', this.options.image ?? IMAGE]));
    if (this.target.kind === 'directory' && await realpath(this.target.path) !== this.target.path) throw new Error('Target directory changed during confirmation');
    if (this.target.kind === 'directory') {
      const source = await copySource(this.target.path);
      this.source = source.path; this.sourceSkipped = source.skipped; this.sourceManifest = source.manifest;
    }
    const mount = this.source ? ['--volume', `${this.source}:/target:ro`] : [];
    this.shell = await this.create('none', [...mount, '--entrypoint', '/bin/sh', this.options.image ?? IMAGE, '-c', 'exec sleep infinity']);
    checked(await this.docker(['start', this.shell]));
    const running = checked(await this.docker(['inspect', '--format', '{{.State.Running}}', this.shell]));
    if (running.stdout.trim() !== 'true') throw new Error('Sandbox did not stay running');
  }

  private async create(network: string, command: string[]): Promise<string> {
    if (this.stopped) throw new Error('Sandbox is stopped');
    const name = `p2o-${randomUUID()}`;
    this.names.add(name); // Track before dispatch, even if the CLI loses its response.
    const labels = ['--label', 'pi-p2o=minimal', ...(this.options.runId ? ['--label', `pi-p2o.run=${this.options.runId}`] : [])];
    checked(await this.docker(['create', '--name', name, ...labels, '--network', network, ...LIMITS(this.options), ...command]));
    return name;
  }

  /** Serialize shell, HTTP and close; cleanup cannot race container creation. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => {});
    return next;
  }

  async exec(command: string, seconds = 30, signal?: AbortSignal, workdir = '/work'): Promise<ProcessResult> {
    if (!command || command.length > 8192 || !Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('Command must be 1..8192 characters; timeout must be 1..60 seconds');
    if (workdir !== '/work' && !/^\/work\/[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(workdir)) throw new Error('Invalid sandbox working directory');
    return this.enqueue(async () => {
      if (this.stopped || !this.shell) throw new Error('No active sandbox');
      const combined = AbortSignal.any([this.cancellation.signal, ...(signal ? [signal] : [])]);
      try {
        await this.ensureWorkdir(workdir, combined);
        const result = await this.docker(['exec', '--workdir', workdir, this.shell, '/usr/bin/timeout', '--signal=KILL', `${seconds}s`, '/bin/sh', '-c', command], { timeoutMs: (seconds + 5) * 1000, signal: combined });
        if (result.code === 124 || result.code === 137) throw new Error('Sandbox command timed out; stopping the sandbox to remove background processes');
        return result;
      } catch (error) {
        // One caller aborting its own command (e.g. a worker being stopped) must not destroy the shared
        // sandbox for everyone else. The command's own `timeout` wrapper reaps it.
        if (!signal?.aborted) {
          this.stopped = true;
          await this.removeAll();
        }
        throw error;
      }
    });
  }

  private async ensureWorkdir(workdir: string, signal: AbortSignal): Promise<void> {
    if (workdir === '/work' || this.workdirs.has(workdir)) return;
    const created = await this.docker(['exec', this.shell!, '/bin/mkdir', '-p', workdir], { timeoutMs: 15_000, signal });
    // Docker may report failure to attach while the command still ran; only a real absence is fatal.
    const exists = await this.docker(['exec', this.shell!, '/bin/sh', '-c', `test -d ${workdir}`], { timeoutMs: 15_000, signal });
    if (created.code !== 0 && exists.code !== 0) throw new Error(`Could not prepare the sandbox working directory ${workdir}`);
    this.workdirs.add(workdir);
  }

  async http(value: string, method: 'GET' | 'HEAD' = 'GET', signal?: AbortSignal): Promise<ProcessResult> {
    if (!['GET', 'HEAD'].includes(method) || value.length > 4096) throw new Error('Only GET/HEAD and URLs up to 4096 characters are supported');
    return this.enqueue(async () => {
      if (this.stopped || !this.shell) throw new Error('No active sandbox');
      const { url, address } = await scopedRequest(this.target, value, this.resolveIP);
      if (this.stopped || signal?.aborted) throw new Error('Cancelled');
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      // This networking container runs ONLY fixed curl arguments, never model-supplied shell/code.
      const name = await this.create('bridge', ['--entrypoint', '/usr/bin/curl', this.options.image ?? IMAGE, '-q',
        '--proxy', '', '--noproxy', '*', '--proto', '=http,https', '--max-time', '20', '--connect-timeout', '5',
        '--max-filesize', '1048576', '--max-redirs', '0', '--no-location', '--silent', '--show-error', '--include',
        '--resolve', `${url.hostname}:${port}:${address}`, ...(method === 'HEAD' ? ['--head'] : []), '--url', url.href]);
      try {
        return await this.docker(['start', '--attach', name], {
          timeoutMs: 25_000, signal: AbortSignal.any([this.cancellation.signal, ...(signal ? [signal] : [])]),
        });
      } finally { await this.remove(name); }
    });
  }

  private async remove(name: string): Promise<void> {
    // A CLI exit code is not evidence in either direction: `rm` can fail for a container that is already
    // gone, and can "succeed" while the daemon still lists it. The listing is the source of truth.
    const removal = await this.docker(['rm', '--force', name]).catch(() => ({ code: -1, stdout: '', stderr: 'rm failed', truncated: false }));
    const remaining = checked(await this.docker(['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']));
    if (remaining.stdout.trim()) throw new Error(`Sandbox cleanup unresolved: ${name} (docker rm exit ${removal.code}). Retry /p2o stop or check Docker`);
    this.names.delete(name);
  }

  private async removeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.names].map(name => this.remove(name)));
    if (results.some(result => result.status === 'rejected')) throw new Error('Sandbox removal could not be verified. Gate retained; retry /p2o stop or check Docker');
    if (this.source) { await rm(this.source, { recursive: true, force: true }); this.source = undefined; }
  }

  async stop(): Promise<void> {
    this.stopped = true; this.cancellation.abort();
    await this.pending;
    await this.removeAll();
  }

  /** Belt-and-braces: after removal, no container of this run may still exist on the daemon. */
  async assertNoRunContainers(): Promise<void> {
    if (!this.options.runId) return;
    const listed = checked(await this.docker(['container', 'ls', '--all', '--filter', `label=pi-p2o.run=${this.options.runId}`, '--format', '{{.Names}}']));
    const names = listed.stdout.split('\n').map(name => name.trim()).filter(Boolean);
    for (const name of names) { try { await this.remove(name); } catch { /* verified below */ } }
    const remaining = checked(await this.docker(['container', 'ls', '--all', '--filter', `label=pi-p2o.run=${this.options.runId}`, '--format', '{{.Names}}']));
    if (remaining.stdout.trim()) throw new Error(`Sandbox cleanup unresolved for run ${this.options.runId}: ${remaining.stdout.trim()}. Retry /p2o stop or check Docker`);
  }
}
