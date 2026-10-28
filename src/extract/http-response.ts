/**
 * R2.2: one raw HTTP response (curl -i style, as the host retains `http-stdout`) → endpoint facts and route assets.
 *
 * What a response can honestly report: the status, its headers, the cookie **names** it sets, and the links/forms/API paths its
 * body references. Header absence is recorded as an observation about this response, never as a vulnerability; cookie values are
 * never read into a row (only names); link/form/script strings become route knowledge, not requests the host later replays.
 */
import { attributes, clean, cleanIdentity, normalizeUrl } from './sanitize.js';
import type { ExtractAsset, ExtractFact, ExtractResult, Extractor } from './types.js';
import { EXTRACT_MAX_FORMS, EXTRACT_MAX_LINKS } from './types.js';

const SECURITY_HEADERS = ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy'] as const;
const RECORDED_HEADERS = ['content-type', 'server', 'x-powered-by', 'location', 'access-control-allow-origin', 'cache-control'] as const;
const LINK = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const FORM = /<form\b[^>]*?>([\s\S]*?)<\/form>/gi;
const FORM_ACTION = /\baction\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const FORM_METHOD = /\bmethod\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const QUOTED_PATH = /["'`](\/[A-Za-z0-9_\-./{}$:%@~+]{1,220})["'`]/g;
const API_MARKER = /\/(?:api|rest|graphql|internal|v[0-9]+)(?:\/|$)/i;
const STATIC_FILE = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|eot)(?:$|\?)/i;

const headerValue = (value: string, max: number) => clean(value, max);

interface Head { status: number; headers: Array<[string, string]>; body: string }

function parseHead(text: string): Head | undefined {
  const start = text.search(/^HTTP\/\d/);
  if (start < 0) return undefined;
  const rest = text.slice(start);
  const separator = rest.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : rest.indexOf('\n\n') >= 0 ? '\n\n' : undefined;
  const head = separator ? rest.slice(0, rest.indexOf(separator)) : rest;
  const body = separator ? rest.slice(rest.indexOf(separator) + separator.length) : '';
  const [statusLine, ...lines] = head.split(/\r?\n/);
  const status = Number(statusLine?.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)?.[1]);
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const headers: Array<[string, string]> = [];
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = clean(line.slice(0, at), 64)?.toLowerCase(), value = headerValue(line.slice(at + 1).trim(), 800);
    if (name && value) headers.push([name, value]);
  }
  return { status, headers, body };
}

