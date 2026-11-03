/**
 * planning_update.md P3 (path "a"): the dashboard server, in the two modes the phase requires.
 *
 *   frozen — serve a snapshot directory this repository wrote (data tree, copied artifact bodies, static client);
 *   live   — bind loopback and serve the data tree generated on demand from read-only stores and report bundles.
 *
 * Both modes are read-only viewers: GET/HEAD only, no write route, no control route, no model or target call. A live build is
 * cached for `refreshMs` and one rebuild is shared by concurrent requests, so the client's poll sees committed records only.
 * Data and API routes require the per-launch bearer token (owner decision m5); static client bytes are not secret and stay
 * public because the browser must fetch them before it can read the token fragment. The token never appears in a query
 * string, a response body, a filesystem path or a log line.
 *
 * The path mapping is a closed map (URL path -> a known route, then a file under the real root), never a concatenation of
 * user input: `..`, encoded separators, control characters, symlinks and non-regular files are refused, and a resolved target
 * must still live under the real root. Artifact bodies are served only for ids a served case or finding cites, so a token
 * holder cannot enumerate the store's artifacts through the dashboard.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { AssessmentStore } from '../state/store.js';
import { validId } from '../validate.js';
import type { DashboardCaseRow, DashboardLimits, DashboardRunFile } from './contract.js';
import { buildDashboard, type DashboardBuild, type DashboardSourceRoot } from './read-model.js';
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

/**
 * One data-tree JSON body may not exceed the bound a frozen data tree must fit (`DASHBOARD_LIMITS.snapshotBytes`): a tree
 * that could not be written to a snapshot is not served from memory either, so a damaged store cannot inflate a response.
 */
export const DASHBOARD_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
/** `store.artifact()` defaults to 16 KiB and refuses above 48 KiB; the route keeps both bounds identical. */
export const DASHBOARD_ARTIFACT_CHUNK_BYTES = 16 * 1024;
export const DASHBOARD_ARTIFACT_CHUNK_MAX_BYTES = 48 * 1024;
export const DASHBOARD_REFRESH_MS_DEFAULT = 5000;
/** `store.artifact()` reads one row with `busy_timeout=0`; a bounded retry then a stated 503 beats a hung request. */
const BUSY_ATTEMPTS = 3, BUSY_RETRY_MS = 60;
const TOKEN_PREFIX = 'Bearer ';

export type DashboardServeOptions =
  | { mode: 'snapshot'; directory: string; port?: number; token?: string }
  | {
      mode: 'live'; stateRoots: DashboardSourceRoot[]; reportRoots: DashboardSourceRoot[];
      runs?: readonly string[]; port?: number; token?: string; refreshMs?: number; limits?: Partial<DashboardLimits>;
    };

export interface DashboardServer {
  mode: 'snapshot' | 'live';
  host: string;
  port: number;
  /** `http://127.0.0.1:<port>/#token=<token>`: a fragment is never sent to the server nor written to an access log. */
  url: string;
  token: string;
  close(): Promise<void>;
  invalidate(): void;
}

/** `GET /runs/<runId>/cases/<caseId>.json`: one case row from the served run file, bounded by the read model already. */
export interface DashboardCaseFile { format: 'p2o-dashboard-case'; version: 1; runId: string; case: DashboardCaseRow }
/**
 * `GET /api/artifact`: one chunk of a retained body. `bytes` is this chunk, `totalBytes` the retained body size and `sha256` /
 * `truncated` describe the whole retained body (a copy can be shorter than the captured artifact; `nextOffset` says whether
 * more retained bytes remain).
 */
export interface DashboardArtifactFile {
  format: 'p2o-dashboard-artifact'; version: 1; runId: string; artifactId: string;
  offset: number; bytes: number; totalBytes: number; sha256: string; truncated: boolean; nextOffset?: number; text: string;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

class DashboardUnavailableError extends Error {}
class ArtifactRangeError extends Error {}
class ArtifactMissingError extends Error {}

const baseHeaders = (): Record<string, string> => ({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': DASHBOARD_CSP,
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'no-store',
});

const isHead = (request: IncomingMessage): boolean => (request.method ?? 'GET') === 'HEAD';

function sendText(request: IncomingMessage, response: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  const body = Buffer.from(`${message}\n`, 'utf8');
  response.writeHead(status, { ...baseHeaders(), 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length), ...extra });
  if (isHead(request)) { response.end(); return; }
  response.end(body);
}

