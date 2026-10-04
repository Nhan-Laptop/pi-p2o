import { randomUUID } from 'node:crypto';
import { deepFreeze } from '../../policy/validation.js';
import type { ProxyBodyEvidence, ProxyEntryDetail, ProxyEntrySummary, ProxyKind, ProxySitemapEvidence, ProxySource } from '../types.js';

export const PROXY_MAX_RECORDS = 512;
export const PROXY_PREVIEW_CHARS = 4096;
const HEADER_LIMIT = 24;
const HEADER_VALUE_CHARS = 256;
/** Media types whose bytes are safe to keep as a bounded text preview (never a binary or opaque stream). */
const TEXTUAL = /^(?:text\/|application\/(?:json|xml|x-www-form-urlencoded|javascript|graphql)|[a-z0-9.+-]+\/[a-z0-9.+-]*\+json)/i;
export function previewableText(mediaType: string, text: string): string { return TEXTUAL.test(mediaType) ? text.slice(0, PROXY_PREVIEW_CHARS) : ''; }
/**
 * Header values that must never be persisted in a capture record. The broker's redactor is a second line of
 * defence (it redacts any field whose *key* looks sensitive), but a capture store is a long-lived buffer and
 * must not hold reusable secrets in the first place.
 */
const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-amz-security-token|x-session-token)$/i;
const METHOD_CHARS = 16;
const REDACTED = '[REDACTED]';

export interface ProxyRecordSeed {
  readonly source: ProxySource;
  readonly kind: ProxyKind;
  readonly method: string;
  readonly url: string;
  readonly decision: 'allowed' | 'blocked';
  readonly reason: string;
  readonly status: number;
  readonly requestHeaders: Record<string, string>;
  readonly responseHeaders: Record<string, string>;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly requestBodyBytes: number;
  readonly responseBodyBytes: number;
  readonly ms: number;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly requestPreview: string;
  readonly responsePreview: string;
  readonly requestMediaType: string;
  readonly responseMediaType: string;
  readonly targetId?: string;
  readonly pinnedAddress?: string;
  readonly dns?: readonly string[];
  readonly replayOf?: string;
  readonly redirects?: readonly string[];
}
export type ProxyRecord = ProxyEntryDetail;

const clampNumber = (value: number, max: number): number => (Number.isFinite(value) && value >= 0 ? Math.min(Math.trunc(value), max) : 0);
const cleanDigest = (value: string): string => (/^[a-f0-9]{64}$/.test(value) ? value : '');
const hostOf = (url: string): string => { try { return new URL(url).host.slice(0, 256); } catch { return ''; } };
const pathOf = (url: string): string => { try { return (new URL(url).pathname || '/').slice(0, 1024); } catch { return '/'; } };

function cleanHeaders(headers: Record<string, string>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Object.keys(out).length >= HEADER_LIMIT) break;
    const name = key.toLowerCase().slice(0, 64);
    if (!name || Object.hasOwn(out, name)) continue;
    out[name] = SENSITIVE_HEADER.test(name) ? REDACTED : value.replace(/[^\t\u0020-\u007e]/g, '').slice(0, HEADER_VALUE_CHARS);
  }
  return Object.freeze(out);
}
function bodyEvidence(preview: string, mediaType: string, bytes: number, digest: string, previewable: boolean): ProxyBodyEvidence {
  const text = preview.slice(0, PROXY_PREVIEW_CHARS);
  return Object.freeze({
    digest: cleanDigest(digest), bytes: clampNumber(bytes, Number.MAX_SAFE_INTEGER), mediaType: mediaType.slice(0, 128),
    // An opaque tunnel/frame stream is digested in full and deliberately never previewed: nothing was clipped.
    preview: text, truncated: !previewable ? 'no' : bytes > Buffer.byteLength(text) ? 'yes' : 'no',
  });
}

/**
 * Bounded, redacted, digest-addressed capture buffer for one proxy session. Records are immutable once
 * stored; the oldest record is dropped (never silently truncated in place) once the ring is full, and the
 * drop count is surfaced so a worker can tell that the page is not the whole history.
 */
export class CaptureStore {
  private readonly maxRecords: number;
  private readonly records: ProxyRecord[] = [];
  private readonly byId = new Map<string, ProxyRecord>();
  private sequence = 0;
  private dropped = 0;
  private allowedCount = 0;
  private blockedCount = 0;
  private byteCount = 0;

  constructor(options: { maxRecords?: number } = {}) {
    const requested = options.maxRecords ?? PROXY_MAX_RECORDS;
    this.maxRecords = Number.isSafeInteger(requested) ? Math.max(16, Math.min(requested, 4096)) : PROXY_MAX_RECORDS;
  }

  get total(): number { return this.sequence; }
  get stored(): number { return this.records.length; }
  get stats(): { total: number; stored: number; dropped: number; allowed: number; blocked: number; bytes: number } {
    return { total: this.sequence, stored: this.records.length, dropped: this.dropped, allowed: this.allowedCount, blocked: this.blockedCount, bytes: this.byteCount };
  }

