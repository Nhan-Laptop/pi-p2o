import { checkCancelled, invariant, PolicyError } from '../policy/errors.js';
import { deepFreeze, digest } from '../policy/validation.js';
import type { Action, Capability, Policy, TargetBudget } from '../policy/index.js';
import { mapApi } from './api.js';
import { observePage } from './browser.js';
import { createBrowserPack, type BrowserPack } from './browser-session.js';
import { createProxyPack, type ProxyPack } from './proxy.js';
import { createFuzzPack } from './fuzz/pack.js';
import type { FuzzPackConfiguration } from './fuzz/pack.js';
import { validateRelativePath } from './filesystem.js';
import { createHttpAdapter, defaultResolver, type CredentialProvider, type DnsResolver } from './http.js';
import { inventoryServices } from './inventory.js';
import { CapabilityRegistry, createDefaultRegistry } from './registry.js';
import { createRedactor } from './redaction.js';
import type { ExecutionSandbox } from './sandbox.js';
import type { Artifact, ExecuteRequest, HttpInput, InventoryInput, NativeInput, PackSessionFence, SourceInput, ToolBroker, ToolDescriptor, ToolReceipt, WebInput } from './types.js';

export interface ToolBrokerOptions {
  policy: Policy;
  budgets: TargetBudget;
  sandbox: ExecutionSandbox;
  registry?: CapabilityRegistry;
  credentials?: CredentialProvider;
  secrets?: readonly string[];
  resolver?: DnsResolver;
  receiptSink?: (receipt: ToolReceipt) => void | Promise<void>;
  /** Optional owner-supplied browser pack so the runtime can drive attempt-release lifetime hooks. */
  browser?: BrowserPack;
  /** Optional owner-supplied proxy pack; else the broker owns one and wires its capture proxy into the browser pack. */
  proxy?: ProxyPack;
  /** Owner-approved fuzz templates and the (absent) external runner; differential fuzzing needs no configuration. */
  fuzz?: FuzzPackConfiguration;
  /**
   * [F3] Attempt-liveness fence consulted before any capability that can create or drive a pack session.
   * The composition supplies it (runtime session lease + live attempt); absent means this composition owns no
   * pack session that could outlive its attempt. A refusal is a denial, never a silent no-op.
   */
  sessionFence?: PackSessionFence;
}
export class ToolExecutionError extends PolicyError {
  readonly receipt: ToolReceipt;
  constructor(error: PolicyError, receipt: ToolReceipt) { super(error.code, error.message); this.name = 'ToolExecutionError'; this.receipt = receipt; }
}
const denialCodes = new Set(['INVALID_INPUT', 'EXPIRED', 'NOT_YET_VALID', 'IDENTITY_DENIED', 'CAPABILITY_DENIED', 'ACTION_DENIED', 'TARGET_DENIED', 'ACCOUNT_DENIED', 'ADDRESS_DENIED', 'DNS_CHANGED', 'PEER_MISMATCH', 'REDIRECT_DENIED', 'BUDGET_EXCEEDED', 'RATE_LIMITED', 'FILESYSTEM_DENIED']);
/**
 * [F3] Capabilities that can create or drive an attempt-scoped pack session. Session cleanup (`browser.session
 * close`, `proxy.session stop`) is deliberately NOT fenced: a pack may still be told to tear its session down
 * after the attempt terminated, which can only reduce leaks.
 */
