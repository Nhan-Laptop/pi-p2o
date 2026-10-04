import { existsSync, renameSync, symlinkSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireApprovedSource, bindApprovedSourceContainer, entrySourceScopeDigest } from '../../src/application/source-binding/index.js';
import { assertSnapshotSeal, createReadOnlySnapshot, fingerprintTree } from '../../src/application/entry/snapshot.js';
import { ENTRY_BOUNDS_DEFAULTS } from '../../src/application/entry/types.js';
import { normalizeGitHubRepo } from '../../src/application/entry/targets.js';
import { approvedRequest, hash, roots } from './fixtures.js';

describe('real filesystem snapshots + real owner ledger (no container/model/network mocks)', () => {
  it('copies the exact approved canary, excludes secrets/symlink escape, never writes originals', async () => {
    const r = await roots();
    try {
      const canary = 'export const approvedCanary = "P2O_APPROVED_SOURCE_CANARY";\n';
      await mkdir(join(r.original, 'src'));
      await writeFile(join(r.original, 'src/canary.ts'), canary);
      await writeFile(join(r.original, '.env'), 'FIXTURE_SECRET=excluded\n');
      await writeFile(join(r.root, 'outside.txt'), 'OUTSIDE_MUST_NOT_ENTER_MOUNT');
      await symlink(join(r.root, 'outside.txt'), join(r.original, 'escape.ts'));
      await mkdir(join(r.original, '.git')); await writeFile(join(r.original, '.git/config'), 'fixture config');
      const before = await lstat(join(r.original, 'src/canary.ts'));
      const approved = await approvedRequest({ root: r.root, origin: r.original });
      const source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot });
      expect(source.identity.digest).toBe(approved.request.preparation.target.digest);
      expect(await readFile(join(source.seal.root, 'src/canary.ts'), 'utf8')).toBe(canary);
      for (const name of ['.env', '.git', 'escape.ts']) expect(existsSync(join(source.seal.root, name))).toBe(false);
      expect((await lstat(source.seal.root)).mode & 0o777).toBe(0o555);
      expect((await lstat(join(source.seal.root, 'src'))).mode & 0o777).toBe(0o555);
      expect((await lstat(join(source.seal.root, 'src/canary.ts'))).mode & 0o777).toBe(0o444);
      expect((await lstat(dirname(source.seal.root))).mode & 0o777).toBe(0o700);
      const after = await lstat(join(r.original, 'src/canary.ts'));
      expect([after.mode, after.mtimeMs, after.ctimeMs, after.ino]).toEqual([before.mode, before.mtimeMs, before.ctimeMs, before.ino]);
      // The bound immutable tree is the input, not the now-changed original owner path.
      await writeFile(join(r.original, 'src/canary.ts'), 'new unapproved original');
      await assertSnapshotSeal(source.seal);
      expect(hash(await readFile(join(source.seal.root, 'src/canary.ts')))).toBe(hash(canary));
    } finally { await r.cleanup(); }
  });
  it('refuses digest/scope drift and cleans refused snapshots without overwriting', async () => {
    const r = await roots();
    try {
      await writeFile(join(r.original, 'canary.ts'), 'approved');
      const approved = await approvedRequest({ root: r.root, origin: r.original });
      await writeFile(join(r.original, 'canary.ts'), 'swapped');
      await expect(acquireApprovedSource({ ...approved, privateRoot: r.privateRoot })).rejects.toMatchObject({ code: 'SCOPE_DIGEST_MISMATCH' });
      expect(await readdir(r.privateRoot)).toEqual([]);
      const request = structuredClone(approved.request); request.preparation.target.locator = '/tmp/unapproved';
      await expect(acquireApprovedSource({ ...approved, request, privateRoot: r.privateRoot })).rejects.toMatchObject({ code: 'SCOPE_DIGEST_MISMATCH' });
      await writeFile(join(r.original, 'canary.ts'), 'approved');
      await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot });
      await expect(acquireApprovedSource({ ...approved, privateRoot: r.privateRoot })).rejects.toMatchObject({ code: 'TARGET_DENIED' });
    } finally { await r.cleanup(); }
  });
  it('requires the real owner gate before any source reads/copies', async () => {
    const r = await roots();
    try {
      await writeFile(join(r.original, 'canary.ts'), 'approved');
      const approved = await approvedRequest({ root: r.root, origin: r.original });
      const document = JSON.parse(await readFile(approved.approvalPath, 'utf8')); document.proposalDigest = 'f'.repeat(64);
      await writeFile(approved.approvalPath, JSON.stringify(document));
      const events: string[] = [];
      await expect(acquireApprovedSource({ ...approved, privateRoot: r.privateRoot, observer: { io: e => events.push(e.kind) } })).rejects.toThrow(/owner-ledger gate refused/);
      expect(events).toEqual([]); expect(await readdir(r.privateRoot)).toEqual([]);
    } finally { await r.cleanup(); }
  });
  it('refuses file and ancestor symlink swaps during reading, never copies outside bytes', async () => {
    const r = await roots();
    try {
      await writeFile(join(r.original, 'canary.ts'), 'approved'); await writeFile(join(r.root, 'outside'), 'EXTERNAL_SECRET');
      const approved = await approvedRequest({ root: r.root, origin: r.original });
      let swapped = false;
      await expect(acquireApprovedSource({ ...approved, privateRoot: r.privateRoot, observer: { io(e) { if (e.kind === 'read' && e.locator.endsWith('canary.ts') && !swapped) { swapped = true; renameSync(e.locator, `${e.locator}.old`); symlinkSync(join(r.root, 'outside'), e.locator); } } } })).rejects.toThrow();
      expect(await readdir(r.privateRoot)).toEqual([]);
      const destinationLink = join(r.privateRoot, 'redirect'); await symlink(r.original, destinationLink);
      await expect(createReadOnlySnapshot({ root: r.original, destination: join(destinationLink, 'must-not-write'), bounds: ENTRY_BOUNDS_DEFAULTS })).rejects.toMatchObject({ code: 'TARGET_DENIED' });
      expect(existsSync(join(r.original, 'must-not-write'))).toBe(false);
      await expect(createReadOnlySnapshot({ root: '/', destination: join(r.privateRoot, 'root-must-not-copy'), bounds: ENTRY_BOUNDS_DEFAULTS })).rejects.toMatchObject({ code: 'TARGET_DENIED' });
      expect(existsSync(join(r.privateRoot, 'root-must-not-copy'))).toBe(false);
    } finally { await r.cleanup(); }
  });
  it('detects identical root replacement and injected links (not merely equal owner-root hashes)', async () => {
    const r = await roots();
    try {
      await writeFile(join(r.original, 'canary.ts'), 'approved');
      const approved = await approvedRequest({ root: r.root, origin: r.original });
      const source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot });
      await rename(source.seal.root, `${source.seal.root}.old`);
      await createReadOnlySnapshot({ root: r.original, destination: source.seal.root, bounds: source.seal.bounds, expectedDigest: source.identity.digest, containerReadable: true });
      expect((await fingerprintTree({ root: source.seal.root, bounds: source.seal.bounds })).digest).toBe(source.identity.digest);
      await expect(assertSnapshotSeal(source.seal)).rejects.toMatchObject({ code: 'SCOPE_DIGEST_MISMATCH' });
      await chmod(source.seal.root, 0o755); await symlink('/etc/passwd', join(source.seal.root, 'escape')); await chmod(source.seal.root, 0o555);
      await expect(assertSnapshotSeal(source.seal)).rejects.toMatchObject({ code: 'TARGET_DENIED' });
    } finally { await r.cleanup(); }
  });
  it('bounds bytes/file count/depth and rejects unpinned source/qualification rather than fallback', async () => {
    const r = await roots();
    try {
      await writeFile(join(r.original, 'canary.ts'), '123456789');
      await expect(fingerprintTree({ root: r.original, bounds: { ...ENTRY_BOUNDS_DEFAULTS, maxFileBytes: 4 } })).rejects.toMatchObject({ code: 'TARGET_TOO_LARGE' });
      const approved = await approvedRequest({ root: r.root, origin: r.original });
      const unpinned = structuredClone(approved.request); delete unpinned.preparation.target.digest; delete unpinned.run.authorization.targets[0]!.digest; unpinned.preparation.scopeDigest = entrySourceScopeDigest(unpinned.preparation); unpinned.approval.scopeDigest = unpinned.preparation.scopeDigest;
      await expect(acquireApprovedSource({ ...approved, request: unpinned, privateRoot: r.privateRoot })).rejects.toMatchObject({ code: 'ENTRY_SOURCE_UNBOUND' });
      const source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot });
      await expect(bindApprovedSourceContainer({ ...approved, source, qualified: { runner: async () => { throw new Error('never called'); }, fixtureAcknowledgement: 'inert-engine-fixture-not-container-isolation' } as never })).rejects.toMatchObject({ code: 'ENTRY_SOURCE_UNBOUND' });
      await expect(bindApprovedSourceContainer({ ...approved, source, qualified: {} as never })).rejects.toMatchObject({ code: 'ENTRY_SOURCE_UNBOUND' });
      await expect(bindApprovedSourceContainer({ ...approved, source: structuredClone(source), qualified: {} as never })).rejects.toMatchObject({ code: 'ENTRY_SOURCE_UNBOUND' });
    } finally { await r.cleanup(); }
  });
  it.each(['validFrom', 'expiresAt', 'deadlineAt'])('rejects invalid owner %s before any source I/O', async field => {
    const r = await roots();
    try {
      await writeFile(join(r.original, 'canary.ts'), 'approved');
      const approved = await approvedRequest({ root: r.root, origin: r.original });
      if (field === 'deadlineAt') approved.request.run.budgets.deadlineAt = 'invalid'; else approved.request.run.authorization[field as 'validFrom' | 'expiresAt'] = 'invalid';
      await expect(acquireApprovedSource({ ...approved, privateRoot: r.privateRoot })).rejects.toMatchObject({ code: 'ENTRY_APPROVAL_WINDOW' });
      expect(await readdir(r.privateRoot)).toEqual([]);
    } finally { await r.cleanup(); }
  });
  it('captures immutable owner request and destination before awaiting the real ledger gate', async () => {
    const r = await roots();
    try {
      await writeFile(join(r.original, 'canary.ts'), 'approved');
      const approved = await approvedRequest({ root: r.root, origin: r.original });
      const options = { ...approved, privateRoot: r.privateRoot, authorize: async (incoming: typeof approved.request) => {
        expect(Object.isFrozen(incoming.run.authorization)).toBe(true); await approved.authorize(incoming);
        approved.request.preparation.target.locator = '/UNAPPROVED_MUTATION'; options.privateRoot = r.original;
      } };
      const source = await acquireApprovedSource(options);
      expect(source.identity.origin).toBe(r.original); expect(source.seal.root.startsWith(`${r.privateRoot}/`)).toBe(true);
      expect(await readdir(r.original)).toEqual(['canary.ts']);
    } finally { await r.cleanup(); }
  });
  it.each(['http://github.com/a/b', 'https://www.github.com/a/b', 'https://github.com./a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a/b?ref=x', 'https://github.com/a/../b/c', 'https://github.com//a/b', 'https://github.com/a/b#main', 'https://github.com@evil.invalid/a/b', 'https://github.com/a/%62'])('rejects noncanonical/scoped clone URL %s', value => {
    expect(() => normalizeGitHubRepo(value)).toThrow();
  });
});
