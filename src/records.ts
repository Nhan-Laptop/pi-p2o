import { appendFile, open, readFile, stat } from 'node:fs/promises';

/**
 * Append-only shared state. This is the coordination medium between the owner and its workers,
 * mirroring Strix's notes/coverage ledger: the next agent reads state, not someone's reasoning.
 * Nothing in this file is authority — scope comes from the human, evidence is verified elsewhere.
 */
export const RECORD_KINDS = ['note', 'coverage', 'observation', 'open', 'report', 'lifecycle'] as const;
export type RecordKind = typeof RECORD_KINDS[number];
export const COVERAGE_OUTCOMES = ['confirmed', 'ruled_out', 'open_proof_gap', 'clean', 'needs_follow_up'] as const;
export type CoverageOutcome = typeof COVERAGE_OUTCOMES[number];

export interface AssessmentRecord {
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
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > 16 * 1024) throw new Error('Record is too large');
  await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
}

export async function readRecords(path: string, limit = RECORD_READ_LIMIT): Promise<AssessmentRecord[]> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return []; }
  const records: AssessmentRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AssessmentRecord;
      if (parsed && typeof parsed === 'object' && isRecordKind(parsed.kind) && typeof parsed.text === 'string') records.push(parsed);
    } catch { /* a truncated tail line is not a reason to lose the rest */ }
  }
  return records.slice(-limit);
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
}

/** Compact projection for p2o_workers: what the owner needs to decide the next move, not the raw log. */
export function summarizeRecords(records: AssessmentRecord[]): RecordsSummary {
  const workers = new Map<string, WorkerSummary>();
  const coverage: AssessmentRecord[] = [];
  const open: AssessmentRecord[] = [];
  const lifecycle: AssessmentRecord[] = [];
  for (const record of records) {
    if (record.kind === 'coverage') coverage.push(record);
    else if (record.kind === 'open') open.push(record);
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
  return { total: records.length, coverage: coverage.slice(-40), open: open.slice(-40), workers: [...workers.values()], lifecycle: lifecycle.slice(-20) };
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