function opensOrDrivesPackSession(tool: Capability, input: unknown): boolean {
  if (tool === 'browser.act' || tool === 'proxy.history') return true;
  const action = input !== null && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  if (tool === 'browser.session') return action === 'open';
  if (tool === 'proxy.session') return action === 'start';
  return false;
}
export function createToolBroker(configuration: ToolBrokerOptions): ToolBroker {
  const options: ToolBrokerOptions = Object.freeze({ ...configuration, secrets: configuration.secrets ? Object.freeze([...configuration.secrets]) : undefined });
  options.budgets.bindRun(options.policy.scope.runId, options.policy.scope.targets);
  invariant(options.sandbox.mode === 'local-fixture' || options.budgets.durable, 'UNAVAILABLE', 'Operational container mode requires a supervisor-owned durable budget journal');
  const registry = options.registry ?? createDefaultRegistry();
  // Registry metadata cannot turn built-in adapters into new arbitrary host tools.
  const redactor = createRedactor(options.secrets);
  const http = createHttpAdapter({ ...options, redactor });
  // The fuzz pack owns no process and no session: differential runs import owner-supplied modules from the
  // trusted snapshot in-process, and template runs go through the same http adapter as `http.request` so
  // every mutated request is authorized, DNS-pinned and budgeted by the existing broker path.
  const fuzz = createFuzzPack({ policy: options.policy, budgets: options.budgets, sandbox: options.sandbox, request: http.request, ...(options.fuzz ?? {}) });
  // Controller-side browser sessions: no process is launched until a `browser.session` call is authorized.
  // An owner-supplied pack (runtime/composition) shares the lifetime hooks; otherwise the broker owns one.
  // Capture/replay sessions share the broker's policy, budgets and sandbox. The pack is inert until a
  // session starts, and its capture-capable egress proxy is handed to a broker-owned browser pack so page
  // traffic lands in `proxy.history`; an owner-supplied browser pack opts in by passing the same factory.
  const proxies = options.proxy ?? createProxyPack({ policy: options.policy, budgets: options.budgets, sandbox: options.sandbox, resolver: options.resolver ?? defaultResolver });
  const browsers = options.browser ?? createBrowserPack({ policy: options.policy, budgets: options.budgets, sandbox: options.sandbox, resolver: options.resolver ?? defaultResolver, egressProxy: proxies.egressProxy });
  let preflight: ReturnType<ExecutionSandbox['preflight']> | undefined;
  return Object.freeze({
    async execute(request: ExecuteRequest) {
      const startedAt = new Date().toISOString();
      const touchedTargets = new Set<string>();
      let descriptor: Readonly<ToolDescriptor> | undefined;
      let inputDigest = digest(null), artifact: Artifact | undefined, timeout = false;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      request.signal?.addEventListener('abort', cancel, { once: true });
      if (request.signal?.aborted) cancel();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Snapshot only after identity validation. Failed untrusted contexts are not copied into receipts.
      let context = { runId: 'untrusted', taskId: 'untrusted', attemptId: 'untrusted', grantId: 'untrusted' };
      const receipt = (error?: PolicyError): ToolReceipt => deepFreeze({
        version: 1, context, tool: { id: descriptor?.id ?? 'unprovisioned', version: descriptor?.version ?? 'unprovisioned', implementationDigest: descriptor?.implementationDigest ?? digest('unprovisioned') }, scopeDigest: options.policy.digest, configurationDigest: options.sandbox.configurationDigest, inputDigest, startedAt, finishedAt: new Date().toISOString(),
        outcome: error ? error.code === 'CANCELLED' ? 'cancelled' : denialCodes.has(error.code) ? 'denied' : 'failed' : 'collected', ...(error ? { errorCode: error.code } : {}), targets: [...touchedTargets], budgets: Object.fromEntries([...touchedTargets].map(id => [id, options.budgets.snapshot(id)])), artifacts: artifact ? [artifact] : [], isolation: options.sandbox.boundary, classification: 'observation-not-verified-finding',
      });
      try {
        checkCancelled(controller.signal);
        const grant = options.policy.assertActive(request.context);
        context = { ...request.context };
        options.budgets.chargeCall(grant); // charge all identity-valid attempts, including malformed/denied input
        descriptor = registry.get(request.tool);
        invariant(grant.capabilities.includes(request.tool), 'CAPABILITY_DENIED', 'Tool capability not granted');
        invariant(descriptor.isolation.includes(options.sandbox.mode) && descriptor.platforms.includes(process.platform) && (request.tool !== 'native.inspect' || options.sandbox.nativeEnabled), 'UNAVAILABLE', 'Tool is not qualified in this sandbox');
        registry.validateInput(request.tool, request.input);
        const serialized = JSON.stringify(request.input);
        invariant(Buffer.byteLength(serialized) <= descriptor.limits.maxInputBytes, 'INVALID_INPUT', 'Tool input byte limit exceeded');
        const input = JSON.parse(serialized); // immutable data snapshot, no retained caller mutations
        inputDigest = digest(input);
        // [F3] No pack session may be created or driven outside a live attempt with an open runtime session
        // lease. The composition owns this fence; the refusal is charged and reported like any other denial.
        if (options.sessionFence && opensOrDrivesPackSession(request.tool, input)) {
          await options.sessionFence.check(context, request.tool);
        }
        const networkAction = (v: HttpInput): Action => v.action ?? 'read';
        if (request.tool === 'source.analyze' || request.tool === 'native.inspect') {
          options.policy.authorize({ context, capability: request.tool, action: request.tool === 'source.analyze' ? 'analyze' : 'native' });
          const paths = request.tool === 'source.analyze' ? (input as SourceInput).paths : [(input as NativeInput).path];
          invariant(paths.length <= descriptor.limits.maxFiles && new Set(paths).size === paths.length, 'INVALID_INPUT', 'Source file count/uniqueness exceeded');
          paths.forEach(validateRelativePath);
        } else if (request.tool === 'fuzz.differential') {
          // Offline capability: local modules get no URL, method or account authority whatsoever.
          options.policy.authorize({ context, capability: request.tool, action: 'analyze' });
        } else if (request.tool === 'fuzz.template') {
          // Authorize the approved base template; every mutated request is re-authorized by the http adapter.
          const resolved = fuzz.authorizeTarget(request.tool, input);
          options.policy.authorize({ context, capability: request.tool, action: resolved.action, url: resolved.url, method: resolved.method, accountId: resolved.accountId });
        } else if (request.tool === 'service.inventory') {
          const inventory = input as InventoryInput;
          invariant(new Set(inventory.urls).size === inventory.urls.length, 'INVALID_INPUT', 'Duplicate inventory endpoints');
          for (const url of inventory.urls) options.policy.authorize({ context, capability: request.tool, action: 'inventory', url, method: 'HEAD', accountId: inventory.accountId });
        } else if (request.tool === 'browser.session' || request.tool === 'browser.act') {
          // Browser calls authorize against the session's own approved origin/url; every intercepted
          // request is re-authorized per request by the pack's CDP + egress-proxy gate before egress.
          const resolved = browsers.authorizeTarget(request.tool, input);
          options.policy.authorize({ context, capability: request.tool, action: 'read', url: resolved.url, method: resolved.method, accountId: resolved.accountId });
        } else if (request.tool === 'proxy.session' || request.tool === 'proxy.history') {
          // Capture/repeat calls authorize against the session's own origin (or the repeat URL); every
          // captured unit and every repeat is re-authorized at connection time by the capture gate.
          const resolved = proxies.authorizeTarget(request.tool, input);
          options.policy.authorize({ context, capability: request.tool, action: resolved.action, url: resolved.url, method: resolved.method, accountId: resolved.accountId });
        } else {
          const v = input as HttpInput;
          options.policy.authorize({ context, capability: request.tool, action: networkAction(v), url: v.url, method: v.method ?? 'GET', accountId: v.accountId });
        }
        timer = setTimeout(() => { timeout = true; controller.abort(); }, descriptor.limits.timeoutMs);
        preflight ??= options.sandbox.preflight(controller.signal);
        invariant((await preflight).ok, 'UNAVAILABLE', 'Sandbox preflight failed; no unsandboxed fallback');
        checkCancelled(controller.signal); options.policy.assertActive(context);
        const execution = { context, capability: request.tool, descriptor, signal: controller.signal, touchedTargets };
        let raw: unknown;
        switch (request.tool) {
          case 'source.analyze': {
            const source = input as SourceInput;
            const files = [];
            let total = 0;
            for (const path of source.paths) {
              const file = await options.sandbox.filesystem.readInput(path, controller.signal);
              total += Buffer.byteLength(file.text);
              invariant(total <= 4194304, 'OUTPUT_LIMIT', 'Source input total byte limit exceeded');
              files.push(file);
            }
            raw = await options.sandbox.analyzeSource(files, source.contains, controller.signal); break;
          }
          case 'http.request': raw = await http.request({ ...execution, input }); break;
          case 'web.observe': {
            const v = input as WebInput;
            raw = observePage(await http.request({ ...execution, input: v }), options.policy, context, v.accountId, controller.signal); break;
          }
          case 'api.map': {
            const v = input as WebInput;
            raw = mapApi(await http.request({ ...execution, input: v }), options.policy, context, v.accountId, controller.signal); break;
          }
          case 'service.inventory': {
            const v = input as InventoryInput;
            raw = await inventoryServices(v.urls, v.accountId, i => http.request({ ...execution, input: i, action: 'inventory' }), controller.signal); break;
          }
          case 'native.inspect': raw = await options.sandbox.inspectNative((input as NativeInput).path, controller.signal); break;
          case 'browser.session':
          case 'browser.act': raw = await browsers.execute({ ...execution, input }); break;
          case 'proxy.session':
          case 'proxy.history': raw = await proxies.execute({ ...execution, input, descriptor, touchedTargets }); break;
          case 'fuzz.differential':
          case 'fuzz.template': raw = await fuzz.execute({ ...execution, input }); break;
          default: throw new PolicyError('CAPABILITY_DENIED', 'Unknown tool');
        }
        checkCancelled(controller.signal); options.policy.assertActive(context);
        registry.validateOutput(request.tool, raw);
        const data = deepFreeze(redactor.value(raw));
        registry.validateOutput(request.tool, data);
        const content = JSON.stringify(data);
        invariant(Buffer.byteLength(content) <= descriptor.limits.maxOutputBytes, 'OUTPUT_LIMIT', 'Evidence output byte limit exceeded');
        options.budgets.chargeArtifact(grant, Buffer.byteLength(content));
        artifact = await options.sandbox.filesystem.writeArtifact(context, content, controller.signal);
        checkCancelled(controller.signal); options.policy.assertActive(context);
        const collected = receipt();
        try { await options.receiptSink?.(collected); } catch { throw new PolicyError('UNAVAILABLE', 'Supervisor receipt persistence failed'); }
        checkCancelled(controller.signal); options.policy.assertActive(context);
        return deepFreeze({ data, artifact, receipt: collected });
      } catch (e) {
        const error = timeout ? new PolicyError('TIMEOUT', 'Tool deadline exceeded') : request.signal?.aborted ? new PolicyError('CANCELLED', 'Tool cancelled') : e instanceof PolicyError ? e : new PolicyError('UNAVAILABLE', 'Tool failed safely');
        const failed = receipt(error);
        try { await options.receiptSink?.(failed); } catch { /* Return the failure receipt for durable retry by the supervisor. */ }
        throw new ToolExecutionError(error, failed);
      } finally { if (timer) clearTimeout(timer); request.signal?.removeEventListener('abort', cancel); }
    },
  });
}
