/**
 * CVSS v3.1 base score from a vector string. Pure, no dependency, no network. The score is computed by the host from the vector the
 * owner recorded; a rating is an attributed assessment and never changes a case verdict or review status.
 * Formulas and weights: FIRST CVSS v3.1 specification, section 7 (Base Metrics Equations) and Appendix A (Roundup).
 */
import { cvss4Score, cvss4Vector, type Cvss4Base, type Cvss4Severity } from './cvss4.js';
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

/**
 * P14.9: severity is computed from what the chain demonstrated, never chosen. A chain step names the effect its own evidence showed; the table below
 * is the *minimum* CVSS 4.0 impact set each effect proves, so nothing is rated on an effect the chain did not produce. Reachability of the step is a
 * separate recording: metrics are combined towards the easiest reach any demonstrated step reported, and a chain that reports none is scored at the
 * least favourable reach (AV:P/AC:H/AT:P/PR:H/UI:A). Missing reachability evidence can only lower a score, never raise one.
 */
export const CASE_EFFECTS = ['confidentiality-read', 'integrity-write', 'availability-loss', 'authentication-bypass', 'code-execution', 'cross-tenant-read', 'sandbox-escape'] as const;
export type CaseEffect = typeof CASE_EFFECTS[number];
type ImpactMetrics = Readonly<Record<'VC' | 'VI' | 'VA' | 'SC' | 'SI' | 'SA', 'H' | 'L' | 'N'>>;
const EFFECT_IMPACT: Readonly<Record<CaseEffect, ImpactMetrics>> = {
  'confidentiality-read': { VC: 'H', VI: 'N', VA: 'N', SC: 'N', SI: 'N', SA: 'N' },
  'integrity-write': { VC: 'N', VI: 'H', VA: 'N', SC: 'N', SI: 'N', SA: 'N' },
  'availability-loss': { VC: 'N', VI: 'N', VA: 'H', SC: 'N', SI: 'N', SA: 'N' },
  'authentication-bypass': { VC: 'H', VI: 'H', VA: 'N', SC: 'N', SI: 'N', SA: 'N' },
  'code-execution': { VC: 'H', VI: 'H', VA: 'H', SC: 'N', SI: 'N', SA: 'N' },
  'cross-tenant-read': { VC: 'H', VI: 'N', VA: 'N', SC: 'H', SI: 'N', SA: 'N' },
  'sandbox-escape': { VC: 'H', VI: 'H', VA: 'H', SC: 'H', SI: 'H', SA: 'H' }
};
/** Metric values in CVSS 4.0 order: index 0 is the easiest reach, so combining two steps means taking the lower index. */
export const CHAIN_REACH_METRICS = { AV: ['N', 'A', 'L', 'P'], AC: ['L', 'H'], AT: ['N', 'P'], PR: ['N', 'L', 'H'], UI: ['N', 'P', 'A'] } as const;
export type ChainReachMetric = keyof typeof CHAIN_REACH_METRICS;
export type ChainReach = { readonly [M in ChainReachMetric]: typeof CHAIN_REACH_METRICS[M][number] };
export const CHAIN_REACH_KEYS = Object.keys(CHAIN_REACH_METRICS) as ChainReachMetric[];
/** What a chain is scored at when no demonstrated step says how it was reached. */
export const WORST_REACH: ChainReach = { AV: 'P', AC: 'H', AT: 'P', PR: 'H', UI: 'A' };
export const CHAIN_REACH_LABELS: Readonly<Record<ChainReachMetric, string>> = { AV: 'attack vector', AC: 'attack complexity', AT: 'attack requirements', PR: 'privileges required', UI: 'user interaction' };

/** Owner-entered reachability of one step, validated metric by metric; a partial group is refused because the missing metric would be guessed. */
export function parseChainReach(value: unknown, label: string): ChainReach {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Error(`${label} must be an object`);
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) if (!CHAIN_REACH_KEYS.includes(key as ChainReachMetric)) throw Error(`Unknown ${label} metric ${key}`);
  const result = {} as Record<ChainReachMetric, string>;
  for (const metric of CHAIN_REACH_KEYS) {
    const allowed: readonly string[] = CHAIN_REACH_METRICS[metric];
    if (!allowed.includes(row[metric] as string)) throw Error(`${label} ${metric} must be one of ${allowed.join('/')}`);
    result[metric] = row[metric] as string;
  }
  return result as ChainReach;
}

/** One chain step as far as impact is concerned: the effect its evidence showed and how it was reached. */
export interface ChainImpactStep { effect?: CaseEffect; reach?: ChainReach }
export interface ChainImpact { vector: string; score: number; severity: Cvss4Severity; effect: CaseEffect }

/**
 * The impact a chain demonstrates: the effect named by the deepest executed step, scored with the easiest reach any executed step reported. Undefined
 * when the chain has no executed depth, or when that depth names no effect — in both cases nothing was demonstrated and nothing may be rated.
 */
export function chainImpact(steps: readonly ChainImpactStep[], demonstratedThrough: number | undefined): ChainImpact | undefined {
  if (typeof demonstratedThrough !== 'number' || !Number.isInteger(demonstratedThrough) || demonstratedThrough < 1 || demonstratedThrough > steps.length) return;
  const demonstrated = steps.slice(0, demonstratedThrough), effect = demonstrated[demonstrated.length - 1]?.effect;
  if (!effect) return;
  const reach: Record<ChainReachMetric, string> = { ...WORST_REACH };
  const rank = (metric: ChainReachMetric, value: string) => (CHAIN_REACH_METRICS[metric] as readonly string[]).indexOf(value);
  for (const step of demonstrated) if (step.reach) for (const metric of CHAIN_REACH_KEYS) if (rank(metric, step.reach[metric]) < rank(metric, reach[metric])) reach[metric] = step.reach[metric];
  const base = { ...EFFECT_IMPACT[effect], ...reach } as unknown as Cvss4Base;
  const scored = cvss4Score(cvss4Vector(base));
  return { vector: scored.vector, score: scored.score, severity: scored.severity, effect };
}

/** Finding severities and CVSS bands share one rank so a rating can be compared with what the chain demonstrated. */
export const SEVERITY_RANK: Readonly<Record<'informational' | Cvss4Severity, number>> = { informational: 0, none: 0, low: 1, medium: 2, high: 3, critical: 4 };
export function severityRank(severity: keyof typeof SEVERITY_RANK): number { return SEVERITY_RANK[severity]; }
