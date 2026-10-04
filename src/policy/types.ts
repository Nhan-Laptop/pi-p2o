export type Action = 'read' | 'mutate' | 'inventory' | 'analyze' | 'native';
export type Capability = 'source.analyze' | 'http.request' | 'web.observe' | 'api.map' | 'service.inventory' | 'native.inspect' | 'browser.session' | 'browser.act' | 'proxy.session' | 'proxy.history' | 'fuzz.differential' | 'fuzz.template';
/**
 * Explicit isolation boundary a capability may be dispatched in. `host-browser` means exactly what it
 * says: a real browser process on the host with scope enforced by policy + CDP interception + a pinned
 * egress proxy. It is NOT container isolation and must never be reported as such.
 */
export type IsolationMode = 'local-fixture' | 'container' | 'host-browser';
export type Role = 'orchestrator' | 'worker' | 'verifier' | 'reporter';

export interface TargetLimits {
  maxRequests: number;
  maxBytes: number;
  maxConcurrent: number;
  rate: { requests: number; windowMs: number };
}
export interface WebTarget {
  id: string;
  origins: string[];
  pathPrefixes: string[];
  allowedCidrs: string[];
  excludedCidrs?: string[];
  methods: string[];
  actions: Action[];
  accounts: string[];
  limits: TargetLimits;
}
export interface Exclusion { origin: string; pathPrefixes: string[] }
export interface ApprovedAccount {
  id: string;
  targetIds: string[];
  actions: Action[];
  expiresAt: string;
  /** No credential material belongs in a scope. Credential providers live in the supervisor. */
  kind: 'anonymous' | 'credential';
}
export interface CapabilityGrant {
  id: string;
  taskId: string;
  attemptId: string;
  role: Role;
  capabilities: Capability[];
  targetIds: string[];
  actions: Action[];
  accountIds: string[];
  expiresAt: string;
  maxCalls: number;
  maxArtifactBytes: number;
}
export interface Scope {
  version: 1;
  runId: string;
  authorization: { reference: string; approvedBy: string; expiresAt: string; notBefore?: string };
  targets: WebTarget[];
  exclusions: Exclusion[];
  accounts: ApprovedAccount[];
  grants: CapabilityGrant[];
}
/** This identity must be supplied by trusted orchestration, never taken from tool JSON. */
export interface ToolContext { runId: string; taskId: string; attemptId: string; grantId: string }
export interface AuthorizationRequest {
  context: ToolContext;
  capability: Capability;
  action: Action;
  url?: string;
  method?: string;
  accountId?: string;
}
export interface NormalizedWebTarget {
  url: string;
  origin: string;
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  path: string;
}
export interface Decision {
  readonly scopeDigest: string;
  readonly grant: Readonly<CapabilityGrant>;
  readonly target?: Readonly<WebTarget>;
  readonly account?: Readonly<ApprovedAccount>;
  readonly normalized?: NormalizedWebTarget;
  readonly action: Action;
  readonly capability: Capability;
}
export interface Policy {
  readonly scope: Readonly<Scope>;
  readonly digest: string;
  authorize(request: AuthorizationRequest): Decision;
  authorizeAddress(decision: Decision, address: string): string;
  assertActive(context: ToolContext): Readonly<CapabilityGrant>;
}
