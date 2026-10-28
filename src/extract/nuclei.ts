/**
 * R2.2, evidence ladder: a nuclei match becomes an **open hypothesis**, never a claim or a case.
 *
 * The scanner found the bytes its template matches on. That is a lead for a human or a worker to test, not a demonstration of
 * impact; recording it as a claim would let a public template author a finding. The receipt stays the evidence, the statement
 * names the template and classification, and the row is `open` until someone executes the effect.
 */
import { clean, displayUrl, isRecord, lines, normalizeUrl, parseJson } from './sanitize.js';
import { type ExtractAsset, type ExtractHypothesis, type ExtractResult, type Extractor, EXTRACT_MAX_RECORDS } from './types.js';

const stringList = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(item => typeof item === 'string' ? [item] : []) : [];

const classification = (info: Record<string, unknown> | undefined): string | undefined => {
  const cves = stringList(info?.['classification'] ? (info.classification as Record<string, unknown>)['cve-id'] : undefined).filter(cve => /^CVE-\d{4}-\d{4,}$/.test(cve)).slice(0, 5);
  const cwes = stringList(info?.['classification'] ? (info.classification as Record<string, unknown>)['cwe-id'] : undefined).filter(cwe => /^CWE-\d{1,5}$/.test(cwe)).slice(0, 5);
  const cvss = (info?.classification as Record<string, unknown> | undefined)?.['cvss-score'];
  return [...cves, ...cwes, ...(typeof cvss === 'number' ? [`CVSS ${cvss}`] : [])].join(', ') || undefined;
};

export const nuclei: Extractor = (source) => {
  const text = source.text;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  const rows: unknown[] = [];
  let omitted = 0;
  if (trimmed.startsWith('[')) {
    const parsed = parseJson(trimmed);
    if (!Array.isArray(parsed)) return undefined;
    rows.push(...parsed.slice(0, EXTRACT_MAX_RECORDS));
  } else {
    const split = lines(text, EXTRACT_MAX_RECORDS);
    omitted = split.omitted;
    for (const line of split.walk) { const parsed = parseJson(line); if (parsed !== undefined) rows.push(parsed); }
  }
  const candidate = rows.filter((value): value is Record<string, unknown> => isRecord(value)
    && (typeof value['template-id'] === 'string' || typeof value.templateID === 'string') && (typeof value['matched-at'] === 'string' || typeof value.host === 'string'));
  if (!candidate.length) return undefined;
  const assets: ExtractAsset[] = [], hypotheses: ExtractHypothesis[] = [], warnings: string[] = [], seen = new Map<string, number>(), seenStatement = new Set<string>();
  let duplicates = 0, skipped = 0;
  for (const row of candidate) {
    const matched = typeof row['matched-at'] === 'string' ? row['matched-at'] : typeof row.host === 'string' ? row.host : '';
    const url = normalizeUrl(matched);
    if (!url) { skipped += 1; continue; }
    const shown = displayUrl(matched) ?? url;
    let index = seen.get(url);
    if (index === undefined) {
      index = assets.length;
      seen.set(url, index);
      assets.push({ kind: 'endpoint', key: url, label: url, attributes: { source: 'nuclei' }, anchors: [{ kind: 'url', value: url }] });
    }
    const template = clean(row['template-id'] ?? row.templateID, 120) ?? 'unknown-template';
    const info = row.info && typeof row.info === 'object' ? row.info as Record<string, unknown> : undefined;
    const name = clean(info?.name, 200), severity = clean(info?.severity, 24)?.toLowerCase() ?? 'unknown';
    const statement = clean(`nuclei: template ${template}${name ? ` (${name})` : ''} matched at ${shown} — severity ${severity}; scanner signal, not a demonstrated effect`, 2_000);
    if (!statement) { skipped += 1; continue; }
    if (seenStatement.has(statement)) { duplicates += 1; continue; }
    seenStatement.add(statement);
    const impact = clean([classification(info), clean(row['matcher-name'], 120) ? `matcher ${clean(row['matcher-name'], 120)}` : undefined].filter(Boolean).join('; '), 1_000);
    hypotheses.push({ asset: index, statement, ...(impact ? { impact } : {}) });
  }
  if (duplicates) warnings.push(`nuclei: ${duplicates} duplicate match(es) folded into one hypothesis`);
  if (skipped) warnings.push(`nuclei: ${skipped} match(es) had no usable http(s) URL and were skipped`);
  if (omitted) warnings.push(`nuclei: ${omitted} line(s) past the ${EXTRACT_MAX_RECORDS}-record walk limit are not parsed`);
  if (assets.length) warnings.push('nuclei matches are recorded as open hypotheses: a template match is a pointer to test, never a claim, case or finding');
  if (!assets.length) return undefined;
  return { extractor: 'nuclei', assets, facts: [], hypotheses, components: [], warnings, omitted: { assets: 0, facts: 0, hypotheses: duplicates, components: 0 } } satisfies ExtractResult;
};
