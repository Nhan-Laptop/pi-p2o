import { isIP } from 'node:net';
import { checkCancelled, invariant, PolicyError, type PolicyErrorCode } from '../policy/errors.js';
import { normalizeAddress, stableAddressSet } from '../policy/network.js';
import type { Action, Capability, Policy, ToolContext } from '../policy/index.js';
import { abortable, type DnsResolver } from './http.js';
import type { ExecutionSandbox } from './sandbox.js';

/** One bounded egress observation. `decision` is the policy verdict, not the server's. */
export interface NetworkEntry {
  readonly seq: number;
  readonly at: string;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly decision: 'allowed' | 'blocked';
  readonly reason?: string;
  readonly status?: number;
  readonly bytes?: number;
  readonly ms?: number;
  readonly redirects?: readonly string[];
  readonly targetId?: string;
}
export type GateCheck =
  | { readonly allowed: true; readonly targetId: string; readonly action: Action; readonly url: string; readonly addresses: readonly string[] }
  | { readonly allowed: false; readonly reason: PolicyErrorCode; readonly detail: string };
export interface BrowserGateOptions {
  policy: Policy;
  sandbox: ExecutionSandbox;
  context: ToolContext;
  accountId: string;
  resolver: DnsResolver;
  capability: Capability;
  maxEntries?: number;
  maxBlockedRequests?: number;
  maxDnsHosts?: number;
}
interface MutableEntry {
  seq: number; at: string; method: string; url: string; resourceType: string;
  decision: 'allowed' | 'blocked'; reason?: string; status?: number; bytes?: number; ms?: number;
  redirects?: string[]; targetId?: string;
}

