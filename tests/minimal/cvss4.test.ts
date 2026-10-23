import { describe, expect, it } from 'vitest';
import { CASE_EFFECTS, WORST_REACH, chainImpact, parseChainReach, severityRank } from '../../src/cvss.js';
import { cvss4MacroVector, cvss4Score, cvss4Vector, parseCvss4 } from '../../src/cvss4.js';

/**
 * P14.9. Every reference score below was produced by FIRST's own reference implementation (`cvss_score.js` with the 270-entry lookup table,
 * `max_severity.js` and `max_composed.js` from github.com/FIRSTdotorg/cvss-v4-calculator) for that exact base vector, not by this port. The port was
 * additionally checked against that implementation on all 104,976 base metric combinations, score and macrovector alike, and agreed on every one.
 */
describe('CVSS 4.0 base score', () => {
  const reference: Array<[string, number, string, string]> = [
    ['AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H', 10, 'critical', '000100'],
    ['AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N', 9.3, 'critical', '000200'],
    ['AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:H/SI:N/SA:N', 9.2, 'critical', '001100'],
    ['AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N', 7.1, 'high', '101200'],
    ['AV:P/AC:H/AT:P/PR:H/UI:A/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N', 4.1, 'medium', '211200'],
    ['AV:N/AC:H/AT:P/PR:L/UI:P/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N', 2.1, 'low', '112201'],
    ['AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N', 0, 'none', '002201'],
  ];
  it.each(reference)('scores %s as %s', (metrics, score, severity, macrovector) => {
    const result = cvss4Score(`CVSS:4.0/${metrics}`);
    expect({ score: result.score, severity: result.severity, macrovector: result.macrovector }).toEqual({ score, severity, macrovector });
  });

  it('refuses an ambiguous or incomplete vector instead of guessing a metric', () => {
    expect(() => parseCvss4('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N')).toThrow(/SA/);
    expect(() => parseCvss4('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:X')).toThrow(/SA/);
    expect(() => parseCvss4('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toThrow();
    expect(() => parseCvss4('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:A')).toThrow(/E/);
  });

  it('round-trips a parsed vector in metric order', () => {
    const base = parseCvss4('CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N');
    expect(cvss4Vector(base)).toBe('CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N');
    expect(cvss4MacroVector(base)).toBe('101200');
  });
});

/** The chain's severity comes from the effect its executed depth named, not from what the owner would like the case to be. */
describe('chain impact', () => {
  const steps = (effect: string | undefined, reach?: Record<string, string>) => [
    { effect: effect as never, ...(reach ? { reach: parseChainReach(reach, 'reach') } : {}) },
    {},
  ];

  it('scores the effect the executed depth names, with the reach that step reported', () => {
    const easy = chainImpact(steps('confidentiality-read', { AV: 'N', AC: 'L', AT: 'N', PR: 'L', UI: 'N' }), 1);
    expect(easy).toMatchObject({ effect: 'confidentiality-read', score: 7.1, severity: 'high' });
    expect(easy?.vector).toBe('CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N');
  });

  it('scores unreported reach at its least favourable values, so missing evidence cannot raise a score', () => {
    const silent = chainImpact(steps('confidentiality-read'), 1);
    expect(silent).toMatchObject({ score: 4.1, severity: 'medium' });
    expect(WORST_REACH).toEqual({ AV: 'P', AC: 'H', AT: 'P', PR: 'H', UI: 'A' });
  });

  it('demonstrates nothing when no step ran, or when the executed depth names no effect', () => {
    expect(chainImpact(steps('code-execution'), undefined)).toBeUndefined();
    expect(chainImpact(steps(undefined), 1)).toBeUndefined();
    expect(chainImpact(steps('code-execution'), 3)).toBeUndefined();
  });

  it('takes the easiest reach any executed step reported, and ignores steps beyond the depth', () => {
    const merged = chainImpact([
      { effect: 'confidentiality-read' as never, reach: parseChainReach({ AV: 'L', AC: 'H', AT: 'P', PR: 'H', UI: 'P' }, 'reach') },
      { effect: 'confidentiality-read' as never, reach: parseChainReach({ AV: 'N', AC: 'H', AT: 'P', PR: 'H', UI: 'A' }, 'reach') },
      { effect: 'sandbox-escape' as never, reach: parseChainReach({ AV: 'N', AC: 'L', AT: 'N', PR: 'N', UI: 'N' }, 'reach') },
    ], 2);
    // UI order is N > P > A, so the passive interaction already reported is easier than the active one the later step reports.
    expect(merged?.vector).toBe('CVSS:4.0/AV:N/AC:H/AT:P/PR:H/UI:P/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N');
  });

  it('reproduces FIRST’s chaining example: exploitability from the entry step, impact from the deepest one', () => {
    // planning_update.md P14.9 quotes this pair: A AV:L/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:H reached only through
    // B AV:N/AC:L/AT:N/PR:N/UI:P/VC:L/VI:L/VA:L. The chain vector takes B's reach and A's impact.
    const step = (effect?: string, reach?: Record<string, string>) => ({ ...(effect ? { effect: effect as never } : {}), ...(reach ? { reach: parseChainReach(reach, 'reach') } : {}) });
    const chained = chainImpact([step(undefined, { AV: 'N', AC: 'L', AT: 'N', PR: 'N', UI: 'P' }), step('code-execution')], 2);
    expect(chained?.vector).toBe('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:P/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N');
    expect(chained).toMatchObject({ score: 8.7, severity: 'high', effect: 'code-execution' });
  });

  it('keeps the effect vocabulary and the severity ranking one closed table', () => {
    expect([...CASE_EFFECTS].sort()).toEqual(['authentication-bypass', 'availability-loss', 'code-execution', 'confidentiality-read', 'cross-tenant-read', 'integrity-write', 'sandbox-escape']);
    expect(severityRank('informational')).toBe(severityRank('none'));
    expect([severityRank('critical'), severityRank('high'), severityRank('medium'), severityRank('low')]).toEqual([4, 3, 2, 1]);
  });
});
