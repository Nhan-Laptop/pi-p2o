import { DECLARATION_BUDGET, LEAD_CEILINGS } from './helpers/budgets.js';
import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerP2O } from '../../extensions/p2o/index.js';
import { AssessmentStore } from '../../src/state/store.js';
import { ALL_TOOLS, DELEGATION_TOOLS, TARGET_TOOLS, ownerTools, workerTools } from '../../src/tool-policy.js';
import { POLICY_VERSION, TOOL_GUIDELINES } from '../../src/tool-guidelines.js';
import { DEFAULT_TOOL_GUIDANCE, parseSettings } from '../../src/roles.js';
import { ownerInstructions, workerBrief, workerInstructions } from '../../src/prompts.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

/**
 * W3 (plan): the model is taught the K3–K6 workflow through short per-tool guidelines (the lead's own policy section keeps its pinned size
 * and stays free of tool names), tool and guideline names cannot drift, fixed context cost cannot grow silently, and p2o_delegate gets the
 * same exact-work admission as p2o_task when structured work is supplied. Mechanism only: whether the guidance improves results needs an
 * authorized benchmark and is deliberately not claimed here.
 */
const registry = (toolGuidance: boolean | 'missing' = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'p2o-guidance-')), settingsPath = join(dir, 'settings.json');
  if (toolGuidance !== 'missing') writeFileSync(settingsPath, JSON.stringify({ p2o: { toolGuidance } }));
  try { const pi = createFakePi(); registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, settingsPath } as any); return pi.tools; } finally { rmSync(dir, { recursive: true, force: true }); }
};
const declaration = (tools: Map<string, any>, names: string[]) => names.reduce((sum, name) => { const tool = tools.get(name); return sum + Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })); }, 0);
const guidance = (tools: Map<string, any>, names: string[]) => names.reduce((sum, name) => sum + Buffer.byteLength((tools.get(name).promptGuidelines ?? []).join('\n')), 0);
const facts = (enabled: boolean) => ({ runId: 'run-x', targetLabel: '/home/x/repo', targetKind: 'directory' as const, sourceSkipped: 0, delegation: { enabled, maxWorkers: enabled ? 3 : 0, maxDepth: enabled ? 2 : 0, reason: enabled ? undefined : 'solo' }, workerBudget: 600, phase: 'active' as const, loopMode: 'event-driven' as const, executorMode: 'isolated' as const });
const ticket = (role: string) => ({ workerId: 'worker-1', role, depth: 1, parentWorkerId: null, target: { kind: 'directory', label: '/home/x/repo' }, executorMode: 'shared' } as any);
const mentioned = (text: string) => new Set(text.match(/\bp2o_[a-z_]+\b/g) ?? []);
const loadouts: Record<string, string[]> = { 'delegated Planner': ownerTools(true), 'solo owner': ownerTools(false), 'worker': workerTools('discovery'), 'reporting worker': workerTools('reporting') };

describe('tool guidance is opt-in (benchmark 2026-10-10: it steers tool use but raised cost without a quality gain)', () => {
  it('is off unless p2o.toolGuidance is true, for a missing, malformed or false setting alike', () => {
    for (const setting of ['missing', false] as const) for (const tool of registry(setting).values()) expect(tool.promptGuidelines, `${tool.name} with toolGuidance=${String(setting)}`).toBeUndefined();
    expect(registry(true).get('p2o_case').promptGuidelines).toEqual([...TOOL_GUIDELINES.p2o_case]);
    expect(DEFAULT_TOOL_GUIDANCE).toBe(false);
    expect(parseSettings({ p2o: { toolGuidance: 'yes' } }).toolGuidance).toBe(false); expect(parseSettings({ p2o: { toolGuidance: 1 } }).toolGuidance).toBe(false);
    expect(parseSettings({ p2o: { toolGuidance: true } }).toolGuidance).toBe(true); expect(parseSettings({}).toolGuidance).toBe(false);
  });
});

