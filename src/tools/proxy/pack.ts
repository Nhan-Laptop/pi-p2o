import { randomUUID } from 'node:crypto';
import { choice, deepFreeze, integer, list, text } from '../../policy/validation.js';
import { checkCancelled, invariant, PolicyError } from '../../policy/errors.js';
import { normalizeOrigin } from '../../policy/targets.js';
import type { Capability, Policy, TargetBudget, ToolContext } from '../../policy/index.js';
import { startEgressProxy, type EgressGate, type EgressObservation, type EgressProxy, type EgressProxyFactory } from '../browser-proxy.js';
import { defaultResolver, type DnsResolver } from '../http.js';
import type { ExecutionSandbox } from '../sandbox.js';
import type { ProxyEvidence, ProxyHistoryEvidence, ProxyRepeatEvidence, ProxySessionEvidence, ToolDescriptor } from '../types.js';
import { CaptureGate } from './gate.js';
import { PROXY_CAPTURE_MODE, proxyIdentity } from './identity.js';
import { replayRequest } from './replay.js';
import { CaptureStore } from './store.js';
import { PackCreationFence, packScopeKey, samePackScope, type PackSessionLifecycle } from '../pack-session.js';
import { currentProcessIdentity } from '../browser-lifecycle.js';

export const PROXY_SESSION_ACTIONS = ['start', 'stop', 'status'] as const;
export const PROXY_HISTORY_ACTIONS = ['list', 'view', 'repeat', 'sitemap', 'scope_rules'] as const;
export type ProxySessionAction = typeof PROXY_SESSION_ACTIONS[number];
export type ProxyHistoryAction = typeof PROXY_HISTORY_ACTIONS[number];

const DEFAULT_TTL_MS = 300_000;
const MAX_TTL_MS = 3_600_000;
const DEFAULT_REQUESTS = 256;
const MAX_REQUESTS = 4096;
const DEFAULT_BYTES = 33_554_432;
const MAX_BYTES = 268_435_456;
const MAX_ORIGINS = 8;
const MAX_SESSIONS = 4;
const LIMITS = Object.freeze([
  'Capture is passthrough: HTTP request/response metadata and body digests are recorded, HTTPS/wss are recorded at CONNECT granularity because TLS is never intercepted.',
  'No per-run CA and no MITM: captured HTTPS bodies are opaque ciphertext and the store records host, port, byte counts and timing only.',
  'Every captured unit is authorized at connection time by the same policy (canonicalization, target/path/exclusion, method/action, account, DNS pin, CIDR) before a socket is dialed.',
  'repeat re-issues one captured request through the same gate with the target budget reserved first; it can modify method/path/query/body but never host, origin, account or scope.',
  'Sessions are bound to one attempt, expire with the grant/authorization deadline, and are killed on release, deadline or owner failure; a stale capture session is never readable again.',
  'Only anonymous approved accounts: a capture proxy never injects broker-held credentials and never stores reusable header secrets.',
]);

export interface ProxyPackExecutionInput {
  readonly context: ToolContext;
  readonly capability: Capability;
  readonly input: Record<string, unknown>;
  readonly descriptor: Readonly<ToolDescriptor>;
  readonly signal?: AbortSignal;
  readonly touchedTargets: Set<string>;
}
export interface ProxyPackOptions {
  readonly policy: Policy;
  readonly budgets: TargetBudget;
  readonly sandbox: ExecutionSandbox;
  readonly resolver?: DnsResolver;
  readonly maxSessions?: number;
  readonly sessionTtlMs?: number;
  readonly maxRequestsPerSession?: number;
  readonly maxBytesPerSession?: number;
  readonly maxRecords?: number;
  readonly lifecycle?: PackSessionLifecycle;
}
export interface ProxyPack {
  /** Broker-side dispatch authorization target for a proxy capability call. */
  authorizeTarget(capability: Capability, input: Record<string, unknown>): { url: string; method: string; accountId: string; action: 'read' | 'mutate' };
  execute(execution: ProxyPackExecutionInput): Promise<ProxyEvidence>;
  /** Capture-capable egress proxy handed to the browser pack so page traffic is recorded by this pack. */
  readonly egressProxy: EgressProxyFactory;
  /** Attempt-release hook: kills every capture session owned by the attempt and tombstones it. */
  releaseAttempt(context: Pick<ToolContext, 'runId' | 'taskId' | 'attemptId'>): Promise<number>;
  /** Live capture sessions attributable to the attempt (0 after release); `packSessionReleaser` may report it. */
  outstanding(context: Pick<ToolContext, 'runId' | 'taskId' | 'attemptId'>): number;
  close(): Promise<void>;
  inspect(proxyId: string): { port: number; url: string; connections: number; blocked: number; errors: number; records: number; refused: boolean; targets: readonly string[]; dns: readonly { host: string; addresses: readonly string[] }[] } | undefined;
  readonly sessions: number;
}

