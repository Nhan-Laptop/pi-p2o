import { appendFile, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Append-only shared state. This is the coordination medium between the owner and its workers,
 * mirroring Strix's notes/coverage ledger: the next agent reads state, not someone's reasoning.
 * Nothing in this file is authority — scope comes from the human, evidence is verified elsewhere.
 */
export const RECORD_KINDS = ['note', 'coverage', 'observation', 'open', 'report', 'lifecycle', 'evidence', 'candidate', 'report_part', 'task'] as const;
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

export const RECORD_TEXT_LIMIT = 2000;
export const RECORD_REF_LIMIT = 10;
export const RECORD_READ_LIMIT = 500;

export function isRecordKind(value: unknown): value is RecordKind { return typeof value === 'string' && (RECORD_KINDS as readonly string[]).includes(value); }
export function isOutcome(value: unknown): value is CoverageOutcome { return typeof value === 'string' && (COVERAGE_OUTCOMES as readonly string[]).includes(value); }

/** Single small O_APPEND write so concurrent writers cannot interleave inside one line. */
export async function appendRecord(path: string, record: AssessmentRecord): Promise<void> {
  const line = `${JSON.stringify({ version: 2, id: randomUUID(), ...record })}\n`;
  if (Buffer.byteLength(line) > 16 * 1024) throw new Error('Record is too large');
  await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
}

export const LEDGER_BYTES = 64 * 1024 * 1024;
export const LEDGER_RECORDS = 100000;
export interface LedgerIndex {
  records: AssessmentRecord[]; byId: Map<string, AssessmentRecord>; complete: boolean;
  diagnostics: string[]; issueCount: number; foreign: number; bytes: number;
}

/** Complete bounded scan of the run-owned regular file. A display tail is never authority. */
export async function readLedger(path: string, runId?: string): Promise<LedgerIndex> {
  const result: LedgerIndex = { records: [], byId: new Map(), complete: true, diagnostics: [], issueCount: 0, foreign: 0, bytes: 0 };
  const issue = (text: string) => { result.complete = false; result.issueCount++; if (result.diagnostics.length < 40) result.diagnostics.push(text); };
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Ledger must be a regular file');
    if (info.size > LEDGER_BYTES) { issue('Ledger exceeds 64 MiB; reconciliation incomplete'); return result; }
    let pending = '', lineNumber = 0;
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
    const stream = file.createReadStream({ encoding: 'utf8', autoClose: false, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      result.bytes += Buffer.byteLength(chunk);
      if (result.bytes > LEDGER_BYTES) { issue('Ledger grew beyond byte bound'); break; }
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (Buffer.byteLength(pending) > 16 * 1024) { issue('Oversized unterminated ledger row'); break; }
    }
    if (pending.trim()) { issue('Uncommitted or damaged ledger tail'); }
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
  } finally { await file.close(); }
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

/** Compact projection for p2o_workers: what the owner needs to decide the next move, not the raw log. */
export function summarizeRecords(records: AssessmentRecord[]): RecordsSummary {
  const workers = new Map<string, WorkerSummary>();
  const coverage: AssessmentRecord[] = [];
  const open: AssessmentRecord[] = [];
  const superseded = new Set(records.flatMap(r => [r.supersedes, ...(r.resolves ?? [])]).filter(Boolean));
  const lifecycle: AssessmentRecord[] = [];
  for (const record of records) {
    if (record.kind === 'coverage') coverage.push(record);
    else if (record.kind === 'open' && !superseded.has(record.id)) open.push(record);
    else if (record.kind === 'candidate' && !superseded.has(record.id)) {
      coverage.push(record);
      if (record.data?.closure === 'open_proof_gap' || record.data?.execution === 'blocked') open.push(record);
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
    const size = await stat(path).then(value => value.size, () => 0);
    if (size !== options.since) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, poll));
  }
}

export async function recordsSize(path: string): Promise<number> { return stat(path).then(value => value.size, () => 0); }

/** Mode check helper for owner-private control files. */
export async function privateFile(path: string, expected: number): Promise<boolean> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return false;
  try { const info = await handle.stat(); return (info.mode & 0o777) === expected; }
  finally { await handle.close(); }
}
