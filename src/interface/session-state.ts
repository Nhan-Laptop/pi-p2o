/**
 * Session-scoped run/plan registry for `/p2o`.
 *
 * State lives in memory and, when the host supports it, in `p2o_run` / `p2o_plan` custom session entries that
 * never enter the model context. Selection is explicit or unambiguous: the last run recorded in this session,
 * or the entry port's `currentRun()` when it reports exactly one. A plan is only resolvable when this session
 * recorded it or the entry port exposes `readPlan`.
 */
import type { EntryPlan, EntryPreparation } from './target-entry.js';

export interface SessionPlanRecord {
  planId: string;
  runId: string;
  digest: string;
  scopeDigest: string;
  createdAt: string;
  preparation: EntryPreparation;
  plan: EntryPlan;
}

export interface SessionRunRecord { runId: string; at: string; state?: string }

export interface SessionEntryLike { type?: unknown; customType?: unknown; data?: unknown }

const MAX_RECORDS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlanRecord(value: unknown): value is SessionPlanRecord {
  if (!isRecord(value)) return false;
  for (const key of ['planId', 'runId', 'digest', 'scopeDigest', 'createdAt']) {
    if (typeof value[key] !== 'string' || !value[key]) return false;
  }
  return isRecord(value.plan) && isRecord(value.preparation);
}

function isRunRecord(value: unknown): value is SessionRunRecord {
  return isRecord(value) && typeof value.runId === 'string' && Boolean(value.runId) && typeof value.at === 'string';
}

function prune<K, V>(map: Map<K, V>): void {
  while (map.size > MAX_RECORDS) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

export class SessionRunRegistry {
  private readonly plans = new Map<string, SessionPlanRecord>();
  private readonly runs = new Map<string, SessionRunRecord>();
  private current?: string;

  get currentRunId(): string | undefined { return this.current; }

  rememberRun(runId: string, state?: string): SessionRunRecord {
    const record: SessionRunRecord = { runId, at: new Date().toISOString(), ...(state ? { state } : {}) };
    this.runs.delete(runId);
    this.runs.set(runId, record);
    prune(this.runs);
    this.current = runId;
    return record;
  }

  rememberPlan(record: SessionPlanRecord): void {
    this.plans.delete(record.planId);
    this.plans.set(record.planId, record);
    prune(this.plans);
  }

  /** Look up a plan recorded in this session. Never scans the filesystem. */
  plan(planId: string): SessionPlanRecord | undefined { return this.plans.get(planId); }

  /** Rebuild in-memory state from branch entries; abandoned branches are not consulted by the caller. */
  hydrate(entries: readonly SessionEntryLike[]): void {
    this.plans.clear();
    this.runs.clear();
    this.current = undefined;
    for (const entry of entries) {
      if (!isRecord(entry) || entry.type !== 'custom') continue;
      if (entry.customType === 'p2o_run' && isRunRecord(entry.data)) {
        this.runs.set(entry.data.runId, entry.data);
        this.current = entry.data.runId;
      }
      if (entry.customType === 'p2o_plan' && isPlanRecord(entry.data)) {
        this.plans.set(entry.data.planId, entry.data);
      }
    }
    prune(this.runs);
    prune(this.plans);
  }
}
