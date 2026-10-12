import { safeText } from './evidence.js';
import { cleanText } from './process.js';
import { CONTROL } from './validate.js';
import type { AssessmentRecord, LedgerIndex } from './records.js';

/**
 * Bounded, deterministic text search over committed ledger records. A plain case-insensitive substring over a fixed set of already-redacted
 * fields: no query language, no regular expression, no SQL, no index to rebuild and no schema change. Hits are navigation pointers (record ID,
 * kind, author, short snippet) to be drilled into with the exact-ID readers; a hit is never evidence, proof or authority, and artifact bytes
 * are not searched. Totals are exact for the committed snapshot the search ran on.
 */
export const SEARCH_QUERY_MIN = 2, SEARCH_QUERY_MAX = 80, SEARCH_LIMIT_MAX = 20, SEARCH_LIMIT_DEFAULT = 10, SNIPPET_CHARS = 100;
const SKIPPED_KINDS = new Set(['report_part']);
const DATA_KEYS = ['title', 'candidate', 'question', 'focus'] as const;

export interface SearchHit { id: string; kind: string; by: string; position: number; taskId?: string; surface?: string; snippet: string }
export interface SearchPage { query: string; asOfRecords: number; snapshotSequence?: number; total: number; shown: number; omittedAfter: number; cursor: number; nextCursor?: number; complete: boolean; hits: SearchHit[]; warning: string }

export function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string') throw Error('Search query must be text');
  const query = value.normalize('NFC').trim();
  if (query.length < SEARCH_QUERY_MIN || query.length > SEARCH_QUERY_MAX) throw Error(`Search query must be ${SEARCH_QUERY_MIN}..${SEARCH_QUERY_MAX} characters`);
  if (CONTROL.test(query)) throw Error('Search query must not contain control or bidirectional characters');
  return query;
}

function fields(record: AssessmentRecord): string[] {
  const values = [record.text, record.surface, record.risk, record.outcome].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (record.data) for (const key of DATA_KEYS) { const value = record.data[key]; if (typeof value === 'string') values.push(value); }
  return values;
}
const snippetOf = (value: string, needle: string): string => {
  const flat = safeText(value).replace(/\s+/g, ' ').trim(), at = flat.toLowerCase().indexOf(needle);
  const start = Math.max(0, (at < 0 ? 0 : at) - 30);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + SNIPPET_CHARS)}${flat.length > start + SNIPPET_CHARS ? '…' : ''}`;
};

export function searchRecords(index: LedgerIndex, queryInput: unknown, options: { cursor?: number; limit?: number } = {}): SearchPage {
  const query = normalizeQuery(queryInput), needle = query.toLowerCase();
  const cursor = options.cursor ?? 0, limit = options.limit ?? SEARCH_LIMIT_DEFAULT;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error('Search cursor must be a non-negative safe integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) throw Error(`Search limit must be 1..${SEARCH_LIMIT_MAX}`);
  const records = index.records, hits: SearchHit[] = []; let total = 0, before = 0, nextCursor: number | undefined;
  for (let position = 0; position < records.length; position++) {
    const record = records[position];
    if (SKIPPED_KINDS.has(record.kind)) continue;
    const matched = fields(record).find(value => value.toLowerCase().includes(needle));
    if (matched === undefined) continue;
    total += 1;
    if (position < cursor) { before += 1; continue; }
    if (hits.length < limit) hits.push({ id: record.id ?? `legacy-position-${position}`, kind: record.kind, by: record.by, position, ...(typeof record.data?.taskId === 'string' ? { taskId: record.data.taskId } : {}), ...(record.surface ? { surface: cleanText(record.surface).slice(0, 80) } : {}), snippet: snippetOf(matched, needle) });
    else nextCursor ??= position;
  }
  return { query, asOfRecords: records.length, ...(index.snapshotSequence !== undefined ? { snapshotSequence: index.snapshotSequence } : {}), total, shown: hits.length, omittedAfter: Math.max(0, total - before - hits.length), cursor, ...(nextCursor !== undefined ? { nextCursor } : {}),
    complete: index.complete, hits, warning: 'Navigation pointers into committed records, not evidence or proof. Snippets are redacted and bounded; artifact bytes are not searched. Drill down by exact ID.' };
}

export function searchLines(page: SearchPage): string[] {
  return [`Search "${cleanText(page.query)}" over ${page.asOfRecords} committed records${page.snapshotSequence !== undefined ? ` @${page.snapshotSequence}` : ''}: ${page.total} match(es), showing ${page.shown} from position ${page.cursor}${page.omittedAfter ? `, ${page.omittedAfter} more after this page` : ''}${page.complete ? '' : '; INCOMPLETE ledger — no completeness claim'}`,
    ...(page.nextCursor !== undefined ? [`Next: /p2o search ${cleanText(page.query)} ${page.nextCursor}`] : []),
    ...page.hits.map(hit => `${hit.position} ${hit.id} ${hit.kind} by=${hit.by}${hit.taskId ? ` task=${hit.taskId}` : ''}${hit.surface ? ` surface=${hit.surface}` : ''}: ${hit.snippet}`),
    'Plain case-insensitive substring over record text, surface, risk, outcome and titles. A hit is a pointer, not evidence; use p2o_ledger (or /p2o log, /p2o task) by exact ID.'];
}
