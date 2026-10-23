import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillLibrary } from '../../src/skills.js';
import { parseScratchWrite, SCRATCH_WRITER } from '../../src/scratch.js';
import { sha256Hex } from '../../src/validate.js';

/**
 * planning_update.md P14.7: a worker cannot read host paths, so a shipped harness reaches it as package bytes copied into
 * assigned scratch. The gate is a byte-level one — what the library hands over must hash-match the package file, and what
 * the sandbox wrote must hash-match what the library handed over, or nothing is claimed to be materialized.
 */
const root = resolve(import.meta.dirname, '../..');
const library = new SkillLibrary(root);

describe('materializing a skill script', () => {
  it('returns package bytes that hash-match the file on disk for every registered script', async () => {
    const catalog = await library.load();
    const scripts = catalog.documents.filter(document => /^skills\/[a-z0-9-]+\/scripts\/[A-Za-z0-9._-]+\.py$/.test(document.path));
    expect(scripts.length, 'the catalog registers at least one script').toBeGreaterThan(0);
    for (const document of scripts) {
      const artifact = await library.materialize(document.id);
      const onDisk = await readFile(join(root, document.path));
      expect(artifact.sha256, document.id).toBe(sha256Hex(onDisk));
      expect(artifact.bytes.equals(onDisk), `${document.id} bytes are the package bytes`).toBe(true);
      expect(artifact.path).toBe(document.path);
    }
  });

  it('registers every script the package ships, so a skill cannot point at a harness the worker cannot reach', async () => {
    const catalog = await library.load(), registered = new Set(catalog.documents.map(document => document.path));
    for (const document of catalog.documents.filter(entry => /^skills\/[a-z0-9-]+\/scripts\//.test(entry.path))) expect(registered.has(document.path)).toBe(true);
    const skills = catalog.skills.map(skill => skill.name);
    for (const skill of skills) {
      const scripts = catalog.documents.filter(entry => entry.path.startsWith(`skills/${skill}/scripts/`));
      for (const script of scripts) expect(script.id, `${skill} script ids stay owner-prefixed`).toMatch(new RegExp(`^${skill}:[a-z0-9-]+$`));
    }
  });

  it('refuses a document that is not a shipped script, and an unknown id', async () => {
    await expect(library.materialize('exploit-design')).rejects.toThrow(/Only a registered skill script/);
    await expect(library.materialize('shared:handoffs')).rejects.toThrow(/Only a registered skill script/);
    await expect(library.materialize('exploit-design:not-a-script')).rejects.toThrow(/Unknown document ID/);
  });

  it('refuses a catalog that tries to register a path outside the package', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'p2o-materialize-'));
    try {
      await mkdir(join(outside, 'skills'), { recursive: true });
      await writeFile(join(outside, 'skills/catalog.json'), JSON.stringify({ version: 1, skills: [],
        documents: [{ id: 'evil:escape', path: '../escape.py' }] }));
      await expect(new SkillLibrary(outside).load()).rejects.toThrow(/Invalid catalog document/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

describe('the scratch writer binding', () => {
  it('accepts only a frame that names the same path, root, length and hash, and fails closed on a mismatch', () => {
    const frame = { ok: true, path: 'skills/x.py', root: '/work/w1', bytes: 3, sha256: sha256Hex(Buffer.from('abc')), mode: 0o500 };
    const expected = { path: 'skills/x.py', root: '/work/w1', sha256: sha256Hex(Buffer.from('abc')), bytes: 3 };
    expect(parseScratchWrite(Buffer.from(JSON.stringify(frame)), expected)).toMatchObject({ path: 'skills/x.py', bytes: 3, mode: 0o500 });
    expect(() => parseScratchWrite(Buffer.from(JSON.stringify({ ...frame, sha256: sha256Hex(Buffer.from('abd')) })), expected)).toThrow(/hash-match/);
    expect(() => parseScratchWrite(Buffer.from(JSON.stringify({ ...frame, path: 'skills/y.py' })), expected)).toThrow(/identity\/byte\/hash mismatch/);
    expect(() => parseScratchWrite(Buffer.from(JSON.stringify({ ok: false, error: 'INVALID_PATH' })), expected)).toThrow(/Scratch write denied \(INVALID_PATH\)/);
    expect(() => parseScratchWrite(Buffer.alloc(0), expected)).toThrow(/missing\/oversized/);
  });

  it('writes, replaces and refuses traversal when the fixed writer runs, so the container side is real code', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'p2o-writer-'));
    const run = (payload: Record<string, unknown>) => spawnSync('python3', ['-I', '-S', '-c', SCRATCH_WRITER, JSON.stringify(payload)], { encoding: 'utf8' });
    const body = Buffer.from("#!/usr/bin/env python3\nprint('materialized')\n");
    try {
      const first = run({ root: scratch, path: 'skills/exploit-design-payload-replay.py', base64: body.toString('base64'), mode: 0o500 });
      expect(first.status, first.stdout + first.stderr).toBe(0);
      const frame = JSON.parse(first.stdout);
      expect(frame).toMatchObject({ ok: true, bytes: body.length, sha256: sha256Hex(body) });
      expect(await readFile(join(scratch, 'skills/exploit-design-payload-replay.py'))).toEqual(body);
      const second = run({ root: scratch, path: 'skills/exploit-design-payload-replay.py', base64: body.toString('base64'), mode: 0o500 });
      expect(second.status, 'a second materialization replaces the file instead of failing').toBe(0);
      const escape = run({ root: scratch, path: '../escape.py', base64: body.toString('base64'), mode: 0o500 });
      expect(escape.status).toBe(78);
      expect(JSON.parse(escape.stdout)).toEqual({ ok: false, error: 'INVALID_PATH' });
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
});
