import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { boundedOutput, projectEvents, projectPage, projectReport, projectSnapshot } from './presentation.js';
import { InterfaceError, type ControlBackend } from './types.js';
import { viewerCss, viewerHtml, viewerScript } from './viewer.js';

export interface DashboardHandle {
  url: string;
  /** Private user-facing capability: never put in tool details, logs or durable receipts. */
  accessUrl: string;
  close(): Promise<void>;
}
export interface DashboardOptions { backend: ControlBackend; runId: string; enabled: true; pollMs?: number }

/** Explicit opt-in only. This server never calls mutating backend operations. */
export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  if (options.enabled !== true) throw new InterfaceError('DASHBOARD_OPT_IN_REQUIRED', 'dashboard is disabled by default');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(options.runId)) throw new InterfaceError('INVALID_INPUT', 'invalid runId');
  await options.backend.status(options.runId); // Bind only an existing accessible run; never launch one.
  const token = randomBytes(32).toString('base64url');
  const expectedToken = Buffer.from(`Bearer ${token}`);
  const sockets = new Set<Socket>();
  const streams = new Map<ServerResponse, () => void>();
  const pollMs = Math.min(10_000, Math.max(100, options.pollMs ?? 1000));
  let closed = false;
  let origin = '';
  let activeReads = 0;
  let closing: Promise<void> | undefined;

  async function read<T>(operation: () => Promise<T>): Promise<T> {
    if (closed || activeReads >= 16) throw new InterfaceError('READ_LIMIT', 'reader unavailable');
    activeReads++;
    const work = Promise.resolve().then(operation).finally(() => { activeReads--; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new InterfaceError('READ_TIMEOUT', 'read timed out')), 5000);
        timeout.unref();
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }
  function headers(res: ServerResponse): void {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }
  function send(res: ServerResponse, status: number, value: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(boundedOutput(value).text);
  }
  function permitted(req: IncomingMessage): boolean {
    if (req.headers.host !== new URL(origin).host) return false;
    if (req.headers.origin !== undefined && req.headers.origin !== origin) return false;
    if (['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site']))) return false;
    if (Object.keys(req.headers).some(k => k === 'forwarded' || k.startsWith('x-forwarded-'))) return false;
    return req.socket.remoteAddress === '127.0.0.1';
  }
  function authorized(req: IncomingMessage): boolean {
    const supplied = typeof req.headers.authorization === 'string' ? Buffer.from(req.headers.authorization) : Buffer.alloc(0);
    return supplied.length === expectedToken.length && timingSafeEqual(supplied, expectedToken);
  }
  function queries(url: URL, allowed: string[]): void {
    for (const key of url.searchParams.keys()) {
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new InterfaceError('INVALID_QUERY', 'unknown or duplicate query');
    }
  }
  function number(url: URL, key: string, fallback: number, max: number, min = 0): number {
    const raw = url.searchParams.get(key);
    if (raw === null) return fallback;
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new InterfaceError('INVALID_QUERY', 'invalid numeric query');
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new InterfaceError('INVALID_QUERY', 'numeric query outside bounds');
    return n;
  }
  function startStream(res: ServerResponse, initialCursor: number): void {
    if (streams.size >= 8) { send(res, 429, { error: 'STREAM_LIMIT' }); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let cursor = initialCursor;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      streams.delete(res);
    };
    streams.set(res, stop);
    res.once('close', stop);
    res.once('error', stop);
    const write = (chunk: string): boolean => {
      if (stopped || closed || res.destroyed) return false;
      // One bounded frame only. A slow reader is disconnected, not queued indefinitely.
      if (!res.write(chunk)) { stop(); res.destroy(); return false; }
      return true;
    };
    const poll = async (): Promise<void> => {
      if (stopped || closed) return;
      try {
        const page = await read(() => options.backend.events(options.runId, { afterSequence: cursor, limit: 32 }));
        if (!Number.isSafeInteger(page.nextSequence) || page.nextSequence < cursor) throw new InterfaceError('EVENT_CURSOR', 'invalid cursor');
        if (stopped || closed) return;
        const projected = projectEvents(page);
        const output = boundedOutput(projected);
        const data = output.truncated ? { ...(output.value as object), nextSequence: page.nextSequence, gap: true } : output.value;
        cursor = page.nextSequence;
        if (page.items.length || page.gap) {
          if (!write(`id: ${cursor}\nevent: receipts\ndata: ${JSON.stringify(data)}\n\n`)) return;
        } else if (!write(': heartbeat\n\n')) return;
        timer = setTimeout(() => { void poll(); }, pollMs);
        timer.unref();
      } catch {
        write('event: error\ndata: {"error":"EVENT_READ_FAILED"}\n\n');
        stop();
        res.end();
      }
    };
    void poll();
  }

  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    headers(res);
    void (async () => {
      if (closed) { send(res, 503, { error: 'CLOSED' }); return; }
      if (!permitted(req)) { send(res, 403, { error: 'LOCAL_ORIGIN_REQUIRED' }); return; }
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); send(res, 405, { error: 'READ_ONLY' }); return; }
      if (!req.url || req.url.length > 2048 || !req.url.startsWith('/') || req.url.startsWith('//') || /[\\\x00-\x20]/.test(req.url)) {
        send(res, 400, { error: 'INVALID_URL' }); return;
      }
      const url = new URL(req.url, origin);
      const staticAssets: Record<string, [string, string]> = {
        '/': ['text/html', viewerHtml], '/viewer.js': ['text/javascript', viewerScript], '/style.css': ['text/css', viewerCss],
      };
      const asset = staticAssets[url.pathname];
      if (asset) {
        queries(url, []);
        res.writeHead(200, { 'Content-Type': `${asset[0]}; charset=utf-8` }); res.end(asset[1]); return;
      }
      if (!authorized(req)) { send(res, 401, { error: 'TOKEN_REQUIRED' }); return; }
      if (url.pathname === '/api/status') {
        queries(url, []); send(res, 200, projectSnapshot(await read(() => options.backend.status(options.runId))));
      } else if (url.pathname === '/api/tasks' || url.pathname === '/api/evidence') {
        const kind = url.pathname === '/api/tasks' ? 'tasks' : 'evidence';
        queries(url, kind === 'tasks' ? ['offset', 'limit'] : ['offset', 'limit', 'evidenceId']);
        const page = { offset: number(url, 'offset', 0, 1_000_000), limit: number(url, 'limit', 50, 100, 1) };
        const id = url.searchParams.get('evidenceId') ?? undefined;
        if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)) throw new InterfaceError('INVALID_QUERY', 'invalid evidenceId');
        const result = await read(() => kind === 'tasks' ? options.backend.tasks(options.runId, page) : options.backend.evidence(options.runId, page, id));
        send(res, 200, projectPage(result, kind));
      } else if (url.pathname === '/api/report') {
        queries(url, ['format']);
        const format = url.searchParams.get('format') ?? 'json';
        if (format !== 'json' && format !== 'markdown') throw new InterfaceError('INVALID_QUERY', 'unsupported format');
        send(res, 200, projectReport(await read(() => options.backend.report(options.runId, format))));
      } else if (url.pathname === '/api/events' || url.pathname === '/api/stream') {
        queries(url, url.pathname === '/api/stream' ? ['afterSequence'] : ['afterSequence', 'limit']);
        const afterSequence = number(url, 'afterSequence', 0, Number.MAX_SAFE_INTEGER);
        if (url.pathname === '/api/stream') startStream(res, afterSequence);
        else send(res, 200, projectEvents(await read(() => options.backend.events(options.runId, { afterSequence, limit: number(url, 'limit', 50, 100, 1) }))));
      } else send(res, 404, { error: 'NOT_FOUND' });
    })().catch(error => {
      if (res.headersSent) res.destroy();
      else send(res, error instanceof InterfaceError && error.code === 'INVALID_QUERY' ? 400 : 503,
        { error: error instanceof InterfaceError ? error.code : 'READ_FAILED' });
    });
  });
  server.maxHeadersCount = 32;
  server.maxConnections = 32;
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 2000;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  // All request failures are per-request; unexpected server failure triggers owned socket cleanup.
  server.on('error', () => { void close(); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new InterfaceError('DASHBOARD_LISTEN', 'loopback bind failed');
  origin = `http://127.0.0.1:${address.port}`;
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    for (const [res, stop] of streams) { stop(); res.end(); }
    for (const socket of sockets) socket.destroy();
    closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return closing;
  }
  return { url: origin, accessUrl: `${origin}/#token=${token}`, close };
}
