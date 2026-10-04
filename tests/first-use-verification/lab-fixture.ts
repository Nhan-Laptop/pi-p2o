/**
 * MODEL-INERT local lab fixture for first-use verification tests.
 *
 * It is a real loopback HTTP server with one bounded differential: the anonymous actor may read the alpha item
 * under `tenant=alpha`, a mismatched tenant claim is rejected, and the beta item is returned when the tenant
 * parameter merely names beta. `enforceTenantBoundary()` (or the single-shot latch) makes the beta read behave
 * like the control, which is how the negative-control test proves the pipeline rejects instead of trusting the
 * producing attempt. No external network, no model, no repository script.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LabRequest {
  method: string;
  url: string;
}

export interface LabFixture {
  origin: string;
  /** Base path prefix the owner-approved target is scoped to. */
  path: string;
  requests: readonly LabRequest[];
  /** Latch the guard: the cross-tenant read is denied exactly like the approved control from now on. */
  enforceTenantBoundary(): void;
  close(): Promise<void>;
}

interface Options {
  /** When true, the vulnerable read can be served exactly once and then the guard latches (stateful fixture). */
  latchAfterViolation?: boolean;
  /** When true, the guard is enforced from the first request (safe fixture). */
  enforceTenantBoundary?: boolean;
}

function json(status: number, body: Record<string, unknown>): { status: number; body: string } {
  return { status, body: JSON.stringify(body) };
}

export async function startLabFixture(options: Options = {}): Promise<LabFixture> {
  const requests: LabRequest[] = [];
  let enforce = options.enforceTenantBoundary === true;
  const path = '/lab';
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    requests.push({ method: request.method ?? 'GET', url: `${url.pathname}${url.search}` });
    const item = url.searchParams.get('id');
    const tenant = url.searchParams.get('tenant');
    const send = (result: { status: number; body: string }): void => {
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(result.body);
    };
    if (url.pathname !== `${path}/item` || request.method !== 'GET' || !item || !tenant) {
      send(json(404, { error: 'unknown_route' }));
      return;
    }
    if (item === 'i-100' && tenant === 'alpha') {
      send(json(200, { tenant: 'alpha', value: 'alpha-value' }));
      return;
    }
    if (item === 'i-100' && tenant === 'beta') {
      send(json(403, { error: 'tenant_mismatch' }));
      return;
    }
    if (item === 'i-200' && tenant === 'beta') {
      if (enforce) {
        send(json(403, { error: 'tenant_mismatch' }));
        return;
      }
      send(json(200, { tenant: 'beta', value: 'beta-secret' }));
      if (options.latchAfterViolation === true) enforce = true;
      return;
    }
    send(json(403, { error: 'tenant_mismatch' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    path,
    requests,
    enforceTenantBoundary() { enforce = true; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
