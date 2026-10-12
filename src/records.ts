import { appendFile, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { recordBackend, type WorkHistoryPage, type WorkHistoryRow } from './state/registry.js';
import type { MutationRequest } from './state/store.js';

/**
 * Append-only shared state. This is the coordination medium between the owner and its workers,
 * mirroring Strix's notes/coverage ledger: the next agent reads state, not someone's reasoning.
 * Nothing in this file is authority — scope comes from the human, evidence is verified elsewhere.
 */
export const RECORD_KINDS = ['note', 'coverage', 'observation', 'open', 'report', 'lifecycle', 'evidence', 'candidate', 'report_part', 'task', 'surface'] as const;
export type RecordKind = typeof RECORD_KINDS[number];
export const COVERAGE_OUTCOMES = ['confirmed', 'ruled_out', 'open_proof_gap', 'clean', 'needs_follow_up'] as const;
export type CoverageOutcome = typeof COVERAGE_OUTCOMES[number];

export interface AssessmentRecord {
  version?: 2;
  id?: string;
  runId?: string;
  data?: Record<string, unknown>;
  supersedes?: string;
  resolves?: string[];
  at: string;
  by: string;
  kind: RecordKind;
  text: string;
  workerId?: string;
  role?: string;
  depth?: number;
  surface?: string;
  risk?: string;
  outcome?: CoverageOutcome;
  refs?: string[];
}

export const RECORD_READ_LIMIT = 500;

export function isRecordKind(value: unknown): value is RecordKind { return typeof value === 'string' && (RECORD_KINDS as readonly string[]).includes(value); }
export function isOutcome(value: unknown): value is CoverageOutcome { return typeof value === 'string' && (COVERAGE_OUTCOMES as readonly string[]).includes(value); }

export interface RecordAck { recordId: string; version: 2; sequence?: number; storeVersion?: number }
const observers = new Map<string, Set<() => void>>();
/** Process-local UI hints only. Not durable delivery, authority, or semantic Planner wakes. */
export function observeRecords(path: string, observer: () => void): () => void {
  const set = observers.get(path) ?? new Set<() => void>();
  set.add(observer); observers.set(path, set);
  return () => { set.delete(observer); if (!set.size) observers.delete(path); };
}

/** Process-local committed-write hint. Never an execution authorization or semantic wake. */
export function notifyRecordObservers(path: string): void {
  for (const observer of observers.get(path) ?? []) { try { observer(); } catch { /* Rendering cannot mask commit. */ } }
}

/** Canonical transaction ACK when bound; legacy O_APPEND ACK has no durability/sequence claim. */
export async function appendRecord(path: string, record: AssessmentRecord): Promise<RecordAck> {
  const backend = recordBackend(path); if (backend) return backend.append([record])[0];
  const recordId = record.id ?? randomUUID();
  const line = `${JSON.stringify({ ...record, version: 2, id: recordId })}\n`;
  if (Buffer.byteLength(line) > 16 * 1024) throw new Error('Record is too large');
  await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
  notifyRecordObservers(path);
  return { recordId, version: 2 };
}

/** One canonical transaction; legacy exports retain explicitly non-atomic append compatibility. */
export async function appendRecords(path: string, records: AssessmentRecord[], request?: MutationRequest): Promise<RecordAck[]> {
  const backend = recordBackend(path); if (backend) return backend.append(records, request);
  if (request) throw Error('Idempotent record packets require the canonical store');
  const acknowledgments: RecordAck[] = [];
  for (const record of records) acknowledgments.push(await appendRecord(path, record));
  return acknowledgments;
}

/** Generated packet IDs/times are created after the store's request lookup, so lost ACKs are safe. */
export async function appendGeneratedRecords(path: string, makeRecords: () => AssessmentRecord[], request: MutationRequest): Promise<RecordAck[]> {
  const backend = recordBackend(path);
  if (!backend) throw Error('Idempotent generated packets require the canonical store');
  return backend.generated(makeRecords, request);
}
/** Retained ACK inspection only; never invokes a record builder or restores mutation authority. */
export async function readGeneratedRecords(path:string,request:MutationRequest):Promise<RecordAck[]|undefined>{
  const backend=recordBackend(path);if(!backend?.generatedResult)throw Error('Retained generated ACK lookup requires the canonical store');return backend.generatedResult(request);
}

export const LEDGER_BYTES = 64 * 1024 * 1024;
export const LEDGER_RECORDS = 100000;
export interface LedgerIndex {
  records: AssessmentRecord[]; byId: Map<string, AssessmentRecord>; complete: boolean;
  diagnostics: string[]; issueCount: number; foreign: number; bytes: number; snapshotSequence?: number;
}

/** Complete bounded scan of the run-owned regular file. A display tail is never authority. */
function ledgerBuilder(runId?: string) {
  const result: LedgerIndex = { records: [], byId: new Map(), complete: true, diagnostics: [], issueCount: 0, foreign: 0, bytes: 0 };
  // Row issues and revision/resolution link issues are kept apart so an incremental scan reports exactly the diagnostics
  // (first 40, rows before links) that one full scan would; a one-shot scan is unchanged.
  const phases = { rows: [] as string[], links: [] as string[] };
  const issue = (text: string, phase: 'rows' | 'links' = 'rows') => {
    result.complete = false; result.issueCount++;
    const list = phases[phase]; if (list.length < 40) list.push(text);
    result.diagnostics = [...phases.rows, ...phases.links].slice(0, 40);
  };
  let lineNumber = 0;
  const taskHeads = new Map<string,AssessmentRecord>();
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
      const t = row.data?.task as Record<string,unknown> | undefined, head = typeof t?.id === 'string' ? taskHeads.get(t.id) : undefined;
      if (!t || row.by !== 'owner' || row.workerId || t.runId !== row.runId || typeof t.id !== 'string' || !Array.isArray(t.prerequisites)
        || !['proposed','reserved','running','reported','reviewed','closed','blocked','cancelled','expired'].includes(String(t.status))
        || !Number.isInteger(t.revision) || (head ? row.supersedes !== head.id || t.revision !== Number((head.data!.task as Record<string,unknown>).revision)+1 : t.revision !== 1)
        || Object.keys(t).some(k => ['deadline','scope','token','authority','target','permissions'].includes(k))) { issue(`Invalid owned task revision ${row.id ?? 'missing'}`); return; }
      taskHeads.set(t.id,row);
    }
    result.records.push(row);
    if (row.id) result.byId.set(row.id, row);
  };
  // Only rows after the last call are linked; a later row can never validate an earlier one (`prior` is order-based), so
  // linking appended rows once equals one full pass.
  const prior = new Set<string>();
  let linked = 0;
  const finish = () => {
    for (; linked < result.records.length; linked++) {
      const row = result.records[linked];
      if (row.supersedes) {
        const previous = result.byId.get(row.supersedes);
        if (!previous || !prior.has(row.supersedes) || previous === row || previous.kind !== row.kind || (row.kind === 'candidate' && (previous.data?.candidate !== row.data?.candidate || previous.surface !== row.surface || previous.risk !== row.risk))) issue(`Invalid revision ${row.id ?? 'legacy'}`, 'links');
      }
      if (row.resolves && (!Array.isArray(row.resolves) || row.resolves.some(id => !prior.has(id) || result.byId.get(id)?.kind !== 'open'))) issue(`Invalid resolution ${row.id ?? 'legacy'}`, 'links');
      if (row.id) prior.add(row.id);
    }
    return result;
  };
  return { result, consume, issue, finish };
}

