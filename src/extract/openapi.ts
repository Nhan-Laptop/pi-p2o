/**
 * R2.2: an OpenAPI/Swagger JSON document → route knowledge and declared servers.
 *
 * A published specification is a contract the target handed over: it says which routes exist, what they accept and how they
 * authenticate. It is `configuration` knowledge — what the target documents, not what it enforces — so every row is a contract
 * fact and a route asset, and nothing here is an observation of live behavior.
 */
import { attributes, clean, cleanIdentity, normalizeUrl, parseJson } from './sanitize.js';
import type { ExtractAsset, ExtractFact, ExtractResult, Extractor } from './types.js';
import { EXTRACT_MAX_RECORDS } from './types.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;

export const openapi: Extractor = (source) => {
  const text = source.text.trimStart();
  if (!text.startsWith('{')) return undefined;
  const document = parseJson(text);
  if (!document || typeof document !== 'object' || Array.isArray(document)) return undefined;
  const spec = document as Record<string, unknown>;
  const version = typeof spec.openapi === 'string' ? clean(spec.openapi, 20) : typeof spec.swagger === 'string' ? clean(spec.swagger, 20) : undefined;
  if (!version || (!version.startsWith('3.') && version !== '2.0')) return undefined;
  const paths = spec.paths && typeof spec.paths === 'object' && !Array.isArray(spec.paths) ? spec.paths as Record<string, unknown> : {};
  const servers: string[] = [];
  if (Array.isArray(spec.servers)) for (const server of spec.servers.slice(0, 5)) {
    const url = server && typeof server === 'object' ? (server as { url?: unknown }).url : undefined;
    if (typeof url === 'string') servers.push(url);
  }
  if (version === '2.0') {
    const host = clean(spec.host, 200), basePath = clean(spec.basePath, 200) ?? '';
    const schemes = Array.isArray(spec.schemes) ? spec.schemes.filter((item): item is string => typeof item === 'string').slice(0, 3) : ['https'];
    for (const scheme of schemes) if (host && /^(?:https?)$/.test(scheme)) servers.push(`${scheme}://${host}${basePath}`);
  }
  const assets: ExtractAsset[] = [], facts: ExtractFact[] = [], warnings: string[] = [];
  const serverAssets = new Map<string, number>();
  for (const raw of servers) {
    const url = normalizeUrl(raw);
    if (!url || serverAssets.has(url)) continue;
    serverAssets.set(url, assets.length);
    assets.push({ kind: 'endpoint', key: url, label: url, attributes: { source: 'openapi', role: 'declared server' }, anchors: [{ kind: 'url', value: url }] });
    facts.push({ asset: assets.length - 1, kind: 'configuration', confidence: 'high', statement: `openapi: document declares server ${url}; a declaration, not a reachability check` });
  }
  const routeAssets = new Map<string, number>();
  let operations = 0, parsed = 0, skipped = 0;
  for (const [rawPath, item] of Object.entries(paths)) {
    if (++parsed > EXTRACT_MAX_RECORDS) { warnings.push(`openapi: more than ${EXTRACT_MAX_RECORDS} paths; the remainder is counted as omitted`); break; }
    if (!item || typeof item !== 'object' || Array.isArray(item)) { skipped += 1; continue; }
    const path = cleanIdentity(rawPath.startsWith('/') ? rawPath : `/${rawPath}`, 300);
    if (!path || path.includes('//')) { skipped += 1; continue; }
    const operationsHere = METHODS.flatMap(method => {
      const operation = (item as Record<string, unknown>)[method];
      return operation && typeof operation === 'object' ? [{ method, operation: operation as Record<string, unknown> }] : [];
    });
    if (!operationsHere.length) { skipped += 1; continue; }
    let routeIndex = routeAssets.get(path);
    if (routeIndex === undefined) {
      routeIndex = assets.length;
      routeAssets.set(path, routeIndex);
      assets.push({ kind: 'route', key: path, label: path, attributes: { path, source: 'openapi', methods: operationsHere.map(row => row.method.toUpperCase()).join(',') },
        anchors: serverAssets.size ? [{ kind: 'path', value: path }] : [{ kind: 'path', value: path }] });
    }
    for (const { method, operation } of operationsHere) {
      operations += 1;
      const operationId = clean(operation.operationId, 120), summary = clean(operation.summary, 200);
      const parameters = Array.isArray(operation.parameters) ? operation.parameters.length : 0;
      const security = Array.isArray(operation.security) ? operation.security.length : 0;
      facts.push({ asset: routeIndex, kind: 'configuration', confidence: 'high',
        statement: clean(`openapi: document declares ${method.toUpperCase()} ${path}${operationId ? ` (${operationId})` : ''}${summary ? ` — ${summary}` : ''}`, 2_000)! });
      const asset = assets[routeIndex]!;
      asset.attributes = attributes({ ...asset.attributes, [`${method}_declared`]: clean(`${operationId ?? 'operation'}${parameters ? `; parameters=${parameters}` : ''}${security ? `; auth=${security}` : ''}`, 300) ?? 'operation' });
    }
  }
  const schemes = version === '2.0'
    ? spec.securityDefinitions && typeof spec.securityDefinitions === 'object' ? Object.keys(spec.securityDefinitions as object) : []
    : spec.components && typeof spec.components === 'object' && (spec.components as { securitySchemes?: unknown }).securitySchemes && typeof (spec.components as { securitySchemes?: unknown }).securitySchemes === 'object'
      ? Object.keys((spec.components as { securitySchemes: object }).securitySchemes) : [];
  if (schemes.length && assets.length) facts.push({ asset: 0, kind: 'configuration', confidence: 'high',
    statement: clean(`openapi: document declares ${schemes.length} security scheme(s): ${schemes.slice(0, 12).join(', ')}`, 2_000)! });
  if (skipped) warnings.push(`openapi: ${skipped} path item(s) had no parseable operation and were skipped`);
  if (!assets.length) return undefined;
  warnings.push(`openapi: parsed specification ${version}; declared routes are contract knowledge, not verified reachability`);
  return { extractor: 'openapi', assets, facts: facts.filter(fact => fact.asset < assets.length), hypotheses: [], components: [], warnings,
    omitted: { assets: 0, facts: 0, hypotheses: 0, components: 0 } } satisfies ExtractResult;
};
