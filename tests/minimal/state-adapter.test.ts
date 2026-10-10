import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssessmentStore, type StoreFault } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { appendRecord, appendRecords, readLedger, observeRecords, recordsSize, waitForRecordChange } from '../../src/records.js';
import { TaskBoard, type TaskDraft } from '../../src/tasks.js';
import { EvidenceStore, type Candidate } from '../../src/evidence.js';
import { persistReport, recoverReports } from '../../src/report.js';
import type { WorkerReport } from '../../src/broker.js';

const draft: TaskDraft = { id: 'task-fixture', question: 'Does the declared gate reach the consumer?', surface: '/fixture', risk: 'authorization', role: 'discovery',
  roleReason: 'A bounded fixture question selected by the owner', expectedTrue: 'Expected actor reaches the consumer', expectedFalse: 'Unexpected actor reaches the consumer',
  stopCondition: 'Stop after the bounded comparison', evidenceIds: [], prerequisites: [], method: { skills: [], reason: 'Inert offline comparison only' } };
const report: WorkerReport = { summary: 'Inert partial fixture', findings: [], evidence: [], coverage: [{ surface: '/fixture', risk: 'authorization', outcome: 'open_proof_gap' }],
  openItems: ['Actor policy remains unresolved'], confidence: 'low', outcome: 'prerequisite-blocked' };
const req = (requestId: string) => ({ actorId: 'worker', requestId, payload: report });
async function fixture(work: (root: string, path: string, store: AssessmentStore) => Promise<void>, fault?: StoreFault) {
  const root = await mkdtemp(join(tmpdir(), 'p2o-adapter-'));
  const store = AssessmentStore.create(root, { runId: 'run-fixture', targetKind: 'directory', targetIdentity: 'fixture', targetDisplay: 'inert', retention: 'durable-local',
    profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } }, { fault });
  const path = join(root, 'state.sqlite'), unbind = bindAssessmentStore(path, store);
  try { await work(root, path, store); } finally { unbind(); store.close(); await rm(root, { recursive: true, force: true }); }
}

