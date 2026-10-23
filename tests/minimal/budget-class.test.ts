import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKER_COMMAND_BUDGET, EXPLOITATION_COMMAND_BUDGET, budgetWrapUpRequired, commandBudgetFor } from '../../src/broker.js';
import { dutyLine } from '../../src/duties.js';
import { validateWorkSpec, workIdentity } from '../../src/work.js';

/**
 * P14.11. 200 brokered commands is a recon allowance: exploitation builds, runs, crashes and adjusts inside the same allowance, and a run cut
 * off mid-iteration loses the payload that would have made it replayable. The class follows the purpose, an explicit `work.budget.commands`
 * still wins, and a run that ends on its allowance has to say what survived.
 */
const work = (extra: Record<string, unknown> = {}) => ({
  assetRefs: [{ id: `asset-${'a'.repeat(24)}`, revision: 1 }], questionKey: 'policy:chain', policyKey: 'policy:declared-contract',
  actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'chain-step', purpose: 'exploitation' as const, ...extra,
});

describe('exploitation budget class', () => {
  it('follows the purpose, and an explicit work budget still wins', () => {
    expect([DEFAULT_WORKER_COMMAND_BUDGET, EXPLOITATION_COMMAND_BUDGET]).toEqual([200, 400]);
    expect(commandBudgetFor(undefined)).toBe(200);
    expect(commandBudgetFor('exploitation', undefined)).toBe(400);
    expect(commandBudgetFor('chaining', undefined)).toBe(400);
    for (const purpose of ['mapping', 'discovery', 'investigation', 'refinement', 'validation', 'retest', 'reporting']) expect(commandBudgetFor(purpose)).toBe(200);
    // The owner can raise or lower the class per task; the declared number is the allowance, not a hint.
    expect(commandBudgetFor('exploitation', { commands: 60 })).toBe(60);
    expect(commandBudgetFor('validation', { commands: 900 })).toBe(900);
    expect(commandBudgetFor('exploitation', {})).toBe(400);
  });

  it('is an allowance, not part of the work identity', () => {
    const base = validateWorkSpec(work()), raised = validateWorkSpec(work({ budget: { commands: 400 } }));
    expect(raised.budget).toEqual({ commands: 400 });
    expect(validateWorkSpec(work({ budget: {} })).budget).toEqual({});
    // The same question with a larger allowance is the same work, so the fingerprint does not move.
    expect(workIdentity('target-r1', { prerequisites: [], work: base }).fingerprint).toBe(workIdentity('target-r1', { prerequisites: [], work: raised }).fingerprint);
    for (const bad of [{ commands: 0 }, { commands: 5001 }, { commands: 1.5 }, { commands: '400' }, { commands: 400, extra: 1 }])
      expect(() => validateWorkSpec(work({ budget: bad })), JSON.stringify(bad)).toThrow(/work (command )?budget/i);
  });

  it('gives only the wrap-up purposes the extra duty sentence, inside the line budget', () => {
    expect(budgetWrapUpRequired('exploitation')).toBe(true); expect(budgetWrapUpRequired('chaining')).toBe(true);
    for (const purpose of ['mapping', 'discovery', 'investigation', 'refinement', 'validation', 'retest', 'reporting']) expect(budgetWrapUpRequired(purpose), purpose).toBe(false);
    expect(dutyLine('exploitation')).toContain('Before you stop: store the payload');
    expect(dutyLine('chaining')).toContain('Before you stop: store the combined payload');
    expect(dutyLine('validation')).not.toContain('Before you stop');
    // Two lines may carry the wrap-up sentence; the rest of the vocabulary must not grow with it.
    for (const purpose of ['exploitation', 'chaining'] as const) expect(dutyLine(purpose).length).toBeLessThanOrEqual(470);
    for (const purpose of ['mapping', 'discovery', 'investigation', 'refinement', 'validation', 'retest', 'reporting'] as const) expect(dutyLine(purpose).length).toBeLessThanOrEqual(400);
  });
});
