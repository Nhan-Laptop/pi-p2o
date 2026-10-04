import type { Action, BudgetSnapshot, Capability, IsolationMode, PolicyErrorCode, ToolContext } from '../policy/index.js';

export interface Artifact { readonly path: string; readonly sha256: string; readonly bytes: number; readonly mediaType: 'application/json'; readonly redacted: true }
/**
 * Bounded binary artifact (browser screenshots). It lives in the same private artifact root as JSON
 * observations, is digest-addressed, and is explicitly NOT text-redacted — the pack never claims it is.
 */
export interface BinaryArtifact { readonly path: string; readonly sha256: string; readonly bytes: number; readonly mediaType: 'image/png'; readonly redacted: false }
export interface ToolReceipt {
  readonly version: 1;
  readonly context: ToolContext;
  readonly tool: { id: Capability | 'unprovisioned'; version: string; implementationDigest: string };
  readonly scopeDigest: string;
  readonly configurationDigest: string;
  readonly inputDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: 'collected' | 'denied' | 'failed' | 'cancelled';
  readonly errorCode?: PolicyErrorCode;
  readonly targets: readonly string[];
  readonly budgets: Readonly<Record<string, Readonly<BudgetSnapshot>>>;
  readonly artifacts: readonly Artifact[];
  readonly isolation: string;
  readonly classification: 'observation-not-verified-finding';
}
export interface ToolResult { readonly data: unknown; readonly artifact: Artifact; readonly receipt: ToolReceipt }
export interface ExecuteRequest { context: ToolContext; tool: Capability; input: unknown; signal?: AbortSignal }
export interface ToolBroker { execute(request: ExecuteRequest): Promise<ToolResult> }
/**
 * [F3] Attempt-liveness fence for capabilities whose pack owns a host resource (browser / interception
 * sessions). The composition supplies it; the broker consults it before it dispatches a call that can create
 * or drive a pack session, so a session can only exist while the attempt is still live under an open runtime
 * session lease. A fence refusal is a denial reported in the receipt, never a silent skip, and an absent
 * fence means the composition owns no pack that can outlive an attempt.
 */
export interface PackSessionFence {
  check(context: ToolContext, capability: Capability): Promise<void> | void;
}
export interface PreflightReport { readonly ok: boolean; readonly boundary: string; readonly checks: readonly { name: string; ok: boolean; detail: string }[] }
export interface Schema {
  type: 'object' | 'string' | 'integer' | 'array';
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false | Schema;
  items?: Schema;
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}
export interface ToolDescriptor {
  id: Capability;
  version: string;
  implementation: string;
  implementationDigest: string;
  source: string;
  platforms: string[];
  inputSchema: Schema;
  outputSchema: Schema;
  sideEffects: readonly ('read-trusted-input' | 'write-private-artifact' | 'target-request' | 'explicit-mutation' | 'offline-container')[];
  actions: readonly Action[];
  limits: { timeoutMs: number; maxInputBytes: number; maxOutputBytes: number; maxResponseBytes: number; maxFiles: number; maxRedirects: number };
  evidenceCollector: string;
  isolation: readonly IsolationMode[];
}
export interface HttpInput {
  url: string;
  accountId: string;
  method?: string;
  action?: 'read' | 'mutate';
  headers?: Record<string, string>;
  body?: string;
  maxResponseBytes?: number;
  maxRedirects?: number;
}
export interface SourceInput { paths: string[]; contains?: string }
export interface WebInput { url: string; accountId: string }
export interface InventoryInput { urls: string[]; accountId: string }
export interface NativeInput { path: string }
export interface HttpHop {
  url: string;
  status: number;
  method: string;
  accountId: string;
  action: Action;
  pinnedAddress: string;
  dnsAddresses: string[];
  headers: Record<string, string>;
  responseBytes: number;
}
export interface HttpEvidence { kind: 'http'; hops: HttpHop[]; finalUrl: string; status: number; headers: Record<string, string>; body: string; bodySha256: string }
export interface SourceFile { path: string; text: string; sha256: string }
export interface SourceEvidence {
  kind: 'source';
  files: { path: string; sha256: string; bytes: number; lines: number; imports: string[]; exports: string[]; routes: { method: string; path: string; line: number }[]; matches: { line: number; text: string }[]; indicators: { kind: string; line: number }[]; dependencies: Record<string, string> }[];
  limits: string[];
}

