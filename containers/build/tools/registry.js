import { readFileSync } from 'node:fs';
import { invariant } from '../policy/errors.js';
import { CAPABILITIES } from '../policy/scope.js';
import { deepFreeze, digest, integer } from '../policy/validation.js';
import { validateSchema } from './schema.js';
import { sha256 } from './redaction.js';
const string = (maxLength = 8192, values) => ({ type: 'string', maxLength, ...(values ? { enum: values } : {}) });
const number = (maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum: 0, maximum });
const array = (items, maxItems = 256, minItems = 0) => ({ type: 'array', items, maxItems, minItems });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const map = (maxLength = 8192) => ({ type: 'object', additionalProperties: string(maxLength) });
const scopeDecision = string(32, ['allowed', 'blocked']);
const httpSchema = object({ kind: string(16, ['http']), hops: array(object({ url: string(), status: number(599), method: string(16), accountId: string(128), action: string(16, ['read', 'mutate', 'inventory']), pinnedAddress: string(64), dnsAddresses: array(string(64), 32, 1), headers: map(16384), responseBytes: number() }), 5, 1), finalUrl: string(), status: number(599), headers: map(16384), body: string(1048576), bodySha256: string(64) });
const sourceSchema = object({ kind: string(16, ['source']), files: array(object({ path: string(4096), sha256: string(64), bytes: number(), lines: number(), imports: array(string(256), 128), exports: array(string(512), 128), routes: array(object({ method: string(16), path: string(512), line: number() }), 128), matches: array(object({ line: number(), text: string(512) }), 128), indicators: array(object({ kind: string(128), line: number() }), 129), dependencies: map(256) }), 64, 1), limits: array(string(512), 16) });
const webSchema = object({ kind: string(16, ['web']), http: httpSchema, title: string(512), links: array(object({ url: string(), scopeDecision }), 128), forms: array(object({ url: string(), method: string(16), scopeDecision }), 64), limits: array(string(512), 16) });
const apiSchema = object({ kind: string(16, ['api']), http: httpSchema, format: string(32, ['openapi-json', 'json-observation', 'non-json-observation']), operations: array(object({ method: string(16), path: string(1024), url: string(), scopeDecision: string(32, ['allowed', 'blocked', 'template-not-expanded']) }), 256), keys: array(string(8192), 128), limits: array(string(512), 16) });
const nativeSchema = object({ kind: string(16, ['native']), path: string(4096), sha256: string(64), bytes: number(), format: string(32, ['elf', 'pe', 'wasm', 'unknown']), architecture: string(64), strings: array(string(256), 128), limits: array(string(512), 16) });
const webInput = object({ url: { ...string(), minLength: 1 }, accountId: { ...string(128), minLength: 1 } });
const inputSchemas = {
    'source.analyze': object({ paths: array({ ...string(4096), minLength: 1 }, 64, 1), contains: { ...string(256), minLength: 1 } }, ['paths']),
    'http.request': object({ ...webInput.properties, method: string(16, ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']), action: string(16, ['read', 'mutate']), headers: map(8192), body: string(65536), maxResponseBytes: { ...number(1048576), minimum: 1 }, maxRedirects: number(4) }, ['url', 'accountId']),
    'web.observe': webInput, 'api.map': webInput,
    'service.inventory': object({ urls: array({ ...string(), minLength: 1 }, 16, 1), accountId: { ...string(128), minLength: 1 } }),
    'native.inspect': object({ path: { ...string(4096), minLength: 1 } }),
};
const outputSchemas = { 'source.analyze': sourceSchema, 'http.request': httpSchema, 'web.observe': webSchema, 'api.map': apiSchema, 'service.inventory': object({ kind: string(16, ['inventory']), services: array(httpSchema, 16, 1), limits: array(string(512), 16) }), 'native.inspect': nativeSchema };
const modules = {
    'source.analyze': ['source', 'sandbox', 'container'], 'http.request': ['http'], 'web.observe': ['http', 'browser'], 'api.map': ['http', 'api'], 'service.inventory': ['http', 'inventory'], 'native.inspect': ['container'],
};
const common = ['broker', 'filesystem', 'redaction', 'schema', 'registry', 'process', 'types'];
const baseLimits = { timeoutMs: 15000, maxInputBytes: 131072, maxOutputBytes: 2097152, maxResponseBytes: 1048576, maxFiles: 64, maxRedirects: 4 };
function implementationDigest(id) {
    const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const identities = [...common, ...modules[id]].map(name => [name, sha256(readFileSync(new URL(`./${name}${extension}`, import.meta.url)))]);
    for (const name of ['budget', 'errors', 'network', 'scope', 'targets', 'types', 'validation'])
        identities.push([`policy/${name}`, sha256(readFileSync(new URL(`../policy/${name}${extension}`, import.meta.url)))]);
    return digest(identities);
}
export class CapabilityRegistry {
    descriptors;
    constructor(descriptors) {
        const entries = new Map();
        for (const d of descriptors) {
            invariant(CAPABILITIES.includes(d.id) && !entries.has(d.id), 'INVALID_INPUT', 'Invalid/duplicate capability descriptor');
            invariant(d.version === '1.0.0' && d.implementation === `pi-p2o/${d.id}` && d.implementationDigest === implementationDigest(d.id), 'INVALID_INPUT', 'Capability identity does not match the installed adapter');
            invariant(digest(d.inputSchema) === digest(inputSchemas[d.id]) && digest(d.outputSchema) === digest(outputSchemas[d.id]), 'INVALID_INPUT', 'Adapter schema cannot be replaced by registry metadata');
            invariant(Object.keys(d.limits).length === Object.keys(baseLimits).length && Object.keys(d.limits).every(k => Object.hasOwn(baseLimits, k)), 'INVALID_INPUT', 'Invalid capability limits');
            for (const [key, maximum] of Object.entries(baseLimits))
                integer(d.limits[key], key, key === 'maxRedirects' ? 0 : 1, maximum);
            invariant(d.sideEffects.includes('write-private-artifact') && (d.id === 'http.request' ? d.sideEffects.includes('explicit-mutation') && d.sideEffects.includes('target-request') : d.id === 'source.analyze' || d.id === 'native.inspect' ? d.sideEffects.includes('read-trusted-input') : d.sideEffects.includes('target-request')), 'INVALID_INPUT', 'Required adapter side effects cannot be hidden');
            entries.set(d.id, deepFreeze(structuredClone(d)));
        }
        this.descriptors = entries;
    }
    get(id) {
        const descriptor = this.descriptors.get(id);
        invariant(descriptor, 'CAPABILITY_DENIED', 'Capability is not provisioned');
        return descriptor;
    }
    list() { return Object.freeze([...this.descriptors.values()]); }
    validateInput(id, input) { validateSchema(this.get(id).inputSchema, input); }
    validateOutput(id, output) { validateSchema(this.get(id).outputSchema, output, 'output'); }
}
export function createDefaultRegistry(options = {}) {
    const limits = { ...baseLimits };
    for (const [key, value] of Object.entries(options.limits ?? {})) {
        invariant(Object.hasOwn(baseLimits, key), 'INVALID_INPUT', 'Unknown registry limit');
        const k = key;
        limits[k] = integer(value, `limits.${key}`, key === 'maxRedirects' ? 0 : 1, baseLimits[k]);
    }
    const ids = CAPABILITIES.filter(id => options.native || id !== 'native.inspect');
    return new CapabilityRegistry(ids.map(id => ({
        id, version: '1.0.0', implementation: `pi-p2o/${id}`, implementationDigest: implementationDigest(id), source: `repository://src/tools/${id === 'source.analyze' ? 'source' : modules[id].at(-1)}.ts`, platforms: ['linux'], inputSchema: inputSchemas[id], outputSchema: outputSchemas[id],
        sideEffects: id === 'source.analyze' || id === 'native.inspect' ? ['read-trusted-input', 'offline-container', 'write-private-artifact'] : id === 'http.request' ? ['target-request', 'explicit-mutation', 'write-private-artifact'] : ['target-request', 'write-private-artifact'],
        actions: id === 'source.analyze' ? ['analyze'] : id === 'native.inspect' ? ['native'] : id === 'service.inventory' ? ['inventory'] : id === 'http.request' ? ['read', 'mutate'] : ['read'],
        limits: { ...limits }, evidenceCollector: 'pi-p2o/redacted-json-sha256/v1', isolation: id === 'native.inspect' ? ['container'] : ['local-fixture', 'container'],
    })));
}
export async function doctor(options) {
    const sandbox = await options.sandbox.preflight(options.signal);
    const checks = [...sandbox.checks, { name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: `Observed Node ${process.versions.node}; requires Node >=22` }];
    checks.push({ name: 'durable-budget', ok: options.sandbox.mode === 'local-fixture' || options.budgets?.durable === true, detail: 'Operational mode requires synchronous supervisor-owned persistent counters and a single writer fence' });
    for (const id of options.required) {
        try {
            const d = options.registry.get(id);
            const ok = d.platforms.includes(process.platform) && d.isolation.includes(options.sandbox.mode) && (id !== 'native.inspect' || options.sandbox.nativeEnabled);
            checks.push({ name: id, ok, detail: `${d.implementation}@${d.version} / ${d.implementationDigest}${ok ? '' : ' not qualified on this boundary'}` });
        }
        catch {
            checks.push({ name: String(id), ok: false, detail: 'Capability missing; no installation/fallback attempted' });
        }
    }
    return deepFreeze({ ok: sandbox.ok && checks.every(c => c.ok), boundary: options.sandbox.boundary, checks });
}
