import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkCancelled, invariant, PolicyError } from '../policy/errors.js';
import { identifier, integer, text } from '../policy/validation.js';
import type { ToolContext } from '../policy/types.js';
import type { Artifact, BinaryArtifact, PreflightReport, SourceFile } from './types.js';
import { sha256 } from './redaction.js';

export interface FilesystemOptions {
  inputRoot: string;
  outputRoot: string;
  /** Supervisor promises an immutable, trusted snapshot; not a worker-controlled live checkout. */
  trustedInputSnapshot: true;
  maxFileBytes?: number;
  maxArtifactBytes?: number;
  maxArtifacts?: number;
}
export function validateRelativePath(value: string): string {
  text(value, 'relative path', 4096);
  invariant(!isAbsolute(value) && !/[\\:%\u0000-\u001f]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..'), 'FILESYSTEM_DENIED', 'Path must be an unambiguous relative path');
  return value;
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}
/** Node cannot promise openat2-level protection against a malicious same-user ancestor race. */
async function noSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  let at: string = sep;
  for (const component of absolute.split(sep).filter(Boolean)) {
    at = join(at, component);
    const stat = await lstat(at);
    invariant(!stat.isSymbolicLink(), 'FILESYSTEM_DENIED', 'Symlink components are forbidden');
  }
}
export class SandboxFilesystem {
  readonly inputRoot: string;
  readonly outputRoot: string;
  readonly limits: Readonly<{ maxFileBytes: number; maxArtifactBytes: number; maxArtifacts: number }>;
  private inputIdentity?: { ino: number; dev: number };
  private outputIdentity?: { ino: number; dev: number };
  private ready = false;
  private artifactCount = 0;
  private artifactBytes = 0;
  private readonly trusted: boolean;
  constructor(options: FilesystemOptions) {
    invariant(isAbsolute(options.inputRoot) && isAbsolute(options.outputRoot), 'FILESYSTEM_DENIED', 'Roots must be absolute');
    this.inputRoot = resolve(options.inputRoot);
    this.outputRoot = resolve(options.outputRoot);
    this.trusted = options.trustedInputSnapshot === true;
    invariant(this.inputRoot !== this.outputRoot && !contained(this.inputRoot, this.outputRoot) && !contained(this.outputRoot, this.inputRoot), 'FILESYSTEM_DENIED', 'Input and output roots must be disjoint');
    for (const root of [this.inputRoot, this.outputRoot]) invariant(![sep, homedir(), '/proc', '/sys', '/dev', '/run', '/var/run'].some(p => root === p || (p !== sep && p !== homedir() && root.startsWith(`${p}/`))), 'FILESYSTEM_DENIED', 'Host/system roots cannot be mounted');
    this.limits = Object.freeze({ maxFileBytes: integer(options.maxFileBytes ?? 1048576, 'maxFileBytes', 1, 16777216), maxArtifactBytes: integer(options.maxArtifactBytes ?? 4194304, 'maxArtifactBytes', 1, 67108864), maxArtifacts: integer(options.maxArtifacts ?? 128, 'maxArtifacts', 1, 4096) });
  }
  async preflight(): Promise<PreflightReport> {
    try {
      invariant(this.trusted, 'FILESYSTEM_DENIED', 'Trusted immutable input snapshot is required');
      await noSymlinkComponents(this.inputRoot);
      await noSymlinkComponents(this.outputRoot);
      const input = await lstat(this.inputRoot), output = await lstat(this.outputRoot);
      invariant(input.isDirectory() && output.isDirectory(), 'FILESYSTEM_DENIED', 'Roots must already exist as directories');
      invariant((output.mode & 0o077) === 0 && (!process.getuid || output.uid === process.getuid()), 'FILESYSTEM_DENIED', 'Output root must be owner-only and supervisor-owned');
      invariant(await realpath(this.inputRoot) === this.inputRoot && await realpath(this.outputRoot) === this.outputRoot, 'FILESYSTEM_DENIED', 'Roots changed identity');
      this.inputIdentity = { ino: input.ino, dev: input.dev };
      this.outputIdentity = { ino: output.ino, dev: output.dev };
      this.ready = true;
      return Object.freeze({ ok: true, boundary: 'trusted-input/private-output-not-process-isolation', checks: [{ name: 'filesystem', ok: true, detail: 'Disjoint immutable input and owner-only output roots; no symlinks' }] });
    } catch {
      this.ready = false;
      return Object.freeze({ ok: false, boundary: 'filesystem-unavailable', checks: [{ name: 'filesystem', ok: false, detail: 'Roots unavailable, unsafe, untrusted or not private' }] });
    }
  }
  private async assertRoots(): Promise<void> {
    invariant(this.ready, 'UNAVAILABLE', 'Filesystem has not passed preflight');
    await noSymlinkComponents(this.inputRoot); await noSymlinkComponents(this.outputRoot);
    const i = await lstat(this.inputRoot), o = await lstat(this.outputRoot);
    invariant(i.ino === this.inputIdentity?.ino && i.dev === this.inputIdentity.dev && o.ino === this.outputIdentity?.ino && o.dev === this.outputIdentity.dev && (o.mode & 0o077) === 0, 'FILESYSTEM_DENIED', 'Filesystem root identity changed');
  }
  async readInput(path: string, signal?: AbortSignal): Promise<SourceFile> {
    checkCancelled(signal); validateRelativePath(path); await this.assertRoots();
    const absolute = join(this.inputRoot, path);
    invariant(contained(this.inputRoot, absolute), 'FILESYSTEM_DENIED', 'Input path escapes root');
    try {
      await noSymlinkComponents(absolute);
      const before = await lstat(absolute);
      invariant(before.isFile() && before.nlink === 1 && before.size <= this.limits.maxFileBytes, 'FILESYSTEM_DENIED', 'Input must be a bounded, non-linked regular file');
      const fd = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await fd.stat();
        invariant(stat.isFile() && stat.ino === before.ino && stat.dev === before.dev && stat.nlink === 1 && stat.size <= this.limits.maxFileBytes, 'FILESYSTEM_DENIED', 'Input changed before open');
        const buffer = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          checkCancelled(signal);
          const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await fd.stat();
        await noSymlinkComponents(absolute);
        const pathAfter = await lstat(absolute);
        invariant(offset === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs && pathAfter.ino === stat.ino && pathAfter.dev === stat.dev, 'FILESYSTEM_DENIED', 'Immutable input changed during read');
        checkCancelled(signal);
        const raw = buffer.subarray(0, offset);
        return { path, text: raw.toString('utf8'), sha256: sha256(raw) };
      } finally { await fd.close(); }
    } catch (e) {
      if (e instanceof PolicyError) throw e;
      throw new PolicyError('FILESYSTEM_DENIED', 'Input unavailable or unsafe');
    }
  }
  private async writeBlob(context: ToolContext, payload: string | Buffer, mediaType: Artifact['mediaType'] | BinaryArtifact['mediaType'], extension: 'json' | 'png', signal?: AbortSignal): Promise<Artifact | BinaryArtifact> {
    checkCancelled(signal); await this.assertRoots();
    const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
    invariant(bytes <= this.limits.maxArtifactBytes && this.artifactBytes + bytes <= this.limits.maxArtifactBytes && this.artifactCount < this.limits.maxArtifacts, 'OUTPUT_LIMIT', 'Private artifact count/byte limit exceeded');
    // Reserve before async filesystem operations so parallel workers cannot race limits.
    this.artifactBytes += bytes; this.artifactCount += 1;
    const ordinal = this.artifactCount;
    const names = [context.runId, context.taskId, context.attemptId].map(v => identifier(v, 'output identity'));
    let directory = this.outputRoot;
    for (const name of names) {
      directory = join(directory, name);
      try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new PolicyError('FILESYSTEM_DENIED', 'Cannot provision private output'); }
      await noSymlinkComponents(directory);
      const s = await lstat(directory);
      invariant(s.isDirectory() && (s.mode & 0o077) === 0 && (!process.getuid || s.uid === process.getuid()), 'FILESYSTEM_DENIED', 'Task output directory is not private');
    }
    const hash = sha256(typeof payload === 'string' ? payload : Buffer.from(payload));
    const name = `${ordinal.toString().padStart(6, '0')}-${hash}.${extension}`;
    const absolute = join(directory, name);
    checkCancelled(signal);
    let created = false;
    try {
      await noSymlinkComponents(dirname(absolute));
      const fd = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { if (typeof payload === 'string') await fd.writeFile(payload, 'utf8'); else await fd.writeFile(payload); await fd.sync(); } finally { await fd.close(); }
      await noSymlinkComponents(absolute); await this.assertRoots(); checkCancelled(signal);
      const path = [...names, basename(absolute)].join('/');
      return mediaType === 'application/json'
        ? Object.freeze({ path, sha256: hash, bytes, mediaType: 'application/json' as const, redacted: true as const })
        : Object.freeze({ path, sha256: hash, bytes, mediaType: 'image/png' as const, redacted: false as const });
    } catch (e) {
      if (created) await unlink(absolute).catch(() => {});
      if (e instanceof PolicyError) throw e;
      throw new PolicyError('FILESYSTEM_DENIED', 'Artifact publication failed');
    }
  }
  async writeArtifact(context: ToolContext, content: string, signal?: AbortSignal): Promise<Artifact> {
    return await this.writeBlob(context, content, 'application/json', 'json', signal) as Artifact;
  }
  /** Bounded binary evidence (browser screenshot bytes). Same private root, same count/byte limits. */
  async writeArtifactBytes(context: ToolContext, bytes: Buffer, signal?: AbortSignal): Promise<BinaryArtifact> {
    invariant(Buffer.isBuffer(bytes) && bytes.byteLength > 0, 'INVALID_INPUT', 'Binary artifact payload must be a non-empty buffer');
    return await this.writeBlob(context, bytes, 'image/png', 'png', signal) as BinaryArtifact;
  }
}
