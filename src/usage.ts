/**
 * Display-only model usage counters reported by Pi for each assistant message. Nothing here limits, throttles, retries or ends work:
 * the numbers exist so the operator can see where tokens go. A message without usable usage is counted as `unknown` and contributes
 * nothing; the sums are never an estimate presented as a measurement, and a missing price is not shown as a real zero cost.
 */
export interface UsageTotals { messages: number; unknownMessages: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; totalTokens: number; cost: number; priced: number }
export interface UsageRow extends UsageTotals { actor: string; role: string }
export const USAGE_ACTORS = 1200, USAGE_REPORTS_PER_ACTOR = 50_000;
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;
const empty = (): UsageTotals => ({ messages: 0, unknownMessages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0, priced: 0 });
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : undefined;

/** Extracts a validated delta from a Pi `Usage` object, or undefined when any required counter is missing or malformed. */
export function usageDelta(usage: unknown): Omit<UsageTotals, 'messages' | 'unknownMessages'> | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const source = usage as Record<string, unknown>, delta = empty();
  for (const field of FIELDS) { const value = count(source[field]); if (value === undefined) return undefined; delta[field] = value; }
  const reasoning = count(source.reasoning); if (reasoning !== undefined) delta.reasoning = reasoning;
  const total = count((source.cost as Record<string, unknown> | undefined)?.total);
  if (total !== undefined && total > 0) { delta.cost = total; delta.priced = 1; }
  return { input: delta.input, output: delta.output, cacheRead: delta.cacheRead, cacheWrite: delta.cacheWrite, reasoning: delta.reasoning, totalTokens: delta.totalTokens, cost: delta.cost, priced: delta.priced };
}

/** The counters a worker forwards to the owner: only validated numbers, never message text or provider objects. */
export function compactUsage(usage: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number; cost: { total: number } } | undefined {
  const delta = usageDelta(usage); if (!delta) return undefined;
  return { input: delta.input, output: delta.output, cacheRead: delta.cacheRead, cacheWrite: delta.cacheWrite, ...(delta.reasoning ? { reasoning: delta.reasoning } : {}), totalTokens: delta.totalTokens, cost: { total: delta.cost } };
}

export class UsageLedger {
  private actors = new Map<string, UsageRow>();
  /** Returns false when the report was not accepted (unknown actor overflow or per-actor report cap); the caller never retries or blocks work. */
  record(actor: string, role: string, usage: unknown): boolean {
    let row = this.actors.get(actor);
    if (!row) { if (this.actors.size >= USAGE_ACTORS) return false; row = { actor, role, ...empty() }; this.actors.set(actor, row); }
    if (row.messages + row.unknownMessages >= USAGE_REPORTS_PER_ACTOR) return false;
    const delta = usageDelta(usage);
    if (!delta) { row.unknownMessages += 1; return true; }
    row.messages += 1;
    for (const key of Object.keys(delta) as Array<keyof typeof delta>) row[key] += delta[key];
    return true;
  }
  rows(): UsageRow[] { return [...this.actors.values()].map(row => ({ ...row })).sort((a, b) => a.actor.localeCompare(b.actor)); }
  totals(): UsageTotals { const total = empty(); for (const row of this.actors.values()) for (const key of Object.keys(total) as Array<keyof UsageTotals>) total[key] += row[key]; return total; }
  /** Per role: planner / worker roles, so the operator can see which part of the run consumes the model. */
  byRole(): Array<UsageTotals & { role: string; actors: number }> {
    const roles = new Map<string, UsageTotals & { role: string; actors: number }>();
    for (const row of this.actors.values()) {
      const entry = roles.get(row.role) ?? { role: row.role, actors: 0, ...empty() };
      entry.actors += 1; for (const key of Object.keys(empty()) as Array<keyof UsageTotals>) entry[key] += row[key]; roles.set(row.role, entry);
    }
    return [...roles.values()].sort((a, b) => a.role.localeCompare(b.role));
  }
}

const group = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** One compact line per role plus a total; exact figures as reported, with the unknown-message count never hidden. */
export function usageLines(ledger: UsageLedger): string[] {
  const roles = ledger.byRole();
  if (!roles.length) return ['Model usage: nothing reported yet (display only; p2o never limits work by usage).'];
  const describe = (item: UsageTotals) => `${group(item.messages)} message(s): in ${group(item.input)} · out ${group(item.output)} (reasoning ${group(item.reasoning)}) · cache read ${group(item.cacheRead)} / write ${group(item.cacheWrite)}${item.unknownMessages ? ` · ${group(item.unknownMessages)} message(s) with no usage reported` : ''}${item.priced ? ` · cost as priced by Pi ${item.cost.toFixed(4)}` : ''}`;
  return ['Model usage as reported by Pi (display only: no cap, no retry, no limit; unreported messages are counted, not estimated):',
    ...roles.map(item => `  ${item.role}${item.actors > 1 ? ` ×${item.actors}` : ''}: ${describe(item)}`),
    ...(roles.length > 1 ? [`  total: ${describe(ledger.totals())}`] : [])];
}
