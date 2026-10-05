import { describe, expect, test } from 'vitest';
import { selectedModelCompletionLimit } from '../../src/runtime/completion-capability.js';

describe('selected-model completion capability (not application spend consent)', () => {
  test('uses the actual model output capability instead of a fixed planner cap or thinking table', () => {
    expect(selectedModelCompletionLimit({ maxTokens: 384_000, contextWindow: 1_000_000 }, 5677)).toBe(384_000);
    expect(selectedModelCompletionLimit({ maxTokens: 8192, contextWindow: 131_072 }, 5677)).toBe(8192);
  });

  test('respects available context without changing the selected model capability', () => {
    const model = Object.freeze({ maxTokens: 8192, contextWindow: 16384 });
    expect(selectedModelCompletionLimit(model, 12_000)).toBe(4384);
    expect(selectedModelCompletionLimit(model, 16_383)).toBe(1);
    expect(model.maxTokens).toBe(8192);
    expect(() => selectedModelCompletionLimit(model, 16_384)).toThrow(/MODEL_CONTEXT_EXHAUSTED/);
  });

  test('fails closed for missing/invalid capability and input facts instead of numeric sentinels', () => {
    for (const maxTokens of [0, -1, Infinity, NaN, 1.5, undefined]) {
      expect(() => selectedModelCompletionLimit({ maxTokens: maxTokens as number, contextWindow: 100 }, 1)).toThrow(/MODEL_COMPLETION_CAPABILITY_REQUIRED/);
    }
    expect(() => selectedModelCompletionLimit({ maxTokens: 101, contextWindow: 100 }, 1)).toThrow(/MODEL_COMPLETION_CAPABILITY_REQUIRED/);
    for (const input of [-1, Infinity, NaN, 1.5]) {
      expect(() => selectedModelCompletionLimit({ maxTokens: 50, contextWindow: 100 }, input)).toThrow(/MODEL_INPUT_BOUND_INVALID/);
    }
  });
});
