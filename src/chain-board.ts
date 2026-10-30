/**
 * planning_update.md M1: the chain lives on the plan board, and its edges are derived, not stored twice.
 *
 * A chain is a group of `todo` plan rows sharing `chainOf`, each with a 1-based `step`, the claims it stands on
 * (`claimRefs`) and the typed capabilities it consumes (`needs`). Step *n* is ready when **every** need it declares is
 * gained by a confirmed-and-tested claim cited in step *n−k*'s `claimRefs` — the same `capabilityMatches` rule the graph
 * join uses (P14.1), so a plan board and a chain view can never disagree about what a link means.
 *
 * Nothing here writes: readiness is a read over plans plus candidate heads, so closing a step is one plan revision and the
 * next view re-derives the frontier. A step with no `needs` is ready by definition: it is the primitive the chain starts from.
 *
 * P22/A1: a need may also be satisfied by a demonstrated claim the step cites in its own `claimRefs`, not only by one cited
 * by an earlier row. That is how a chain branches: a link that consumes a primitive demonstrated elsewhere starts a new chain
 * by citing it, so the attack path does not have to grow as one line. Earlier rows keep precedence, so the provenance of an
 * ordinary chain is unchanged; the link is still a citation the run recorded, never a capability lookup.
 */
import { capabilityKey, capabilityMatches, describeCapability, isTypedCapability, type Capability } from './capabilities.js';
import { isDemonstrated } from './claims.js';
import { claimCapabilities } from './claims.js';
import type { ChainClaim } from './chain-view.js';
import type { PlanEntry } from './planning.js';

export const CHAIN_LINE_LIMIT = 240;

export type ChainStepState = 'ready' | 'waiting' | 'done' | 'blocked' | 'deferred' | 'cancelled';
export interface ChainStep {
  planId: string;
  planRevision: number;
  chainOf: string;
  step: number;
  total: number;
  title: string;
  status: string;
  claimRefs: readonly string[];
  needs: readonly Capability[];
  environmentRef?: string;
  state: ChainStepState;
  /** Needs that no earlier step's demonstrated claim gains, in the order the step declares them. */
  waitingOn: Capability[];
  /** Need key → record id of the earlier step's demonstrated claim that gains it: the provenance of `ready`. */
  satisfiedBy: Record<string, string>;
}
export interface ChainProgress {
  chainOf: string;
  total: number;
  done: number;
  steps: ChainStep[];
  ready: ChainStep[];
  waiting: ChainStep[];
  /** Lowest-numbered ready step: the one the lead can turn into a task today. */
  next?: ChainStep;
  /** `chain <id> 1/3 · next: step 2 (ready) · waiting on: read /login`. */
  line: string;
}

/** Plan rows that belong to a chain, in step order. A chain is read, never stored as its own record. */
const chainRows = (plans: readonly PlanEntry[]): Map<string, PlanEntry[]> => {
  const groups = new Map<string, PlanEntry[]>();
  for (const plan of plans) {
    if (plan.kind !== 'todo' || !plan.chainOf || !plan.step) continue;
    const rows = groups.get(plan.chainOf) ?? [];
    rows.push(plan);
    groups.set(plan.chainOf, rows);
  }
  for (const rows of groups.values()) rows.sort((left, right) => (left.step ?? 0) - (right.step ?? 0));
  return groups;
};

const stateOf = (status: string): ChainStepState | undefined => {
  if (status === 'done') return 'done';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'blocked') return 'blocked';
  if (status === 'deferred') return 'deferred';
  return undefined;
};

export function chainBoard(plans: readonly PlanEntry[], claims: readonly ChainClaim[]): ChainProgress[] {
  // One read of the capability pair per claim, filtered to what a *demonstrated* claim can hand on.
  const gained = new Map<string, Capability[]>();
  for (const claim of claims) {
    if (!claim.recordId || !isDemonstrated(claim)) continue;
    gained.set(claim.recordId, claimCapabilities(claim).gained.filter(isTypedCapability));
  }
  const progress: ChainProgress[] = [];
  for (const [chainOf, rows] of [...chainRows(plans)].sort(([left], [right]) => left.localeCompare(right))) {
    const total = rows.length;
    const steps: ChainStep[] = rows.map(row => {
      const needs = row.needs ?? [];
      const earlier = rows.filter(other => (other.step ?? 0) < (row.step ?? 0));
      const offered = earlier.flatMap(other => (other.claimRefs ?? []).flatMap(ref => gained.get(ref) ?? []));
      const waitingOn: Capability[] = [];
      const satisfiedBy: Record<string, string> = {};
      for (const need of needs) {
        // First earlier step whose cited claim gains the need, so the provenance names the closest link rather than any link.
        const provider = earlier.find(other => (other.claimRefs ?? []).some(ref => (gained.get(ref) ?? []).some(have => capabilityMatches(need, have))));
        const earlierRecord = provider?.claimRefs?.find(ref => (gained.get(ref) ?? []).some(have => capabilityMatches(need, have)));
        // P22/A1: a step that cites a demonstrated provider itself may stand on it, so a new chain can branch from a
        // demonstrated primitive. Only the citation links: this never searches claims the row did not cite.
        const ownRecord = (row.claimRefs ?? []).find(ref => (gained.get(ref) ?? []).some(have => capabilityMatches(need, have)));
        const recordId = earlierRecord ?? ownRecord;
        if (recordId) satisfiedBy[capabilityKey(need)] = recordId;
        else waitingOn.push(need);
      }
      const settled = stateOf(row.status);
      // A settled row keeps the state the lead gave it: readiness cannot override a cancellation or a block.
      const state = settled ?? (waitingOn.length ? 'waiting' : 'ready');
      return { planId: row.id, planRevision: row.revision, chainOf, step: row.step ?? 0, total, title: row.title, status: row.status,
        claimRefs: row.claimRefs ?? [], needs, ...(row.environmentRef ? { environmentRef: row.environmentRef } : {}), state, waitingOn, satisfiedBy };
    });
    const ready = steps.filter(step => step.state === 'ready');
    const waiting = steps.filter(step => step.state === 'waiting');
    const done = steps.filter(step => step.state === 'done').length;
    const next = ready[0];
    const on = [...new Set(waiting.flatMap(step => step.waitingOn).map(describeCapability))].slice(0, 3);
    const line = [`chain ${chainOf} ${done}/${total}`,
      setup(steps, ready, waiting, done),
      ...(on.length ? [`waiting on: ${on.join(', ')}`] : [])].filter(Boolean).join(' · ');
    progress.push({ chainOf, total, done, steps, ready, waiting, ...(next ? { next } : {}), line: line.length <= CHAIN_LINE_LIMIT ? line : `${line.slice(0, CHAIN_LINE_LIMIT - 1)}…` });
  }
  return progress;
}

const setup = (steps: ChainStep[], ready: ChainStep[], waiting: ChainStep[], done: number): string => {
  if (ready.length) return `next: step ${ready[0]!.step} (ready)`;
  if (waiting.length) return `next: step ${waiting[0]!.step} (waiting)`;
  // A chain that is not finished must say why it is not: a blocked step is an obligation, not a settled chain.
  const blocked = steps.filter(step => step.state === 'blocked');
  if (blocked.length) return `blocked: step ${blocked[0]!.step}`;
  if (done === steps.length) return 'settled';
  return 'no open step';
};

/** Plan-view lines: one per chain, ordered by id, capped so a plan page cannot be flooded by chain text. */
export const chainLines = (progress: readonly ChainProgress[]): string[] => progress.slice(0, 10).map(chain => chain.line);
