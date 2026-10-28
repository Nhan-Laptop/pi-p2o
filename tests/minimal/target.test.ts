import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyTarget, hasOrigin, hasSource, parseCommand, scopedRequest, targetLabel, webURL } from '../../src/target.js';

/**
 * planning_update.md Part XI (S2/S6): one owner role (no `--solo`) and no scope enforcement. The target is a starting
 * label, not a boundary: only the URL grammar and the transport still validate anything.
 */
describe('one target grammar', () => {
  it('has only help, stop, pause, resume and a target', () => {
    expect(parseCommand('')).toEqual({ action: 'help' });
    expect(parseCommand('stop')).toEqual({ action: 'stop' });
    expect(parseCommand('pause')).toEqual({ action: 'pause' });
    expect(parseCommand('resume')).toEqual({ action: 'resume' });
    expect(parseCommand('--target "./my repo"')).toEqual({ action: 'start', target: './my repo', options: {} });
    expect(parseCommand("--target './my repo'")).toEqual({ action: 'start', target: './my repo', options: {} });
    expect(parseCommand('--target https://example.com')).toEqual({ action: 'start', target: 'https://example.com', options: {} });
    expect(parseCommand('--resume run-1234abcd')).toEqual({ action: 'start', resume: 'run-1234abcd', options: {} });
    for (const args of ['--resume', '--resume ../run-x', '--resume run-abc --workers 2', '--target x --resume run-abc'])
      expect(() => parseCommand(args), args).toThrow();
    for (const args of ['--target', '--target x --headless', '--target x --target y', '--target x;y extra', 'approve plan-1', 'resume extra', '--target "unterminated', '--target --help', '--target x --solo'])
      expect(() => parseCommand(args), args).toThrow();
  });

  it('takes one optional quoted operator objective and refuses control text', () => {
    expect(parseCommand('--target x --goal "Check whether tenant A can read tenant B invoices"')).toMatchObject({ options: { goal: 'Check whether tenant A can read tenant B invoices' } });
    expect(parseCommand("--target x --goal 'single quoted goal'")).toMatchObject({ options: { goal: 'single quoted goal' } });
    for (const args of ['--goal', '--goal ""', `--goal "${'a'.repeat(601)}"`, '--goal "bad\u202etext"', '--goal "bad\u0085text"'])
      expect(() => parseCommand(`--target x ${args}`), args).toThrow(/--goal/);
  });

  it('takes up to five repeatable quoted --avoid constraints', () => {
    expect(parseCommand('--target x --avoid "No payment flows" --avoid \'Do not touch /admin\'')).toMatchObject({ options: { avoid: ['No payment flows', 'Do not touch /admin'] } });
    expect(parseCommand(`--target x ${Array.from({ length: 5 }, (_, i) => `--avoid "c${i}"`).join(' ')}`)).toMatchObject({ options: { avoid: ['c0', 'c1', 'c2', 'c3', 'c4'] } });
    expect(() => parseCommand(`--target x ${Array.from({ length: 6 }, (_, i) => `--avoid "c${i}"`).join(' ')}`)).toThrow(/at most 5/);
    for (const args of ['--avoid', '--avoid ""', `--avoid "${'a'.repeat(301)}"`, '--avoid "bad\u202etext"', '--avoid "bad\u0085text"'])
      expect(() => parseCommand(`--target x ${args}`), args).toThrow(/--avoid/);
  });

  it('parses the delegation, round and loop limits it understands', () => {
    expect(parseCommand('--target x --workers 12 --loop event-driven --executors isolated --target-ops 2')).toMatchObject({ options: { workers: 12, executorMode: 'isolated', maxTargetOperations: 2 } });
    // P18/D48: the manual loop was removed; event-driven remains as the only (and default) loop mode.
    expect(() => parseCommand('--target x --loop manual')).toThrow(/MANUAL_LOOP_REMOVED/);
    for (const args of ['--loop retry', '--executors bad', '--target-ops 0']) expect(() => parseCommand(`--target x ${args}`)).toThrow();
    // P18/A9: the round budget is per round; `0` disables an axis and both at 0 is an explicit unbounded round.
    expect(parseCommand('--target x --round-steps 25 --round-seconds 600')).toMatchObject({ options: { roundSteps: 25, roundSeconds: 600 } });
    expect(parseCommand('--target x --round-steps 0 --round-seconds 0')).toMatchObject({ options: { roundSteps: 0, roundSeconds: 0 } });
    for (const args of ['--round-steps', '--round-steps -1', '--round-steps 201', '--round-seconds 7201', '--round-seconds 1.5'])
      expect(() => parseCommand(`--target x ${args}`), args).toThrow(/--round-/);
    expect(parseCommand('--target x --workers 5 --max-depth 1')).toMatchObject({ options: { workers: 5, maxDepth: 1 } });
  });

  it('parses --refer-workspace as latest/all/an explicit run-id list', () => {
    expect(parseCommand('--target x --refer-workspace')).toMatchObject({ options: { referWorkspace: 'latest' } });
    expect(parseCommand('--target x --refer-workspace all')).toMatchObject({ options: { referWorkspace: 'all' } });
    expect(parseCommand('--target x --refer-workspace run-abc123,run-def456')).toMatchObject({ options: { referWorkspace: ['run-abc123', 'run-def456'] } });
    expect(parseCommand('--target x --refer-workspace --workers 2')).toMatchObject({ options: { referWorkspace: 'latest', workers: 2 } });
    expect(() => parseCommand('--target x --refer-workspace not-a-run-id')).toThrow(/Unknown option/);
  });

  it('takes one optional --origin that pairs only with a directory target', () => {
    expect(parseCommand('--target ./repo --origin https://example.com')).toMatchObject({ target: './repo', options: { origin: 'https://example.com' } });
    expect(() => parseCommand('--target https://example.com --origin https://other.example')).toThrow(/--origin goes with a source directory target/);
    for (const args of ['--origin', '--origin ftp://example.com', '--origin not-a-url', `--origin "${'a'.repeat(2049)}"`, '--origin "https://a b.example"'])
      expect(() => parseCommand(`--target ./repo ${args}`), args).toThrow(/--origin/);
    expect(() => parseCommand('--target ./repo --origin https://a.example --origin https://b.example')).toThrow(/only once/);
  });
});