function sendJson(request: IncomingMessage, response: ServerResponse, status: number, body: string | Buffer, extra: Record<string, string> = {}): void {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  response.writeHead(status, { ...baseHeaders(), 'content-type': 'application/json; charset=utf-8', 'content-length': String(bytes.length), ...extra });
  if (isHead(request)) { response.end(); return; }
  response.end(bytes);
}

const notFound = (request: IncomingMessage, response: ServerResponse): void => sendText(request, response, 404, 'not found');

/** A generated JSON body gets the same bound the frozen tree was written under, so a huge build is refused, not streamed. */
function sendDataJson(request: IncomingMessage, response: ServerResponse, body: string | Buffer): void {
  if (Buffer.byteLength(body) > DASHBOARD_RESPONSE_MAX_BYTES) { sendText(request, response, 500, 'response exceeds the size bound'); return; }
  sendJson(request, response, 200, body);
}

/** P5a: REPORT.md is served as text, never re-rendered; the route sets the same nosniff/CSP/no-store headers as every data route. */
function sendMarkdown(request: IncomingMessage, response: ServerResponse, body: string | Buffer): void {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  if (bytes.length > DASHBOARD_RESPONSE_MAX_BYTES) { sendText(request, response, 500, 'response exceeds the size bound'); return; }
  response.writeHead(200, { ...baseHeaders(), 'content-type': 'text/markdown; charset=utf-8', 'content-length': String(bytes.length) });
  if (isHead(request)) { response.end(); return; }
  response.end(bytes);
}

/** Decode once and refuse the forms that would make a path ambiguous: encoded separators, backslashes, control bytes, dots. */
function decodePath(pathname: string): { segments: string[]; trailingSlash: boolean } | null {
  if (/%(?:2f|5c)/i.test(pathname)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (/[\x00-\x1f\x7f\\]/.test(decoded)) return null;
  const segments = decoded.split('/').filter(segment => segment.length > 0);
  if (segments.some(segment => segment === '.' || segment === '..')) return null;
  return { segments, trailingSlash: decoded.endsWith('/') };
}

type DashboardRoute =
  | { kind: 'static' }
  | { kind: 'index' }
  | { kind: 'run'; runId: string }
  | { kind: 'report'; runId: string }
  | { kind: 'case'; runId: string; caseId: string }
  | { kind: 'artifact' }
  /** An `/api`/`/artifacts` path that is not a served route: authenticated, then 404. */
  | { kind: 'hidden' };

function routeOf(pathname: string, path: { segments: string[]; trailingSlash: boolean }): DashboardRoute {
  const [first, second, third, fourth] = path.segments;
  // Match the decoded single segment, not the raw pathname: `/%69ndex.json` is the same data route and must be gated.
  if (path.segments.length === 1 && path.segments[0] === 'index.json') return { kind: 'index' };
  if (first === 'runs') {
    // P5a: the report document itself, never a page or a re-render; the body is bytes the export or the read model produced.
    if (path.segments.length === 3 && second !== undefined && third === 'report.md') return validId(second) ? { kind: 'report', runId: second } : { kind: 'hidden' };
    if (path.segments.length === 2 && second !== undefined && second.endsWith('.json')) {
      const runId = second.slice(0, -'.json'.length);
      return validId(runId) ? { kind: 'run', runId } : { kind: 'hidden' };
    }
    if (path.segments.length === 4 && second !== undefined && third === 'cases' && fourth !== undefined && fourth.endsWith('.json')) {
      const runId = second, caseId = fourth.slice(0, -'.json'.length);
      return validId(runId) && validId(caseId) ? { kind: 'case', runId, caseId } : { kind: 'hidden' };
    }
    return { kind: 'hidden' };
  }
  if (first === 'api') return pathname === '/api/artifact' && path.segments.length === 2 ? { kind: 'artifact' } : { kind: 'hidden' };
  // Artifact copies are reachable only through the cited-id allowlist on /api/artifact, never as public static files.
  if (first === 'artifacts') return { kind: 'hidden' };
  return { kind: 'static' };
}

/**
 * Resolve `relative` under `root` only if every component is a real entry (no symlink anywhere on the path) and the final
 * target is a regular file whose real path is still under `root`. A snapshot is handed to other people, so it must contain
 * what it claims; a symlink or a non-regular entry is a 404 rather than a redirect to somewhere else.
 */
async function fileUnder(root: string, relative: string): Promise<{ real: string; size: number } | null> {
  const segments = relative.split('/');
  if (!segments.length || segments.some(segment => !segment.length || segment === '.' || segment === '..' || /[\x00-\x1f\x7f\\]/.test(segment))) return null;
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink()) return null;
    if (index < segments.length - 1 ? !info.isDirectory() : !info.isFile()) return null;
  }
  const real = await realpath(current).catch(() => null);
  if (real === null || (real !== root && !real.startsWith(`${root}${sep}`))) return null;
  const info = await stat(real).catch(() => null);
  return info?.isFile() ? { real, size: info.size } : null;
}

