/**
 * planning_update.md P16.5: route diversity is a visible dimension, not a hidden preference.
 *
 * A route is the *family* of mechanism a chain step tries (`upload`, `auth`, `sqli`, …). ARTEX spreads its exploration over
 * mechanism-different routes while a goal is unmet, and concentrates only once one route shows a demonstrated effect. The host
 * cannot judge plausibility, so this module only counts what the plan already says and names the families the run's own
 * capabilities make plausible — the choice stays with the model and the advisory never refuses anything.
 */
import { capabilityKey, isTypedCapability, type Capability } from './capabilities.js';
import { claimCapabilities, type ClaimFields } from './claims.js';
import type { PlanEntry } from './planning.js';

export const ROUTE_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const ROUTE_FAMILIES = ['upload', 'auth', 'sqli', 'deser', 'ssrf', 'path', 'injection', 'business-logic', 'other'] as const;
export type RouteFamily = typeof ROUTE_FAMILIES[number];

/** What a demonstrated capability makes worth trying, as families. Deliberately coarse: this is a hint, not a ranking. */
const PLAUSIBLE: Readonly<Record<string, readonly RouteFamily[]>> = {
  'http.request': ['auth', 'sqli', 'upload', 'ssrf', 'path', 'business-logic'],
  'file.write': ['upload', 'path'], 'file.read': ['path'], 'exec.code': ['upload', 'deser', 'injection'],
  deserialize: ['deser'], 'db.query': ['sqli'], 'cred.session': ['auth'], 'cred.secret': ['auth'], 'admin.ui': ['auth', 'business-logic'],
  'cloud.role': ['ssrf', 'auth'], 'net.egress': ['ssrf'], 'host.shell': ['injection'], 'data.read': ['business-logic'],
  'auth.bypass': ['auth'], 'dns.resolve': ['ssrf'],
};

const FAMILY_WORDS: ReadonlyArray<[RegExp, RouteFamily]> = [
  [/upload|unrestricted.?file/i, 'upload'], [/auth|session|login|credential|idor|authoriz/i, 'auth'], [/sql/i, 'sqli'],
  [/deser|serial/i, 'deser'], [/ssrf|server.?side.?request/i, 'ssrf'], [/traversal|path|lfi|rfi|file.?read/i, 'path'],
  [/xss|inject|command|template|ssti/i, 'injection'], [/business|logic|race|price|workflow/i, 'business-logic'],
];

/** A leader-declared route: a slug. Unknown words are kept as slugs rather than guessed into a family. */
export function routeSlug(value: unknown): string {
  if (typeof value !== 'string' || !ROUTE_SLUG.test(value.trim())) throw Error('route must be a lowercase slug of 1..32 characters (e.g. upload, auth, sqli)');
  return value.trim();
}

/** Map a risk/mechanism word to a family when it clearly names one; otherwise keep its slug. */
export function familyOf(word: string): string {
  for (const [pattern, family] of FAMILY_WORDS) if (pattern.test(word)) return family;
  const slug = word.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return slug && ROUTE_SLUG.test(slug) ? slug : 'other';
}

/**
 * Default route for a todo (the plan's `methodFamily`): the first cited claim's risk, else the first needed capability kind,
 * else the first gained kind, else `other`. Deterministic, so two readers derive the same family from the same row.
 */
export function defaultRoute(plan: Pick<PlanEntry, 'route' | 'claimRefs' | 'needs'>, claims: readonly ClaimFields[]): string {
  if (plan.route) return plan.route;
  const byRecord = new Map<string, ClaimFields>();
  for (const claim of claims) {
    const id = (claim as { recordId?: string }).recordId;
    if (typeof id === 'string') byRecord.set(id, claim);
  }
  for (const ref of plan.claimRefs ?? []) {
    const claim = byRecord.get(ref) as (ClaimFields & { risk?: string }) | undefined;
    if (!claim) continue;
    if (typeof claim.risk === 'string' && claim.risk.trim()) return familyOf(claim.risk);
    const needs = claimCapabilities(claim).needs.find(isTypedCapability);
    if (needs) return familyOf(needs.kind);
    const gained = claimCapabilities(claim).gained.find(isTypedCapability);
    if (gained) return familyOf(gained.kind);
  }
  const need = (plan.needs ?? []).find(isTypedCapability);
  return need ? familyOf(need.kind) : 'other';
}

export interface RouteCounts { open: string[]; done: string[] }

/** Todo rows only: a route is what the plan is trying, and goals/decisions do not try anything. */
export function routeCounts(plans: readonly PlanEntry[]): RouteCounts {
  const open = new Set<string>(), done = new Set<string>();
  for (const plan of plans) {
    if (plan.kind !== 'todo') continue;
    const route = plan.route ?? 'other';
    if (['open', 'in-progress', 'blocked'].includes(plan.status)) open.add(route);
    else if (plan.status === 'done') done.add(route);
  }
  return { open: [...open].sort(), done: [...done].sort() };
}

/** Families the run's own demonstrated capabilities make plausible, minus the ones already open. */
export function plausibleAlternatives(plans: readonly PlanEntry[], claims: readonly ClaimFields[]): string[] {
  const counts = routeCounts(plans), seen = new Set<string>();
  for (const claim of claims) {
    const { closure, execution } = claim as { closure?: unknown; execution?: unknown };
    if (closure !== 'confirmed' || execution !== 'tested') continue;
    for (const gained of claimCapabilities(claim).gained) if (isTypedCapability(gained)) for (const family of PLAUSIBLE[gained.kind] ?? []) seen.add(family);
  }
  return [...seen].filter(route => !counts.open.includes(route)).sort();
}

/** One open route and a plausible alternative: the advisory ARTEX calls route monoculture. Never a refusal. */
export function routeMonoculture(plans: readonly PlanEntry[], claims: readonly ClaimFields[]): { route: string; alternatives: string[] } | undefined {
  const counts = routeCounts(plans);
  if (counts.open.length !== 1) return undefined;
  const alternatives = plausibleAlternatives(plans, claims);
  return alternatives.length ? { route: counts.open[0], alternatives } : undefined;
}
