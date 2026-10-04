import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { checkCancelled, invariant, PolicyError } from '../policy/errors.js';
import { normalizeAddress, stableAddressSet } from '../policy/network.js';
import { normalizeWebTarget } from '../policy/targets.js';
import { sha256 } from './redaction.js';
export async function abortable(promise, signal) {
    checkCancelled(signal);
    if (!signal)
        return promise;
    return new Promise((resolve, reject) => {
        const abort = () => reject(new PolicyError('CANCELLED', 'Operation cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        promise.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted)
            abort();
        else
            resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
        if (signal.aborted)
            abort();
    });
}
const defaultResolver = async (hostname, signal) => {
    checkCancelled(signal);
    if (net.isIP(hostname))
        return [hostname];
    const records = await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
    return records.map(r => r.address);
};
const callerHeaders = new Set(['accept', 'accept-language', 'content-type', 'if-match', 'if-none-match', 'idempotency-key']);
const credentialHeaders = new Set(['authorization', 'cookie', 'x-api-key', 'x-csrf-token']);
function validateHeaders(input, permitted) {
    invariant(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length <= 24, 'INVALID_INPUT', 'Invalid header object');
    const result = {};
    let bytes = 0;
    for (const [key, value] of Object.entries(input)) {
        const lower = key.toLowerCase();
        invariant(permitted.has(lower) && !Object.hasOwn(result, lower), 'ACCOUNT_DENIED', 'Unapproved/duplicate header');
        invariant(typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value), 'INVALID_INPUT', 'Header control characters forbidden');
        bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
        invariant(bytes <= 8192, 'INVALID_INPUT', 'Header bytes exceeded');
        result[lower] = value;
    }
    return result;
}
const identityField = /^(?:authorization|password|passwd|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|api[-_]?key|cookie|session(?:id)?|credential|secret)$/i;
function assertNoBodyCredentials(body) {
    if (!body)
        return;
    const visit = (value, depth = 0) => {
        invariant(depth < 24, 'INVALID_INPUT', 'Request body nesting exceeded');
        if (Array.isArray(value)) {
            value.forEach(v => visit(v, depth + 1));
            return;
        }
        if (value && typeof value === 'object')
            for (const [key, child] of Object.entries(value)) {
                invariant(!identityField.test(key), 'ACCOUNT_DENIED', 'Body authentication/secret fields require an application-specific approved action adapter');
                visit(child, depth + 1);
            }
    };
    let json;
    try {
        json = JSON.parse(body);
    }
    catch { /* Raw authorized differential-test bodies remain supported. */ }
    if (json !== undefined)
        visit(json);
    for (const key of new URLSearchParams(body).keys())
        invariant(!identityField.test(key), 'ACCOUNT_DENIED', 'Form authentication fields are unsupported');
    invariant(!/(?:name\s*=\s*["'](?:password|passwd|token|secret|authorization|cookie)["'])/i.test(body), 'ACCOUNT_DENIED', 'Multipart identity fields are unsupported');
}
function responseHeaders(raw) {
    return Object.fromEntries(Object.entries(raw).filter((e) => e[1] !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join('\n') : v]));
}
export function createHttpAdapter(options) {
    const resolver = options.resolver ?? defaultResolver;
    async function resolveApproved(decision, signal) {
        checkCancelled(signal);
        const answers = await abortable(resolver(decision.normalized.hostname, signal), signal);
        checkCancelled(signal);
        const addresses = stableAddressSet(answers);
        for (const address of addresses) {
            options.policy.authorizeAddress(decision, address);
            options.sandbox.assertEgress(address);
        }
        return addresses;
    }
    return Object.freeze({
        async request(execution) {
            const { context, capability, input, descriptor, signal, touchedTargets } = execution;
            const method = input.method ?? 'GET';
            const action = execution.action ?? input.action ?? 'read';
            const body = input.body ?? '';
            invariant(!['GET', 'HEAD', 'OPTIONS'].includes(method) || input.body === undefined, 'ACTION_DENIED', 'Read requests cannot carry bodies');
            invariant(Buffer.byteLength(body) <= 65536, 'INVALID_INPUT', 'Request body too large');
            assertNoBodyCredentials(body);
            const maxBytes = input.maxResponseBytes ?? descriptor.limits.maxResponseBytes;
            const redirects = input.maxRedirects ?? descriptor.limits.maxRedirects;
            invariant(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= descriptor.limits.maxResponseBytes && Number.isSafeInteger(redirects) && redirects >= 0 && redirects <= descriptor.limits.maxRedirects, 'INVALID_INPUT', 'Response/redirect limits cannot be widened');
            const publicHeaders = validateHeaders(input.headers ?? {}, callerHeaders);
            const hops = [];
            let url = input.url;
            const firstOrigin = normalizeWebTarget(url).origin;
            for (;;) {
                checkCancelled(signal);
                const decision = options.policy.authorize({ context, capability, action, url, method, accountId: input.accountId });
                invariant(decision.normalized.origin === firstOrigin, 'REDIRECT_DENIED', 'Redirect cannot cross origin/account boundaries');
                touchedTargets.add(decision.target.id);
                const reservation = options.budgets.reserve(decision.target.id);
                const agent = decision.normalized.protocol === 'https:' ? new https.Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 }) : new http.Agent({ keepAlive: false, maxSockets: 1 });
                let pendingSocket;
                try {
                    const dispatched = await resolveApproved(decision, signal);
                    const selected = dispatched[0];
                    let authHeaders = {};
                    if (decision.account.kind === 'credential') {
                        invariant(options.credentials, 'ACCOUNT_DENIED', 'Approved account has no credential-owning provider');
                        authHeaders = validateHeaders(await abortable(options.credentials.headers({ accountId: decision.account.id, targetId: decision.target.id, origin: decision.normalized.origin, action, signal }), signal), credentialHeaders);
                        invariant(Object.keys(authHeaders).length > 0, 'ACCOUNT_DENIED', 'Credential provider supplied no account identity');
                        options.redactor.register(Object.values(authHeaders));
                        // Register credential values as well as the header, including echoed bearer/cookie secrets.
                        for (const [key, value] of Object.entries(authHeaders)) {
                            if (key === 'authorization') {
                                const token = value.split(/\s+/).slice(1).join(' ');
                                if (token)
                                    options.redactor.register([token]);
                            }
                            if (key === 'cookie')
                                for (const part of value.split(';')) {
                                    const v = part.slice(part.indexOf('=') + 1).trim();
                                    if (v)
                                        options.redactor.register([v]);
                                }
                        }
                    }
                    const headers = { ...publicHeaders, ...authHeaders, 'accept-encoding': 'identity', 'user-agent': 'pi-p2o-broker/1.0.0', ...(input.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) };
                    reservation.consumeBytes(Buffer.byteLength(body) + Buffer.byteLength(decision.normalized.url) + Buffer.byteLength(JSON.stringify(headers)));
                    // Return NO socket synchronously: HTTP bytes stay queued until DNS/peer checks pass.
                    const guardedConnect = (_connectionOptions, callback) => {
                        let settled = false;
                        const done = (error, socket) => { if (!settled) {
                            settled = true;
                            callback(error, socket);
                        } };
                        void (async () => {
                            const atConnect = await resolveApproved(decision, signal);
                            invariant(JSON.stringify(atConnect) === JSON.stringify(dispatched), 'DNS_CHANGED', 'DNS changed between dispatch and connection');
                            checkCancelled(signal);
                            options.policy.authorizeAddress(decision, selected);
                            options.sandbox.assertEgress(selected);
                            const endpoint = { host: selected, port: decision.normalized.port, family: net.isIP(selected), autoSelectFamily: false };
                            const secure = decision.normalized.protocol === 'https:';
                            const socket = secure ? tls.connect({ ...endpoint, servername: net.isIP(decision.normalized.hostname) ? undefined : decision.normalized.hostname, rejectUnauthorized: true, checkServerIdentity: (_hostname, certificate) => tls.checkServerIdentity(decision.normalized.hostname, certificate), ALPNProtocols: ['http/1.1'] }) : net.connect(endpoint);
                            pendingSocket = socket;
                            const cancel = () => { socket.destroy(new PolicyError('CANCELLED', 'Connection cancelled')); done(new PolicyError('CANCELLED', 'Connection cancelled')); };
                            signal?.addEventListener('abort', cancel, { once: true });
                            socket.once('close', () => signal?.removeEventListener('abort', cancel));
                            socket.once('error', () => done(new PolicyError('UNAVAILABLE', 'Connection/TLS failed')));
                            socket.once(secure ? 'secureConnect' : 'connect', () => {
                                try {
                                    checkCancelled(signal);
                                    invariant(socket.remoteAddress && normalizeAddress(socket.remoteAddress) === selected && socket.remotePort === decision.normalized.port, 'PEER_MISMATCH', 'Connected peer does not match pinned endpoint');
                                    options.policy.authorizeAddress(decision, socket.remoteAddress);
                                    options.sandbox.assertEgress(socket.remoteAddress);
                                    done(null, socket);
                                }
                                catch (e) {
                                    socket.destroy();
                                    done(e);
                                }
                            });
                            if (signal?.aborted)
                                cancel();
                        })().catch(e => done(e instanceof PolicyError ? e : new PolicyError('UNAVAILABLE', 'DNS/connection failed')));
                        return undefined;
                    };
                    agent.createConnection = guardedConnect;
                    const response = await new Promise((resolve, reject) => {
                        let responseFailure;
                        const request = (decision.normalized.protocol === 'https:' ? https : http).request(decision.normalized.url, { method, headers, agent, maxHeaderSize: 16384 }, response => {
                            const chunks = [];
                            let bytes = 0;
                            const responseFields = responseHeaders(response.headers);
                            response.once('error', e => reject(responseFailure ?? (e instanceof PolicyError ? e : new PolicyError('UNAVAILABLE', 'Response failed'))));
                            response.once('aborted', () => reject(responseFailure ?? new PolicyError('UNAVAILABLE', 'Response was incomplete')));
                            try {
                                reservation.consumeBytes(Buffer.byteLength(JSON.stringify(responseFields)));
                            }
                            catch (e) {
                                responseFailure = e;
                                reject(responseFailure);
                                request.destroy(responseFailure);
                                return;
                            }
                            response.on('data', (chunk) => {
                                try {
                                    checkCancelled(signal);
                                    options.policy.authorizeAddress(decision, selected);
                                    options.sandbox.assertEgress(selected);
                                    bytes += chunk.length;
                                    reservation.consumeBytes(chunk.length);
                                    invariant(bytes <= maxBytes, 'OUTPUT_LIMIT', 'HTTP response byte limit exceeded');
                                    chunks.push(chunk);
                                }
                                catch (e) {
                                    responseFailure ??= e;
                                    reject(responseFailure);
                                    response.destroy(responseFailure);
                                    request.destroy(responseFailure);
                                }
                            });
                            response.once('end', () => {
                                try {
                                    checkCancelled(signal);
                                    options.policy.authorizeAddress(decision, selected);
                                    options.sandbox.assertEgress(selected);
                                    resolve({ status: response.statusCode ?? 0, headers: responseFields, raw: Buffer.concat(chunks, bytes) });
                                }
                                catch (e) {
                                    reject(e);
                                }
                            });
                        });
                        const cancel = () => { pendingSocket?.destroy(); request.destroy(new PolicyError('CANCELLED', 'HTTP request cancelled')); };
                        signal?.addEventListener('abort', cancel, { once: true });
                        request.once('close', () => signal?.removeEventListener('abort', cancel));
                        request.once('error', e => reject(responseFailure ?? (e instanceof PolicyError ? e : new PolicyError('UNAVAILABLE', 'HTTP request failed'))));
                        request.setTimeout(descriptor.limits.timeoutMs, () => request.destroy(new PolicyError('TIMEOUT', 'HTTP socket timed out')));
                        request.end(body);
                        if (signal?.aborted)
                            cancel();
                    });
                    const hop = { url: decision.normalized.url, status: response.status, method, accountId: decision.account.id, action, pinnedAddress: selected, dnsAddresses: dispatched, headers: response.headers, responseBytes: response.raw.length };
                    hops.push(hop);
                    const location = response.headers.location;
                    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
                        invariant(action === 'read' || action === 'inventory', 'REDIRECT_DENIED', 'State-changing redirects are never replayed');
                        invariant(hops.length <= redirects, 'REDIRECT_DENIED', 'Redirect hop limit exceeded');
                        invariant(!/[\\\u0000-\u0020\u007f]/.test(location) && !/%(?:2f|5c|2e|25)/i.test(location.split(/[?#]/, 1)[0]), 'REDIRECT_DENIED', 'Ambiguous redirect location');
                        let next;
                        try {
                            next = new URL(location, decision.normalized.url).href;
                        }
                        catch {
                            throw new PolicyError('REDIRECT_DENIED', 'Invalid redirect location');
                        }
                        invariant(normalizeWebTarget(next).origin === firstOrigin, 'REDIRECT_DENIED', 'Cross-origin redirect denied');
                        // Authorize before following; exclusions/actions/accounts/DNS are checked again next hop.
                        options.policy.authorize({ context, capability, action, url: next, method, accountId: input.accountId });
                        url = next;
                        continue;
                    }
                    return { kind: 'http', hops, finalUrl: decision.normalized.url, status: response.status, headers: response.headers, body: response.raw.toString('utf8'), bodySha256: sha256(response.raw) };
                }
                finally {
                    pendingSocket?.destroy();
                    agent.destroy();
                    reservation.release();
                }
            }
        },
    });
}