async function readUnder(root: string, relative: string): Promise<Buffer | null> {
  const file = await fileUnder(root, relative);
  if (!file) return null;
  if (file.size > DASHBOARD_RESPONSE_MAX_BYTES) throw Error('dashboard data exceeds the response bound');
  return readFile(file.real);
}

/** Read only the requested range: a cited body is bounded, but the route must not read beyond the chunk it returns. */
async function readRange(path: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

interface LiveOptions {
  stateRoots: readonly DashboardSourceRoot[];
  reportRoots: readonly DashboardSourceRoot[];
  runs?: readonly string[];
  limits?: Partial<DashboardLimits>;
}
interface LiveBuild { build: DashboardBuild | null; builtAt: number; inFlight: Promise<DashboardBuild> | null }

/** One cached build shared by every request; an expired or invalidated cache rebuilds once, not once per concurrent poll. */
class LiveData {
  private readonly state: LiveBuild = { build: null, builtAt: 0, inFlight: null };
  constructor(private readonly options: LiveOptions, private readonly refreshMs: number) {}
  invalidate(): void { this.state.build = null; this.state.builtAt = 0; }
  async get(): Promise<DashboardBuild> {
    const now = Date.now();
    if (this.state.build && now - this.state.builtAt < this.refreshMs) return this.state.build;
    if (this.state.inFlight) return this.state.inFlight;
    let tracked: Promise<DashboardBuild>;
    tracked = buildDashboard({ ...this.options }).then(build => {
      this.state.build = build; this.state.builtAt = Date.now();
      return build;
    }).finally(() => { if (this.state.inFlight === tracked) this.state.inFlight = null; });
    this.state.inFlight = tracked;
    try { return await tracked; }
    catch { throw new DashboardUnavailableError('the live dashboard build failed'); }
  }
}

interface ServeContext {
  mode: 'snapshot' | 'live';
  tokenDigest: Buffer;
  /** Frozen: the real snapshot root, which also holds the static client. Live: null. */
  snapshotRoot: string | null;
  /** Static client root: the snapshot root in frozen mode, the built client in live mode when it exists. */
  clientRoot: string | null;
  stateRoots: readonly DashboardSourceRoot[];
  live: LiveData | null;
}

function authorize(request: IncomingMessage, tokenDigest: Buffer): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(TOKEN_PREFIX)) return false;
  const presented = header.slice(TOKEN_PREFIX.length);
  if (!presented.length || /\s/.test(presented)) return false;
  // Equal-length sha256 digests: the comparison is constant-time and does not leak the token length.
  return timingSafeEqual(createHash('sha256').update(presented, 'utf8').digest(), tokenDigest);
}

function rowOf(value: unknown): Record<string, unknown> | undefined { return recordOf(value); }

