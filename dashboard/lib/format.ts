/**
 * planning_update.md P2: display formatting. Every function here is pure and locale-free — the dashboard must render the
 * same strings wherever it is opened, so committed ISO timestamps are shown as recorded (no `Date` formatting, no time zone).
 */

export const severityLabel = (value: string | null): string => value ?? 'not rated';

/** Worst-first severity order for a ledger row; `not rated` is a state, not a severity, so it sorts last. */
export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'informational', 'not rated'] as const;

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** Committed times are ISO-8601 UTC; the view shows that instant without reformatting it into a local zone. */
export const formatTime = (value: string | null): string => {
  if (value === null) return 'not recorded';
  return value.replace(/\.\d+Z$/, 'Z').replace('T', ' ');
};

export const sourceLabel = (source: string): string =>
  source === 'both' ? 'store + report' : source === 'report' ? 'report bundle' : 'store';

export const retentionLabel = (retention: string): string =>
  retention === 'durable-local' ? 'durable local' : retention === 'unknown' ? 'retention unknown' : retention;

export const clamp = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

/** Short id for a card; the full id stays available in the detail panel and its title attribute. */
export const shortId = (value: string, max = 14): string => clamp(value, max);

/** Bounded wrapping for SVG text (which cannot wrap): words only, at most `maxLines`, ellipsis only when words are cut. */
export function wrapText(value: string, width: number, maxLines: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    let line = '';
    while (index < words.length) {
      const candidate = line ? `${line} ${words[index]}` : words[index]!;
      if (candidate.length > width && line) break;
      line = candidate;
      index += 1;
      if (line.length >= width) break;
    }
    lines.push(line.length > width ? clamp(line, width) : line);
  }
  if (index < words.length && lines.length) {
    const last = lines.length - 1;
    const line = lines[last]!;
    lines[last] = line.length >= width ? `${line.slice(0, Math.max(0, width - 1))}…` : `${line}…`;
  }
  return lines;
}

/** A query value from `window.location.search`, without touching `URLSearchParams` ordering. Pure so it is testable. */
export function queryValue(search: string, name: string): string | null {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (!query) return null;
  for (const part of query.split('&')) {
    if (!part) continue;
    const at = part.indexOf('=');
    const key = at < 0 ? part : part.slice(0, at);
    if (decodeURIComponent(key.replace(/\+/g, ' ')) !== name) continue;
    const raw = at < 0 ? '' : part.slice(at + 1);
    const value = decodeURIComponent(raw.replace(/\+/g, ' '));
    return value.length ? value : null;
  }
  return null;
}

/** The run link used by plain anchors: full-page navigation keeps the static export free of router payload files. */
export const graphHref = (runId: string): string => `/graph/?run=${encodeURIComponent(runId)}`;

export const RUN_OPEN_LABEL = 'open';
export const RUN_CLOSED_LABEL = 'finished';
