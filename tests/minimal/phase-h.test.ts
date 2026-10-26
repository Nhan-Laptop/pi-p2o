import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { AssessmentEngine, type EngineDeps, type PlannerWake, type RoundProgress } from '../../src/engine.js';
import { completionDemand, deriveCompletion } from '../../src/completion.js';
import { plannerWakeMessage, plannerWakePrompt } from '../../src/planner-bridge.js';
import { plannerInstructions } from '../../src/prompts.js';
import type { ChainClaim } from '../../src/chain-view.js';
import type { PlanEntry } from '../../src/planning.js';

/**
 * Phase H acceptance (P16.2 + P16.7). A quiet round does not end an unfinished run: the demand names the obligation and the
 * loop stays live. Only nothing-owed (complete) or a lead-recorded blocked goes quiet. A worker that expired is continued
 * from its last write, not retried differently.
 */
function engineFixture(mode: 'manual' | 'event-driven' = 'event-driven') {
  const wakes: PlannerWake[] = [], problems: string[] = [];
  const deps: EngineDeps = {
    active: () => true, list: async () => [], readiness: async () => ({ ready: true }), capacity: () => 1, reap: async () => true,
    spawn: async () => undefined, persist: async () => undefined, wake: wake => wakes.push(wake), idle: () => true, problem: reason => problems.push(reason),
  };
  return { engine: new AssessmentEngine('run-h', mode, deps, 5), wakes, problems };
}
const QUIET: RoundProgress = { testedCells: 0, closures: 0, assets: 0, chainDepth: 0, remaining: 0 };
const plan = (overrides: Partial<PlanEntry>): PlanEntry => ({
  id: 'plan-x', runId: 'run-h', revision: 1, recordId: 'rec-plan-x', kind: 'todo', title: 'Fixture row', status: 'open',
  reason: 'Fixture plan row for the phase-h test', ...overrides,
} as PlanEntry);
const demonstrated = (recordId: string): ChainClaim => ({
  candidate: recordId, recordId, closure: 'confirmed', execution: 'tested', gained: [{ kind: 'http.request', subject: 'internal-api' }], surface: '/x',
} as unknown as ChainClaim);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the frontier floor outranks a quiet round (P16.2)', () => {
  it('demands the ready step by name and keeps the loop live instead of pausing', () => {
    const { engine, problems } = engineFixture();
    const owed: RoundProgress = { ...QUIET, remaining: 2, demand: 'step 2 of chain login ready and undispatched; 1 goal(s) not reviewed or closed' };
    engine.notify('worker-report', 'w1');
    engine.consume(engine.boundary()!.through, owed);
    engine.notify('worker-report', 'w2');
    engine.consume(engine.boundary()!.through, owed);
    expect(engine.quietRounds()).toEqual([1, 2]);
    engine.notify('worker-report', 'w3');
    const wake = engine.boundary()!;
    expect(wake.demand).toBeDefined();
    expect(wake.demand).toContain('quiet rounds 1 and 2 added nothing measurable');
    expect(wake.demand).toContain('step 2 of chain login');
    expect(wake.demand).toContain('1 goal(s) not reviewed or closed');
    // Nothing was refused and nothing went quiet: the wake is delivered and the engine stays live.
    expect(engine.snapshot().state).not.toBe('blocked');
    expect(engine.snapshot().paused).toBeUndefined();
    expect(problems).toEqual([]);
    expect(plannerWakePrompt(wake)).toContain('step 2 of chain login');
    expect(plannerWakeMessage(wake).content).toContain('Stalled round:');
    engine.consume(wake.through, owed);
    engine.notify('worker-report', 'w4');
    expect(engine.boundary()).toBeDefined();
    engine.stop();
  });

  it('falls back to the obligation count when the owner supplied no prose', () => {
    const { engine } = engineFixture();
    const owed: RoundProgress = { ...QUIET, remaining: 3 };
    engine.notify('worker-report', 'w1');
    engine.consume(engine.boundary()!.through, owed);
    engine.notify('worker-report', 'w2');
    engine.consume(engine.boundary()!.through, owed);
    engine.notify('worker-report', 'w3');
    expect(engine.boundary()!.demand).toContain('3 obligation(s) remain');
    engine.stop();
  });

  it('pauses when the lead recorded blocked, because that is the human decision the rule asks for', async () => {
    const { engine } = engineFixture();
    await engine.disposition('blocked', 'Needs a credential only the operator can supply');
    expect(engine.snapshot().state).toBe('blocked');
    engine.notify('worker-report', 'w1');
    expect(engine.boundary()).toBeUndefined();
    engine.resume();
    engine.notify('worker-report', 'w2');
    expect(engine.boundary()).toBeDefined();
    engine.stop();
  });
});

describe('completionDemand names what the quiet round still owes (P16.2)', () => {
  it('names the chain step and the goal, not a count', () => {
    const plans = [plan({ id: 'todo-1', step: 1, chainOf: 'login', claimRefs: ['rec-a'] }),
      plan({ id: 'todo-2', step: 2, chainOf: 'login', claimRefs: ['rec-b'], needs: [{ kind: 'http.request', subject: 'internal-api' }] }),
      plan({ id: 'goal-1', kind: 'goal', title: 'Show the login boundary', status: 'active', criteria: ['bounded'] })];
    const completion = deriveCompletion({ plans, claims: [demonstrated('rec-a')], tasks: [] });
    const demand = completionDemand(completion, plans)!;
    expect(demand).toContain('step 2 of chain login ready and undispatched');
    expect(demand).toContain('1 goal(s) not reviewed or closed');
    expect(completionDemand(deriveCompletion({ plans: [], claims: [], tasks: [] }), [])).toBeUndefined();
  });
});

describe('an expired worker is continued from where it stopped (P16.7)', () => {
  it('names continue and the brief that starts at the last write', () => {
    const prompt = plannerInstructions({ runId: 'run-h', targetLabel: 'https://example.invalid', targetKind: 'url', sourceSkipped: 0,
      delegation: { enabled: true, maxWorkers: 3, maxDepth: 2 } });
    expect(prompt).toContain('its progress is in the ledger and its conversation is resumable');
    expect(prompt).toContain('continue it on the same ticket');
    expect(prompt).toContain('dispatch a new task with a different mechanism');
    // The lead prompt still carries no tool-name vocabulary; the tool itself owns the exact verb.
    expect(prompt).not.toMatch(/\bp2o_[a-z_]+\b/);
  });
});
