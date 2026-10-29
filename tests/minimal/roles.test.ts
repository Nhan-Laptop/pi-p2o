import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedWorkerModels, DEFAULT_MAX_DEPTH, DEFAULT_MAX_WORKERS, MAX_SKILLS, PURPOSE_SKILLS, ROLE_DEFAULTS, loadSettings, parseSettings, resolveRole, THINKING_LEVELS, validateTaskRuntime } from '../../src/roles.js';
import { WORK_PURPOSES } from '../../src/work.js';

describe('role table', () => {
  it('falls back to package defaults and the parent model', () => {
    const settings = parseSettings(undefined);
    expect(settings).toMatchObject({ maxWorkers: DEFAULT_MAX_WORKERS, maxDepth: DEFAULT_MAX_DEPTH, roles: {} });
    const general = resolveRole({ settings, parentModel: 'deepseek/deepseek-flash' });
    expect(general).toMatchObject({ role: 'general', model: 'deepseek/deepseek-flash', skills: [] });
    const validation = resolveRole({ role: 'validation', settings, parentModel: 'parent/model' });
    expect(validation.model).toBe('opencode-go/kimi-k3');
    // P15 (W5): reproduction is not impact assessment, so the validation role ships no method skill; the duty line carries the contract.
    expect(validation.skills).toEqual([]);
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

// planning_update.md P15 (W3/W4): the target kind and the capabilities a step consumes decide which method a purpose hands out, so a
// URL run is not given a source-tree method and an exploit step climbs the ladder its own primitive names.
describe('purpose → skill defaults follow the target and the consumed capability (P15)', () => {
  const settings = parseSettings(undefined);
  it('gives a URL run the web playbooks, keeps the source methods where a source tree exists, and keeps the base table without a kind', () => {
    expect(resolveRole({ role: 'recon', settings, context: { kind: 'url' } }).skills).toEqual(['web-deployment-hygiene']);
    expect(resolveRole({ role: 'discovery', settings, context: { kind: 'url' } }).skills).toEqual(['web-route-input-inventory']);
    expect(resolveRole({ role: 'recon', settings, context: { kind: 'directory' } }).skills).toEqual(['attack-surface-mapping']);
    expect(resolveRole({ role: 'recon', settings, context: { kind: 'hybrid' } }).skills).toEqual(['attack-surface-mapping']);
    expect(resolveRole({ role: 'discovery', settings, context: { kind: 'hybrid' } }).skills).toEqual(['source-code-auditing']);
    // No kind means no guess: a caller that cannot supply context keeps the pre-P15 defaults.
    expect(resolveRole({ role: 'recon', settings }).skills).toEqual(['attack-surface-mapping']);
    expect(resolveRole({ role: 'discovery', settings }).skills).toEqual(['source-code-auditing']);
  });

  it('derives the exploitation ladder from work.needs and never drops the general procedure', () => {
    const exploit = (needs: string[], kind?: 'directory' | 'url' | 'hybrid') => resolveRole({ role: 'exploit', settings, context: { kind, needs } }).skills;
    expect(exploit([])).toEqual(['exploit-design']);
    expect(exploit(['net.egress'])).toEqual(['exploit-design', 'ssrf-to-internal']);
    expect(exploit(['exec.code'], 'directory')).toEqual(['exploit-design', 'binary-exploit-ladder']);
    expect(exploit(['exec.code'], 'url')).toEqual(['exploit-design', 'web-injection-to-exec']);
    expect(exploit(['cred.secret'])).toEqual(['exploit-design', 'credential-and-pivot']);
    // Three ladders plus the procedure exceed the assignment cap, so the cap keeps the procedure and the first ladders.
    expect(exploit(['net.egress', 'exec.code', 'cred.session'])).toHaveLength(MAX_SKILLS);
    expect(exploit(['net.egress', 'exec.code', 'cred.session'])[0]).toBe('exploit-design');
    // An unknown capability kind selects no ladder instead of guessing one.
    expect(exploit(['not.a.kind'])).toEqual(['exploit-design']);
    // An explicit request still wins over every derivation.
    expect(resolveRole({ role: 'exploit', settings, context: { needs: ['net.egress'] }, skills: ['fuzzing'] }).skills).toEqual(['fuzzing']);
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

  it('uses the purpose when skills are omitted, and an explicitly empty purpose list means no method default', () => {
    expect(resolveRole({ role: 'discovery', settings, purpose: 'mapping' }).skills).toEqual(['attack-surface-mapping']);
    expect(resolveRole({ role: 'validation', settings, purpose: 'retest' }).skills).toEqual(['remediation']);
    expect(resolveRole({ role: 'general', settings, purpose: 'refinement' }).skills).toEqual(['source-code-auditing']);
    // P15 (W3/W5): validation, reporting and investigation ship [] on purpose, so an explicit purpose must not resurrect the
    // role default; role=discovery + purpose=validation starting from source-code-auditing was the P15 regression.
    expect(resolveRole({ role: 'discovery', settings, purpose: 'validation' }).skills).toEqual([]);
    expect(resolveRole({ role: 'discovery', settings, purpose: 'reporting' }).skills).toEqual([]);
    expect(resolveRole({ role: 'recon', settings, purpose: 'investigation' }).skills).toEqual([]);
    expect(resolveRole({ role: 'general', settings, purpose: 'investigation' }).skills).toEqual([]);
    // A role default applies only when no purpose is supplied, because the derived purpose then speaks for the role.
    expect(resolveRole({ role: 'discovery', settings }).skills).toEqual(['source-code-auditing']);
    expect(resolveRole({ role: 'recon', settings }).skills).toEqual(['attack-surface-mapping']);
  });

  it('accepts the exploit role, resolves a model for it and grants no scope (P14.4, P14.6)', () => {
    const resolved = resolveRole({ role: 'exploit', settings, parentModel: 'parent/model' });
    expect(resolved).toMatchObject({ role: 'exploit', model: 'opencode-go/kimi-k3', skills: ['exploit-design'], requestedSkills: [], omittedSkills: [] });
    // A role selects a model and a starting skill set; the ticket still fixes the target, so nothing here may widen it.
    expect(Object.keys(resolved).sort()).toEqual(['model', 'omittedSkills', 'requestedSkills', 'role', 'skills', 'thinking']);
    expect(JSON.stringify(resolved)).not.toMatch(/target|origin|scope/i);
    // P14.6 ships the exploit skill, so both exploit purposes now start from it instead of from nothing.
    for (const purpose of ['exploitation', 'chaining'] as const) expect(PURPOSE_SKILLS[purpose]).toEqual(['exploit-design']);
    expect(resolveRole({ role: 'exploit', settings, purpose: 'chaining' }).skills).toEqual(['exploit-design']);
  });

  it('never overrides an explicit request or the operator role setting, and keeps the model axis on the role', () => {
    const configured = parseSettings({ p2o: { roles: { discovery: { skills: ['fuzzing'] } } } });
    expect(resolveRole({ role: 'discovery', settings: configured, purpose: 'validation' }).skills).toEqual(['fuzzing']);
    expect(resolveRole({ role: 'discovery', settings, purpose: 'validation', skills: ['memory-safety-auditing'] }).skills).toEqual(['memory-safety-auditing']);
    expect(resolveRole({ role: 'validation', settings, purpose: 'retest' }).model).toBe('opencode-go/kimi-k3');
    expect(resolveRole({ role: 'discovery', settings, purpose: 'validation' }).model).toBe('opencode-go/deepseek-v4-flash');
  });

  it('removes the source method from a URL-only refinement or retest and keeps it where a snapshot exists', () => {
    for (const purpose of ['refinement', 'retest'] as const) {
      expect(resolveRole({ role: 'general', settings, purpose, context: { kind: 'url' } }).skills, `${purpose} on url`).toEqual([]);
      expect(resolveRole({ role: 'general', settings, purpose, context: { kind: 'hybrid' } }).skills, `${purpose} on hybrid`).not.toEqual([]);
      expect(resolveRole({ role: 'general', settings, purpose, context: { kind: 'directory' } }).skills, `${purpose} on directory`).not.toEqual([]);
    }
    expect(resolveRole({ role: 'general', settings, purpose: 'refinement', context: { kind: 'hybrid' } }).skills).toEqual(['source-code-auditing']);
    expect(resolveRole({ role: 'general', settings, purpose: 'retest', context: { kind: 'hybrid' } }).skills).toEqual(['remediation']);
    // An explicit request still wins, so any skill stays nameable on any target kind.
    expect(resolveRole({ role: 'general', settings, purpose: 'refinement', context: { kind: 'url' }, skills: ['memory-safety-auditing'] }).skills).toEqual(['memory-safety-auditing']);
    // The rule only removes source-based methods: a URL discovery keeps its web playbook, and operator settings still outrank it.
    expect(resolveRole({ role: 'discovery', settings, purpose: 'discovery', context: { kind: 'url' } }).skills).toEqual(['web-route-input-inventory']);
    const configured = parseSettings({ p2o: { roles: { general: { skills: ['fuzzing'] } } } });
    expect(resolveRole({ role: 'general', settings: configured, purpose: 'refinement', context: { kind: 'url' } }).skills).toEqual(['fuzzing']);
  });

  it('reports the requested and omitted skills instead of silently capping at MAX_SKILLS', () => {
    const requested = ['attack-surface-mapping', 'source-code-auditing', 'web-deployment-hygiene', 'data-flow-analysis'];
    const capped = resolveRole({ role: 'general', settings, skills: requested });
    expect(capped.skills).toEqual(requested.slice(0, MAX_SKILLS));
    expect(capped.requestedSkills).toEqual(requested);
    expect(capped.omittedSkills).toEqual(requested.slice(MAX_SKILLS));
    // A derived exploitation ladder can overflow the cap too; without this field that loss would leave no trace anywhere.
    const ladder = resolveRole({ role: 'exploit', settings, context: { needs: ['net.egress', 'exec.code', 'cred.session'] } });
    expect(ladder.skills).toHaveLength(MAX_SKILLS);
    expect(ladder.requestedSkills).toEqual([]);
    expect(ladder.omittedSkills).toEqual(['credential-and-pivot']);
    // Nothing cut, nothing reported.
    expect(resolveRole({ role: 'recon', settings })).toMatchObject({ requestedSkills: [], omittedSkills: [] });
  });

  it('P10/WF-02/03 (Q28) + P19/B3: validates a per-task worker model and leaves the thinking level to the role', () => {
    // The package role defaults plus every operator-configured role model are the whole allowed set.
    const defaults = allowedWorkerModels(settings);
    expect(defaults).toContain('opencode-go/kimi-k3');
    expect(defaults).toContain('opencode-go/deepseek-v4-flash');
    const configured = parseSettings({ p2o: { roles: { general: { model: 'fixture/provider-model' } } } });
    expect(allowedWorkerModels(configured)).toContain('fixture/provider-model');
    expect(validateTaskRuntime(undefined, settings)).toBeUndefined();
    expect(validateTaskRuntime({ model: ' fixture/provider-model ' }, configured)).toEqual({ model: 'fixture/provider-model' });
    expect(() => validateTaskRuntime({ model: 'nope/model' }, settings)).toThrow(/MODEL_UNAVAILABLE: nope\/model.*legalNext: name one of/);
    // P19/B3: the thinking axis is role configuration. No per-task request can name it, so the role resolution is its only source.
    expect(THINKING_LEVELS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveRole({ role: 'validation', settings }).thinking).toBeUndefined();
    // An empty runtime is a valid empty request: the host validates the request, it does not fill defaults into the task.
    expect(validateTaskRuntime({}, settings)).toEqual({});
  });
});
