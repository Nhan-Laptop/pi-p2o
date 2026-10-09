import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_WORKERS, loadSettings, parseSettings, resolveRole } from '../../src/roles.js';

describe('role table', () => {
  it('falls back to package defaults and the parent model', () => {
    const settings = parseSettings(undefined);
    expect(settings).toMatchObject({ maxWorkers: DEFAULT_MAX_WORKERS, maxDepth: DEFAULT_MAX_DEPTH, roles: {} });
    const general = resolveRole({ settings, parentModel: 'deepseek/deepseek-flash' });
    expect(general).toMatchObject({ role: 'general', model: 'deepseek/deepseek-flash', skills: [] });
    const validation = resolveRole({ role: 'validation', settings, parentModel: 'parent/model' });
    expect(validation.model).toBe('opencode-go/kimi-k3');
    expect(validation.skills).toEqual(['exploitability-assessment']);
  });

  it('applies per-spawn overrides over settings over defaults, like pi-herdr', () => {
    const settings = parseSettings({ p2o: { maxWorkers: 5, maxDepth: 1, roles: { discovery: { model: 'setting/model', skills: ['fuzzing'] } } } });
    expect(settings).toMatchObject({ maxWorkers: 5, maxDepth: 1 });
    expect(resolveRole({ role: 'discovery', settings }).model).toBe('setting/model');
    expect(resolveRole({ role: 'discovery', settings }).skills).toEqual(['fuzzing']);
    expect(resolveRole({ role: 'discovery', settings, model: 'explicit/model', skills: ['memory-safety-auditing'] })).toMatchObject({ model: 'explicit/model', skills: ['memory-safety-auditing'] });
    expect(resolveRole({ role: 'not-a-role', settings }).role).toBe('general');
  });

  it('treats settings as untrusted and refuses to load nonsense', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-roles-'));
    const path = join(root, 'settings.json');
    try {
      await writeFile(path, '{not json');
      expect(loadSettings(path)).toMatchObject({ maxWorkers: DEFAULT_MAX_WORKERS, roles: {} });
      await writeFile(path, JSON.stringify({ p2o: { maxWorkers: 99, maxDepth: -3, roles: { validation: { model: 42, skills: ['ok', 'not a skill', 7], thinking: 'MAXIMUM' } } } }));
      const settings = loadSettings(path);
      expect(settings.maxWorkers).toBe(99); // Explicit operator capacity, not the old hard cap 6.
      expect(parseSettings({p2o:{maxWorkers:Number.MAX_SAFE_INTEGER+1}}).maxWorkers).toBe(DEFAULT_MAX_WORKERS);
      expect(settings.maxDepth).toBe(DEFAULT_MAX_DEPTH);
      expect(settings.roles.validation).toEqual({ skills: ['ok'] });
      expect(resolveRole({ role: 'validation', settings, model: 'x/y' }).thinking).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
