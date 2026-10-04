import { describe, it, expect } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestJson } from '../../src/contracts/index.js';
import { validateFinding } from '../../src/evidence/index.js';
import { reviewSourceCandidate, sourcePropertyClaim } from '../../src/application/first-use-verification/index.js';
import { createHarness, findingFixture, SOURCE, INPUT, NOW } from '../evidence/fixtures.js';

function setup(patch: Record<string, unknown> = {}) {
  const h = createHarness();
  const ref = { evidenceId: 'source', path: 'handler.ts', fileHash: INPUT, startLine: 1, endLine: 1,
    excerpt: 'return record;', hypothesis: 'The handler may omit an actor check; reachability and runtime policy remain untested.' };
  const claim = sourcePropertyClaim(ref);
  const { evidenceId: _, ...proof } = ref;
  h.collect('source', 'source', { metadata: { claimDigest: digestJson(claim), sourceClaim: { ...proof, ...patch } } }, {}, SOURCE);
  const finding = { ...findingFixture(h, 'supported-static'), claim };
  return { h, ref, finding };
}
describe('source evidence-bound claims', () => {
  it('accepts only the demonstrated static property, not its security hypothesis', () => {
    const s = setup();
    try {
      const review = reviewSourceCandidate(s.h.vault, s.finding, s.ref, NOW);
      expect(review.status).toBe('accepted');
      expect(review.finding?.state).toBe('supported-static');
      expect(review.finding?.limitations.join(' ')).toContain('no runtime reachability');
      expect(review.finding?.claim).not.toBe(s.ref.hypothesis);
    } finally { s.h.dispose(); }
  });
  it.each([{ fileHash: '0'.repeat(64) }, { startLine: 0 }, { endLine: 100 }, { excerpt: 'absent call' }, { hypothesis: '' }])('refuses invalid proof %j', patch => {
    const s = setup(patch);
    try { expect(validateFinding(s.h.vault, s.finding, { reviewerId: 'reviewer', now: NOW }).status).toBe('returned-for-evidence'); }
    finally { s.h.dispose(); }
  });
  it('refuses mere claimDigest agreement from a lexical scan', () => {
    const h = createHarness();
    try {
      h.collect('source', 'source');
      expect(validateFinding(h.vault, findingFixture(h, 'supported-static'), { reviewerId: 'reviewer', now: NOW }).status).toBe('returned-for-evidence');
    } finally { h.dispose(); }
  });
  it('rejects tampered preserved source and unrelated hypothesis/reference', () => {
    const s = setup();
    try {
      expect(() => reviewSourceCandidate(s.h.vault, s.finding, { ...s.ref, hypothesis: 'changed' }, NOW)).toThrow();
      const receipt = s.h.vault.get('source')!;
      chmodSync(join(s.h.vaultRoot, receipt.locator), 0o600);
      writeFileSync(join(s.h.vaultRoot, receipt.locator), 'tampered', { mode: 0o600 });
      expect(validateFinding(s.h.vault, s.finding, { reviewerId: 'reviewer', now: NOW }).status).toBe('returned-for-evidence');
    } finally { s.h.dispose(); }
  });
  it('never auto-promotes a static suspicion to a reproduced vulnerability', () => {
    const s = setup();
    try { expect(validateFinding(s.h.vault, { ...s.finding, state: 'reproduced' }, { reviewerId: 'reviewer', now: NOW }).status).toBe('returned-for-evidence'); }
    finally { s.h.dispose(); }
  });
});