interface CaptureSession {
  readonly id: string;
  readonly context: ToolContext;
  readonly accountId: string;
  readonly origins: readonly string[];
  readonly implicit: boolean;
  readonly limits: { readonly maxRequests: number; readonly maxBytes: number };
  readonly gate: CaptureGate;
  readonly store: CaptureStore;
  readonly proxies: Set<EgressProxy>;
  readonly targets: Set<string>;
  expiresAt: number;
  closed: boolean;
  teardown?: Promise<void>;
  readonly abort: AbortController;
  readonly actions: Set<Promise<unknown>>;
}
interface Tombstone { readonly id: string; readonly context: ToolContext; readonly accountId: string; readonly origins: readonly string[]; readonly implicit: boolean; readonly closedAt: number; readonly reason: string; readonly requestsMax: number; readonly bytesMax: number }

const liveProxies = new Set<EgressProxy>();
let exitHooked = false;
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => { for (const proxy of liveProxies) void proxy.close(); });
}

/** Force every unit through a counted gate: the standalone listener has no CDP layer to count requests. */
function countingGate(gate: CaptureGate): EgressGate {
  return {
    check: (url, method, resourceType, options) => gate.check(url, method, resourceType, { ...options, count: true }),
    checkConnect: (host, port, signal) => gate.checkConnect(host, port, signal),
    recordResponse: (requestId, status, bytes, ms) => gate.recordResponse(requestId, status, bytes, ms),
    recordFailed: (requestId, reason) => gate.recordFailed(requestId, reason),
  };
}
function headerInput(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', 'headers must be an object');
  const entries = Object.entries(value as Record<string, unknown>);
  invariant(entries.length <= 16, 'INVALID_INPUT', 'Header count exceeded');
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    invariant(typeof entry === 'string' && key.length <= 128, 'INVALID_INPUT', 'Invalid header value');
    out[key] = entry;
  }
  return out;
}
/** An empty repeat body is meaningful, so this validator accepts the empty string where `text` does not. */
function bodyInput(value: unknown): string {
  invariant(typeof value === 'string' && value.length <= 65536, 'INVALID_INPUT', 'Invalid repeat body');
  return value;
}

/**
 * Capture/replay pack. One session per attempt owns a bounded store, a connection-time policy gate and an
 * egress listener. The same store receives traffic the browser pack routes through the pack's capture proxy,
 * so `proxy.history` is a single view over page traffic and direct capture.
 */
