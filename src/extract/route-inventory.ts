/**
 * W-Z/A discovery breadth: a bounded same-origin crawl document becomes attributed route knowledge.
 *
 * The crawl ran as an ordinary sandbox command and its stdout was retained as an artifact, so this extractor is a pure
 * function over bytes the host already holds — no network, no shell, no eval, no target traffic. What it writes is the
 * same grade as a model-recorded row: `route` assets with a parameter matrix as bounded attributes, observed facts for
 * each parameter the crawl saw, and **open hypotheses** for parameter names that look like object references,
 * redirects, file paths, templates, commands or next-hop inputs. It never produces a claim, case, coverage cell or
 * finding: a parameter name is a hypothesis matrix, not reachability and not a demonstrated effect.
 *
 * The format is one exact signature (`p2o-route-inventory/1`) so this parser can sit last in the registry without
 * stealing OpenAPI/httpx/nuclei JSON, and malformed input returns `undefined` rather than throwing into the ingest.
 */
import { clean, cleanIdentity, isRecord, parseJson } from './sanitize.js';
import { EXTRACT_MAX_ASSETS, EXTRACT_MAX_FACTS, EXTRACT_MAX_HYPOTHESES, EXTRACT_MAX_RECORDS, EXTRACT_MAX_ROW_BYTES,
  type ExtractAsset, type ExtractFact, type ExtractHypothesis, type ExtractResult, type Extractor } from './types.js';

/** The one exact document signature the crawl script emits; any other JSON is somebody else's format. */
export const ROUTE_INVENTORY_SCHEMA = 'p2o-route-inventory/1';

const PARAM_LOCATIONS = ['query', 'form', 'path', 'json'] as const;
const METHODS = /^[A-Za-z]{3,7}$/;
/** Parameter names a behavioral test should look at first; the name is a hint, never evidence. */
const SUSPICIOUS_TOKENS = new Set(['id', 'ids', 'redirect', 'url', 'uri', 'path', 'file', 'filename', 'template',
  'cmd', 'command', 'exec', 'next', 'target', 'dest', 'destination', 'return', 'callback', 'continue']);
const PARAMS_PER_ROUTE = 32;
const PARAMS_ATTRIBUTE_BYTES = 500;
const PARAM_NAME_BYTES = 64;

const rowBytes = (row: unknown): number => Buffer.byteLength(JSON.stringify(row));
const suspicious = (name: string): boolean => name.toLowerCase().split(/[^a-z0-9]+/).some(token => SUSPICIOUS_TOKENS.has(token));

/** The parameter matrix as one bounded attribute: `query:q,form:username` in the order the crawl reported them. */
function parameterMatrix(params: ReadonlyArray<readonly [string, string]>): string | undefined {
  const seen = new Set<string>(), entries: string[] = [];
  for (const [location, name] of params.slice(0, PARAMS_PER_ROUTE)) {
    const entry = `${location}:${name}`;
    if (seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries.length ? clean(entries.join(','), PARAMS_ATTRIBUTE_BYTES) : undefined;
}

/** `cookie`, `bearer` or `anonymous`; a label the reader can compare, not a credential. */
function authLabel(auth: Record<string, unknown>): string {
  const parts = (['cookie', 'bearer'] as const).filter(key => auth[key] === true);
  return parts.length ? parts.join('+') : 'anonymous';
}

function readMethods(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap(method => typeof method === 'string' && METHODS.test(method) ? [method.toUpperCase()] : []))].slice(0, 8);
}

function readParams(value: unknown): Array<readonly [string, string]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item)) return [];
    const location = typeof item['in'] === 'string' && (PARAM_LOCATIONS as readonly string[]).includes(item['in']) ? item['in'] : undefined;
    const name = cleanIdentity(item['name'], PARAM_NAME_BYTES);
    return location && name ? [[location, name] as const] : [];
  }).slice(0, PARAMS_PER_ROUTE);
}

