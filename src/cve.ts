/**
 * planning_update.md P16.4: a CVE is a lead, never evidence.
 *
 * The owner chose a host-side fetch (2026-10-24, Part XI): the model names a product/version, never a destination. R0/D-R1-4
 * keeps that choice but bounds the fetch (timeout, 4 MiB, redirect cap, public destinations only). A lead record carries what
 * was read and from where (`url`, `retrievedAt`, `sha256`) and starts `untriaged`; it can settle only by being executed and
 * demonstrated like any other claim. Attribution (ARTEX agent/promptcatalog.go:40,104) is the reason this file exists at all:
 * "version X is affected by CVE-Y" is a pointer to test, not proof of exploitability.
 */
import { sha256Hex } from './validate.js';
import type { AssessmentRecord } from './records.js';

/** Suggested starting points for a CVE lookup; not an allowlist (Part XI). */
export const CVE_SUGGESTED_HOSTS = ['services.nvd.nist.gov', 'nvd.nist.gov', 'www.cve.org', 'cve.org'] as const;
export const LEAD_STATES = ['untriaged', 'tasked', 'ruled_out'] as const;
export type LeadState = typeof LEAD_STATES[number];

export interface CveQuery { product: string; version?: string; vendor?: string; cpe?: string }
export interface CveHit { cve: string; severity: string; score?: number; affected: string; summary: string }
export interface CveFetch { status: number; body: string; sha256: string }
export interface LeadSource { url: string; retrievedAt: string; sha256: string }
export interface LeadDraft { product: string; version?: string; vendor?: string; cpe?: string; cve: string; severity: string; affected: string; summary: string; source: LeadSource }
export interface LeadView { id: string; product: string; version?: string; vendor?: string; cve: string; severity: string; affected: string; source: LeadSource; state: LeadState; assetRefs: Array<{ id: string; revision?: number }>; reason?: string; record: AssessmentRecord }

const clip = (value: unknown, max: number): string => typeof value === 'string' ? value.trim().slice(0, max) : '';
const text = (value: unknown): string => typeof value === 'string' ? value : '';

/** Shape-check the query without inventing a product: the lead names one. */
export function cveQuery(input: Record<string, unknown>): CveQuery {
  const product = clip(input.product, 120);
  if (product.length < 2) throw Error('A CVE lookup needs a product name (2..120 characters)');
  const version = input.version === undefined ? undefined : clip(input.version, 80);
  const vendor = input.vendor === undefined ? undefined : clip(input.vendor, 80);
  const cpe = input.cpe === undefined ? undefined : clip(input.cpe, 300);
  if (cpe !== undefined && !/^cpe:2\.3:[aho*]:/.test(cpe)) throw Error('cpe must be a CPE 2.3 name (cpe:2.3:...)');
  return { product, ...(version ? { version } : {}), ...(vendor ? { vendor } : {}), ...(cpe ? { cpe } : {}) };
}

/** Part XI: any http(s) source is allowed; the suggested hosts above are advice, not a gate. */
export function assertCveSource(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('CVE sources are fetched over http(s) only');
  return url;
}

/** One NVD API 2.0 query: product + version (and vendor when supplied). The host builds it, not the model. */
export function cveUrl(query: CveQuery): string {
  const terms = [query.vendor, query.product].filter(part => part !== undefined).join(' ');
  const search = query.version ? `${terms} ${query.version}` : terms;
  const url = new URL('https://services.nvd.nist.gov/rest/json/cves/2.0');
  url.searchParams.set('keywordSearch', search.slice(0, 200));
  url.searchParams.set('resultsPerPage', '2000');
  assertCveSource(url.toString());
  return url.toString();
}

const severityOf = (metrics: Record<string, unknown> | undefined): { severity: string; score?: number } => {
  for (const key of ['cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2']) {
    const rows = metrics?.[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const data = (row as { cvssData?: Record<string, unknown> })?.cvssData;
      const severity = text(data?.baseSeverity).toUpperCase() || (typeof data?.baseScore === 'number' ? (data.baseScore >= 9 ? 'CRITICAL' : data.baseScore >= 7 ? 'HIGH' : data.baseScore >= 4 ? 'MEDIUM' : 'LOW') : '');
      if (severity) return { severity, ...(typeof data?.baseScore === 'number' ? { score: data.baseScore } : {}) };
    }
  }
  return { severity: 'UNKNOWN' };
};
const affectedOf = (cve: Record<string, unknown>): string => {
  const ranges: string[] = [];
  const configurations = Array.isArray(cve.configurations) ? cve.configurations : [];
  for (const configuration of configurations) {
    const nodes = Array.isArray((configuration as { nodes?: unknown }).nodes) ? (configuration as { nodes: unknown[] }).nodes : [];
    for (const node of nodes) {
      const matches = Array.isArray((node as { cpeMatch?: unknown[] }).cpeMatch) ? (node as { cpeMatch: unknown[] }).cpeMatch : [];
      for (const match of matches) {
        const row = match as Record<string, unknown>;
        if (row.vulnerable === false) continue;
        const criteria = text(row.criteria), from = text(row.versionStartIncluding) || text(row.versionStartExcluding), to = text(row.versionEndIncluding) || text(row.versionEndExcluding);
        const range = from && to ? `${from}..${to}` : criteria.split(':').slice(4, 5)[0] || criteria;
        ranges.push([criteria.split(':').slice(3, 5).join(':'), range].filter(Boolean).join(' '));
        if (ranges.length >= 3) break;
      }
      if (ranges.length >= 3) break;
    }
    if (ranges.length >= 3) break;
  }
  return clip([...new Set(ranges)].join('; '), 300) || 'as published';
};

