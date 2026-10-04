import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { digestJson, type JsonObject } from '../../src/contracts/index.js';

export interface FixtureItem { id: string; tenant: string; value: string }

export interface FixtureInstance {
  origin: string;
  port: number;
  environmentId: string;
  instanceId: string;
  configurationDigest: string;
  items: readonly FixtureItem[];
  /** Number of requests the instance answered (tests assert pre-dispatch budget enforcement). */
  requests: number;
  /** In-flight requests right now (measurement only). */
  active: number;
  /** Extra concurrency evidence for the overlap regression: highest simultaneous in-flight request count. */
  maxConcurrent: number;
  /** Safe variant flag: the export route enforces the tenant boundary. */
  readonly enforceExportTenant: boolean;
  close(): Promise<void>;
}

export interface FixtureOptions {
  environmentId: string;
  instanceId?: string;
  port: number;
  /** Configuration identity of the assessed fixture build; must match the approved task scope. */
  configurationDigest: string;
  items?: readonly FixtureItem[];
  /** "Safe" fixture variant: the export route enforces the tenant boundary (used to prove controller-side checks). */
  enforceExportTenant?: boolean;
}

export const FIXTURE_ROUTES = Object.freeze([
  'GET /healthz',
  'GET /api/v1/items/{id}?tenant={tenant} (guarded by exact tenant equality)',
  'GET /api/v1/export?item={id} (no tenant check; seeded defect)',
  'GET / (static index)',
]);

export const FIXTURE_ITEMS: readonly FixtureItem[] = Object.freeze([
  { id: 'i-100', tenant: 'alpha', value: 'alpha-tenant-value' },
  { id: 'i-200', tenant: 'beta', value: 'beta-tenant-value' },
]);

/** Content identity of the fixture build, independent of the environment/instance identity. */
export function fixtureBuildDigest(): string {
  return digestJson({ fixture: 'loopback-tenant-lab', version: 1, routes: [...FIXTURE_ROUTES], items: FIXTURE_ITEMS.map(i => ({ id: i.id, tenant: i.tenant })) });
}

function send(response: ServerResponse, status: number, body: JsonObject | string): void {
  const payload = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  response.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store' });
  response.end(payload);
}

/**
 * Bounded server-side response delay, selected only by an owner-approved observation input. Two owned workers
 * issuing delayed approved checks therefore overlap inside the fixture itself, which the concurrency regression
 * asserts through `maxConcurrent`; the delay never changes the status or the body and is capped at 2s.
 */
function boundedDelayMs(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 2_000) : 0;
}

function handle(instance: FixtureInstance, request: IncomingMessage, response: ServerResponse): void {
  instance.requests += 1;
  instance.active += 1;
  if (instance.active > instance.maxConcurrent) instance.maxConcurrent = instance.active;
  const url = new URL(request.url ?? '/', instance.origin);
  const delayMs = boundedDelayMs(url.searchParams.get('delayMs'));
  let settled = false;
  const respond = (status: number, body: JsonObject | string): void => {
    if (settled) return;
    settled = true;
    const finish = (): void => {
      instance.active -= 1;
      if (response.destroyed || response.writableEnded) return;
      send(response, status, body);
    };
    if (delayMs > 0) setTimeout(finish, delayMs);
    else finish();
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') { respond(405, { error: 'method_not_allowed' }); return; }
  if (url.pathname === '/healthz') {
    respond(200, {
      ok: true, fixture: 'loopback-tenant-lab', version: 1,
      environmentId: instance.environmentId, instanceId: instance.instanceId,
      configurationDigest: instance.configurationDigest, items: instance.items.map(i => i.id),
    });
    return;
  }
  if (url.pathname === '/') {
    respond(200, `<!doctype html><title>loopback tenant lab</title><h1>${instance.environmentId}</h1><ul>${FIXTURE_ROUTES.map(r => `<li>${r}</li>`).join('')}</ul>`);
    return;
  }
  const readMatch = /^\/api\/v1\/items\/([A-Za-z0-9_-]{1,32})$/.exec(url.pathname);
  if (readMatch) {
    const item = instance.items.find(candidate => candidate.id === readMatch[1]);
    if (!item) { respond(404, { error: 'not_found' }); return; }
    const tenant = url.searchParams.get('tenant') ?? '';
    // The guarded read route requires an exact tenant match. Case is not normalized.
    if (tenant !== item.tenant) { respond(403, { error: 'tenant_mismatch', route: 'read' }); return; }
    respond(200, { id: item.id, tenant: item.tenant, kind: 'item' });
    return;
  }
  if (url.pathname === '/api/v1/export') {
    const id = url.searchParams.get('item') ?? '';
    const item = instance.items.find(candidate => candidate.id === id);
    if (!item) { respond(404, { error: 'not_found' }); return; }
    if (instance.enforceExportTenant === true) {
      const tenant = url.searchParams.get('tenant') ?? '';
      if (tenant !== item.tenant) { respond(403, { error: 'tenant_mismatch', route: 'export' }); return; }
    }
    // Seeded defect (default variant): the export route returns the tenant value without any tenant check.
    respond(200, { id: item.id, tenant: item.tenant, value: item.value, exported: true, route: 'export' });
    return;
  }
  respond(404, { error: 'not_found' });
}

/** Start one loopback-only fixture instance. No external interface, no target code execution. */
export async function startFixture(options: FixtureOptions): Promise<FixtureInstance> {
  const instance = {
    environmentId: options.environmentId,
    instanceId: options.instanceId ?? createHash('sha256').update(`${options.environmentId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16),
    configurationDigest: options.configurationDigest,
    items: options.items ?? FIXTURE_ITEMS,
    enforceExportTenant: options.enforceExportTenant === true,
    requests: 0,
    active: 0,
    maxConcurrent: 0,
    origin: '',
    port: options.port,
    close: async (): Promise<void> => {},
  } as FixtureInstance;
  let server: Server;
  const binding = new Promise<void>((resolve, reject) => {
    server = createServer((request, response) => handle(instance, request, response));
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  await binding;
  const address = server!.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP address');
  (instance as { origin: string }).origin = `http://127.0.0.1:${address.port}`;
  (instance as { port: number }).port = address.port;
  (instance as { close: () => Promise<void> }).close = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return instance;
}

/** Stable loopback origin reserved for the clean verifier environment. Loopback only, never external. */
export function fixtureOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}
