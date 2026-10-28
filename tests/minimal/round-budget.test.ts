import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUND_BUDGET, MAX_ROUND_SECONDS, MAX_ROUND_STEPS, demandSignature, judgeRound, parseRoundBudget } from '../../src/round-budget.js';

const budget = { ...DEFAULT_ROUND_BUDGET };
const at = (facts: Partial<Parameters<typeof judgeRound>[0]> = {}) => judgeRound({ steps: 0, startedAt: 0, now: 0, budget, ...facts });

/** P18/A9: the round budget is a pure judge, so every boundary is pinned here rather than through the engine. */
describe('round budget (P18/A9)', () => {
  it('keeps a fresh round open and turns every disabled axis off', () => {
    expect(at()).toEqual({ state: 'open', reason: '' });
    // `--round-steps 0 --round-seconds 0` disables the numeric axes; only a reported context percent can still fire.
    const disabled = { steps: 0, seconds: 0, wrapSteps: 0, contextWrapPercent: 0, contextHardPercent: 0 };
    expect(judgeRound({ steps: 10_000, startedAt: 0, now: 24 * 60 * 60 * 1000, contextPercent: 96, budget: disabled })).toEqual({ state: 'open', reason: '' });
  });

  it('wraps inside the step window and exhausts exactly at the step limit', () => {
    expect(at({ steps: 33 }).state).toBe('open');
    expect(at({ steps: 34 })).toMatchObject({ state: 'wrap', reason: expect.stringContaining('last 6 steps') });
    expect(at({ steps: 39 }).state).toBe('wrap');
    expect(at({ steps: 40 })).toMatchObject({ state: 'exhausted', reason: expect.stringContaining('40/40') });
    // The step axis is bounded by its own value, not by a lifetime count.
    expect(judgeRound({ steps: 3, startedAt: 0, now: 0, budget: { ...budget, steps: 3, wrapSteps: 0 } })).toMatchObject({ state: 'exhausted' });
  });

  it('wraps at 90% of the time axis and exhausts at 100%', () => {
    expect(at({ now: 809_999 }).state).toBe('open');
    expect(at({ now: 810_000 })).toMatchObject({ state: 'wrap', reason: expect.stringContaining('last 10%') });
    expect(at({ now: 900_000 })).toMatchObject({ state: 'exhausted', reason: expect.stringContaining('900s/900s') });
  });

  it('uses context percentages only when Pi reports one, hard before wrap', () => {
    // No measurement is not a measurement: the axis stays silent rather than assuming a value.
    expect(at({ steps: 0, contextPercent: null })).toEqual({ state: 'open', reason: '' });
    expect(at({ contextPercent: undefined })).toEqual({ state: 'open', reason: '' });
    expect(at({ contextPercent: 79 }).state).toBe('open');
    expect(at({ contextPercent: 80 })).toMatchObject({ state: 'wrap', reason: expect.stringContaining('80%') });
    expect(at({ contextPercent: 92 })).toMatchObject({ state: 'exhausted', reason: expect.stringContaining('92%') });
  });

  it('prefers the step axis in the reason when several axes fire together', () => {
    expect(at({ steps: 40, now: 10 * 60 * 60 * 1000, contextPercent: 99 })).toMatchObject({ state: 'exhausted', reason: expect.stringContaining('step') });
  });
});

describe('demand signature (P18.4)', () => {
  it('treats whitespace-only edits as the same demand and a different obligation as a new one', () => {
    expect(demandSignature(undefined)).toBe('');
    expect(demandSignature('  ')).toBe('');
    expect(demandSignature('  two   proofs remain ')).toBe('two proofs remain');
    expect(demandSignature('two proofs remain')).toBe(demandSignature('two proofs remain'));
    expect(demandSignature('two proofs remain')).not.toBe(demandSignature('three proofs remain'));
  });
});

describe('round budget settings parsing', () => {
  it('returns defaults for malformed input and never shares the default object', () => {
    const parsed = parseRoundBudget(undefined);
    expect(parsed).toEqual(DEFAULT_ROUND_BUDGET);
    expect(parsed).not.toBe(DEFAULT_ROUND_BUDGET);
    expect(parseRoundBudget('nope')).toEqual(DEFAULT_ROUND_BUDGET);
    expect(parseRoundBudget({ steps: 1.5, seconds: -1 })).toEqual(DEFAULT_ROUND_BUDGET);
  });

  it('keeps valid integers, disables axes with 0, and bounds every field', () => {
    expect(parseRoundBudget({ steps: 20, seconds: 0, wrapSteps: 4, contextWrapPercent: 75, contextHardPercent: 90 }))
      .toEqual({ steps: 20, seconds: 0, wrapSteps: 4, contextWrapPercent: 75, contextHardPercent: 90 });
    // A wrap window can never exceed the step limit it wraps; an out-of-range percent falls back rather than clamping a guess.
    expect(parseRoundBudget({ steps: 20, wrapSteps: 200 }).wrapSteps).toBe(20);
    // Out-of-range values fall back to the default rather than clamping an operator typo into something plausible.
    expect(parseRoundBudget({ steps: 0, wrapSteps: 999 }).wrapSteps).toBe(DEFAULT_ROUND_BUDGET.wrapSteps);
    expect(parseRoundBudget({ steps: MAX_ROUND_STEPS + 1 }).steps).toBe(DEFAULT_ROUND_BUDGET.steps);
    expect(parseRoundBudget({ seconds: MAX_ROUND_SECONDS + 1 }).seconds).toBe(DEFAULT_ROUND_BUDGET.seconds);
    expect(parseRoundBudget({ contextWrapPercent: 40 }).contextWrapPercent).toBe(DEFAULT_ROUND_BUDGET.contextWrapPercent);
    expect(parseRoundBudget({ contextHardPercent: 100 }).contextHardPercent).toBe(DEFAULT_ROUND_BUDGET.contextHardPercent);
  });
});
