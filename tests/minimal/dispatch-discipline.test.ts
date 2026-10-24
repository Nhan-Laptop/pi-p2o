import { describe, expect, it } from 'vitest';
import { ownerInstructions, type OwnerPromptFacts } from '../../src/prompts.js';

// planning_update.md P6: the lead prompt carries the three scheduling rules that keep a dependent
// step from being dispatched before the step it consumes, cap the batch, and refuse a silent stall.
const base = (overrides: Partial<OwnerPromptFacts> = {}): OwnerPromptFacts => ({ runId: 'run-test', targetLabel: 'https://example.invalid',
  targetKind: 'url', sourceSkipped: 0, delegation: { enabled: true, maxWorkers: 3, maxDepth: 2 }, ...overrides });

const solo = () => ownerInstructions(base({ delegation: { enabled: false, reason: 'disabled', maxWorkers: 0, maxDepth: 0 } }));

describe('dispatch discipline (P6)', () => {
  it('states the serial-chain rule, the batch cap and the anti-stall floor', () => {
    for (const prompt of [ownerInstructions(base()), ownerInstructions(base({ loopMode: 'event-driven' })), solo()]) {
      expect(prompt).toContain('A chain step that consumes an earlier step’s actual output is its own task with pinned prerequisites');
      expect(prompt).toMatch(/Dispatch at most four intents per call, highest value first/);
      // P15 (R1): a round with no feasible question is not a stall, so the rule names the blocked path instead of demanding work.
      expect(prompt).toMatch(/A round that adds no intent is a stall only when a feasible question exists/);
      expect(prompt).toContain('report blocked/human-needed with the missing prerequisite instead of inventing work');
    }
  });

  it('keeps the rules out of the tool-name vocabulary the lead prompt may not carry', () => {
    expect(ownerInstructions(base())).not.toMatch(/\bp2o_[a-z_]+\b/);
  });

  it('does not raise the batch cap above what the frontier can schedule', () => {
    // The cap is a scheduling rule, not a queue limit: one call stays inside the default worker slots so a
    // readiness miss costs one round rather than a whole batch.
    const prompt = ownerInstructions(base());
    expect(prompt).toContain('Available: 3 concurrent worker slots');
    expect(prompt).not.toMatch(/at most (?:[5-9]|\d{2,}) intents per call/);
  });
});
