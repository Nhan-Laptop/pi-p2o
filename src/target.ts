import { lookup } from 'node:dns/promises';
import { realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { MAX_DEPTH, MAX_WORKERS } from './roles.js';

export type Target = { kind: 'directory'; path: string } | { kind: 'url'; url: string; origin: string };
export interface StartOptions { solo: boolean; workers?: number; maxDepth?: number; export?: boolean }
export type Command = { action: 'help' } | { action: 'stop' } | { action: 'start'; target: string; options: StartOptions };

/** Deliberately small. One target plus delegation limits; quoting is supported for directory names. */
export function parseCommand(args: string): Command {
  const text = args.trim();
  if (!text || text === '--help') return { action: 'help' };
  if (text === 'stop') return { action: 'stop' };
  const match = /^--target\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?:\s+(.*))?$/.exec(text);
  if (!match) throw new Error('Usage: /p2o --target <directory|http(s)-URL> [--solo] [--workers N] [--max-depth D] or /p2o stop');
  const target = match[1] ?? match[2] ?? match[3];
  if (target.length > 4096 || /[\x00-\x1f\x7f]/.test(target) || target.startsWith('-')) throw new Error('Invalid target');
  const options: StartOptions = { solo: false };
  const rest = (match[4] ?? '').trim();
  if (rest) {
    const tokens = rest.split(/\s+/);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === '--solo') { options.solo = true; continue; }
      if (token === '--export') { options.export = true; continue; }
      if (token !== '--workers' && token !== '--max-depth') throw new Error(`Unknown option ${token.slice(0, 40)}; usage: /p2o --target <directory|http(s)-URL> [--solo] [--workers N] [--max-depth D]`);
      const value = tokens[index + 1];
      if (!value || !/^\d+$/.test(value)) throw new Error(`${token} needs an integer value`);
      index += 1;
      const parsed = Number(value);
      if (token === '--workers') {
        if (parsed < 1 || parsed > MAX_WORKERS) throw new Error(`--workers must be 1..${MAX_WORKERS}`);
        options.workers = parsed;
      } else {
        if (parsed < 0 || parsed > MAX_DEPTH) throw new Error(`--max-depth must be 0..${MAX_DEPTH}`);
        options.maxDepth = parsed;
      }
    }
  }
  return { action: 'start', target, options };
}

export function webURL(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Use an HTTP(S) URL without credentials or a fragment');
  }
  if (url.hostname.endsWith('.')) throw new Error('Trailing-dot hostnames are not supported');
  return url;
}

export async function classifyTarget(value: string, cwd: string): Promise<Target> {
  if (/^https?:\/\//i.test(value)) {
    const url = webURL(value);
    return { kind: 'url', url: url.href, origin: url.origin };
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) throw new Error('Only HTTP(S) URLs and local directories are supported');
  const path = await realpath(resolve(cwd, value));
  if (!path || path === '/' || path === homedir() || ['/dev', '/proc', '/sys', '/run'].some(root => path === root || path.startsWith(`${root}/`)) || /[:,\x00-\x1f\x7f]/.test(path)) throw new Error('Choose a specific source directory, not home, root or system/service directories; no colon, comma or control characters');
  if (!(await stat(path)).isDirectory()) throw new Error('Local target must be a directory');
  return { kind: 'directory', path };
}

export type AddressClass = 'public' | 'private' | 'loopback' | 'link-local' | 'multicast' | 'reserved' | 'shared' | 'ipv6' | 'container-alias';

/** Classification only. Requests are no longer blocked by class; the class is recorded in the receipt. */
export function addressClass(address: string): AddressClass {
  if (isIP(address) === 6) return 'ipv6';
  if (isIP(address) !== 4) return 'reserved';
  const [a, b, c] = address.split('.').map(Number);
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a >= 224) return 'multicast';
  if (a === 100 && b >= 64 && b <= 127) return 'shared';
  return publicIPv4(address) ? 'public' : 'reserved';
}

/** Conservative public-address test, retained for labelling and for tests that assert the boundary. */
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

export type ResolveAddress = (hostname: string) => Promise<string[]>;
export const resolveAddresses: ResolveAddress = async hostname => {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true })).map(record => record.address)
    .sort((a, b) => isIP(a) - isIP(b)); // Prefer IPv4; IPv6 availability depends on Docker routing.
};

/** Container-side alias that only resolves inside the sandbox; the container resolver owns it. */
export const CONTAINER_HOST_ALIAS = 'host.docker.internal';

export interface ScopedAddress { address: string; addressClass: AddressClass; pin: boolean }

