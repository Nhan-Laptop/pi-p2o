import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, type InertSandbox } from './helpers/fake-pi.js';

/**
 * S0 (plan): the command list lives in three places (the /p2o help text, README.md and docs/USAGE.md). Only the first one is code, so it is the one
 * that silently falls behind. This keeps it complete: every `/p2o <command>` shown as a command (at the start of a line or in backticks) in the two
 * documents must appear in the help text.
 */
const root = resolve(import.meta.dirname, '../..');
const documented = (text: string) => new Set([...text.matchAll(/(?:^|`)\/p2o\s+([a-z][a-z-]*)/gm)].map(match => match[1]));

describe('/p2o help lists every documented command', () => {
  it('mentions each command that README.md and docs/USAGE.md document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p2o-help-'));
    try {
      const pi = createFakePi(), ctx = createContext({ cwd: dir }), sandboxes: InertSandbox[] = [];
      registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(dir, 'control'), settingsPath: join(dir, 'no-settings.json'), herdr: createSimpleHerdr().client, createSandbox: sandboxFactory(sandboxes) });
      await pi.commands.get('p2o').handler('', ctx.ctx);
      const help = ctx.notices.at(-1) ?? '', words = new Set(help.match(/[a-z][a-z-]*/g));
      expect(help).toContain('Usage: /p2o --target');
      const names = new Set([...documented(await readFile(join(root, 'README.md'), 'utf8')), ...documented(await readFile(join(root, 'docs/USAGE.md'), 'utf8'))]);
      expect(names.size, 'the documents should still show a full command list').toBeGreaterThan(20);
      expect([...names].filter(name => !words.has(name)).sort(), 'documented but absent from the /p2o help text').toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('does not fire on prose that merely mentions the extension', () => {
    expect([...documented('The /p2o extension is installed.\nUse `/p2o status` or\n/p2o log 0\n- see /p2o report')].sort()).toEqual(['log', 'status']);
  });
});
