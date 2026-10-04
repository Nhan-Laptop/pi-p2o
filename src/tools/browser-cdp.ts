import { checkCancelled, invariant, PolicyError } from '../policy/errors.js';

type Json = Record<string, unknown>;
interface MessageEventLike { readonly data: unknown }
/** Minimal structural WebSocket surface; Node >= 22 provides it as a global (no dependency added). */
interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  addEventListener(type: 'close', listener: (event: unknown) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
}
type WebSocketCtor = new (url: string) => WebSocketLike;
export interface CdpEvent { readonly method: string; readonly params: Json; readonly sessionId?: string }
export interface CdpClient {
  send<T = unknown>(method: string, params?: Json, sessionId?: string): Promise<T>;
  on(handler: (event: CdpEvent) => void): () => void;
  close(): void;
  readonly closed: boolean;
}
export interface CdpOptions { timeoutMs?: number; commandTimeoutMs?: number; maxMessageBytes?: number; signal?: AbortSignal }

export function isJsonObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function asRecord(value: unknown): Json | undefined {
  return isJsonObject(value) ? value : undefined;
}

/**
 * Raw CDP over the browser's WebSocket endpoint: request/response correlation plus event fan-out, with
 * bounded message and command timeouts. No Playwright/Puppeteer; the browser's own protocol is the API.
 */
export async function connectCdp(url: string, options: CdpOptions = {}): Promise<CdpClient> {
  invariant(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+$/.test(url), 'UNAVAILABLE', 'CDP endpoint must be the loopback debugging endpoint of the owned browser');
  const Ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  invariant(typeof Ctor === 'function', 'UNAVAILABLE', 'Runtime has no WebSocket implementation; the browser pack requires Node >= 22');
  const connectTimeoutMs = options.timeoutMs ?? 8000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 20000;
  const maxMessageBytes = options.maxMessageBytes ?? 8388608;
  const socket = new Ctor(url);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: PolicyError) => void; timer: ReturnType<typeof setTimeout> }>();
  const handlers = new Set<(event: CdpEvent) => void>();
  let nextId = 0;
  let closed = false;

  const failAll = (error: PolicyError) => {
    for (const [id, entry] of pending) { clearTimeout(entry.timer); pending.delete(id); entry.reject(error); }
  };
  const shutdown = () => {
    if (closed) return;
    closed = true;
    failAll(new PolicyError('UNAVAILABLE', 'Browser connection closed'));
    try { socket.close(); } catch { /* already gone */ }
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { shutdown(); reject(new PolicyError('TIMEOUT', 'Browser debugging endpoint did not accept the connection')); }, connectTimeoutMs);
    const abort = () => { clearTimeout(timer); shutdown(); reject(new PolicyError('CANCELLED', 'Browser connection cancelled')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    socket.addEventListener('open', () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); resolve(); });
    socket.addEventListener('error', () => { clearTimeout(timer); shutdown(); reject(new PolicyError('UNAVAILABLE', 'Browser debugging endpoint refused the connection')); });
    socket.addEventListener('close', () => { shutdown(); reject(new PolicyError('UNAVAILABLE', 'Browser debugging endpoint closed the connection')); });
    checkCancelled(options.signal);
  });

  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string' || event.data.length > maxMessageBytes) { shutdown(); return; }
    let message: unknown;
    try { message = JSON.parse(event.data); } catch { shutdown(); return; }
    const envelope = asRecord(message);
    if (!envelope) { shutdown(); return; }
    if (typeof envelope.id === 'number') {
      const entry = pending.get(envelope.id);
      if (!entry) return;
      pending.delete(envelope.id); clearTimeout(entry.timer);
      const error = asRecord(envelope.error);
      if (error) entry.reject(new PolicyError('UNAVAILABLE', `Browser command failed: ${String(error.message ?? 'unknown error')}`));
      else entry.resolve(envelope.result);
      return;
    }
    if (typeof envelope.method === 'string') {
      const params = asRecord(envelope.params) ?? {};
      const sessionId = typeof envelope.sessionId === 'string' ? envelope.sessionId : undefined;
      const event_: CdpEvent = { method: envelope.method, params, ...(sessionId ? { sessionId } : {}) };
      for (const handler of handlers) { try { handler(event_); } catch { /* handler faults never break the transport */ } }
    }
  });
  socket.addEventListener('close', () => shutdown());

  return Object.freeze({
    get closed() { return closed; },
    send<T = unknown>(method: string, params: Json = {}, sessionId?: string): Promise<T> {
      if (closed) return Promise.reject(new PolicyError('UNAVAILABLE', 'Browser connection is closed'));
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); shutdown(); reject(new PolicyError('TIMEOUT', 'Browser command deadline exceeded')); }, commandTimeoutMs);
        pending.set(id, { resolve: value => resolve(value as T), reject, timer });
        try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch { clearTimeout(timer); pending.delete(id); reject(new PolicyError('UNAVAILABLE', 'Browser command could not be sent')); }
      });
    },
    on(handler: (event: CdpEvent) => void): () => void { handlers.add(handler); return () => { handlers.delete(handler); }; },
    close() { shutdown(); },
  });
}
