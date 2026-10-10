import { constants, closeSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const uid = () => process.getuid?.();
const leaf = (name: string) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(name) || name === '..') throw Error('Invalid state filename'); return name; };

/** Linux host-only FD containment. Target/model paths never enter this API. */
export class PrivateDirectory {
  private closed = false;
  private constructor(readonly fd: number, readonly displayPath: string) {
    const info = fstatSync(fd);
    if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o777) !== 0o700) throw Error('State directory must be owned by this user with mode 0700');
  }
  /** Walk every ancestor without symlinks, pinning each directory before the next lookup. */
  static open(path: string, create = false): PrivateDirectory {
    if (!isAbsolute(path) || path.includes('\0')) throw Error('State root must be an absolute host path');
    const parts = path.split('/').filter(Boolean);
    if (!parts.length || parts.some(p => p === '.' || p === '..')) throw Error('Invalid state root');
    let fd = openSync('/', directoryFlags);
    try {
      for (const [i, name] of parts.entries()) {
        const pinned = `/proc/self/fd/${fd}/${name}`;
        if (create && i === parts.length - 1) {
          try { mkdirSync(pinned, { mode: 0o700 }); fsyncSync(fd); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
        }
        const next = openSync(pinned, directoryFlags); closeSync(fd); fd = next;
      }
      const result = new PrivateDirectory(fd, path); fd = -1; return result;
    } finally { if (fd >= 0) closeSync(fd); }
  }
  path(name: string): string { if (this.closed) throw Error('State directory is closed'); return `/proc/self/fd/${this.fd}/${leaf(name)}`; }
  child(name: string, create = false): PrivateDirectory {
    const path = this.path(name);
    if (create) { mkdirSync(path, { mode: 0o700 }); fsyncSync(this.fd); }
    const fd = openSync(path, directoryFlags);
    try { return new PrivateDirectory(fd, join(this.displayPath, name)); }
    catch (error) { closeSync(fd); throw error; }
  }
  /** Existing files must be private regular single-link files; never follow devices/symlinks. */
  file(name: string): number {
    const fd = openSync(this.path(name), fileFlags);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== uid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw Error('State file must be private, regular and single-link');
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  createFile(name: string): void {
    const fd = openSync(this.path(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    fsyncSync(this.fd);
  }
  read(name: string, bound: number): Buffer {
    const fd = this.file(name);
    try {
      const info = fstatSync(fd);
      if (info.size > bound) throw Error('State file exceeds read bound');
      const buffer = Buffer.alloc(info.size); let offset = 0;
      while (offset < buffer.length) { const n = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!n) throw Error('State bytes missing'); offset += n; }
      if (fstatSync(fd).size !== info.size) throw Error('State file changed during read');
      return buffer;
    } finally { closeSync(fd); }
  }
  /** fsync bytes, publish without overwriting an existing ID, then fsync the directory. */
  publish(name: string, bytes: Buffer): void {
    const temp = `tmp-${randomUUID()}`;
    const fd = openSync(this.path(temp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } catch (error) { try { unlinkSync(this.path(temp)); } catch { /* No pointer is published. */ } throw error; }
    finally { closeSync(fd); }
    try { linkSync(this.path(temp), this.path(name)); }
    finally { unlinkSync(this.path(temp)); }
    fsyncSync(this.fd);
  }
  usage(): { bytes: number; files: number } {
    const names = readdirSync(`/proc/self/fd/${this.fd}`);
    if (names.length > 4096) throw Error('State file count exceeds 4096');
    let bytes = 0;
    for (const name of names) {
      const fd = this.file(name); try { bytes += fstatSync(fd).size; } finally { closeSync(fd); }
    }
    return { bytes, files: names.length };
  }
  close(): void { if (!this.closed) { this.closed = true; closeSync(this.fd); } }
}
