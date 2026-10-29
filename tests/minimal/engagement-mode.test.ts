import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CASE_EFFECTS } from '../../src/cvss.js';
import { DEFAULT_EFFECT_CLASSES, campaignFrom, campaignStartLine, parseCampaign } from '../../src/campaign.js';
import { parseCommand } from '../../src/target.js';
import { fixture, seedClaim } from './helpers/report-fixture.js';

/**
 * P7.1 (planning_update.md §13 A7.1, owner decisions 2026-10-26): the engagement mode is a host-checked object.
 * `exploit` is the default (Q8); `assess` is the opt-in read-only shape. The parser validates the mode and the effect
 * classes, a stored v1 campaign reads as assess, and the host — not the prompt — refuses a mis-shaped intent.
 */
const PROMPT_SECTION = 'p2o_assessment';
const plannerPrompt = async (h: any): Promise<string> => {
  const event = { systemPromptOptions: { sections: {} as Record<string, string> }, prompt: '' };
  for (const handler of h.pi.events.get('before_agent_start') ?? []) await handler(event);
  return event.systemPromptOptions.sections[PROMPT_SECTION];
};
const startOptions = (line: string) => {
  const command = parseCommand(line);
  if (command.action !== 'start') throw new Error(`expected a start command, got ${command.action}`);
  return command.options;
};
const v1 = {
  v: 1, objective: 'Assess the fixture boundary', constraints: [], targetRevision: '', heartbeatSeconds: 600,
  startedAt: '2026-01-01T00:00:00.000Z', createdBy: 'operator',
};
const exploitationDraft = {
  question: 'Does the recorded primitive reach the effect the chain claims?', surface: '/fixture', risk: 'authorization', role: 'exploit',
  roleReason: 'P7.1 admission fixture takes the primitive further', expectedTrue: 'The bounded effect is demonstrated',
  expectedFalse: 'The effect is not demonstrated and the wall is recorded', stopCondition: 'Stop after one bounded attempt',
  evidenceIds: [], prerequisites: [], methodReason: 'One bounded effect against the recorded fixture',
};

describe('engagement mode parser (A7.1)', () => {
  it('defaults to exploit and validates an explicit mode', () => {
    expect(startOptions('--target ./source')).toEqual({});
    expect(parseCommand('--target ./source --mode assess')).toMatchObject({ action: 'start', target: './source', options: { mode: 'assess' } });
    expect(parseCommand('--target ./source --mode exploit')).toMatchObject({ options: { mode: 'exploit' } });
    expect(() => parseCommand('--target ./source --mode "' + 'assess'.toUpperCase() + '"')).toThrow(/--mode must be assess or exploit/);
    expect(() => parseCommand('--target ./source --mode assess --mode exploit')).toThrow(/only once/);
  });

  it('accepts repeatable effect classes, dedupes and stores them in canonical order', () => {
    // Order comes from CASE_EFFECTS, not from the flag order, so two equal authorizations render identically.
    expect(startOptions('--target ./source --mode exploit --effect code-execution --effect confidentiality-read --effect code-execution').effectClasses).toEqual(['confidentiality-read', 'code-execution']);
    expect(startOptions('--target ./source --mode exploit --effect sandbox-escape').effectClasses).toEqual(['sandbox-escape']);
    // Flag order does not matter: the ladder is named before or after the classes it narrows.
    expect(startOptions('--target ./source --effect sandbox-escape --mode exploit').effectClasses).toEqual(['sandbox-escape']);
    expect(startOptions('--target ./source --mode assess').effectClasses).toBeUndefined();
  });

  it('refuses an unknown effect, and an effect in assess mode in either flag order', () => {
    expect(() => parseCommand('--target ./source --mode exploit --effect not-a-class')).toThrow(/--effect must be one of/);
    // A7.1: an effect class with no named mode is refused, because it would silently attach to the default frame.
    expect(() => parseCommand('--target ./source --effect code-execution')).toThrow(/requires --mode exploit/);
    expect(() => parseCommand('--target ./source --effect code-execution --mode exploit')).not.toThrow();
    expect(() => parseCommand('--target ./source --mode assess --effect code-execution')).toThrow(/goes with exploit mode/);
    expect(() => parseCommand('--target ./source --effect code-execution --mode assess')).toThrow(/goes with exploit mode/);
    // The unknown-option text names the new flags, so a typo is a usage error rather than a silent scope widening.
    expect(() => parseCommand('--target ./source --effects code-execution')).toThrow(/--mode assess\|exploit/);
  });
});

