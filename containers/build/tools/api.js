import { checkCancelled, invariant } from '../policy/errors.js';
/** Read only the supplied endpoint; do not dereference remote schemas or invent permissions. */
export function mapApi(http, policy, context, accountId, signal) {
    checkCancelled(signal);
    let json;
    try {
        json = JSON.parse(http.body);
    }
    catch { /* Non-JSON is still an HTTP observation, not a mapping success claim. */ }
    const operations = [];
    let format = json === undefined ? 'non-json-observation' : 'json-observation';
    let keys = [];
    if (json && typeof json === 'object' && !Array.isArray(json)) {
        const o = json;
        keys = Object.keys(o).slice(0, 128);
        if ((typeof o.openapi === 'string' || o.swagger === '2.0') && o.paths && typeof o.paths === 'object' && !Array.isArray(o.paths)) {
            format = 'openapi-json';
            for (const [path, value] of Object.entries(o.paths)) {
                checkCancelled(signal);
                invariant(operations.length <= 256, 'OUTPUT_LIMIT', 'API operation limit exceeded');
                if (!path.startsWith('/') || path.startsWith('//') || !value || typeof value !== 'object' || Array.isArray(value))
                    continue;
                for (const method of Object.keys(value)) {
                    if (!['get', 'head', 'post', 'put', 'patch', 'delete', 'options'].includes(method))
                        continue;
                    invariant(operations.length < 256, 'OUTPUT_LIMIT', 'API operation limit exceeded');
                    const url = new URL(path, new URL(http.finalUrl).origin).href;
                    let scopeDecision = 'blocked';
                    if (/[{}]/.test(path))
                        scopeDecision = 'template-not-expanded';
                    else {
                        try {
                            policy.authorize({ context, capability: 'api.map', action: 'read', method: method.toUpperCase(), url, accountId });
                            scopeDecision = 'allowed';
                        }
                        catch { /* Discovered routes confer no authority. */ }
                    }
                    operations.push({ method: method.toUpperCase(), path: path.slice(0, 1024), url, scopeDecision });
                }
            }
        }
    }
    return { kind: 'api', http, format, operations, keys, limits: ['Only this endpoint was requested; discovered operations were not tested.', 'OpenAPI servers, remote references, credentials, templates and state-changing operations are never followed automatically.'] };
}
