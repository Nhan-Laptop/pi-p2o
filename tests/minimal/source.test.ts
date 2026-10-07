import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copySource } from '../../src/source.js';

it('copies only regular source files, not external symlinks, host sockets or dependency trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-source-test-'));
  const server = createServer(); let copied: string | undefined;
  try {
    await writeFile(join(root, 'source.txt'), 'original');
    await symlink('/etc/passwd', join(root, 'outside-link'));
    await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules/ignored'), 'ignored');
    await new Promise<void>(resolve => server.listen(join(root, 'service.sock'), resolve));
    const result = await copySource(root); copied = result.path;
    expect(result.skipped).toBe(3); expect(await readdir(copied)).toEqual(['source.txt']);
    await writeFile(join(root, 'source.txt'), 'changed');
    expect(await readFile(join(copied, 'source.txt'), 'utf8')).toBe('original');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (copied) await rm(copied, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

it('hashes special object-key filenames without losing manifest entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-source-manifest-'));
  let copy: string | undefined;
  try {
    await writeFile(join(root, '__proto__'), 'owned source bytes');
    const result = await copySource(root); copy = result.path;
    expect(Object.keys(result.manifest)).toEqual(['__proto__']);
    expect(result.manifest.__proto__).toBe(createHash('sha256').update('owned source bytes').digest('hex'));
  } finally { if (copy) await rm(copy, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

it('refuses an oversized source without leaving a partial copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-source-large-'));
  try {
    const { open } = await import('node:fs/promises');
    const file = await open(join(root, 'large'), 'w'); await file.truncate(65 * 1024 * 1024); await file.close();
    await expect(copySource(root)).rejects.toThrow('64 MiB');
  } finally { await rm(root, { recursive: true, force: true }); }
});
