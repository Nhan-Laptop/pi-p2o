import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { IncrementalLedger, LEDGER_BYTES, LEDGER_RECORDS, indexRecords, isRecordKind, readLedger, type AssessmentRecord, type LedgerIndex } from '../../src/records.js';
import { AssessmentStore } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { reportProjection } from '../../src/report.js';
import { taskFrontier, taskHead, taskRevisionAt, type AssessmentTask } from '../../src/tasks.js';
import { derive } from '../../src/ledger-memo.js';
import { statusView, type ViewProfile } from '../../src/ui/state.js';

/** Verbatim copy of the one-shot scanner as it was before the incremental refactor: the oracle for every comparison below. */
function oracleIndex(rows: AssessmentRecord[], runId?: string): LedgerIndex {
  const result: LedgerIndex = { records: [], byId: new Map(), complete: true, diagnostics: [], issueCount: 0, foreign: 0, bytes: 0 };
  const issue = (text: string) => { result.complete = false; result.issueCount++; if (result.diagnostics.length < 40) result.diagnostics.push(text); };
  let lineNumber = 0;
  const taskHeads = new Map<string, AssessmentRecord>();
  const consume = (line: string) => {
    lineNumber++;
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > 16 * 1024) { issue(`Oversized ledger row ${lineNumber}`); return; }
    let row: AssessmentRecord;
    try { row = JSON.parse(line); } catch { issue(`Malformed ledger row ${lineNumber}`); return; }
    if (!row || !isRecordKind(row.kind) || typeof row.text !== 'string' || typeof row.by !== 'string' || typeof row.at !== 'string'
      || (row.data !== undefined && (!row.data || typeof row.data !== 'object' || Array.isArray(row.data)))
      || (row.refs !== undefined && (!Array.isArray(row.refs) || row.refs.some(v => typeof v !== 'string')))
      || (row.supersedes !== undefined && (typeof row.supersedes !== 'string' || row.supersedes.length > 80))) { issue(`Invalid ledger row ${lineNumber}`); return; }
    if (runId && row.runId !== undefined && row.runId !== runId) { result.foreign++; return; }
    if (row.id !== undefined && (typeof row.id !== 'string' || !row.id || row.id.length > 80)) { issue(`Invalid ID at row ${lineNumber}`); return; }
    if (row.id && result.byId.has(row.id)) { issue(`Duplicate ledger ID ${row.id}`); return; }
    if (row.version === 2 && !row.id) issue(`Missing v2 ID at row ${lineNumber}`);
    if (result.records.length >= LEDGER_RECORDS) { issue('Ledger exceeds 100000 records'); return; }
    if (row.kind === 'task') {
      const t = row.data?.task as Record<string, unknown> | undefined, head = typeof t?.id === 'string' ? taskHeads.get(t.id) : undefined;
      if (!t || row.by !== 'owner' || row.workerId || t.runId !== row.runId || typeof t.id !== 'string' || !Array.isArray(t.prerequisites)
        || !['proposed', 'reserved', 'running', 'reported', 'reviewed', 'closed', 'blocked', 'cancelled', 'expired'].includes(String(t.status))
        || !Number.isInteger(t.revision) || (head ? row.supersedes !== head.id || t.revision !== Number((head.data!.task as Record<string, unknown>).revision) + 1 : t.revision !== 1)
        || Object.keys(t).some(k => ['deadline', 'scope', 'token', 'authority', 'target', 'permissions'].includes(k))) { issue(`Invalid owned task revision ${row.id ?? 'missing'}`); return; }
      taskHeads.set(t.id, row);
    }
    result.records.push(row);
    if (row.id) result.byId.set(row.id, row);
  };
  for (const row of rows) {
    const line = JSON.stringify(row); result.bytes += Buffer.byteLength(line) + 1;
    if (result.bytes > LEDGER_BYTES) { issue('Ledger exceeds 64 MiB; reconciliation incomplete'); break; }
    consume(line);
  }
  const prior = new Set<string>();
  for (const row of result.records) {
    if (row.supersedes) {
      const previous = result.byId.get(row.supersedes);
      if (!previous || !prior.has(row.supersedes) || previous === row || previous.kind !== row.kind || (row.kind === 'candidate' && (previous.data?.candidate !== row.data?.candidate || previous.surface !== row.surface || previous.risk !== row.risk))) issue(`Invalid revision ${row.id ?? 'legacy'}`);
    }
    if (row.resolves && (!Array.isArray(row.resolves) || row.resolves.some(id => !prior.has(id) || result.byId.get(id)?.kind !== 'open'))) issue(`Invalid resolution ${row.id ?? 'legacy'}`);
    if (row.id) prior.add(row.id);
  }
  return result;
}

