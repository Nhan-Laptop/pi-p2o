import { createHash, randomUUID } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { copySource } from './source.js';
import { abortable, checked, runDocker, type RunProcess, type ProcessResult, type OutputObserver } from './process.js';
import { isIP } from 'node:net';
import { hasSource, httpRequest, scopedRequest, taskTimeout, CONTAINER_HOST_ALIAS, type HttpRequest, type ResolveAddress, type Target } from './target.js';
import { HttpSessions, responseHead } from './http-session.js';
import { sha256Hex } from './validate.js';
import { SCRATCH_READER, SCRATCH_PROTOCOL_BYTES, SCRATCH_WRITER, SCRATCH_WRITE_MAX_BYTES, parseScratchWrite, scratchPath, scratchRoot, scratchBound, scratchOffset, parseScratchSnapshot, type ScratchSnapshot, type ScratchWrite } from './scratch.js';

// Fixed content digest, not a mutable tag or a model-selected image. No automatic image pull.
export const IMAGE = 'ghcr.io/usestrix/strix-sandbox@sha256:f6906c3114e504fd1a218fcf028d7a0e46851118403a438b63956de6ea7c4331';
// 2026-10-25 (planning_update.md Part XI): the operator asked for a real shell, so the container runs as root with a
// writable rootfs, every capability and no pids/memory/cpu limit. The container is the only blast radius: no host path
// is mounted and the Docker socket is never exposed.
const LIMITS = (_options: SandboxOptions) => ['--log-driver', 'none', '--workdir', '/work', '--user', 'root',
  '--env', 'HOME=/root', '--env', 'TMPDIR=/tmp',
  '--env', 'SEMGREP_ENABLE_VERSION_CHECK=0', '--env', 'SEMGREP_SEND_METRICS=off'];

