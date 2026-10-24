import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeIdentity } from '../../src/runtime-digest.js';
import { ensurePrivateDirectory, extensionDigest, mintTicket, readTicket, workerName, type Ticket } from '../../src/ticket.js';
import { createServer } from 'node:net';

/**
 * Runtime identity covers the entry file plus the sibling src closure. These fixtures build tiny packages in a temporary directory;
 * none of them runs p2o code. (Plan W0: a change confined to src/ must change the identity, and a broken closure must fail closed.)
 */
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function pkg(layout: 'source' | 'dist' = 'source', files: Record<string, string> = { 'a.ts': 'export const a = 1;\n', 'b/c.ts': 'export const c = 2;\n' }) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-digest-')); roots.push(root);
  const base = layout === 'dist' ? join(root, 'dist') : root, ext = layout === 'dist' ? 'js' : 'ts';
  await mkdir(join(base, 'extensions/p2o'), { recursive: true }); await mkdir(join(base, 'src/b'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.8.7' }));
  const entry = join(base, `extensions/p2o/index.${ext}`);
  await writeFile(entry, 'export default () => {};\n');
  for (const [name, body] of Object.entries(files)) await writeFile(join(base, 'src', name.replace(/\.ts$/, `.${ext}`)), body);
  return { root, base, entry, ext };
}

describe('runtime closure digest', () => {
  it('changes when a file under src changes even though the entry file is byte-identical', async () => {
    const { base, entry, ext } = await pkg();
    const before = await runtimeIdentity(entry);
    await writeFile(join(base, `src/a.${ext}`), 'export const a = 2;\n'); // entry untouched
    const after = await runtimeIdentity(entry);
    expect(after.sha256).not.toBe(before.sha256);
    expect(extensionDigest('export default () => {};\n')).toBe(extensionDigest('export default () => {};\n')); // legacy entry-only digest cannot tell
  });

  it('is deterministic, independent of absolute path and mtime, and sensitive to adding, removing, renaming and version', async () => {
    const first = await pkg(), second = await pkg();
    const a = await runtimeIdentity(first.entry), b = await runtimeIdentity(second.entry);
    expect(a.sha256).toBe(b.sha256); expect(a).toMatchObject({ version: '9.8.7', files: 3 });
    await new Promise(resolve => setTimeout(resolve, 20)); await writeFile(join(second.base, 'src/a.ts'), 'export const a = 1;\n'); // same bytes, newer mtime
    expect((await runtimeIdentity(second.entry)).sha256).toBe(a.sha256);
    await writeFile(join(second.base, 'src/new.ts'), 'export const n = 0;\n');
    const added = (await runtimeIdentity(second.entry)).sha256; expect(added).not.toBe(a.sha256);
    await rm(join(second.base, 'src/new.ts')); await cp(join(second.base, 'src/a.ts'), join(second.base, 'src/a2.ts'));
    expect((await runtimeIdentity(second.entry)).sha256).not.toBe(a.sha256); // an extra file with identical bytes is still a different closure
    await writeFile(join(first.root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.8.8' }));
    expect((await runtimeIdentity(first.entry)).sha256).not.toBe(a.sha256);
  });

  it('ignores declaration files and non-executable files, and supports the dist layout without reading outside the package', async () => {
    const source = await pkg('source'), dist = await pkg('dist');
    await writeFile(join(dist.base, 'src/a.d.ts'), 'export declare const a: number;\n'); await writeFile(join(dist.base, 'src/a.js.map'), '{}');
    const before = await runtimeIdentity(dist.entry);
    await writeFile(join(dist.base, 'src/a.d.ts'), 'export declare const a: string;\n'); await writeFile(join(dist.base, 'src/notes.md'), 'x');
    expect(await runtimeIdentity(dist.entry)).toEqual(before);
    expect(before.files).toBe(3); expect((await runtimeIdentity(source.entry)).sha256).not.toBe(before.sha256); // different bytes/extensions, distinct identity
  });

  it('hashes a fixture entry that has no sibling src on its own', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-digest-')); roots.push(root);
    await mkdir(join(root, 'fixtures'), { recursive: true }); await writeFile(join(root, 'fixtures/owner.ts'), 'export default 1;\n');
    expect(await runtimeIdentity(join(root, 'fixtures/owner.ts'))).toMatchObject({ files: 1, version: '' });
  });

  it('fails closed instead of producing a partial or empty digest', async () => {
    const symlinked = await pkg(); await symlink(join(symlinked.base, 'src/a.ts'), join(symlinked.base, 'src/link.ts'));
    await expect(runtimeIdentity(symlinked.entry)).rejects.toThrow('RUNTIME_DIGEST_UNSAFE');
    const unreadable = await pkg(); await chmod(join(unreadable.base, 'src/a.ts'), 0o000);
    if (process.getuid?.() !== 0) await expect(runtimeIdentity(unreadable.entry)).rejects.toThrow();
    const noEntry = await pkg(); await rm(noEntry.entry);
    await expect(runtimeIdentity(noEntry.entry)).rejects.toThrow();
    const srcFile = await mkdtemp(join(tmpdir(), 'p2o-digest-')); roots.push(srcFile);
    await mkdir(join(srcFile, 'extensions/p2o'), { recursive: true }); await writeFile(join(srcFile, 'extensions/p2o/index.ts'), 'x'); await writeFile(join(srcFile, 'src'), 'not a directory');
    await expect(runtimeIdentity(join(srcFile, 'extensions/p2o/index.ts'))).rejects.toThrow('not a plain directory');
  });

  it('makes a ticket minted against the old closure fail the extension identity gate after a src-only change', async () => {
    const { base, entry, ext } = await pkg();
    const control = join(await mkdtemp(join(tmpdir(), 'p2o-digest-')), 'control'); roots.push(join(control, '..'));
    await ensurePrivateDirectory(control);
    const socket = join(control, 'owner.sock'), server = createServer(); await new Promise<void>(resolve => server.listen(socket, resolve));
    try {
      const old = await runtimeIdentity(entry);
      const ticket: Ticket = { version: 2, runId: 'run-digest', workerId: workerName('discovery'), paneId: 'pane', parentWorkerId: null, depth: 1, role: 'discovery',
        target: { kind: 'directory', label: '/fixture' }, image: 'img', socket, records: join(control, 'records.sqlite'), reports: join(control, 'reports'),
        lifetime: 'until-stopped', extension: { path: entry, sha256: old.sha256 }, token: 'a'.repeat(32) };
      const path = await mintTicket(control, ticket);
      const expectations = (sha256: string) => ({ image: 'img', extensionPath: entry, extensionSha: sha256 });
      await expect(readTicket(path, expectations(old.sha256))).resolves.toMatchObject({ role: 'discovery' });
      await writeFile(join(base, `src/a.${ext}`), 'export const a = 3;\n');
      await expect(readTicket(path, expectations((await runtimeIdentity(entry)).sha256))).rejects.toThrow('extension identity does not match the running code');
      await expect(readTicket(path, expectations(extensionDigest('export default () => {};\n')))).rejects.toThrow('extension identity'); // legacy entry-only digests are not accepted
    } finally { server.close(); }
  });
});