/** Shared v2 integrity checks for both historical JSONL and canonical-store projections. */
export function indexRecords(rows: AssessmentRecord[], runId?: string): LedgerIndex {
  const builder = ledgerBuilder(runId);
  for (const row of rows) {
    const line = JSON.stringify(row); builder.result.bytes += Buffer.byteLength(line) + 1;
    if (builder.result.bytes > LEDGER_BYTES) { builder.issue('Ledger exceeds 64 MiB; reconciliation incomplete'); break; }
    builder.consume(line);
  }
  return builder.finish();
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freezeDeep(child); }
  return value;
}

/**
 * Append-only form of `indexRecords`: the same v2 integrity checks, byte/row bounds and diagnostics, applied once per row instead
 * of once per read. Feeding the same rows in any batching yields exactly what `indexRecords` returns for them (differentially
 * tested). Rows and snapshots are deeply frozen: a snapshot is immutable shared state, never a scratch copy a caller may edit.
 */
export class IncrementalLedger {
  private readonly builder: ReturnType<typeof ledgerBuilder>;
  private capped = false;
  private cached?: LedgerIndex;
  constructor(readonly runId?: string) { this.builder = ledgerBuilder(runId); }
  get size(): number { return this.builder.result.records.length; }
  append(rows: AssessmentRecord[]): void {
    if (!rows.length) return;
    const { result, consume, issue, finish } = this.builder;
    this.cached = undefined;
    for (const row of rows) {
      if (this.capped) break; // a full scan stops reading at the byte bound
      const line = JSON.stringify(row); result.bytes += Buffer.byteLength(line) + 1;
      if (result.bytes > LEDGER_BYTES) { issue('Ledger exceeds 64 MiB; reconciliation incomplete'); this.capped = true; break; }
      const before = result.records.length;
      consume(line);
      if (result.records.length > before) freezeDeep(result.records[before]);
    }
    finish();
  }
  /** Immutable view; `snapshotSequence` is stamped per call without copying anything. */
  snapshot(snapshotSequence?: number): LedgerIndex {
    const { result } = this.builder;
    this.cached ??= { records: Object.freeze(result.records.slice()) as AssessmentRecord[], byId: new Map(result.byId), complete: result.complete,
      diagnostics: Object.freeze([...result.diagnostics]) as string[], issueCount: result.issueCount, foreign: result.foreign, bytes: result.bytes };
    return snapshotSequence === undefined ? this.cached : { ...this.cached, snapshotSequence };
  }
}

