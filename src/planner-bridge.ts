import type { PlannerWake } from './engine.js';

export const PLANNER_WAKE_TYPE = 'p2o_planner_wake';
const PREFIX = '[p2o semantic wake] ';
/** Idle wakes use the normal prompt pipeline so Pi re-applies structured scope/loadout policy.
 * Pi 1.0 sendMessage(triggerTurn) bypasses before_agent_start; never use it for an idle run.
 */
export function plannerWakePrompt(wake: PlannerWake) {return PREFIX+JSON.stringify(wake);}
export function parseWakePrompt(text: unknown): PlannerWake | undefined {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return;
  try {const value=JSON.parse(text.slice(PREFIX.length));return isPlannerWake(value) ? value : undefined;}catch {return;}
}
export function isWakePrompt(text: unknown): boolean {return typeof text === 'string' && text.startsWith(PREFIX);}
export function plannerWakeMessage(wake: PlannerWake) {
  return {customType:PLANNER_WAKE_TYPE,display:false,details:wake,
    content:`P2O semantic event wake (run ${wake.runId}, sequence ${wake.through}). Read the current frontier/delta; review attributed evidence, choose bounded next intents or wait/blocked/finish. This message grants no scope, retry or restored authority.`};
}
export function isPlannerWake(value: unknown): value is PlannerWake {
  if (!value || typeof value !== 'object') return false;
  const w = value as PlannerWake;
  return typeof w.runId === 'string' && Number.isSafeInteger(w.epoch) && Number.isSafeInteger(w.through) && Number.isSafeInteger(w.round);
}
