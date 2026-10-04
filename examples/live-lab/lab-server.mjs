#!/usr/bin/env node
// Intentionally vulnerable loopback lab target for the live vertical slice.
//
// This file is deliberately, safely broken: it is a small dependency-free HTTP service that seeds two
// tenants, two accounts and two item secrets, and it contains two seeded access-control defects that the
// live assessment is supposed to find:
//
//   [LAB-VULN-1] GET /api/v1/items/:id authorizes on the CLIENT-SUPPLIED `tenant` query parameter
//                instead of the authenticated session's tenant, so the alpha member can read the beta
//                item by asserting the matching tenant value (cross-tenant read / IDOR).
//   [LAB-VULN-2] GET /api/v1/export is documented as admin-only own-tenant export but performs no role
//                check and no tenant check, so any authenticated member can export any tenant's secret.
//
// It is safe to run: loopback-only, seeded and deterministic, no external dependencies, no writes, no
// outbound traffic, no command execution. Routes are registered as `app.get(...)`/`app.post(...)` so the
// pinned offline source-analysis pack records the route table as lexical evidence.
//
// Usage (the harness starts it in-process; this CLI form is for manual poking):
//   node examples/live-lab/lab-server.mjs [port]
import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const LAB_NAME = 'live-lab-tenant-api';
export const LAB_VERSION = 1;
export const LAB_ROUTES = Object.freeze([
  'POST /api/v1/session',
  'GET /healthz',
  'GET /api/v1/items/{id}?tenant={tenant} (guarded read; defect: compares the client parameter, not the session tenant)',
  'GET /api/v1/export?item={id} (defect: no role check and no tenant check)',
  'GET /api/v1/export/secure?item={id} (guarded variant: admin-only and own-tenant only)',
  'GET / (static index)',
]);

/** Seeded tenants and items. Deterministic: every instance serves exactly these records. */
export const LAB_ITEMS = Object.freeze([
  Object.freeze({ id: 'i-100', tenant: 'alpha', label: 'alpha-invoice', value: 'alpha-live-value' }),
  Object.freeze({ id: 'i-200', tenant: 'beta', label: 'beta-invoice', value: 'beta-live-value' }),
]);

/**
 * Seeded lab accounts. These passwords are fixture data for a deliberately vulnerable loopback lab, never
 * real credentials; the broker injects the resulting session token at dispatch and the harness holds it
 * in memory only.
 */
export const LAB_ACCOUNTS = Object.freeze([
  Object.freeze({ accountId: 'acct-guest', tenant: 'alpha', role: 'member', password: 'guest-live-fixture-password' }),
  Object.freeze({ accountId: 'acct-admin', tenant: 'beta', role: 'admin', password: 'admin-live-fixture-password' }),
]);


const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });

function send(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  if (typeof body === 'string') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(body);
    return;
  }
  response.writeHead(status, JSON_HEADERS);
  response.end(`${JSON.stringify(body)}\n`);
}

function equalSecret(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** Minimal exact-path router; patterns use `:name` segments. Registration order is the route table. */
function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler) => {
    const segments = pattern.split('/');
    routes.push({ method, pattern, segments, handler });
  };
  return {
    routes,
    get: add('GET'),
    head: add('HEAD'),
    post: add('POST'),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const parts = pathname.split('/');
        if (parts.length !== route.segments.length) continue;
        const params = {};
        let matched = true;
        for (let index = 0; index < parts.length; index += 1) {
          const expected = route.segments[index];
          if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(parts[index]);
          else if (expected !== parts[index]) { matched = false; break; }
        }
        if (matched) return { route, params };
      }
      return undefined;
    },
  };
}