/** NVD JSON → hits. Rejected/description-less entries are dropped rather than guessed at. */
export function parseNvd(payload: unknown): CveHit[] {
  const rows = Array.isArray((payload as { vulnerabilities?: unknown })?.vulnerabilities) ? (payload as { vulnerabilities: unknown[] }).vulnerabilities : [];
  const hits: CveHit[] = [];
  for (const row of rows) {
    const cve = (row as { cve?: Record<string, unknown> })?.cve;
    const id = text(cve?.id);
    if (!/^CVE-\d{4}-\d{4,}$/.test(id)) continue;
    if (text(cve?.vulnStatus).toLowerCase() === 'rejected') continue;
    const descriptions = Array.isArray(cve?.descriptions) ? cve!.descriptions as Array<{ lang?: string; value?: string }> : [];
    const summary = clip(descriptions.find(item => item.lang === 'en')?.value ?? descriptions[0]?.value, 400);
    const { severity, score } = severityOf(cve?.metrics as Record<string, unknown> | undefined);
    hits.push({ cve: id, severity, ...(score !== undefined ? { score } : {}), affected: cve ? affectedOf(cve) : 'as published', summary });
  }
  return hits;
}

/** One allowlisted fetch, then the leads it produced. The caller supplies the transport so tests never touch the network. */
export async function lookupCves(query: CveQuery, fetchText: (url: string) => Promise<CveFetch>, now = () => new Date().toISOString()): Promise<{ url: string; retrievedAt: string; sha256: string; leads: LeadDraft[] }> {
  const url = cveUrl(query), page = await fetchText(url);
  if (page.status < 200 || page.status >= 300) throw Error(`CVE source answered ${page.status}; no lead is recorded from a failed fetch`);
  const retrievedAt = now(), sha256 = sha256Hex(page.body);
  const leads = parseNvd(JSON.parse(page.body)).map(hit => ({ product: query.product, ...(query.version ? { version: query.version } : {}), ...(query.vendor ? { vendor: query.vendor } : {}), ...(query.cpe ? { cpe: query.cpe } : {}),
    cve: hit.cve, severity: hit.severity, affected: hit.affected, summary: hit.summary, source: { url, retrievedAt, sha256 } }));
  return { url, retrievedAt, sha256, leads };
}

/** `lead` records: one per CVE, state `untriaged`. Provenance is host-recorded; the text says it is a pointer, not a finding. */
export function leadRecords(runId: string, by: string, leads: readonly LeadDraft[], options: { workerId?: string; assetRefs?: Array<{ id: string; revision?: number }> } = {}): AssessmentRecord[] {
  return leads.map(lead => ({
    runId, at: lead.source.retrievedAt, by, ...(options.workerId ? { workerId: options.workerId } : {}), kind: 'lead',
    text: `${lead.product}${lead.version ? ` ${lead.version}` : ''} → ${lead.cve} (${lead.severity}); lead only, not a finding`,
    data: {
      product: lead.product, ...(lead.version ? { version: lead.version } : {}), ...(lead.vendor ? { vendor: lead.vendor } : {}), ...(lead.cpe ? { cpe: lead.cpe } : {}),
      cve: lead.cve, severity: lead.severity, affected: lead.affected, summary: lead.summary, source: lead.source,
      assetRefs: options.assetRefs ?? [], state: 'untriaged' satisfies LeadState,
    },
  }));
}

/** Latest revision per lead record (a triage supersedes the untriaged row). */
export function leadFrontier(index: { records: readonly AssessmentRecord[]; byId: ReadonlyMap<string, AssessmentRecord> }): LeadView[] {
  const replaced = new Set(index.records.flatMap(row => row.supersedes ? [row.supersedes] : []));
  const views: LeadView[] = [];
  for (const row of index.records) {
    if (row.kind !== 'lead' || !row.id || replaced.has(row.id)) continue;
    const data = row.data ?? {};
    const source = data.source as LeadSource | undefined;
    if (!source || typeof source.url !== 'string' || typeof source.sha256 !== 'string') continue;
    const state = (LEAD_STATES as readonly string[]).includes(String(data.state)) ? data.state as LeadState : 'untriaged';
    const assetRefs = Array.isArray(data.assetRefs) ? (data.assetRefs as Array<{ id?: unknown; revision?: unknown }>).flatMap(ref => typeof ref.id === 'string' ? [{ id: ref.id, ...(typeof ref.revision === 'number' ? { revision: ref.revision } : {}) }] : []) : [];
    views.push({ id: row.id, product: text(data.product), ...(text(data.version) ? { version: text(data.version) } : {}), ...(text(data.vendor) ? { vendor: text(data.vendor) } : {}),
      cve: text(data.cve), severity: text(data.severity) || 'UNKNOWN', affected: text(data.affected), source, state, assetRefs, ...(text(data.reason) ? { reason: text(data.reason) } : {}), record: row });
  }
  return views;
}
