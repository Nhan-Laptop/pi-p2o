import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { checkCancelled, invariant, PolicyError } from '../../policy/errors.js';
import { normalizeAddress } from '../../policy/network.js';
import { normalizeWebTarget } from '../../policy/targets.js';
import { sha256 } from '../redaction.js';
import type { Reservation, TargetBudget } from '../../policy/index.js';
import type { CaptureGate } from './gate.js';
import { previewableText, type CaptureStore, type ProxyRecord } from './store.js';

export const REPLAY_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** A repeat may adjust these request headers; identity, host, proxy and hop-by-hop headers are never accepted. */
const REPLAY_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'if-match', 'if-none-match', 'idempotency-key', 'x-request-id', 'cache-control', 'pragma']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REPLAY_BODY = 65536;

export interface ReplayInput {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly maxResponseBytes?: number;
}
export interface ReplayOutcome { readonly record: ProxyRecord; readonly redirects: readonly string[] }

export interface ReplayOptions {
  readonly gate: CaptureGate;
  readonly budgets: TargetBudget;
  readonly store: CaptureStore;
  readonly original: ProxyRecord;
  readonly input: ReplayInput;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
}

function replayHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const headers = input ?? {};
  invariant(Object.keys(headers).length <= 16, 'INVALID_INPUT', 'Repeat header count exceeded');
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    invariant(REPLAY_HEADERS.has(lower) && !Object.hasOwn(out, lower), 'ACCOUNT_DENIED', 'Repeat may not set identity, host or proxy headers');
    invariant(typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value), 'INVALID_INPUT', 'Header control characters forbidden');
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    invariant(bytes <= 8192, 'INVALID_INPUT', 'Repeat header bytes exceeded');
    out[lower] = value;
  }
  return out;
}

interface Transaction { status: number; headers: Record<string, string>; body: Buffer; pinnedAddress: string; dnsAddresses: string[]; bytes: number }

/**
 * Re-issue a captured request through the same connection-time gate as live capture: policy authorization,
 * DNS pinning and per-address egress policy are re-evaluated for the (possibly modified) method/URL, and the
 * target budget is reserved before any socket exists. A modification may rewrite path/query/method/body and
 * a bounded header allowlist, but it can never change host/origin/account: the repeat URL must stay on the
 * original origin and the original record must have been allowed in the first place.
 */
