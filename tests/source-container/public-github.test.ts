/** Opt-in LIVE HTTPS GitHub smoke; never substituted with the controlled loopback Git fixture. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { digestJson } from '../../src/contracts/index.js';
import { acquireApprovedSource } from '../../src/application/source-binding/index.js';
import { approvedRequest, hash, roots } from './fixtures.js';
const url = 'https://github.com/octocat/Hello-World';
const revision = '7fd1a60b01f91b314f59955a4e4b2d59b3d22937';
const consent = `${url}@${revision}`;
const optedIn = process.env.P2O_APPROVED_PUBLIC_GITHUB === consent;
if (process.env.P2O_APPROVED_PUBLIC_GITHUB && !optedIn) throw new Error(`Public GitHub smoke accepts ONLY explicitly approved fixture ${consent}`);
const content = 'Hello World!\n';
const digest = digestJson({ version: 1, entries: [{ p: 'README', s: Buffer.byteLength(content), h: hash(content) }] });
it.skipIf(!optedIn)('OPTIONAL LIVE github.com HTTPS clone; fixed public fixture; real Git, no scripts', async () => {
  const r = await roots();
  try {
    const approved = await approvedRequest({ root: r.root, origin: url, kind: 'github-repo', digest, revision, mode: 'assessment' });
    // Default real runner only: no transport rewrite, fake response, inherited Git config or model.
    const source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot, cloneTimeoutMs: 20000, bounds: { maxFiles: 16, maxFileBytes: 16 * 1024, maxTotalBytes: 64 * 1024, maxDepth: 8, maxPathChars: 256 } });
    expect(source.identity).toMatchObject({ kind: 'github-repo', origin: url, digest, revision });
    expect(source.seal.files).toBe(1); expect(await readFile(join(source.seal.root, 'README'), 'utf8')).toBe(content);
  } finally { await r.cleanup(); }
}, 30000);
