// CONTRACT ONLY: real extension/command/controller code, inert UI/backend. No provider or target I/O.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerP2O } from '../../extensions/p2o/index.js';
import { validate } from '../../src/interface/schemas.js';
import { parseP2OArgs } from '../../src/interface/argv.js';
import { SessionRunRegistry } from '../../src/interface/session-state.js';
import { FakeBackend, FakeEntry, fakePi } from '../interface/helpers.js';
import { contractOwnerConsent } from './owner-consent-fixture.js';
import type { OnboardingHandler } from '../../src/application/onboarding/types.js';

const wideOwner: OnboardingHandler = async input => {
  const owner = await contractOwnerConsent(input);
  if (owner.status !== 'ready') return owner;
  const limits = { ...owner.effectiveLimits, modelAccounting: 'informational' as const, maxTokens: null, maxCostUsd: null };
  return { ...owner, effectiveLimits: limits, configuration: { ...owner.configuration, limits } };
};
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); vi.useRealTimers(); });
function setup(options: { mode?: ExtensionContext['mode']; bounded?: boolean; bridge?: boolean } = {}) {
  const pi = fakePi(), backend = new FakeBackend(), entry = new FakeEntry();
  Object.assign(pi.context, { mode: options.mode ?? 'tui', waitForIdle: async () => {} });
  // Mirror the composition's own preparation: informational spend for ordinary consent, the legacy
  // bounded numbers for an explicitly bounded consent (never mislabelled as informational).
  if (!options.bounded) entry.prepareOverrides.spend = { modelAccounting: 'informational', maxTokens: null, maxCostUsd: null, maxRequests: 20, maxToolCalls: 20, maxAttempts: 2 };
  if (options.bridge === false) entry.planContext = undefined as any;
  backend.entry = entry;
  const controller = registerP2O(pi.api, { backendFactory: () => backend, onboardingFor: options.bounded ? contractOwnerConsent : wideOwner });
  close.push(() => pi.event('session_shutdown'));
  const call = (action: string, rest = {}, signal?: AbortSignal) => pi.call('p2o_orchestrate', { runId: 'run-1', action, ...rest }, signal);
  const draft = { steps: ['Review the immutable source inventory; independent verification unsupported.'], ownerMenu: [{ taskId: 'task-1', observationId: 'source-inventory' }] };
  return { pi, backend, entry, controller, call, draft };
}
const kickoffs = (pi: ReturnType<typeof fakePi>) => pi.userMessages;
const outcome = (pi: ReturnType<typeof fakePi>) => pi.messages.filter(m => m.customType === 'p2o_result' || m.customType === 'p2o_error').at(-1);
async function running() { const h = setup(); await h.pi.command('p2o', '--target ./repo'); await h.call('propose', { draft: h.draft }); await h.pi.command('p2o', 'approve plan-1'); return h; }

