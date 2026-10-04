import { isIP } from 'node:net';
import { invariant, PolicyError, type PolicyErrorCode } from '../../policy/errors.js';
import { normalizeAddress, stableAddressSet } from '../../policy/network.js';
import { abortable, type DnsResolver } from '../http.js';
import type { Action, Capability, Policy, ToolContext } from '../../policy/index.js';
import type { GateCheck } from '../browser-gate.js';
import type { EgressGate } from '../browser-proxy.js';
import type { ProxyScopeEvidence } from '../types.js';
import type { ExecutionSandbox } from '../sandbox.js';

export interface CaptureGateLimits { readonly maxRequests: number; readonly maxBytes: number }
export interface CaptureGateOptions {
  readonly policy: Policy;
  readonly sandbox: ExecutionSandbox;
  readonly context: ToolContext;
  readonly accountId: string;
  readonly capability: Capability;
  readonly resolver: DnsResolver;
  readonly limits: CaptureGateLimits;
  readonly maxDnsHosts?: number;
  readonly maxBlockedRequests?: number;
}
const errorCode = (error: unknown): PolicyErrorCode => (error instanceof PolicyError ? error.code : 'UNAVAILABLE');

/**
 * Connection-time scope gate for a capture session: the same authorization path as the browser gate
 * (canonical URL → target/path/exclusion → method/action → account → DNS pin → per-address CIDR and egress
 * policy) plus an explicit per-session request/byte budget. It is used by the standalone capture proxy and as
 * a decorator in front of the browser pack's CDP gate, so both channels refuse out-of-scope destinations
 * before any socket is dialed.
 */
export class CaptureGate implements EgressGate {
  private readonly options: CaptureGateOptions;
  private readonly pinned = new Map<string, string[]>();
  private readonly blockedReasons = new Map<string, number>();
  private requestsUsed = 0;
  private bytesUsed = 0;
  private blockedRequests = 0;
  private exhausted = false;
  private capability: Capability;

  constructor(options: CaptureGateOptions) { this.options = options; this.capability = options.capability; }

