/**
 * planning_update.md P2 (path "a"): the frozen-mode static server. It serves a snapshot directory this repository wrote —
 * generated data files and the copied Next export — on loopback only, GET/HEAD only, with no write route, no control route
 * and no model or target call. Live state and the per-launch token are P3, so this server reads nothing but the directory.
 *
 * The path mapping is a closed map (URL path -> file under the snapshot root, with `index.html` for directory routes), never a
 * concatenation of user input: `..`, encoded separators, control characters, symlinks and non-regular files are refused, and a
 * resolved target must still live under the real snapshot root.
 */
import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, sep } from 'node:path';
import { snapshotDirectory } from './snapshot.js';

export const DASHBOARD_SERVE_HOST = '127.0.0.1';
/**
 * `script-src`/`style-src` allow inline because the static Next export inlines its hydration bootstrap and style payloads;
 * that is the only relaxation. The client has no HTML-injection path (a source test pins `dangerouslySetInnerHTML` out), every
 * data value is rendered as React text, and no directive admits an external origin.
 */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Extensions the snapshot can contain; anything else is a 404, not an unknown content type. */
export const DASHBOARD_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface DashboardServerOptions { directory: string; port?: number }
export interface DashboardServer { directory: string; host: string; port: number; url: string; close: () => Promise<void> }

const baseHeaders = (): Record<string, string> => ({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': DASHBOARD_CSP,
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'no-store',
});

const reject = (response: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void => {
  response.writeHead(status, { ...baseHeaders(), 'content-type': 'text/plain; charset=utf-8', ...extra });
  response.end(`${message}\n`);
};

/** Map a URL pathname to a file path under the snapshot root, or `null` for anything that is not a plain file route. */
function routePath(pathname: string): string | null {
  if (!pathname.startsWith('/')) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\x00') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter(segment => segment.length > 0);
  if (segments.some(segment => segment === '.' || segment === '..')) return null;
  if (decoded.endsWith('/')) return segments.length === 0 ? 'index.html' : `${segments.join('/')}/index.html`;
  const last = segments.at(-1) ?? '';
  if (!extname(last)) return null; // a directory route without the trailing slash: the caller redirects
  return segments.join('/');
}

async function handleRequest(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') { reject(response, 405, 'method not allowed', { allow: 'GET, HEAD' }); return; }
  let url: URL;
  try { url = new URL(request.url ?? '/', `http://${DASHBOARD_SERVE_HOST}`); } catch { reject(response, 400, 'bad request'); return; }

  const last = url.pathname.split('/').filter(segment => segment.length > 0).at(-1) ?? '';
  if (!url.pathname.endsWith('/') && last && !extname(last)) {
    // `/graph` -> `/graph/`: the static export has no extension-less file route, and a redirect keeps one canonical URL.
    const location = `${url.pathname}/${url.search}`;
    response.writeHead(308, { ...baseHeaders(), location });
    response.end();
    return;
  }

  const relative = routePath(url.pathname);
  if (relative === null) { reject(response, 404, 'not found'); return; }
  const real = await realpath(join(root, relative)).catch(() => null);
  if (real === null || (real !== root && !real.startsWith(`${root}${sep}`))) { reject(response, 404, 'not found'); return; }
  const info = await stat(real).catch(() => null);
  if (!info || !info.isFile()) { reject(response, 404, 'not found'); return; }
  const contentType = DASHBOARD_CONTENT_TYPES[extname(real).toLowerCase()];
  if (contentType === undefined) { reject(response, 404, 'not found'); return; }

  const immutable = relative.startsWith('_next/static/');
  response.writeHead(200, {
    ...baseHeaders(),
    'content-type': contentType,
    'content-length': String(info.size),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  if (method === 'HEAD') { response.end(); return; }
  createReadStream(real).on('error', () => { response.destroy(); }).pipe(response);
}

/** Serve one snapshot directory on loopback. `port: 0` picks a free port; the caller prints `url`, which carries no secret. */
export async function serveDashboardSnapshot(options: DashboardServerOptions): Promise<DashboardServer> {
  const directory = snapshotDirectory(options.directory);
  const real = await realpath(directory).catch(() => null);
  if (real === null) throw Error(`Snapshot directory does not exist: ${directory}`);
  const info = await lstat(real).catch(() => null);
  if (!info || !info.isDirectory()) throw Error(`Snapshot path is not a directory: ${directory}`);
  const requestedPort = options.port ?? 0;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw Error(`Port must be an integer between 0 and 65535, got ${requestedPort}`);

  const server = createServer((request, response) => {
    void handleRequest(real, request, response).catch(() => {
      if (!response.headersSent) reject(response, 500, 'server error');
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, rejectListener) => {
    server.once('error', rejectListener);
    server.listen(requestedPort, DASHBOARD_SERVE_HOST, () => { server.off('error', rejectListener); resolve(); });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort;
  return {
    directory,
    host: DASHBOARD_SERVE_HOST,
    port,
    url: `http://${DASHBOARD_SERVE_HOST}:${port}/`,
    close: () => new Promise<void>((resolve, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
