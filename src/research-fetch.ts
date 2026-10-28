import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sha256Hex } from './validate.js';

/**
 * R0/D-R1-4: a citation lookup is a host-side fetch, never an evidence path, and it must not become an SSRF or an
 * unbounded allocation in the owner process. The URL is model-chosen, so the fetcher resolves it itself, refuses
 * loopback/link-local/private/metadata destinations (before the request and again for every redirect), and stops reading
 * at a hard byte cap. The returned text is quoted data: instructions inside it are reported, never followed.
 *
 * The previous Part XI implementation used global `fetch` with `redirect: 'follow'` and no limit; that is the defect this
 * module replaces. It is deliberately dependency-free so tests can inject `lookupHost`/`fetchImpl`.
 */
export const RESEARCH_FETCH_MAX_BYTES = 4 * 1024 * 1024;
export const RESEARCH_FETCH_TIMEOUT_MS = 15_000;
export const RESEARCH_FETCH_MAX_REDIRECTS = 5;

export interface ResearchFetchResult {
  status: number; body: string; sha256: string; bytes: number; contentType?: string; finalUrl: string; truncated: boolean;
}
export interface ResearchFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Test seam: resolve the hostname to its addresses. Production uses the system resolver. */
  lookupHost?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /** Test seam: the transport. Production uses global fetch. */
  fetchImpl?: typeof fetch;
}

/** Text-only citation sources; a binary body is reported instead of being retained as text. */
const TEXT_CONTENT_TYPES = [/^text\//, /^application\/(?:json|xml|xhtml\+xml|ld\+json|rss\+xml|atom\+xml|yaml|problem\+json)$/];
export function isTextContentType(value: string | undefined): boolean {
  if (value === undefined) return true;
  const type = value.split(';', 1)[0]!.trim().toLowerCase();
  return TEXT_CONTENT_TYPES.some(pattern => pattern.test(type));
}

const ipv4Blocked = (address: string): boolean => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isSafeInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local and cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && parts[2] === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
};

/** Expand an IPv6 literal into eight 16-bit groups; undefined means "not a valid address". */
function ipv6Groups(address: string): number[] | undefined {
  const input = address.split('%', 1)[0]!.toLowerCase();
  if (!input.includes(':')) return undefined;
  const halves = input.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (!part) return [];
    const groups: number[] = [];
    for (const piece of part.split(':')) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(piece)) {
        const parts = piece.split('.').map(Number);
        if (parts.length !== 4 || parts.some(Number.isNaN)) return undefined;
        groups.push((parts[0]! << 8) | parts[1]!, (parts[2]! << 8) | parts[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return undefined;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  const head = parse(halves[0]!), tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  if (head.length + tail.length >= 8) return undefined;
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** True for every address a citation fetch must never reach: loopback, link-local, private, metadata, multicast, reserved. */
export function isBlockedAddress(raw: string): boolean {
  const address = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return ipv4Blocked(mapped[1]!);
  const family = isIP(address);
  if (family === 4) return ipv4Blocked(address);
  if (family !== 6) return true; // an unrecognised literal is not a destination this fetcher accepts
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  if (groups.every(group => group === 0)) return true; // unspecified
  if (groups.slice(0, 7).every(group => group === 0) && g7 === 1) return true; // loopback
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
    // IPv4-compatible / IPv4-mapped forms that are not textual dotted quads.
    const v4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join('.');
    return g5 === 0xffff ? ipv4Blocked(v4) : true; // deprecated ::a.b.c.d forms are refused outright
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if ((g0 & 0xe000) !== 0x2000) return true; // not global unicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2001 && g1 === 0x0000) return true; // Teredo
  if (g0 === 0x2002) return true; // 6to4
  if (g0 === 0x0064 && g1 === 0xff9b) return true; // NAT64
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard-only
  if (g0 === 0x2001 && (g1 === 0x0002 || (g1 >= 0x0010 && g1 <= 0x002f))) return true; // benchmarking / ORCHID
  return false;
}

/** Local-only names are refused before DNS: they can only resolve to this host or a private resolver view. */
function refusedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || host === 'metadata.google.internal';
}

async function assertFetchable(url: URL, lookupHost: NonNullable<ResearchFetchOptions['lookupHost']>): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('Research fetch accepts http(s) URLs only');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (refusedHostname(hostname)) throw Error(`Research fetch refused ${hostname}: local and metadata hostnames are not citation sources`);
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw Error(`Research fetch refused ${hostname}: loopback, link-local, private and metadata addresses are not citation sources`);
    return;
  }
  let rows: Array<{ address: string; family: number }>;
  try { rows = await lookupHost(hostname); } catch { throw Error(`Research fetch refused ${hostname}: it did not resolve`); }
  if (!rows.length) throw Error(`Research fetch refused ${hostname}: it did not resolve`);
  for (const row of rows) {
    if (isBlockedAddress(row.address)) throw Error(`Research fetch refused ${hostname}: it resolves to a loopback, link-local, private or metadata address (${row.address})`);
  }
}

const defaultLookup: NonNullable<ResearchFetchOptions['lookupHost']> = async hostname => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map(row => ({ address: row.address, family: row.family }));
};

/** Read at most `maxBytes`; the caller gets a truncation marker instead of a silent clip or an unbounded buffer. */
async function readBounded(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    const buffer = Buffer.from(text, 'utf8');
    if (buffer.length <= maxBytes) return { text, bytes: buffer.length, truncated: false };
    return { text: buffer.subarray(0, maxBytes).toString('utf8'), bytes: maxBytes, truncated: true };
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const remaining = maxBytes - bytes;
      if (chunk.length > remaining) {
        if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); bytes += remaining; }
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    }
  } finally {
    reader.releaseLock?.();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes: Buffer.byteLength(Buffer.concat(chunks)), truncated };
}

/**
 * Fetch one citation URL with a hard timeout, byte cap, redirect cap, and a public-destination check on every hop.
 * The body hash and byte count describe exactly what is returned (a truncated body is marked, never silently clipped).
 */
export async function fetchBounded(input: string, options: ResearchFetchOptions = {}): Promise<ResearchFetchResult> {
  const timeoutMs = options.timeoutMs ?? RESEARCH_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? RESEARCH_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? RESEARCH_FETCH_MAX_REDIRECTS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
    !Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw Error('Invalid research fetch bounds');
  const lookupHost = options.lookupHost ?? defaultLookup;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Error(`Research fetch timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const perform = async (): Promise<ResearchFetchResult> => {
    let current = new URL(input);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertFetchable(current, lookupHost);
      let response: Response;
      try {
        response = await fetchImpl(current.href, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'text/html,application/xhtml+xml,application/json;q=0.9,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1' },
        });
      } catch (error) {
        if (controller.signal.aborted) throw Error(`Research fetch timed out after ${timeoutMs} ms`);
        throw Error(`Research fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw Error(`Research fetch: HTTP ${response.status} redirect without a Location header`);
        current = new URL(location, current);
        continue;
      }
      const contentType = response.headers.get('content-type') ?? undefined;
      if (!isTextContentType(contentType)) {
        throw Error(`Research fetch refused a non-text content type (${contentType!.split(';', 1)[0]}); cite the URL instead of fetching it`);
      }
      const body = await readBounded(response, maxBytes);
      return {
        status: response.status, body: body.text, sha256: sha256Hex(body.text), bytes: body.bytes,
        ...(contentType === undefined ? {} : { contentType }), finalUrl: response.url || current.href, truncated: body.truncated,
      };
    }
    throw Error(`Research fetch stopped after ${maxRedirects} redirects`);
  };
  try {
    return await Promise.race([perform(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