  useCapability(capability: Capability): void { this.capability = capability; }
  get refused(): boolean { return this.exhausted; }
  get requestCount(): number { return this.requestsUsed; }
  get byteCount(): number { return this.bytesUsed; }
  get blockedCount(): number { return this.blockedRequests; }
  get pinnedHosts(): readonly { host: string; addresses: readonly string[] }[] {
    return Object.freeze([...this.pinned.entries()].slice(0, 64).map(([host, addresses]) => Object.freeze({ host, addresses: Object.freeze([...addresses]) })));
  }
  /** Charge observed request+response bytes; exceeding the session byte budget refuses the next unit. */
  chargeBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.bytesUsed += Math.trunc(bytes);
    if (this.bytesUsed > this.options.limits.maxBytes) this.exhausted = true;
  }
  /** Charge one unit before it is dialed; false means the session budget is exhausted. */
  consumeRequest(): boolean {
    if (this.exhausted || this.requestsUsed >= this.options.limits.maxRequests) { this.exhausted = true; return false; }
    this.requestsUsed += 1;
    return true;
  }
  recordResponse(_requestId: string, _status: number, _bytes?: number, _ms?: number): void { /* the capture sink owns the per-unit record */ }
  recordFailed(_requestId: string, _reason: string): void { /* the capture sink owns the per-unit record */ }

  private markBlocked(reason: string): void {
    this.blockedRequests += 1;
    this.blockedReasons.set(reason, (this.blockedReasons.get(reason) ?? 0) + 1);
    if (this.blockedRequests >= (this.options.maxBlockedRequests ?? 256)) this.exhausted = true;
  }
  private async resolvePinned(hostname: string, signal?: AbortSignal): Promise<string[]> {
    if (isIP(hostname) !== 0) {
      // A literal address is its own pin: recording it makes `scope_rules` show the exact endpoint set
      // the session connected to, without pretending a name was resolved.
      const literal = normalizeAddress(hostname);
      if (!this.pinned.has(hostname) && this.pinned.size < (this.options.maxDnsHosts ?? 64)) this.pinned.set(hostname, [literal]);
      return [literal];
    }
    const answers = await abortable(this.options.resolver(hostname, signal), signal);
    const addresses = stableAddressSet(answers);
    const pinned = this.pinned.get(hostname);
    if (pinned && pinned.join(',') !== addresses.join(',')) throw new PolicyError('DNS_CHANGED', 'DNS answers changed during the capture session');
    if (!pinned) {
      invariant(this.pinned.size < (this.options.maxDnsHosts ?? 64), 'OUTPUT_LIMIT', 'Too many distinct hosts in one capture session');
      this.pinned.set(hostname, addresses);
    }
    return addresses;
  }

  private async decide(url: string, method: string, signal?: AbortSignal): Promise<{ allowed: true; targetId: string; action: Action; url: string; addresses: string[] } | { allowed: false; reason: PolicyErrorCode; detail: string }> {
    const action: Action = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'mutate';
    try {
      const decision = this.options.policy.authorize({ context: this.options.context, capability: this.capability, action, url, method, accountId: this.options.accountId });
      invariant(decision.target && decision.normalized && decision.account, 'TARGET_DENIED', 'Capture request has no approved target');
      // Broker-held credentials are never injected by an interception proxy; only anonymous approved accounts.
      invariant(decision.account.kind === 'anonymous', 'ACCOUNT_DENIED', 'Capture sessions support anonymous approved accounts only');
      const addresses = await this.resolvePinned(decision.normalized.hostname, signal);
      for (const address of addresses) {
        this.options.policy.authorizeAddress(decision, address);
        this.options.sandbox.assertEgress(address);
      }
      return { allowed: true, targetId: decision.target.id, action, url: decision.normalized.url, addresses };
    } catch (error) {
      return { allowed: false, reason: errorCode(error), detail: error instanceof PolicyError ? error.message : 'Request denied' };
    }
  }

  async check(url: string, method: string, _resourceType: string, options: { requestId?: string; count?: boolean; record?: boolean; signal?: AbortSignal } = {}): Promise<GateCheck> {
    void _resourceType; void options.record; void options.requestId;
    if (this.exhausted) { this.markBlocked('BUDGET_EXCEEDED'); return { allowed: false, reason: 'BUDGET_EXCEEDED', detail: 'Capture session budget exhausted' }; }
    const upper = method.toUpperCase();
    if (!/^https?:\/\//i.test(url)) { this.markBlocked('TARGET_DENIED'); return { allowed: false, reason: 'TARGET_DENIED', detail: 'Only http(s) destinations can be captured' }; }
    const counted = options.count !== false;
    if (counted && this.requestsUsed >= this.options.limits.maxRequests) {
      this.exhausted = true; this.markBlocked('BUDGET_EXCEEDED');
      return { allowed: false, reason: 'BUDGET_EXCEEDED', detail: 'Capture session request budget exhausted' };
    }
    const result = await this.decide(url, upper, options.signal);
    if (!result.allowed) { this.markBlocked(result.reason); return result; }
    if (counted) this.requestsUsed += 1;
    return result;
  }

  /** CONNECT is authorized as its https origin; per-path enforcement is impossible without MITM. */
  async checkConnect(host: string, port: number, signal?: AbortSignal): Promise<GateCheck> {
    invariant(/^[a-z0-9.-]+$/i.test(host) && Number.isInteger(port) && port > 0 && port <= 65535, 'TARGET_DENIED', 'Invalid CONNECT authority');
    const suffix = port === 443 ? '' : `:${port}`;
    return await this.check(`https://${host}${suffix}/`, 'GET', 'CONNECT', { count: true, signal });
  }

  /** Explicit, worker-readable scope decisions for this session (nothing here is a host path or secret). */
  describe(): ProxyScopeEvidence {
    const grant = this.options.policy.assertActive(this.options.context);
    const scope = this.options.policy.scope;
    return Object.freeze({
      allowed: Object.freeze(scope.targets
        .filter(target => grant.targetIds.includes(target.id))
        .map(target => Object.freeze({
          targetId: target.id, origins: Object.freeze([...target.origins]), pathPrefixes: Object.freeze([...target.pathPrefixes]),
          methods: Object.freeze([...target.methods]), accounts: Object.freeze(target.accounts.filter(id => grant.accountIds.includes(id))),
        }))),
      excluded: Object.freeze(scope.exclusions.map(exclusion => Object.freeze({ origin: exclusion.origin, pathPrefixes: Object.freeze([...exclusion.pathPrefixes]) }))),
      decisions: Object.freeze({ allowed: this.requestsUsed, blocked: this.blockedRequests, byReason: Object.freeze([...this.blockedReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 32).map(([reason, count]) => Object.freeze({ reason, count }))) }),
      pinned: this.pinnedHosts,
      budget: Object.freeze({ requests: this.requestsUsed, requestsMax: this.options.limits.maxRequests, bytes: this.bytesUsed, bytesMax: this.options.limits.maxBytes }),
      refused: this.exhausted ? 'yes' : 'no',
    });
  }
}