/** Artifact ids cited by a run file's findings/cases reproduction rows; nothing else may be read through the route. */
function citedIdsFrom(file: Record<string, unknown>): Set<string> {
  const cited = new Set<string>();
  for (const collection of ['findings', 'cases']) {
    const rows = file[collection];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const reproduction = rowOf(row)?.reproduction;
      if (!Array.isArray(reproduction)) continue;
      for (const step of reproduction) {
        const captures = rowOf(step)?.captures;
        if (!Array.isArray(captures)) continue;
        for (const capture of captures) {
          const id = rowOf(capture)?.id;
          if (typeof id === 'string') cited.add(id);
        }
      }
    }
  }
  return cited;
}

function citedIdsFromRun(file: DashboardRunFile): Set<string> {
  const cited = new Set<string>();
  for (const row of [...file.findings, ...file.cases]) for (const step of row.reproduction) for (const capture of step.captures) cited.add(capture.id);
  return cited;
}

function artifactRefOf(file: Record<string, unknown>, artifactId: string): { bytes: number; sha256: string; truncated: boolean } | null {
  const rows = file.artifacts;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const ref = rowOf(row);
    if (ref?.artifactId === artifactId && typeof ref.bytes === 'number' && typeof ref.sha256 === 'string') {
      return { bytes: ref.bytes, sha256: ref.sha256, truncated: ref.truncated === true };
    }
  }
  return null;
}

interface ArtifactParams { runId: string; artifactId: string; offset: number; length: number }

/** Invalid parameter syntax is a 400; an offset beyond the retained bytes is a 416 once the body's size is known. */
function artifactParams(url: URL): ArtifactParams | null {
  const runId = url.searchParams.get('run'), artifactId = url.searchParams.get('id');
  if (!validId(runId) || !validId(artifactId)) return null;
  const rawOffset = url.searchParams.get('offset'), rawLength = url.searchParams.get('length');
  const offset = rawOffset === null ? 0 : (/^(?:0|[1-9]\d{0,15})$/.test(rawOffset) ? Number(rawOffset) : Number.NaN);
  const length = rawLength === null ? DASHBOARD_ARTIFACT_CHUNK_BYTES : (/^[1-9]\d{0,5}$/.test(rawLength) ? Number(rawLength) : Number.NaN);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  if (!Number.isSafeInteger(length) || length < 1 || length > DASHBOARD_ARTIFACT_CHUNK_MAX_BYTES) return null;
  return { runId, artifactId, offset, length };
}

async function liveArtifact(directory: string, runId: string, artifactId: string, offset: number, length: number) {
  for (let attempt = 1; attempt <= BUSY_ATTEMPTS; attempt++) {
    let store: AssessmentStore | undefined;
    try {
      store = AssessmentStore.open(directory, runId, { readOnly: true });
      // The dashboard is a viewer: a handle that is not read-only is a bug, not a degraded mode.
      if (store.readOnly !== true) throw Error('the dashboard opened a store that is not read-only');
      return store.artifact(artifactId, offset, length);
    } catch (error) {
      const message = messageOf(error);
      if (/SQLITE_BUSY|database is locked/i.test(message)) {
        if (attempt < BUSY_ATTEMPTS) { await new Promise(resolveDelay => setTimeout(resolveDelay, attempt * BUSY_RETRY_MS)); continue; }
        throw new DashboardUnavailableError('the store is busy');
      }
      if (/range exceeds retained bytes/i.test(message)) throw new ArtifactRangeError('artifact offset is beyond the retained bytes');
      if (/unknown artifact/i.test(message)) throw new ArtifactMissingError('artifact not found');
      throw error;
    } finally { try { store?.close(); } catch { /* read-only: close cannot change committed state */ } }
  }
  throw new DashboardUnavailableError('the store is busy');
}

