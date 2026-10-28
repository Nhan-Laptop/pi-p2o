/**
 * P18/A9: the round budget. P18.0 adds the deterministic model only; the loop that consumes it is P18.1+.
 *
 * A round is one bounded work package — one planner session or one observed turn — not a campaign cap. The campaign stays
 * uncapped (A9): the budget says when the current round has to wrap up and hand the ledger back, so a long-horizon campaign
 * keeps starting fresh bounded rounds instead of living in one growing conversation. A disabled axis is a value `<= 0`, so
 * `--round-steps 0 --round-seconds 0` turns every axis off and restores an unbounded round.
 */
export interface RoundBudget {
  /** Planner steps (tool-call turns) one round may take; `0` disables the axis. */
  steps: number;
  /** Wall-clock seconds one round may take; `0` disables the axis. */
  seconds: number;
  /** How many steps before the limit the round should wrap up; `0` disables the step wrap window. */
  wrapSteps: number;
  /** Context-window percent at which the round must start wrapping; `0` disables the axis. */
  contextWrapPercent: number;
  /** Context-window percent at which the round is exhausted; `0` disables the axis. */
  contextHardPercent: number;
}
/** A9: default-on. 40 steps or 15 minutes, wrapping at step 34, 90% of the time axis, 80% context; hard stop at 92%. */
export const DEFAULT_ROUND_BUDGET: RoundBudget = { steps: 40, seconds: 900, wrapSteps: 6, contextWrapPercent: 80, contextHardPercent: 92 };
export const MAX_ROUND_STEPS = 200;
export const MAX_ROUND_SECONDS = 7200;
/** `wrap` means finish the current thought and hand the ledger back; `exhausted` means stop starting new work now. */
export type RoundBudgetState = 'open' | 'wrap' | 'exhausted';
export interface RoundFacts {
  steps: number;
  startedAt: number;
  now: number;
  /** Pi's reported planner context usage; `null`/absent means the axis cannot fire rather than guessing a value. */
  contextPercent?: number | null;
  budget: RoundBudget;
}

/**
 * Pure judge: no clock, no provider, no ledger read. `exhausted` wins over `wrap`; among axes the step axis is reported first
 * so the reason a caller shows is stable. Every threshold uses `>=`, so an exact-limit round is not "open".
 */
export function judgeRound(facts: RoundFacts): { state: RoundBudgetState; reason: string } {
  const { budget } = facts;
  const steps = Number.isFinite(facts.steps) ? Math.max(0, Math.trunc(facts.steps)) : 0;
  const elapsedMs = Number.isFinite(facts.now) && Number.isFinite(facts.startedAt) ? Math.max(0, facts.now - facts.startedAt) : 0;
  const elapsed = Math.floor(elapsedMs / 1000);
  const context = typeof facts.contextPercent === 'number' && Number.isFinite(facts.contextPercent) ? facts.contextPercent : undefined;
  if (budget.steps > 0 && steps >= budget.steps) return { state: 'exhausted', reason: `round step limit ${steps}/${budget.steps} reached` };
  if (budget.seconds > 0 && elapsedMs >= budget.seconds * 1000) return { state: 'exhausted', reason: `round time limit ${elapsed}s/${budget.seconds}s reached` };
  if (context !== undefined && budget.contextHardPercent > 0 && context >= budget.contextHardPercent) return { state: 'exhausted', reason: `planner context ${Math.round(context)}% reached ${budget.contextHardPercent}%` };
  // `0` disables the axis, and a wrap window of `0` disables only the step window: the time/context thresholds still wrap.
  if (budget.steps > 0 && budget.wrapSteps > 0 && steps >= Math.max(0, budget.steps - budget.wrapSteps)) return { state: 'wrap', reason: `round step ${steps}/${budget.steps}, inside the last ${budget.wrapSteps} steps` };
  if (budget.seconds > 0 && elapsedMs >= budget.seconds * 1000 * 0.9) return { state: 'wrap', reason: `round time ${elapsed}s/${budget.seconds}s, inside the last 10%` };
  if (context !== undefined && budget.contextWrapPercent > 0 && context >= budget.contextWrapPercent) return { state: 'wrap', reason: `planner context ${Math.round(context)}% reached ${budget.contextWrapPercent}%` };
  return { state: 'open', reason: '' };
}

/**
 * P16.2/P18.4: what makes two rounds' obligations the same demand. A `wait` disposition answers the demand it saw; when the
 * ledger's demand text changes (a new obligation or a different one is named) the wait no longer answers it, so a debt wake
 * may fire again. Whitespace-only changes are not a new demand.
 */
export function demandSignature(demand?: string): string { return (demand ?? '').trim().replace(/\s+/g, ' '); }

/** Defensive parse for user-controlled settings (`p2o.plannerRound`): malformed fields fall back, integers are bounded. */
export function parseRoundBudget(raw: unknown, fallback: RoundBudget = DEFAULT_ROUND_BUDGET): RoundBudget {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback };
  const source = raw as Record<string, unknown>;
  const int = (value: unknown, min: number, max: number, otherwise: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : otherwise;
  const steps = int(source.steps, 0, MAX_ROUND_STEPS, fallback.steps);
  const seconds = int(source.seconds, 0, MAX_ROUND_SECONDS, fallback.seconds);
  // A wrap window larger than the step limit would wrap the round at step 0, so it can never exceed the limit it wraps.
  const wrapSteps = Math.min(int(source.wrapSteps, 0, MAX_ROUND_STEPS, fallback.wrapSteps), steps > 0 ? steps : MAX_ROUND_STEPS);
  return {
    steps, seconds, wrapSteps,
    contextWrapPercent: int(source.contextWrapPercent, 50, 99, fallback.contextWrapPercent),
    contextHardPercent: int(source.contextHardPercent, 50, 99, fallback.contextHardPercent),
  };
}
