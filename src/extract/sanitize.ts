/**
 * Identity hygiene for extracted rows. The graph refuses secret-bearing identities (state/graph.ts) and one refusal fails the
 * whole batch, so the extractor emits identities it can defend: URLs lose their query, fragment and userinfo (the parts that
 * carry tokens), and any row that still looks credential-bearing is dropped with a warning instead of poisoning the ingest.
 */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/** Shapes that are credentials rather than identifiers. Deliberately narrower than the graph's check: these are the shapes a scanner output actually carries. */
const CREDENTIAL = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|[?&;](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token|auth)=)/i;

/** NFC text without control characters, at most `max` bytes and characters. Empty input yields `undefined`. */
export function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const stripped = value.replace(CONTROL, '').replace(/\s+/g, ' ').trim().normalize('NFC');
  if (!stripped) return undefined;
  if (stripped.length <= max && Buffer.byteLength(stripped) <= max) return stripped;
  let cut = stripped.slice(0, max);
  while (Buffer.byteLength(cut) > max) cut = cut.slice(0, Math.floor(cut.length * 0.9));
  return cut;
}

/** Keep an identity-shaped value; refuse the credential shapes the graph would reject mid-batch. */
export function cleanIdentity(value: unknown, max: number): string | undefined {
  const text = clean(value, max);
  if (!text || CREDENTIAL.test(text)) return undefined;
  return text;
}

/**
 * Normalize a URL for identity: lower-case scheme/host, no default port, no credentials, no query, no fragment, root path as
 * `/`. Raw values (including the query) belong in attributes or anchors, never in the identity bytes. Returns `undefined` for a
 * non-http(s) URL so file:// and javascript: captures are ignored instead of stored.
 */
export function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
  return cleanIdentity(url.href, 500);
}

/** A URL as a reader should see it: path bytes (including dot segments a scanner tested) kept, query and fragment dropped. */
export function displayUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/[?#].*$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  const text = clean(trimmed, 500);
  return text && !CREDENTIAL.test(text) ? text : undefined;
}

/** The host:port part of a URL, without scheme or path. */
export function hostKey(value: unknown): string | undefined {
  const normalized = normalizeUrl(value);
  if (!normalized) return undefined;
  try { const url = new URL(normalized); return cleanIdentity(url.host, 300); } catch { return undefined; }
}

/** A bounded attribute dictionary in the graph's shape: ≤16 entries, names ≤64, values ≤500 bytes. */
export function attributes(entries: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(entries)) {
    if (Object.keys(out).length >= 16) break;
    const key = clean(name, 64), kept = clean(value, 500);
    if (!key || !kept) continue;
    out[key] = CREDENTIAL.test(kept) ? '[REDACTED]' : kept;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Split a text capture into lines without materializing more than the parser will walk. */
export function lines(text: string, limit: number): { walk: string[]; omitted: number } {
  const walk: string[] = [];
  let start = 0, total = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    total += 1;
    if (walk.length < limit) {
      const line = text.slice(start, end).replace(/\r$/, '');
      if (line.trim()) walk.push(line);
    }
    start = end + 1;
  }
  return { walk, omitted: Math.max(0, total - walk.length) };
}

/** A plain JSON object, not an array and not null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON.parse that never throws; a malformed line is a skipped record, not a failed ingest. */
export function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}
