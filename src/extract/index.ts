/**
 * R2.1: the extractor registry. One entry point decides whether a retained artifact is a recognized format, runs the matching
 * pure parser, and bounds its output before any graph write happens.
 *
 * The registry is deliberately a fixed ordered list rather than a plugin surface: the order is the format precedence (a JSON
 * document is checked for an OpenAPI signature before a scanner signature), and every parser is a deterministic function of the
 * bytes. Malformed input degrades to a warning or to "not recognized"; it never throws into the tool call that triggered ingest.
 */
import { clean, cleanIdentity } from './sanitize.js';
import { httpx } from './httpx.js';
import { httpResponse } from './http-response.js';
import { nmap } from './nmap.js';
import { nuclei } from './nuclei.js';
import { openapi } from './openapi.js';
import { packages } from './packages.js';
import { EXTRACT_MAX_ASSETS, EXTRACT_MAX_COMPONENTS, EXTRACT_MAX_FACTS, EXTRACT_MAX_HYPOTHESES, EXTRACT_MAX_INPUT_BYTES, EXTRACT_MAX_ROW_BYTES,
  type ExtractAsset, type ExtractComponent, type ExtractFact, type ExtractHypothesis, type ExtractOmissions, type ExtractResult, type ExtractSource, type Extractor } from './types.js';

export * from './types.js';

/** Format precedence: structured specs first, then scanner output, then manifests, then the raw-response catch-all. */
export const EXTRACTORS: ReadonlyArray<{ name: string; run: Extractor }> = [
  { name: 'openapi', run: openapi },
  { name: 'nmap', run: nmap },
  { name: 'nuclei', run: nuclei },
  { name: 'httpx', run: httpx },
  { name: 'packages', run: packages },
  { name: 'http-response', run: httpResponse },
];

const rowBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** UTF-8 prefix at the byte cap, without splitting a character. */
export function boundedText(value: string, cap = EXTRACT_MAX_INPUT_BYTES): string {
  if (Buffer.byteLength(value) <= cap) return value;
  return Buffer.from(value, 'utf8').subarray(0, cap).toString('utf8').replace(/\uFFFD$/, '');
}

/** Capture streams can carry binary (compiled output, tty control); those are artifacts to read, not formats to parse. */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8 * 1024);
  if (!sample) return true;
  let control = 0;
  for (const char of sample) {
    const code = char.codePointAt(0)!;
    if (code === 0) return true;
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return control * 100 > sample.length * 2;
}

function boundAsset(asset: ExtractAsset): ExtractAsset | undefined {
  const key = cleanIdentity(asset.key, 500);
  if (!key) return undefined;
  const bounded: ExtractAsset = { kind: asset.kind, key };
  const label = clean(asset.label, 200);
  if (label) bounded.label = label;
  if (asset.attributes) {
    const attributes = Object.entries(asset.attributes).slice(0, 16).flatMap(([name, value]) => {
      const key = clean(name, 64), kept = clean(value, 500);
      return key && kept ? [[key, kept] as const] : [];
    });
    if (attributes.length) bounded.attributes = Object.fromEntries(attributes);
  }
  if (asset.anchors) {
    const anchors = asset.anchors.slice(0, 4).flatMap(anchor => {
      const value = cleanIdentity(anchor.value, 1000);
      return value ? [{ kind: anchor.kind, value, ...(anchor.locator ? { locator: Object.fromEntries(Object.entries(anchor.locator).slice(0, 8)) } : {}) }] : [];
    });
    if (anchors.length) bounded.anchors = anchors;
  }
  return bounded;
}

/**
 * Enforce the per-ingest bounds and row byte cap. Rows are dropped tail-first and counted in `omitted`, so the return value
 * always truthfully says how much of the artifact's knowledge reached the graph.
 */