describe('prompt and tool guidance cannot drift apart', () => {
  it('attaches the guidance to the registered tool it is about and names only tools that exist', () => {
    const tools = registry(), registered = new Set(tools.keys());
    for (const [name, lines] of Object.entries(TOOL_GUIDELINES)) {
      expect(registered.has(name), `${name} has guidance but is not registered`).toBe(true);
      expect(tools.get(name).promptGuidelines, name).toEqual([...lines]);
      for (const named of mentioned(lines.join('\n'))) expect(registered.has(named), `${name} guidance names ${named}`).toBe(true);
    }
    for (const prompt of [ownerInstructions(facts(true)), ownerInstructions(facts(false)), ...['recon', 'discovery', 'validation', 'reporting', 'general'].map(role => workerInstructions(ticket(role)))])
      for (const named of mentioned(prompt)) expect(registered.has(named), `a prompt names ${named}`).toBe(true);
    for (const name of ALL_TOOLS) expect(registered.has(name), name).toBe(true);
  });

  it('names only tools its own role can call, in the system instructions and in the brief', () => {
    for (const kind of ['directory', 'url'] as const) for (const role of ['recon', 'discovery', 'validation', 'reporting', 'general']) {
      const worker = { ...ticket(role), target: { kind, label: kind === 'url' ? 'https://example.invalid' : '/home/x/repo' }, commandBudget: 20 };
      const text = `${workerInstructions(worker)}\n${workerBrief({ ticket: worker, focus: 'surface-recon', task: 'Map authorized inputs', context: 'No previous work' })}`;
      for (const named of mentioned(text)) expect(workerTools(role), `${role}/${kind}: the worker prompt names ${named}`).toContain(named);
    }
  });

  it('gives every knowledge-workflow tool guidance, or a stated reason why not, and never advises a role about a tool it cannot call', () => {
    const exempt: Record<string, string> = { p2o_artifact: 'its description already says to read retained output by ID in bounded ranges' };
    for (const name of ['p2o_task', 'p2o_delegate', 'p2o_case', 'p2o_coverage', 'p2o_graph', 'p2o_state', 'p2o_capture', 'p2o_plan', 'p2o_finish', 'p2o_artifact'])
      expect(TOOL_GUIDELINES[name] !== undefined || exempt[name] !== undefined, `${name} needs guidance or an exemption`).toBe(true);
    for (const [label, names] of Object.entries(loadouts))
      for (const name of names) for (const named of mentioned((TOOL_GUIDELINES[name] ?? []).join('\n'))) expect(names, `${label}: guidance on ${name} names ${named}`).toContain(named);
    expect(workerTools('reporting')).not.toContain('p2o_capture'); expect(TOOL_GUIDELINES.p2o_capture.join(' ')).not.toMatch(/p2o_(?:case|plan|coverage)/);
  });

  it('keeps the guidance short, versioned and free of authority claims', () => {
    const tools = registry();
    expect(POLICY_VERSION).toBeGreaterThanOrEqual(1);
    // P15 (R7): the payload/environment order-of-work advice moved out of the p2o_lab declaration into its guideline, so both owner
    // loadouts carry 180 more bytes of guidance. The ceiling rises on purpose; the worker ceilings do not move.
    expect(guidance(tools, loadouts['delegated Planner'])).toBeLessThanOrEqual(1400); expect(guidance(tools, loadouts['solo owner'])).toBeLessThanOrEqual(1400);
    expect(guidance(tools, loadouts.worker)).toBeLessThanOrEqual(800); expect(guidance(tools, loadouts['reporting worker'])).toBeLessThanOrEqual(800);
    for (const line of Object.values(TOOL_GUIDELINES).flat()) { expect(line.length).toBeLessThanOrEqual(260); expect(line).not.toMatch(/\b(?:you are authorized|ignore|bypass|widen scope)\b/i); }
    expect(TOOL_GUIDELINES.p2o_delegate.join(' ')).toContain('without work the identity is unknown');
  });

  it('leaves the lead policy section and worker guidance untouched: no tool names in the lead prompt', () => {
    for (const enabled of [true, false]) expect(ownerInstructions(facts(enabled))).not.toMatch(/\bp2o_[a-z_]+\b/);
    // The 5,300-character ceiling of the lead prompt is pinned by recon.test.ts; adding guidance to tools must not eat into it.
    const base = { runId: 'run-recon', targetLabel: 'https://example.invalid', targetKind: 'url' as const, sourceSkipped: 2, delegation: { enabled: false, maxWorkers: 1, maxDepth: 1 }, workerBudget: 20 };
    expect(ownerInstructions(base).length).toBeLessThan(LEAD_CEILINGS.soloUrl);
  });

  it('no longer advertises the removed 60 s / 300 s command ceilings', () => {
    const tools = registry();
    for (const name of ['p2o_shell', 'p2o_net', 'p2o_http']) expect(tools.get(name).description, name).not.toMatch(/60-second|300-second|ceiling of 60|ceiling of 300/i);
  });
});