export async function replayRequest(options: ReplayOptions): Promise<ReplayOutcome> {
  const { gate, budgets, store, original, input, signal } = options;
  invariant(original.decision === 'allowed', 'TARGET_DENIED', 'A refused request is never replayed');
  const originalUrl = normalizeWebTarget(original.url);
  const requested = input.url === undefined ? originalUrl : normalizeWebTarget(input.url);
  invariant(requested.origin === originalUrl.origin, 'TARGET_DENIED', 'Repeat may not widen scope, host or account');
  const method = (input.method ?? original.method).toUpperCase();
  invariant((REPLAY_METHODS as readonly string[]).includes(method), 'ACTION_DENIED', 'Unsupported repeat method');
  const body = input.body ?? '';
  invariant(Buffer.byteLength(body) <= MAX_REPLAY_BODY, 'INVALID_INPUT', 'Repeat body too large');
  invariant(!['GET', 'HEAD', 'OPTIONS'].includes(method) || input.body === undefined, 'ACTION_DENIED', 'Read requests cannot carry bodies');
  const headers = replayHeaders(input.headers);
  const maxBytes = Math.max(1, Math.min(input.maxResponseBytes ?? options.maxResponseBytes, options.maxResponseBytes));
  const redirects: string[] = [];
  let url = requested.url;

  for (;;) {
    const hopStarted = Date.now();
    checkCancelled(signal);
    const check = await gate.check(url, method, 'Repeat', { count: true, signal });
    if (!check.allowed) throw new PolicyError(check.reason, check.detail);
    const reservation = budgets.reserve(check.targetId);
    try {
      const headersOut = { ...headers, 'accept-encoding': 'identity', 'user-agent': 'pi-p2o-broker/1.0.0', ...(input.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) };
      const parsed = new URL(check.url);
      reservation.consumeBytes(Buffer.byteLength(body) + Buffer.byteLength(check.url) + Buffer.byteLength(JSON.stringify(headersOut)));
      const response = await transact({ check, url: parsed, method, headers: headersOut, body, signal, timeoutMs: options.timeoutMs, maxBytes, reservation, gate });
      const location = response.headers.location;
      if (REDIRECTS.has(response.status) && location) {
        invariant(redirects.length < options.maxRedirects, 'REDIRECT_DENIED', 'Repeat redirect hop limit exceeded');
        invariant(!/[\\\u0000-\u0020\u007f]/.test(location) && !/%(?:2f|5c|2e|25)/i.test(location.split(/[?#]/, 1)[0]!), 'REDIRECT_DENIED', 'Ambiguous redirect location');
        let next: string;
        try { next = new URL(location, check.url).href; } catch { throw new PolicyError('REDIRECT_DENIED', 'Invalid redirect location'); }
        // Authorize the hop before following it; a cross-origin hop always fails the gate on the next pass.
        redirects.push(`${response.status} ${next.slice(0, 512)}`);
        url = next;
        continue;
      }
      const record = store.record({
        source: 'repeat', kind: 'repeat', method, url: check.url, decision: 'allowed', reason: 'response', status: response.status,
        requestHeaders: Object.fromEntries(Object.entries({ ...headers, ...(input.body === undefined ? {} : { 'content-type': headers['content-type'] ?? 'application/octet-stream' }) })),
        responseHeaders: response.headers,
        requestBytes: Buffer.byteLength(body), responseBytes: response.bytes, ms: Date.now() - hopStarted,
        requestBodyBytes: Buffer.byteLength(body), responseBodyBytes: response.body.length,
        requestDigest: sha256(Buffer.from(body)), responseDigest: sha256(response.body),
        requestPreview: previewableText(headers['content-type'] ?? '', body),
        responsePreview: previewableText(response.headers['content-type'] ?? '', response.body.toString('utf8')),
        requestMediaType: headers['content-type'] ?? '', responseMediaType: response.headers['content-type'] ?? '',
        targetId: check.targetId, pinnedAddress: response.pinnedAddress, dns: response.dnsAddresses, replayOf: original.id, redirects,
      });
      return { record, redirects: Object.freeze([...redirects]) };
    } finally { reservation.release(); }
  }
}

async function transact(options: {
  check: { targetId: string; url: string; addresses: readonly string[] };
  url: URL; method: string; headers: Record<string, string>; body: string;
  signal?: AbortSignal; timeoutMs: number; maxBytes: number; gate: CaptureGate;
  reservation: Reservation;
}): Promise<Transaction> {
  const { url, method, headers, body, signal, gate, check } = options;
  const secure = url.protocol === 'https:';
  const port = Number(url.port || (secure ? 443 : 80));
  const selected = check.addresses[0]!;
  const agent = secure ? new https.Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 }) : new http.Agent({ keepAlive: false, maxSockets: 1 });
  let pendingSocket: net.Socket | undefined;
  const guardedConnect = (_options: unknown, callback: (error: Error | null, socket?: Duplex) => void): undefined => {
    let settled = false;
    const done = (error: Error | null, socket?: net.Socket) => { if (!settled) { settled = true; callback(error, socket); } };
    void (async () => {
      checkCancelled(signal);
      // Re-check the pinned address set at connect time: a repeat cannot outlive a DNS change.
      const atConnect = await gate.check(check.url, method, 'Repeat', { count: false, signal });
      if (!atConnect.allowed) throw new PolicyError(atConnect.reason, atConnect.detail);
      invariant(JSON.stringify(atConnect.addresses) === JSON.stringify(check.addresses), 'DNS_CHANGED', 'DNS changed between dispatch and connection');
      checkCancelled(signal); // a slow resolver may finish after attempt release: never dial after cancellation
      const endpoint = { host: selected, port, family: net.isIP(selected), autoSelectFamily: false };
      const socket = secure
        ? tls.connect({ ...endpoint, servername: net.isIP(url.hostname) ? undefined : url.hostname, rejectUnauthorized: true, checkServerIdentity: (_hostname, certificate) => tls.checkServerIdentity(url.hostname, certificate), ALPNProtocols: ['http/1.1'] })
        : net.connect(endpoint);
      pendingSocket = socket;
      const cancel = () => { socket.destroy(new PolicyError('CANCELLED', 'Connection cancelled')); done(new PolicyError('CANCELLED', 'Connection cancelled')); };
      signal?.addEventListener('abort', cancel, { once: true });
      socket.once('close', () => signal?.removeEventListener('abort', cancel));
      socket.once('error', () => done(new PolicyError('UNAVAILABLE', 'Connection/TLS failed')));
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        try {
          checkCancelled(signal);
          invariant(socket.remoteAddress && normalizeAddress(socket.remoteAddress) === selected && socket.remotePort === port, 'PEER_MISMATCH', 'Connected peer does not match pinned endpoint');
          done(null, socket);
        } catch (error) { socket.destroy(); done(error as Error); }
      });
      if (signal?.aborted) cancel();
    })().catch(error => done(error instanceof PolicyError ? error : new PolicyError('UNAVAILABLE', 'DNS/connection failed')));
    return undefined;
  };
  agent.createConnection = guardedConnect as typeof agent.createConnection;
  try {
    const response = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
      let failure: Error | undefined;
      const request = (secure ? https : http).request(url, { method, headers, agent, maxHeaderSize: 16384 }, incoming => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const fields = Object.fromEntries(Object.entries(incoming.headers).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : value]));
        incoming.once('error', error => reject(failure ?? (error instanceof PolicyError ? error : new PolicyError('UNAVAILABLE', 'Response failed'))));
        incoming.once('aborted', () => reject(failure ?? new PolicyError('UNAVAILABLE', 'Response was incomplete')));
        try { options.reservation.consumeBytes(Buffer.byteLength(JSON.stringify(fields))); } catch (error) { failure = error as Error; reject(failure); request.destroy(failure); return; }
        incoming.on('data', (chunk: Buffer) => {
          try {
            checkCancelled(signal);
            bytes += chunk.length;
            options.reservation.consumeBytes(chunk.length);
            invariant(bytes <= options.maxBytes, 'OUTPUT_LIMIT', 'Repeat response byte limit exceeded');
            chunks.push(chunk);
          } catch (error) { failure ??= error as Error; reject(failure); incoming.destroy(failure); request.destroy(failure); }
        });
        incoming.once('end', () => {
          try { checkCancelled(signal); resolve({ status: incoming.statusCode ?? 0, headers: fields, body: Buffer.concat(chunks, bytes) }); } catch (error) { reject(error); }
        });
      });
      const cancel = () => { pendingSocket?.destroy(); request.destroy(new PolicyError('CANCELLED', 'Repeat request cancelled')); };
      signal?.addEventListener('abort', cancel, { once: true });
      request.once('close', () => signal?.removeEventListener('abort', cancel));
      request.once('error', error => reject(failure ?? (error instanceof PolicyError ? error : new PolicyError('UNAVAILABLE', 'Repeat request failed'))));
      request.setTimeout(options.timeoutMs, () => request.destroy(new PolicyError('TIMEOUT', 'Repeat socket timed out')));
      request.end(body);
      if (signal?.aborted) cancel();
    });
    return { status: response.status, headers: response.headers, body: response.body, pinnedAddress: selected, dnsAddresses: [...check.addresses], bytes: response.body.length };
  } finally {
    const gone = pendingSocket && !pendingSocket.closed ? new Promise<void>(resolve => pendingSocket!.once('close', () => resolve())) : Promise.resolve();
    pendingSocket?.destroy(); agent.destroy();
    await gone; // destroyed is intent, close is the actual socket teardown proof
  }
}
