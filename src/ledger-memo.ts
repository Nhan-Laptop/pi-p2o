import type { AssessmentRecord, LedgerIndex } from './records.js';

interface Memo { length: number; values: Map<string, unknown> }
const memo = new WeakMap<AssessmentRecord[], Memo>();

/**
 * Derived lookups cached per record list. A canonical snapshot's `records` array is frozen and shared by every view of the same
 * snapshot, so keying on it (not on the per-call index wrapper) keeps the cache across reads until a new row creates a new snapshot.
 * The cached length is a guard: a list that grew in place can never serve a stale lookup. Pure derivation; the builder must not
 * mutate its input and callers must treat the result as read-only shared state.
 */
export function derive<T>(index: LedgerIndex, name: string, build: (records: AssessmentRecord[]) => T): T {
  const records = index.records;
  let entry = memo.get(records);
  if (!entry || entry.length !== records.length) { entry = { length: records.length, values: new Map() }; memo.set(records, entry); }
  if (!entry.values.has(name)) entry.values.set(name, build(records));
  return entry.values.get(name) as T;
}
