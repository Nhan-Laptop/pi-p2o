import { createHash, type Hash } from 'node:crypto';
import { isIP } from 'node:net';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { invariant, PolicyError } from '../policy/errors.js';
import type { TargetBudget, ToolContext } from '../policy/index.js';
import type { GateCheck } from './browser-gate.js';

/**
 * Mandatory egress choke point for a browser session. Chrome is launched with
 * `--proxy-server=http://127.0.0.1:<port>` and `--proxy-bypass-list=<-loopback>` so *every* connection the
 * browser makes — pages, subresources, redirects, websocket upgrades, and Chrome's own background
 * services — arrives here first. Non-scope destinations are answered 403 without any upstream socket, and
 * in-scope destinations are connected to an address this proxy resolved and the policy authorized, which
 * is what makes DNS rebinding at connect time impossible rather than merely detected.
 *
 * The proxy is loopback-only and unauthenticated (a pinned Chrome launcher cannot be given proxy
 * credentials on the command line); it exists only for its session's lifetime and enforces exactly the
 * same scope/budget rules as the CDP gate.
 *
 * [B2] The proxy is also the capture point of the interception pack: an optional `capture` sink receives
 * one bounded observation per handled unit (method, url, decision, status, bounded headers, both body
 * digests, byte counts, timing). Capture is strictly fire-and-forget — a sink error can never change an
 * egress decision — and HTTPS arrives as an opaque CONNECT tunnel, so per-request HTTPS metadata is only
 * available when the CDP Fetch layer supplies it, never from TLS bytes.
 */
export interface EgressGate {
  check(url: string, method: string, resourceType: string, options?: { requestId?: string; count?: boolean; record?: boolean; signal?: AbortSignal }): Promise<GateCheck>;
  checkConnect(host: string, port: number, signal?: AbortSignal): Promise<GateCheck>;
  recordResponse(requestId: string, status: number, bytes?: number, ms?: number): void;
  recordFailed(requestId: string, reason: string): void;
}
export interface EgressObservation {
  readonly kind: 'http' | 'websocket' | 'connect';
  readonly method: string;
  readonly url: string;
  readonly decision: 'allowed' | 'blocked';
  readonly reason: string;
  readonly status: number;
  readonly targetId?: string;
  readonly dns: readonly string[];
  readonly pinnedAddress: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly requestBytes: number;
  readonly responseBytes: number;
  /** Bytes that are body (never the start line/headers); the digests and previews cover exactly these. */
  readonly requestBodyBytes: number;
  readonly responseBodyBytes: number;
  readonly ms: number;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly requestPreview: string;
  readonly responsePreview: string;
  readonly requestMediaType: string;
  readonly responseMediaType: string;
}
export type EgressCaptureSink = (observation: EgressObservation) => void;
export interface EgressProxyOptions {
  gate: EgressGate;
  budgets: TargetBudget;
  capture?: EgressCaptureSink;
  maxConnections?: number;
  headTimeoutMs?: number;
  idleTimeoutMs?: number;
}
export interface EgressProxy {
  readonly port: number;
  readonly url: string;
  readonly connections: number;
  readonly blocked: number;
  readonly errors: number;
  close(): Promise<void>;
}
/** An interchangeable egress proxy: the browser pack's default listener or the capture pack's listener. */
export interface EgressProxyFactory {
  start(options: { gate: EgressGate; budgets: TargetBudget; context: ToolContext; accountId: string; origin: string }): Promise<EgressProxy>;
}
const MAX_HEAD_BYTES = 16384;
const PREVIEW_BYTES = 4096;
const TEXTUAL = /^(?:text\/|application\/(?:json|xml|x-www-form-urlencoded|javascript|graphql)|[a-z0-9.+-]+\/[a-z0-9.+-]*\+json)/i;

