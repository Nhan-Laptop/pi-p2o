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
  /**
   * Bounded bring-up budget for sandbox readiness. When absent, the capability descriptor's own budget is
   * used (>= 30s). The operation deadline (`descriptor.limits.timeoutMs`, 15s) only starts once the sandbox
   * reports ready, so a cold packed-image start can never consume the operation budget.
   */
  startupBudgetMs?: number;
  /**
   * No-progress circuit breaker: after N consecutive tool-plane refusals (TIMEOUT / STARTUP_TIMEOUT /
   * CANCELLED / UNAVAILABLE) with zero collected receipts, this attempt is halted with the explicit
   * `NO_PROGRESS_HALT` code instead of calling into a dead loop. `{ consecutiveRefusals: 0 }` disables it.
   */
  noProgress?: { consecutiveRefusals?: number };
  /** Trusted composition hook, invoked once per halted attempt. Never a worker-facing surface. */
  onNoProgress?: (report: NoProgressReport) => void;
}
export class ToolExecutionError extends PolicyError {
  readonly receipt: ToolReceipt;
  /**
   * True once the call entered the capability adapter, false for every pre-dispatch refusal (halt fence,
   * capability/isolation/input validation, session fence, policy authorize, sandbox bring-up). The owning
   * composition releases a reservation whose call never dispatched; dispatched failures stay charged.
   */
  readonly dispatched: boolean;
  constructor(error: PolicyError, receipt: ToolReceipt, dispatched: boolean) { super(error.code, error.message); this.name = 'ToolExecutionError'; this.receipt = receipt; this.dispatched = dispatched; }
}
/** Explicit terminal code for an attempt whose tool plane is refusing every call with no progress. */
export const NO_PROGRESS_HALT = 'NO_PROGRESS_HALT';
export const DEFAULT_NO_PROGRESS_REFUSALS = 5;
/**
 * One attempt's halt record. It is also the receipt-facing reason: the attempt may not keep calling tools,
 * and the supervisor's own no-progress watchdog terminates the owned runtime so provider turns stop.
 */
export interface NoProgressReport {
  version: 1;
  attemptId: string;
  code: typeof NO_PROGRESS_HALT;
  refusals: number;
  collected: number;
  lastCode: string;
  reason: string;
  at: string;
}
/** Tool-plane failures, as opposed to a policy decision about one request. */
const refusalCodes: ReadonlySet<string> = new Set(['TIMEOUT', 'CANCELLED', 'UNAVAILABLE']);
/**
 * True for the tool-plane failures the no-progress breaker counts. The owning composition uses this to
 * classify a released reservation's refusal, so the supervisor only ever counts the same codes (a policy
 * denial proves the plane answered and resets the streak).
 */
export function isToolPlaneRefusal(code: string): boolean { return refusalCodes.has(code); }
/**
 * `PolicyErrorCode` is a closed policy union outside this module, so the explicit halt identity travels as
 * this stable message prefix plus the structured `NoProgressReport` (broker accessor and `onNoProgress`),
 * while the code stays the truthful `UNAVAILABLE` (the tool plane is not usable).
 */