describe('the worker-control tools are offered only when workers exist', () => {
  it('keeps p2o_delegate and p2o_workers (steer/stop folded into it, S2) out of the solo loadout, and the target tools out of the delegated one', () => {
    expect(DELEGATION_TOOLS).toEqual(['p2o_delegate', 'p2o_workers']);
    for (const name of DELEGATION_TOOLS) { expect(ownerTools(true), name).toContain(name); expect(ownerTools(false), name).not.toContain(name); expect(workerTools('discovery'), name).not.toContain(name); }
    for (const name of TARGET_TOOLS) { expect(ownerTools(false), name).toContain(name); expect(ownerTools(true), name).not.toContain(name); }
    expect(ownerTools(false)).toContain('p2o_loop'); // engine and frontier status stay available to a solo owner
    // 2026-10-22 (planning_update.md P14.2): p2o_lab belongs to both executing loadouts, so both counts moved by one.
    // 2026-10-23 (planning_update.md P14.8): p2o_research is offered to every loadout, so both counts moved by one again.
    expect(ownerTools(false)).toHaveLength(21); expect(ownerTools(true)).toHaveLength(19);
  });
});

describe('fixed context cost per loadout is budgeted (plan principle 16)', () => {
  // Sizes measured on 2026-10-10 after W3 (delegate work params, trimmed ceilings) and W4 (p2o_state search), plus 2% headroom. Baseline before the W phase was
  // 35,514 / 39,904 / 20,458 / 13,627 bytes of declarations (+2.1% / +1.8% / +1.4% / +2.5%). A change that grows a loadout must raise the number here on purpose.
  // 2026-10-11 (S2): the solo owner no longer carries the four worker-control tools (-3,636 B declarations, -179 B guidance), so its budget fell to 36,967 / 921.
  // 2026-10-11 (P1-P6a of the workflow/report plan, deliberate): p2o_case gained the rate action and its finding schema (+952 B), p2o_coverage the suggest action (+231 B),
  // p2o_finish the narrative parameter (+167 B), p2o_task externalEvidence (+38 B). Delegated Planner 36,268 -> 37,656 B and solo owner 36,967 -> 38,355 B (+3.8%); workers are unchanged.
  // 2026-10-11 (extension audit S1): enum parameters are declared as {type:'string', enum} (src/schema-kit.ts) instead of an anyOf of const literals: Planner 37,656 -> 32,310 B (-14.2%),
  // solo owner 38,355 -> 33,328 B, worker 20,750 -> 18,038 B, reporting worker 13,974 -> 11,540 B. Guidance is unchanged.
  // 2026-10-11 (planning_update.md 3.3): the p2o_skill_list description tells the lead and workers to check the catalog before assigning or starting work (+105 B in every loadout; guidance is unchanged).
  // 2026-10-12 (planning_update.md P1.2): new p2o_surface tool (owner + worker loadouts) for a cheap normalized component/entryPoint dedup hint, separate from p2o_note. Declarations rose by
  // one tool's worth of bytes in every loadout that carries it (reporting worker keeps it too, same as p2o_note); guidance is unchanged since p2o_surface has no promptGuidelines entry.
  // 2026-10-13 (planning_update.md --refer-workspace, E3): p2o_state's guidance gained one sentence pointing at domain=reference heads as prior-run context, never same-run evidence
  // (+159 B guidance in every loadout that carries p2o_state, i.e. all four; declarations unchanged). POLICY_VERSION bumped to 2.
  // 2026-10-21 (chain capability, deliberate): p2o_candidate gained provides/requires so a worker can name the capability edge a later step consumes (+387 B in the worker
  // loadouts), and p2o_case's finding schema gained the ordered `chain` block the owner rates an assembled chain through (+781 B where p2o_case is carried). Guidance is
  // unchanged and POLICY_VERSION stays 2. Chains are recorded structurally here, so no separate chain text is added to the fixed-cost guidance.
  // 2026-10-22 (planning_update.md P1): p2o_delegate's description now names what a purpose decides, so the lead picks one deliberately (+245 B in the
  // delegated Planner loadout only; solo owner carries no delegate tool). Guidance is unchanged and POLICY_VERSION stays 2.
  // 2026-10-22 (planning_update.md P5): p2o_graph gained the read-only `chain` action and one sentence naming it (+95 B in every
  // loadout, since all four carry the graph tool). Guidance is unchanged and POLICY_VERSION stays 2.
  // 2026-10-22 (planning_update.md P7): the delegate description names purpose as the source of the default skill set (+52 B,
  // delegated Planner only — the other three loadouts carry no delegate tool). Guidance is unchanged and POLICY_VERSION stays 2.
  const budget = DECLARATION_BUDGET; // P13(f): the numbers live in tests/minimal/helpers/budgets.ts
  it('keeps tool declarations and guidance inside the recorded budget', () => {
    const tools = registry();
    for (const [label, names] of Object.entries(loadouts)) {
      const [declared, guided] = budget[label as keyof typeof budget];
      expect(declaration(tools, names), `${label} declarations`).toBeLessThanOrEqual(Math.ceil(declared * 1.02)); expect(guidance(tools, names), `${label} guidance`).toBeLessThanOrEqual(Math.ceil(guided * 1.02));
    }
  });
});