export const routeInventory: Extractor = (source) => {
  const text = typeof source.text === 'string' ? source.text : '';
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return undefined;
  const parsed = parseJson(trimmed);
  if (!isRecord(parsed) || parsed['schema'] !== ROUTE_INVENTORY_SCHEMA || !Array.isArray(parsed['routes'])) return undefined;
  const rows = parsed['routes'] as unknown[];
  if (!rows.length) return undefined;

  const assets: ExtractAsset[] = [], facts: ExtractFact[] = [], hypotheses: ExtractHypothesis[] = [], warnings: string[] = [];
  const indices = new Map<string, number>();
  const omitted = { assets: 0, facts: 0, hypotheses: 0, components: 0 };
  let skipped = 0;
  for (const raw of rows.slice(0, EXTRACT_MAX_RECORDS)) {
    if (!isRecord(raw)) { skipped += 1; continue; }
    const path = cleanIdentity(raw['path'], 500);
    if (!path || !path.startsWith('/')) { skipped += 1; continue; }
    const methods = readMethods(raw['methods']);
    const params = readParams(raw['params']);
    const auth = isRecord(raw['auth']) ? raw['auth'] : {};
    let index = indices.get(path);
    if (index === undefined) {
      if (assets.length >= EXTRACT_MAX_ASSETS) { omitted.assets += 1; continue; }
      const matrix = parameterMatrix(params);
      const attributes: Record<string, string> = { source: 'route-crawl', auth: authLabel(auth) };
      if (methods.length) attributes['method'] = methods.join(',');
      if (matrix) attributes['params'] = matrix;
      const asset: ExtractAsset = { kind: 'route', key: path, label: path, attributes, anchors: [{ kind: 'path', value: path }] };
      if (rowBytes(asset) > EXTRACT_MAX_ROW_BYTES) { omitted.assets += 1; continue; }
      index = assets.length;
      indices.set(path, index);
      assets.push(asset);
    }
    for (const [location, name] of params) {
      if (facts.length >= EXTRACT_MAX_FACTS) { omitted.facts += 1; continue; }
      const fact: ExtractFact = { asset: index, kind: 'observed', confidence: 'medium',
        statement: clean(`crawl: route ${path} accepts ${name} in ${location}; the crawl observed a parameter name, not a vulnerability or reachability`, 2_000)! };
      if (rowBytes(fact) > EXTRACT_MAX_ROW_BYTES) { omitted.facts += 1; continue; }
      facts.push(fact);
      if (!suspicious(name)) continue;
      if (hypotheses.length >= EXTRACT_MAX_HYPOTHESES) { omitted.hypotheses += 1; continue; }
      const hypothesis: ExtractHypothesis = { asset: index, statement: clean(`crawl: parameter ${name} on ${path} (${location}) is named like an object reference, redirect, file path, template, command or next-hop input — a name-shaped candidate for behavioral testing, never a demonstrated effect`, 2_000)!,
        impact: clean(`Candidate parameter ${name}: test whether the server acts on it and which boundary that reaches`, 1_000) };
      if (rowBytes(hypothesis) > EXTRACT_MAX_ROW_BYTES) { omitted.hypotheses += 1; continue; }
      hypotheses.push(hypothesis);
    }
  }
  if (!assets.length) return undefined;
  if (skipped) warnings.push(`route-inventory: ${skipped} route row(s) had no usable path and were skipped`);
  const trimmedCounts = Object.entries(omitted).filter(([, count]) => count > 0);
  if (trimmedCounts.length) warnings.push(`ingest bounds: ${trimmedCounts.map(([kind, count]) => `${count} ${kind}`).join(', ')} row(s) omitted`);
  warnings.push('route crawl rows are attributed knowledge: a parameter map is a hypothesis matrix, never a claim or a finding');
  return { extractor: 'route-inventory', assets, facts, hypotheses, components: [], warnings, omitted } satisfies ExtractResult;
};