describe('campaign record v2 (A7.1)', () => {
  it('reads a stored v1 campaign as assess, so resuming an old run cannot retroactively authorize a ladder', () => {
    expect(parseCampaign(v1)).toMatchObject({ v: 2, objective: v1.objective, mode: 'assess', effectClasses: [] });
    // A v1 row is a v1 row: a hand-edited mode/effectClasses on it is an unknown extra field, ignored rather than upgraded.
    expect(parseCampaign({ ...v1, mode: 'exploit', effectClasses: ['code-execution'] })).toMatchObject({ mode: 'assess', effectClasses: [] });
  });

  it('builds a v2 campaign whose default authorization is every effect except availability-loss', () => {
    const built = campaignFrom({ target: '/fixture', at: '2026-10-26T00:00:00.000Z' });
    expect(built).toMatchObject({ v: 2, mode: 'exploit', createdBy: 'default' });
    expect(built.effectClasses).toEqual(DEFAULT_EFFECT_CLASSES);
    expect(built.effectClasses).not.toContain('availability-loss');
    expect(DEFAULT_EFFECT_CLASSES).toEqual(CASE_EFFECTS.filter(effect => effect !== 'availability-loss'));
    // Round-trips through stored JSON, and an existing record still wins (a campaign is written once).
    expect(parseCampaign(JSON.parse(JSON.stringify(built)))).toEqual(built);
    expect(campaignFrom({ target: '/other', at: '2027-01-01T00:00:00.000Z', mode: 'assess' }, built)).toEqual(built);
  });

  it('an explicitly requested effect class is honored, and assess authorizes none', () => {
    expect(campaignFrom({ target: '/fixture', at: '2026-10-26T00:00:00.000Z', mode: 'exploit', effectClasses: ['availability-loss'] }).effectClasses).toEqual(['availability-loss']);
    expect(campaignFrom({ target: '/fixture', at: '2026-10-26T00:00:00.000Z', mode: 'assess', effectClasses: ['code-execution'] })).toMatchObject({ mode: 'assess', effectClasses: [] });
    // Malformed stored values are refused rather than read as "no restriction".
    const good = campaignFrom({ target: '/fixture', at: '2026-10-26T00:00:00.000Z' });
    expect(parseCampaign({ ...good, mode: 'escalate' })).toBeUndefined();
    expect(parseCampaign({ ...good, effectClasses: ['not-a-class'] })).toBeUndefined();
    // Duplicates are canonicalized rather than refused: the stored text is what the operator meant.
    expect(parseCampaign({ ...good, effectClasses: ['code-execution', 'code-execution'] })!.effectClasses).toEqual(['code-execution']);
    expect(parseCampaign({ ...good, mode: 'assess', effectClasses: ['code-execution'] })).toBeUndefined();
  });

  it('prints the mode and the effect classes on the start line', () => {
    const exploit = campaignStartLine(campaignFrom({ target: '/fixture', at: '2026-10-26T00:00:00.000Z', effectClasses: ['code-execution'] }));
    expect(exploit).toContain('mode exploit (access ladder authorized for effect classes: code-execution)');
    const assess = campaignStartLine(campaignFrom({ target: '/fixture', at: '2026-10-26T00:00:00.000Z', mode: 'assess' }));
    expect(assess).toContain('mode assess (read-only: the host refuses exploitation and chaining intents)');
  });
});