interface ParsedHead { method: string; target: string; headers: Record<string, string> }
function parseHead(head: string): ParsedHead {
  const lines = head.split('\r\n');
  const [method = '', target = ''] = (lines[0] ?? '').split(' ');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { method: method.toUpperCase(), target, headers };
}
/** Bounded, control-character-stripped view of a header set; values are redacted later by the capture store. */
function boundedHeaders(headers: Record<string, string>, limit = 24): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Object.keys(out).length >= limit) break;
    out[key.slice(0, 64)] = value.replace(/[^\t\u0020-\u007e]/g, '').slice(0, 512);
  }
  return out;
}
function parseResponseHead(head: string): { status: number; headers: Record<string, string> } {
  const lines = head.split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0) || 0;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { status, headers };
}
function upstreamHead(firstLine: string, headers: Record<string, string>): string {
  const lines = [firstLine];
  for (const [key, value] of Object.entries(headers)) {
    if (key === 'proxy-connection' || key === 'proxy-authorization') continue;
    lines.push(`${key}: ${value}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}
function refuse(socket: Socket, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

/** Per-unit capture accumulator: streaming digests and a bounded preview per direction; O(1) memory. */
interface CaptureAccumulator {
  readonly kind: 'http' | 'websocket' | 'connect';
  readonly method: string;
  url: string;
  targetId?: string;
  dns: readonly string[];
  pinnedAddress: string;
  readonly requestHeaders: Record<string, string>;
  readonly requestHash: Hash;
  readonly responseHash: Hash;
  requestBytes: number;
  responseBytes: number;
  requestBodyBytes: number;
  responseBodyBytes: number;
  requestPreview: Buffer;
  responsePreview: Buffer;
  responseHeaders: Record<string, string>;
  settled: boolean;
}
function newAccumulator(kind: CaptureAccumulator['kind'], method: string, url: string, headers: Record<string, string>, targetId?: string): CaptureAccumulator {
  return {
    kind, method, url, ...(targetId === undefined ? {} : { targetId }),
    requestHeaders: boundedHeaders(headers), requestHash: createHash('sha256'), responseHash: createHash('sha256'),
    requestBytes: 0, responseBytes: 0, requestBodyBytes: 0, responseBodyBytes: 0, requestPreview: Buffer.alloc(0), responsePreview: Buffer.alloc(0), responseHeaders: {}, settled: false, dns: [], pinnedAddress: '',
  };
}
/**
 * Wire bytes are always counted; the digest and bounded preview cover body bytes only, so a start line or
 * header block can never be mistaken for content. CONNECT tunnels and websocket frames are opaque: their
 * whole stream is digested as `body` because there is no HTTP message to split.
 */
function absorb(accumulator: CaptureAccumulator, direction: 'request' | 'response', chunk: Buffer, body: boolean): void {
  try {
    if (direction === 'request') {
      accumulator.requestBytes += chunk.length;
      if (!body) return;
      accumulator.requestBodyBytes += chunk.length;
      accumulator.requestHash.update(chunk);
      if (accumulator.requestPreview.length < PREVIEW_BYTES) accumulator.requestPreview = Buffer.concat([accumulator.requestPreview, chunk.subarray(0, PREVIEW_BYTES - accumulator.requestPreview.length)]);
    } else {
      accumulator.responseBytes += chunk.length;
      if (!body) return;
      accumulator.responseBodyBytes += chunk.length;
      accumulator.responseHash.update(chunk);
      if (accumulator.responsePreview.length < PREVIEW_BYTES) accumulator.responsePreview = Buffer.concat([accumulator.responsePreview, chunk.subarray(0, PREVIEW_BYTES - accumulator.responsePreview.length)]);
    }
  } catch { /* capture accounting never affects egress */ }
}
const previewOf = (buffer: Buffer, mediaType: string): string => (TEXTUAL.test(mediaType) ? buffer.toString('utf8').slice(0, PREVIEW_BYTES) : '');
const mediaTypeOf = (headers: Record<string, string>): string => (headers['content-type'] ?? '').split(';', 1)[0]!.trim().slice(0, 128);

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const sockets = new Set<Socket>();
  const maxConnections = options.maxConnections ?? 64;
  const headTimeoutMs = options.headTimeoutMs ?? 5000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 60000;
  let blocked = 0, errors = 0, closed = false, proxySeq = 0;
  let closing: Promise<void> | undefined;

  const emit = (accumulator: CaptureAccumulator, fields: { decision: 'allowed' | 'blocked'; reason: string; status: number; ms: number; url?: string }): void => {
    if (accumulator.settled || !options.capture) return;
    accumulator.settled = true;
    try {
      const requestMediaType = mediaTypeOf(accumulator.requestHeaders);
      const responseMediaType = mediaTypeOf(accumulator.responseHeaders);
      options.capture({
        kind: accumulator.kind, method: accumulator.method, url: fields.url ?? accumulator.url,
        decision: fields.decision, reason: fields.reason, status: fields.status,
        ...(accumulator.targetId === undefined ? {} : { targetId: accumulator.targetId }),
        dns: accumulator.dns, pinnedAddress: accumulator.pinnedAddress,
        requestHeaders: accumulator.requestHeaders, responseHeaders: accumulator.responseHeaders,
        requestBytes: accumulator.requestBytes, responseBytes: accumulator.responseBytes, ms: fields.ms,
        requestBodyBytes: accumulator.requestBodyBytes, responseBodyBytes: accumulator.responseBodyBytes,
        requestDigest: accumulator.requestHash.digest('hex'), responseDigest: accumulator.responseHash.digest('hex'),
        requestPreview: previewOf(accumulator.requestPreview, requestMediaType), responsePreview: previewOf(accumulator.responsePreview, responseMediaType),
        requestMediaType, responseMediaType,
      });
    } catch { /* capture is diagnostic only: a sink failure is ignored, never surfaced to egress */ }
  };

  const dial = (address: string, port: number): Promise<Socket> => new Promise((resolve, reject) => {
    if (closed) { reject(new PolicyError('UNAVAILABLE', 'Egress session is closed')); return; }
    const upstream = connect({ host: address, port, ...(isIP(address) === 6 ? { family: 6 as const } : {}) });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.setNoDelay(true);
    const failed = (error: unknown) => { upstream.destroy(); reject(error instanceof PolicyError ? error : new PolicyError('UNAVAILABLE', 'Egress connection failed')); };
    upstream.once('error', failed);
    upstream.once('close', () => reject(new PolicyError('UNAVAILABLE', 'Egress connection closed before completion')));
    upstream.once('connect', () => { upstream.removeListener('error', failed); upstream.on('error', () => {}); resolve(upstream); });
  });
  const firstReachable = async (addresses: readonly string[], port: number): Promise<Socket | undefined> => {
    for (const address of addresses) { try { return await dial(address, port); } catch { /* try the next authorized address */ } }
    return undefined;
  };

  /** Reserve, charge and release the target budget for one egress unit (tunnel or proxied request). */
  const charge = (targetId: string, requestBytes: number) => {
    const reservation = options.budgets.reserve(targetId);
    reservation.consumeBytes(requestBytes);
    let released = false;
    return {
      consume(bytes: number) { if (!released) reservation.consumeBytes(bytes); },
      release() { if (!released) { released = true; reservation.release(); } },
    };
  };

  /** Reserve the target budget before any upstream socket exists; a refusal never dials the target. */
  const reserve = (client: Socket, requestId: string, targetId: string, headText: string, accumulator: CaptureAccumulator | undefined, startedAt: number): { consume(bytes: number): void; release(): void } | undefined => {
    try { return charge(targetId, Buffer.byteLength(headText)); }
    catch {
      errors += 1;
      options.gate.recordFailed(requestId, 'BUDGET_EXCEEDED');
      if (accumulator) emit(accumulator, { decision: 'blocked', reason: 'BUDGET_EXCEEDED', status: 429, ms: Date.now() - startedAt });
      refuse(client, 429, 'Too Many Requests');
      return undefined;
    }
  };

  async function handleConnection(client: Socket, headText: string, body: Buffer): Promise<void> {
    const { method, target, headers } = parseHead(headText);
    if (!method || !target || /[\r\n]/.test(target)) { errors += 1; refuse(client, 400, 'Bad Request'); return; }
    const requestId = `proxy-${++proxySeq}`;
    const startedAt = Date.now();

    if (method === 'CONNECT') {
      const separator = target.lastIndexOf(':');
      const host = (separator === -1 ? target : target.slice(0, separator)).replace(/^\[|\]$/g, '');
      const port = Number(separator === -1 ? '443' : target.slice(separator + 1));
      const authority = `https://${isIP(host) === 6 ? `[${host}]` : host}${port === 443 ? '' : `:${port}`}/`;
      const capture = newAccumulator('connect', method, authority, headers);
      // A CONNECT unit is one opaque stream: the CONNECT head and every tunnel byte are digested together.
      absorb(capture, 'request', Buffer.from(headText), true);
      if (body.length) absorb(capture, 'request', body, true);
      const check = await options.gate.checkConnect(host, port);
      if (closed || client.destroyed) return;
      if (!check.allowed) { blocked += 1; emit(capture, { decision: 'blocked', reason: check.reason, status: 403, ms: Date.now() - startedAt }); refuse(client, 403, 'Forbidden'); return; }
      capture.targetId = check.targetId; capture.dns = check.addresses; capture.pinnedAddress = check.addresses[0] ?? '';
      const budget = reserve(client, requestId, check.targetId, headText, capture, startedAt);
      if (!budget) return;
      const upstream = await firstReachable(check.addresses, port);
      if (!upstream) { errors += 1; budget.release(); emit(capture, { decision: 'allowed', reason: 'UNAVAILABLE', status: 502, ms: Date.now() - startedAt }); refuse(client, 502, 'Bad Gateway'); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (body.length) upstream.write(body);
      let bytes = 0, settled = false;
      const finish = () => { if (settled) return; settled = true; options.gate.recordResponse(requestId, 200, bytes, Date.now() - startedAt); emit(capture, { decision: 'allowed', reason: 'response', status: 200, ms: Date.now() - startedAt }); budget.release(); };
      client.on('data', chunk => absorb(capture, 'request', chunk, true));
      upstream.on('data', chunk => { bytes += chunk.length; absorb(capture, 'response', chunk, true); try { budget.consume(chunk.length); } catch { client.destroy(); upstream.destroy(); } });
      upstream.once('end', () => { client.end(); finish(); });
      upstream.once('close', () => { if (!client.destroyed) client.end(); finish(); });
      upstream.once('error', () => { client.destroy(); finish(); });
      client.once('close', () => { upstream.destroy(); finish(); });
      client.once('error', () => { upstream.destroy(); finish(); });
      client.pipe(upstream); upstream.pipe(client);
      if (client.setTimeout) client.setTimeout(idleTimeoutMs, () => { client.destroy(); upstream.destroy(); });
      return;
    }

    const absolute = /^https?:\/\//i.test(target) ? target : `http://${headers.host ?? ''}${target.startsWith('/') ? target : `/${target}`}`;
    const upgrade = (headers.upgrade ?? '').toLowerCase() === 'websocket';
    const capture = newAccumulator(upgrade ? 'websocket' : 'http', method, absolute, headers);
    absorb(capture, 'request', Buffer.from(headText), false);
    if (body.length) absorb(capture, 'request', body, true);
    // Fetch already counted every http(s) request; only a websocket upgrade that Fetch cannot see is charged here.
    const check = await options.gate.check(absolute, method, upgrade ? 'WebSocket' : 'Fetch', { requestId, count: upgrade });
    if (closed || client.destroyed) return;
    if (!check.allowed) { blocked += 1; emit(capture, { decision: 'blocked', reason: check.reason, status: 403, ms: Date.now() - startedAt, url: absolute }); refuse(client, 403, 'Forbidden'); return; }
    capture.targetId = check.targetId;
    capture.url = check.url;
    let parsed: URL;
    try { parsed = new URL(check.url); } catch { errors += 1; refuse(client, 400, 'Bad Request'); return; }
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    // The proxy deliberately speaks plain HTTP only: https/wss arrive as CONNECT tunnels, where TLS is
    // opaque on purpose and the CDP Fetch gate already authorizes each request by full URL.
    if (parsed.protocol !== 'http:') { errors += 1; emit(capture, { decision: 'blocked', reason: 'TARGET_DENIED', status: 501, ms: Date.now() - startedAt }); refuse(client, 501, 'Not Implemented'); return; }
    capture.dns = check.addresses; capture.pinnedAddress = check.addresses[0] ?? '';
    const budget = reserve(client, requestId, check.targetId, headText, capture, startedAt);
    if (!budget) return;
    const upstream = await firstReachable(check.addresses, port);
    if (!upstream) { errors += 1; budget.release(); emit(capture, { decision: 'allowed', reason: 'UNAVAILABLE', status: 502, ms: Date.now() - startedAt }); refuse(client, 502, 'Bad Gateway'); return; }
    const requestLine = `${method} ${parsed.pathname}${parsed.search} HTTP/1.1`;

    if (upgrade) {
      upstream.write(upstreamHead(requestLine, { ...headers, connection: 'Upgrade' }));
      if (body.length) upstream.write(body);
      let bytes = 0, settled = false;
      const finish = () => { if (settled) return; settled = true; options.gate.recordResponse(requestId, 101, bytes, Date.now() - startedAt); emit(capture, { decision: 'allowed', reason: 'response', status: 101, ms: Date.now() - startedAt }); budget.release(); };
      client.on('data', chunk => absorb(capture, 'request', chunk, true));
      upstream.on('data', chunk => { bytes += chunk.length; absorb(capture, 'response', chunk, true); try { budget.consume(chunk.length); } catch { client.destroy(); upstream.destroy(); } });
      upstream.once('close', () => { if (!client.destroyed) client.end(); finish(); });
      upstream.once('error', () => { client.destroy(); finish(); });
      client.once('close', () => { upstream.destroy(); finish(); });
      client.once('error', () => { upstream.destroy(); finish(); });
      client.pipe(upstream); upstream.pipe(client);
      if (client.setTimeout) client.setTimeout(idleTimeoutMs, () => { client.destroy(); upstream.destroy(); });
      return;
    }

    upstream.write(upstreamHead(requestLine, { ...headers, connection: 'close' }));
    if (body.length) upstream.write(body);
    client.on('data', chunk => absorb(capture, 'request', chunk, true));
    client.pipe(upstream);
    let bytes = 0, status: number | undefined, head: Buffer = Buffer.alloc(0), headDone = false, settled = false;
    const finish = () => { if (settled) return; settled = true; options.gate.recordResponse(requestId, status ?? 0, bytes, Date.now() - startedAt); emit(capture, { decision: 'allowed', reason: status ? 'response' : 'incomplete', status: status ?? 0, ms: Date.now() - startedAt }); budget.release(); };
    upstream.on('data', chunk => {
      bytes += chunk.length;
      try { budget.consume(chunk.length); } catch { client.destroy(); upstream.destroy(); return; }
      if (headDone) { absorb(capture, 'response', chunk, true); client.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) { if (head.length > MAX_HEAD_BYTES) { client.destroy(); upstream.destroy(); } return; }
      const headText = head.subarray(0, end).toString('latin1');
      const parsedHead = parseResponseHead(headText);
      status = parsedHead.status || undefined;
      capture.responseHeaders = boundedHeaders(parsedHead.headers);
      const lines = headText.split('\r\n').filter(line => !/^connection:/i.test(line));
      client.write(`${[...lines, 'Connection: close', '', ''].join('\r\n')}`);
      // The response start line and headers are never part of the body digest or preview.
      const rest = head.subarray(end + 4);
      if (rest.length) { absorb(capture, 'response', rest, true); client.write(rest); }
      headDone = true;
    });
    upstream.once('end', () => { client.end(); finish(); });
    upstream.once('close', () => { if (!client.destroyed) client.end(); finish(); });
    upstream.once('error', () => { client.destroy(); finish(); });
    client.once('close', () => { upstream.destroy(); finish(); });
    client.once('error', () => { upstream.destroy(); finish(); });
    if (client.setTimeout) client.setTimeout(idleTimeoutMs, () => { client.destroy(); upstream.destroy(); });
  }

  const server: Server = createServer(socket => {
    if (closed || sockets.size >= maxConnections) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (socket.setTimeout) socket.setTimeout(headTimeoutMs, () => { errors += 1; socket.destroy(); });
    let head: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      if (head.length > MAX_HEAD_BYTES) { errors += 1; refuse(socket, 431, 'Request Header Fields Too Large'); return; }
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      if (socket.setTimeout) socket.setTimeout(0);
      const rest = head.subarray(end + 4);
      void handleConnection(socket, head.subarray(0, end).toString('latin1'), rest).catch(() => { errors += 1; refuse(socket, 502, 'Bad Gateway'); });
    };
    socket.on('data', onData);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new PolicyError('UNAVAILABLE', 'Browser egress proxy could not listen')));
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  invariant(address && typeof address === 'object', 'UNAVAILABLE', 'Browser egress proxy has no port');
  return Object.freeze({
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    get connections() { return sockets.size; },
    get blocked() { return blocked; },
    get errors() { return errors; },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const gone = [...sockets].map(socket => socket.destroyed ? Promise.resolve() : new Promise<void>(resolve => socket.once('close', () => resolve())));
        for (const socket of sockets) socket.destroy();
        await Promise.all([...gone, new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))]);
      })();
      return closing;
    },
  });
}
