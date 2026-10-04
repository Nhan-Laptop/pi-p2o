import { invariant } from './errors.js';
import { addressInCidr, isForbiddenAddress, normalizeAddress, validateCidr } from './network.js';
import { normalizeOrigin, normalizePathPrefix, normalizeWebTarget, pathWithin } from './targets.js';
import { choice, deepFreeze, digest, identifier, integer, list, record, strings, text, timestamp } from './validation.js';
export const ACTIONS = ['read', 'mutate', 'inventory', 'analyze', 'native'];
export const CAPABILITIES = ['source.analyze', 'http.request', 'web.observe', 'api.map', 'service.inventory', 'native.inspect'];
const actions = (v, label) => list(v, label, (x, l) => choice(x, l, ACTIONS));
function limits(v) {
    const o = record(v, 'limits', ['maxRequests', 'maxBytes', 'maxConcurrent', 'rate']);
    const r = record(o.rate, 'rate', ['requests', 'windowMs']);
    return { maxRequests: integer(o.maxRequests, 'maxRequests'), maxBytes: integer(o.maxBytes, 'maxBytes'), maxConcurrent: integer(o.maxConcurrent, 'maxConcurrent', 1, 128), rate: { requests: integer(r.requests, 'rate.requests'), windowMs: integer(r.windowMs, 'rate.windowMs', 1, 86400000) } };
}
function target(v) {
    const o = record(v, 'target', ['id', 'origins', 'pathPrefixes', 'allowedCidrs', 'excludedCidrs', 'methods', 'actions', 'accounts', 'limits']);
    const cidrs = (x, label, min = 0) => strings(x, label, min).map(c => { validateCidr(c); return c; });
    const methods = strings(o.methods, 'methods', 1);
    invariant(methods.every(m => ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)), 'INVALID_INPUT', 'Unapproved HTTP method');
    return { id: identifier(o.id, 'target.id'), origins: strings(o.origins, 'origins', 1).map(normalizeOrigin), pathPrefixes: strings(o.pathPrefixes, 'pathPrefixes', 1).map(normalizePathPrefix), allowedCidrs: cidrs(o.allowedCidrs, 'allowedCidrs', 1), excludedCidrs: o.excludedCidrs === undefined ? [] : cidrs(o.excludedCidrs, 'excludedCidrs'), methods, actions: actions(o.actions, 'target.actions'), accounts: strings(o.accounts, 'target.accounts'), limits: limits(o.limits) };
}
function account(v) {
    const o = record(v, 'account', ['id', 'targetIds', 'actions', 'expiresAt', 'kind']);
    return { id: identifier(o.id, 'account.id'), targetIds: strings(o.targetIds, 'account.targetIds', 1), actions: actions(o.actions, 'account.actions'), expiresAt: timestamp(o.expiresAt, 'account.expiresAt'), kind: choice(o.kind, 'account.kind', ['anonymous', 'credential']) };
}
function grant(v) {
    const o = record(v, 'grant', ['id', 'taskId', 'attemptId', 'role', 'capabilities', 'targetIds', 'actions', 'accountIds', 'expiresAt', 'maxCalls', 'maxArtifactBytes']);
    const role = choice(o.role, 'role', ['orchestrator', 'worker', 'verifier', 'reporter']);
    const capabilities = list(o.capabilities, 'capabilities', (x, l) => choice(x, l, CAPABILITIES));
    invariant((role !== 'orchestrator' && role !== 'reporter') || capabilities.length === 0, 'CAPABILITY_DENIED', 'Control/report roles cannot execute target tools');
    return { id: identifier(o.id, 'grant.id'), taskId: identifier(o.taskId, 'grant.taskId'), attemptId: identifier(o.attemptId, 'grant.attemptId'), role, capabilities, targetIds: strings(o.targetIds, 'grant.targetIds'), actions: actions(o.actions, 'grant.actions'), accountIds: strings(o.accountIds, 'grant.accountIds'), expiresAt: timestamp(o.expiresAt, 'grant.expiresAt'), maxCalls: integer(o.maxCalls, 'maxCalls'), maxArtifactBytes: integer(o.maxArtifactBytes, 'maxArtifactBytes') };
}
export function validateScope(value) {
    const o = record(value, 'scope', ['version', 'runId', 'authorization', 'targets', 'exclusions', 'accounts', 'grants']);
    invariant(o.version === 1, 'INVALID_INPUT', 'Unsupported scope version');
    const a = record(o.authorization, 'authorization', ['reference', 'approvedBy', 'expiresAt', 'notBefore']);
    const scope = {
        version: 1, runId: identifier(o.runId, 'runId'),
        authorization: { reference: text(a.reference, 'authorization.reference'), approvedBy: text(a.approvedBy, 'authorization.approvedBy'), expiresAt: timestamp(a.expiresAt, 'authorization.expiresAt'), ...(a.notBefore === undefined ? {} : { notBefore: timestamp(a.notBefore, 'authorization.notBefore') }) },
        targets: list(o.targets, 'targets', target),
        exclusions: list(o.exclusions, 'exclusions', v => { const e = record(v, 'exclusion', ['origin', 'pathPrefixes']); return { origin: normalizeOrigin(text(e.origin, 'exclusion.origin')), pathPrefixes: strings(e.pathPrefixes, 'exclusion.pathPrefixes', 1).map(normalizePathPrefix) }; }),
        accounts: list(o.accounts, 'accounts', account), grants: list(o.grants, 'grants', grant, 1),
    };
    for (const collection of [scope.targets, scope.accounts, scope.grants])
        invariant(new Set(collection.map(x => x.id)).size === collection.length, 'INVALID_INPUT', 'Duplicate identity');
    const targets = new Map(scope.targets.map(t => [t.id, t]));
    const accounts = new Map(scope.accounts.map(a => [a.id, a]));
    // Ambiguous origins would make target-wide limits/account ownership bypassable.
    const origins = scope.targets.flatMap(t => t.origins);
    invariant(new Set(origins).size === origins.length, 'INVALID_INPUT', 'Origins may belong to only one budgeted target');
    for (const a of scope.accounts) {
        invariant(a.targetIds.every(t => targets.has(t)), 'INVALID_INPUT', 'Unknown account target');
        invariant(Date.parse(a.expiresAt) <= Date.parse(scope.authorization.expiresAt), 'INVALID_INPUT', 'Account outlives authorization');
    }
    for (const t of scope.targets)
        invariant(t.accounts.every(id => accounts.get(id)?.targetIds.includes(t.id)), 'INVALID_INPUT', 'Target references an unapproved account');
    for (const g of scope.grants) {
        invariant(g.targetIds.every(t => targets.has(t)) && g.accountIds.every(a => accounts.has(a)), 'INVALID_INPUT', 'Grant references unknown targets/accounts');
        invariant(Date.parse(g.expiresAt) <= Date.parse(scope.authorization.expiresAt), 'INVALID_INPUT', 'Grant outlives authorization');
    }
    if (scope.authorization.notBefore)
        invariant(Date.parse(scope.authorization.notBefore) < Date.parse(scope.authorization.expiresAt), 'INVALID_INPUT', 'Invalid authorization interval');
    return deepFreeze(scope);
}
export function createPolicy(value, options = {}) {
    const scope = validateScope(value);
    const scopeDigest = digest(scope);
    const now = options.now ?? Date.now;
    let lastNow = 0;
    const activeTime = () => { const time = now(); invariant(Number.isFinite(time) && time >= 0, 'UNAVAILABLE', 'Policy clock unavailable'); lastNow = Math.max(lastNow, time); return lastNow; };
    const grants = new Map(scope.grants.map(g => [g.id, g]));
    const decisions = new WeakMap();
    function assertActive(context) {
        const c = record(context, 'context', ['runId', 'taskId', 'attemptId', 'grantId']);
        for (const key of ['runId', 'taskId', 'attemptId', 'grantId'])
            identifier(c[key], `context.${key}`);
        const time = activeTime();
        invariant(time < Date.parse(scope.authorization.expiresAt), 'EXPIRED', 'Authorization expired');
        invariant(!scope.authorization.notBefore || time >= Date.parse(scope.authorization.notBefore), 'NOT_YET_VALID', 'Authorization is not yet active');
        const g = grants.get(context.grantId);
        invariant(context.runId === scope.runId && g && g.taskId === context.taskId && g.attemptId === context.attemptId, 'IDENTITY_DENIED', 'Context does not own this grant');
        invariant(time < Date.parse(g.expiresAt), 'EXPIRED', 'Capability grant expired');
        return g;
    }
    const api = {
        scope, digest: scopeDigest, assertActive,
        authorize(request) {
            const g = assertActive(request.context);
            invariant(g.capabilities.includes(request.capability), 'CAPABILITY_DENIED', 'Capability not granted');
            invariant(g.actions.includes(request.action), 'ACTION_DENIED', 'Action not granted');
            const offline = request.capability === 'source.analyze' || request.capability === 'native.inspect';
            let d;
            if (offline) {
                invariant(!request.url && !request.method && !request.accountId, 'TARGET_DENIED', 'Offline analysis cannot request network/account authority');
                invariant(request.action === (request.capability === 'source.analyze' ? 'analyze' : 'native'), 'ACTION_DENIED', 'Invalid offline action');
                d = deepFreeze({ scopeDigest, grant: g, capability: request.capability, action: request.action });
            }
            else {
                invariant(typeof request.url === 'string', 'TARGET_DENIED', 'Network tool requires a target');
                const normalized = normalizeWebTarget(request.url);
                for (const key of new URL(normalized.url).searchParams.keys())
                    invariant(!/^(?:access[-_]?token|refresh[-_]?token|auth[-_]?token|token|api[-_]?key|key|password|passwd|authorization|cookie|session(?:id)?|credential|auth)$/i.test(key), 'ACCOUNT_DENIED', 'URL authentication parameters are unsupported');
                const t = scope.targets.find(t => t.origins.includes(normalized.origin));
                invariant(t && g.targetIds.includes(t.id) && t.pathPrefixes.some(p => pathWithin(normalized.path, p)), 'TARGET_DENIED', 'Destination is outside granted scope');
                invariant(!scope.exclusions.some(e => e.origin === normalized.origin && e.pathPrefixes.some(p => pathWithin(normalized.path, p))), 'TARGET_DENIED', 'Destination is excluded');
                const method = request.method ?? 'GET';
                invariant(t.methods.includes(method), 'ACTION_DENIED', 'HTTP method not approved');
                const required = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? (request.capability === 'service.inventory' ? 'inventory' : 'read') : 'mutate';
                invariant(request.action === required && t.actions.includes(required), 'ACTION_DENIED', 'Action does not match approved method/tool');
                invariant(request.capability === 'http.request' || ['GET', 'HEAD'].includes(method), 'ACTION_DENIED', 'Observation tools cannot mutate');
                const a = scope.accounts.find(a => a.id === request.accountId);
                invariant(a && g.accountIds.includes(a.id) && t.accounts.includes(a.id) && a.targetIds.includes(t.id) && a.actions.includes(required), 'ACCOUNT_DENIED', 'Account/action not approved');
                invariant(activeTime() < Date.parse(a.expiresAt), 'EXPIRED', 'Account approval expired');
                d = deepFreeze({ scopeDigest, grant: g, target: t, account: a, normalized, capability: request.capability, action: required });
            }
            decisions.set(d, { ...request.context });
            return d;
        },
        authorizeAddress(decision, address) {
            const context = decisions.get(decision);
            invariant(context, 'IDENTITY_DENIED', 'Decision was not issued by this policy');
            assertActive(context);
            invariant(decision.target && decision.normalized && decision.account, 'TARGET_DENIED', 'Offline capability has no network authority');
            invariant(activeTime() < Date.parse(decision.account.expiresAt), 'EXPIRED', 'Account approval expired');
            const a = normalizeAddress(address);
            invariant(!isForbiddenAddress(a) && decision.target.allowedCidrs.some(c => addressInCidr(a, c)) && !decision.target.excludedCidrs?.some(c => addressInCidr(a, c)), 'ADDRESS_DENIED', 'Address is outside approved networks or excluded');
            return a;
        },
    };
    return Object.freeze(api);
}
