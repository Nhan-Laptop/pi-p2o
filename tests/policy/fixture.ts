import type { Scope, ToolContext } from '../../src/policy/index.js';

export const context: ToolContext = { runId: 'fixture-run', taskId: 'fixture-task', attemptId: 'fixture-attempt', grantId: 'fixture-grant' };
export const NOW = Date.parse('2026-10-02T12:00:00.000Z');
export function fixtureScope(origin = 'http://127.0.0.1:32123'): Scope {
  const expiresAt = '2099-10-02T13:00:00.000Z';
  return {
    version: 1, runId: context.runId,
    authorization: { reference: 'local-fixture-owner-approval', approvedBy: 'fixture-owner', notBefore: '2026-10-01T00:00:00.000Z', expiresAt },
    targets: [{ id: 'fixture-target', origins: [origin], pathPrefixes: ['/'], allowedCidrs: ['127.0.0.0/8', '::1/128'], excludedCidrs: ['127.0.0.9/32'], methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'], actions: ['read', 'inventory', 'mutate'], accounts: ['anonymous', 'approved-user'], limits: { maxRequests: 100, maxBytes: 20000000, maxConcurrent: 4, rate: { requests: 100, windowMs: 1000 } } }],
    exclusions: [{ origin, pathPrefixes: ['/excluded'] }],
    accounts: [
      { id: 'anonymous', targetIds: ['fixture-target'], actions: ['read', 'inventory', 'mutate'], expiresAt, kind: 'anonymous' },
      { id: 'approved-user', targetIds: ['fixture-target'], actions: ['read', 'mutate'], expiresAt, kind: 'credential' },
    ],
    grants: [{ id: context.grantId, taskId: context.taskId, attemptId: context.attemptId, role: 'worker', capabilities: ['source.analyze', 'http.request', 'web.observe', 'api.map', 'service.inventory'], targetIds: ['fixture-target'], actions: ['analyze', 'read', 'inventory', 'mutate'], accountIds: ['anonymous', 'approved-user'], expiresAt, maxCalls: 100, maxArtifactBytes: 20000000 }],
  };
}
