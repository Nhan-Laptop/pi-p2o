import { describe, expect, it } from 'vitest';
import { PRIORITY_BASE, PRIORITY_MAX, PRIORITY_MIN, PRIORITY_WEIGHTS, suggestPriority, type PriorityFacts } from '../../src/priority.js';
import { WORK_PURPOSES } from '../../src/work.js';

// planning_update.md P4: priority is a stated derivation, not a feeling. The weights are read from the module so this
// table and the source cannot disagree; the suggestion never dispatches, so there is nothing to test but the number.
const neutral: PriorityFacts = { prerequisitesUnmet: false, purpose: 'discovery', requiresSatisfiedByConfirmed: false, targetAssetHasAcceptedFinding: false, questionCoveredByFreshCell: false };
const w = PRIORITY_WEIGHTS;

describe('priority suggestion (P4)', () => {
  it('scores a task with no signal at the neutral base', () => {
    expect(suggestPriority(neutral)).toBe(PRIORITY_BASE);
  });

  it('applies each signal weight in isolation', () => {
    const table: Array<[string, Partial<PriorityFacts>, number]> = [
      ['prerequisites unmet', { prerequisitesUnmet: true }, PRIORITY_BASE + w.prerequisitesUnmet],
      ['validation unlocks a case', { purpose: 'validation' }, PRIORITY_BASE + w.cheapUnlockingPurpose],
      ['retest unlocks a case', { purpose: 'retest' }, PRIORITY_BASE + w.cheapUnlockingPurpose],
      ['requires met by confirmed claim', { requiresSatisfiedByConfirmed: true }, PRIORITY_BASE + w.requiresSatisfiedByConfirmed],
      ['target asset already productive', { targetAssetHasAcceptedFinding: true }, PRIORITY_BASE + w.targetAssetHasAcceptedFinding],
      ['question already covered fresh', { questionCoveredByFreshCell: true }, PRIORITY_BASE + w.questionCoveredByFreshCell],
    ];
    for (const [label, patch, expected] of table) expect([label, suggestPriority({ ...neutral, ...patch })]).toEqual([label, expected]);
  });

  it('gives the unlocking bonus only to validation and retest', () => {
    for (const purpose of WORK_PURPOSES) {
      const bonus = purpose === 'validation' || purpose === 'retest' ? w.cheapUnlockingPurpose : 0;
      expect([purpose, suggestPriority({ ...neutral, purpose })]).toEqual([purpose, PRIORITY_BASE + bonus]);
    }
  });

  it('sums independent signals', () => {
    expect(suggestPriority({ ...neutral, purpose: 'validation', requiresSatisfiedByConfirmed: true, targetAssetHasAcceptedFinding: true }))
      .toBe(PRIORITY_BASE + w.cheapUnlockingPurpose + w.requiresSatisfiedByConfirmed + w.targetAssetHasAcceptedFinding);
  });

  it('stays inside the 0..100 band for every combination of facts (the clamp contract)', () => {
    for (const purpose of WORK_PURPOSES)
      for (let mask = 0; mask < 16; mask++) {
        const score = suggestPriority({
          prerequisitesUnmet: Boolean(mask & 1),
          purpose,
          requiresSatisfiedByConfirmed: Boolean(mask & 2),
          targetAssetHasAcceptedFinding: Boolean(mask & 4),
          questionCoveredByFreshCell: Boolean(mask & 8),
        });
        expect(score).toBeGreaterThanOrEqual(PRIORITY_MIN);
        expect(score).toBeLessThanOrEqual(PRIORITY_MAX);
        expect(Number.isInteger(score)).toBe(true);
      }
  });

  it('is pure: same facts give the same score and the input is not mutated', () => {
    const facts: PriorityFacts = { ...neutral, purpose: 'retest', requiresSatisfiedByConfirmed: true };
    const before = JSON.stringify(facts);
    expect(suggestPriority(facts)).toBe(suggestPriority(facts));
    expect(JSON.stringify(facts)).toBe(before);
  });
});
