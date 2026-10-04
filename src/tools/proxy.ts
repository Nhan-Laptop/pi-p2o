/**
 * [B2] Proxy / interception pack public surface: capture-session and capture-history capabilities.
 *
 * The worker-visible handle is `proxyId` (never a key containing "session"): the evidence redactor treats
 * such keys as credentials and would replace the handle with `[REDACTED]`. The capture listener's port is
 * never exposed — clients reach it only through the packs that own it, and repeats are issued by the pack.
 */
export { createProxyPack, PROXY_SESSION_ACTIONS, PROXY_HISTORY_ACTIONS } from './proxy/pack.js';
export type { ProxyPack, ProxyPackOptions, ProxyPackExecutionInput, ProxySessionAction, ProxyHistoryAction } from './proxy/pack.js';
export { CaptureStore } from './proxy/store.js';
export { CaptureGate } from './proxy/gate.js';
export { proxyIdentity, PROXY_CAPTURE_MODE, PROXY_TRANSPORT } from './proxy/identity.js';

export interface ProxySessionInput {
  readonly action: 'start' | 'stop' | 'status';
  readonly proxyId?: string;
  readonly accountId?: string;
  readonly origins?: readonly string[];
  readonly maxRequests?: number;
  readonly maxBytes?: number;
  readonly ttlMs?: number;
}
export interface ProxyHistoryInput {
  readonly action: 'list' | 'view' | 'repeat' | 'sitemap' | 'scope_rules';
  readonly proxyId: string;
  readonly requestId?: string;
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly maxResponseBytes?: number;
  readonly limit?: number;
  readonly page?: number;
  readonly filter?: 'all' | 'allowed' | 'blocked';
  readonly query?: string;
}
export type ProxyInput = ProxySessionInput | ProxyHistoryInput;