describe('targets keep their grammar, not a scope', () => {
  it('classifies a directory plus --origin as one hybrid target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-target-'));
    try {
      const hybrid = await classifyTarget(root, '/tmp', 'https://example.com/app');
      expect(hybrid).toEqual({ kind: 'hybrid', path: root, url: 'https://example.com/app', origin: 'https://example.com' });
      expect(targetLabel(hybrid)).toBe(`${root} + https://example.com/app`);
      expect(hasSource(hybrid)).toBe(true); expect(hasOrigin(hybrid)).toBe(true);
      await expect(classifyTarget('/', '/tmp', 'https://example.com')).rejects.toThrow();
      await expect(classifyTarget('https://example.com', '/tmp', 'https://other.example')).rejects.toThrow('--origin goes with a source directory target');
      await expect(classifyTarget(root, '/tmp', 'not-a-url')).rejects.toThrow();
      const plain = await classifyTarget(root, '/tmp');
      expect(hasSource(plain)).toBe(true); expect(hasOrigin(plain)).toBe(false);
      const url = await classifyTarget('https://example.com/x', '/tmp');
      expect(hasSource(url)).toBe(false); expect(hasOrigin(url)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('resolves any destination and records its address class without comparing origins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-target-'));
    try {
      const hybrid = await classifyTarget(root, '/tmp', 'https://example.com');
      await expect(scopedRequest(hybrid, '/path', async () => ['93.184.216.34'])).resolves.toMatchObject({ addressClass: 'public' });
      // Part XI: a different origin is no longer a refusal.
      await expect(scopedRequest(hybrid, 'https://other.example/', async () => ['10.0.0.7'])).resolves.toMatchObject({ url: expect.objectContaining({ hostname: 'other.example' }), addressClass: 'private' });
      // A directory run may still use HTTP when it names an absolute URL; a relative one has no base.
      const directory = await classifyTarget(root, '/tmp');
      await expect(scopedRequest(directory, 'https://example.com/abs', async () => ['93.184.216.34'])).resolves.toMatchObject({ addressClass: 'public' });
      await expect(scopedRequest(directory, '/relative', async () => ['93.184.216.34'])).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps the URL grammar: no credentials, fragments, trailing dot or non-HTTP scheme', () => {
    expect(() => webURL('https://user:pass@example.com/')).toThrow();
    expect(() => webURL('https://example.com/#frag')).toThrow();
    expect(() => webURL('https://example.com./')).toThrow(/Trailing-dot/);
    expect(() => webURL('ftp://example.com/')).toThrow();
  });

  it('resolves directories, refuses files and root, and treats GitHub as an ordinary URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-target-'));
    try {
      await mkdir(join(root, 'repo')); await writeFile(join(root, 'file'), 'x'); await symlink(join(root, 'repo'), `${root}-link`);
      expect(await classifyTarget(join(root, 'repo'), root)).toEqual({ kind: 'directory', path: join(root, 'repo') });
      expect(await classifyTarget(`${root}-link`, '/tmp')).toEqual({ kind: 'directory', path: join(root, 'repo') });
      await expect(classifyTarget(join(root, 'file'), root)).rejects.toThrow('directory');
      await expect(classifyTarget('/', root)).rejects.toThrow();
      await expect(classifyTarget('ftp://example.com', root)).rejects.toThrow();
      expect(await classifyTarget('https://github.com/o/r', root)).toMatchObject({ kind: 'url', origin: 'https://github.com' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
