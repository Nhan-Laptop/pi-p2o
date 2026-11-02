/**
 * W-Y (A): HAR (HTTP Archive) → route assets. A browser-driven flow writes a HAR inside the sandbox; the host may also import
 * one as an ordinary retained artifact. The archive records requests the browser actually made, so an entry is an observed
 * route with a method and a host — never a claim, a finding or a vulnerability. Identity is the URL path (query and fragment
 * dropped by `clean`, matching how routes are recorded); the raw URL never becomes the key.
 *
 * Like every extractor this is a pure function over bytes the host already retained: no network, no shell, no eval. It keeps
 * the same shape and caps as the other parsers (`EXTRACT_MAX_*`) and returns `undefined` when the artifact is not a HAR.
 */
import { attributes, clean, isRecord, parseJson } from './sanitize.js';
import { type ExtractAsset, type ExtractFact, type ExtractResult, type Extractor, EXTRACT_MAX_ASSETS, EXTRACT_MAX_FACTS, EXTRACT_MAX_RECORDS, EXTRACT_MAX_ROW_BYTES } from './types.js';

const rowBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Route identity is the path a browser requested; a URL that cannot be parsed keeps its cleaned raw form (never dropped). */
const pathOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return clean(parsed.pathname || '/', 500);
  } catch { return clean(url, 500); }
};
const statusOf = (value: unknown): string | undefined => typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : undefined;
const contentTypeOf = (response: Record<string, unknown> | undefined): string | undefined => {
  const content = isRecord(response?.content) ? response.content : undefined;
  return clean(content?.mimeType, 120) ?? clean(content?.mime_type, 120);
};

export const har: Extractor = (source): ExtractResult | undefined => {
  const text = source.text.trimStart();
  if (!text.startsWith('{')) return undefined;
  try {
    const parsed = parseJson(text);
    if (!isRecord(parsed) || !isRecord(parsed.log) || !Array.isArray(parsed.log.entries)) return undefined;
    const routes: Array<{ path: string; method: string; host?: string; status?: string; contentType?: string }> = [];
    let walkOmitted = 0, skipped = 0;
    for (const entry of parsed.log.entries) {
      if (routes.length >= EXTRACT_MAX_RECORDS) { walkOmitted += 1; continue; }
      if (!isRecord(entry) || !isRecord(entry.request)) { skipped += 1; continue; }
      const url = clean(entry.request.url, 2048), path = url === undefined ? undefined : pathOf(url);
      if (path === undefined) { skipped += 1; continue; }
      const response = isRecord(entry.response) ? entry.response : undefined;
      let host: string | undefined;
      try { host = clean(new URL(url!).host, 300); } catch { host = undefined; }
      const status = statusOf(response?.status), contentType = contentTypeOf(response);
      routes.push({ path, method: (clean(entry.request.method, 16) ?? 'GET').toUpperCase(), ...(host ? { host } : {}), ...(status ? { status } : {}), ...(contentType ? { contentType } : {}) });
    }
    if (!routes.length) return undefined;
    const assets: ExtractAsset[] = [], facts: ExtractFact[] = [], warnings: string[] = [], byPath = new Map<string, { index: number; requests: number }>();
    let omittedAssets = skipped;
    for (const route of routes) {
      const known = byPath.get(route.path);
      if (known) { known.requests += 1; continue; }
      if (assets.length >= EXTRACT_MAX_ASSETS) { omittedAssets += 1; continue; }
      const row: ExtractAsset = { kind: 'route', key: route.path, label: clean(`${route.method} ${route.path}`, 200) ?? route.path,
        attributes: attributes({ method: route.method, host: route.host, requestCount: '1' }) ?? undefined, anchors: [{ kind: 'path', value: route.path }] };
      if (rowBytes(row) > EXTRACT_MAX_ROW_BYTES) { omittedAssets += 1; continue; }
      byPath.set(route.path, { index: assets.length, requests: 1 });
      assets.push(row);
      if (facts.length < EXTRACT_MAX_FACTS) facts.push({ asset: assets.length - 1, kind: 'observed', confidence: 'high',
        statement: `har: browser recorded HTTP ${route.status ?? 'unknown'}${route.contentType ? ` (${route.contentType})` : ''} for ${route.method} ${route.path}` });
    }
    // The request count belongs to the retained route, not to whichever request happened to arrive first.
    for (const counted of byPath.values()) if (counted.requests > 1) {
      const asset = assets[counted.index], updated = attributes({ ...(asset.attributes ?? {}), requestCount: String(counted.requests) });
      if (updated) assets[counted.index] = { ...asset, attributes: updated };
    }
    if (!assets.length) return undefined;
    if (skipped) warnings.push(`har: ${skipped} entr${skipped === 1 ? 'y' : 'ies'} had no usable http(s) request URL and were skipped`);
    if (omittedAssets) warnings.push(`har: ${omittedAssets} route row(s) were omitted at the ${EXTRACT_MAX_ASSETS}-asset / ${EXTRACT_MAX_ROW_BYTES}-byte row bound`);
    if (walkOmitted) warnings.push(`har: ${walkOmitted} entr${walkOmitted === 1 ? 'y is' : 'ies are'} past the ${EXTRACT_MAX_RECORDS}-record walk limit and were not parsed`);
    return { extractor: 'har', assets, facts, hypotheses: [], components: [], warnings, omitted: { assets: omittedAssets + walkOmitted, facts: Math.max(0, routes.length - facts.length), hypotheses: 0, components: 0 } } satisfies ExtractResult;
  } catch { return undefined; }
};
