import { describe, expect, it } from 'vitest';
import { plannerInstructions, type PlannerPromptFacts } from '../../src/prompts.js';

// planning_update.md P6: the lead prompt carries the three scheduling rules that keep a dependent
// step from being dispatched before the step it consumes, cap the batch, and refuse a silent stall.
const base = (overrides: Partial<PlannerPromptFacts> = {}): PlannerPromptFacts => ({ runId: 'run-test', targetLabel: 'https://example.invalid',
  targetKind: 'url', sourceSkipped: 0, delegation: { enabled: true, maxWorkers: 3, maxDepth: 2 }, ...overrides });

const solo = () => plannerInstructions(base({ delegation: { enabled: false, reason: 'disabled', maxWorkers: 0, maxDepth: 0 } }));

describe('dispatch discipline (P6)', () => {
  it('states the serial-chain rule, the dispatch order and the anti-stall floor', () => {
    for (const prompt of [plannerInstructions(base()), plannerInstructions(base({ loopMode: 'event-driven' })), solo()]) {
      expect(prompt).toContain('A chain step that consumes an earlier step’s actual output is its own task with pinned prerequisites');
      expect(prompt).toMatch(/Dispatch the highest-value intents first; a slot opens as one settles/);
      // P15 (R1): a round with no feasible question is not a stall, so the rule names the blocked path instead of demanding work.
      expect(prompt).toMatch(/A round that adds no intent is a stall only when a feasible question exists/);
      expect(prompt).toContain('report blocked/human-needed with the missing prerequisite instead of inventing work');
    }
  });

  it('keeps the rules out of the tool-name vocabulary the lead prompt may not carry', () => {
    expect(plannerInstructions(base())).not.toMatch(/\bp2o_[a-z_]+\b/);
  });

  it('names no batch size the frontier would have to police', () => {
    // How many intents a call carries is the lead's judgement: the slots are stated, the batch is not counted.
    const prompt = plannerInstructions(base());
    expect(prompt).toContain('Available: 3 concurrent worker slots');
    expect(prompt).not.toMatch(/at most \w+ intents per call/);
    expect(prompt).toContain('nothing is dropped');
  });
});