/** ws/wss are authorized as their http/https origin: the scope model has no separate WS authority. */
export function normalizeBrowserUrl(value: string): { policyUrl: string; requestUrl: string } {
  if (/^wss:\/\//i.test(value)) return { policyUrl: `https://${value.slice(6)}`, requestUrl: value };
  if (/^ws:\/\//i.test(value)) return { policyUrl: `http://${value.slice(5)}`, requestUrl: value };
  return { policyUrl: value, requestUrl: value };
}
const errorCode = (error: unknown): PolicyErrorCode => error instanceof PolicyError ? error.code : 'UNAVAILABLE';

/**
 * The single scope gate for everything a browser session tries to do. It is called by the CDP Fetch
 * interceptor before a request is continued, and by the egress proxy before a socket is opened, so a
 * non-scope request is denied before it can leave the host no matter which path it takes (subresource,
 * XHR, redirect hop, websocket upgrade, or a page-level navigation).
 */
export class BrowserRequestGate {
  private readonly options: BrowserGateOptions;
  private readonly entries: MutableEntry[] = [];
  private readonly byId = new Map<string, MutableEntry>();
  private readonly pinned = new Map<string, string[]>();
  private blockedRequests = 0;
  private dropped = 0;
  private allowedRequests = 0;
  private sequence = 0;
  private requestsUsed = 0;
  private budgetExhausted = false;
  /** Set by the manager before each capability call; every request of a grant shares the session. */
  private capability: Capability;
  constructor(options: BrowserGateOptions) { this.options = options; this.capability = options.capability; }
  useCapability(capability: Capability): void { this.capability = capability; }
  get refused(): boolean { return this.budgetExhausted; }
  get requestCount(): number { return this.requestsUsed; }
  get blockedCount(): number { return this.blockedRequests; }
  /** Target ids the policy actually authorized during this session (receipt attribution). */
  readonly touched = new Set<string>();
  get allowedCount(): number { return this.allowedRequests; }

  private createEntry(requestId: string, seed: { method: string; url: string; resourceType: string }): MutableEntry {
    const existing = this.byId.get(requestId);
    let entry = existing;
    if (!entry) {
      entry = {
        seq: ++this.sequence, at: new Date().toISOString(),
        method: seed.method, url: seed.url, resourceType: seed.resourceType,
        decision: 'allowed',
      };
      this.byId.set(requestId, entry);
      const maxEntries = this.options.maxEntries ?? 512;
      if (this.entries.length >= maxEntries) { this.entries.shift(); this.dropped += 1; }
      this.entries.push(entry);
    }
    return entry;
  }
  private static freeze(entry: MutableEntry): NetworkEntry {
    return Object.freeze({
      seq: entry.seq, at: entry.at, method: entry.method, url: entry.url, resourceType: entry.resourceType, decision: entry.decision,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(entry.status === undefined ? {} : { status: entry.status }),
      ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
      ...(entry.ms === undefined ? {} : { ms: entry.ms }),
      ...(entry.redirects === undefined ? {} : { redirects: Object.freeze([...entry.redirects]) }),
      ...(entry.targetId === undefined ? {} : { targetId: entry.targetId }),
    });
  }
  summary(limit = 24): { entries: readonly NetworkEntry[]; total: number; allowed: number; blocked: number; dropped: number; refused: boolean } {
    const bounded = Math.max(1, Math.min(limit, 128));
    return Object.freeze({
      entries: Object.freeze(this.entries.slice(-bounded).map(BrowserRequestGate.freeze)),
      total: this.entries.length + this.dropped, allowed: this.allowedRequests, blocked: this.blockedRequests,
      dropped: this.dropped, refused: this.budgetExhausted,
    });
  }
  /** Full bounded log for controller-side diagnostics/tests; never returned to a worker unbounded. */
  inspect(limit = 512): readonly NetworkEntry[] { return Object.freeze(this.entries.slice(-limit).map(BrowserRequestGate.freeze)); }
  inspectBlocked(limit = 64): readonly NetworkEntry[] { return Object.freeze(this.entries.filter(e => e.decision === 'blocked').slice(-limit).map(BrowserRequestGate.freeze)); }

  // Entries are created exactly once, by `check` (the decision point). Network telemetry only updates an
  // existing entry, so every logged request carries a real gate decision and an undecided race can never
  // be misread as allowed traffic.
  private update(requestId: string, mutate: (entry: MutableEntry) => void): void {
    const entry = this.byId.get(requestId);
    if (entry) mutate(entry);
  }
  recordRequestStarted(requestId: string, seed: { method: string; url: string; resourceType: string }): void {
    this.update(requestId, entry => { entry.method = seed.method; entry.url = seed.url; entry.resourceType = seed.resourceType; });
  }
  recordRedirect(requestId: string, url: string, status: number): void {
    this.update(requestId, entry => {
      const redirects = entry.redirects ?? [];
      if (redirects.length < 8) redirects.push(`${status} ${url.slice(0, 512)}`);
      entry.redirects = redirects;
      entry.url = url;
    });
  }
  recordResponse(requestId: string, status: number, bytes?: number, ms?: number): void {
    this.update(requestId, entry => {
      entry.status = status;
      if (bytes !== undefined) entry.bytes = bytes;
      if (ms !== undefined) entry.ms = ms;
    });
  }
  recordFinished(requestId: string, bytes?: number, ms?: number): void {
    this.update(requestId, entry => {
      if (bytes !== undefined) entry.bytes = bytes;
      if (ms !== undefined) entry.ms = ms;
    });
  }
  recordFailed(requestId: string, reason: string): void {
    this.update(requestId, entry => { if (entry.decision === 'allowed') entry.reason = reason.slice(0, 64); });
  }
  recordBlocked(requestId: string, reason: string, url?: string, resourceType?: string): void {
    this.update(requestId, entry => {
      entry.decision = 'blocked';
      entry.reason = reason.slice(0, 64);
      if (url !== undefined) entry.url = url;
      if (resourceType !== undefined) entry.resourceType = resourceType;
    });
  }

  /** Count one in-scope request against the per-session request budget. */
  private consumeRequestBudget(): boolean {
    const max = this.options.sandbox.browser?.maxRequestsPerSession ?? 0;
    if (max <= 0) { this.budgetExhausted = true; return false; }
    if (this.requestsUsed >= max) { this.budgetExhausted = true; return false; }
    this.requestsUsed += 1;
    return true;
  }

  private async resolvePinned(hostname: string, signal?: AbortSignal): Promise<string[]> {
    if (isIP(hostname) !== 0) return [normalizeAddress(hostname)];
    const answers = await abortable(this.options.resolver(hostname, signal), signal);
    checkCancelled(signal);
    const addresses = stableAddressSet(answers);
    const pinned = this.pinned.get(hostname);
    if (pinned && pinned.join(',') !== addresses.join(',')) throw new PolicyError('DNS_CHANGED', 'DNS answers changed during the browser session');
    if (!pinned) {
      invariant(this.pinned.size < (this.options.maxDnsHosts ?? 64), 'OUTPUT_LIMIT', 'Too many distinct hosts in one browser session');
      this.pinned.set(hostname, addresses);
    }
    return addresses;
  }

  private markBlocked(): void {
    this.blockedRequests += 1;
    // A page that keeps hammering non-scope destinations is bounded, then the session refuses further actions.
    if (this.blockedRequests >= (this.options.maxBlockedRequests ?? 512)) this.budgetExhausted = true;
  }
  /** Full authorization used both before dispatch and by every intercepted request. */
  private async decide(policyUrl: string, method: string, signal?: AbortSignal): Promise<{ allowed: true; targetId: string; action: Action; url: string; addresses: string[] } | { allowed: false; reason: PolicyErrorCode; detail: string }> {
    const action: Action = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'mutate';
    try {
      const decision = this.options.policy.authorize({ context: this.options.context, capability: this.capability, action, url: policyUrl, method, accountId: this.options.accountId });
      invariant(decision.target && decision.normalized && decision.account, 'TARGET_DENIED', 'Browser request has no approved target');
      // Broker-held credentials are never injected into a page; only anonymous approved accounts are allowed here.
      invariant(decision.account.kind === 'anonymous', 'ACCOUNT_DENIED', 'Browser sessions support anonymous approved accounts only');
      const addresses = await this.resolvePinned(decision.normalized.hostname, signal);
      for (const address of addresses) {
        this.options.policy.authorizeAddress(decision, address);
        this.options.sandbox.assertEgress(address);
      }
      this.touched.add(decision.target.id);
      return { allowed: true, targetId: decision.target.id, action, url: decision.normalized.url, addresses };
    } catch (error) {
      return { allowed: false, reason: errorCode(error), detail: error instanceof PolicyError ? error.message : 'Request denied' };
    }
  }

  /**
   * Authorize one intercepted request. `count`/`record` distinguish the counted, logged Fetch-path check
   * from a pre-dispatch probe for the same navigation.
   */
  async check(url: string, method: string, resourceType: string, options: { requestId?: string; count?: boolean; record?: boolean; signal?: AbortSignal } = {}): Promise<GateCheck> {
    const requestId = options.requestId ?? `p2o-${++this.sequence}`;
    const { policyUrl, requestUrl } = normalizeBrowserUrl(url);
    const counted = options.count !== false;
    const recorded = options.record !== false;
    if (recorded) this.createEntry(requestId, { method, url: requestUrl, resourceType });
    if (!/^https?:\/\//i.test(policyUrl)) {
      this.markBlocked();
      if (recorded) this.recordBlocked(requestId, 'TARGET_DENIED', requestUrl, resourceType);
      return { allowed: false, reason: 'TARGET_DENIED', detail: 'Only http(s)/ws(s) requests can leave the browser' };
    }
    const result = await this.decide(policyUrl, method, options.signal);
    if (!result.allowed) {
      this.markBlocked();
      if (recorded) this.recordBlocked(requestId, result.reason, requestUrl, resourceType);
      return result;
    }
    // Budgets are only charged for in-scope, authorized requests: Chrome's own background chatter is
    // denied by policy above and must never consume the target's request budget.
    if (counted && !this.consumeRequestBudget()) {
      this.markBlocked();
      if (recorded) this.recordBlocked(requestId, 'BUDGET_EXCEEDED', requestUrl, resourceType);
      return { allowed: false, reason: 'BUDGET_EXCEEDED', detail: 'Session request budget exhausted' };
    }
    if (counted) this.allowedRequests += 1;
    if (recorded) {
      this.update(requestId, entry => { entry.targetId = result.targetId; entry.url = requestUrl; });
    }
    return { allowed: true, targetId: result.targetId, action: result.action, url: result.url, addresses: result.addresses };
  }

  /** CONNECT-level check used by the egress proxy; the same origin/path/DNS rules apply. */
  async checkConnect(host: string, port: number, signal?: AbortSignal): Promise<GateCheck> {
    invariant(/^[a-z0-9.-]+$/i.test(host) && Number.isInteger(port) && port > 0 && port <= 65535, 'TARGET_DENIED', 'Invalid CONNECT authority');
    const suffix = port === 443 ? '' : `:${port}`;
    return await this.check(`https://${host}${suffix}/`, 'GET', 'CONNECT', { count: false, record: true, signal });
  }
  /** Pre-dispatch authorization probe: same rules, no budget charge, no log entry (the Fetch pass logs). */
  async probe(url: string, method = 'GET', signal?: AbortSignal): Promise<GateCheck> {
    const { policyUrl } = normalizeBrowserUrl(url);
    if (!/^https?:\/\//i.test(policyUrl)) return { allowed: false, reason: 'TARGET_DENIED', detail: 'Only http(s) destinations can be navigated to' };
    return await this.check(url, method, 'Navigation', { count: false, record: false, signal });
  }
}
