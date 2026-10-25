import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerP2O } from '../../extensions/p2o/index.js';
import { AssessmentStore } from '../../src/state/store.js';
import { ALL_TOOLS, DELEGATION_TOOLS, TARGET_TOOLS, ownerTools, workerTools } from '../../src/tool-policy.js';
import { TOOL_BOUNDARIES } from '../../src/tool-guidelines.js';
import { ownerInstructions, workerBrief, workerInstructions } from '../../src/prompts.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

/**
 * W3 (plan): the model is taught the K3–K6 workflow through short per-tool guidelines (the lead's own policy section keeps its pinned size
 * and stays free of tool names), tool and guideline names cannot drift, fixed context cost cannot grow silently, and p2o_delegate gets the
 * same exact-work admission as p2o_task when structured work is supplied. Mechanism only: whether the guidance improves results needs an
 * authorized benchmark and is deliberately not claimed here.
 */
const registry = () => {
  const pi = createFakePi();
  registerP2O(pi.pi, { extensionPath: EXTENSION_PATH } as any);
  return pi.tools;
};
const declaration = (tools: Map<string, any>, names: string[]) => names.reduce((sum, name) => { const tool = tools.get(name); return sum + Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })); }, 0);
const guidance = (tools: Map<string, any>, names: string[]) => names.reduce((sum, name) => sum + Buffer.byteLength((tools.get(name).promptGuidelines ?? []).join('\n')), 0);
const facts = (enabled: boolean) => ({ runId: 'run-x', targetLabel: '/home/x/repo', targetKind: 'directory' as const, sourceSkipped: 0, delegation: { enabled, maxWorkers: enabled ? 3 : 0, maxDepth: enabled ? 2 : 0, reason: enabled ? undefined : 'solo' }, workerBudget: 600, phase: 'active' as const, loopMode: 'event-driven' as const, executorMode: 'isolated' as const });
const ticket = (role: string) => ({ workerId: 'worker-1', role, depth: 1, parentWorkerId: null, target: { kind: 'directory', label: '/home/x/repo' }, executorMode: 'shared' } as any);
const mentioned = (text: string) => new Set(text.match(/\bp2o_[a-z_]+\b/g) ?? []);
const loadouts: Record<string, string[]> = { 'owner': ownerTools(), 'worker': workerTools('discovery'), 'reporting worker': workerTools('reporting') };

describe('tool descriptions carry the boundary (Part XI: no separate guidance layer)', () => {
  it('folds every boundary sentence into the registered description and never sets promptGuidelines', () => {
    const tools = registry();
    for (const name of ALL_TOOLS) {
      const tool = tools.get(name);
      expect(tool, name).toBeDefined();
      for (const line of TOOL_BOUNDARIES[name] ?? []) expect(tool.description, name).toContain(line);
      expect(tool.promptGuidelines, name).toBeUndefined();
    }
    for (const [name, lines] of Object.entries(TOOL_BOUNDARIES)) for (const named of mentioned(lines.join(' '))) expect(ALL_TOOLS, `${name} names ${named}`).toContain(named);
  });

  it('names only tools its own role can call, in the system instructions and in the brief', () => {
    for (const kind of ['directory', 'url'] as const) for (const role of ['recon', 'discovery', 'validation', 'reporting', 'general']) {
      const worker = { ...ticket(role), target: { kind, label: kind === 'url' ? 'https://example.invalid' : '/home/x/repo' } };
      const text = `${workerInstructions(worker)}\n${workerBrief({ ticket: worker, focus: 'surface-recon', task: 'Map authorized inputs', context: 'No previous work' })}`;
      for (const named of mentioned(text)) expect(workerTools(role), `${role}/${kind}: the worker prompt names ${named}`).toContain(named);
    }
  });

  it('leaves the lead policy section free of tool names', () => {
    for (const enabled of [true, false]) expect(ownerInstructions(facts(enabled))).not.toMatch(/\bp2o_[a-z_]+\b/);
  });

  it('no longer advertises the removed 60 s / 300 s command ceilings', () => {
    const tools = registry();
    for (const name of ['p2o_shell', 'p2o_net', 'p2o_http']) expect(tools.get(name).description, name).not.toMatch(/60-second|300-second|ceiling of 60|ceiling of 300/i);
  });
});

describe('one owner role holds every owner tool (Part XI)', () => {
  it('offers delegation and target tools to the same lead loadout', () => {
    expect(DELEGATION_TOOLS).toEqual(['p2o_delegate', 'p2o_workers']);
    expect(ownerTools()).toHaveLength(new Set(ownerTools()).size);
    for (const name of DELEGATION_TOOLS) { expect(ownerTools(), name).toContain(name); expect(workerTools('discovery'), name).not.toContain(name); }
    for (const name of TARGET_TOOLS) expect(ownerTools(), name).toContain(name);
    expect(ownerTools()).toContain('p2o_loop');
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