describe('p2o_delegate admission (D3)', () => {
  async function fixture(work: (h: any) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'p2o-delegate-')); await mkdir(join(root, 'source'));
    const pi = createFakePi(), ctx = createContext({ cwd: root }), herdr = createSimpleHerdr(), sandboxes: InertSandbox[] = [];
    registerP2O(pi.pi, { extensionPath: EXTENSION_PATH, controlRoot: join(root, 'control'), settingsPath: join(root, 'settings.json'), herdr: herdr.client, createSandbox: (target: any) => { const sandbox = new InertSandbox(target); sandboxes.push(sandbox); return sandbox; } });
    const command = (text: string) => pi.commands.get('p2o').handler(text, ctx.ctx), call = (name: string, params: any = {}) => pi.tools.get(name).execute(randomUUID(), params, undefined, undefined, ctx.ctx);
    const events = async () => { const store = AssessmentStore.open(join(root, '.p2o-state'), (await readdir(join(root, '.p2o-state')))[0]); try { return store.events({ limit: 100 }).rows; } finally { store.close(); } };
    try { await command('--target ./source'); await work({ call, events, command, sandboxes }); } finally { await command('stop'); await command('close'); await rm(root, { recursive: true, force: true }); }
  }
  const structured = (assetId: string, questionKey = 'policy:fixture') => ({ focus: 'structured', task: 'Observe the inert fixture boundary and report', role: 'discovery',
    work: { assetRefs: [{ id: assetId, revision: 1 }], questionKey, actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'source-trace', purpose: 'investigation' },
    decision: { disposition: 'new', reason: 'No prior matching structured attempt exists' }, outputContract: { kind: 'investigation', required: ['evidence', 'gaps'], partialAllowed: true, artifactPolicy: 'ids-only' } });

  it('runs the exact-work conflict check when work is supplied and reports an unknown identity when it is not', async () => fixture(async h => {
    const asset = (await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /delegate-fixture' } }] } })).details.acks[0];
    const first = (await h.call('p2o_delegate', structured(asset.entityId))).details;
    expect(first).toMatchObject({ workMatch: 'structured' }); expect(first.taskId).toMatch(/^task-/);
    await expect(h.call('p2o_delegate', structured(asset.entityId))).rejects.toThrow(/ASSIGNMENT_CONFLICT|already/i); // the same exact work is already active
    const other = (await h.call('p2o_delegate', structured(asset.entityId, 'policy:other-question'))).details; // a different question on the same asset is not suppressed
    expect(other.workMatch).toBe('structured'); expect(other.workerId).not.toBe(first.workerId);

    const legacy = await h.call('p2o_delegate', { focus: 'legacy', task: 'Observe the inert fixture legacy path and report', role: 'discovery' });
    expect(legacy.details.workMatch).toBe('unknown'); expect(legacy.content[0].text).toContain('Work identity is unknown');
    const rows = await h.events(); const unstructured = rows.filter((event: any) => event.kind === 'delegate.unstructured');
    expect(unstructured).toHaveLength(1); expect(unstructured[0]).toMatchObject({ actorId: 'owner', taskId: legacy.details.taskId });
    expect(rows.filter((event: any) => event.kind === 'delegate.unstructured' && event.taskId === first.taskId)).toHaveLength(0); // structured delegation is not flagged
  }));

  it('rejects malformed structured work before any pane or worker exists', async () => fixture(async h => {
    const asset = (await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /delegate-bad' } }] } })).details.acks[0];
    const bad = structured(asset.entityId); (bad.work as any).purpose = 'not-a-purpose';
    await expect(h.call('p2o_delegate', bad)).rejects.toThrow(); expect((await h.call('p2o_workers')).details.workers).toHaveLength(0);
    await expect(h.call('p2o_delegate', { ...structured(asset.entityId), decision: undefined })).rejects.toThrow(); expect((await h.call('p2o_workers')).details.workers).toHaveLength(0);
  }));
});
