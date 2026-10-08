import { randomUUID } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { copySource } from './source.js';
import { checked, runDocker, type RunProcess, type ProcessResult } from './process.js';
import { isIP } from 'node:net';
import { httpRequest, scopedRequest, CONTAINER_HOST_ALIAS, type HttpRequest, type ResolveAddress, type Target } from './target.js';
import { HttpSessions, responseHead } from './http-session.js';

// Fixed content digest, not a mutable tag or a model-selected image. No automatic image pull.
export const IMAGE = 'ghcr.io/usestrix/strix-sandbox@sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331';
const LIMITS = (options: SandboxOptions) => ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--user', '65532:65532', '--pids-limit', '512', '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
  '--ulimit', 'nofile=4096:4096', '--log-driver', 'none',
  '--tmpfs', `/tmp:rw,nosuid,nodev,size=${options.tmpBytes ?? '512m'},mode=1777`,
  '--tmpfs', `/work:rw,nosuid,nodev,size=${options.workBytes ?? '512m'},mode=1777`,
  '--workdir', '/work', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp',
  '--env', 'SEMGREP_ENABLE_VERSION_CHECK=0', '--env', 'SEMGREP_SEND_METRICS=off'];

/** The container may reach the host's published ports under this alias; it is not the host's loopback. */
const HOST_ALIAS_ARGS = ['--add-host', `${CONTAINER_HOST_ALIAS}:host-gateway`];
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

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
  get isStopped(): boolean { return this.stopped; }
  sourceSkipped = 0;
  sourceManifest: Record<string, string> = {};
  private endpoint?: string;
  private stopped = false;
  private pending: Promise<unknown> = Promise.resolve();
  private cancellation = new AbortController();
  private readonly workdirs = new Set<string>();
  private readonly sessions = new HttpSessions();
  constructor(readonly target: Target, private readonly run: RunProcess = runDocker, private readonly resolveIP?: ResolveAddress, private readonly options: SandboxOptions = {}) {
    validateImage(options.image ?? IMAGE);
    if (options.runId !== undefined && !ID_PATTERN.test(options.runId)) throw new Error('Invalid run id for container labels');
  }

  private async docker(args: string[], options?: Parameters<RunProcess>[1]): Promise<ProcessResult> {
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
    this.shell = await this.create('bridge', [...HOST_ALIAS_ARGS, ...mount, '--entrypoint', '/bin/sh', this.options.image ?? IMAGE, '-c', 'exec sleep infinity']);
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

  async exec(command: string, seconds = 30, signal?: AbortSignal, workdir = '/work', onRunning?: () => void, maxSeconds = 60): Promise<ProcessResult> {
    if (![60, 300].includes(maxSeconds) || !command || command.length > 8192 || !Number.isInteger(seconds) || seconds < 1 || seconds > maxSeconds) throw new Error(`Command must be 1..8192 characters; timeout must be 1..${maxSeconds} seconds`);
    if (workdir !== '/work' && !/^\/work\/[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(workdir)) throw new Error('Invalid sandbox working directory');
    return this.enqueue(async () => {
      if (this.stopped || !this.shell) throw new Error('No active sandbox');
      const combined = AbortSignal.any([this.cancellation.signal, ...(signal ? [signal] : [])]);
      try {
        await this.ensureWorkdir(workdir, combined);
        onRunning?.();
        const result = await this.docker(['exec', '--workdir', workdir, this.shell, '/usr/bin/timeout', '--signal=KILL', `${seconds}s`, '/bin/sh', '-c', command], { timeoutMs: (seconds + 5) * 1000, signal: combined });
        if (result.code === 124 || result.code === 137) throw new Error('Sandbox command timed out; stopping the sandbox to remove background processes');
        return result;
      } catch (error) {
        // Killing the Docker CLI does not reap commands in the container. With network egress,
        // fail closed: cancel/timeout removes the shared executor, including background children.
        this.stopped = true; this.cancellation.abort();
        await this.removeAll();
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

  /** Fixed curl, actor-local sessions, and origin validation before every redirect hop. */
  async http(input: HttpRequest, signal?: AbortSignal, onRunning?: () => void, actor = 'owner'): Promise<ProcessResult> {
    const request = httpRequest(input);
    return this.enqueue(async () => {
      const hops: string[] = [];
      let current = request.url, method = request.method, body = request.body;
      let last: ProcessResult | undefined;
      let rejectedCookies = 0;
      const finish = (redirectStopped?: string): ProcessResult => ({ ...last!, hops, session: request.session,
        ...(redirectStopped ? { redirectStopped } : {}), ...(rejectedCookies ? { cookieWarning: 'Some cookies exceeded session limits or were invalid' } : {}) });
      for (let index = 0; ; index++) {
        if (this.stopped || !this.shell) throw new Error('No active sandbox');
        const combined = AbortSignal.any([this.cancellation.signal, ...(signal ? [signal] : [])]);
        combined.throwIfAborted();
        let destination: Awaited<ReturnType<typeof scopedRequest>>;
        try { destination = await scopedRequest(this.target, current, this.resolveIP); }
        catch (error) { if (last) return finish(error instanceof Error ? error.message : String(error)); throw error; }
        const { url, address, addressClass: kind, pin } = destination;
        combined.throwIfAborted();
        if (this.stopped) throw new Error('Cancelled');
        if (!index && request.resetSession) this.sessions.reset(actor, request.session, url);
        const headers = Object.entries(request.headers ?? {});
        const explicitCookie = headers.some(([name]) => name.toLowerCase() === 'cookie');
        const jar = explicitCookie ? undefined : this.sessions.header(actor, request.session, url);
        const args = ['-q', '--proxy', '', '--noproxy', '*', '--proto', '=http,https', '--max-time', '20', '--connect-timeout', '5',
          '--max-filesize', '8388608', '--max-redirs', '0', '--no-location', '--silent', '--show-error', '--include'];
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        if (pin) args.push('--resolve', url.hostname + ':' + port + ':' + (isIP(address) === 6 ? '[' + address + ']' : address));
        if (method === 'HEAD') args.push('--head');
        else args.push('--request', method); // A GET body must not implicitly become POST.
        if (jar) args.push('-H', 'Cookie: ' + jar);
        for (const [name, value] of headers) args.push('-H', name + ': ' + value);
        if (body !== undefined) args.push('--data-binary', '@-');
        args.push('--url', url.href);
        const name = await this.create('bridge', [...HOST_ALIAS_ARGS, ...(body === undefined ? [] : ['--interactive']),
          '--entrypoint', '/usr/bin/curl', this.options.image ?? IMAGE, ...args]);
        try {
          combined.throwIfAborted();
          if (this.stopped) throw new Error('Cancelled');
          onRunning?.();
          last = await this.docker(['start', '--attach', ...(body === undefined ? [] : ['--interactive']), name], {
            timeoutMs: 25_000, signal: combined, ...(body === undefined ? {} : { stdin: body }),
          });
        } finally { await this.remove(name); }
        const head = responseHead(last.stdout);
        hops.push((head.status ?? 'no-status') + ' ' + method + ' ' + url.href + ' → ' + (address || CONTAINER_HOST_ALIAS) + ' (' + kind + ')');
        if (last.code !== 0) return finish('Transport failed; no automatic retry or redirect');
        if (!head.complete) return finish('Response headers incomplete; cookies and redirects were not processed');
        rejectedCookies += this.sessions.store(actor, request.session, url, head.headers);
        const locations = head.headers.filter(([name]) => name === 'location').map(([, value]) => value);
        if (!head.status || !REDIRECT_STATUS.has(head.status) || !locations.length || !request.followRedirects) return finish();
        if (locations.length !== 1) return finish('Ambiguous Location headers; no redirect followed');
        if (index >= request.maxRedirects) return finish('Redirect limit reached');
        try {
          const next = new URL(locations[0], url.href); next.hash = '';
          current = next.href;
        } catch { return finish('Invalid redirect URL'); }
        if ((head.status === 303 && method !== 'HEAD') || ((head.status === 301 || head.status === 302) && method === 'POST')) {
          method = 'GET'; body = undefined;
        }
      }
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
    this.sessions.clear();
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