/** The container may reach the host's published ports under this alias; it is not the host's loopback. */
const HOST_ALIAS_ARGS = ['--add-host', `${CONTAINER_HOST_ALIAS}:host-gateway`];
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Optional sizing/labelling. Delegated runs get more scratch and a run label for verified sweeps. */
export interface SandboxOptions { tmpBytes?: string; workBytes?: string; runId?: string; image?: string; sourceExcludePaths?: readonly string[] }
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
  private readonly provisioned = new Set<string>();
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
    if (hasSource(this.target) && await realpath(this.target.path) !== this.target.path) throw new Error('Target directory changed during confirmation');
    if (hasSource(this.target)) {
      const source = await copySource(this.target.path, this.options.sourceExcludePaths);
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

  /**
   * Provision the assignment scratch once, before an executor is published. A failure here is a provisioning
   * failure, not a command failure: the caller removes the sandbox and never starts a worker against it.
   */
  async provision(assignment: string): Promise<void> {
    if (!ID_PATTERN.test(assignment)) throw new Error('Invalid assignment id for executor scratch');
    const workdir = `/work/${assignment}`;
    return this.enqueue(async () => {
      if (this.stopped || !this.shell) throw new Error('No active sandbox');
      if (this.provisioned.has(workdir)) return;
      const combined = this.cancellation.signal;
      await this.ensureWorkdir(workdir, combined);
      const writable = await this.docker(['exec', '--workdir', workdir, this.shell, '/bin/sh', '-c', 'test -w .'], { timeoutMs: 15_000, signal: combined });
      if (writable.code !== 0) throw new Error(`Executor scratch ${workdir} is not writable`);
      this.provisioned.add(workdir);
    });
  }

  /** Serialize shell, HTTP and close; cleanup cannot race container creation. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => {});
    return next;
  }

  async exec(command: string, seconds = 0, signal?: AbortSignal, workdir = '/work', onRunning?: () => void, onOutput?: OutputObserver): Promise<ProcessResult> {
    if (typeof command !== 'string' || !command.trim() || command.length > 8192) throw new Error('Command must be 1..8192 characters');
    taskTimeout(seconds);
    if (workdir !== '/work' && !/^\/work\/[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(workdir)) throw new Error('Invalid sandbox working directory');
    return this.enqueue(async () => {
      if (this.stopped || !this.shell) throw new Error('No active sandbox');
      const combined = AbortSignal.any([this.cancellation.signal, ...(signal ? [signal] : [])]);
      // Provisioning is not a target command: a permission failure here must not retire the executor. The pool
      // calls provision() before publishing a lease; a later failure leaves the sandbox alive for cleanup.
      await this.ensureWorkdir(workdir, combined);
      onRunning?.();
      try {
        const deadline = seconds ? ['/usr/bin/timeout', '--signal=KILL', `${seconds}s`] : [];
        const result = await this.docker(['exec', '--workdir', workdir, this.shell, ...deadline, '/bin/sh', '-c', command], { timeoutMs: null, signal: combined, onOutput });
        if (seconds && (result.code === 124 || result.code === 137)) throw new Error('Opt-in sandbox command timed out; stopping the sandbox to remove background processes');
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

  /** Fixed FD-walking text reader in assigned scratch. Never docker-cp to a host/model path. */
  async captureScratch(path: string, maxBytes: number, signal?: AbortSignal, workdir = '/work', onRunning?: () => void, onOutput?: OutputObserver, seconds = 0, offsetBytes = 0): Promise<ProcessResult & {scratchSnapshot:ScratchSnapshot;previewLimit:number}> {
    const relative = scratchPath(path), root = scratchRoot(workdir), bound = scratchBound(maxBytes), offset = scratchOffset(offsetBytes); taskTimeout(seconds);
    return this.enqueue(async () => {
      if (this.stopped || !this.shell) throw Error('No active sandbox');
      const combined = AbortSignal.any([this.cancellation.signal, ...(signal ? [signal] : [])]);
      const metadata = Buffer.alloc(SCRATCH_PROTOCOL_BYTES), hash = createHash('sha256');
      let used = 0, observed = 0, denialFrame = false, readerCode: number | undefined, readerBytes = 0;
      await this.ensureWorkdir(root,combined); combined.throwIfAborted();
      onRunning?.();
      try {
        const deadline = seconds ? ['/usr/bin/timeout','--signal=KILL',`${seconds}s`] : [];
        const result = await this.docker(['exec','--workdir',root,this.shell,...deadline,'/usr/bin/python3','-I','-S','-c',SCRATCH_READER,JSON.stringify({root,path:relative,maxBytes:bound,offset})], {
          timeoutMs:null,signal:combined,onOutput:(stream,bytes)=>{
            if (stream === 'stderr') {
              if (used + bytes.length > metadata.length) throw Error('Scratch metadata frame exceeds bound');
              bytes.copy(metadata,used); used += bytes.length;
            } else {
              if (observed + bytes.length > bound) throw Error('Scratch body exceeds configured capture bound');
              observed += bytes.length;hash.update(bytes);onOutput?.('stdout',bytes);
            }
          },
        });
        readerCode = result.code; readerBytes = Buffer.byteLength(result.stdout);
        if (seconds && [124,137].includes(result.code)) throw Error('Opt-in scratch capture timed out; stopping the sandbox');
        try {denialFrame = (JSON.parse(metadata.subarray(0,used).toString('utf8')) as {ok?:unknown})?.ok === false;} catch { /* not a denial frame */ }
        const scratchSnapshot = parseScratchSnapshot(metadata.subarray(0,used),{path:relative,root,maxBytes:bound,offset,observedBytes:observed,sha256:hash.digest('hex')});
        if (result.code !== 0) throw Error(`Scratch reader returned ${result.code}; captured tail/operation uncertain, no retry`);
        const preview = Buffer.from(result.stdout).subarray(0,8192).toString('utf8'); // Replaced by the redacted retained prefix before returning.
        return {...result,stdout:preview,stderr:'',scratchSnapshot,previewLimit:8192,truncated:result.truncated || readerBytes>8192}; // Bound JSON escaping plus metadata to broker frame; no raw buffers.
      } catch(error) {
        // A completed, authenticated denial frame is a safe refusal. Transport/cancel/protocol faults may
        // still have a helper running: retire the executor and never silently rerun the read.
        const denial = denialFrame && readerCode === 78 && observed === 0 && /^Scratch capture denied \(/.test(error instanceof Error ? error.message : '');
        if (!denial) {
          this.stopped = true; this.cancellation.abort(); await this.removeAll();
        }
        throw error;
      } finally {metadata.fill(0);}
    });
  }

  /**
   * planning_update.md P14.7: put bounded package bytes into assigned scratch so a worker can run a shipped harness.
   * The writer is a fixed script, the destination is a relative path inside the caller's own scratch, and the bytes it
   * reports are the ones it re-read from disk — the host refuses a mismatch instead of trusting the write.
   */
  async writeScratch(path: string, bytes: Buffer, signal?: AbortSignal, workdir = '/work', mode = 0o500): Promise<ScratchWrite> {
    const relative = scratchPath(path), root = scratchRoot(workdir);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > SCRATCH_WRITE_MAX_BYTES) throw Error('Materialized bytes must be 1..64 KiB');
    return this.enqueue(async () => {
      if (this.stopped || !this.shell) throw Error('No active sandbox');
      const combined = AbortSignal.any([this.cancellation.signal, ...(signal ? [signal] : [])]);
      await this.ensureWorkdir(root, combined); combined.throwIfAborted();
      try {
        const result = await this.docker(['exec', '--workdir', root, this.shell!, '/usr/bin/python3', '-I', '-S', '-c', SCRATCH_WRITER,
          JSON.stringify({ root, path: relative, base64: bytes.toString('base64'), mode })], { timeoutMs: 30_000, signal: combined });
        const expected = { path: relative, root, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
        const frame = parseScratchWrite(Buffer.from(result.stdout ?? '', 'utf8'), expected);
        if (result.code !== 0) throw Error(`Scratch writer returned ${result.code}; nothing is claimed to be materialized`);
        return frame;
      } catch (error) {
        // A transport fault may have left a partial file: retire the executor rather than leave ambiguous bytes to run.
        const denial = /^Scratch write denied \(/.test(error instanceof Error ? error.message : '');
        if (!denial) { this.stopped = true; this.cancellation.abort(); await this.removeAll(); }
        throw error;
      }
    });
  }

  /**
   * planning_update.md P14.8: fetch one curated source URL inside the sandbox. The URL is the corpus's, not the model's,
   * the body is bounded and https-only, and the caller gets a hash of exactly the bytes it may quote.
   */
  async fetchResearch(url: string, signal?: AbortSignal, workdir = '/work'): Promise<{ status: string; sha256: string; bytes: number; body: string; truncated: boolean }> {
    if (typeof url !== 'string' || !/^https:\/\/[^\s'"\\]{1,300}$/.test(url)) throw Error('Research URL must be an https URL the corpus cites');
    return this.enqueue(async () => {
      if (this.stopped || !this.shell) throw Error('No active sandbox');
      const combined = AbortSignal.any([this.cancellation.signal, ...(signal ? [signal] : [])]);
      await this.ensureWorkdir(scratchRoot(workdir), combined); combined.throwIfAborted();
      const command = `/usr/bin/curl -sS -L --proto =https --proto-redir =https --max-time 20 --max-filesize ${32 * 1024}`
        + ` -A p2o-research/1 --write-out '\n__P2O_STATUS__%{http_code}' '${url}'`;
      const result = await this.docker(['exec', '--workdir', scratchRoot(workdir), this.shell!, '/bin/sh', '-c', command], { timeoutMs: 60_000, signal: combined });
      if (result.code === 63) return { status: 'too-large', sha256: sha256Hex(''), bytes: 0, body: '', truncated: true };
      if (result.code !== 0) throw Error(`Research fetch failed (curl exit ${result.code}); nothing was quoted`);
      const marker = result.stdout.lastIndexOf('\n__P2O_STATUS__');
      const body = marker < 0 ? result.stdout : result.stdout.slice(0, marker);
      const status = marker < 0 ? 'unknown' : result.stdout.slice(marker + '\n__P2O_STATUS__'.length).trim();
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > 32 * 1024) throw Error('Research fetch returned more than the configured bound');
      return { status: /^\d{3}$/.test(status) ? status : 'unknown', sha256: sha256Hex(body), bytes, body, truncated: result.truncated === true };
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

  /** Fixed curl and actor-local sessions; any http(s) destination and any redirect hop are allowed (Part XI). */
  async http(input: HttpRequest, signal?: AbortSignal, onRunning?: () => void, actor = 'owner', onOutput?: OutputObserver): Promise<ProcessResult> {
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
        try { destination = await abortable(scopedRequest(this.target, current, this.resolveIP),combined); }
        catch (error) { if (last) return finish(error instanceof Error ? error.message : String(error)); throw error; }
        const { url, address, addressClass: kind, pin } = destination;
        combined.throwIfAborted();
        if (this.stopped) throw new Error('Cancelled');
        if (!index && request.resetSession) this.sessions.reset(actor, request.session, url);
        const headers = Object.entries(request.headers ?? {});
        const explicitCookie = headers.some(([name]) => name.toLowerCase() === 'cookie');
        const jar = explicitCookie ? undefined : this.sessions.header(actor, request.session, url);
        const args = ['-q', '--proxy', '', '--noproxy', '*', '--proto', '=http,https', '--max-time', String(request.timeout), '--connect-timeout', String(request.connectTimeout),
          '--max-redirs', '0', '--no-location', '--silent', '--show-error', '--include'];
        // Part XI: no response-size cap; the model asked for the body and gets it.
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
            timeoutMs: null, signal: combined, onOutput, ...(body === undefined ? {} : { stdin: body }),
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