/**
 * Recheck the confirmed origin on every request, then resolve the destination. Private and loopback
 * addresses are allowed by the confirmed scope; the resulting class is recorded rather than used to
 * block. A hostname the sandbox resolves itself (the container alias) is deliberately not pinned.
 */
export async function scopedRequest(target: Target, value: string, resolveIP: ResolveAddress = resolveAddresses): Promise<{ url: URL } & ScopedAddress> {
  if (target.kind !== 'url') throw new Error('HTTP is unavailable for directory assessments');
  const url = webURL(new URL(value, target.url).href);
  if (url.origin !== target.origin) throw new Error(`Out of scope: only ${target.origin} is allowed`);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return { url, address: hostname, addressClass: addressClass(hostname), pin: false };
  if (hostname === CONTAINER_HOST_ALIAS) return { url, address: '', addressClass: 'container-alias', pin: false };
  const addresses = await resolveIP(hostname);
  if (!addresses.length || addresses.some(address => !isIP(address))) throw new Error(`Could not resolve ${hostname} to valid IP addresses`);
  return { url, address: addresses[0], addressClass: addressClass(addresses[0]), pin: true };
}

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'] as const;
export type HttpMethod = string;
export const HTTP_METHOD_PATTERN = "^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$";
export interface HttpRequest {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  followRedirects: boolean;
  maxRedirects: number;
  /** Actor-local named cookie jar. "none" disables cookie persistence and automatic sending. */
  session?: string;
  resetSession?: boolean;
}
export type NormalizedHttpRequest = HttpRequest & { session: string; resetSession: boolean };
export const MAX_BODY_BYTES = 32 * 1024;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const RESERVED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'expect']);

/** Validated once here, revalidated by the broker: header/body values never reach a shell. */
export function httpHeaders(input: unknown): Record<string, string> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('headers must be an object of name/value strings');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 20) throw new Error('At most 20 request headers are supported');
  const headers: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) throw new Error(`Invalid header name ${name.slice(0, 40)}`);
    if (RESERVED_HEADERS.has(name.toLowerCase())) throw new Error(`${name} is set by the transport and cannot be overridden`);
    if (typeof value !== 'string' || Buffer.byteLength(value) > 4096 || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new Error(`Invalid value for header ${name.slice(0, 40)}`);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > 8192) throw new Error('Request headers must total at most 8192 bytes');
    if (Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase())) throw new Error('Duplicate case-insensitive header name');
    headers[name] = value;
  }
  return headers;
}

/** Model-facing request validation. Bodies and headers are bounded; URLs stay within the confirmed origin. */
export function httpRequest(input: unknown): NormalizedHttpRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('HTTP request must be an object');
  const params = input as Record<string, unknown>;
  if (typeof params.url !== 'string' || !params.url || params.url.length > 4096) throw new Error('url must be 1..4096 characters');
  if (params.method !== undefined && typeof params.method !== 'string') throw new Error('method must be an HTTP token of 1..32 characters');
  const method = (params.method as string | undefined) ?? 'GET';
  if (!new RegExp(HTTP_METHOD_PATTERN).test(method)) throw new Error('method must be an HTTP token of 1..32 characters');
  const maxRedirects = params.maxRedirects ?? 3;
  if (typeof maxRedirects !== 'number' || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) throw new Error('maxRedirects must be 0..5');
  if (params.followRedirects !== undefined && typeof params.followRedirects !== 'boolean') throw new Error('followRedirects must be boolean');
  if (params.resetSession !== undefined && typeof params.resetSession !== 'boolean') throw new Error('resetSession must be boolean');
  const session = params.session ?? 'default';
  if (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(session)) throw new Error('session must be a name of 1..40 characters, or none');
  const headers = httpHeaders(params.headers);
  const body = params.body;
  if (body !== undefined && typeof body !== 'string') throw new Error('body must be a string');
  if (typeof body === 'string' && Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error(`Request body must be at most ${MAX_BODY_BYTES} bytes`);
  // Standard convenience is case-insensitive; extension methods retain their exact token spelling.
  const normalized = (HTTP_METHODS as readonly string[]).includes(method.toUpperCase()) ? method.toUpperCase() : method;
  if (normalized === 'HEAD' && body !== undefined) throw new Error('HEAD requests cannot carry a body');
  return { url: params.url, method: normalized, headers, body, followRedirects: params.followRedirects ?? true,
    maxRedirects, session, resetSession: params.resetSession ?? false } as NormalizedHttpRequest;
}

export function targetLabel(target: Target): string { return target.kind === 'directory' ? target.path : target.url; }
