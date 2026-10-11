import { describe, expect, it } from 'vitest';
import { cvssScore, cvssSeverity, roundUp } from '../../src/cvss.js';

/** Reference values are the NVD/FIRST base scores published for these vectors, not values derived from this implementation. */
describe('CVSS 3.1 base score', () => {
  const reference: Array<[string, number, string]> = [
    ['AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8, 'critical'], ['AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', 7.5, 'high'], ['AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N', 5.3, 'medium'],
    ['AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', 6.5, 'medium'], ['AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1, 'medium'], ['AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', 8.8, 'high'],
    ['AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10, 'critical'], ['AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', 7.8, 'high'], ['AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N', 4.3, 'medium'],
    ['AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N', 1.6, 'low'], ['AV:N/AC:L/PR:H/UI:N/S:C/C:H/I:H/A:H', 9.1, 'critical'], ['AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0, 'none'],
  ];
  it.each(reference)('scores %s as %s', (metrics, score, severity) => {
    expect(cvssScore(`CVSS:3.1/${metrics}`)).toEqual({ vector: `CVSS:3.1/${metrics}`, score, severity });
  });
  it('rejects anything that is not a complete CVSS:3.1 base vector', () => {
    for (const bad of ['', 'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H', 'CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:F', 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H\n', ' CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H']) expect(cvssScore(bad), bad).toBeUndefined();
    expect(cvssScore(undefined)).toBeUndefined(); expect(cvssScore(7)).toBeUndefined();
  });
  it('rounds up as the specification does, immune to floating point noise', () => {
    expect(roundUp(4.02)).toBe(4.1); expect(roundUp(4)).toBe(4); expect(roundUp(4.0001)).toBe(4.1); expect(roundUp(4.000001)).toBe(4); // the specification compares at five decimals expect(roundUp(4.00000000000001)).toBe(4); expect(roundUp(0)).toBe(0);
    expect([cvssSeverity(0), cvssSeverity(0.1), cvssSeverity(3.9), cvssSeverity(4), cvssSeverity(6.9), cvssSeverity(7), cvssSeverity(8.9), cvssSeverity(9), cvssSeverity(10)]).toEqual(['none', 'low', 'low', 'medium', 'medium', 'high', 'high', 'critical', 'critical']);
  });
});