function readBody(request, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) { reject(new Error('body too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function handle(instance, request, response) {
  instance.requests += 1;
  const url = new URL(request.url ?? '/', instance.origin);
  const method = request.method === 'HEAD' ? 'HEAD' : request.method ?? 'GET';
  const sessions = instance.__sessions;
  const itemsById = new Map(LAB_ITEMS.map((item) => [item.id, item]));
  const app = instance.__app;

  /** Session gate only: every tenant-scoped route requires a live session token. */
  const requireSession = () => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const session = sessions.get(token);
    if (!session) {
      send(response, 401, { error: 'session_required' });
      return undefined;
    }
    return session;
  };

  const matched = app.match(method === 'HEAD' ? 'GET' : method, url.pathname);
  if (!matched) { send(response, 404, { error: 'not_found' }); return; }
  matched.route.handler({ request, response, url, params: matched.params, requireSession, itemsById });
}

/**
 * Start one loopback-only lab instance. The instance serves seeded records and mints a fresh session token
 * per seeded account; it never mutates state and never contacts anything outside 127.0.0.1.
 */
export async function startLabServer(options) {
  const environmentId = String(options.environmentId);
  const configurationDigest = String(options.configurationDigest);
  const port = Number.isSafeInteger(options.port) ? options.port : 0;
  // Each environment instance seeds its own account identities; every instance keeps the same
  // tenants/items/roles so two environments are the same approved build with distinct sessions.
  const accounts = Array.isArray(options.accounts) && options.accounts.length ? options.accounts : LAB_ACCOUNTS;

  const sessions = new Map();
  const tokens = new Map();
  for (const account of accounts) {
    const token = `lab-${account.accountId}-${randomUUID().replaceAll('-', '')}`;
    tokens.set(account.accountId, token);
    sessions.set(token, { accountId: account.accountId, tenant: account.tenant, role: account.role });
  }

  const app = createRouter();

  // Owner-side login for the seeded fixture accounts. Never reached by the assessment (no check approves it).
  app.post('/api/v1/session', async ({ request, response }) => {
    let body;
    try { body = JSON.parse(await readBody(request)); } catch { send(response, 400, { error: 'invalid_json' }); return; }
    const account = instance.__accounts.find((candidate) => candidate.accountId === body?.accountId);
    if (!account || !equalSecret(body?.password, account.password)) { send(response, 401, { error: 'invalid_credentials' }); return; }
    send(response, 200, { token: tokens.get(account.accountId), accountId: account.accountId, tenant: account.tenant, role: account.role, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  });

  app.get('/healthz', ({ response }) => {
    send(response, 200, {
      ok: true, lab: LAB_NAME, version: LAB_VERSION,
      environmentId: instance.environmentId, instanceId: instance.instanceId,
      configurationDigest: instance.configurationDigest,
      tenants: ['alpha', 'beta'], accounts: instance.__accounts.map((account) => account.accountId),
      items: LAB_ITEMS.map((item) => item.id), routes: [...LAB_ROUTES],
    });
  });

  app.get('/', ({ response }) => {
    send(response, 200, `<!doctype html><title>${LAB_NAME}</title><h1>${instance.environmentId}</h1><ul>${LAB_ROUTES.map((route) => `<li>${route}</li>`).join('')}</ul>`);
  });

  app.get('/api/v1/items/:id', ({ response, url, params, requireSession, itemsById }) => {
    const session = requireSession();
    if (!session) return;
    const item = itemsById.get(params.id);
    if (!item) { send(response, 404, { error: 'not_found' }); return; }
    const requestedTenant = url.searchParams.get('tenant') ?? '';
    // [LAB-VULN-1] The authorization decision compares the CLIENT-SUPPLIED tenant parameter with the item.
    // The authenticated session's own tenant is never consulted, so any tenant spelling that matches the
    // target item is accepted.
    if (requestedTenant !== item.tenant) { send(response, 403, { error: 'tenant_mismatch', route: 'read' }); return; }
    send(response, 200, { kind: 'item', id: item.id, tenant: item.tenant, label: item.label, requestedBy: session.accountId, sessionTenant: session.tenant });
  });

  app.get('/api/v1/export/secure', ({ response, url, requireSession, itemsById }) => {
    const session = requireSession();
    if (!session) return;
    const item = itemsById.get(url.searchParams.get('item') ?? '');
    if (!item) { send(response, 404, { error: 'not_found' }); return; }
    // The documented contract, enforced: admin-only and own-tenant only. This guarded sibling exists in the
    // same build as the unguarded `/api/v1/export` above, which is what makes that route the outlier.
    if (session.role !== 'admin' || item.tenant !== session.tenant) { send(response, 403, { error: 'forbidden', route: 'export-secure' }); return; }
    send(response, 200, { kind: 'export', id: item.id, tenant: item.tenant, value: item.value, exported: true, requestedBy: session.accountId, sessionTenant: session.tenant });
  });

  app.get('/api/v1/export', ({ response, url, requireSession, itemsById }) => {
    const session = requireSession();
    if (!session) return;
    const item = itemsById.get(url.searchParams.get('item') ?? '');
    if (!item) { send(response, 404, { error: 'not_found' }); return; }
    // [LAB-VULN-2] Documented contract: admin-only, own-tenant export. Neither the role nor the tenant
    // boundary is enforced, so a plain member receives any tenant's secret value.
    send(response, 200, { kind: 'export', id: item.id, tenant: item.tenant, value: item.value, exported: true, requestedBy: session.accountId, sessionTenant: session.tenant });
  });

  const instance = {
    environmentId,
    instanceId: options.instanceId ? String(options.instanceId) : createHash('sha256').update(`${environmentId}:${randomUUID()}`).digest('hex').slice(0, 16),
    configurationDigest,
    items: LAB_ITEMS,
    accounts: accounts.map(({ accountId, tenant, role }) => ({ accountId, tenant, role })),
    requests: 0,
    origin: '',
    port,
    __accounts: accounts,
    __sessions: sessions,
    __app: app,
    close: async () => {},
  };

  let server;
  await new Promise((resolve, reject) => {
    server = createServer((request, response) => {
      try { handle(instance, request, response); }
      catch { send(response, 500, { error: 'lab_error' }); }
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('lab server did not bind a loopback TCP address');
  instance.origin = `http://127.0.0.1:${address.port}`;
  instance.port = address.port;
  instance.tokenFor = (accountId) => tokens.get(accountId);
  instance.close = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return instance;
}

/** Stable loopback origin for a reserved verifier port. */
export function labOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.argv[2] ?? '0', 10);
  const instance = await startLabServer({ environmentId: 'lab-live-manual', port: Number.isSafeInteger(port) ? port : 0, configurationDigest: 'manual' });
  process.stdout.write(`${LAB_NAME} listening on ${instance.origin} (seeded tenants alpha/beta; intentionally vulnerable)\n`);
}