/** Resolve a reference against the response URL and keep only same-origin paths; the query is dropped from the route identity. */
function sameOriginPath(reference: string, base: string): { path: string; url: string } | undefined {
  if (!reference || /^(?:javascript|mailto|tel|data|blob):/i.test(reference) || reference.startsWith('#')) return undefined;
  let resolved: URL;
  try { resolved = new URL(reference, base); } catch { return undefined; }
  let origin: URL;
  try { origin = new URL(base); } catch { return undefined; }
  if (resolved.origin !== origin.origin) return undefined;
  const path = cleanIdentity(decodeURIComponentSafe(resolved.pathname) || '/', 300);
  if (!path || !path.startsWith('/')) return undefined;
  return { path, url: normalizeUrl(`${resolved.origin}${resolved.pathname}`) ?? '' };
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export const httpResponse: Extractor = (source) => {
  const text = source.text.trimStart();
  if (!/^HTTP\/\d/.test(text)) return undefined;
  const head = parseHead(text);
  if (!head) return undefined;
  const base = normalizeUrl(source.url);
  if (!base) return undefined;
  const assets: ExtractAsset[] = [], facts: ExtractFact[] = [], warnings: string[] = [];
  const header = (name: string) => head.headers.find(([key]) => key === name)?.[1];
  const security = Object.fromEntries(SECURITY_HEADERS.map(name => {
    const value = header(name);
    return [name, value ? (name === 'content-security-policy' ? 'present' : value) : undefined];
  }));
  const recorded = Object.fromEntries(RECORDED_HEADERS.map(name => [name, header(name)]));
  const cookieNames = head.headers.filter(([name]) => name === 'set-cookie').flatMap(([, value]) => {
    const name = clean(value.split('=')[0], 80);
    return name && !/[;,\s]/.test(name) ? [name] : [];
  });
  const endpointIndex = assets.length;
  assets.push({ kind: 'endpoint', key: base, label: clean(`${head.status} ${base}`, 200), attributes: attributes({
    status: String(head.status), ...recorded, ...security, cookie_names: cookieNames.length ? cookieNames.join(', ') : undefined,
    header_count: String(head.headers.length), body_bytes: String(Buffer.byteLength(head.body)), source: 'http-response',
  }), anchors: [{ kind: 'url', value: base }] });
  facts.push({ asset: endpointIndex, kind: 'observed', confidence: 'high',
    statement: `http: response for ${base} was HTTP ${head.status}${recorded['content-type'] ? ` (${recorded['content-type']})` : ''}` });
  const missing = SECURITY_HEADERS.filter(name => !header(name));
  if (missing.length && /^text\/html|^application\/(?:json|xml)/i.test(recorded['content-type'] ?? ''))
    facts.push({ asset: endpointIndex, kind: 'observed', confidence: 'medium',
      statement: `http: this response did not carry security header(s): ${missing.join(', ')} — an observation about this response, not by itself a vulnerability` });
  if (cookieNames.length)
    facts.push({ asset: endpointIndex, kind: 'observed', confidence: 'high', statement: `http: response set ${cookieNames.length} cookie name(s): ${cookieNames.slice(0, 12).join(', ')} (values are not retained)` });
  // Route identity is the path; how it was discovered is an attribute, so a link, a form and a bundle reference converge on one row.
  const routes = new Map<string, { asset: ExtractAsset; discovered: Set<string>; methods: Set<string> }>();
  const route = (path: string, absolute: string, discovered: string, method?: string) => {
    const existing = routes.get(path);
    if (existing) { existing.discovered.add(discovered); if (method) existing.methods.add(method); return; }
    routes.set(path, { asset: { kind: 'route', key: path, label: path, attributes: attributes({ path, source: 'http-response', discoveredBy: discovered, ...(method ? { method } : {}) }),
      anchors: absolute ? [{ kind: 'path', value: path, locator: { url: absolute } }] : [{ kind: 'path', value: path }] }, discovered: new Set([discovered]), methods: new Set(method ? [method] : []) });
  };
  let links = 0, forms = 0, apiPaths = 0;
  for (const match of head.body.matchAll(LINK)) {
    if (links >= EXTRACT_MAX_LINKS) break;
    const found = sameOriginPath(match[1] ?? match[2] ?? '', base);
    if (!found) continue;
    links += 1;
    route(found.path, found.url, 'link');
  }
  for (const form of head.body.matchAll(FORM)) {
    if (forms >= EXTRACT_MAX_FORMS) break;
    const action = form[0].match(FORM_ACTION), method = form[0].match(FORM_METHOD);
    const found = sameOriginPath(action?.[1] ?? action?.[2] ?? base, base);
    if (!found) continue;
    forms += 1;
    route(found.path, found.url, 'form', (method?.[1] ?? method?.[2] ?? 'get').toLowerCase());
  }
  for (const script of head.body.matchAll(SCRIPT)) {
    for (const quoted of script[1]!.matchAll(QUOTED_PATH)) {
      if (apiPaths >= EXTRACT_MAX_LINKS) break;
      const path = quoted[1]!;
      if (!API_MARKER.test(path) || STATIC_FILE.test(path)) continue;
      const found = sameOriginPath(path, base);
      if (!found) continue;
      apiPaths += 1;
      route(found.path, found.url, 'js');
    }
  }
  for (const { asset, discovered, methods } of routes.values()) {
    const index = assets.length;
    assets.push({ ...asset, attributes: attributes({ ...asset.attributes, discoveredBy: [...discovered].join(','), ...(methods.size ? { method: [...methods].join(',') } : {}) }) });
    facts.push({ asset: index, kind: 'observed', confidence: 'medium',
      statement: `http: response body referenced route ${asset.key} (${[...discovered].join(', ')}); discovery is not reachability` });
  }
  const capNotice = (name: string, count: number, cap: number) => { if (count >= cap) warnings.push(`http-response: ${name} reached the ${cap}-item parse cap; the rest were not inventoried`); };
  capNotice('links', links, EXTRACT_MAX_LINKS);
  capNotice('forms', forms, EXTRACT_MAX_FORMS);
  capNotice('JS API paths', apiPaths, EXTRACT_MAX_LINKS);
  return { extractor: 'http-response', assets, facts, hypotheses: [], components: [], warnings,
    omitted: { assets: 0, facts: 0, hypotheses: 0, components: 0 } } satisfies ExtractResult;
};