async function serveStatic(context: ServeContext, request: IncomingMessage, response: ServerResponse, url: URL,
  path: { segments: string[]; trailingSlash: boolean }): Promise<void> {
  const last = path.segments.at(-1) ?? '';
  if (!path.trailingSlash && !extname(last)) {
    // `/graph` -> `/graph/`: the static export has no extension-less file route, and a redirect keeps one canonical URL.
    response.writeHead(308, { ...baseHeaders(), location: `${url.pathname}/${url.search}`, 'content-length': '0' });
    response.end();
    return;
  }
  const relative = path.trailingSlash
    ? (path.segments.length === 0 ? 'index.html' : `${path.segments.join('/')}/index.html`)
    : path.segments.join('/');
  if (!relative || context.clientRoot === null) { notFound(request, response); return; }
  const file = await fileUnder(context.clientRoot, relative);
  if (!file) { notFound(request, response); return; }
  if (file.size > DASHBOARD_RESPONSE_MAX_BYTES) { sendText(request, response, 500, 'response exceeds the size bound'); return; }
  const contentType = DASHBOARD_CONTENT_TYPES[extname(relative).toLowerCase()];
  if (contentType === undefined) { notFound(request, response); return; }
  const immutable = relative.startsWith('_next/static/');
  response.writeHead(200, {
    ...baseHeaders(),
    'content-type': contentType,
    'content-length': String(file.size),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  if (isHead(request)) { response.end(); return; }
  createReadStream(file.real).on('error', () => { response.destroy(); }).pipe(response);
}

async function serveArtifact(context: ServeContext, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const params = artifactParams(url);
  if (!params) { sendText(request, response, 400, 'invalid artifact request'); return; }
  const { runId, artifactId, offset, length } = params;

  if (context.mode === 'snapshot') {
    const root = context.snapshotRoot!;
    const bytes = await readUnder(root, `runs/${runId}.json`);
    if (!bytes) { notFound(request, response); return; }
    const file = recordOf(JSON.parse(bytes.toString('utf8')));
    if (!file || !citedIdsFrom(file).has(artifactId)) { notFound(request, response); return; }
    const ref = artifactRefOf(file, artifactId);
    if (!ref) { notFound(request, response); return; }
    if (offset > ref.bytes) { sendText(request, response, 416, 'artifact offset is beyond the retained bytes'); return; }
    const copy = await fileUnder(root, `artifacts/${runId}/${artifactId}.txt`);
    if (!copy) { notFound(request, response); return; }
    // The ref is what the data tree says the copy is; a different file is a damaged snapshot, never silently trusted.
    if (copy.size !== ref.bytes) { sendText(request, response, 500, 'artifact copy does not match the data tree'); return; }
    const chunk = await readRange(copy.real, offset, length);
    const nextOffset = offset + chunk.length < ref.bytes ? offset + chunk.length : undefined;
    const body: DashboardArtifactFile = { format: 'p2o-dashboard-artifact', version: 1, runId, artifactId, offset,
      bytes: chunk.length, totalBytes: ref.bytes, sha256: ref.sha256, truncated: ref.truncated,
      ...(nextOffset === undefined ? {} : { nextOffset }), text: chunk.toString('utf8') };
    sendDataJson(request, response, JSON.stringify(body));
    return;
  }

  const build = await context.live!.get();
  const runFile = build.runs.find(run => run.runId === runId);
  if (!runFile || !citedIdsFromRun(runFile).has(artifactId)) { notFound(request, response); return; }
  const directory = await storeDirectory(context.stateRoots, runId);
  if (!directory) { notFound(request, response); return; }
  const result = await liveArtifact(directory, runId, artifactId, offset, length);
  const body: DashboardArtifactFile = { format: 'p2o-dashboard-artifact', version: 1, runId, artifactId, offset: result.offset,
    bytes: result.returnedBytes, totalBytes: result.manifest.bytes, sha256: result.manifest.sha256,
    truncated: result.manifest.truncated === true, ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }), text: result.text };
  sendDataJson(request, response, JSON.stringify(body));
}

/** The state root the read model selected for this run: absolute roots only, the same root ordering it used. */
async function storeDirectory(stateRoots: readonly DashboardSourceRoot[], runId: string): Promise<string | null> {
  const candidates: string[] = [];
  for (const root of stateRoots) {
    // buildDashboard ignores a relative root; a relative path here could resolve to a different store by accident.
    if (!isAbsolute(root.path)) continue;
    const directory = resolve(root.path);
    const info = await stat(join(directory, runId, 'assessment.sqlite')).catch(() => null);
    if (info?.isFile()) candidates.push(directory);
  }
  return candidates.sort()[0] ?? null;
}