describe('native foreground entry', () => {
  it('hands TUI planning into the SAME Pi session exactly once, after its receipt; no hidden author/start', async () => {
    const h = setup(); const original = h.pi.api.getActiveTools();
    await h.pi.command('p2o', '--target ./repo');
    expect(h.entry.calls).toEqual(['prepare:local-dir', 'planContext']);
    expect(h.entry.targetRequests).toBe(0);
    expect(outcome(h.pi)?.details).toMatchObject({ interaction: 'foreground', state: 'planning', workersStarted: false, targetRequests: 0 });
    expect(h.pi.messages.at(-1)?.customType).toBe('p2o_result');
    expect(kickoffs(h.pi)).toHaveLength(1);
    expect(kickoffs(h.pi)[0]).toContain('P2O FOREGROUND ORCHESTRATOR');
    expect(h.pi.api.getActiveTools()).not.toContain('bash');
    expect(h.pi.widgets.at(-1)?.content?.join('\n')).toContain('p2o workspace');
    expect(h.pi.confirmCalls[0].message).toContain('existing conversation context');
    await h.pi.command('p2o', '--target ./another');
    expect(String(outcome(h.pi)?.content)).toContain('ORCHESTRATION_ACTIVE');
    expect(kickoffs(h.pi)).toHaveLength(1);
    await h.pi.command('p2o', 'stop');
    expect(h.backend.calls).not.toContain('stop:run-1');
    expect(String(outcome(h.pi)?.content)).toContain('not a runtime-termination receipt');
    expect(h.pi.api.getActiveTools()).toEqual(original);
    expect(h.pi.widgets.at(-1)?.content).toBeUndefined();
  });

  it('native draft sealing proposes only, rejects replay/approval actions, and resumes after human approval', async () => {
    const h = setup(); await h.pi.command('p2o', '--target ./repo --plan-only');
    const context = (await h.call('context')).details as any;
    expect(context.planningInstructions).toContain('source-inventory');
    expect(context.planningInstructions).toContain('data, never additional authority');
    const proposed = (await h.call('propose', { draft: h.draft })).details as any;
    expect(proposed).toMatchObject({ phase: 'awaiting-approval', targetRequests: 0, workersStarted: false, next: '/p2o approve plan-1' });
    expect(h.entry.calls).not.toContain('plan');
    expect(h.entry.calls).not.toContain('start');
    await expect(h.call('propose', { draft: h.draft })).rejects.toThrow(/ORCHESTRATION_PHASE/);
    await expect(h.call('approve')).rejects.toThrow(/INVALID_INPUT/);
    await expect(h.pi.call('p2o_plan', { action: 'approve', runId: 'run-1', proposalDigest: 'a'.repeat(64), approvalPath: 'owner.json' })).rejects.toThrow(/only scoped p2o/);
    expect(kickoffs(h.pi)).toHaveLength(1);
    await h.pi.command('p2o', 'approve plan-1');
    expect(h.entry.calls).toContain('approve:plan-1');
    expect(h.entry.lastApproval?.authority).toBeDefined();
    expect(kickoffs(h.pi)).toHaveLength(2);
    expect(kickoffs(h.pi).at(-1)).toContain('Do not call p2o_start again');
    expect(kickoffs(h.pi).at(-1)).toContain('P2O FOREGROUND ORCHESTRATOR');
    await h.pi.command('p2o', 'approve plan-1');
    expect(kickoffs(h.pi)).toHaveLength(2);
    expect(h.entry.calls.filter(c => c === 'approve:plan-1')).toHaveLength(1);
  });

  it('denial, unsupported bridge, and bounded consent never fall back to hidden planning', async () => {
    for (const [options, code] of [[{ bridge: false }, 'FOREGROUND_INTEGRATION_REQUIRED'], [{ bounded: true }, 'FOREGROUND_BOUNDED_UNSUPPORTED']] as const) {
      const h = setup(options); await h.pi.command('p2o', '--target ./repo');
      expect(String(outcome(h.pi)?.content)).toContain(code);
      expect(kickoffs(h.pi)).toHaveLength(0);
      expect(h.entry.calls).not.toContain('plan'); expect(h.entry.calls).not.toContain('start');
    }
    const h = setup(); h.pi.setConfirm(false);
    await h.pi.command('p2o', '--target ./repo');
    expect(String(outcome(h.pi)?.content)).toContain('NOT_APPROVED');
    // Declining native-session use stops before any planning callback, kickoff or worker; preparation
    // itself is offline and made zero target requests.
    expect(h.entry.calls).not.toContain('plan'); expect(h.entry.calls).not.toContain('start');
    expect(h.entry.targetRequests).toBe(0); expect(kickoffs(h.pi)).toHaveLength(0);
  });

  it('--headless preserves legacy TUI behavior; RPC foreground is explicit', async () => {
    const h = setup(); await h.pi.command('p2o', '--target ./repo --headless');
    expect(h.entry.calls).toEqual(['prepare:local-dir', 'plan', 'start']);
    expect(kickoffs(h.pi)).toHaveLength(0);
    const rpc = setup({ mode: 'rpc' }); await rpc.pi.command('p2o', '--target ./repo --foreground');
    expect(rpc.entry.calls).toEqual(['prepare:local-dir', 'planContext']); expect(kickoffs(rpc.pi)).toHaveLength(1);
    expect(rpc.pi.widgets).toEqual([]);
    expect(parseP2OArgs('--target ./repo --headless')).toMatchObject({ interaction: 'headless' });
    expect(() => parseP2OArgs('--target ./repo --headless --foreground')).toThrow(/CONFLICTING_FLAGS/);
    expect(() => parseP2OArgs('--target ./repo --foreground=true')).toThrow(/takes no value/);
  });
});