const haltError = (report: NoProgressReport): PolicyError => new PolicyError('UNAVAILABLE', `${NO_PROGRESS_HALT}: ${report.reason}`);
/** A broker whose per-attempt halt state is readable by the owning composition for status/reporting. */
export interface ToolBrokerWithNoProgress extends ToolBroker {
  /** The halt record for one attempt, when its tool plane was halted. Never creates state. */
  noProgress(attemptId: string): NoProgressReport | undefined;
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
export function createToolBroker(configuration: ToolBrokerOptions): ToolBrokerWithNoProgress {
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
  invariant(options.startupBudgetMs === undefined || (Number.isSafeInteger(options.startupBudgetMs) && options.startupBudgetMs >= 1000 && options.startupBudgetMs <= 300_000), 'INVALID_INPUT', 'startupBudgetMs must be a bounded 1s..300s bring-up budget');
  const refusalLimit = options.noProgress?.consecutiveRefusals ?? DEFAULT_NO_PROGRESS_REFUSALS;
  invariant(Number.isSafeInteger(refusalLimit) && refusalLimit >= 0 && refusalLimit <= 64, 'INVALID_INPUT', 'noProgress.consecutiveRefusals must be 0..64');
  /**
   * Attempt-scoped no-progress state. `collected` counts observations that actually reached the caller, so
   * the breaker can only fire for an attempt that has never collected anything; any non-refusal outcome
   * (including a policy denial, which proves the plane answered) resets the consecutive streak.
   */
  const progress = new Map<string, { refusals: number; collected: number; lastCode: string; halt?: NoProgressReport }>();
  const recordCollected = (attemptId: string): void => {
    if (attemptId === 'untrusted') return;
    const entry = progress.get(attemptId) ?? { refusals: 0, collected: 0, lastCode: 'none' };
    entry.refusals = 0; entry.collected += 1; progress.set(attemptId, entry);
  };
  const recordRefusal = (attemptId: string, code: string): NoProgressReport | undefined => {
    if (attemptId === 'untrusted') return undefined;
    const entry = progress.get(attemptId) ?? { refusals: 0, collected: 0, lastCode: 'none' };
    progress.set(attemptId, entry);
    if (entry.halt) return entry.halt;
    if (!refusalCodes.has(code)) { entry.refusals = 0; entry.lastCode = code; return undefined; }
    entry.refusals += 1; entry.lastCode = code;
    if (refusalLimit === 0 || entry.collected > 0 || entry.refusals < refusalLimit) return undefined;
    entry.halt = Object.freeze({
      version: 1 as const, attemptId, code: NO_PROGRESS_HALT as typeof NO_PROGRESS_HALT, refusals: entry.refusals, collected: entry.collected, lastCode: code,
      reason: `no-progress: ${entry.refusals} consecutive tool-plane refusals (${code}) with zero collected receipts; attempt halted instead of calling into a dead loop`,
      at: new Date().toISOString(),
    });
    try { options.onNoProgress?.(entry.halt); } catch { /* a composition hook must never change the halt decision */ }
    return entry.halt;
  };
  let preflight: ReturnType<ExecutionSandbox['preflight']> | undefined;
  return Object.freeze({
    async execute(request: ExecuteRequest) {
      const startedAt = new Date().toISOString();
      const touchedTargets = new Set<string>();
      let descriptor: Readonly<ToolDescriptor> | undefined;
      let inputDigest = digest(null), artifact: Artifact | undefined, timeout = false;
      /**
       * True only once the call passed every pre-dispatch gate and entered the capability adapter. The owning
       * composition releases a reservation whose call provably never dispatched (see `ToolExecutionError`).
       */
      let dispatched = false;
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
        // Halt fence: an attempt whose tool plane already refused N consecutive calls with zero collected
        // receipts may not keep calling (and may not spend another tool-call budget unit) on a dead plane.
        const halted = progress.get(context.attemptId)?.halt;
        if (halted) throw haltError(halted);
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
        // Bring-up is bounded by its own budget: the operation deadline starts only after the sandbox is ready.
        const startupBudgetMs = options.startupBudgetMs ?? registry.startupBudgetMs(request.tool);
        const startup = new AbortController();
        const abortStartup = () => startup.abort();
        request.signal?.addEventListener('abort', abortStartup, { once: true });
        if (request.signal?.aborted) startup.abort();
        let startupTimer: ReturnType<typeof setTimeout> | undefined;
        let startupTimedOut = false;
        try {
          if (!preflight) {
            startupTimer = setTimeout(() => { startupTimedOut = true; startup.abort(); }, startupBudgetMs);
            preflight = options.sandbox.preflight(startup.signal);
          }
          try {
            const readyPromise = preflight;
            // The budget must bound a sandbox that never honours the signal: race the readiness promise against
            // the bring-up abort instead of trusting the sandbox to stop on its own.
            let rejectOnAbort: (() => void) | undefined;
            const aborted = new Promise<never>((_, reject) => {
              rejectOnAbort = () => reject(startupTimedOut
                ? new PolicyError('TIMEOUT', `sandbox bring-up exceeded ${startupBudgetMs} ms; no unsandboxed fallback`)
                : new PolicyError('CANCELLED', 'Tool cancelled'));
              if (startup.signal.aborted) rejectOnAbort();
              else startup.signal.addEventListener('abort', rejectOnAbort, { once: true });
            });
            // The losing promise is observed, never an unhandled rejection.
            void readyPromise.catch(() => { /* bring-up result is discarded after abort */ });
            let ready: Awaited<typeof readyPromise>;
            try { ready = await Promise.race([readyPromise, aborted]); }
            finally { if (rejectOnAbort) startup.signal.removeEventListener('abort', rejectOnAbort); }
            invariant(ready.ok, 'UNAVAILABLE', 'Sandbox preflight failed; no unsandboxed fallback');
          } catch (error) {
            preflight = undefined; // a failed bring-up must not poison every later call with a cached rejection
            if (startupTimedOut && !request.signal?.aborted && !(error instanceof PolicyError && error.code === 'TIMEOUT')) throw new PolicyError('TIMEOUT', `sandbox bring-up exceeded ${startupBudgetMs} ms; no unsandboxed fallback`);
            throw error;
          }
        } finally {
          if (startupTimer) clearTimeout(startupTimer);
          request.signal?.removeEventListener('abort', abortStartup);
        }
        timer = setTimeout(() => { timeout = true; controller.abort(); }, descriptor.limits.timeoutMs);
        checkCancelled(controller.signal); options.policy.assertActive(context);
        // Charged only at dispatch: a refusal that never dispatched must not consume the capability/task budget.
        options.budgets.chargeCall(grant);
        dispatched = true; // the dispatch boundary: everything after this may reach the sandbox/target adapter
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
        recordCollected(context.attemptId);
        return deepFreeze({ data, artifact, receipt: collected });
      } catch (e) {
        const error = timeout ? new PolicyError('TIMEOUT', 'Tool deadline exceeded') : request.signal?.aborted ? new PolicyError('CANCELLED', 'Tool cancelled') : e instanceof PolicyError ? e : new PolicyError('UNAVAILABLE', 'Tool failed safely');
        // The breaker sees every failure the worker would have seen; the tripping call reports the explicit
        // halt reason so the worker cannot mistake it for a retryable single-request error.
        const halt = recordRefusal(context.attemptId, error.code);
        const effective = halt && !error.message.startsWith(NO_PROGRESS_HALT) ? haltError(halt) : error;
        const failed = receipt(effective);
        try { await options.receiptSink?.(failed); } catch { /* Return the failure receipt for durable retry by the supervisor. */ }
        throw new ToolExecutionError(effective, failed, dispatched);
      } finally { if (timer) clearTimeout(timer); request.signal?.removeEventListener('abort', cancel); }
    },
    noProgress(attemptId: string) { return progress.get(attemptId)?.halt; },
  });
}