async function serveData(context: ServeContext, request: IncomingMessage, response: ServerResponse, url: URL,
  route: Exclude<DashboardRoute, { kind: 'static' }>): Promise<void> {
  switch (route.kind) {
    case 'hidden': { notFound(request, response); return; }
    case 'index': {
      if (context.mode === 'snapshot') {
        const bytes = await readUnder(context.snapshotRoot!, 'index.json');
        if (!bytes) { notFound(request, response); return; }
        sendJson(request, response, 200, bytes);
        return;
      }
      const build = await context.live!.get();
      sendDataJson(request, response, JSON.stringify(build.index));
      return;
    }
    case 'run': {
      if (context.mode === 'snapshot') {
        const bytes = await readUnder(context.snapshotRoot!, `runs/${route.runId}.json`);
        if (!bytes) { notFound(request, response); return; }
        sendJson(request, response, 200, bytes);
        return;
      }
      const build = await context.live!.get();
      const runFile = build.runs.find(run => run.runId === route.runId);
      if (!runFile) { notFound(request, response); return; }
      sendDataJson(request, response, JSON.stringify(runFile));
      return;
    }
    case 'report': {
      // Frozen: the snapshot's own reports/<runId>.md, path-checked by fileUnder like every other copied file.
      if (context.mode === 'snapshot') {
        const bytes = await readUnder(context.snapshotRoot!, `reports/${route.runId}.md`);
        if (!bytes) { notFound(request, response); return; }
        sendMarkdown(request, response, bytes);
        return;
      }
      // Live: the report body already in the cached, bounded build; a run without one is 404, never an empty document.
      const build = await context.live!.get();
      const report = build.runs.find(run => run.runId === route.runId)?.report;
      if (!report) { notFound(request, response); return; }
      sendMarkdown(request, response, report.text);
      return;
    }
    case 'case': {
      let row: DashboardCaseRow | undefined;
      if (context.mode === 'snapshot') {
        const bytes = await readUnder(context.snapshotRoot!, `runs/${route.runId}.json`);
        if (!bytes) { notFound(request, response); return; }
        const file = recordOf(JSON.parse(bytes.toString('utf8')));
        const rows = file?.cases;
        const found = Array.isArray(rows) ? rows.map(rowOf).find(item => item?.id === route.caseId) : undefined;
        if (!found) { notFound(request, response); return; }
        row = found as unknown as DashboardCaseRow;
      } else {
        const build = await context.live!.get();
        row = build.runs.find(run => run.runId === route.runId)?.cases.find(item => item.id === route.caseId);
        if (!row) { notFound(request, response); return; }
      }
      const body: DashboardCaseFile = { format: 'p2o-dashboard-case', version: 1, runId: route.runId, case: row };
      sendDataJson(request, response, JSON.stringify(body));
      return;
    }
    case 'artifact': { await serveArtifact(context, request, response, url); return; }
  }
}

async function handle(context: ServeContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    sendText(request, response, 405, 'method not allowed', { allow: 'GET, HEAD' });
    return;
  }
  const raw = request.url ?? '/';
  const rawPath = raw.split('?')[0] ?? '';
  if (rawPath.includes('\\') || /[\x00-\x1f\x7f]/.test(rawPath)) { notFound(request, response); return; }
  // Reject dot-like raw segments before the WHATWG URL parser normalises them away: `/../index.json` is an escape attempt,
  // not a request for the index, and `%2e%2e` is the same segment after one decode.
  const dotLike = rawPath.split('/').some(segment => {
    if (!segment) return false;
    try { const decoded = decodeURIComponent(segment); return decoded === '.' || decoded === '..'; } catch { return false; }
  });
  if (dotLike) { notFound(request, response); return; }
  let url: URL;
  try { url = new URL(raw, `http://${DASHBOARD_SERVE_HOST}`); } catch { sendText(request, response, 400, 'bad request'); return; }
  const path = decodePath(url.pathname);
  if (!path) { notFound(request, response); return; }
  const route = routeOf(url.pathname, path);
  if (route.kind === 'static') { await serveStatic(context, request, response, url, path); return; }
  if (!authorize(request, context.tokenDigest)) {
    sendText(request, response, 401, 'unauthorized', { 'www-authenticate': 'Bearer realm="p2o-dashboard"' });
    return;
  }
  await serveData(context, request, response, url, route);
}