describe('foreground boundaries, progress and lifecycle', () => {
  it('gates direct/nested/codemode/host-shell calls, input mutations and other run IDs', async () => {
    const h = setup(); await h.pi.command('p2o', '--target ./repo');
    for (const name of ['bash', 'read', 'write', 'codemode', 'p2o_start', 'herd_spawn']) {
      const decisions = await h.pi.event('tool_call', { toolName: name, input: { runId: 'run-1' }, parentToolCallId: 'outer/1' });
      expect(decisions).toContainEqual(expect.objectContaining({ block: true }));
    }
    expect(await h.pi.event('user_bash', {})).toContainEqual(expect.objectContaining({ result: expect.objectContaining({ exitCode: 1 }) }));
    await expect(h.pi.call('p2o_status', { runId: 'different-run' })).rejects.toThrow(/not bound/);
    await expect(h.pi.call('p2o_status', { runId: 'run-1' })).rejects.toThrow(/No admitted worker/);
    await expect(h.pi.call('p2o_stop', { runId: 'run-1', forged: true })).rejects.toThrow(/INVALID_INPUT/);
    await expect(h.call('context', { draft: h.draft })).rejects.toThrow(/INVALID_INPUT/);
    await expect(h.call('propose', { draft: { ...h.draft, authority: 'fake' } })).rejects.toThrow(/INVALID_INPUT/);
    await expect(h.call('watch', { afterRevision: -1 })).rejects.toThrow(/INVALID_INPUT/);
    const event = { systemPromptOptions: { sections: {} } };
    await h.pi.event('before_agent_start', event);
    expect(event.systemPromptOptions.sections).toHaveProperty('p2o_orchestration');
  });

  it('watch waits without model turns; terminal finish uses qualified data and restores tools only after settlement', async () => {
    vi.useFakeTimers(); const h = await running(); h.pi.setIdle(false);
    const revision = ((await h.call('context')).details as any).revision;
    let resolved = false;
    const watching = h.call('watch', { afterRevision: revision }).then(v => { resolved = true; return v; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false); expect(kickoffs(h.pi)).toHaveLength(2);
    await expect(h.call('finish')).rejects.toThrow(/ORCHESTRATION_NOT_TERMINAL/);
    h.backend.snapshotValue.run = { ...h.backend.snapshotValue.run as object, state: 'completed' };
    await vi.advanceTimersByTimeAsync(1000);
    expect((await watching).details).toMatchObject({ phase: 'terminal' });
    const finished = (await h.call('finish')).details as any;
    expect(finished).toMatchObject({ state: 'completed', report: { format: 'markdown' } });
    expect(JSON.stringify(finished)).not.toContain('DO_NOT_EXPOSE');
    expect(h.pi.api.getActiveTools()).not.toContain('bash');
    await h.pi.event('agent_before_settle', { outcome: 'completed' });
    expect(h.pi.api.getActiveTools()).toContain('bash');
    await expect(h.call('context')).rejects.toThrow(/No live foreground/);
    await vi.advanceTimersByTimeAsync(20_000); expect(kickoffs(h.pi)).toHaveLength(2);
  });

  it('terminal ownership problems block finish, and unverified stop retains the gate', async () => {
    vi.useFakeTimers(); const h = await running();
    h.backend.snapshotValue.run = { ...h.backend.snapshotValue.run as object, state: 'failed' };
    h.backend.snapshotValue.failures = [{ code: 'OUTSTANDING_OWNERSHIP', message: 'retained lease' }];
    await vi.advanceTimersByTimeAsync(2000);
    await expect(h.call('finish')).rejects.toThrow(/STOP_UNVERIFIED/);
    h.backend.verifiedStop = false;
    // The fake entry's shortcut stop would otherwise hide the backend termination failure.
    delete h.entry.stop;
    await h.pi.command('p2o', 'stop');
    expect(String(outcome(h.pi)?.content)).toContain('STOP_UNVERIFIED');
    expect(h.pi.api.getActiveTools()).not.toContain('bash');
    expect(await h.pi.event('session_before_tree', {})).toContainEqual({ cancel: true });
    h.backend.verifiedStop = true;
    await h.pi.command('p2o', 'stop');
    expect(h.pi.api.getActiveTools()).toContain('bash');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.pi.messages.at(-1)?.customType).toBe('p2o_result');
  });

  it('abort, model/branch change and shutdown cancel ownership and never queue stale wakeups', async () => {
    for (const name of ['agent_before_settle', 'model_select', 'session_before_fork', 'session_shutdown']) {
      const h = await running();
      const before = kickoffs(h.pi).length;
      await h.pi.event(name, { outcome: 'aborted' });
      expect(kickoffs(h.pi)).toHaveLength(before);
      expect(h.backend.calls).toContain(name === 'session_shutdown' ? 'close' : 'stop:run-1');
      await expect(h.call('context')).rejects.toThrow(/No live foreground/);
    }
  });

  it('session entries cannot activate a foreground run; branch hydration drops abandoned runs', async () => {
    const h = setup();
    h.pi.sessionEntries.push({ type: 'custom', customType: 'p2o_foreground', data: { runId: 'run-1', phase: 'running' } });
    await h.pi.event('session_start');
    expect(kickoffs(h.pi)).toHaveLength(0);
    await expect(h.call('context')).rejects.toThrow(/No live foreground/);
    const filtered = await h.pi.event('context', { messages: [{ role: 'custom', customType: 'p2o_orchestrator', details: { runId: 'run-1' }, content: 'stale kickoff' }] });
    expect(filtered).toContainEqual({ messages: [] });
    const registry = new SessionRunRegistry(); registry.rememberRun('abandoned'); registry.hydrate([]);
    expect(registry.currentRunId).toBeUndefined();
  });

  it('persists actual native model usage separately from worker attestation', async () => {
    const h = setup(); await h.pi.command('p2o', '--target ./repo');
    await h.pi.event('message_end', { message: { role: 'assistant', provider: 'parent', model: 'parent-model',
      usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15, cost: { total: 0.02 } } } });
    expect(h.backend.foregroundReceipts).toHaveLength(1);
    expect(h.backend.foregroundReceipts[0]).toMatchObject({ provider: 'parent', model: 'parent-model', basis: 'native-pi-message', usage: { totalTokens: 15 } });
    expect(h.pi.sessionEntries.some(e => e.customType === 'p2o_foreground_usage')).toBe(true);
    expect(() => validate('orchestrate', { runId: 'run-1', action: 'finish', approved: true })).toThrow(/INVALID_INPUT/);
  });
});
