import { DatabaseSync } from 'node:sqlite';

/** Read-only journal audit. Session usage.input can exclude cacheRead: never use it as the billing ledger. */
export function readDurableAccounting(paths, pricedModels = []) {
  const prices = new Set(pricedModels);
  const rows = new Map();
  const warnings = [];
  for (const path of paths) {
    let db;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='autonomous_phase_journals'").get();
      if (!table) continue;
      for (const row of db.prepare('SELECT run_id, phase, json FROM autonomous_phase_journals').all()) {
        const key = `${row.run_id}/${row.phase}`;
        if (rows.has(key) && rows.get(key).json !== row.json) throw new Error(`Conflicting durable journal ${key}`);
        rows.set(key, row);
      }
    } catch (error) { warnings.push(`${path}: ${error.message}`); }
    finally { db?.close(); }
  }
  let tokens = 0, costMicros = 0, providerCostMicros = 0, uncertainTokens = 0, uncertainCostMicros = 0;
  let settlements = 0, unknownTurns = 0, assumedTurns = 0, costKnown = true, providerCostKnown = true;
  for (const row of rows.values()) {
    const journal = JSON.parse(row.json);
    for (const receipt of Object.values(journal.settlements ?? {})) {
      if (![receipt.inputTokens, receipt.outputTokens, receipt.costMicros].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid durable settlement accounting');
      const total = receipt.inputTokens + receipt.outputTokens;
      tokens += total; costMicros += receipt.costMicros; settlements += 1;
      const reported = receipt.reportedCostMicros;
      const priced = prices.has(`${receipt.selection?.provider}/${receipt.selection?.model}`);
      if (!priced && reported == null) costKnown = false;
      if (!priced && reported != null) costMicros += reported - receipt.costMicros;
      if (reported == null) providerCostKnown = false; else providerCostMicros += reported;
      if ((receipt.basis ?? '').startsWith('assumed-worst-case')) assumedTurns += 1;
    }
    for (const hold of Object.values(journal.reservations ?? {})) {
      if ((hold.openTurns ?? 0) > 0) {
        unknownTurns += hold.openTurns;
        // openTokens is the outstanding per-turn wire admission, not the entire residual launch envelope.
        uncertainTokens += hold.openTokens ?? hold.reservedTokens;
        uncertainCostMicros += hold.openCostMicros ?? hold.reservedCostMicros;
      }
    }
  }
  const complete = rows.size > 0 && warnings.length === 0 && unknownTurns === 0 && assumedTurns === 0;
  return {
    tokens: rows.size && !warnings.length ? tokens : null,
    usd: rows.size && !warnings.length && costKnown ? costMicros / 1e6 : null,
    providerReportedUsd: rows.size && !warnings.length && providerCostKnown && settlements > 0 ? providerCostMicros / 1e6 : null,
    upperBoundTokens: rows.size && !warnings.length ? tokens + uncertainTokens : null,
    upperBoundUsd: rows.size && !warnings.length && costKnown ? (costMicros + uncertainCostMicros) / 1e6 : null,
    unknownTurns, assumedTurns, unsettledTokens: uncertainTokens, unsettledPolicyMicros: uncertainCostMicros,
    settlements, journalCount: rows.size, complete, warnings,
    usdBasis: 'read-only durable cache-inclusive phase settlements; stored pinned-policy estimate, NOT provider invoice; open/assumed turns remain uncertain',
  };
}

/** An explicitly authorized qualification envelope is independent of ordinary product financial policy. */
export function qualificationEnvelopeVerdict(accounting, limits) {
  // A proven lower-bound breach remains a breach even when final usage/billing is also unknown.
  if ((accounting.tokens !== null && accounting.tokens >= limits.tokens) || (accounting.usd !== null && accounting.usd >= limits.usd)) return { allowed: false, verdict: 'BREACHED', reason: 'Durable usage exhausts the explicitly authorized qualification envelope' };
  if (accounting.tokens === null || accounting.usd === null || !accounting.complete) return { allowed: false, verdict: 'UNKNOWN', reason: 'Missing, unpriced, conflicting or unsettled durable usage; refuse more live calls' };
  return { allowed: true, verdict: 'WITHIN', remainingTokens: limits.tokens - accounting.tokens, remainingUsd: limits.usd - accounting.usd };
}
