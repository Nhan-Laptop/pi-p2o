import { constants } from 'node:fs';
import { chmod, mkdtemp, mkdir, open, opendir, rm, lstat } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
/** Owner export marker. Never mount a prior portable knowledge bundle as target source. */
export const PRIVATE_KNOWLEDGE_MARKER = '.p2o-knowledge-bundle';

/** Linux directory-FD traversal: no symlinks, sockets, FIFOs or devices can become sandbox mounts. */
export async function copySource(path: string, excludePaths: readonly string[] = []): Promise<{ path: string; skipped: number; manifest: Record<string, string> }> {
  if (excludePaths.some(p => typeof p !== 'string' || !isAbsolute(p) || p.includes('\0'))) throw Error('Source exclusions must be owner-selected absolute paths');
  const destination = await mkdtemp(join(tmpdir(), 'p2o-source-'));
  const excluded = [...excludePaths.map(p => resolve(p)), destination];
  let bytes = 0; let entries = 0; let skipped = 0;
  const manifest: Record<string, string> = Object.create(null);
  const root = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(async error => {
    await rm(destination, { recursive: true, force: true }); throw error;
  });
  const visit = async (fd: number, output: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error('Source exceeds maximum directory depth (64)');
    // Prior/custom stores and explicitly selected private roots must not become source mounts.
    const markers = await Promise.all(['assessment.sqlite','writer.lock'].map(name => lstat(`/proc/self/fd/${fd}/${name}`).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;})));
    const knowledgeBundle = await lstat(`/proc/self/fd/${fd}/${PRIVATE_KNOWLEDGE_MARKER}`).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
    // Prior v1 bundles predate the marker. Inspect only a bounded, pinned regular index, never code.
    let legacyBundle=false;
    if(!knowledgeBundle && !markers.every(Boolean)){
      const index=await open(`/proc/self/fd/${fd}/manifest.json`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(error=>{if(['ENOENT','ELOOP'].includes(error.code))return undefined;throw error;});
      if(index)try{const stat=await index.stat();if(stat.isFile()&&stat.size<=1024*1024){
        const buffer=Buffer.alloc(stat.size+1);let used=0;while(used<buffer.length){const read=await index.read(buffer,used,buffer.length-used,null);if(!read.bytesRead)break;used+=read.bytesRead;}
        if(used===stat.size)try{const value=JSON.parse(buffer.subarray(0,used).toString('utf8'));
          legacyBundle=Boolean(value&&[1,2].includes(value.version)&&value.redactionVersion===2&&value.authorityRestored===false&&typeof value.runId==='string'&&/^run-[a-zA-Z0-9-]{1,75}$/.test(value.runId)&&typeof value.bundleSha256==='string'&&/^[a-f0-9]{64}$/.test(value.bundleSha256)&&Array.isArray(value.files));
        }catch{ /* Ordinary source manifests are not private bundle indexes. */ }
        buffer.fill(0);
      }}finally{await index.close();}
    }
    const ancestry = join(path, relative(destination, output)).split('/');
    if (knowledgeBundle || legacyBundle || markers.every(Boolean) || ancestry.some(name => ['.p2o-state','.p2o-reports'].includes(name) || name.startsWith('.p2o-export-') || /^p2o-run-[a-zA-Z0-9]+$/.test(name))) { skipped++; return; }
    for await (const entry of await opendir(`/proc/self/fd/${fd}`)) {
      if (++entries > MAX_ENTRIES) throw new Error('Source exceeds maximum entries (20000)');
      const dest = join(output, entry.name), sourcePath = join(path, relative(destination, dest));
      if (['.git', 'node_modules', '.p2o-state', '.p2o-reports'].includes(entry.name)
        || excluded.some(root => sourcePath === root || sourcePath.startsWith(`${root}/`))) { skipped++; continue; }
      const input = `/proc/self/fd/${fd}/${entry.name}`;
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
