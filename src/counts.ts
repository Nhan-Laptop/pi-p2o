/**
 * One count pair for every bounded page.
 *
 * Why this file exists (planning_update.md P11, cause-level fix): the pair `total`/`shown` was hand-written in six places —
 * `listPage`, `ledgerPage`, `searchRecords`, `graphPage`, `graphExport`, the knowledge-head page and two inline payloads — under
 * four different names (`omitted`, `omittedAfter`, `omittedCells`, `matched`). Nothing declared the shape, so a new page could omit
 * a field silently, and a reader could not compare two pages without knowing which dialect each spoke. The three projections that
 * were missing the pair were a symptom of that duplication, not three separate oversights.
 *
 * The contract is now one interface and one constructor: any bounded list states the denominator (`total`), what the page contains
 * (`shown`), and the remainder (`omitted = total - shown`). `assertCounted` is a compile-time check for hand-built pages: passing a
 * literal without the triple fails `npm run typecheck`, so the next page cannot drift.
 */
export interface Counted {
  /** Items that exist for this query, independent of the page. */
  total:number;
  /** Items in this response after the cursor, the limit and the byte cap. */
  shown:number;
  /** `total - shown`: what this response does not contain. Never implies the work is unfinished. */
  omitted:number;
  cursor:number;
  /** Present only when a later page exists and its cursor is position-based. */
  nextCursor?:number;
}

export interface CountOptions<T, P = unknown> {
  cursor?:number;
  limit?:number;
  /** Field carrying the page items; defaults to `entries`. */
  key?:string;
  /** Serialized-byte ceiling for the page items before the last one is dropped; defaults to 23 KiB. */
  bytes?:number;
  project?:(item:T)=>P;
  /** Message for a cursor past the end; defaults to `Invalid cursor`. */
  beyond?:string;
  /** Noun used in cursor/limit errors; defaults to `page`. */
  label?:string;
}

/**
 * The single constructor for a bounded page. Validation, byte trimming and the next-cursor rule live here so every caller agrees:
 * the cursor is a position in `selected`, the limit is 1..100, and `nextCursor` appears only when items remain after this page.
 */
export function counted<T, P = T, K extends string = 'entries'>(selected: readonly T[], options: CountOptions<T, P> & { key?: K } = {}): Counted & Record<K, P[]> {
  const cursor = options.cursor ?? 0, limit = options.limit ?? 20, label = options.label ?? 'page', cap = options.bytes ?? 23 * 1024;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Error(`Invalid ${label} cursor/limit`);
  if (cursor > selected.length) throw Error(options.beyond ?? `Invalid ${label} cursor`);
  const items = selected.slice(cursor, cursor + limit).map(item => options.project ? options.project(item) : item);
  while (items.length && Buffer.byteLength(JSON.stringify(items)) > cap) items.pop();
  const end = cursor + items.length;
  return { total: selected.length, shown: items.length, omitted: selected.length - items.length, cursor,
    ...(end < selected.length && items.length ? { nextCursor: end } : {}), [options.key ?? 'entries']: items } as Counted & Record<K, P[]>;
}

/**
 * Compile-time guard for a page built by hand (a fixed tail, a per-kind map). It returns the value unchanged and exists only to make
 * `npm run typecheck` refuse a payload that claims to be bounded without saying how much it left out.
 */
export function assertCounted<T extends Counted>(value: T): T { return value; }

/** Shorthand for a page whose items are the same array it counts (a tail or a per-kind slice with an explicit total). */
export function countedTail<T>(items: readonly T[], tail: readonly T[]): Counted { return { total: items.length, shown: tail.length, omitted: Math.max(0, items.length - tail.length), cursor: Math.max(0, items.length - tail.length) }; }
