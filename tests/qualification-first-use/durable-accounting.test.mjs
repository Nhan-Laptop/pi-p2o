import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readDurableAccounting, qualificationEnvelopeVerdict } from './durable-accounting.mjs';

function fixture(journal, work) {
  const root = mkdtempSync('/tmp/p2o-accounting-audit-');
  const path = join(root, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE autonomous_phase_journals(run_id TEXT, phase TEXT, json TEXT)');
  db.prepare('INSERT INTO autonomous_phase_journals VALUES (?, ?, ?)').run('owned-fixture', 'workers', JSON.stringify(journal));
  db.close();
  try { work(path); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('offline installed-audit counterexample includes cached input, preserves unsettled upper bounds and proven envelope breach', () => {
  const selection = { provider: 'deepseek', model: 'deepseek-flash' };
  fixture({ settlements: { observed: { selection, inputTokens: 2_469_822, outputTokens: 302_305, costMicros: 1_103_770, reportedCostMicros: null, basis: 'provider-usage' } }, reservations: {
    url1: { openTurns: 1, openTokens: 392_831, openCostMicros: 463_450 },
    url2: { openTurns: 1, openTokens: 792_346, openCostMicros: 583_304 },
    local1: { openTurns: 1, openTokens: 446_909, openCostMicros: 479_673 },
  } }, path => {
    const accounting = readDurableAccounting([path], ['deepseek/deepseek-flash']);
    assert.equal(accounting.tokens, 2_772_127);
    assert.equal(accounting.usd, 1.103770);
    assert.equal(accounting.upperBoundTokens, 4_404_213);
    assert.equal(accounting.upperBoundUsd, 2.630197);
    assert.equal(accounting.unknownTurns, 3);
    assert.equal(accounting.complete, false);
    assert.equal(accounting.providerReportedUsd, null, 'a pinned estimate is not a provider invoice');
    assert.equal(qualificationEnvelopeVerdict(accounting, { usd: 1, tokens: 400_000 }).verdict, 'BREACHED');
  });
});

test('missing/unpriced/uncertain accounting is unknown, not an invented zero estimate or live permission', () => {
  const missing = readDurableAccounting([]);
  assert.equal(missing.usd, null); assert.equal(missing.tokens, null);
  assert.equal(qualificationEnvelopeVerdict(missing, { usd: 1, tokens: 400_000 }).allowed, false);
  fixture({ settlements: { unknown: { selection: { provider: 'unpriced', model: 'model' }, inputTokens: 10, outputTokens: 20, costMicros: 0, reportedCostMicros: null, basis: 'provider-usage' } } }, path => {
    const accounting = readDurableAccounting([path]);
    assert.equal(accounting.tokens, 30); assert.equal(accounting.usd, null); assert.equal(accounting.providerReportedUsd, null);
    assert.equal(qualificationEnvelopeVerdict(accounting, { usd: 1, tokens: 400_000 }).verdict, 'UNKNOWN');
  });
});
