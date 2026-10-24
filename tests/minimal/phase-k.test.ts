import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AssessmentStore } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { PlanBoard, planFrontier, type PlanDraft } from '../../src/planning.js';
import { appendRecord, readLedger } from '../../src/records.js';
import { finishPreflight } from '../../src/finish-preflight.js';
import { renderReport } from '../../src/report-export.js';
import { routeCounts, routeMonoculture } from '../../src/routes.js';
import { situationLine, summarizeSituation } from '../../src/situation.js';
import { EvidenceStore, type Candidate } from '../../src/evidence.js';

/**
 * Phase K acceptance (P16.5 + P16.6). Routes are counted from the plan board and named in the line/report/wake; concentration
 * is an advisory, never a refusal. Negative evidence is a checkpoint: a second `ruled_out` on the same surface+capability
 * needs new evidence or a different mechanism, and a negation recorded without tested execution is shown as unproven.
 */
const runId = 'run-k';
const plan = (overrides: Partial<Record<string, unknown>>) => ({ runId, revision: 1, recordId: 'rec', kind: 'todo', title: 'Fixture step', status: 'open', reason: 'Fixture row for the route test', ...overrides }) as never;
const claim = (recordId: string, overrides: Record<string, unknown> = {}) => ({ candidate: recordId, recordId, closure: 'confirmed', execution: 'tested', gained: [{ kind: 'http.request' }], surface: '/x', ...overrides });