export function createProxyPack(options: ProxyPackOptions): ProxyPack {
  const sessions = new Map<string, CaptureSession>();
  const tombstones = new Map<string, Tombstone>();
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const ttlMs = options.sessionTtlMs ?? DEFAULT_TTL_MS;
  const requestsMax = options.maxRequestsPerSession ?? DEFAULT_REQUESTS;
  const bytesMax = options.maxBytesPerSession ?? DEFAULT_BYTES;
  const resolver = options.resolver ?? defaultResolver;
  let closed = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const creation = new PackCreationFence(options.lifecycle);
  const releases = new Map<string, Promise<number>>();
  let closing: Promise<void> | undefined;
  hookExit();

  const ensureWatchdog = (): void => {
    if (watchdog || closed) return;
    watchdog = setInterval(() => {
      for (const session of [...sessions.values()]) {
        if (session.closed) continue;
        let revoked = false;
        try { options.policy.assertActive(session.context); } catch { revoked = true; }
        if (Date.now() >= session.expiresAt) void kill(session, 'deadline').catch(() => {});
        else if (revoked) void kill(session, 'grant-revoked').catch(() => {});
      }
    }, 1000);
    watchdog.unref?.();
  };
  const stopWatchdog = (): void => { if (watchdog) { clearInterval(watchdog); watchdog = undefined; } };

  const forget = (session: CaptureSession, reason: string): void => {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.id);
    for (const proxy of session.proxies) liveProxies.delete(proxy);
    tombstones.set(session.id, { id: session.id, context: { ...session.context }, accountId: session.accountId, origins: session.origins, implicit: session.implicit, closedAt: Date.now(), reason, requestsMax: requestsMax, bytesMax: bytesMax });
    if (tombstones.size > 64) { const first = tombstones.keys().next().value; if (first !== undefined) tombstones.delete(first); }
  };
  function kill(session: CaptureSession, reason: string): Promise<void> {
    if (session.teardown) return session.teardown;
    session.closed = true;
    session.abort.abort();
    session.teardown = (async () => {
      const results = await Promise.allSettled([...session.proxies].map(proxy => proxy.close()));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new Error(`Capture listener teardown is unverified: ${failures.map(result => String(result.reason)).join('; ')}`);
      await Promise.allSettled([...session.actions]);
      await options.lifecycle?.resolve(session.context, session.id);
      session.closed = false;
      forget(session, reason);
      session.proxies.clear();
    })().catch(error => { session.teardown = undefined; throw error; });
    return session.teardown;
  }
  const requireOwnership = (context: ToolContext, proxyId: string): { session?: CaptureSession; tombstone?: Tombstone } => {
    const session = sessions.get(proxyId);
    if (session) {
      invariant(session.context.runId === context.runId && session.context.taskId === context.taskId && session.context.attemptId === context.attemptId, 'IDENTITY_DENIED', 'Capture session belongs to a different attempt');
      return { session };
    }
    const tombstone = tombstones.get(proxyId);
    invariant(tombstone, 'INVALID_INPUT', 'Unknown capture session');
    invariant(tombstone.context.runId === context.runId && tombstone.context.taskId === context.taskId && tombstone.context.attemptId === context.attemptId, 'IDENTITY_DENIED', 'Capture session belonged to a different attempt and cannot be reused');
    return { tombstone };
  };
  const assertLive = (session: CaptureSession): void => {
    invariant(!closed, 'UNAVAILABLE', 'Proxy pack is closed');
    invariant(!session.closed && sessions.has(session.id), 'UNAVAILABLE', 'Capture session is no longer live');
    invariant(Date.now() < session.expiresAt, 'EXPIRED', 'Capture session lifetime expired');
    options.policy.assertActive(session.context);
  };
  /** The attempt's active session, preferring an explicitly started one over a browser-implicit capture session. */
  const sessionFor = (context: ToolContext): CaptureSession | undefined => {
    const owned = [...sessions.values()].filter(session => !session.closed && session.context.runId === context.runId && session.context.taskId === context.taskId && session.context.attemptId === context.attemptId);
    return owned.find(session => !session.implicit) ?? owned[owned.length - 1];
  };
  /** Bounded record sink; a capture failure can never change an egress decision and never throws into egress. */
  const sink = (session: CaptureSession, source: 'capture-proxy' | 'browser-egress') => (observation: EgressObservation): void => {
    try {
      session.store.record({
        source, kind: observation.kind, method: observation.method, url: observation.url,
        decision: observation.decision, reason: observation.reason, status: observation.status,
        requestHeaders: { ...observation.requestHeaders }, responseHeaders: { ...observation.responseHeaders },
        requestBytes: observation.requestBytes, responseBytes: observation.responseBytes, ms: observation.ms,
        requestBodyBytes: observation.requestBodyBytes, responseBodyBytes: observation.responseBodyBytes,
        requestDigest: observation.requestDigest, responseDigest: observation.responseDigest,
        requestPreview: observation.requestPreview, responsePreview: observation.responsePreview,
        requestMediaType: observation.requestMediaType, responseMediaType: observation.responseMediaType,
        ...(observation.targetId === undefined ? {} : { targetId: observation.targetId }),
        dns: observation.dns, pinnedAddress: observation.pinnedAddress,
      });
      session.gate.chargeBytes(observation.requestBytes + observation.responseBytes);
      if (observation.targetId) session.targets.add(observation.targetId);
    } catch { /* capture is diagnostic only */ }
  };

  function listenerIdentity(session: CaptureSession): Record<string, unknown> {
    return { version: 1, kind: 'controller-listener', sessionId: session.id,
      scope: { runId: session.context.runId, taskId: session.context.taskId, attemptId: session.context.attemptId },
      controller: currentProcessIdentity(), ports: [...session.proxies].map(proxy => proxy.port) };
  }

  async function openCaptureSession(context: ToolContext, accountId: string, origins: readonly string[], implicit: boolean, limits: { maxRequests: number; maxBytes: number }, ttlOverrideMs?: number): Promise<CaptureSession> {
    await creation.check(context);
    const grant = options.policy.assertActive(context);
    // An implicit session is opened by the browser pack's already-authorized session: its gate only counts
    // budget (the browser gate authorizes every request), so no second capability grant is demanded here.
    if (!implicit) for (const origin of origins) options.policy.authorize({ context, capability: 'proxy.session', action: 'read', url: `${origin}/`, method: 'GET', accountId });
    const expiresAt = Math.min(Date.parse(grant.expiresAt), Date.parse(options.policy.scope.authorization.expiresAt), Date.now() + (ttlOverrideMs ?? (implicit ? MAX_TTL_MS : ttlMs)));
    const id = `px-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const session: CaptureSession = {
      id, context: { ...context }, accountId, origins: Object.freeze([...origins]), implicit, limits,
      gate: new CaptureGate({ policy: options.policy, sandbox: options.sandbox, context, accountId, capability: 'proxy.session', resolver, limits }),
      store: new CaptureStore(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
      proxies: new Set<EgressProxy>(), targets: new Set<string>(), expiresAt, closed: false, abort: new AbortController(), actions: new Set(),
    };
    await options.lifecycle?.enroll(context, id, listenerIdentity(session));
    sessions.set(id, session);
    ensureWatchdog();
    return session;
  }

  async function trackProxy(session: CaptureSession, proxy: EgressProxy): Promise<void> {
    // Attribute before any await: a simultaneous stop must see the newly allocated listener.
    session.proxies.add(proxy); liveProxies.add(proxy);
    await options.lifecycle?.update(session.context, session.id, listenerIdentity(session));
    await creation.check(session.context);
  }
  const fencedGate = (context: ToolContext, gate: EgressGate): EgressGate => ({
    ...gate,
    async check(url, method, resourceType, options) {
      try { await creation.check(context); const result = await gate.check(url, method, resourceType, options); await creation.check(context); return result; }
      catch { return { allowed: false, reason: 'CAPABILITY_DENIED', detail: 'Capture attempt is sealed' }; }
    },
    async checkConnect(host, port, signal) {
      try { await creation.check(context); const result = await gate.checkConnect(host, port, signal); await creation.check(context); return result; }
      catch { return { allowed: false, reason: 'CAPABILITY_DENIED', detail: 'Capture attempt is sealed' }; }
    },
  });
  const sessionEvidence = (session: CaptureSession, status: 'open' | 'closed', released: 'yes' | 'no'): ProxySessionEvidence => deepFreeze({
    kind: 'proxy-session' as const, status, proxyId: session.id, mode: PROXY_CAPTURE_MODE, origins: session.origins,
    budget: { requests: session.gate.requestCount, requestsMax: session.limits.maxRequests, bytes: session.gate.byteCount, bytesMax: session.limits.maxBytes },
    identity: proxyIdentity(), isolation: options.sandbox.boundary, limits: LIMITS, released,
  });
  const tombstoneEvidence = (tombstone: Tombstone): ProxySessionEvidence => deepFreeze({
    kind: 'proxy-session' as const, status: 'closed' as const, proxyId: tombstone.id, mode: PROXY_CAPTURE_MODE, origins: tombstone.origins,
    budget: { requests: 0, requestsMax: tombstone.requestsMax, bytes: 0, bytesMax: tombstone.bytesMax }, identity: proxyIdentity(), isolation: options.sandbox.boundary, limits: LIMITS, released: 'yes' as const,
  });
  const historyBase = (session: CaptureSession, action: ProxyHistoryAction): Omit<ProxyHistoryEvidence, 'total' | 'shown' | 'refused' | 'limits'> => ({
    kind: 'proxy-history' as const, proxyId: session.id, action, status: 'open' as const,
  });
  const syncTouched = (execution: ProxyPackExecutionInput, session: CaptureSession): void => { for (const id of session.targets) execution.touchedTargets.add(id); };

  async function sessionAction(execution: ProxyPackExecutionInput, input: Record<string, unknown>): Promise<ProxyEvidence> {
    const action = choice(text(input.action, 'action', 16), 'action', PROXY_SESSION_ACTIONS);
    invariant(!closed, 'UNAVAILABLE', 'Proxy pack is closed');
    if (action === 'start') {
      invariant(sessions.size < maxSessions, 'BUDGET_EXCEEDED', 'Capture session limit reached');
      const origins = list(input.origins, 'origins', (value, label) => normalizeOrigin(text(value, label, 8192)), 1, MAX_ORIGINS);
      const accountId = text(input.accountId, 'accountId', 128);
      const limits = {
        maxRequests: input.maxRequests === undefined ? requestsMax : integer(input.maxRequests, 'maxRequests', 1, MAX_REQUESTS),
        maxBytes: input.maxBytes === undefined ? bytesMax : integer(input.maxBytes, 'maxBytes', 1024, MAX_BYTES),
      };
      const requestedTtl = input.ttlMs === undefined ? undefined : integer(input.ttlMs, 'ttlMs', 1000, MAX_TTL_MS);
      const session = await openCaptureSession(execution.context, accountId, origins, false, limits, requestedTtl);
      try {
        // The standalone listener is the session's own egress path; the browser pack may use the same pack
        // through the egress factory, in which case the browser session's proxy is added to this session.
        const proxy = await startEgressProxy({ gate: fencedGate(session.context, countingGate(session.gate)), budgets: options.budgets, capture: sink(session, 'capture-proxy'), maxConnections: 64 });
        await trackProxy(session, proxy);
      } catch (error) {
        await kill(session, 'start-failed');
        throw error instanceof PolicyError ? error : new PolicyError('UNAVAILABLE', 'Capture listener could not start');
      }
      return sessionEvidence(session, 'open', 'no');
    }
    const proxyId = input.proxyId === undefined ? sessionFor(execution.context)?.id : text(input.proxyId, 'proxyId', 128);
    invariant(proxyId, 'INVALID_INPUT', 'No active capture session for this attempt');
    const found = requireOwnership(execution.context, proxyId);
    if (found.tombstone) return tombstoneEvidence(found.tombstone);
    const session = found.session!;
    syncTouched(execution, session);
    if (action === 'status') { await creation.check(execution.context); assertLive(session); return sessionEvidence(session, 'open', 'no'); }
    const evidence = sessionEvidence(session, 'closed', 'yes');
    await kill(session, 'stopped');
    return evidence;
  }

  async function historyAction(execution: ProxyPackExecutionInput, input: Record<string, unknown>): Promise<ProxyEvidence> {
    const action = choice(text(input.action, 'action', 24), 'action', PROXY_HISTORY_ACTIONS);
    const proxyId = text(input.proxyId, 'proxyId', 128);
    await creation.check(execution.context);
    const found = requireOwnership(execution.context, proxyId);
    invariant(found.session, 'UNAVAILABLE', 'Capture session is closed and cannot be read');
    const session = found.session;
    assertLive(session);
    syncTouched(execution, session);
    const stats = session.store.stats;
    const base = { ...historyBase(session, action), total: stats.stored, refused: session.gate.refused ? 'yes' as const : 'no' as const, limits: LIMITS };
    if (action === 'list') {
      const listed = session.store.list({
        ...(input.limit === undefined ? {} : { limit: integer(input.limit, 'limit', 1, 64) }),
        ...(input.page === undefined ? {} : { page: integer(input.page, 'page', 0, 64) }),
        ...(input.filter === undefined ? {} : { filter: choice(input.filter, 'filter', ['all', 'allowed', 'blocked'] as const) }),
        ...(input.query === undefined ? {} : { query: text(input.query, 'query', 256) }),
      });
      return deepFreeze({ ...base, shown: listed.shown, entries: listed.entries });
    }
    if (action === 'view' || action === 'repeat') {
      const requestId = text(input.requestId, 'requestId', 64);
      const record = session.store.get(requestId);
      invariant(record, 'INVALID_INPUT', 'Unknown capture record');
      if (action === 'view') return deepFreeze({ ...base, shown: 1, entry: record });
      // Repeats run under the history capability; the standalone listener keeps its own capability.
      session.gate.useCapability('proxy.history');
      let replay;
      try {
        checkCancelled(execution.signal);
        replay = await replayRequest({
          gate: session.gate, budgets: options.budgets, store: session.store, original: record,
          input: {
            ...(input.method === undefined ? {} : { method: text(input.method, 'method', 16) }),
            ...(input.url === undefined ? {} : { url: text(input.url, 'url', 8192) }),
            ...(input.headers === undefined ? {} : { headers: headerInput(input.headers) }),
            ...(input.body === undefined ? {} : { body: bodyInput(input.body) }),
            ...(input.maxResponseBytes === undefined ? {} : { maxResponseBytes: integer(input.maxResponseBytes, 'maxResponseBytes', 1, execution.descriptor.limits.maxResponseBytes) }),
          },
          signal: execution.signal ? AbortSignal.any([execution.signal, session.abort.signal]) : session.abort.signal,
          timeoutMs: execution.descriptor.limits.timeoutMs,
          maxResponseBytes: execution.descriptor.limits.maxResponseBytes,
          maxRedirects: execution.descriptor.limits.maxRedirects,
        });
      } finally { session.gate.useCapability('proxy.session'); }
      await creation.check(execution.context);
      session.targets.add(replay.record.targetId);
      syncTouched(execution, session);
      const repeat: ProxyRepeatEvidence = {
        id: replay.record.id, url: replay.record.url, method: replay.record.method, status: replay.record.status,
        requestDigest: replay.record.requestDigest, responseDigest: replay.record.responseDigest,
        requestBytes: replay.record.requestBytes, responseBytes: replay.record.responseBytes, ms: replay.record.ms,
        pinnedAddress: replay.record.pinnedAddress, dns: replay.record.dns, redirects: replay.record.redirects,
        truncated: replay.record.truncated, replayOf: replay.record.replayOf,
      };
      return deepFreeze({ ...base, shown: 2, entry: record, repeat });
    }
    if (action === 'sitemap') return deepFreeze({ ...base, shown: 0, sitemap: session.store.sitemap() });
    return deepFreeze({ ...base, shown: 0, scope: session.gate.describe() });
  }

  return Object.freeze({
    get sessions() { return sessions.size; },
    authorizeTarget(capability: Capability, input: Record<string, unknown>): { url: string; method: string; accountId: string; action: 'read' | 'mutate' } {
      if (capability === 'proxy.session') {
        const action = choice(text(input.action, 'action', 16), 'action', PROXY_SESSION_ACTIONS);
        if (action === 'start') {
          const origins = list(input.origins, 'origins', (value, label) => normalizeOrigin(text(value, label, 8192)), 1, MAX_ORIGINS);
          return { url: `${origins[0]}/`, method: 'GET', accountId: text(input.accountId, 'accountId', 128), action: 'read' };
        }
        const proxyId = input.proxyId === undefined ? undefined : text(input.proxyId, 'proxyId', 128);
        const found = proxyId === undefined ? undefined : (sessions.get(proxyId) ?? tombstones.get(proxyId));
        const active = found ?? (proxyId === undefined ? [...sessions.values()][0] : undefined);
        invariant(active, 'INVALID_INPUT', 'Unknown or absent capture session');
        return { url: `${active.origins[0] ?? ''}/`, method: 'GET', accountId: active.accountId, action: 'read' };
      }
      invariant(capability === 'proxy.history', 'CAPABILITY_DENIED', 'Not a proxy capability');
      const proxyId = text(input.proxyId, 'proxyId', 128);
      const session = sessions.get(proxyId);
      invariant(session && !session.closed, 'UNAVAILABLE', 'Capture session is not live');
      const action = choice(text(input.action, 'action', 24), 'action', PROXY_HISTORY_ACTIONS);
      if (action === 'repeat') {
        const requestId = text(input.requestId, 'requestId', 64);
        const record = session.store.get(requestId);
        invariant(record, 'INVALID_INPUT', 'Unknown capture record');
        const method = (input.method === undefined ? record.method : text(input.method, 'method', 16)).toUpperCase();
        const url = input.url === undefined ? record.url : text(input.url, 'url', 8192);
        return { url, method, accountId: session.accountId, action: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'mutate' };
      }
      return { url: `${session.origins[0] ?? ''}/`, method: 'GET', accountId: session.accountId, action: 'read' };
    },
    async execute(execution: ProxyPackExecutionInput): Promise<ProxyEvidence> {
      invariant(execution.capability === 'proxy.session' || execution.capability === 'proxy.history', 'CAPABILITY_DENIED', 'Not a proxy capability');
      if (execution.capability === 'proxy.session') {
        if (execution.input.action === 'start') return await creation.create(execution.context, () => sessionAction(execution, execution.input));
        return await sessionAction(execution, execution.input);
      }
      const found = requireOwnership(execution.context, text(execution.input.proxyId, 'proxyId', 128));
      invariant(found.session && !found.session.closed, 'UNAVAILABLE', 'Capture session is closed and cannot be read');
      const pending = historyAction(execution, execution.input);
      found.session.actions.add(pending);
      try { return await pending; } finally { found.session.actions.delete(pending); }
    },
    egressProxy: {
      async start({ gate, budgets, context, accountId, origin }: { gate: EgressGate; budgets: TargetBudget; context: ToolContext; accountId: string; origin: string }): Promise<EgressProxy> {
        invariant(!closed, 'UNAVAILABLE', 'Proxy pack is closed');
        return await creation.create(context, async () => {
        await creation.check(context);
        let session = sessionFor(context);
        if (!session) session = await openCaptureSession(context, accountId, [origin], true, { maxRequests: requestsMax, maxBytes: bytesMax });
        const captureSession = session;
        // The browser gate stays authoritative for browser scope/budgets; the capture session adds its own
        // request/byte budget in front of it and records every unit the browser gate authorizes.
        const decorated: EgressGate = {
          check: async (url, method, resourceType, options) => {
            if (!captureSession.gate.consumeRequest()) return { allowed: false, reason: 'BUDGET_EXCEEDED', detail: 'Capture session budget exhausted' };
            return await gate.check(url, method, resourceType, options);
          },
          checkConnect: async (host, port, signal) => {
            if (!captureSession.gate.consumeRequest()) return { allowed: false, reason: 'BUDGET_EXCEEDED', detail: 'Capture session budget exhausted' };
            return await gate.checkConnect(host, port, signal);
          },
          recordResponse: (requestId, status, bytes, ms) => gate.recordResponse(requestId, status, bytes, ms),
          recordFailed: (requestId, reason) => gate.recordFailed(requestId, reason),
        };
        try {
          const proxy = await startEgressProxy({ gate: fencedGate(context, decorated), budgets, capture: sink(captureSession, 'browser-egress') });
          await trackProxy(captureSession, proxy);
          return proxy;
        } catch (error) { await kill(captureSession, 'start-failed'); throw error; }
        });
      },
    },
    releaseAttempt(context: Pick<ToolContext, 'runId' | 'taskId' | 'attemptId'>): Promise<number> {
      const key = packScopeKey(context);
      let pending = releases.get(key);
      if (!pending) {
        pending = (async () => {
          await creation.seal(context);
          const owned = [...sessions.values()].filter(session => samePackScope(session.context, context));
          await Promise.all(owned.map(session => kill(session, 'attempt-released')));
          return owned.length;
        })();
        releases.set(key, pending);
        void pending.catch(() => { releases.delete(key); });
      }
      return pending;
    },
    outstanding(context: Pick<ToolContext, 'runId' | 'taskId' | 'attemptId'>): number {
      return [...sessions.values()].filter(session => samePackScope(session.context, context)).length;
    },
    close(): Promise<void> {
      closed = true; stopWatchdog();
      closing ??= (async () => {
        await creation.close();
        const results = await Promise.allSettled([...sessions.values()].map(session => kill(session, 'pack-closed')));
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length) throw new Error(`Proxy pack shutdown unverified: ${failures.map(result => String(result.reason)).join('; ')}`);
      })().catch(error => { closing = undefined; throw error; });
      return closing;
    },
    inspect(proxyId: string) {
      const session = sessions.get(proxyId);
      if (!session) return undefined;
      const proxy = [...session.proxies][0];
      if (!proxy) return undefined;
      return {
        port: proxy.port, url: proxy.url, connections: proxy.connections, blocked: proxy.blocked, errors: proxy.errors,
        records: session.store.stored, refused: session.gate.refused, targets: Object.freeze([...session.targets]),
        dns: session.gate.pinnedHosts,
      };
    },
  });
}
