import { checkCancelled, invariant, PolicyError } from '../policy/errors.js';
import { deepFreeze, digest } from '../policy/validation.js';
import { mapApi } from './api.js';
import { observePage } from './browser.js';
import { validateRelativePath } from './filesystem.js';
import { createHttpAdapter } from './http.js';
import { inventoryServices } from './inventory.js';
import { createDefaultRegistry } from './registry.js';
import { createRedactor } from './redaction.js';
export class ToolExecutionError extends PolicyError {
    receipt;
    constructor(error, receipt) { super(error.code, error.message); this.name = 'ToolExecutionError'; this.receipt = receipt; }
}
const denialCodes = new Set(['INVALID_INPUT', 'EXPIRED', 'NOT_YET_VALID', 'IDENTITY_DENIED', 'CAPABILITY_DENIED', 'ACTION_DENIED', 'TARGET_DENIED', 'ACCOUNT_DENIED', 'ADDRESS_DENIED', 'DNS_CHANGED', 'PEER_MISMATCH', 'REDIRECT_DENIED', 'BUDGET_EXCEEDED', 'RATE_LIMITED', 'FILESYSTEM_DENIED']);
export function createToolBroker(configuration) {
    const options = Object.freeze({ ...configuration, secrets: configuration.secrets ? Object.freeze([...configuration.secrets]) : undefined });
    options.budgets.bindRun(options.policy.scope.runId, options.policy.scope.targets);
    invariant(options.sandbox.mode === 'local-fixture' || options.budgets.durable, 'UNAVAILABLE', 'Operational container mode requires a supervisor-owned durable budget journal');
    const registry = options.registry ?? createDefaultRegistry();
    // Registry metadata cannot turn built-in adapters into new arbitrary host tools.
    const redactor = createRedactor(options.secrets);
    const http = createHttpAdapter({ ...options, redactor });
    let preflight;
    return Object.freeze({
        async execute(request) {
            const startedAt = new Date().toISOString();
            const touchedTargets = new Set();
            let descriptor;
            let inputDigest = digest(null), artifact, timeout = false;
            const controller = new AbortController();
            const cancel = () => controller.abort();
            request.signal?.addEventListener('abort', cancel, { once: true });
            if (request.signal?.aborted)
                cancel();
            let timer;
            // Snapshot only after identity validation. Failed untrusted contexts are not copied into receipts.
            let context = { runId: 'untrusted', taskId: 'untrusted', attemptId: 'untrusted', grantId: 'untrusted' };
            const receipt = (error) => deepFreeze({
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
                const networkAction = (v) => v.action ?? 'read';
                if (request.tool === 'source.analyze' || request.tool === 'native.inspect') {
                    options.policy.authorize({ context, capability: request.tool, action: request.tool === 'source.analyze' ? 'analyze' : 'native' });
                    const paths = request.tool === 'source.analyze' ? input.paths : [input.path];
                    invariant(paths.length <= descriptor.limits.maxFiles && new Set(paths).size === paths.length, 'INVALID_INPUT', 'Source file count/uniqueness exceeded');
                    paths.forEach(validateRelativePath);
                }
                else if (request.tool === 'service.inventory') {
                    const inventory = input;
                    invariant(new Set(inventory.urls).size === inventory.urls.length, 'INVALID_INPUT', 'Duplicate inventory endpoints');
                    for (const url of inventory.urls)
                        options.policy.authorize({ context, capability: request.tool, action: 'inventory', url, method: 'HEAD', accountId: inventory.accountId });
                }
                else {
                    const v = input;
                    options.policy.authorize({ context, capability: request.tool, action: networkAction(v), url: v.url, method: v.method ?? 'GET', accountId: v.accountId });
                }
                timer = setTimeout(() => { timeout = true; controller.abort(); }, descriptor.limits.timeoutMs);
                preflight ??= options.sandbox.preflight(controller.signal);
                invariant((await preflight).ok, 'UNAVAILABLE', 'Sandbox preflight failed; no unsandboxed fallback');
                checkCancelled(controller.signal);
                options.policy.assertActive(context);
                const execution = { context, capability: request.tool, descriptor, signal: controller.signal, touchedTargets };
                let raw;
                switch (request.tool) {
                    case 'source.analyze': {
                        const source = input;
                        const files = [];
                        let total = 0;
                        for (const path of source.paths) {
                            const file = await options.sandbox.filesystem.readInput(path, controller.signal);
                            total += Buffer.byteLength(file.text);
                            invariant(total <= 4194304, 'OUTPUT_LIMIT', 'Source input total byte limit exceeded');
                            files.push(file);
                        }
                        raw = await options.sandbox.analyzeSource(files, source.contains, controller.signal);
                        break;
                    }
                    case 'http.request':
                        raw = await http.request({ ...execution, input });
                        break;
                    case 'web.observe': {
                        const v = input;
                        raw = observePage(await http.request({ ...execution, input: v }), options.policy, context, v.accountId, controller.signal);
                        break;
                    }
                    case 'api.map': {
                        const v = input;
                        raw = mapApi(await http.request({ ...execution, input: v }), options.policy, context, v.accountId, controller.signal);
                        break;
                    }
                    case 'service.inventory': {
                        const v = input;
                        raw = await inventoryServices(v.urls, v.accountId, i => http.request({ ...execution, input: i, action: 'inventory' }), controller.signal);
                        break;
                    }
                    case 'native.inspect':
                        raw = await options.sandbox.inspectNative(input.path, controller.signal);
                        break;
                    default: throw new PolicyError('CAPABILITY_DENIED', 'Unknown tool');
                }
                checkCancelled(controller.signal);
                options.policy.assertActive(context);
                registry.validateOutput(request.tool, raw);
                const data = deepFreeze(redactor.value(raw));
                registry.validateOutput(request.tool, data);
                const content = JSON.stringify(data);
                invariant(Buffer.byteLength(content) <= descriptor.limits.maxOutputBytes, 'OUTPUT_LIMIT', 'Evidence output byte limit exceeded');
                options.budgets.chargeArtifact(grant, Buffer.byteLength(content));
                artifact = await options.sandbox.filesystem.writeArtifact(context, content, controller.signal);
                checkCancelled(controller.signal);
                options.policy.assertActive(context);
                const collected = receipt();
                try {
                    await options.receiptSink?.(collected);
                }
                catch {
                    throw new PolicyError('UNAVAILABLE', 'Supervisor receipt persistence failed');
                }
                checkCancelled(controller.signal);
                options.policy.assertActive(context);
                return deepFreeze({ data, artifact, receipt: collected });
            }
            catch (e) {
                const error = timeout ? new PolicyError('TIMEOUT', 'Tool deadline exceeded') : request.signal?.aborted ? new PolicyError('CANCELLED', 'Tool cancelled') : e instanceof PolicyError ? e : new PolicyError('UNAVAILABLE', 'Tool failed safely');
                const failed = receipt(error);
                try {
                    await options.receiptSink?.(failed);
                }
                catch { /* Return the failure receipt for durable retry by the supervisor. */ }
                throw new ToolExecutionError(error, failed);
            }
            finally {
                if (timer)
                    clearTimeout(timer);
                request.signal?.removeEventListener('abort', cancel);
            }
        },
    });
}
