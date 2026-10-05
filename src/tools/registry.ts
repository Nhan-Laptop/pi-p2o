import { readFileSync } from 'node:fs';
import { invariant } from '../policy/errors.js';
import { CAPABILITIES } from '../policy/scope.js';
import { deepFreeze, digest, integer } from '../policy/validation.js';
import type { Action, Capability, IsolationMode } from '../policy/types.js';
import type { TargetBudget } from '../policy/budget.js';
import type { ExecutionSandbox } from './sandbox.js';
import type { PreflightReport, Schema, ToolDescriptor } from './types.js';
import { validateSchema } from './schema.js';
import { sha256 } from './redaction.js';
import { BROWSER_ACT_ACTIONS, BROWSER_SESSION_ACTIONS } from './browser-session.js';
import { PROXY_HISTORY_ACTIONS, PROXY_SESSION_ACTIONS } from './proxy.js';
import { FUZZ_STRATEGIES } from './fuzz/generator.js';
import { FUZZ_TEMPLATE_AXES, FUZZ_TEMPLATE_METHODS } from './fuzz/template.js';
const string = (maxLength = 8192, values?: readonly string[]): Schema => ({ type: 'string', maxLength, ...(values ? { enum: values } : {}) });
const number = (maximum = Number.MAX_SAFE_INTEGER): Schema => ({ type: 'integer', minimum: 0, maximum });
const array = (items: Schema, maxItems = 256, minItems = 0): Schema => ({ type: 'array', items, maxItems, minItems });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const map = (maxLength = 8192): Schema => ({ type: 'object', additionalProperties: string(maxLength) });
const scopeDecision = string(32, ['allowed', 'blocked']);
const httpSchema = object({ kind: string(16, ['http']), hops: array(object({ url: string(), status: number(599), method: string(16), accountId: string(128), action: string(16, ['read', 'mutate', 'inventory']), pinnedAddress: string(64), dnsAddresses: array(string(64), 32, 1), headers: map(16384), responseBytes: number() }), 5, 1), finalUrl: string(), status: number(599), headers: map(16384), body: string(1048576), bodySha256: string(64) });
const sourceSchema = object({ kind: string(16, ['source']), files: array(object({ path: string(4096), sha256: string(64), bytes: number(), lines: number(), imports: array(string(256), 128), exports: array(string(512), 128), routes: array(object({ method: string(16), path: string(512), line: number() }), 128), matches: array(object({ line: number(), text: string(512) }), 128), indicators: array(object({ kind: string(128), line: number() }), 129), dependencies: map(256) }), 64, 1), limits: array(string(512), 16) });
const webSchema = object({ kind: string(16, ['web']), http: httpSchema, title: string(512), links: array(object({ url: string(), scopeDecision }), 128), forms: array(object({ url: string(), method: string(16), scopeDecision }), 64), limits: array(string(512), 16) });
const apiSchema = object({ kind: string(16, ['api']), http: httpSchema, format: string(32, ['openapi-json', 'json-observation', 'non-json-observation']), operations: array(object({ method: string(16), path: string(1024), url: string(), scopeDecision: string(32, ['allowed', 'blocked', 'template-not-expanded']) }), 256), keys: array(string(8192), 128), limits: array(string(512), 16) });
const nativeSchema = object({ kind: string(16, ['native']), path: string(4096), sha256: string(64), bytes: number(), format: string(32, ['elf', 'pe', 'wasm', 'unknown']), architecture: string(64), strings: array(string(256), 128), limits: array(string(512), 16) });
// [B3] Fuzzing pack evidence. Differential evidence carries the recorded seed, the minimized reproducer and
// both normalized outcomes; template evidence carries only declared mutation axes with outcome classifications.
const fuzzOutcomeSchema = object({ kind: string(24, ['accept', 'reject', 'oversize', 'invariant-violation']), value: string(8192), name: string(128), detail: string(512) }, ['kind']);
const fuzzSubjectSchema = object({ role: string(16, ['module-a', 'module-b']), path: string(4096), outcome: fuzzOutcomeSchema, digest: string(64) });
const fuzzDifferentialSchema = object({
  kind: string(24, ['fuzz-differential']),
  subject: object({ kind: string(24, ['module-pair', 'module-invariant']), modules: array(object({ role: string(16, ['module-a', 'module-b']), path: string(4096), sha256: string(64) }), 2, 1) }),
  strategy: string(16, FUZZ_STRATEGIES), seed: string(64), casesMax: number(4096), casesRun: number(4096),
  outcome: string(24, ['no-divergence', 'divergence']),
  divergence: object({
    foundAtCase: number(4096),
    reproducer: object({ hex: string(131072), preview: string(4096), bytes: number(65536), sha256: string(64) }),
    initial: object({ bytes: number(65536), sha256: string(64) }),
    shrinkSteps: number(1048576), subjectA: fuzzSubjectSchema, subjectB: fuzzSubjectSchema, digest: string(64),
  }),
  budget: object({ deadlineMs: number(3600000), spentMs: number(3600000), maxInputBytes: number(65536), maxOutcomeBytes: number(65536) }),
  isolation: string(512), limits: array(string(1024), 16),
}, ['kind', 'subject', 'strategy', 'seed', 'casesMax', 'casesRun', 'outcome', 'budget', 'isolation', 'limits']);
const fuzzTemplateSchema = object({
  kind: string(24, ['fuzz-template']),
  templateId: string(128), method: string(16, FUZZ_TEMPLATE_METHODS), accountId: string(128), url: string(8192),
  seed: string(64), casesMax: number(64), casesRun: number(64),
  baseline: object({ status: number(599), bytes: number(), bodySha256: string(64) }),
  observations: array(object({
    case: number(64), axis: string(16, FUZZ_TEMPLATE_AXES), name: string(128), value: string(256), valueSha256: string(64),
    url: string(8192), status: number(599), bytes: number(), bodySha256: string(64),
    classification: string(32, ['same', 'status-diff', 'digest-diff', 'structure-diff', 'length-diff', 'error']), detail: string(512), responseFingerprint: string(64),
  }), 64),
  classifications: array(object({ name: string(32, ['same', 'status-diff', 'digest-diff', 'structure-diff', 'length-diff', 'error']), count: number(64) }), 8),
  stopped: string(16, ['completed', 'deadline', 'request-cap', 'rate-limit']),
  budget: object({ deadlineMs: number(3600000), spentMs: number(3600000), attemptsUsed: number(256), requestsMax: number(256) }),
  isolation: string(512), limits: array(string(1024), 16),
});
const browserChromeSchema = object({ version: string(64), product: string(128), binarySha256: string(64), identityDigest: string(64) });
const browserBudgetSchema = object({ actions: number(), actionsMax: number(), requests: number(), requestsMax: number() });
const browserNetworkEntrySchema = object({ seq: number(), at: string(40), method: string(16), url: string(8192), resourceType: string(32), decision: string(16, ['allowed', 'blocked']), reason: string(64), status: number(599), bytes: number(), ms: number(), redirects: array(string(600), 8), targetId: string(64) }, ['seq', 'at', 'method', 'url', 'resourceType', 'decision']);
const browserNetworkSchema = object({ entries: array(browserNetworkEntrySchema, 128), total: number(), allowed: number(), blocked: number(), dropped: number(), refused: string(8, ['yes', 'no']) });
const browserDomSchema = object({ digest: string(64), bytes: number(), truncated: string(8, ['yes', 'no']) });
const browserSessionSchema = object({
  kind: string(24, ['browser-session']), status: string(16, ['open', 'closed']), browserId: string(128), origin: string(8192), url: string(8192), title: string(512),
  chrome: browserChromeSchema, budget: browserBudgetSchema, isolation: string(512), limits: array(string(1024), 16),
});
const browserActSchema = object({
  kind: string(24, ['browser-action']), browserId: string(128), action: string(16, BROWSER_ACT_ACTIONS), url: string(8192), title: string(512),
  dom: browserDomSchema, network: browserNetworkSchema, budget: browserBudgetSchema, changed: string(8, ['yes', 'no']),
  refs: array(object({ ref: string(16), role: string(64), name: string(16384) }), 256),
  snapshot: object({ digest: string(64), lines: number(), text: string(16384) }),
  extraction: object({ mediaType: string(32, ['text/plain', 'text/html']), text: string(131072), bytes: number(), truncated: string(8, ['yes', 'no']) }),
  screenshot: object({ path: string(4096), sha256: string(64), bytes: number(), mediaType: string(32, ['image/png']) }),
  tabs: array(object({ index: number(), url: string(8192), title: string(512), active: string(8, ['yes', 'no']) }), 16),
  limits: array(string(1024), 16),
}, ['kind', 'browserId', 'action', 'url', 'title', 'dom', 'network', 'budget', 'limits']);
// [B2] Proxy capture/history evidence. Bodies are digest-addressed with bounded text previews, and the
// capture store redacts sensitive headers before the broker's redactor runs a second pass.
const proxyBodySchema = object({ digest: string(64), bytes: number(), mediaType: string(128), preview: string(4096), truncated: string(8, ['yes', 'no']) });
const proxyEntryProperties = {
  seq: number(), id: string(64), at: string(40), source: string(24, ['capture-proxy', 'browser-egress', 'repeat']),
  kind: string(16, ['http', 'connect', 'websocket', 'repeat']), method: string(16), url: string(8192), host: string(256),
  status: number(599), decision: string(16, ['allowed', 'blocked']), reason: string(64),
  requestBytes: number(), responseBytes: number(), ms: number(), requestDigest: string(64), responseDigest: string(64),
  targetId: string(128), replayOf: string(64), pinnedAddress: string(64), truncated: string(8, ['yes', 'no']),
};
const proxyEntrySchema = object(proxyEntryProperties);
const proxyEntryDetailSchema = object({ ...proxyEntryProperties, requestHeaders: map(512), responseHeaders: map(512), requestBody: proxyBodySchema, responseBody: proxyBodySchema, dns: array(string(64), 32), redirects: array(string(600), 8) });
const proxyIdentitySchema = object({ mode: string(32, ['passthrough-no-mitm']), transport: string(48, ['loopback-http-capture-proxy']), mitm: string(8, ['none']), implementationDigest: string(64), identityDigest: string(64) });
const proxyBudgetSchema = object({ requests: number(), requestsMax: number(), bytes: number(), bytesMax: number() });
const proxySessionSchema = object({ kind: string(24, ['proxy-session']), status: string(16, ['open', 'closed']), proxyId: string(128), mode: string(32, ['passthrough-no-mitm']), origins: array(string(8192), 8, 1), budget: proxyBudgetSchema, identity: proxyIdentitySchema, isolation: string(512), limits: array(string(1024), 16), released: string(8, ['yes', 'no']) });
const proxyRepeatSchema = object({ id: string(64), url: string(8192), method: string(16), status: number(599), requestDigest: string(64), responseDigest: string(64), requestBytes: number(), responseBytes: number(), ms: number(), pinnedAddress: string(64), dns: array(string(64), 32), redirects: array(string(600), 8), truncated: string(8, ['yes', 'no']), replayOf: string(64) });
const proxySitemapSchema = object({ origins: array(object({ origin: string(8192), requests: number(), allowed: number(), blocked: number(), paths: array(object({ path: string(1024), requests: number(), methods: array(string(16), 8), lastStatus: number(599), decision: string(16, ['allowed', 'blocked', 'mixed']) }), 32) }), 16) });
const proxyScopeSchema = object({
  allowed: array(object({ targetId: string(128), origins: array(string(8192), 8, 1), pathPrefixes: array(string(1024), 32, 1), methods: array(string(16), 8, 1), accounts: array(string(128), 16) }), 16),
  excluded: array(object({ origin: string(8192), pathPrefixes: array(string(1024), 32, 1) }), 16),
  decisions: object({ allowed: number(), blocked: number(), byReason: array(object({ reason: string(64), count: number() }), 32) }),
  pinned: array(object({ host: string(256), addresses: array(string(64), 32, 1) }), 64),
  budget: proxyBudgetSchema, refused: string(8, ['yes', 'no']),
});
const proxyHistorySchema = object({
  kind: string(24, ['proxy-history']), proxyId: string(128), action: string(24, PROXY_HISTORY_ACTIONS), status: string(16, ['open', 'closed']),
  total: number(), shown: number(), refused: string(8, ['yes', 'no']), limits: array(string(1024), 16),
  entries: array(proxyEntrySchema, 64), entry: proxyEntryDetailSchema, repeat: proxyRepeatSchema, sitemap: proxySitemapSchema, scope: proxyScopeSchema,
}, ['kind', 'proxyId', 'action', 'status', 'total', 'shown', 'refused', 'limits']);
const browserSessionInput = object({ action: string(16, BROWSER_SESSION_ACTIONS), browserId: string(128), url: string(8192), accountId: string(128) }, ['action']);
const browserActInput = object({ browserId: { ...string(128), minLength: 1 }, action: string(24, BROWSER_ACT_ACTIONS), url: string(8192), ref: string(16), text: string(65536), value: string(65536), key: string(16) }, ['browserId', 'action']);
const proxySessionInput = object({ action: string(16, PROXY_SESSION_ACTIONS), proxyId: string(128), accountId: string(128), origins: array(string(8192), 8, 1), maxRequests: { ...number(4096), minimum: 1 }, maxBytes: { ...number(268435456), minimum: 1024 }, ttlMs: { ...number(3600000), minimum: 1000 } }, ['action']);
const proxyHistoryInput = object({ action: string(24, PROXY_HISTORY_ACTIONS), proxyId: { ...string(128), minLength: 1 }, requestId: string(64), method: string(16, ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']), url: string(8192), headers: map(8192), body: string(65536), maxResponseBytes: { ...number(1048576), minimum: 1 }, limit: { ...number(64), minimum: 1 }, page: number(64), filter: string(16, ['all', 'allowed', 'blocked']), query: string(256) }, ['action', 'proxyId']);
const webInput = object({ url: { ...string(), minLength: 1 }, accountId: { ...string(128), minLength: 1 } });
const fuzzDifferentialInput = object({
  subject: object({ kind: string(24, ['module-pair', 'module-invariant']), module: { ...string(4096), minLength: 1 }, moduleA: { ...string(4096), minLength: 1 }, moduleB: { ...string(4096), minLength: 1 } }, ['kind']),
  strategy: string(16, FUZZ_STRATEGIES), seed: { ...string(64), minLength: 1 },
  cases: { ...number(4096), minimum: 1 }, maxInputBytes: { ...number(65536), minimum: 1 }, timeoutMs: { ...number(600000), minimum: 1 },
}, ['subject', 'strategy', 'seed']);
const fuzzTemplateInput = object({
  templateId: { ...string(128), minLength: 1 }, seed: { ...string(64), minLength: 1 },
  axes: array(string(16, FUZZ_TEMPLATE_AXES), 3, 1), cases: { ...number(64), minimum: 1 },
}, ['templateId', 'seed']);
const inputSchemas: Record<Capability, Schema> = {
  'source.analyze': object({ paths: array({ ...string(4096), minLength: 1 }, 64, 1), contains: { ...string(256), minLength: 1 } }, ['paths']),
  'http.request': object({ ...webInput.properties, method: string(16, ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']), action: string(16, ['read', 'mutate']), headers: map(8192), body: string(65536), maxResponseBytes: { ...number(1048576), minimum: 1 }, maxRedirects: number(4) }, ['url', 'accountId']),
  'web.observe': webInput, 'api.map': webInput,
  'service.inventory': object({ urls: array({ ...string(), minLength: 1 }, 16, 1), accountId: { ...string(128), minLength: 1 } }),
  'native.inspect': object({ path: { ...string(4096), minLength: 1 } }),
  'browser.session': browserSessionInput, 'browser.act': browserActInput,
  'proxy.session': proxySessionInput, 'proxy.history': proxyHistoryInput,
  'fuzz.differential': fuzzDifferentialInput, 'fuzz.template': fuzzTemplateInput,
};
const outputSchemas: Record<Capability, Schema> = { 'source.analyze': sourceSchema, 'http.request': httpSchema, 'web.observe': webSchema, 'api.map': apiSchema, 'service.inventory': object({ kind: string(16, ['inventory']), services: array(httpSchema, 16, 1), limits: array(string(512), 16) }), 'native.inspect': nativeSchema, 'browser.session': browserSessionSchema, 'browser.act': browserActSchema, 'proxy.session': proxySessionSchema, 'proxy.history': proxyHistorySchema,
  'fuzz.differential': fuzzDifferentialSchema, 'fuzz.template': fuzzTemplateSchema,
};
const modules: Record<Capability, string[]> = {
  'source.analyze': ['source', 'sandbox', 'container'], 'http.request': ['http'], 'web.observe': ['http', 'browser'], 'api.map': ['http', 'api'], 'service.inventory': ['http', 'inventory'], 'native.inspect': ['container'],
  // The browser pack identity covers the transport, the request gate, the egress proxy and the session
  // lifetime: the last entry is the adapter the descriptor names as its source.
  'browser.session': ['sandbox', 'browser-cdp', 'browser-identity', 'browser-gate', 'browser-proxy', 'browser-session'],
  'browser.act': ['sandbox', 'browser-cdp', 'browser-identity', 'browser-gate', 'browser-proxy', 'browser-session'],
  // The capture pack identity covers the transport, the connection-time gate, the bounded store, repeat and
  // the pack lifetime; `proxy` is the adapter module the descriptor names as its source.
  'proxy.session': ['sandbox', 'browser-proxy', 'browser-gate', 'http', 'proxy/store', 'proxy/gate', 'proxy/identity', 'proxy/pack', 'proxy'],
  'proxy.history': ['sandbox', 'browser-proxy', 'browser-gate', 'http', 'proxy/store', 'proxy/gate', 'proxy/replay', 'proxy/identity', 'proxy/pack', 'proxy'],
  // The fuzz pack identity covers the deterministic PRNG/generator, the minimizer, the adapter logic and the
  // pack; `fuzz/pack` is the adapter module the descriptor names as its source.
  'fuzz.differential': ['sandbox', 'fuzz/prng', 'fuzz/generator', 'fuzz/shrink', 'fuzz/differential', 'fuzz/external-tool', 'fuzz/pack'],
  'fuzz.template': ['sandbox', 'http', 'fuzz/prng', 'fuzz/generator', 'fuzz/template', 'fuzz/external-tool', 'fuzz/pack'],
};
const common = ['broker', 'filesystem', 'redaction', 'schema', 'registry', 'process', 'types'];
/**
 * Descriptor-level bring-up budget: cold-starting the pinned sandbox happens before the operation deadline,
 * so it must never fit inside the 15s steady-state cap. Capabilities may widen it; nothing may declare less
 * than the 30s floor that a packed-image cold start needs on a loaded host.
 */
export const DEFAULT_STARTUP_BUDGET_MS = 30_000;
const descriptorStartupBudgetMs: Partial<Record<Capability, number>> = {
  // Source analysis mounts and hashes the immutable snapshot inside the pack before its operation starts.
  'source.analyze': 30_000,
  // Native inspection loads and disassembles bounded bytes inside the pack.
  'native.inspect': 45_000,
};
const baseLimits = { timeoutMs: 15000, maxInputBytes: 131072, maxOutputBytes: 2097152, maxResponseBytes: 1048576, maxFiles: 64, maxRedirects: 4 };
function implementationDigest(id: Capability): string {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const identities = [...common, ...modules[id]].map(name => [name, sha256(readFileSync(new URL(`./${name}${extension}`, import.meta.url)))]);
  for (const name of ['budget', 'errors', 'network', 'scope', 'targets', 'types', 'validation']) identities.push([`policy/${name}`, sha256(readFileSync(new URL(`../policy/${name}${extension}`, import.meta.url)))]);
  return digest(identities);
}
/**
 * Adapter declarations that registry metadata may not widen or hide. A descriptor that does not match
 * the installed adapter's schema, identity, isolation, actions or required side effects is refused.
 */
const defaultIsolation: readonly IsolationMode[] = ['local-fixture', 'container'];
const adapterIsolation: Record<Capability, readonly IsolationMode[]> = {
  'source.analyze': defaultIsolation, 'http.request': defaultIsolation, 'web.observe': defaultIsolation, 'api.map': defaultIsolation, 'service.inventory': defaultIsolation,
  'native.inspect': ['container'],
  'browser.session': ['host-browser'], 'browser.act': ['host-browser'],
  'proxy.session': ['local-fixture', 'host-browser'], 'proxy.history': ['local-fixture', 'host-browser'],
  // Differential fuzzing imports owner-supplied modules into the controller process, so it is qualified only
  // on the trusted-input-only fixture boundary; it is never enabled by the host-browser or container mode.
  'fuzz.differential': ['local-fixture'], 'fuzz.template': ['local-fixture', 'container'],
};
const adapterActions: Record<Capability, readonly Action[]> = {
  'source.analyze': ['analyze'], 'http.request': ['read', 'mutate'], 'web.observe': ['read'], 'api.map': ['read'], 'service.inventory': ['inventory'], 'native.inspect': ['native'],
  'browser.session': ['read'], 'browser.act': ['read', 'mutate'],
  'proxy.session': ['read', 'mutate'], 'proxy.history': ['read', 'mutate'],
  'fuzz.differential': ['analyze'], 'fuzz.template': ['read', 'mutate'],
};
const adapterSideEffects: Record<Capability, readonly ('read-trusted-input' | 'write-private-artifact' | 'target-request' | 'explicit-mutation' | 'offline-container')[]> = {
  'source.analyze': ['read-trusted-input', 'offline-container', 'write-private-artifact'],
  'native.inspect': ['read-trusted-input', 'offline-container', 'write-private-artifact'],
  'http.request': ['target-request', 'explicit-mutation', 'write-private-artifact'],
  'browser.session': ['target-request', 'write-private-artifact'],
  'browser.act': ['target-request', 'explicit-mutation', 'write-private-artifact'],
  'proxy.session': ['target-request', 'explicit-mutation', 'write-private-artifact'],
  'proxy.history': ['target-request', 'explicit-mutation', 'write-private-artifact'],
  'fuzz.differential': ['read-trusted-input', 'offline-container', 'write-private-artifact'],
  'fuzz.template': ['target-request', 'explicit-mutation', 'write-private-artifact'],
  'web.observe': ['target-request', 'write-private-artifact'],
  'api.map': ['target-request', 'write-private-artifact'],
  'service.inventory': ['target-request', 'write-private-artifact'],
};
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every(value => b.includes(value));
function createDescriptor(id: Capability, limits: ToolDescriptor['limits']): ToolDescriptor {
  return {
    id, version: '1.0.0', implementation: `pi-p2o/${id}`, implementationDigest: implementationDigest(id),
    source: `repository://src/tools/${id === 'source.analyze' ? 'source' : modules[id].at(-1)}.ts`, platforms: ['linux'],
    inputSchema: inputSchemas[id], outputSchema: outputSchemas[id],
    sideEffects: [...adapterSideEffects[id]], actions: [...adapterActions[id]], limits: { ...limits },
    evidenceCollector: 'pi-p2o/redacted-json-sha256/v1', isolation: [...adapterIsolation[id]],
  };
}
export class CapabilityRegistry {
  private readonly descriptors: ReadonlyMap<Capability, Readonly<ToolDescriptor>>;
  constructor(descriptors: readonly ToolDescriptor[]) {
    const entries = new Map<Capability, ToolDescriptor>();
    for (const d of descriptors) {
      invariant(CAPABILITIES.includes(d.id) && !entries.has(d.id), 'INVALID_INPUT', 'Invalid/duplicate capability descriptor');
      invariant(d.version === '1.0.0' && d.implementation === `pi-p2o/${d.id}` && d.implementationDigest === implementationDigest(d.id), 'INVALID_INPUT', 'Capability identity does not match the installed adapter');
      invariant(digest(d.inputSchema) === digest(inputSchemas[d.id]) && digest(d.outputSchema) === digest(outputSchemas[d.id]), 'INVALID_INPUT', 'Adapter schema cannot be replaced by registry metadata');
      invariant(Object.keys(d.limits).length === Object.keys(baseLimits).length && Object.keys(d.limits).every(k => Object.hasOwn(baseLimits, k)), 'INVALID_INPUT', 'Invalid capability limits');
      for (const [key, maximum] of Object.entries(baseLimits)) integer(d.limits[key as keyof typeof baseLimits], key, key === 'maxRedirects' ? 0 : 1, maximum);
      invariant(sameSet(d.isolation, adapterIsolation[d.id]), 'INVALID_INPUT', 'Adapter isolation declaration cannot be replaced by registry metadata');
      invariant(sameSet(d.actions, adapterActions[d.id]), 'INVALID_INPUT', 'Adapter action set cannot be widened or hidden by registry metadata');
      invariant(sameSet(d.sideEffects, adapterSideEffects[d.id]), 'INVALID_INPUT', 'Adapter side effects cannot be added or hidden by registry metadata');
      entries.set(d.id, deepFreeze(structuredClone(d)));
    }
    this.descriptors = entries;
  }
  get(id: Capability): Readonly<ToolDescriptor> {
    const descriptor = this.descriptors.get(id);
    invariant(descriptor, 'CAPABILITY_DENIED', 'Capability is not provisioned');
    return descriptor;
  }
  list(): readonly Readonly<ToolDescriptor>[] { return Object.freeze([...this.descriptors.values()]); }
  /**
   * Bounded descriptor-driven bring-up budget for this capability. It is not the operation deadline: the
   * caller runs sandbox readiness under this budget and only then starts `limits.timeoutMs` for real work.
   */
  startupBudgetMs(id: Capability): number {
    const budget = descriptorStartupBudgetMs[this.get(id).id] ?? DEFAULT_STARTUP_BUDGET_MS;
    integer(budget, 'startupBudgetMs', DEFAULT_STARTUP_BUDGET_MS, 300_000);
    return budget;
  }
  validateInput(id: Capability, input: unknown): void { validateSchema(this.get(id).inputSchema, input); }
  validateOutput(id: Capability, output: unknown): void { validateSchema(this.get(id).outputSchema, output, 'output'); }
}
export function createDefaultRegistry(options: { native?: boolean; browser?: boolean; fuzz?: boolean; limits?: Partial<ToolDescriptor['limits']> } = {}): CapabilityRegistry {
  const limits = { ...baseLimits };
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    invariant(Object.hasOwn(baseLimits, key), 'INVALID_INPUT', 'Unknown registry limit');
    const k = key as keyof typeof limits;
    limits[k] = integer(value, `limits.${key}`, key === 'maxRedirects' ? 0 : 1, baseLimits[k]);
  }
  // Browser and fuzz-pack capabilities are only provisioned when the run explicitly enables the pack;
  // native tools and the packs are never enabled implicitly by the sandbox mode.
  const browserIds = new Set<Capability>(['browser.session', 'browser.act']);
  const fuzzIds = new Set<Capability>(['fuzz.differential', 'fuzz.template']);
  const ids = CAPABILITIES.filter(id => (options.native || id !== 'native.inspect') && (options.browser === true || !browserIds.has(id)) && (options.fuzz === true || !fuzzIds.has(id)));
  return new CapabilityRegistry(ids.map(id => createDescriptor(id, limits)));
}
export async function doctor(options: { registry: CapabilityRegistry; sandbox: ExecutionSandbox; required: readonly Capability[]; budgets?: TargetBudget; signal?: AbortSignal }): Promise<PreflightReport> {
  const sandbox = await options.sandbox.preflight(options.signal);
  const checks = [...sandbox.checks, { name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: `Observed Node ${process.versions.node}; requires Node >=22` }];
  checks.push({ name: 'durable-budget', ok: options.sandbox.mode === 'local-fixture' || options.budgets?.durable === true, detail: 'Operational mode requires synchronous supervisor-owned persistent counters and a single writer fence' });
  const browser = options.sandbox.browser;
  const browserEnabled = options.sandbox.mode === 'host-browser' && browser?.enabled === true && browser.acknowledgement === 'host-browser-not-container-isolated';
  for (const id of options.required) {
    try {
      const d = options.registry.get(id);
      const browserCapability = id === 'browser.session' || id === 'browser.act';
      const ok = d.platforms.includes(process.platform) && d.isolation.includes(options.sandbox.mode) && (id !== 'native.inspect' || options.sandbox.nativeEnabled) && (!browserCapability || browserEnabled);
      checks.push({ name: id, ok, detail: `${d.implementation}@${d.version} / ${d.implementationDigest}${ok ? '' : ' not qualified on this boundary'}` });
    } catch { checks.push({ name: String(id), ok: false, detail: 'Capability missing; no installation/fallback attempted' }); }
  }
  if (options.required.some(id => id === 'browser.session' || id === 'browser.act')) {
    checks.push({ name: 'browser-pack', ok: browserEnabled, detail: 'Browser capabilities require an explicitly acknowledged host-browser sandbox with a pinned Chrome identity re-verified at preflight; container/local-fixture isolation is refused' });
  }
  if (options.required.some(id => id === 'proxy.session' || id === 'proxy.history')) {
    // Capture sessions are loopback-only under local-fixture; policy-scope egress requires the acknowledged
    // host boundary whose pinned identity is re-hashed at preflight.
    const proxyEnabled = options.sandbox.mode === 'local-fixture' || browserEnabled;
    checks.push({ name: 'proxy-pack', ok: proxyEnabled, detail: 'Capture sessions are loopback-only under local-fixture; non-loopback egress requires the acknowledged host-browser boundary' });
  }
  if (options.required.some(id => id === 'fuzz.differential' || id === 'fuzz.template')) {
    const differential = options.required.includes('fuzz.differential');
    const fuzzEnabled = !differential || options.sandbox.codeExecution === 'trusted-local-modules';
    checks.push({ name: 'fuzz-pack', ok: fuzzEnabled, detail: 'In-process differential testing requires the trusted-input-only boundary acknowledgement; external coverage-guided tools are not installed and are refused by pinned-identity verification' });
  }
  return deepFreeze({ ok: sandbox.ok && checks.every(c => c.ok), boundary: options.sandbox.boundary, checks });
}