const same = (actual: LedgerIndex, expected: LedgerIndex) => {
  const view = (index: LedgerIndex) => ({ records: [...index.records], ids: [...index.byId.entries()], complete: index.complete, diagnostics: [...index.diagnostics], issueCount: index.issueCount, foreign: index.foreign, bytes: index.bytes });
  expect(view(actual)).toEqual(view(expected));
};

function prng(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** Deterministic corpus mixing valid state with every corruption class the integrity checks name. */
function corpus(seed: number, count: number, runId: string): AssessmentRecord[] {
  const random = prng(seed), rows: AssessmentRecord[] = [], ids: string[] = [], opens: string[] = [], candidates: AssessmentRecord[] = [], tasks = new Map<string, { id: string; revision: number }>();
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
  const base = (n: number, kind: AssessmentRecord['kind'], extra: Partial<AssessmentRecord> = {}): AssessmentRecord => ({ id: `r${seed}-${n}`, runId, at: '2030', by: pick(['owner', 'worker-a', 'worker-b']), kind, text: `row ${n} kind ${kind}`, ...extra });
  for (let n = 0; n < count; n++) {
    const roll = random();
    if (roll < 0.40) { const kind = pick(['note', 'observation', 'evidence', 'lifecycle', 'coverage'] as const), row = base(n, kind, random() < 0.1 ? { version: 2 as const } : {}); rows.push(row); ids.push(row.id!); }
    else if (roll < 0.47) { const row = base(n, 'open'); rows.push(row); ids.push(row.id!); opens.push(row.id!); }
    else if (roll < 0.57) {
      const prior = candidates.length && random() < 0.55 ? pick(candidates) : undefined, bad = random() < 0.2, surface = prior && !bad ? prior.surface : `/s${n % 3}`;
      const row = base(n, 'candidate', { surface, risk: prior && !bad ? prior.risk : 'authorization', supersedes: prior?.id ?? (random() < 0.08 ? 'missing-target' : undefined), data: { candidate: prior && !bad ? prior.data!.candidate : `c${n % 4}`, closure: pick(['confirmed', 'open_proof_gap']) } });
      rows.push(row); ids.push(row.id!); candidates.push(row);
    } else if (roll < 0.65) {
      const known = [...tasks.values()], head = known.length && random() < 0.6 ? pick(known) : undefined, bad = random() < 0.25, taskId = head?.id ?? `task-${n}`;
      const revision = head ? head.revision + (bad ? 2 : 1) : (bad ? 3 : 1);
      const row = base(n, 'task', { by: bad && random() < 0.3 ? 'worker-a' : 'owner', supersedes: head ? `${head.id}-r${head.revision}` : undefined, data: { task: { id: taskId, runId, revision, status: bad && random() < 0.3 ? 'bogus' : 'proposed', prerequisites: [] } } });
      row.id = `${taskId}-r${revision}`; row.data = { task: { ...(row.data!.task as object), id: taskId } };
      rows.push(row); if (!bad || random() < 0.5) { ids.push(row.id); tasks.set(taskId, { id: taskId, revision }); }
    } else if (roll < 0.71 && opens.length) {
      const row = base(n, 'note', { resolves: random() < 0.75 ? [pick(opens)] : ['not-an-open-row'] }); rows.push(row); ids.push(row.id!);
    } else if (roll < 0.76) rows.push({ ...base(n, 'note'), runId: 'other-run' });
    else if (roll < 0.80 && ids.length) rows.push({ ...base(n, 'note'), id: pick(ids) });
    else if (roll < 0.85) rows.push({ ...base(n, 'note'), kind: 'bogus' } as unknown as AssessmentRecord);
    else if (roll < 0.88) rows.push({ ...base(n, 'note'), text: undefined } as unknown as AssessmentRecord);
    else if (roll < 0.90) rows.push({ ...base(n, 'note'), text: 'x'.repeat(17 * 1024) });
    else if (roll < 0.92) rows.push({ ...base(n, 'note'), supersedes: pick(ids.length ? ids : ['self']) });
    else { const row = base(n, 'note'); delete row.runId; delete (row as Partial<AssessmentRecord>).id; rows.push(row); }
  }
  return rows;
}

describe('incremental canonical ledger projection (K6 index)', () => {
  it('keeps one-shot indexRecords byte-for-byte equal to the pre-refactor scanner on valid and corrupt corpora', () => {
    let corrupt = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const rows = corpus(seed, 40 + seed * 3, 'run-x'), actual = indexRecords(rows, 'run-x'), expected = oracleIndex(rows, 'run-x');
      same(actual, expected); if (!actual.complete) corrupt++;
    }
    expect(corrupt, 'the corpus must actually exercise the issue paths').toBeGreaterThan(60);
    same(indexRecords(corpus(7, 120, 'run-x')), oracleIndex(corpus(7, 120, 'run-x'))); // no run filter
  });

  it('equals a full scan at every batch prefix, for every random batching', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rows = corpus(1000 + seed, 60 + seed * 2, 'run-x'), random = prng(seed), ledger = new IncrementalLedger('run-x');
      for (let offset = 0; offset < rows.length;) {
        const size = 1 + Math.floor(random() * 17); ledger.append(rows.slice(offset, offset + size)); offset += size;
        same(ledger.snapshot(), oracleIndex(rows.slice(0, offset), 'run-x'));
      }
      same(ledger.snapshot(), indexRecords(rows, 'run-x'));
    }
  });

  it('reports the same diagnostics when rows arrive one at a time (row issues before link issues, first 40)', () => {
    const rows = corpus(4242, 400, 'run-x'), ledger = new IncrementalLedger('run-x');
    for (const row of rows) ledger.append([row]);
    const incremental = ledger.snapshot(), full = oracleIndex(rows, 'run-x');
    expect(full.issueCount).toBeGreaterThan(40); expect(incremental.diagnostics).toEqual(full.diagnostics); expect(incremental.diagnostics).toHaveLength(40); same(incremental, full);
  });

  it('stops at the 64 MiB byte bound exactly like a full scan, even when the bound is crossed inside a later batch', () => {
    const filler = 'y'.repeat(15 * 1024), rows: AssessmentRecord[] = [];
    let total = 0;
    for (let n = 0; total < LEDGER_BYTES + 3 * 16 * 1024; n++) { const row: AssessmentRecord = { id: `big-${n}`, runId: 'run-x', at: '2030', by: 'owner', kind: 'note', text: filler }; rows.push(row); total += Buffer.byteLength(JSON.stringify(row)) + 1; }
    const ledger = new IncrementalLedger('run-x');
    for (let offset = 0; offset < rows.length; offset += 700) ledger.append(rows.slice(offset, offset + 700));
    const full = oracleIndex(rows, 'run-x');
    expect(full.complete).toBe(false); expect(full.diagnostics).toContain('Ledger exceeds 64 MiB; reconciliation incomplete');
    same(ledger.snapshot(), full); ledger.append(rows.slice(0, 5).map((row, n) => ({ ...row, id: `late-${n}` }))); same(ledger.snapshot(), full); // nothing is read past the bound
  }, 60_000);

  it('applies the 100000-row cap identically', () => {
    const rows: AssessmentRecord[] = Array.from({ length: LEDGER_RECORDS + 40 }, (_, n) => ({ id: `n-${n}`, runId: 'run-x', at: '2030', by: 'owner', kind: 'note' as const, text: 't' }));
    const ledger = new IncrementalLedger('run-x');
    for (let offset = 0; offset < rows.length; offset += 6000) ledger.append(rows.slice(offset, offset + 6000));
    const incremental = ledger.snapshot(), full = oracleIndex(rows, 'run-x');
    expect(full.records).toHaveLength(LEDGER_RECORDS); expect(full.issueCount).toBe(40); same(incremental, full);
  }, 120_000);

  it('hands out immutable snapshots: later rows never change an earlier view and nothing can be edited in place', () => {
    const ledger = new IncrementalLedger('run-x'), rows = corpus(9, 30, 'run-x');
    ledger.append(rows.slice(0, 10)); const first = ledger.snapshot(11), length = first.records.length, ids = first.byId.size;
    ledger.append(rows.slice(10)); const second = ledger.snapshot(12);
    expect(first.records).toHaveLength(length); expect(first.byId.size).toBe(ids); expect(second.records.length).toBeGreaterThan(length);
    expect(first.snapshotSequence).toBe(11); expect(second.snapshotSequence).toBe(12); expect(ledger.snapshot().records).toBe(second.records); // unchanged ledger: no copy
    expect(Object.isFrozen(second.records)).toBe(true); expect(Object.isFrozen(second.diagnostics)).toBe(true);
    const row = second.records.find(item => item.data)!;
    expect(() => { (row as { text: string }).text = 'tampered'; }).toThrow(TypeError);
    expect(() => { (row.data as Record<string, unknown>).injected = true; }).toThrow(TypeError);
    expect(() => { (second.records as AssessmentRecord[]).push(row); }).toThrow(TypeError);
  });

  describe('canonical store adapter', () => {
    async function fixture(work: (h: { store: AssessmentStore; path: string; runId: string }) => Promise<void> | void) {
      const root = await mkdtemp(join(tmpdir(), 'p2o-incremental-')), runId = 'run-incremental', path = join(root, 'alias.sqlite');
      const store = AssessmentStore.create(root, { runId, retention: 'durable-local', targetKind: 'directory', targetIdentity: 'fixture', targetDisplay: 'fixture', profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } }), unbind = bindAssessmentStore(path, store);
      try { await work({ store, path, runId }); } finally { unbind(); store.close(); await rm(root, { recursive: true, force: true }); }
    }
    const note = (runId: string, text: string, extra: Partial<AssessmentRecord> = {}): AssessmentRecord => ({ id: randomUUID(), runId, at: '2030', by: 'owner', kind: 'note', text, ...extra });
    const task = (runId: string, id: string, revision: number, prior?: string): AssessmentRecord => ({ id: `${id}-r${revision}`, runId, at: '2030', by: 'owner', kind: 'task', text: `task ${id}@r${revision}`, supersedes: prior, data: { task: { id, runId, revision, status: revision % 2 ? 'proposed' : 'reported', role: 'general', question: 'q', prerequisites: [], evidenceIds: [] } } });

    it('serves exactly indexRecords(store.records()) after every commit, with the committed sequence', () => fixture(async ({ store, path, runId }) => {
      const verify = async () => { const index = await readLedger(path, runId); same(index, indexRecords(store.records(), runId)); expect(index.snapshotSequence).toBe(store.sequence()); return index; };
      expect((await verify()).records).toHaveLength(0);
      const gap = note(runId, 'open gap'); store.commitRecords([{ ...gap, kind: 'open' }]); await verify();
      for (let n = 0; n < 12; n++) {
        const revision = Math.floor(n / 3) + 1;
        store.commitRecords([task(runId, `task-${n % 3}`, revision, revision > 1 ? `task-${n % 3}-r${revision - 1}` : undefined), note(runId, `observation ${n}`, { kind: 'observation' })]); await verify();
      }
      store.commitRecords([note(runId, 'resolves the gap', { resolves: [gap.id!] })]); const index = await verify();
      expect(index.complete).toBe(true); expect(index.records.length).toBe(store.records().length);
      const again = await readLedger(path, runId); expect(again.records).toBe(index.records); // unchanged ledger: the same immutable snapshot, no copy
    }));

    it('reads only rows it has not seen: one page request per read once warm, never a full history reload', () => fixture(async ({ store, path, runId }) => {
      store.commitRecords(Array.from({ length: 30 }, (_, n) => note(runId, `seed ${n}`))); await readLedger(path, runId);
      const spy = vi.spyOn(AssessmentStore.prototype, 'recordsSince'), all = vi.spyOn(AssessmentStore.prototype, 'records');
      try {
        await readLedger(path, runId); store.commitRecords([note(runId, 'one more')]); const index = await readLedger(path, runId);
        expect(index.records).toHaveLength(31); expect(all).not.toHaveBeenCalled();
        expect(spy.mock.calls.every(([sequence]) => sequence > 0)).toBe(true); // always resumes after the last consumed sequence
        expect(spy.mock.results.map(result => (result.value as unknown[]).length)).toEqual([0, 1]);
      } finally { spy.mockRestore(); all.mockRestore(); }
    }));

    it('drops the cache after a failed update and rebuilds the identical projection from the store', () => fixture(async ({ store, path, runId }) => {
      store.commitRecords(Array.from({ length: 5 }, (_, n) => note(runId, `a ${n}`))); await readLedger(path, runId); store.commitRecords([note(runId, 'b')]);
      const original = AssessmentStore.prototype.recordsSince; let fail = true;
      const spy = vi.spyOn(AssessmentStore.prototype, 'recordsSince').mockImplementation(function (this: AssessmentStore, ...args: Parameters<AssessmentStore['recordsSince']>) { if (fail) { fail = false; throw Error('simulated read fault'); } return original.apply(this, args); });
      try {
        await expect(readLedger(path, runId)).rejects.toThrow('simulated read fault');
        same(await readLedger(path, runId), indexRecords(store.records(), runId)); expect(spy.mock.calls.at(-1)![0]).toBeGreaterThanOrEqual(0);
      } finally { spy.mockRestore(); }
    }));

    it('never trusts a half-applied update: a throw after some rows were indexed forces a rebuild, not duplicated rows', () => fixture(async ({ store, path, runId }) => {
      store.commitRecords(Array.from({ length: 4 }, (_, n) => note(runId, `warm ${n}`))); await readLedger(path, runId);
      store.commitRecords(Array.from({ length: 3 }, (_, n) => note(runId, `late ${n}`)));
      const original = IncrementalLedger.prototype.append; let armed = true;
      const spy = vi.spyOn(IncrementalLedger.prototype, 'append').mockImplementation(function (this: IncrementalLedger, rows: AssessmentRecord[]) { original.call(this, rows.slice(0, 1)); if (armed) { armed = false; throw Error('fault after one row'); } });
      try {
        await expect(readLedger(path, runId)).rejects.toThrow('fault after one row');
        spy.mockRestore(); const rebuilt = await readLedger(path, runId);
        expect(rebuilt.complete).toBe(true); expect(rebuilt.issueCount).toBe(0); same(rebuilt, indexRecords(store.records(), runId));
      } finally { spy.mockRestore(); }
    }));

    it('keeps projections for different run filters independent and never mixes foreign rows into another run', () => fixture(async ({ store, path, runId }) => {
      store.commitRecords([note(runId, 'mine')]);
      const mine = await readLedger(path, runId), other = await readLedger(path, 'someone-else'), back = await readLedger(path, runId);
      expect(mine.records).toHaveLength(1); expect(other.records).toHaveLength(0); expect(other.foreign).toBe(1); same(back, indexRecords(store.records(), runId));
    }));

    it('validates page requests and refuses reads after close', () => fixture(async ({ store }) => {
      for (const bad of [[-1, 10], [1.5, 10], [Number.NaN, 10], [0, 0], [0, 10001], [0, 2.5]] as const) expect(() => store.recordsSince(bad[0], bad[1])).toThrow('Invalid record page request');
      expect(store.recordsSince(0, 1)).toEqual([]);
      store.close(); expect(() => store.recordsSince(0)).toThrow();
    }));
  });
});

