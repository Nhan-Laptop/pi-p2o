/**
 * Bounded GitHub clone hardening.
 *
 * The clone runs only after human approval, only over HTTPS to `github.com`, only into a fresh private
 * directory, and with every environment variable the entry workflow controls pinned: no terminal prompt, no
 * credential helper, no system/global git config, no template/hook directory, and only the HTTPS transport
 * protocol. The argv is an array (never a shell string), the URL is validated before spawn, and the resolved
 * commit is recorded as the immutable revision. Nothing inside the clone is installed, built or executed.
 */
import { chmod, lstat, mkdir, opendir, rename } from 'node:fs/promises';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { entryFail, errorDetail, safeText } from './errors.js';
import { assertNoSymlinkComponents, assertSnapshotSeal, createReadOnlySnapshot, ensurePrivateSourceDirectory, fingerprintTree, removePrivateSourceTree, sealSnapshot, validateEntryBounds, type EntrySnapshotSeal } from './snapshot.js';
import { normalizeGitHubRepo } from './targets.js';
import type { EntryBounds, EntryCommandResult, EntryCommandRunner, EntryObserver } from './types.js';

const CLONE_TIMEOUT_MS = 10 * 60_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const REVISION_PATTERN = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const CREDENTIAL_IN_OUTPUT = [
  /https?:\/\/[^\s/@]+:[^\s/@]+@/gi,
  /(?:authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi,
  /\b(?:password|passwd|token|secret|api[-_]?key)=[^\s&;]+/gi,
];

function sanitizeOutput(value: string, max = 400): string {
  let text = safeText(value, 4096);
  for (const pattern of CREDENTIAL_IN_OUTPUT) text = text.replace(pattern, '[redacted]');
  return safeText(text, max);
}

/** Default bounded runner: argv array, no shell, sanitized output, hard timeout. */
export function createProcessRunner(): EntryCommandRunner {
  return {
    async run(input): Promise<EntryCommandResult> {
      if (input.signal?.aborted) throw new Error('command was cancelled');
      return await new Promise<EntryCommandResult>((resolvePromise, reject) => {
        const child = spawn(input.file, input.args, { cwd: input.cwd, env: input.env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', bytes = 0, settled = false, failure: Error | undefined;
        const cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); };
        const stop = (error: Error): void => {
          failure ??= error;
          // git-remote-https is a child process; killing only the CLI leaves acquisition running.
          try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
        };
        const abort = () => stop(new Error('command was cancelled'));
        const timer = setTimeout(() => stop(new Error('command exceeded its time bound')), input.timeoutMs);
        const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
          bytes += chunk.byteLength;
          if (bytes > input.maxOutputBytes) { stop(new Error('command output exceeded its byte bound')); return; }
          if (stream === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
        };
        child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
        child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
        child.once('error', error => { if (!settled) { settled = true; cleanup(); reject(error); } });
        // Await closed pipes/process BEFORE returning a failure; cleanup never races a live Git CLI.
        child.once('close', code => { if (!settled) { settled = true; cleanup(); if (failure) reject(failure); else resolvePromise({ code: code ?? -1, stdout, stderr }); } });
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();
      });
    },
  };
}

export interface GitCloneInvocation {
  file: string;
  args: string[];
  /** Allowlisted environment: process env is never inherited wholesale. */
  env: Record<string, string>;
  cwd: string;
}

/**
 * Exact clone invocation for one allowlisted HTTPS GitHub repository. The destination is chosen by the
 * caller (never from the repository name) and the URL is validated before it can reach argv.
 */
export function buildGitCloneInvocation(input: {
  repoUrl: string;
  destination: string;
  privateRoot: string;
  hooksDir: string;
  templateDir: string;
  gitBinary?: string;
  pathEnv?: string;
}): GitCloneInvocation {
  const repo = normalizeGitHubRepo(input.repoUrl);
  if (repo.url !== input.repoUrl) entryFail('TARGET_DENIED', 'repository URL is not the canonical HTTPS GitHub form');
  const home = join(input.privateRoot, 'git-home');
  const file = input.gitBinary ?? 'git';
  return {
    file,
    args: [
      'clone',
      '--depth', '1',
      '--single-branch',
      '--no-tags',
      '--no-recurse-submodules',
      '--config', `core.hooksPath=${input.hooksDir}`,
      '--config', 'core.symlinks=true',
      '--config', 'credential.helper=',
      '--config', 'protocol.allow=never',
      '--config', 'protocol.https.allow=always',
      '--config', 'advice.detachedHead=false',
      '--',
      repo.url,
      input.destination,
    ],
    env: {
      PATH: input.pathEnv ?? sanitizedPath(),
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
      GIT_CONFIG_SYSTEM: join(home, 'gitconfig-system'),
      GIT_TEMPLATE_DIR: input.templateDir,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_PROTOCOL_FROM_USER: '0',
      // Command-scope configuration applies to clone AND subsequent reads. No inherited transport,
      // redirects, proxy, filters, credential helper, hooks, templates or include files.
      GIT_CONFIG_COUNT: '10',
      GIT_CONFIG_KEY_0: 'http.followRedirects', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'http.sslVerify', GIT_CONFIG_VALUE_1: 'true',
      GIT_CONFIG_KEY_2: 'http.proxy', GIT_CONFIG_VALUE_2: '',
      GIT_CONFIG_KEY_3: 'http.extraHeader', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'credential.helper', GIT_CONFIG_VALUE_4: '',
      GIT_CONFIG_KEY_5: 'core.hooksPath', GIT_CONFIG_VALUE_5: input.hooksDir,
      GIT_CONFIG_KEY_6: 'protocol.allow', GIT_CONFIG_VALUE_6: 'never',
      GIT_CONFIG_KEY_7: 'protocol.https.allow', GIT_CONFIG_VALUE_7: 'always',
      GIT_CONFIG_KEY_8: 'submodule.recurse', GIT_CONFIG_VALUE_8: 'false',
      GIT_CONFIG_KEY_9: 'http.lowSpeedTime', GIT_CONFIG_VALUE_9: '30',
      LC_ALL: 'C',
      LANG: 'C',
    },
    cwd: input.privateRoot,
  };
}

async function runGit(input: {
  runner: EntryCommandRunner;
  invocation: GitCloneInvocation;
  signal?: AbortSignal;
  observer?: EntryObserver;
}): Promise<EntryCommandResult> {
  input.observer?.io?.({ kind: 'spawn', locator: input.invocation.file });
  try {
    return await input.runner.run({
      file: input.invocation.file,
      args: [...input.invocation.args],
      env: { ...input.invocation.env },
      cwd: input.invocation.cwd,
      timeoutMs: CLONE_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    entryFail('REPO_CLONE_FAILED', `git could not run: ${errorDetail(error, 200)}`);
  }
}

export interface CloneResult {
  /** Resolved immutable commit (40 or 64 hex characters). */
  revision: string;
  destination: string;
}

const verifiedClones = new Map<string, { revision: string; seal: EntrySnapshotSeal }>();
/** Controller-only proof that a commit-labelled acquisition came from this hardened clone, not prose. */
export async function assertClonedSourceSnapshot(root: string, revision: string, digest: string): Promise<void> {
  const observed = verifiedClones.get(root);
  if (!observed || observed.revision !== revision || observed.seal.digest !== digest) entryFail('ENTRY_SOURCE_UNBOUND', 'commit-labelled source has no matching hardened-clone attestation in this controller');
  await assertSnapshotSeal(observed.seal);
}

/**
 * Clone one owner-approved GitHub repository into `destination` and return the resolved commit. Bounded by
 * `bounds.maxFiles`/`bounds.maxTotalBytes` through the caller's walk; the clone directory itself is removed
 * on refusal so no partial view survives a failed bound check.
 */
export async function cloneGitHubRepoSafely(input: {
  repoUrl: string;
  destination: string;
  privateRoot: string;
  runner: EntryCommandRunner;
  bounds: EntryBounds;
  gitBinary?: string;
  signal?: AbortSignal;
  /** Full immutable commit and/or bounded manifest digest from the approved owner scope. */
  expectedRevision?: string;
  expectedDigest?: string;
  containerReadable?: boolean;
  /** Narrower caller time bound; never exceeds the acquisition hard timeout. */
  timeoutMs?: number;
  observer?: EntryObserver;
  /** Injectable tree check; returns file/byte counts and refuses when the bounds are exceeded. */
  inspect?: (root: string) => Promise<{ files: number; bytes: number }>;
  /** Injectable revision reader for tests; defaults to `git -C <dir> rev-parse HEAD`. */
  revisionFor?: (invocation: GitCloneInvocation, destination: string) => Promise<string>;
}): Promise<CloneResult> {
  validateEntryBounds(input.bounds);
  if (resolve(input.destination) !== input.destination || resolve(input.privateRoot) !== input.privateRoot || input.destination === input.privateRoot || input.destination.startsWith(`${input.privateRoot}${sep}`) || input.privateRoot.startsWith(`${input.destination}${sep}`)) entryFail('TARGET_DENIED', 'clone destination and git control roots must be canonical, absolute and disjoint');
  if (input.expectedRevision !== undefined && !REVISION_PATTERN.test(input.expectedRevision)) entryFail('TARGET_DENIED', 'approved GitHub revision must be a full immutable commit, not a branch/tag/abbreviation');
  if (input.expectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedDigest)) entryFail('TARGET_DENIED', 'approved source digest must be SHA-256');
  await ensurePrivateSourceDirectory(input.privateRoot);
  await ensurePrivateSourceDirectory(dirname(input.destination));
  await assertNoSymlinkComponents(input.privateRoot);
  const hooksDir = join(input.privateRoot, 'git-hooks');
  const templateDir = join(input.privateRoot, 'git-template');
  const home = join(input.privateRoot, 'git-home');
  for (const path of [hooksDir, templateDir, home]) {
    await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    await assertNoSymlinkComponents(path);
    const dir = await opendir(path);
    for await (const _entry of dir) entryFail('TARGET_DENIED', 'git controls must be empty; never reuse hooks, templates or config');
    await chmod(path, 0o500);
  }
  if (await lstat(input.destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) entryFail('TARGET_DENIED', 'clone destination already exists; never reuse or overwrite it');
  const invocation = buildGitCloneInvocation({
    repoUrl: input.repoUrl, destination: input.destination, privateRoot: input.privateRoot, hooksDir, templateDir,
    ...(input.gitBinary ? { gitBinary: input.gitBinary } : {}),
  });
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const timeout = setTimeout(abort, Math.min(input.timeoutMs ?? CLONE_TIMEOUT_MS, CLONE_TIMEOUT_MS));
  // Bound the raw checkout + object database too; the filtered snapshot alone cannot bound a pack.
  const diskLimit = Math.min(1024 * 1024 * 1024, input.bounds.maxTotalBytes * 3 + 16 * 1024 * 1024);
  let diskFailure: unknown, checking = false;
  let pendingCheck: Promise<void> = Promise.resolve();
  const checkDisk = async () => {
    if (checking) return;
    checking = true;
    try { await assertCloneDiskBound(input.destination, diskLimit, input.bounds.maxFiles * 8 + 1024); }
    catch (error) { diskFailure = error; abort(); }
    finally { checking = false; }
  };
  const monitor = setInterval(() => { if (!checking) pendingCheck = checkDisk(); }, 50);
  const exported = join(dirname(input.destination), `.source-${randomUUID()}`);
  try {
    input.observer?.io?.({ kind: 'clone', locator: input.repoUrl });
    const cloned = await runGit({ runner: input.runner, invocation, signal: controller.signal, ...(input.observer ? { observer: input.observer } : {}) });
    clearInterval(monitor); await pendingCheck;
    if (diskFailure) throw diskFailure;
    if (cloned.code !== 0) entryFail('REPO_CLONE_FAILED', `git clone failed with exit ${cloned.code}: ${sanitizeOutput(cloned.stderr || cloned.stdout)}`);
    await assertCloneDiskBound(input.destination, diskLimit, input.bounds.maxFiles * 8 + 1024);
    const revision = input.revisionFor
      ? await input.revisionFor(invocation, input.destination)
      : await readRevision({ runner: input.runner, invocation, destination: input.destination, signal: controller.signal });
    if (!REVISION_PATTERN.test(revision)) entryFail('REPO_CLONE_FAILED', 'git returned an unexpected commit identity');
    if (input.expectedRevision !== undefined && revision !== input.expectedRevision) entryFail('SCOPE_DIGEST_MISMATCH', 'resolved commit differs from the approved immutable revision');
    // The real default check is mandatory even if a trusted test/inspection callback is supplied.
    const walked = await fingerprintTree({ root: input.destination, bounds: input.bounds, signal: controller.signal });
    if (input.expectedDigest !== undefined && walked.digest !== input.expectedDigest) entryFail('SCOPE_DIGEST_MISMATCH', 'cloned source differs from the approved manifest digest');
    if (input.inspect) {
      const counts = await input.inspect(input.destination);
      if (counts.files > input.bounds.maxFiles || counts.bytes > input.bounds.maxTotalBytes) entryFail('TARGET_TOO_LARGE', 'cloned repository exceeds the approved source bounds');
    }
    await createReadOnlySnapshot({ root: input.destination, destination: exported, bounds: input.bounds, expectedDigest: walked.digest, containerReadable: input.containerReadable, signal: controller.signal, observer: input.observer });
    if (input.expectedRevision || input.expectedDigest) {
      const afterRevision = input.revisionFor ? await input.revisionFor(invocation, input.destination) : await readRevision({ runner: input.runner, invocation, destination: input.destination, signal: controller.signal });
      if (afterRevision !== revision) entryFail('SCOPE_DIGEST_MISMATCH', 'resolved commit drifted during source export');
    }
    // Commit metadata, hooks and checkout state never enter the immutable source view.
    clearInterval(monitor);
    await removePrivateSourceTree(input.destination);
    await rename(exported, input.destination);
    const seal = await sealSnapshot({ root: input.destination, bounds: input.bounds, expectedDigest: walked.digest, containerReadable: input.containerReadable, signal: controller.signal });
    verifiedClones.set(input.destination, { revision, seal });
    return { revision, destination: input.destination };
  } catch (error) {
    clearInterval(monitor); await pendingCheck;
    await removePrivateSourceTree(input.destination).catch(() => undefined);
    await removePrivateSourceTree(exported).catch(() => undefined);
    if (diskFailure) throw diskFailure;
    throw error;
  } finally { clearInterval(monitor); clearTimeout(timeout); input.signal?.removeEventListener('abort', abort); }
}

/** Filesystem accounting only, including git objects. No reads/links/repository commands. */
async function assertCloneDiskBound(root: string, maxBytes: number, maxEntries: number): Promise<void> {
  let bytes = 0, entries = 0;
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info || info.isSymbolicLink()) return;
    if (++entries > maxEntries || (bytes += info.size) > maxBytes) entryFail('TARGET_TOO_LARGE', 'raw clone/object database exceeds its acquisition disk bound');
    if (info.isDirectory()) {
      const dir = await opendir(path);
      for await (const entry of dir) await visit(join(path, entry.name));
    }
  };
  await visit(root);
}

async function readRevision(input: {
  runner: EntryCommandRunner;
  invocation: GitCloneInvocation;
  destination: string;
  signal?: AbortSignal;
}): Promise<string> {
  const result = await runGit({
    runner: input.runner,
    invocation: {
      ...input.invocation,
      args: ['-C', input.destination, 'rev-parse', 'HEAD'],
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (result.code !== 0) entryFail('REPO_CLONE_FAILED', `could not resolve the cloned commit: ${sanitizeOutput(result.stderr)}`);
  const revision = result.stdout.trim().toLowerCase();
  if (!REVISION_PATTERN.test(revision)) entryFail('REPO_CLONE_FAILED', 'git returned an unexpected commit identity');
  return revision;
}

/** Join a private root and a caller-chosen relative destination, refusing traversal. */
export function privateDestination(privateRoot: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(segment) || segment === '.' || segment === '..') {
      entryFail('ENTRY_FAILED', 'private destination segments must be bounded identifiers');
    }
  }
  return join(privateRoot, ...segments);
}

/** PATH-only environment used by tests to prove process env is not inherited. */
export function sanitizedPath(): string {
  return (process.env.PATH ?? '/usr/bin:/bin').split(delimiter).slice(0, 32).join(delimiter);
}
