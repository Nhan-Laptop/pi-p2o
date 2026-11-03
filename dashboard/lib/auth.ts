'use client';
/**
 * planning_update.md P3 (owner decision m5): the per-launch bearer token. `serve` prints one URL whose fragment carries the
 * token; the client reads it once, keeps it in this module's memory for the life of the tab, and sends it as an
 * `Authorization: Bearer` header on every data request. It is never written to storage, never put in a query string, and
 * never rendered into page text.
 */

/** The one line a page shows when a data route answers 401. It points at the operator's own terminal, not a URL. */
export const AUTH_REOPEN_MESSAGE =
  '401 unauthorized: the dashboard token is missing or expired. Reopen the URL printed by the serve command (its #token= fragment carries the secret) and keep that tab open.';
export const AUTH_TOKEN_MAX = 512;

let memoryToken: string | null = null;

/** Read a token out of a URL fragment (`#token=…` or `#a=1&token=…`) without requiring a browser. */
export function parseTokenHash(hash: string): string | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!body) return null;
  for (const part of body.split('&')) {
    if (!part) continue;
    const at = part.indexOf('=');
    const key = at < 0 ? part : part.slice(0, at);
    if (key !== 'token') continue;
    const raw = at < 0 ? '' : part.slice(at + 1);
    let value: string;
    try { value = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { value = raw; }
    const token = value.trim();
    if (!token || token.length > AUTH_TOKEN_MAX) return null;
    if ([...token].some(char => { const code = char.charCodeAt(0); return code <= 0x20 || code === 0x7f; })) return null;
    return token;
  }
  return null;
}

/** Test and page-lifecycle hook: the module value is the only place a token lives. */
export function rememberAuthToken(token: string | null): void {
  memoryToken = token !== null && token.length > 0 && token.length <= AUTH_TOKEN_MAX ? token : null;
}

export function clearAuthToken(): void {
  memoryToken = null;
}

/** Effects only: read the fragment once and keep the value in memory. Never called during render. */
export function captureAuthTokenFromLocation(): string | null {
  if (typeof window === 'undefined') return memoryToken;
  const found = parseTokenHash(window.location.hash);
  if (found !== null) rememberAuthToken(found);
  return memoryToken;
}

export function getAuthToken(): string | null {
  return memoryToken;
}

/** Header map for one fetch; empty when no token has been captured (the route will answer 401 and the page says why). */
export function authHeaders(): Record<string, string> {
  const token = captureAuthTokenFromLocation();
  return token === null ? {} : { authorization: `Bearer ${token}` };
}

/** Every data request goes through here so no call site can forget the header or the no-store rule. */
export function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('accept', headers.get('accept') ?? 'application/json');
  for (const [name, value] of Object.entries(authHeaders())) headers.set(name, value);
  return fetch(input, { ...init, headers, cache: init.cache ?? 'no-store' });
}

/**
 * Keep the secret across full-page anchors (the static export has no router state). The token rides in the fragment, so it
 * is not part of the request line and survives reloads of a copy of the URL; a link already carrying one is left alone.
 */
export function withAuthHash(href: string): string {
  const token = memoryToken;
  // Only same-origin paths get the fragment; a stray absolute link must never carry the launch secret.
  if (token === null || !href.startsWith('/')) return href;
  const hashAt = href.indexOf('#');
  const base = hashAt < 0 ? href : href.slice(0, hashAt);
  const fragment = hashAt < 0 ? '' : href.slice(hashAt + 1);
  if (fragment.split('&').some(part => part === 'token' || part.startsWith('token='))) return href;
  const appended = `${base}#${fragment ? `${fragment}&` : ''}token=${encodeURIComponent(token)}`;
  return appended;
}
