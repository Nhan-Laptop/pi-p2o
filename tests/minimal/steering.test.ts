import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { campaignFrom, campaignStartLine, parseCampaign } from '../../src/campaign.js';
import { AssessmentStore } from '../../src/state/store.js';
import { parseCommand } from '../../src/target.js';
import { createContext, createFakePi, sandboxFactory, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

/**
 * A7.9/D23 (planning_update.md P7.8): runtime steering and `--allow`. A recorded permission raises authorization inside the
 * existing frame; hints and constraints are append-only facts the next planner round reads. Hermetic: inert sandbox, real
 * SQLite store, no model and no target.
 */
async function steeringFixture(work: (h: any) => Promise<void>, settings?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-steering-'));
  await mkdir(join(root, 'source'));
  const settingsPath = join(root, 'settings.json');
  if (settings) await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  const pi = createFakePi(), ctx = createContext({ cwd: root }), sandboxes: InertSandbox[] = [];
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath, createSandbox: sandboxFactory(sandboxes) });
  const command = (text: string) => pi.commands.get('p2o').handler(text, ctx.ctx);
  const call = (name: string, params: any = {}) => pi.tools.get(name).execute(randomUUID(), params, undefined, undefined, ctx.ctx);
  const reader = async () => AssessmentStore.open(join(root, '.p2o-state'), (await readdir(join(root, '.p2o-state')))[0]);
  const prompt = async () => {
    const event = { systemPromptOptions: { sections: {} as Record<string, string> }, prompt: '' };
    for (const handler of pi.events.get('before_agent_start') ?? []) await handler(event, ctx.ctx);
    return event.systemPromptOptions.sections['p2o_assessment'];
  };
  try { await work({ root, pi, ctx, sandboxes, command, call, reader, prompt }); }
  finally { await command('stop').catch(() => undefined); await rm(root, { recursive: true, force: true }); }
}

