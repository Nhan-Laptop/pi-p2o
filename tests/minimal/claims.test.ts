import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claimRequires, demonstratedProvides, isDemonstrated, isOpenGap, isTestedCell } from '../../src/claims.js';
import { CANDIDATE_EXECUTIONS } from '../../src/evidence.js';
import { COVERAGE_EXECUTION } from '../../src/coverage-types.js';

/**
 * planning_update.md P13(b): two vocabularies share the field name `execution` and three of their values, and every read came
 * from untyped ledger JSON, so nothing stopped a coverage cell from being read as if it were a demonstrated primitive. These
 * tests hold the single owner (`src/claims.ts`) and fail when a literal comparison is reintroduced anywhere else.
 */
describe('one owner for "was it demonstrated" (P13b)', () => {
  it('requires both a confirmed closure and a tested execution', () => {
    expect(isDemonstrated({ closure: 'confirmed', execution: 'tested' })).toBe(true);
    expect(isDemonstrated({ closure: 'confirmed' })).toBe(false);
    expect(isDemonstrated({ execution: 'tested' })).toBe(false);
    expect(isDemonstrated({ closure: 'open_proof_gap', execution: 'tested' })).toBe(false);
    expect(isDemonstrated({ closure: 'confirmed', execution: 'not_tested' })).toBe(false);
    expect(isDemonstrated({ closure: 'ruled_out', execution: 'tested' })).toBe(false);
    expect(isOpenGap({ closure: 'open_proof_gap' })).toBe(true);
    expect(isOpenGap({ closure: 'confirmed', execution: 'tested' })).toBe(false);
  });

  it('does not read a coverage cell as a demonstrated claim, or the reverse', () => {
    // A cell carries `execution: 'tested'` and no closure: the claim rule must refuse it rather than treat it as proven.
    const cell = { execution: 'tested', currentness: 'current', effectiveAssessment: 'accepted' };
    expect(isTestedCell(cell)).toBe(true);
    expect(isDemonstrated(cell)).toBe(false);
    expect(demonstratedProvides(cell as { provides?: unknown })).toBeUndefined();
    // The reverse cannot be distinguished by shape alone, which is exactly why the rule lives in one function: a cell-shaped
    // object never satisfies `isDemonstrated`, and claim readers must not fall back to a bare `execution === 'tested'` check.
    expect(isTestedCell({ execution: 'tested' })).toBe(true);
    expect(isTestedCell({ execution: 'blocked' })).toBe(false);
  });

  it('hands out a capability only from a demonstrated claim', () => {
    expect(demonstratedProvides({ closure: 'confirmed', execution: 'tested', provides: 'an authenticated session' })).toBe('an authenticated session');
    expect(demonstratedProvides({ closure: 'open_proof_gap', execution: 'not_tested', provides: 'an authenticated session' })).toBeUndefined();
    expect(demonstratedProvides({ closure: 'confirmed', execution: 'tested', provides: '   ' })).toBeUndefined();
    expect(claimRequires({ requires: ' an authenticated session ' })).toBe(' an authenticated session ');
    expect(claimRequires({ requires: '' })).toBeUndefined();
  });

  it('keeps the two vocabularies declared separately even though they overlap', () => {
    expect(CANDIDATE_EXECUTIONS).not.toEqual(COVERAGE_EXECUTION);
    expect(COVERAGE_EXECUTION.length).toBeGreaterThan(CANDIDATE_EXECUTIONS.length);
    // Only `tested` matters to both; the overlap is the reason a shared literal was dangerous.
    expect(CANDIDATE_EXECUTIONS.filter(value => (COVERAGE_EXECUTION as readonly string[]).includes(value)).sort()).toEqual(['blocked', 'not_applicable', 'tested']);
  });

  it('is the only place that compares a claim to its literals', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        if (name === 'node_modules' || name === 'dist' || name === '.git' || name.startsWith('.')) continue;
        const path = join(directory, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(ts|mts)$/.test(name) || /\.test\.ts$/.test(name)) continue;
        if (path === join(root, 'src', 'claims.ts')) continue; // the owner, allowed to name the literals
        const text = readFileSync(path, 'utf8');
        for (const pattern of [/execution\s*===\s*'tested'/, /closure\s*===\s*'confirmed'/, /closure\s*===\s*'open_proof_gap'/]) {
          if (pattern.test(text)) offenders.push(`${path.slice(root.length)}: ${String(pattern)}`);
        }
      }
    };
    walk(join(root, 'src'));
    walk(join(root, 'extensions'));
    expect(offenders, 'claim literals belong in src/claims.ts').toEqual([]);
  });
});