// These tests qualify the adapter independently; the extension has not switched its run backend yet.
describe('same canonical task/evidence/report services, no duplicate JSONL authority', () => {
  it('returns durable ACK and snapshot sequence through existing APIs, with one UI hint per commit', async () => fixture(async (_root, path, store) => {
    let hints = 0; const off = observeRecords(path, () => { hints++; });
    try {
      const ack = await appendRecord(path, { at: '2030', by: 'owner', kind: 'note', text: 'fixture' }); expect(ack).toMatchObject({ sequence: 1, storeVersion: 7, version: 2 });
      expect((await readLedger(path)).snapshotSequence).toBe(1); expect(await recordsSize(path)).toBe(1);
      await appendRecords(path, [{ at: '2030', by: 'owner', kind: 'open', text: 'gap' }, { at: '2030', by: 'owner', kind: 'note', text: 'another' }]);
      expect(hints).toBe(2); expect(store.records()).toHaveLength(3); expect((await readLedger(path, 'run-fixture')).complete).toBe(true);
      expect(await stat(path).catch(() => undefined)).toBeUndefined();
      const since = await recordsSize(path); store.event({ actorId: 'owner', kind: 'run.paused', occurredAt: '2030', summary: 'paused' });
      expect(await waitForRecordChange(path, { since, timeoutMs: 1 })).toBe(true);
    } finally { off(); }
  }));
  it('denies unbound/closed SQLite aliases instead of falling back to a competing JSONL writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-unbound-')); const path = join(root, 'state.sqlite');
    try {
      await expect(appendRecord(path, { at: '2030', by: 'owner', kind: 'note', text: 'no writer' })).rejects.toThrow('no active host adapter');
      await expect(readLedger(path)).rejects.toThrow('historical'); expect(await stat(path).catch(() => undefined)).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains TaskBoard active-owner and accepted prerequisite gates on the store adapter', async () => fixture(async (_root, path) => {
    let active = true; const board = new TaskBoard('run-fixture', path, () => active);
    const created = await board.create(draft); expect(created.status).toBe('proposed');
    const child = await board.create({ ...draft, id: 'task-child', surface: '/child', prerequisites: [{ taskId: created.id }] });
    await expect(board.reserve(child.id, 'worker-child')).rejects.toThrow('lead-accepted');
    await board.reserve(created.id, 'worker'); await board.transition(created.id, 'running', 'fixture worker started');
    await expect(board.transition(created.id, 'reviewed', 'not a handoff', ['missing'])).rejects.toThrow('reported');
    active = false; await expect(board.create({ ...draft, id: 'other' })).rejects.toThrow('authority inactive');
  }));
  it('commits full normalized report/task/coverage/open packet together, including lost-ACK replay', async () => {
    let fail: string | undefined;
    await fixture(async (_root, path, store) => {
      const board = new TaskBoard('run-fixture', path, () => true); const task = await board.create(draft);
      await board.reserve(task.id, 'worker'); await board.transition(task.id, 'running', 'fixture worker running');
      const initial = store.records().length;
      fail = 'before-commit'; await expect(board.handoff(task.id, 'worker', report, 'discovery', 1, req('handoff'))).rejects.toThrow('injected');
      expect(store.records()).toHaveLength(initial); expect((await board.list())[0].status).toBe('running'); expect(recoverReports(await readLedger(path)).reports).toHaveLength(0);
      fail = 'after-commit'; await expect(board.handoff(task.id, 'worker', report, 'discovery', 1, req('handoff'))).rejects.toThrow('injected');
      const committed = store.records().length; expect((await board.list())[0].status).toBe('reported');
      fail = undefined; const a = await board.handoff(task.id, 'worker', report, 'discovery', 1, req('handoff'));
      const b = await board.handoff(task.id, 'worker', report, 'discovery', 1, req('handoff')); expect(b).toEqual(a); expect(store.records()).toHaveLength(committed);
      const index = await readLedger(path); expect(index.complete).toBe(true); expect(recoverReports(index).reports).toHaveLength(1);
      expect(index.records.filter(r => r.kind === 'coverage')).toHaveLength(1); expect(index.records.filter(r => r.kind === 'open')).toHaveLength(1);
      expect((await board.list())[0]).toMatchObject({ status: 'reported', handoffId: recoverReports(index).reports[0].id });
      await expect(board.handoff(task.id, 'worker', { ...report, summary: 'changed' }, 'discovery', 1, req('handoff'))).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    }, stage => { if (stage === fail) throw Error('injected packet failure'); });
  });
  it('records no-investigation handoff from a reserved worker as blocked, not reviewed/completed', async () => fixture(async (_root, path, store) => {
    const board = new TaskBoard('run-fixture', path, () => true); const task = await board.create(draft); await board.reserve(task.id, 'worker');
    await board.handoff(task.id, 'worker', { ...report, blocked: 'Runtime profile mismatch; no investigation' }, 'discovery', 1, req('blocked'));
    const current = (await board.list())[0]; expect(current.status).toBe('blocked'); expect(current.reviewReason).toBeUndefined();
    expect(store.checkpoint('blocked packet').pendingReviews).toEqual([task.id]); expect(recoverReports(await readLedger(path)).reports).toHaveLength(1);
  }));
  it('keeps report fragment hashes valid across redaction, idempotent delivery, and legacy export', async () => fixture(async (root, path, store) => {
    const long = { ...report, summary: 'Authorization: fixture-secret', findings: ['password=fixture-secret\n' + '観'.repeat(900), ...Array(19).fill('x'.repeat(900))] };
    const key = { actorId: 'worker', requestId: 'large-report', payload: {} };
    const id = await persistReport(path, 'run-fixture', 'worker', long, 'discovery', 1, key);
    expect(await persistReport(path, 'run-fixture', 'worker', long, 'discovery', 1, key)).toBe(id);
    await expect(persistReport(path, 'run-fixture', 'worker', { ...long, summary: 'changed' }, 'discovery', 1, key)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    const index = await readLedger(path); expect(recoverReports(index).diagnostics).toEqual([]); expect(recoverReports(index).reports).toHaveLength(1);
    expect(JSON.stringify(index.records)).not.toContain('fixture-secret');
    const evidence = new EvidenceStore('run-fixture', path, 'fixture'); const exported = JSON.parse(await readFile(await evidence.exportTo(root, {}), 'utf8'));
    expect(exported.records).toHaveLength(store.records().length); expect(exported.reconciliation.complete).toBe(true);
  }));
  it('preserves evidence ID/proof/current independent-support gates instead of promoting stored claims', async () => fixture(async (_root, path) => {
    const evidence = new EvidenceStore('run-fixture', path, 'fixture'), result = { code: 0, stdout: 'inert', stderr: '', truncated: false };
    const ref = await evidence.receipt('validator', 'shell', 'inert fixture', result, '2030');
    const candidate: Candidate = { candidate: 'gate', surface: '/fixture', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction',
      evidenceRefs: [ref], negativeControls: [], limitations: 'Inert fixture, not actual proof', policyBasis: 'boundary_invariant', expectedPolicy: 'Declared actor reaches consumer only' };
    const prior = await evidence.candidate('validator', candidate);
    const accepted = await evidence.candidate('owner', { ...candidate, supersedes: prior.id, independentEvidenceRef: ref });
    await evidence.candidate('validator', { ...candidate, supersedes: accepted.id, closure: 'open_proof_gap' });
    const latest = (await readLedger(path)).records.filter(r => r.kind === 'candidate').at(-1)!;
    await expect(evidence.candidate('owner', { ...candidate, supersedes: latest.id, independentEvidenceRef: ref })).rejects.toThrow('matching runtime');
    await expect(evidence.candidate('owner', { ...candidate, candidate: 'another', evidenceRefs: ['foreign'] })).rejects.toThrow('same-run');
  }));
});
