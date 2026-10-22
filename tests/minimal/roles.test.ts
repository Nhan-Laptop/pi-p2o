import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_WORKERS, MAX_SKILLS, PURPOSE_SKILLS, ROLE_DEFAULTS, loadSettings, parseSettings, resolveRole } from '../../src/roles.js';
import { WORK_PURPOSES } from '../../src/work.js';

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

  it('treats settings as untrusted and refuses to load nonsense', async () => {    const root = await mkdtemp(join(tmpdir(), 'p2o-roles-'));
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

// planning_update.md P7: purpose decides the default skill set when the lead omits `skills`; role still picks the model.
describe('purpose → skill defaults (P7)', () => {
  const settings = parseSettings(undefined);

  it('binds a purpose to a shipped skill and stays inside the assignment cap', async () => {
    const catalog = JSON.parse(await readFile(join(fileURLToPath(new URL('../..', import.meta.url)), 'skills', 'catalog.json'), 'utf8'));
    const shipped = new Set((catalog.skills as Array<{ name: string }>).map(skill => skill.name));
    for (const purpose of WORK_PURPOSES) {
      const skills = PURPOSE_SKILLS[purpose];
      expect(skills.length, purpose).toBeLessThanOrEqual(MAX_SKILLS);
      for (const skill of skills) expect(shipped.has(skill), `${purpose} → ${skill}`).toBe(true);
    }
    // Shipped defaults for the four roles that already had one must not move: purpose refines, it does not replace.
    expect(PURPOSE_SKILLS.mapping).toEqual(ROLE_DEFAULTS.recon.skills);
    expect(PURPOSE_SKILLS.discovery).toEqual(ROLE_DEFAULTS.discovery.skills);
    expect(PURPOSE_SKILLS.validation).toEqual(ROLE_DEFAULTS.validation.skills);
    expect(PURPOSE_SKILLS.reporting).toEqual(ROLE_DEFAULTS.reporting.skills);
  });

  it('uses the purpose when skills are omitted, and an empty purpose list keeps the role default', () => {
    expect(resolveRole({ role: 'discovery', settings, purpose: 'mapping' }).skills).toEqual(['attack-surface-mapping']);
    expect(resolveRole({ role: 'validation', settings, purpose: 'retest' }).skills).toEqual(['remediation']);
    expect(resolveRole({ role: 'general', settings, purpose: 'refinement' }).skills).toEqual(['source-code-auditing']);
    // investigation ships no default on purpose, so a general-role worker keeps the empty role default it has today.
    expect(resolveRole({ role: 'general', settings, purpose: 'investigation' }).skills).toEqual([]);
    // Omitting the purpose derives it from the role, so the two call sites cannot disagree with the worker's duty line.
    expect(resolveRole({ role: 'discovery', settings }).skills).toEqual(['source-code-auditing']);
  });

  it('never overrides an explicit request or the operator role setting, and keeps the model axis on the role', () => {
    const configured = parseSettings({ p2o: { roles: { discovery: { skills: ['fuzzing'] } } } });
    expect(resolveRole({ role: 'discovery', settings: configured, purpose: 'validation' }).skills).toEqual(['fuzzing']);
    expect(resolveRole({ role: 'discovery', settings, purpose: 'validation', skills: ['memory-safety-auditing'] }).skills).toEqual(['memory-safety-auditing']);
    expect(resolveRole({ role: 'validation', settings, purpose: 'retest' }).model).toBe('opencode-go/kimi-k3');
    expect(resolveRole({ role: 'discovery', settings, purpose: 'validation' }).model).toBe('opencode-go/deepseek-v4-flash');
  });
});