describe('engagement mode in the run (A7.1)', () => {
  it('defaults to exploit in the confirmation, the run profile and the planner prompt', async () => fixture(async h => {
    await h.command('--target ./source');
    const confirmation = h.ctx.confirmBodies.at(-1) as string;
    expect(confirmation).toContain('Engagement: mode exploit (access ladder authorized for effect classes:');
    expect(confirmation).toContain('code-execution');
    const store = await h.reader();
    try {
      expect(store.manifest().profile).toMatchObject({ mode: 'exploit', effectClasses: DEFAULT_EFFECT_CLASSES });
    } finally { store.close(); }
    const prompt = await plannerPrompt(h);
    expect(prompt).toContain('ENGAGEMENT MODE — EXPLOIT');
    // A3/D32: the impact goal is demanded as a plan-board goal whose proof is a capability or an accepted case.
    expect(prompt).toContain('record a plan goal whose proof is a capability or an accepted case');
    // Planner policy text names no tool: active tool declarations own usage and arguments.
    expect(prompt).not.toMatch(/\bp2o_[a-z_]+\b/);
  }));

  it('refuses an exploitation intent in assess mode, and the report names the mode', async () => fixture(async h => {
    await h.command('--target ./source --mode assess');
    expect(h.ctx.confirmBodies.at(-1)).toContain('Engagement: mode assess (read-only: the host refuses exploitation and chaining intents)');
    const store = await h.reader();
    try {
      expect(store.manifest().profile).toMatchObject({ mode: 'assess', effectClasses: [] });
      // P18/A9: every run records a campaign frame; assess mode records the read-only shape in it.
      expect(store.campaign()).toMatchObject({ createdBy: 'default', mode: 'assess', effectClasses: [] });
    } finally { store.close(); }
    await expect(h.call('p2o_task_author', { draft: exploitationDraft })).rejects.toThrow(/ASSESS_MODE_REFUSES_EXPLOITATION/);
    // Mapping/discovery/validation purposes stay admitted: assess refuses effects, not assessment.
    const recon = await h.call('p2o_task_author', { draft: { question: 'Which surfaces does the fixture expose?', surface: '/fixture', risk: 'mapping', role: 'recon', evidenceIds: [], prerequisites: [] } });
    expect(recon.details).toMatchObject({ status: 'proposed', role: 'recon' });
    // The report states the engagement shape from the recorded campaign mode.
    const exported = await h.call('p2o_finish', { export: true });
    const directory = exported.details.reportPath as string;
    const report = await readFile(join(directory, 'REPORT.md'), 'utf8');
    // Markdown-safe escaping is expected: parentheses are escaped in the report body.
    expect(report).toContain('Engagement mode: mode assess \\(read-only: the host refuses exploitation and chaining intents\\)');
  }));

  it('exploit mode admits an exploitation intent only under a capability-proof goal', async () => fixture(async h => {
    await h.command('--target ./source');
    const goalDraft = (proof: Record<string, unknown>) => ({ entry: { kind: 'goal', title: 'Reach the recorded effect under an impact goal', status: 'active', proof,
      criteria: ['The exploitation step runs and is attributed'], reason: 'P7.1 admission fixture: the goal the ladder is settled against' } });
    // No goal yet: the host refuses before the intent exists, for every target-executing purpose (A3/D32), not only exploitation.
    await expect(h.call('p2o_task_author', { draft: exploitationDraft })).rejects.toThrow(/EXPLOIT_MODE_NEEDS_IMPACT_GOAL/);
    await expect(h.call('p2o_task_author', { draft: { question: 'Which surfaces does the fixture expose?', surface: '/fixture', risk: 'mapping', role: 'recon', evidenceIds: [], prerequisites: [] } })).rejects.toThrow(/EXPLOIT_MODE_NEEDS_IMPACT_GOAL/);
    // Reporting is read-only, so it is admitted without an impact goal.
    const reportingDraft = { question: 'Summarize the reviewed fixture records?', surface: '/fixture', risk: 'reporting', role: 'reporting',
      roleReason: 'Reporting is read-only and needs no impact goal', expectedTrue: 'The summary cites reviewed records', expectedFalse: 'The summary names what is missing',
      stopCondition: 'Stop after one summary of the reviewed records', evidenceIds: [], prerequisites: [], methodReason: 'Read-only summary of the reviewed fixture records' };
    expect((await h.call('p2o_task_author', { draft: reportingDraft })).details).toMatchObject({ status: 'proposed' });
    await h.call('p2o_goal_author', { entry: { kind: 'todo', title: 'A todo is not a goal', status: 'open', reason: 'P7.1 negative control: only a goal authorizes the ladder' } });
    await expect(h.call('p2o_task_author', { draft: exploitationDraft })).rejects.toThrow(/EXPLOIT_MODE_NEEDS_IMPACT_GOAL/);
    // A capability-proof goal opens the ladder; the intent still has to carry its own lineage.
    await h.call('p2o_goal_author', { entry: { kind: 'goal', title: 'Reach the recorded effect under an impact goal', status: 'active', proof: { kind: 'capability', capability: { kind: 'file.read' } },
      criteria: ['The exploitation step runs and is attributed'], reason: 'P7.1 admission fixture: the goal the ladder is settled against' } });
    await h.call('p2o_task_author', { draft: { question: 'Which surfaces does the fixture expose?', surface: '/fixture', risk: 'mapping', role: 'recon', evidenceIds: [], prerequisites: [] } });
    const observation = (await h.call('p2o_shell', { command: 'printf engagement-observation' })).details;
    const claim = await seedClaim(h, { candidate: 'engagement-primitive', surface: '/fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested',
      proof: 'static_trace', evidenceRefs: [observation.evidenceId], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture boundary',
      limitations: 'Nothing executed yet' });
    const asset = (await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /fixture' } }] } })).details.acks[0];
    const created = await h.call('p2o_task_author', { draft: { ...exploitationDraft, work: {
      assetRefs: [{ id: asset.entityId, revision: 1 }], questionKey: 'engagement:fixture', policyKey: 'policy:fixture', actorContext: 'actor:fixture',
      tenantContext: 'tenant:fixture', methodFamily: 'chain-step', purpose: 'exploitation', claimRefs: [claim.id] },
      decision: { disposition: 'new', reason: 'First task that executes this bounded step' } } });
    expect(created.details).toMatchObject({ status: 'proposed', role: 'exploit' });
    expect(created.details.work).toMatchObject({ purpose: 'exploitation' });
  }));
});