export function boundResult(result: ExtractResult): ExtractResult {
  const omitted: ExtractOmissions = { ...result.omitted };
  const warnings = [...result.warnings];
  const assets: ExtractAsset[] = [], assetIndex = new Map<string, number>(), seen = new Set<string>();
  for (const asset of result.assets) {
    const identity = `${asset.kind}\u0000${asset.key}`;
    if (seen.has(identity)) { omitted.assets += 1; continue; }
    if (assets.length >= EXTRACT_MAX_ASSETS) { omitted.assets += 1; continue; }
    const bounded = boundAsset(asset);
    if (!bounded || rowBytes(bounded) > EXTRACT_MAX_ROW_BYTES) { omitted.assets += 1; continue; }
    seen.add(identity);
    assetIndex.set(identity, assets.length);
    assets.push(bounded);
  }
  const remap = (index: number): number | undefined => {
    const asset = result.assets[index];
    return asset ? assetIndex.get(`${asset.kind}\u0000${asset.key}`) : undefined;
  };
  const facts: ExtractFact[] = [];
  for (const fact of result.facts) {
    if (facts.length >= EXTRACT_MAX_FACTS) { omitted.facts += 1; continue; }
    const asset = remap(fact.asset), statement = clean(fact.statement, 2_000);
    if (asset === undefined || !statement) { omitted.facts += 1; continue; }
    const row = { asset, kind: fact.kind, statement, confidence: fact.confidence };
    if (rowBytes(row) > EXTRACT_MAX_ROW_BYTES) { omitted.facts += 1; continue; }
    facts.push(row);
  }
  const hypotheses: ExtractHypothesis[] = [];
  for (const hypothesis of result.hypotheses) {
    if (hypotheses.length >= EXTRACT_MAX_HYPOTHESES) { omitted.hypotheses += 1; continue; }
    const asset = remap(hypothesis.asset), statement = clean(hypothesis.statement, 2_000);
    if (asset === undefined || !statement) { omitted.hypotheses += 1; continue; }
    const impact = clean(hypothesis.impact, 1_000);
    const row = { asset, statement, ...(impact ? { impact } : {}) };
    if (rowBytes(row) > EXTRACT_MAX_ROW_BYTES) { omitted.hypotheses += 1; continue; }
    hypotheses.push(row);
  }
  const components: ExtractComponent[] = [];
  for (const component of result.components) {
    if (components.length >= EXTRACT_MAX_COMPONENTS) { omitted.components += 1; continue; }
    const asset = remap(component.asset);
    if (asset === undefined) { omitted.components += 1; continue; }
    components.push({ asset, name: component.name, version: component.version, ecosystem: component.ecosystem, ...(component.cpe ? { cpe: component.cpe } : {}) });
  }
  const trimmed = Object.entries(omitted).filter(([, count]) => count > 0);
  if (trimmed.length) warnings.push(`ingest bounds: ${trimmed.map(([kind, count]) => `${count} ${kind}`).join(', ')} row(s) omitted`);
  return { extractor: result.extractor, assets, facts, hypotheses, components, warnings, omitted };
}

/**
 * Parse one retained artifact. `undefined` means no parser recognized the format; the caller reports that as a note, not an
 * error. The artifact ID is not part of parsing (identities are content-derived); the writer attaches provenance.
 */
export function extract(source: ExtractSource): ExtractResult | undefined {
  if (!source || typeof source.text !== 'string') return undefined;
  const text = boundedText(source.text);
  if (looksBinary(text)) return undefined;
  const bounded: ExtractSource = { ...source, text };
  for (const { run } of EXTRACTORS) {
    let result: ExtractResult | undefined;
    try { result = run(bounded); } catch { result = undefined; }
    if (result && result.assets.length) return boundResult(result);
  }
  return undefined;
}

/** Plan §R2.1 names the registry entry `parse`; keep both names for the writer and for tests. */
export const parse = extract;

/** Human-facing list of recognized artifact formats, for the tool description and the docs. */
export const EXTRACT_FORMATS = ['nmap XML', 'httpx JSON/JSONL', 'nuclei JSONL', 'raw HTTP response', 'OpenAPI/Swagger JSON',
  'package-lock.json', 'pnpm-lock.yaml', 'requirements.txt', 'go.mod', 'Cargo.lock', 'Gemfile.lock', 'pom.xml'] as const;