describe('A7.9 recorded permissions', () => {
  it('parses --allow with the same bounded shape and one shared budget with --avoid', () => {
    const parsed = parseCommand('--target ./source --allow "You may exploit the upload endpoint" --avoid "No payment flows"');
    expect(parsed).toMatchObject({ action: 'start', options: { allow: ['You may exploit the upload endpoint'], avoid: ['No payment flows'] } });
    expect(() => parseCommand(`--target ./source --allow "${'a'.repeat(301)}"`)).toThrow(/--allow needs one quoted sentence of 1..300/);
    expect(() => parseCommand('--target ./source --allow "bad\u0001bytes"')).toThrow(/--allow/);
    const five = ['a', 'b', 'c', 'd', 'e'].map(line => `--allow "${line}"`).join(' ');
    expect(() => parseCommand(`--target ./source ${five} --avoid "one more"`)).toThrow(/at most 5 times/);
  });

  it('records allow and deny as different rules in the campaign frame and prints the permission', () => {
    const record = campaignFrom({ target: 'https://cart.example', at: '2026-01-01T00:00:00.000Z', goal: 'Assess the cart', avoid: ['No payment flows'], allow: ['You may exploit the upload endpoint'] });
    expect(record.constraints).toEqual([{ rule: 'deny', text: 'No payment flows' }, { rule: 'allow', text: 'You may exploit the upload endpoint' }]);
    expect(parseCampaign(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(campaignStartLine(record)).toContain('constraints: 1 deny, 1 allow');
  });

  it('prints the recorded permission to the planner as permission only and keeps ordinary execution open', async () => steeringFixture(async h => {
    // The operator deny rule is a command-policy rule (A7.7); a recorded --allow must not become a policy bypass.
    await h.command('--target ./source --allow "You may run the upload probe"');
    const confirmation = h.ctx.confirmBodies.at(-1) as string;
    expect(confirmation).toContain('Operator permissions (recorded allow = permission only; a deny still wins and the target never widens):');
    expect(confirmation).toContain('You may run the upload probe');
    const planner = await h.prompt();
    expect(planner).toContain('allow "You may run the upload probe"');
    expect(planner).toContain('allow = permission only');
    const store = await h.reader();
    try { expect(store.campaign()?.constraints).toEqual([{ rule: 'allow', text: 'You may run the upload probe' }]); } finally { store.close(); }
    // An ordinary command still runs under the recorded permission.
    const allowed = await h.call('p2o_shell', { command: 'echo permitted-by-operator' });
    expect(allowed.content[0].text).toContain('permitted-by-operator');
  }, { p2o: { commandPolicy: { rules: [{ action: 'deny', match: 'ALLOW_PROBE', reason: 'operator deny fixture' }] } } }));

  it('never lets a recorded allow override an operator deny rule', async () => steeringFixture(async h => {
    await h.command('--target ./source --allow "The operator permits the upload probe"');
    const commands = h.sandboxes[0].commands.length;
    await expect(h.call('p2o_shell', { command: 'echo ALLOW_PROBE' })).rejects.toThrow(/POLICY_DENY/);
    // Denied before any byte reached the executor: the permission is recorded intent, not a bypass.
    expect(h.sandboxes[0].commands).toHaveLength(commands);
  }, { p2o: { commandPolicy: { rules: [{ action: 'deny', match: 'ALLOW_PROBE', reason: 'operator deny fixture' }] } } }));
});

describe('A7.9 runtime steering', () => {
  it('records one hint and one constraint append-only and renders them into the next planner prompt', async () => steeringFixture(async h => {
    await h.command('--target ./source --goal "Assess the fixture cart"');
    const hint = await h.call('p2o_loop', { action: 'hint', text: '  Prefer  the upload endpoint over login ' });
    expect(hint.details).toMatchObject({ kind: 'hint', text: 'Prefer the upload endpoint over login', recorded: 1, limit: 24 });
    const constraint = await h.call('p2o_loop', { action: 'constrain', text: 'Do not touch the payment flow at all' });
    expect(constraint.details).toMatchObject({ kind: 'constraint', recorded: 1, limit: 12 });
    const planner = await h.prompt();
    expect(planner).toContain('OPERATOR STEERING');
    expect(planner).toContain('constraints (absolute, they narrow; deny always wins): "Do not touch the payment flow at all"');
    expect(planner).toContain('hints (guidance, never a permission and never a widening): "Prefer the upload endpoint over login"');
    // The campaign frame is not rewritten by steering: it stays the recorded frame.
    const store = await h.reader();
    try {
      expect(store.campaign()?.constraints).toEqual([]);
      const facts = store.records().filter((record: any) => record.kind === 'lifecycle' && record.data?.steering).map((record: any) => record.data.steering);
      expect(facts).toEqual([{ kind: 'hint', text: 'Prefer the upload endpoint over login' }, { kind: 'constraint', text: 'Do not touch the payment flow at all' }]);
    } finally { store.close(); }
    // Duplicates are refused instead of growing the prompt every round.
    await expect(h.call('p2o_loop', { action: 'hint', text: 'Prefer the upload endpoint over login' })).rejects.toThrow(/STEERING_DUPLICATE/);
    // A goal action is deliberately absent: goals are plan records with a proof.
    await expect(h.call('p2o_loop', { action: 'goal', text: 'take over the world' })).rejects.toThrow(/Unknown loop action/);
  }));

  it('bounds one instruction to 300 characters and the run to 24 hints and 12 constraints', async () => steeringFixture(async h => {
    await h.command('--target ./source');
    await expect(h.call('p2o_loop', { action: 'hint', text: 'ab' })).rejects.toThrow(/3..300 characters/);
    await expect(h.call('p2o_loop', { action: 'hint', text: 'a'.repeat(301) })).rejects.toThrow(/3..300 characters/);
    for (let index = 0; index < 24; index += 1) await h.call('p2o_loop', { action: 'hint', text: `hint ${index + 1}` });
    await expect(h.call('p2o_loop', { action: 'hint', text: 'one too many' })).rejects.toThrow(/STEERING_LIMIT/);
    for (let index = 0; index < 12; index += 1) await h.call('p2o_loop', { action: 'constrain', text: `constraint ${index + 1}` });
    await expect(h.call('p2o_loop', { action: 'constrain', text: 'one too many' })).rejects.toThrow(/STEERING_LIMIT/);
    const planner = await h.prompt();
    expect(planner).toContain('hint 24');
    expect(planner).toContain('constraint 12');
  }));

  it('keeps the steering facts readable from the durable store after the run stops', async () => steeringFixture(async h => {
    await h.command('--target ./source --goal "Assess the fixture cart"');
    await h.call('p2o_loop', { action: 'hint', text: 'Start from the upload endpoint' });
    await h.call('p2o_loop', { action: 'constrain', text: 'Never touch the payment flow' });
    const runId = (await readdir(join(h.root, '.p2o-state')))[0];
    await h.command('stop');
    // Durable-local keeps the committed records; a resuming reader sees the same append-only steering facts, not live memory.
    const reopened = AssessmentStore.open(join(h.root, '.p2o-state'), runId, { readOnly: true });
    try {
      const texts = reopened.records().filter((record: any) => record.kind === 'lifecycle' && record.data?.steering).map((record: any) => record.text);
      expect(texts).toEqual(['operator hint: Start from the upload endpoint', 'operator constraint: Never touch the payment flow']);
    } finally { reopened.close(); }
  }));
});
