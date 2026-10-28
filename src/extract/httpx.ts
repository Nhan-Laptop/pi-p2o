/**
 * R2.2: httpx JSON/JSONL → endpoint assets.
 *
 * httpx is the recon camera: one JSON object per URL actually fetched, with the status, title, technology and TLS facts the
 * inventory wants. Identity is the normalized URL (scheme/host lower-cased, default port and query dropped); the raw URL rides
 * in the anchor, and the response facts that describe the endpoint are attributes, never an assertion of security.
 */
import { attributes, clean, hostKey, isRecord, lines, normalizeUrl, parseJson } from './sanitize.js';
import { type ExtractAsset, type ExtractFact, type ExtractResult, type Extractor, EXTRACT_MAX_RECORDS } from './types.js';

const asText = (value: unknown, max: number): string | undefined => {
  if (typeof value === 'string') return clean(value, max);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

const techList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const name = typeof item === 'string' ? clean(item, 80) : item && typeof item === 'object' ? clean((item as { name?: unknown }).name, 80) : undefined;
    return name ? [name] : [];
  }).slice(0, 12);
};

function row(source: Record<string, unknown>): ExtractAsset | undefined {
  const url = normalizeUrl(source.url ?? source.input ?? source.final_url);
  if (!url) return undefined;
  const status = asText(source.status_code ?? source['status-code'], 16);
  const title = asText(source.title, 200);
  const method = asText(source.method, 16);
  const tech = techList(source.tech);
  const tls = source.tls && typeof source.tls === 'object' ? source.tls as Record<string, unknown> : undefined;
  const headers = source.header && typeof source.header === 'object' ? source.header as Record<string, unknown> : undefined;
  const server = asText(source.webserver, 120) ?? asText(headers?.server, 120);
  const attributesOut = attributes({
    status, title, method, server,
    host: asText(source.host, 200), path: asText(source.path, 300),
    content_type: asText(source.content_type, 120), content_length: asText(source.content_length, 20),
    tech: tech.length ? tech.join(', ') : undefined,
    tls_issuer: asText(tls?.issuer_cn, 200), tls_version: asText(tls?.tls_version, 40),
    cdn: asText(source.cdn_name, 80), cname: Array.isArray(source.cname) ? clean(source.cname.join(', '), 300) : undefined,
    websocket: source.websocket === true ? 'yes' : undefined, source: 'httpx',
  });
  return { kind: 'endpoint', key: url, ...(title ? { label: title } : { label: hostKey(url) }), ...(attributesOut ? { attributes: attributesOut } : {}),
    anchors: [{ kind: 'url', value: url }] };
}

export const httpx: Extractor = (source) => {
  const text = source.text;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  const rows: unknown[] = [];
  let omitted = 0;
  if (trimmed.startsWith('[')) {
    const parsed = parseJson(trimmed);
    if (Array.isArray(parsed)) rows.push(...parsed.slice(0, EXTRACT_MAX_RECORDS));
    else return undefined;
  } else {
    const split = lines(text, EXTRACT_MAX_RECORDS);
    omitted = split.omitted;
    for (const line of split.walk) { const parsed = parseJson(line); if (parsed !== undefined) rows.push(parsed); }
  }
  const candidate = rows.filter((value): value is Record<string, unknown> => isRecord(value)
    && ('status_code' in value || 'status-code' in value) && ('url' in value || 'input' in value));
  if (!candidate.length) return undefined;
  const assets: ExtractAsset[] = [], facts: ExtractFact[] = [], warnings: string[] = [];
  const seen = new Map<string, number>();
  let duplicates = 0, skipped = 0;
  for (const source of candidate) {
    const asset = row(source);
    if (!asset) { skipped += 1; continue; }
    if (seen.has(asset.key)) { duplicates += 1; continue; }
    seen.set(asset.key, assets.length);
    const index = assets.length;
    assets.push(asset);
    const status = asText(source.status_code ?? source['status-code'], 16), title = asText(source.title, 200);
    facts.push({ asset: index, kind: 'observed', confidence: 'high', statement: `httpx: HTTP ${status ?? 'unknown'}${title ? ` — ${title}` : ''} (fetched live by the host, not inferred)` });
  }
  if (duplicates) warnings.push(`httpx: ${duplicates} duplicate URL row(s) folded into one endpoint identity`);
  if (skipped) warnings.push(`httpx: ${skipped} row(s) had no usable http(s) URL and were skipped`);
  if (omitted) warnings.push(`httpx: ${omitted} line(s) past the ${EXTRACT_MAX_RECORDS}-record walk limit are not parsed`);
  if (!assets.length) return undefined;
  return { extractor: 'httpx', assets, facts, hypotheses: [], components: [], warnings, omitted: { assets: duplicates + skipped, facts: 0, hypotheses: 0, components: 0 } } satisfies ExtractResult;
};
