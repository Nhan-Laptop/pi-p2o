import { THINKING_LEVELS, type PlannerModels } from './roles.js';
import type { WorkPurpose } from './duties.js';

/**
 * planning_update.md P18.6 / D50: per-round model and thinking routing.
 *
 * The round boundary is the one place a switch is cheap: D45 starts each round in a fresh session, so the new session has no
 * prompt cache to lose and `setModel` appends one recorded `model_change` entry. This module is the pure decision layer. It
 * names the loadout from facts the owner already derived; it never resolves a model id (the extension checks
 * `ctx.modelRegistry`), never changes tools or authority, and never invents a model. A12 makes routing opt-in: when
 * `p2o.plannerModels` names nothing for the selected loadout, the round keeps the current model and the reason says why.
 */

/** D50 routes on the round's named demand. The vocabulary is the work purposes plus the review round, because review is a
 * planner job rather than a worker purpose. */
export type RoundDemand = WorkPurpose | 'review';

/** D50: the demand classes that take the escalation loadout by name. Every other named demand takes the base loadout. */
export const ESCALATION_DEMANDS = ['exploitation', 'chaining'] as const satisfies readonly RoundDemand[];

/** One finished round's outcome. `closed: 0` means the round closed no obligation. */
export interface RoundOutcome { closed: number }

export interface RoundRouteInput {
  /**
   * The brief's named demand, already classified by the owner (D46). Free text is not re-parsed: a demand that is not
   * exploitation/chaining takes the base loadout, and escalation implied by brief contents arrives in the two count fields.
   */
  demand?: string | null;
  /** D46 fact: demonstrated primitive(s) still without a successor step. Boolean and count forms are both accepted. */
  unchainedPrimitive?: number | boolean | null;
  /** D46 fact: chain step(s) ready and undispatched. Boolean and count forms are both accepted. */
  readyChainStep?: number | boolean | null;
  /** Operator setting `p2o.plannerModels`; absent, empty or malformed keeps routing off (A12). */
  plannerModels?: PlannerModels | null;
  /** What the session uses now; read only to make a keep-current reason concrete, never to choose a target. */
  currentModel?: string;
  currentThinking?: string;
  /** Round outcomes, oldest first; only the last two can prove the closing-less streak D50 escalates on. */
  previousRounds?: readonly RoundOutcome[];
}

export interface RoundRoute {
  /** Model to set, or absent to keep the session's current model. */
  modelId?: string;
  /** Thinking level to set, or absent to keep the session's current level. */
  thinking?: string;
  /** Why this loadout won (or why nothing is switched), for `planner.round-model`/`planner.round-model-fallback`. */
  reason: string;
  /**
   * True only when the escalation loadout is applied. A fired escalation trigger with no escalation config is a keep-current
   * fallback (`planner.round-model-fallback`), not an escalated round, so the escalation metric is not inflated by it.
   */
  escalated: boolean;
}

/** Booleans are the brief's "carries one" form; counts let the reason name how many. A malformed value carries nothing. */
const count = (value: number | boolean | null | undefined): number => value === true ? 1
  : typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

/** Same bounds as a role model id: a bounded id the registry still has to know. */
const modelId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;

/** The Pi thinking vocabulary is authoritative; an unknown level would fail `setThinkingLevel`, so it is not emitted. */
const thinkingLevel = (value: unknown): string | undefined =>
  typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value) ? value : undefined;

/** D50 order: demand class, then the closing-less streak, then the brief's two escalation facts. */
function escalationTriggers(input: RoundRouteInput): string[] {
  const triggers: string[] = [];
  const demand = typeof input.demand === 'string' ? input.demand.trim().toLowerCase() : '';
  if ((ESCALATION_DEMANDS as readonly string[]).includes(demand)) triggers.push(`demand ${demand} is exploitation/chaining`);
  if (closedNothing(input.previousRounds)) triggers.push('the last two rounds closed nothing');
  const unchained = count(input.unchainedPrimitive);
  if (unchained > 0) triggers.push(unchained === 1 ? 'the brief carries an unchained primitive' : `the brief carries ${unchained} unchained primitives`);
  const ready = count(input.readyChainStep);
  if (ready > 0) triggers.push(ready === 1 ? 'a chain step is ready' : `${ready} chain steps are ready`);
  return triggers;
}

/** Only two well-formed zero outcomes are consecutive proof; a malformed count cannot establish a streak. */
function closedNothing(rounds: readonly RoundOutcome[] | undefined): boolean {
  if (!Array.isArray(rounds) || rounds.length < 2) return false;
  const last = rounds.slice(-2) as readonly (RoundOutcome | null | undefined)[];
  return last.every(round => round?.closed === 0);
}

/** No loadout is applied: the caller keeps what the session already has, which is today's behaviour (A12). */
function keep(reason: string, input: RoundRouteInput): RoundRoute {
  const model = typeof input.currentModel === 'string' && input.currentModel.trim() ? ` ${input.currentModel.trim()}` : '';
  const thinking = typeof input.currentThinking === 'string' && input.currentThinking.trim() ? ` at thinking ${input.currentThinking.trim()}` : '';
  return { reason: `${reason}; keeping the current model${model}${thinking}`, escalated: false };
}

/**
 * D50's default rule, as one deterministic decision: base for review/mapping/validation (and every other named non-escalation
 * demand), escalation for exploitation/chaining, two consecutive closing-less rounds, an unchained primitive or a ready chain
 * step. The caller applies the result with `pi.setModel`/`pi.setThinkingLevel` before the briefing; an absent `modelId` or
 * `thinking` means "do not change that axis", not "use a default".
 */
export function routeRound(input: RoundRouteInput = {}): RoundRoute {
  const models: PlannerModels = input.plannerModels && typeof input.plannerModels === 'object' && !Array.isArray(input.plannerModels) ? input.plannerModels : {};
  const base = modelId(models.base), escalate = modelId(models.escalate);
  const thinkingBase = thinkingLevel(models.thinkingBase), thinkingEscalate = thinkingLevel(models.thinkingEscalate);
  if (!base && !escalate && !thinkingBase && !thinkingEscalate) return keep('no p2o.plannerModels configured', input);

  const triggers = escalationTriggers(input);
  const escalation = triggers.length > 0;
  const selected = escalation ? { model: escalate, thinking: thinkingEscalate } : { model: base, thinking: thinkingBase };
  if (!selected.model && !selected.thinking) {
    return keep(escalation
      ? `escalation triggered (${triggers.join('; ')}) but p2o.plannerModels names no escalation model or thinking`
      : 'p2o.plannerModels names no base model or thinking', input);
  }
  const demand = typeof input.demand === 'string' ? input.demand.trim().toLowerCase().slice(0, 80) : '';
  return {
    ...(selected.model ? { modelId: selected.model } : {}),
    ...(selected.thinking ? { thinking: selected.thinking } : {}),
    reason: escalation ? `escalation loadout: ${triggers.join('; ')}` : `base loadout: ${demand ? `demand ${demand}` : 'no escalation trigger'}`,
    escalated: escalation,
  };
}
