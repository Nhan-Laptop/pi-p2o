/**
 * CVSS v3.1 base score from a vector string. Pure, no dependency, no network. The score is computed by the host from the vector the
 * owner recorded; a rating is an attributed assessment and never changes a case verdict or review status.
 * Formulas and weights: FIRST CVSS v3.1 specification, section 7 (Base Metrics Equations) and Appendix A (Roundup).
 */
export const CVSS_VECTOR = /^CVSS:3\.1\/AV:[NALP]\/AC:[LH]\/PR:[NLH]\/UI:[NR]\/S:[UC]\/C:[NLH]\/I:[NLH]\/A:[NLH]$/;
export type CvssSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';
export interface CvssScore { vector: string; score: number; severity: CvssSeverity }

const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 } as const, AC = { L: 0.77, H: 0.44 } as const, UI = { N: 0.85, R: 0.62 } as const, CIA = { H: 0.56, L: 0.22, N: 0 } as const;
const PR = { unchanged: { N: 0.85, L: 0.62, H: 0.27 }, changed: { N: 0.85, L: 0.68, H: 0.5 } } as const;

/** Spec Appendix A: smallest number, to one decimal, that is equal to or higher than the input, immune to floating point noise. */
export function roundUp(value: number): number {
  const integer = Math.round(value * 100000);
  return integer % 10000 === 0 ? integer / 100000 : (Math.floor(integer / 10000) + 1) / 10;
}
export function cvssSeverity(score: number): CvssSeverity { return score === 0 ? 'none' : score < 4 ? 'low' : score < 7 ? 'medium' : score < 9 ? 'high' : 'critical'; }

/** Returns undefined for anything that is not a complete CVSS:3.1 base vector. */
export function cvssScore(vector: unknown): CvssScore | undefined {
  if (typeof vector !== 'string' || !CVSS_VECTOR.test(vector)) return;
  const metrics = Object.fromEntries(vector.split('/').slice(1).map(part => part.split(':'))) as Record<string, string>;
  const changed = metrics.S === 'C', iss = 1 - (1 - CIA[metrics.C as keyof typeof CIA]) * (1 - CIA[metrics.I as keyof typeof CIA]) * (1 - CIA[metrics.A as keyof typeof CIA]);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const exploitability = 8.22 * AV[metrics.AV as keyof typeof AV] * AC[metrics.AC as keyof typeof AC] * PR[changed ? 'changed' : 'unchanged'][metrics.PR as 'N' | 'L' | 'H'] * UI[metrics.UI as keyof typeof UI];
  const score = impact <= 0 ? 0 : roundUp(Math.min(changed ? 1.08 * (impact + exploitability) : impact + exploitability, 10));
  return { vector, score, severity: cvssSeverity(score) };
}
