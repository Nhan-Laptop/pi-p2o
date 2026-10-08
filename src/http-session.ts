import { isIP } from 'node:net';

export interface ResponseHead { status?: number; headers: Array<[string, string]>; complete: boolean }

/** Only actual response headers steer redirects/cookies; ignore body text and skip informational blocks. */
export function responseHead(stdout: string): ResponseHead {
  let offset = 0;
  while (offset < stdout.length) {
    const match = /^HTTP\/(?:1\.[01]|2|3)\s+(\d{3})[^\r\n]*\r?\n/.exec(stdout.slice(offset));
    if (!match) return { headers: [], complete: false };
    const end = /\r?\n\r?\n/g;
    end.lastIndex = offset;
    const terminator = end.exec(stdout);
    if (!terminator || terminator.index - offset > 32 * 1024) return { status: Number(match[1]), headers: [], complete: false };
    const block = stdout.slice(offset + match[0].length, terminator.index);
    const lines = block ? block.split(/\r?\n/) : [];
    const headers: Array<[string, string]> = [];
    for (const line of lines) {
      const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line);
      if (!header || /[\x00-\x08\x0a-\x1f\x7f]/.test(header[2])) return { headers: [], complete: false };
      headers.push([header[1].toLowerCase(), header[2].trim()]);
    }
    const status = Number(match[1]);
    offset = terminator.index + terminator[0].length;
    if (status >= 100 && status < 200 && status !== 101) continue;
    return { status, headers, complete: true };
  }
  return { headers: [], complete: false };
}

interface Cookie { name: string; value: string; domain: string; path: string; secure: boolean; expires?: number }
const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const pathMatches = (request: string, cookie: string) => request === cookie ||
  (request.startsWith(cookie) && (cookie.endsWith('/') || request[cookie.length] === '/'));

/** Origin-bound, actor-local jars. This is HTTP session state, not browser identity or authorization proof. */
export class HttpSessions {
  private readonly jars = new Map<string, Map<string, Cookie>>();
  constructor(private readonly now: () => number = Date.now) {}
  private key(actor: string, session: string, url: URL) { return JSON.stringify([actor, session, url.origin]); }
  clear() { this.jars.clear(); }
  reset(actor: string, session: string, url: URL) { this.jars.delete(this.key(actor, session, url)); }
  private prune(jar: Map<string, Cookie>) {
    for (const [key, cookie] of jar) if (cookie.expires !== undefined && cookie.expires <= this.now()) jar.delete(key);
  }
  header(actor: string, session: string, url: URL): string | undefined {
    if (session === 'none') return undefined;
    const jar = this.jars.get(this.key(actor, session, url));
    if (!jar) return undefined;
    this.prune(jar);
    const values = [...jar.values()].filter(cookie => (!cookie.secure || url.protocol === 'https:') && pathMatches(url.pathname, cookie.path))
      .sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`);
    return values.length ? values.join('; ') : undefined;
  }
  store(actor: string, session: string, url: URL, headers: Array<[string, string]>): number {
    if (session === 'none') return 0;
    const key = this.key(actor, session, url);
    let jar = this.jars.get(key);
    let rejected = 0;
    for (const [header, text] of headers) {
      if (header !== 'set-cookie') continue;
      const [pair, ...attributes] = text.split(';');
      const equals = pair.indexOf('=');
      if (equals < 1) { rejected++; continue; }
      const name = pair.slice(0, equals).trim(), value = pair.slice(equals + 1).trim();
      if (!NAME.test(name) || Buffer.byteLength(value) > 4096 || /[\x00-\x20\x7f;,]/.test(value)) { rejected++; continue; }
      const attrs = new Map(attributes.map(attribute => {
        const index = attribute.indexOf('=');
        return [attribute.slice(0, index < 0 ? undefined : index).trim().toLowerCase(), index < 0 ? '' : attribute.slice(index + 1).trim()];
      }));
      const hostname = url.hostname.toLowerCase();
      const domain = (attrs.get('domain') ?? hostname).toLowerCase().replace(/^\./, '');
      if (domain !== hostname && (isIP(hostname) || !hostname.endsWith(`.${domain}`))) { rejected++; continue; }
      let path = attrs.get('path');
      if (!path?.startsWith('/')) path = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
      if (path.length > 4096) { rejected++; continue; }
      const secure = attrs.has('secure');
      if ((secure && url.protocol !== 'https:') || (name.startsWith('__Secure-') && !secure) ||
        (name.startsWith('__Host-') && (!secure || attrs.has('domain') || path !== '/'))) { rejected++; continue; }
      let expires: number | undefined;
      const maxAge = attrs.get('max-age');
      if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) expires = this.now() + Math.min(Number(maxAge), 400 * 86400) * 1000;
      else if (attrs.has('expires')) { const parsed = Date.parse(attrs.get('expires')!); if (Number.isFinite(parsed)) expires = parsed; }
      const cookieKey = JSON.stringify([name, domain, path]);
      if (expires !== undefined && expires <= this.now()) { jar?.delete(cookieKey); continue; }
      if (!jar) {
        for (const [other, old] of this.jars) { this.prune(old); if (!old.size) this.jars.delete(other); }
        if (this.jars.size >= 64) { rejected++; continue; }
        jar = new Map(); this.jars.set(key, jar);
      }
      this.prune(jar);
      const cookie: Cookie = { name, value, domain, path, secure, expires };
      const prospective = new Map(jar); prospective.set(cookieKey, cookie);
      if (prospective.size > 64 || Buffer.byteLength([...prospective.values()].map(c => `${c.name}=${c.value}`).join('; ')) > 8192) { rejected++; continue; }
      jar.set(cookieKey, cookie);
    }
    return rejected;
  }
}