describe('status and report projections over an incremental snapshot', () => {
  const profile: ViewProfile = { runId: 'run-x', target: 'fixture', lifecycle: 'active', delegation: false, maxWorkers: 3, exportEnabled: false,
    engine: { mode: 'manual', pendingIntents: 0, rounds: 0, maxAutomaticRounds: 100, paused: undefined, decision: undefined } as ViewProfile['engine'], executor: { mode: 'shared', maxTargetOperations: 1 }, retention: 'durable-local', stateLocation: '/fixture' };

  it('renders the same status, widget and report projection (including the lazily computed version) as a full scan', () => {
    let incomplete = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rows = corpus(2000 + seed, 50 + seed * 2, 'run-x'), ledger = new IncrementalLedger('run-x');
      for (let offset = 0; offset < rows.length; offset += 13) ledger.append(rows.slice(offset, offset + 13));
      const incremental = ledger.snapshot(rows.length), full = { ...oracleIndex(rows, 'run-x'), snapshotSequence: rows.length };
      expect(statusView(incremental, profile)).toEqual(statusView(full, profile));
      expect(JSON.stringify(reportProjection(incremental))).toBe(JSON.stringify(reportProjection(full)));
      if (!incremental.complete) incomplete++;
    }
    expect(incomplete, 'corrupt corpora must reach the incomplete-state labels too').toBeGreaterThan(30);
  });

  it('computes the content digest only when version is read, and to the same value as an eager digest', () => {
    const rows = corpus(77, 60, 'run-x'), index = indexRecords(rows, 'run-x');
    const eager = createHash('sha256').update(index.records.map(row => `${JSON.stringify(row)}\n`).join('')).digest('hex'), projection = reportProjection(index);
    expect(projection.version).toBe(eager); expect(projection.version).toBe(eager);
    expect(JSON.parse(JSON.stringify(projection)).version).toBe(eager); expect({ ...projection }.version).toBe(eager);
    const trap = indexRecords([{ id: 'n1', runId: 'run-x', at: '2030', by: 'owner', kind: 'note', text: 'x' }], 'run-x');
    (trap.records[0] as unknown as { toJSON(): never }).toJSON = () => { throw Error('digest computed eagerly'); };
    expect(() => reportProjection(trap)).not.toThrow(); expect(() => statusView(trap, profile)).not.toThrow();
    expect(() => reportProjection(trap).version).toThrow('digest computed eagerly');
  });
});

