import { constants } from 'node:fs';
import { chmod, mkdtemp, mkdir, open, opendir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

/** Linux directory-FD traversal: no symlinks, sockets, FIFOs or devices can become sandbox mounts. */
export async function copySource(path: string): Promise<{ path: string; skipped: number; manifest: Record<string, string> }> {
  const destination = await mkdtemp(join(tmpdir(), 'p2o-source-'));
  let bytes = 0; let entries = 0; let skipped = 0;
  const manifest: Record<string, string> = Object.create(null);
  const root = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(async error => {
    await rm(destination, { recursive: true, force: true }); throw error;
  });
  const visit = async (fd: number, output: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error('Source exceeds maximum directory depth (64)');
    for await (const entry of await opendir(`/proc/self/fd/${fd}`)) {
      if (++entries > MAX_ENTRIES) throw new Error('Source exceeds maximum entries (20000)');
      if (['.git', 'node_modules'].includes(entry.name)) { skipped++; continue; }
      const input = `/proc/self/fd/${fd}/${entry.name}`;
      const dest = join(output, entry.name);
      if (entry.isDirectory()) {
        const directory = await open(input, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await mkdir(dest, { mode: 0o755 }); await visit(directory.fd, dest, depth + 1); }
        finally { await directory.close(); }
      } else if (entry.isFile()) {
        const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const metadata = await file.stat();
          if (!metadata.isFile()) throw new Error('Source file changed type during copying');
          if (metadata.size + bytes > MAX_BYTES) throw new Error('Source exceeds maximum copied bytes (64 MiB)');
          const copy = await open(dest, 'wx', 0o444);
          const hash = createHash('sha256');
          try {
            const buffer = Buffer.alloc(64 * 1024);
            for (;;) {
              const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
              if (!bytesRead) break;
              bytes += bytesRead;
              hash.update(buffer.subarray(0, bytesRead));
              if (bytes > MAX_BYTES) throw new Error('Source exceeds maximum copied bytes (64 MiB)');
              let offset = 0;
              while (offset < bytesRead) offset += (await copy.write(buffer, offset, bytesRead - offset)).bytesWritten;
            }
            manifest[relative(destination, dest)] = hash.digest('hex');
          } finally { await copy.close(); }
        } finally { await file.close(); }
      } else { skipped++; }
    }
  };
  try {
    await visit(root.fd, destination, 0); await chmod(destination, 0o755);
    return { path: destination, skipped, manifest };
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
  finally { await root.close(); }
}