async function planFixture(work: (h: { board: PlanBoard; path: string; store: AssessmentStore }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-route-')), path = join(root, 'alias.sqlite');
  const store = AssessmentStore.create(root, { runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'inert', targetDisplay: 'inert',
    profile: { runtimeHash: 'inert', image: 'inert', loopMode: 'manual', executorMode: 'shared' } }), unbind = bindAssessmentStore(path, store);
  try { await work({ board: new PlanBoard(runId, path, () => true), path, store }); } finally { unbind(); store.close(); await rm(root, { recursive: true, force: true }); }
}

describe('routes are a visible dimension of the plan (P16.5)', () => {
  it('defaults a todo route from the method family it cites and honours an explicit one', async () => await planFixture(async ({ board, store }) => {
    const risk = (risk: string) => store.commitRecords([{ runId, by: 'owner', at: '2030', kind: 'candidate', text: 'Inert claim, not a finding', data: { candidate: `claim-${risk}`, surface: '/login', risk, closure: 'open_proof_gap', execution: 'not_tested' } }])[0].recordId;
    const authorization = await risk('authorization'), upload = await risk('upload');
    const derived = await board.create({ kind: 'todo', title: 'Try the login boundary', status: 'open', reason: 'Bounded route fixture, no target', claimRefs: [authorization] } as PlanDraft);
    expect(derived.route).toBe('auth');
    const explicit = await board.create({ kind: 'todo', title: 'Try the upload path', status: 'open', reason: 'Bounded route fixture, no target', claimRefs: [upload], route: 'upload' } as PlanDraft);
    expect(explicit.route).toBe('upload');
    // A goal is not a route: the field only exists on a todo, like the rest of the chain link.
    expect(() => board.create({ kind: 'goal', title: 'Show the login boundary', status: 'active', reason: 'Bounded route fixture, no target', criteria: ['bounded'],
      proof: { kind: 'capability', capability: { kind: 'http.request' } }, route: 'auth' } as PlanDraft)).toThrow('Only a todo holds a chain link');
  }));

  it('counts one open route plus a plausible alternative as monoculture, and two routes as none', () => {
    const claims = [claim('rec-1')];
    expect(routeMonoculture([plan({ id: 'a', route: 'upload', status: 'open' }), plan({ id: 'b', route: 'auth', status: 'in-progress' })], claims)).toBeUndefined();
    const single = routeMonoculture([plan({ id: 'a', route: 'upload', status: 'open' }), plan({ id: 'b', route: 'auth', status: 'done' })], claims)!;
    expect(single.route).toBe('upload');
    expect(single.alternatives).toEqual(expect.arrayContaining(['auth', 'sqli']));
    expect(routeCounts([plan({ id: 'a', route: 'upload', status: 'open' }), plan({ id: 'b', route: 'upload', status: 'done' })])).toEqual({ open: ['upload'], done: ['upload'] });
  });

  it('renders the route sentence, the advisory and ## ROUTES', async () => await planFixture(async ({ board, store, path }) => {
    store.commitRecords([{ runId, by: 'owner', at: '2030', kind: 'candidate', text: 'Inert claim, not a finding',
      data: { candidate: 'claim-single', surface: '/login', risk: 'authorization', closure: 'confirmed', execution: 'tested', gained: [{ kind: 'http.request' }], policyBasis: 'explicit_contract', expectedPolicy: 'fixture', evidenceRefs: [] } }]);
    await board.create({ kind: 'todo', title: 'Only route in the plan', status: 'open', reason: 'Bounded route fixture, no target', claimRefs: [store.records().filter(row => row.kind === 'candidate').at(-1)!.id!] } as PlanDraft);
    const index = await readLedger(path), plans = planFrontier(index);
    expect(plans[0].route).toBe('auth');
    const line = situationLine(summarizeSituation({ tasks: [], cases: [], coverage: [], claims: [], plans }));
    expect(line).toContain('routes: 1 open (auth), 0 done');
    const preflight = finishPreflight(index, { wrote: [] });
    expect(preflight.obligations.map(item => item.code)).not.toContain('ROUTE_MONOCULTURE');
    expect(preflight.advisory.find(item => item.code === 'ROUTE_MONOCULTURE')).toMatchObject({ level: 'advisory', ids: ['auth'] });
    const report = renderReport(index, {}, { runId, target: 'inert', retention: 'durable-local', historical: false, asOfSequence: 1, storeSchema: 1, runtime: { hash: 'inert' }, complete: true, format: 2 }).files.find(file => file.name === 'REPORT.md')!.body;
    expect(report).toContain('## ROUTES');
    expect(report).toContain('| auth |');
  }));
});

describe('negative evidence is a checkpoint, not a wall (P16.6)', () => {
  it('refuses a duplicate ruled_out unless it brings new evidence or a different mechanism', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-neg-'));
    try {
      const path = join(root, 'ledger.jsonl'); await writeFile(path, '');
      await appendRecord(path, { id: 'ev-1', runId, at: '2030', by: 'owner', kind: 'evidence', text: 'First control receipt' });
      await appendRecord(path, { id: 'ev-2', runId, at: '2030', by: 'owner', kind: 'evidence', text: 'Second control receipt' });
      const store = new EvidenceStore(runId, path, 'inert');
      const base: Candidate = { candidate: 'admin-denied', surface: '/admin', risk: 'authorization', closure: 'ruled_out', execution: 'tested', proof: 'live_reproduction',
        evidenceRefs: ['ev-1'], negativeControls: [], policyBasis: 'explicit_contract', expectedPolicy: 'Declared boundary', control: '403 on /admin with the low actor', limitations: 'One actor' };
      await store.candidate('owner', base);
      await expect(store.candidate('owner', { ...base, candidate: 'admin-denied-again' })).rejects.toThrow('RULED_OUT_RECHECK');
      const fresh = await store.candidate('owner', { ...base, candidate: 'admin-denied-fresh', evidenceRefs: ['ev-1', 'ev-2'] });
      expect(fresh.data?.closure).toBe('ruled_out');
      const other = await store.candidate('owner', { ...base, candidate: 'admin-denied-mechanism', control: '404 on the same path from a different actor', evidenceRefs: ['ev-1'] });
      expect(other.data?.control).toContain('404');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('shows a negation nobody proved as unproven-negation', () => {
    const snapshot = summarizeSituation({ tasks: [], cases: [], coverage: [], claims: [{ candidate: 'neg', closure: 'ruled_out', execution: 'not_tested' } as never] });
    expect(snapshot.unprovenNegations).toBe(1);
    expect(situationLine(snapshot)).toContain('1 unproven-negation');
  });
});
