import { checkCancelled, invariant } from '../policy/errors.js';
import type { Policy, ToolContext } from '../policy/types.js';
import type { HttpEvidence } from './types.js';

export interface ApiEvidence {
  kind: 'api';
  http: HttpEvidence;
  format: 'openapi-json' | 'json-observation' | 'non-json-observation';
  operations: { method: string; path: string; url: string; scopeDecision: 'allowed' | 'blocked' | 'template-not-expanded' }[];
  keys: string[];
  limits: string[];
}
/** Read only the supplied endpoint; do not dereference remote schemas or invent permissions. */
export function mapApi(http: HttpEvidence, policy: Policy, context: ToolContext, accountId: string, signal?: AbortSignal): ApiEvidence {
  checkCancelled(signal);
  let json: unknown;
  try { json = JSON.parse(http.body); } catch { /* Non-JSON is still an HTTP observation, not a mapping success claim. */ }
  const operations: ApiEvidence['operations'] = [];
  let format: ApiEvidence['format'] = json === undefined ? 'non-json-observation' : 'json-observation';
  let keys: string[] = [];
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    keys = Object.keys(o).slice(0, 128);
    if ((typeof o.openapi === 'string' || o.swagger === '2.0') && o.paths && typeof o.paths === 'object' && !Array.isArray(o.paths)) {
      format = 'openapi-json';
      for (const [path, value] of Object.entries(o.paths)) {
        checkCancelled(signal);
        invariant(operations.length <= 256, 'OUTPUT_LIMIT', 'API operation limit exceeded');
        if (!path.startsWith('/') || path.startsWith('//') || !value || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const method of Object.keys(value)) {
          if (!['get', 'head', 'post', 'put', 'patch', 'delete', 'options'].includes(method)) continue;
          invariant(operations.length < 256, 'OUTPUT_LIMIT', 'API operation limit exceeded');
          const url = new URL(path, new URL(http.finalUrl).origin).href;
          let scopeDecision: ApiEvidence['operations'][number]['scopeDecision'] = 'blocked';
          if (/[{}]/.test(path)) scopeDecision = 'template-not-expanded';
          else {
            try { policy.authorize({ context, capability: 'api.map', action: 'read', method: method.toUpperCase(), url, accountId }); scopeDecision = 'allowed'; } catch { /* Discovered routes confer no authority. */ }
          }
          operations.push({ method: method.toUpperCase(), path: path.slice(0, 1024), url, scopeDecision });
        }
      }
    }
  }
  return { kind: 'api', http, format, operations, keys, limits: ['Only this endpoint was requested; discovered operations were not tested.', 'OpenAPI servers, remote references, credentials, templates and state-changing operations are never followed automatically.'] };
}
