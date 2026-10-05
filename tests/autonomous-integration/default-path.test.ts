import { describe, it, expect } from 'vitest';
import { mkdir, readFile, readdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { DurableStore } from '../../src/store/store.js';
import { defaultAutonomousBudget, durableAutonomousPool } from '../../src/application/autonomous-budget.js';
import { commandHarness } from './harness.js';

async function runDirectory(root: string) { return join(root, 'runs', (await readdir(join(root, 'runs')))[0]!); }
function phases(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Object.fromEntries(db.prepare('SELECT phase, json FROM autonomous_phase_journals').all().map(row => [String(row.phase), JSON.parse(String(row.json))])); }
  finally { db.close(); }
}
describe('actual default command -> bundled backend: INERT model and automated consent, not live AI qualification', () => {
  it('ordinary runs have no application token/USD quota: no partial admission and no extension demand', async () => {
    // Ordinary runs have no application token/USD quota: a formerly 'too small' budget can no longer stop
    // planning, and no partial/extension report is produced. The native model limits still bound each turn.
    const h = await commandHarness();
    try {
      const plan = await h.command('--target https://example.invalid/exact --plan-only');
      expect(plan?.runId).toBeTruthy();
      expect(h.notifications.some(n => n.message.includes('BUDGET_EXTENSION_REQUIRED'))).toBe(false);
      const root = await runDirectory(h.root);
      const pinned = JSON.parse(await readFile(join(root, 'autonomous-budget.json'), 'utf8'));
      expect(pinned).toMatchObject({ outcome: 'accounting-only', ownerLimits: { mode: 'accounting-only' } });
      const manifest = JSON.parse(await readFile(join(root, 'control/run-manifest.json'), 'utf8'));
      expect(manifest.budgets).toMatchObject({ modelAccounting: 'informational', maxTokens: null, maxCostUsd: null });
      await expect(readFile(join(root, 'partial-report.json'))).rejects.toThrow();
      expect(h.provider.requests.length).toBe(1);
    } finally { await h.close(); }
  });
  it('real planner AND worker gateway wire limits; one informational durable ledger; deterministic accepted-packet stop without paid prose', async () => {
    const h = await commandHarness(); let requests = 0;
    const server = createServer((_req, res) => { requests++; res.end('bounded owner response'); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const plan = await h.command(`--target http://127.0.0.1:${(server.address() as AddressInfo).port}/exact --plan-only`);
      expect(h.notifications.filter(n => n.type === 'error')).toEqual([]);
      expect(requests).toBe(0); expect(h.provider.requests).toHaveLength(1);
      await h.command(`approve ${plan.planId}`);
      expect((await h.wait(plan.runId)).run.state).toBe('completed');
      expect(requests).toBe(1);
      // planner + context + broker + packet only; no terminal prose turn or hidden model substitution.
      expect(h.provider.requests).toHaveLength(4);
      expect(h.provider.requests.every(r => r.model === 'inert-worker' && r.max_tokens === 4096 && r.n === 1)).toBe(true);
      const root = await runDirectory(h.root), state = phases(join(root, 'state.sqlite'));
      // Accounting-only runs keep one informational durable ledger (no four financial phase quotas).
      expect(Object.keys(state)).toEqual(['workers']);
      expect(state.workers.runId).toBe(plan.runId);
      expect(state.workers.committed.tokens).toBeGreaterThan(0);
      expect(state.workers.limits).toMatchObject({ mode: 'accounting-only', maxTokens: null, maxCostUsdMicros: null });
      expect(Object.keys(state.workers.reservations)).toHaveLength(0);
      const handles = await readdir(join(root, 'control/handles'));
      const handle = JSON.parse(await readFile(join(root, 'control/handles', handles[0]!), 'utf8'));
      expect(handle.sessionRelease.verified).toBe(true); expect(handle.budgetOutcome).toBeUndefined();
      const report: any = await h.controller.execute('report', { runId: plan.runId, format: 'json' }, h.cwd);
      // Informational accounting is reported cumulatively; there are no phase reserves left to report.
      expect(report.modelBudget.policy).toBe('informational-durable-no-phase-quotas');
      expect(report.modelBudget.accounting.limits).toMatchObject({ mode: 'accounting-only', maxTokens: null, maxCostUsd: null });
      expect(report.modelBudget.accounting.committed.tokens).toBeGreaterThan(0);
      expect(report.modelBudget.phases).toBeUndefined();
      expect(h.provider.requests).toHaveLength(4);
    } finally { await h.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  }, 90000);
  it('first-use static pack is actually selected, consented, doctored, dispatched and physically released; source checkpoint is anchored', async () => {
    const h = await commandHarness(); const target = join(h.root, 'source'); await mkdir(target);
    await writeFile(join(target, 'index.ts'), 'export const marker = "AUTONOMOUS_INTEGRATION";\n');
    try {
      const run = await h.command(`--target ${target}`);
      expect(h.notifications.filter(n => n.type === 'error')).toEqual([]);
      expect((await h.wait(run.runId)).run.state).toBe('completed');
      expect(h.dialogs.some(d => d.title.includes('TOOL PACK static'))).toBe(true);
      expect(h.dialogs.some(d => d.title.includes('Consent to scoped TOOL PACK'))).toBe(true);
      const root = await runDirectory(h.root);
      expect(JSON.parse(await readFile(join(root, 'control/pack-grant.json'), 'utf8')).capabilities).toContain('source.analyze');
      const handle = JSON.parse(await readFile(join(root, 'control/handles', (await readdir(join(root, 'control/handles')))[0]!), 'utf8'));
      expect(handle.sessionRelease.verified).toBe(true);
      expect(handle.sessionRelease.releasers.some((r: any) => r.name === 'container-pack')).toBe(true);
      const checkpoint = JSON.parse(await readFile(join(h.root, 'checkpoints', run.runId, 'checkpoint.json'), 'utf8'));
      expect(checkpoint.checkpoint.runId).toBe(run.runId);
      expect(checkpoint.checkpoint.planDigest).toBeTruthy();
      expect(JSON.stringify(checkpoint)).not.toContain('explicit-inert-secret');
      expect(JSON.stringify(checkpoint)).not.toContain('provider');
      const report: any = await h.controller.execute('report', { runId: run.runId, format: 'json' }, h.cwd);
      expect(JSON.stringify(report)).toContain('"findings":[]'); // a scan question is never a literal source claim
    } finally { await h.close(); }
  }, 90000);
  it('unsupported host/mixed pack choice blocks before model or source access, never falls back to container', async () => {
    const h = await commandHarness({ packBoundary: 'unsupported' }); const target = join(h.root, 'source'); await mkdir(target);
    try {
      await h.command(`--target ${target}`);
      expect(h.provider.requests).toHaveLength(0);
      expect(h.notifications.some(n => n.message.includes('PACK_BOUNDARY_UNSUPPORTED'))).toBe(true);
      await expect(readFile(join(await runDirectory(h.root), 'control/source-approval.json'))).rejects.toThrow();
    } finally { await h.close(); }
  });
});

describe('real SQLite phase writer/reopen mechanics ONLY (not resource restart acceptance)', () => {
  it('restores charged spend/reserves and refuses policy change, missing namespace and stale writers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-phase-reopen-')), path = join(root, 'state.sqlite');
    const selection = { provider: 'inert-fixture', model: 'inert-worker', thinking: 'off' as const };
    const plan = defaultAutonomousBudget({ maxTokens: 100000, maxCostUsd: 10 }, selection, 4096);
    let store = new DurableStore({ path });
    try {
      const pool = durableAutonomousPool(store, 'original-run', plan);
      store.registerControllerPhaseAttempt('original-run', 'planner', 'plan-attempt');
      pool.planner.reserve({ attemptId: 'plan-attempt', selection, inputTokensUpperBound: 50, maxOutputTokens: 20 }).settle({ inputTokens: 40, outputTokens: 10 });
      const before = pool.planner.snapshot(); store.close(); store = new DurableStore({ path });
      const restored = durableAutonomousPool(store, 'original-run', plan);
      expect(restored.planner.snapshot()).toEqual(before);
      expect(restored.report.snapshot().remaining.tokens).toBe(1536);
      expect(restored.verifier.snapshot().remaining.tokens).toBe(40960);
      expect(() => durableAutonomousPool(store, 'original-run', defaultAutonomousBudget({ maxTokens: 200000, maxCostUsd: 10 }, selection, 4096))).toThrow('immutable');
      const a = store.autonomousPhaseJournal('original-run', 'report'), b = store.autonomousPhaseJournal('original-run', 'report');
      const rawA = a.load('original-run') as any, rawB = b.load('original-run') as any;
      a.save({ ...rawA, committed: { tokens: 1, costMicros: 1 } });
      expect(() => b.save(rawB)).toThrow('Stale phase writer');
      const db = new DatabaseSync(path); db.prepare("DELETE FROM autonomous_phase_journals WHERE phase = 'workers'").run(); db.close();
      expect(() => durableAutonomousPool(store, 'original-run', plan)).toThrow('Missing restart');
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
});