/** Complete bounded scan or the one bound owner-store projection; never a display tail. */
export async function readLedger(path: string, runId?: string): Promise<LedgerIndex> {
  const backend = recordBackend(path); if (backend) return backend.index(runId);
  const builder = ledgerBuilder(runId), { result, issue, consume } = builder;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Ledger must be a regular file');
    if (info.size > LEDGER_BYTES) { issue('Ledger exceeds 64 MiB; reconciliation incomplete'); return result; }
    let pending = '';
    const stream = file.createReadStream({ encoding: 'utf8', autoClose: false, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      result.bytes += Buffer.byteLength(chunk);
      if (result.bytes > LEDGER_BYTES) { issue('Ledger grew beyond byte bound'); break; }
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (Buffer.byteLength(pending) > 16 * 1024) { issue('Oversized unterminated ledger row'); break; }
    }
    if (pending.trim()) issue('Uncommitted or damaged ledger tail');
    return builder.finish();
  } finally { await file.close(); }
}

function legacyWorkPage(index:LedgerIndex,key:'workFingerprint'|'workOverlapKey',value:string,limit:number):WorkHistoryPage{
  const latest=new Map<string,string>();for(const row of index.records){const task=row.kind==='task'?row.data?.task as Record<string,unknown>|undefined:undefined;if(task&&typeof task.id==='string')latest.set(task.id,row.id!);}
  const all:WorkHistoryRow[]=[];for(const [sequence,row] of index.records.entries()){
    const task=row.kind==='task'?row.data?.task as Record<string,unknown>|undefined:undefined;if(!task||task[key]!==value||typeof task.id!=='string'||typeof task.workFingerprint!=='string'||typeof task.targetRevision!=='string')continue;
    const status=String(task.status),result:WorkHistoryRow['result']=status==='closed'&&typeof task.reviewReason==='string'&&Array.isArray(task.evidenceIds)&&task.evidenceIds.length?'reusable':['blocked','reported','cancelled','expired'].includes(status)?'partial':'none';
    all.push({sequence:sequence+1,recordId:row.id!,taskId:task.id,taskRevision:Number(task.revision),fingerprint:task.workFingerprint,targetRevision:task.targetRevision,
      ...(typeof task.workOverlapKey==='string'?{overlapKey:task.workOverlapKey}:{}),status,current:latest.get(task.id)===row.id,result});
  }
  all.sort((a,b)=>b.sequence-a.sequence);const active=all.filter(row=>row.current&&!['closed','blocked','cancelled','expired'].includes(row.status)).length,reusable=all.filter(row=>row.result==='reusable').length,partial=all.filter(row=>row.result==='partial').length;
  return {rows:all.slice(0,limit),total:all.length,active,reusable,partial,omitted:Math.max(0,all.length-limit)};
}
/** Indexed in canonical schema 6; legacy JSONL uses a complete bounded scan, never a display tail. */
export async function readWorkHistory(path:string,fingerprint:string,limit=20):Promise<WorkHistoryPage>{
  if(!/^[a-f0-9]{64}$/.test(fingerprint)||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid work-history query');
  const backend=recordBackend(path);if(backend?.workHistory)return backend.workHistory(fingerprint,limit);return legacyWorkPage(await readLedger(path),'workFingerprint',fingerprint,limit);
}
export async function readWorkOverlap(path:string,overlapKey:string,limit=20):Promise<WorkHistoryPage>{
  if(!/^[a-f0-9]{64}$/.test(overlapKey)||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid work-overlap query');
  const backend=recordBackend(path);if(backend?.workOverlap)return backend.workOverlap(overlapKey,limit);return legacyWorkPage(await readLedger(path),'workOverlapKey',overlapKey,limit);
}

/** Cheap normalized identity for a recon surface-inventory entry — a duplicate hint, not the exact `work` fingerprint of src/work.ts. */
export function surfaceKey(component: string, entryPoint: string): string {
  const norm = (value: string) => value.normalize('NFC').trim().toLowerCase();
  return `${norm(component)}::${norm(entryPoint)}`;
}

/** Appends one surface-inventory record and reports whether its normalized key already exists in this run.
 *  A non-blocking hint: it never refuses the write and never reserves the key, unlike task/work admission. */
export async function recordSurface(path: string, runId: string, attribution: Pick<AssessmentRecord, 'by' | 'workerId' | 'role' | 'depth'>, input: { component: string; entryPoint: string; text?: string; refs?: string[] }): Promise<RecordAck & { duplicate: boolean; priorRecordId?: string }> {
  if (!input.component.trim() || !input.entryPoint.trim()) throw new Error('Surface component and entryPoint are required');
  const key = surfaceKey(input.component, input.entryPoint);
  const index = await readLedger(path, runId);
  const prior = index.records.find(r => r.kind === 'surface' && (r.data as { key?: unknown } | undefined)?.key === key);
  const ack = await appendRecord(path, {
    runId, at: new Date().toISOString(), kind: 'surface', text: input.text?.trim() || `${input.component} · ${input.entryPoint}`,
    data: { key, component: input.component, entryPoint: input.entryPoint },
    ...(input.refs?.length ? { refs: input.refs.slice(0, 10) } : {}),
    ...attribution,
  });
  return { ...ack, duplicate: Boolean(prior), ...(prior?.id ? { priorRecordId: prior.id } : {}) };
}

/** Legacy bounded display API. Integrity-sensitive callers use readLedger directly. */
export async function readRecords(path: string, limit = RECORD_READ_LIMIT, strict = false): Promise<AssessmentRecord[]> {
  try { return (await readLedger(path)).records.slice(-Math.max(1, limit)); }
  catch (error) { if (strict) throw error; return []; }
}

export interface LedgerPage { records: AssessmentRecord[]; total: number; cursor: number; nextCursor?: number; complete: boolean; truncated: boolean; diagnostics: string[] }
export function ledgerPage(index: LedgerIndex, options: { cursor?: number; limit?: number; id?: string } = {}): LedgerPage {
  const cursor = options.cursor ?? Math.max(0, index.records.length - (options.limit ?? 50));
  const limit = options.limit ?? 50;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > index.records.length || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid ledger cursor/limit');
  const candidates = options.id ? [index.byId.get(options.id)].filter((r): r is AssessmentRecord => Boolean(r)) : index.records.slice(cursor, cursor + limit);
  const records: AssessmentRecord[] = []; let bytes = 0;
  for (const row of candidates) { const size = Buffer.byteLength(JSON.stringify(row)); if (bytes + size > 48 * 1024) break; records.push(row); bytes += size; }
  const next = cursor + records.length;
  return { records, total: index.records.length, cursor, ...(!options.id && next < index.records.length ? { nextCursor: next } : {}), complete: index.complete,
    truncated: records.length < candidates.length || (!options.id && (cursor > 0 || next < index.records.length)), diagnostics: index.diagnostics };
}

export interface WorkerSummary {
  workerId: string; role?: string; depth?: number; notes: number; coverage: number; open: number;
  reported: boolean; last?: AssessmentRecord;
}
export interface RecordsSummary {
  total: number;
  coverage: AssessmentRecord[];
  open: AssessmentRecord[];
  workers: WorkerSummary[];
  lifecycle: AssessmentRecord[];
  coverageTotal: number; openTotal: number; lifecycleTotal: number; omitted: number;
}

/** Ids that a later row replaced (`supersedes`) or resolved (`resolves`). */
export function retiredIds(records: readonly AssessmentRecord[]): Set<string> {
  const retired = new Set<string>();
  for (const record of records) { if (record.supersedes) retired.add(record.supersedes); for (const id of record.resolves ?? []) retired.add(id); }
  return retired;
}
/** An unresolved gap: an `open` item, or a candidate left as an open proof gap or blocked, that no later row replaced or resolved. */
export function isOpenGap(record: AssessmentRecord, retired: ReadonlySet<string>): boolean {
  if (record.id !== undefined && retired.has(record.id)) return false;
  return record.kind === 'open' || (record.kind === 'candidate' && (record.data?.closure === 'open_proof_gap' || record.data?.execution === 'blocked'));
}

/**
 * Latest revision of every owner-authored entity stored as a note under `data[field]` (cases, coverage plans and cells, plans). A revision counts only
 * when it is the first (revision 1) or follows the one before it (revision + 1, `supersedes` = that record); `parse` rejects anything malformed.
 * Anything else is ignored, never promoted, so a forged or out-of-order note cannot become the head.
 */
export function ownerNoteFrontier<E extends { id: string; runId: string; revision: number; recordId: string }>(index: LedgerIndex, field: string, parse: (value: unknown, recordId: string) => E): E[] {
  const latest = new Map<string, E>();
  for (const row of index.records) {
    const value = row.kind === 'note' && row.by === 'owner' && !row.workerId ? row.data?.[field] : undefined;
    if (!row.id || !value) continue;
    try {
      const entry = parse(value, row.id);
      if (entry.runId !== row.runId) continue;
      const previous = latest.get(entry.id);
      if (previous ? entry.revision !== previous.revision + 1 || row.supersedes !== previous.recordId : entry.revision !== 1) continue;
      latest.set(entry.id, entry);
    } catch { /* Untrusted or legacy notes are not promoted. */ }
  }
  return [...latest.values()];
}

/** Compact projection for p2o_workers: what the owner needs to decide the next move, not the raw log. */
export function summarizeRecords(records: AssessmentRecord[]): RecordsSummary {
  const workers = new Map<string, WorkerSummary>();
  const coverage: AssessmentRecord[] = [];
  const open: AssessmentRecord[] = [];
  const retired = retiredIds(records);
  const lifecycle: AssessmentRecord[] = [];
  for (const record of records) {
    if (record.kind === 'coverage') coverage.push(record);
    else if (record.kind === 'open') { if (isOpenGap(record, retired)) open.push(record); }
    else if (record.kind === 'candidate') {
      if (record.id === undefined || !retired.has(record.id)) { coverage.push(record); if (isOpenGap(record, retired)) open.push(record); }
    }
    else if (record.kind === 'lifecycle') lifecycle.push(record);
    if (!record.workerId) continue;
    const entry = workers.get(record.workerId) ?? { workerId: record.workerId, role: record.role, depth: record.depth, notes: 0, coverage: 0, open: 0, reported: false };
    if (record.kind === 'note' || record.kind === 'observation') entry.notes += 1;
    if (record.kind === 'coverage') entry.coverage += 1;
    if (record.kind === 'open') entry.open += 1;
    if (record.kind === 'report') entry.reported = true;
    entry.last = record;
    workers.set(record.workerId, entry);
  }
  return { total: records.length, coverage: coverage.slice(-40), open: open.slice(-40), workers: [...workers.values()], lifecycle: lifecycle.slice(-20),
    coverageTotal: coverage.length, openTotal: open.length, lifecycleTotal: lifecycle.length,
    omitted: Math.max(0, coverage.length - 40) + Math.max(0, open.length - 40) + Math.max(0, lifecycle.length - 20) };
}

/** Blocking owner-side wait used instead of model polling (Strix's `wait_for_agents`). */
export async function waitForRecordChange(path: string, options: { since: number; timeoutMs: number; signal?: AbortSignal; pollMs?: number }): Promise<boolean> {
  const deadline = Date.now() + Math.max(1, options.timeoutMs);
  const poll = Math.max(100, options.pollMs ?? 400);
  for (;;) {
    if (options.signal?.aborted) throw new Error('Cancelled');
    const size = await recordsSize(path);
    if (size !== options.since) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, poll));
  }
}

/** Opaque change token: canonical event sequence or legacy file byte count; not a disk quota. */
export async function recordsSize(path: string): Promise<number> { const backend = recordBackend(path); return backend ? backend.changeToken() : stat(path).then(value => value.size, () => 0); }