describe('memoised task lookups (K6 status path)', () => {
  /** Verbatim copies of the lookups as they were before memoisation. */
  const legacyFrontier = (index: LedgerIndex) => { const latest = new Map<string, AssessmentTask>(); for (const r of index.records) if (r.kind === 'task' && r.by === 'owner' && !r.workerId && r.data?.task) { const t = r.data.task as AssessmentTask; if (t.runId === r.runId && typeof t.id === 'string') latest.set(t.id, { ...t, recordId: r.id! }); } return [...latest.values()]; };
  const legacyAt = (index: LedgerIndex, id: string, revision: unknown) => index.records.filter(row => row.kind === 'task').map(row => row.data?.task as AssessmentTask | undefined).find(task => task?.id === id && task.revision === revision);
  const handBuilt = (records: AssessmentRecord[]): LedgerIndex => ({ records, byId: new Map(), complete: true, diagnostics: [], issueCount: 0, foreign: 0, bytes: 0 });
  const taskRow = (n: number, by: string, task: unknown, extra: Partial<AssessmentRecord> = {}): AssessmentRecord => ({ id: `t${n}`, runId: 'run-x', at: '2030', by, kind: 'task', text: 'task', data: { task } as AssessmentRecord['data'], ...extra });

  it('returns exactly what the legacy scans returned, for validated ledgers and hand-built odd indexes', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const index = indexRecords(corpus(3000 + seed, 120, 'run-x'), 'run-x'), taskIds = new Set<string>();
      for (const row of index.records) if (row.kind === 'task') taskIds.add((row.data!.task as AssessmentTask).id);
      expect(taskFrontier(index)).toEqual(legacyFrontier(index));
      for (const id of [...taskIds, 'task-missing']) for (const revision of [1, 2, 3, 4, undefined, '1']) expect(taskRevisionAt(index, id, revision)).toBe(legacyAt(index, id, revision));
      for (const id of taskIds) expect(taskHead(index, id)).toEqual(legacyFrontier(index).find(task => task.id === id));
      expect(taskHead(index, 'task-missing')).toBeUndefined();
    }
    const odd = handBuilt([
      taskRow(1, 'owner', { id: 'a', runId: 'run-x', revision: 1, status: 'proposed' }), taskRow(2, 'worker-a', { id: 'a', runId: 'run-x', revision: 1, status: 'closed' }), // same (id, revision), worker-authored: first row wins
      taskRow(3, 'owner', { id: 'a', runId: 'run-x', revision: 2, status: 'reported' }), taskRow(4, 'owner', { id: 'a', runId: 'run-x', revision: 3 }, { workerId: 'w' }), // owner row with a worker id is not a head
      taskRow(5, 'owner', { id: 'b', runId: 'other', revision: 1 }), taskRow(6, 'owner', { id: 7, runId: 'run-x', revision: 1 }), taskRow(7, 'owner', 'not-an-object'), taskRow(8, 'owner', null),
      taskRow(9, 'owner', { id: 'c', runId: 'run-x' }), taskRow(10, 'owner', { id: 'c', runId: 'run-x', revision: '1' }), taskRow(11, 'owner', { id: 'c', runId: 'run-x', revision: 1 }),
      { id: 'n1', runId: 'run-x', at: '2030', by: 'owner', kind: 'note', text: 'not a task', data: { task: { id: 'a', revision: 9 } } } as AssessmentRecord,
    ]);
    expect(taskFrontier(odd)).toEqual(legacyFrontier(odd));
    for (const id of ['a', 'b', 'c', '7', 'z']) for (const revision of [1, 2, 3, 9, '1', undefined, null]) expect(taskRevisionAt(odd, id, revision), `${id}@${String(revision)}`).toBe(legacyAt(odd, id, revision));
    expect(taskRevisionAt(odd, 'a', 1)!.status).toBe('proposed'); expect(taskRevisionAt(odd, 'c', undefined)).toBe(legacyAt(odd, 'c', undefined));
  });

  it('computes each derivation once per record list, shared by every view of one snapshot, and never serves a grown list stale', () => {
    const ledger = new IncrementalLedger('run-x'), rows = corpus(31, 80, 'run-x'); ledger.append(rows);
    let builds = 0; const build = (records: AssessmentRecord[]) => { builds++; return records.length; };
    const first = ledger.snapshot(1), second = ledger.snapshot(2);
    expect(first).not.toBe(second); expect(first.records).toBe(second.records);
    derive(first, 'probe', build); derive(second, 'probe', build); derive(first, 'probe', build); expect(builds).toBe(1);
    derive(first, 'other', build); expect(builds).toBe(2);
    ledger.append([{ id: 'late', runId: 'run-x', at: '2030', by: 'owner', kind: 'note', text: 'late row' }]); derive(ledger.snapshot(3), 'probe', build); expect(builds).toBe(3); // a new snapshot has its own cache
    const growing = handBuilt([taskRow(1, 'owner', { id: 'a', runId: 'run-x', revision: 1 })]);
    expect(taskHead(growing, 'a')!.revision).toBe(1); growing.records.push(taskRow(2, 'owner', { id: 'a', runId: 'run-x', revision: 2 })); expect(taskHead(growing, 'a')!.revision).toBe(2); expect(taskRevisionAt(growing, 'a', 2)).toBeDefined();
  });

  it('gives callers independent copies of the frontier so editing a result cannot corrupt the cache', () => {
    const index = indexRecords([taskRow(1, 'owner', { id: 'a', runId: 'run-x', revision: 1, status: 'proposed', prerequisites: [] })], 'run-x'), before = taskFrontier(index);
    expect(index.complete).toBe(true); expect(before).toHaveLength(1);
    before[0].status = 'closed'; before.push({ ...before[0], id: 'phantom' });
    expect(taskFrontier(index)).toHaveLength(1); expect(taskFrontier(index)[0].status).toBe('proposed'); expect(taskHead(index, 'a')!.status).toBe('proposed'); expect(taskHead(index, 'phantom')).toBeUndefined();
  });
});