const validPort = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw Error(`Port must be an integer between 0 and 65535, got ${value}`);
  return value;
};

const validToken = (value: string): string => {
  if (typeof value !== 'string' || !value.length || value.length > 512 || /[\x00-\x20\x7f]/.test(value)) throw Error('Token must be a non-empty string without whitespace or control characters');
  return value;
};

const validRoots = (value: readonly DashboardSourceRoot[], label: string): DashboardSourceRoot[] => {
  if (!Array.isArray(value)) throw Error(`${label} must be an array of source roots`);
  return value.map(root => {
    if (!recordOf(root) || typeof root.path !== 'string' || !root.path.length) throw Error(`${label} entries need a path`);
    return { ...root };
  });
};

/** The built client lives at the same default `snapshot --client` copies from; without a build the data routes still work. */
async function defaultClientRoot(): Promise<string | null> {
  const real = await realpath(join(process.cwd(), 'dashboard', 'out')).catch(() => null);
  if (real === null) return null;
  const info = await lstat(real).catch(() => null);
  return info?.isDirectory() ? real : null;
}

/** Serve a snapshot directory or live committed state on loopback. `port: 0` picks a free port; `url` carries the token. */
export async function serveDashboard(options: DashboardServeOptions): Promise<DashboardServer> {
  const requestedPort = validPort(options.port ?? 0);
  const token = options.token === undefined ? randomBytes(32).toString('base64url') : validToken(options.token);
  const tokenDigest = createHash('sha256').update(token, 'utf8').digest();
  let context: ServeContext;

  if (options.mode === 'snapshot') {
    const directory = snapshotDirectory(options.directory);
    const real = await realpath(directory).catch(() => null);
    if (real === null) throw Error(`Snapshot directory does not exist: ${directory}`);
    const info = await lstat(real).catch(() => null);
    if (!info || !info.isDirectory()) throw Error(`Snapshot path is not a directory: ${directory}`);
    context = { mode: 'snapshot', tokenDigest, snapshotRoot: real, clientRoot: real, stateRoots: [], live: null };
  } else {
    const stateRoots = validRoots(options.stateRoots, 'stateRoots'), reportRoots = validRoots(options.reportRoots, 'reportRoots');
    const refreshMs = options.refreshMs ?? DASHBOARD_REFRESH_MS_DEFAULT;
    if (!Number.isSafeInteger(refreshMs) || refreshMs < 1 || refreshMs > 24 * 60 * 60 * 1000) throw Error(`refreshMs must be an integer between 1 and 86400000, got ${refreshMs}`);
    const liveOptions: LiveOptions = { stateRoots, reportRoots, ...(options.runs === undefined ? {} : { runs: options.runs }), ...(options.limits === undefined ? {} : { limits: options.limits }) };
    context = { mode: 'live', tokenDigest, snapshotRoot: null, clientRoot: await defaultClientRoot(), stateRoots, live: new LiveData(liveOptions, refreshMs) };
  }

  const server = createServer((request, response) => {
    void handle(context, request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof DashboardUnavailableError) { sendText(request, response, 503, 'dashboard data is temporarily unavailable'); return; }
      if (error instanceof ArtifactRangeError) { sendText(request, response, 416, error.message); return; }
      if (error instanceof ArtifactMissingError) { notFound(request, response); return; }
      sendText(request, response, 500, 'server error');
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(requestedPort, DASHBOARD_SERVE_HOST, () => { server.off('error', rejectListen); resolveListen(); });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort;
  return {
    mode: options.mode,
    host: DASHBOARD_SERVE_HOST,
    port,
    url: `http://${DASHBOARD_SERVE_HOST}:${port}/#token=${encodeURIComponent(token)}`,
    token,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections();
    }),
    invalidate: () => { context.live?.invalidate(); },
  };
}