  record(seed: ProxyRecordSeed): ProxyRecord {
    const id = `rq-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const previewable = seed.kind !== 'connect' && seed.kind !== 'websocket';
    const url = seed.url.slice(0, 8192);
    const record: ProxyRecord = deepFreeze({
      seq: ++this.sequence, id, at: new Date().toISOString(), source: seed.source, kind: seed.kind,
      method: seed.method.slice(0, METHOD_CHARS).toUpperCase(), url, host: hostOf(url),
      status: clampNumber(seed.status, 599), decision: seed.decision === 'blocked' ? 'blocked' : 'allowed', reason: seed.reason.slice(0, 64),
      requestBytes: clampNumber(seed.requestBytes, Number.MAX_SAFE_INTEGER), responseBytes: clampNumber(seed.responseBytes, Number.MAX_SAFE_INTEGER), ms: clampNumber(seed.ms, 3_600_000),
      requestDigest: cleanDigest(seed.requestDigest), responseDigest: cleanDigest(seed.responseDigest),
      targetId: (seed.targetId ?? '').slice(0, 128), replayOf: (seed.replayOf ?? '').slice(0, 64), pinnedAddress: (seed.pinnedAddress ?? '').slice(0, 64),
      requestHeaders: cleanHeaders(seed.requestHeaders), responseHeaders: cleanHeaders(seed.responseHeaders),
      requestBody: bodyEvidence(seed.requestPreview, seed.requestMediaType, seed.requestBodyBytes, seed.requestDigest, previewable),
      responseBody: bodyEvidence(seed.responsePreview, seed.responseMediaType, seed.responseBodyBytes, seed.responseDigest, previewable),
      dns: Object.freeze((seed.dns ?? []).slice(0, 32).map(address => address.slice(0, 64))),
      redirects: Object.freeze((seed.redirects ?? []).slice(0, 8).map(entry => entry.slice(0, 600))),
      truncated: previewable && (seed.requestBodyBytes > Buffer.byteLength(seed.requestPreview) || seed.responseBodyBytes > Buffer.byteLength(seed.responsePreview)) ? 'yes' : 'no',
    });
    this.byId.set(id, record);
    this.records.push(record);
    this.byteCount += record.requestBytes + record.responseBytes;
    if (record.decision === 'blocked') this.blockedCount += 1; else this.allowedCount += 1;
    while (this.records.length > this.maxRecords) {
      const evicted = this.records.shift();
      if (evicted) { this.byId.delete(evicted.id); this.dropped += 1; }
    }
    return record;
  }

  get(id: string): ProxyRecord | undefined { return this.byId.get(id); }

  static summary(record: ProxyRecord): ProxyEntrySummary {
    return {
      seq: record.seq, id: record.id, at: record.at, source: record.source, kind: record.kind,
      method: record.method, url: record.url, host: record.host, status: record.status,
      decision: record.decision, reason: record.reason, requestBytes: record.requestBytes, responseBytes: record.responseBytes, ms: record.ms,
      requestDigest: record.requestDigest, responseDigest: record.responseDigest, targetId: record.targetId,
      replayOf: record.replayOf, pinnedAddress: record.pinnedAddress, truncated: record.truncated,
    };
  }

  /** Newest-first bounded page. `matched` is the filtered total so a worker can page deterministically. */
  list(options: { page?: number; limit?: number; filter?: 'all' | 'allowed' | 'blocked'; query?: string } = {}): { entries: ProxyEntrySummary[]; matched: number; shown: number } {
    const limit = Math.max(1, Math.min(options.limit ?? 24, 64));
    const page = Math.max(0, Math.min(options.page ?? 0, 64));
    const filter = options.filter ?? 'all';
    const query = (options.query ?? '').slice(0, 256);
    const ordered = [...this.records].reverse();
    const matched = ordered.filter(record => (filter === 'all' || record.decision === filter) && (query.length === 0 || record.url.includes(query)));
    const entries = matched.slice(page * limit, page * limit + limit).map(record => CaptureStore.summary(record));
    return { entries, matched: matched.length, shown: entries.length };
  }

  /** Bounded origin → path aggregation over the stored page; evicted records are simply absent. */
  sitemap(maxOrigins = 16, maxPaths = 32): ProxySitemapEvidence {
    interface PathEntry { requests: number; methods: Set<string>; lastStatus: number; allowed: number; blocked: number }
    const origins = new Map<string, { requests: number; allowed: number; blocked: number; paths: Map<string, PathEntry> }>();
    for (const record of this.records) {
      let origin: string;
      try { origin = new URL(record.url).origin; } catch { continue; }
      const bucket = origins.get(origin) ?? { requests: 0, allowed: 0, blocked: 0, paths: new Map<string, PathEntry>() };
      bucket.requests += 1;
      if (record.decision === 'blocked') bucket.blocked += 1; else bucket.allowed += 1;
      const path = pathOf(record.url);
      const entry = bucket.paths.get(path) ?? { requests: 0, methods: new Set<string>(), lastStatus: 0, allowed: 0, blocked: 0 };
      entry.requests += 1;
      entry.methods.add(record.method);
      entry.lastStatus = record.status;
      if (record.decision === 'blocked') entry.blocked += 1; else entry.allowed += 1;
      bucket.paths.set(path, entry);
      origins.set(origin, bucket);
    }
    return deepFreeze({
      origins: [...origins.entries()]
        .sort((a, b) => b[1].requests - a[1].requests)
        .slice(0, maxOrigins)
        .map(([origin, bucket]) => ({
          origin, requests: bucket.requests, allowed: bucket.allowed, blocked: bucket.blocked,
          paths: [...bucket.paths.entries()]
            .sort((a, b) => b[1].requests - a[1].requests)
            .slice(0, maxPaths)
            .map(([path, entry]) => ({
              path, requests: entry.requests, methods: [...entry.methods].sort().slice(0, 8), lastStatus: entry.lastStatus,
              decision: entry.allowed > 0 && entry.blocked > 0 ? 'mixed' as const : entry.blocked > 0 ? 'blocked' as const : 'allowed' as const,
            })),
        })),
    });
  }
}