/** [B2] Proxy/interception pack evidence: bounded, redacted capture observations and their aggregations. */
export type ProxySource = 'capture-proxy' | 'browser-egress' | 'repeat';
export type ProxyKind = 'http' | 'connect' | 'websocket' | 'repeat';
export interface ProxyBodyEvidence { readonly digest: string; readonly bytes: number; readonly mediaType: string; readonly preview: string; readonly truncated: 'yes' | 'no' }
export interface ProxyEntrySummary {
  readonly seq: number;
  readonly id: string;
  readonly at: string;
  readonly source: ProxySource;
  readonly kind: ProxyKind;
  readonly method: string;
  readonly url: string;
  readonly host: string;
  readonly status: number;
  readonly decision: 'allowed' | 'blocked';
  readonly reason: string;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly ms: number;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly targetId: string;
  readonly replayOf: string;
  readonly pinnedAddress: string;
  readonly truncated: 'yes' | 'no';
}
export interface ProxyEntryDetail extends ProxyEntrySummary {
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly requestBody: ProxyBodyEvidence;
  readonly responseBody: ProxyBodyEvidence;
  readonly dns: readonly string[];
  readonly redirects: readonly string[];
}
export interface ProxyBudgetEvidence { readonly requests: number; readonly requestsMax: number; readonly bytes: number; readonly bytesMax: number }
export interface ProxyIdentityEvidence { readonly mode: 'passthrough-no-mitm'; readonly transport: 'loopback-http-capture-proxy'; readonly mitm: 'none'; readonly implementationDigest: string; readonly identityDigest: string }
export interface ProxySessionEvidence {
  readonly kind: 'proxy-session';
  readonly status: 'open' | 'closed';
  readonly proxyId: string;
  readonly mode: 'passthrough-no-mitm';
  readonly origins: readonly string[];
  readonly budget: ProxyBudgetEvidence;
  readonly identity: ProxyIdentityEvidence;
  readonly isolation: string;
  readonly limits: readonly string[];
  readonly released: 'yes' | 'no';
}
export interface ProxyRepeatEvidence {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly status: number;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly ms: number;
  readonly pinnedAddress: string;
  readonly dns: readonly string[];
  readonly redirects: readonly string[];
  readonly truncated: 'yes' | 'no';
  readonly replayOf: string;
}
export interface ProxySitemapEvidence {
  readonly origins: readonly { readonly origin: string; readonly requests: number; readonly allowed: number; readonly blocked: number; readonly paths: readonly { readonly path: string; readonly requests: number; readonly methods: readonly string[]; readonly lastStatus: number; readonly decision: 'allowed' | 'blocked' | 'mixed' }[] }[];
}
export interface ProxyScopeEvidence {
  readonly allowed: readonly { readonly targetId: string; readonly origins: readonly string[]; readonly pathPrefixes: readonly string[]; readonly methods: readonly string[]; readonly accounts: readonly string[] }[];
  readonly excluded: readonly { readonly origin: string; readonly pathPrefixes: readonly string[] }[];
  readonly decisions: { readonly allowed: number; readonly blocked: number; readonly byReason: readonly { readonly reason: string; readonly count: number }[] };
  readonly pinned: readonly { readonly host: string; readonly addresses: readonly string[] }[];
  readonly budget: ProxyBudgetEvidence;
  readonly refused: 'yes' | 'no';
}
export interface ProxyHistoryEvidence {
  readonly kind: 'proxy-history';
  readonly proxyId: string;
  readonly action: 'list' | 'view' | 'repeat' | 'sitemap' | 'scope_rules';
  readonly status: 'open' | 'closed';
  readonly total: number;
  readonly shown: number;
  readonly refused: 'yes' | 'no';
  readonly entries?: readonly ProxyEntrySummary[];
  readonly entry?: ProxyEntryDetail;
  readonly repeat?: ProxyRepeatEvidence;
  readonly sitemap?: ProxySitemapEvidence;
  readonly scope?: ProxyScopeEvidence;
  readonly limits: readonly string[];
}
export type ProxyEvidence = ProxySessionEvidence | ProxyHistoryEvidence;

// ---------------------------------------------------------------------------------------------
// [B3] Fuzzing pack inputs. `fuzz.differential` runs two local module adapters (or one adapter plus an
// invariant) over seeded byte inputs; `fuzz.template` mutates only the parts an owner-approved template
// declares. Neither type carries a network target, account or credential.
// ---------------------------------------------------------------------------------------------
export type FuzzStrategy = 'bytes' | 'utf8' | 'json' | 'url' | 'header-value' | 'path';
export interface FuzzModulePairSubject { readonly kind: 'module-pair'; readonly moduleA: string; readonly moduleB: string }
export interface FuzzModuleInvariantSubject { readonly kind: 'module-invariant'; readonly module: string }
export type FuzzDifferentialSubject = FuzzModulePairSubject | FuzzModuleInvariantSubject;
export interface FuzzDifferentialInput {
  readonly subject: FuzzDifferentialSubject;
  readonly strategy: FuzzStrategy;
  readonly seed: string;
  readonly cases?: number;
  readonly maxInputBytes?: number;
  readonly timeoutMs?: number;
}
export type FuzzTemplateAxis = 'query' | 'header' | 'body';
export interface FuzzTemplateQuery { readonly name: string; readonly base?: string; readonly tokens: readonly string[]; readonly maxLength: number }
export interface FuzzTemplateHeader { readonly name: string; readonly base: string; readonly tokens: readonly string[]; readonly maxLength: number }
export interface FuzzTemplateBody { readonly base: string; readonly tokens: readonly string[]; readonly maxLength: number }
/** Owner-supplied, pre-approved request template: every mutable part is declared here, nothing else may change. */
export interface ApprovedFuzzTemplate {
  readonly id: string;
  readonly accountId: string;
  readonly method: string;
  readonly url: string;
  readonly query: readonly FuzzTemplateQuery[];
  readonly headers: readonly FuzzTemplateHeader[];
  readonly body?: FuzzTemplateBody;
  readonly maxRequests: number;
  readonly rate: { readonly requests: number; readonly windowMs: number };
  readonly approvedBy: string;
  readonly expiresAt: string;
}
export interface FuzzTemplateInput {
  readonly templateId: string;
  readonly seed: string;
  readonly axes?: readonly FuzzTemplateAxis[];
  readonly cases?: number;
}
