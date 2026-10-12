import { CONTROL, validId } from '../validate.js';

/**
 * Human-only run controls. There is deliberately no model tool for `hold` or `release`: the operator can tighten or loosen the
 * target-operation gate, the model cannot. `stop-worker` reaches the same withdrawal path as the model's `p2o_stop_worker`.
 */
export type OperatorCommand = { action: 'workers' } | { action: 'hold'; reason: string } | { action: 'release' } | { action: 'stop-worker'; workerId: string; reason: string };
export const OPERATOR_REASON_LIMIT = 500;
const WORKER_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function parseOperatorCommand(args: string): OperatorCommand | undefined {
  const text = args.trim(), [action, ...parts] = text.split(/\s+/);
  if (action !== 'workers' && action !== 'hold' && action !== 'release' && action !== 'stop-worker') return undefined;
  const reason = (value: string[], fallback: string) => {
    const joined = value.join(' ').trim() || fallback;
    if (joined.length > OPERATOR_REASON_LIMIT || CONTROL.test(joined)) throw Error(`Reason must be 1..${OPERATOR_REASON_LIMIT} printable characters`);
    return joined;
  };
  if (action === 'workers' || action === 'release') { if (parts.length) throw Error(`Usage: /p2o ${action}`); return { action }; }
  if (action === 'hold') return { action, reason: reason(parts, 'Held by human') };
  if (!parts[0] || !WORKER_ID.test(parts[0]) || !validId(parts[0])) throw Error('Usage: /p2o stop-worker <worker-id> [reason]');
  return { action, workerId: parts[0], reason: reason(parts.slice(1), 'Withdrawn by human') };
}
