import { lookup } from 'node:dns/promises';
import { realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { CASE_EFFECTS, type CaseEffect } from './cvss.js';
import { parseCallbackUrl, parseLabNetwork, type EngagementMode } from './campaign.js';
import { MAX_DEPTH, MAX_WORKERS, type LoopMode, type RetentionMode } from './roles.js';
import { TEXT_CONTROL } from './validate.js';

/** `hybrid` is a source snapshot plus one deployed origin of the same system: both are confirmed together, share one graph, and neither widens the other. */
export type Target = { kind: 'directory'; path: string } | { kind: 'url'; url: string; origin: string } | { kind: 'hybrid'; path: string; url: string; origin: string };
/** The target mounts a read-only source snapshot in the sandbox. */
export const hasSource = (target: Target): target is Extract<Target, { path: string }> => target.kind !== 'url';
/** The target carries a starting URL; HTTP is not restricted to its origin. */
export const hasOrigin = (target: Target): target is Extract<Target, { origin: string }> => target.kind !== 'directory';
/** 'latest'/'all' pick by eligibility at run start; an explicit id list (≤10, `run-<chars>` shape) names runs directly. Never grants authority — see planning_update.md. */
export type ReferWorkspaceOption = 'latest' | 'all' | readonly string[];
export interface StartOptions { workers?: number; maxDepth?: number; export?: boolean; loopMode?: LoopMode; executorMode?: 'shared' | 'isolated' | 'session'; /** A7.2: an explicit `--executors session:N`; defaults to, and may never exceed, the target-operation cap. */ sessionLimit?: number; maxTargetOperations?: number; retention?: RetentionMode; goal?: string; avoid?: string[]; /** A6.1: campaign heartbeat in seconds; `0` disables it. */ heartbeatSeconds?: number; /** D15: `exploit` (default) authorizes the access ladder; `assess` is the opt-in read-only shape. */ mode?: EngagementMode; /** D15/Q9: the effect classes `--effect` authorized; the host defaults to every class except `availability-loss`. */ effectClasses?: CaseEffect[]; /** A7.4: one operator-supplied JSON identity file; the host seals a copy and never shows a value to a model. */ identityPath?: string; origin?: string; /** A7.8: the operator's out-of-band callback destination the target may reach (recorded, never a listener). */ callback?: string; /** A7.8: the operator's throwaway docker network the sandbox joins, so the target can route back to a listener. */ labNetwork?: string; /** A7.9/D23: recorded permissions; a deny still wins, an allow never widens the target. */ allow?: string[]; referWorkspace?: ReferWorkspaceOption }
export type Command = { action: 'help' } | { action: 'stop' } | { action: 'pause' } | { action: 'resume' }
  /** A7.7: the operator resolves one pending policy ask. The decision is written as an owner-attributed record. */
  | { action: 'approve' | 'deny'; id: string }
  | { action: 'start'; target?: string; resume?: string; options: StartOptions };

/** Deliberately small. One target plus delegation limits; quoting is supported for directory names. */
const GOAL_CHARS = 600;
// A7.9/D23: `--avoid` and `--allow` are one constraint list with one budget (deny is absolute, allow is a permission).
const CONSTRAINT_CHARS = 300, MAX_CONSTRAINTS = 5;
/** Same run-ID shape the bundle-import manifest already validates (src/source.ts); ≤10 ids, consistent with other id-list caps in this codebase. */
const REFER_WORKSPACE_RUN_ID = 'run-[a-zA-Z0-9-]{1,75}';
const REFER_WORKSPACE_VALUE = new RegExp(`^(?:latest|all|${REFER_WORKSPACE_RUN_ID}(?:,${REFER_WORKSPACE_RUN_ID}){0,9})$`);
export function parseCommand(args: string): Command {
  const text = args.trim();
  if (!text || text === '--help') return { action: 'help' };
  if (text === 'stop' || text === 'pause' || text === 'resume') return { action: text };
  // A7.7: one pending policy decision, named by the id the refusal returned. Nothing else is accepted here.
  const resolution = /^(approve|deny)\s+(policy-ask-[a-f0-9-]{36})$/.exec(text);
  if (resolution) return { action: resolution[1] as 'approve' | 'deny', id: resolution[2] };
  // Part XI S8: resume an existing durable-local store instead of creating another run. The stored profile supplies the target.
  const resume = /^--resume\s+(run-[a-zA-Z0-9-]{1,75})$/.exec(text);
  if (resume) return { action: 'start', resume: resume[1], options: {} };
  const match = /^--target\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?:\s+(.*))?$/.exec(text);
  if (!match) throw new Error('Usage: /p2o --target <directory|http(s)-URL> [options] or /p2o --resume <run-id> or /p2o stop');
  const target = match[1] ?? match[2] ?? match[3];
  if (target.length > 4096 || /[\x00-\x1f\x7f]/.test(target) || target.startsWith('-')) throw new Error('Invalid target');
  const options: StartOptions = {};
  const rest = (match[4] ?? '').trim();
  if (rest) {
    const tokens = [...rest.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === '--export') { options.export = true; continue; }
      if (token === '--retention') {
        const value = tokens[++index];
        if (value !== 'durable-local' && value !== 'ephemeral') throw Error('--retention must be durable-local or ephemeral');
        options.retention = value; continue;
      }
      if (token === '--goal') {
        const value = tokens[++index]?.trim();
        if (!value || value.length > GOAL_CHARS || value !== value.normalize('NFC') || TEXT_CONTROL.test(value)) throw Error(`--goal needs one quoted sentence of 1..${GOAL_CHARS} characters without control characters`);
        options.goal = value; continue;
      }
      if (token === '--heartbeat-seconds') {
        // A6.1: heartbeats consume paid planner rounds, so the value is explicit: 0 disables, a small non-zero value is
        // refused at the parser rather than silently raised to the floor the campaign record would clamp to.
        const value = tokens[++index];
        if (!value || !/^\d+$/.test(value)) throw Error('--heartbeat-seconds needs an integer value (0 disables)');
        const seconds = Number(value);
        if (!Number.isSafeInteger(seconds)) throw Error('--heartbeat-seconds needs a safe integer');
        if (seconds !== 0 && seconds < 120) throw Error('--heartbeat-seconds must be 0 (disabled) or at least 120 seconds');
        options.heartbeatSeconds = seconds; continue;
      }
      if (token === '--avoid' || token === '--allow') {
        // A7.9: a denial is absolute and a permission is only a permission; both are recorded operator words with one shared budget.
        const value = tokens[++index]?.trim();
        if (!value || value.length > CONSTRAINT_CHARS || value !== value.normalize('NFC') || TEXT_CONTROL.test(value)) throw Error(`${token} needs one quoted sentence of 1..${CONSTRAINT_CHARS} characters without control characters`);
        if (((options.avoid?.length ?? 0) + (options.allow?.length ?? 0)) >= MAX_CONSTRAINTS) throw Error(`--avoid and --allow together may be given at most ${MAX_CONSTRAINTS} times`);
        (token === '--avoid' ? (options.avoid ??= []) : (options.allow ??= [])).push(value); continue;
      }
      if (token === '--mode') {
        // D15 (owner decision 2026-10-26): `exploit` is the default, so the flag exists to make the frame explicit and to
        // select the opt-in read-only shape. An explicit mode outranks any stored profile at resume.
        const value = tokens[++index];
        if (value !== 'assess' && value !== 'exploit') throw Error('--mode must be assess or exploit');
        if (options.mode !== undefined) throw Error('--mode may be given only once');
        options.mode = value; continue;
      }
      if (token === '--effect') {
        // D15: an effect class is part of an explicitly named ladder, never a quiet add-on to the default frame.
        const value = tokens[++index];
        if (!value || !(CASE_EFFECTS as readonly string[]).includes(value)) throw Error(`--effect must be one of: ${CASE_EFFECTS.join(', ')}; repeat the flag to authorize more than one`);
        if (options.mode === 'assess') throw Error('--effect goes with exploit mode; assess mode authorizes no effect classes');
        const effects = (options.effectClasses ??= []);
        if (!effects.includes(value as CaseEffect)) effects.push(value as CaseEffect);
        continue;
      }
      if (token === '--identity') {
        // A7.4: the credential channel is one file the operator names. Absolute only (the host must not resolve a relative
        // path against a model-chosen cwd), bounded and given once; an unreadable file fails start before any resource exists.
        const value = tokens[++index];
        if (!value || value.length > 4096 || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value)) throw Error('--identity needs one absolute path to a JSON identity file');
        if (options.identityPath !== undefined) throw Error('--identity may be given only once');
        options.identityPath = value; continue;
      }
      if (token === '--origin') {
        const value = tokens[++index]?.trim();
        if (!value || value.length > 2048 || !/^https?:\/\//i.test(value) || TEXT_CONTROL.test(value) || /[\x00-\x1f\x7f\s]/.test(value)) throw Error('--origin needs one http(s) URL without whitespace or control characters');
        if (options.origin !== undefined) throw Error('--origin may be given only once');
        options.origin = value; continue;
      }
      if (token === '--callback') {
        // A7.8: a destination the target reaches out to. It is printed in prompts, so credentials and fragments are refused:
        // they would either leak a value or turn one endpoint into two different things.
        const value = tokens[++index]?.trim();
        if (!value || parseCallbackUrl(value) === undefined) throw Error('--callback needs one absolute http(s) URL without whitespace, control characters, credentials or a fragment');
        if (options.callback !== undefined) throw Error('--callback may be given only once');
        options.callback = value; continue;
      }
      if (token === '--lab-network') {
        // A7.8: the operator brings the network; the host verifies it exists at start and never publishes a port.
        const value = tokens[++index]?.trim();
        if (value === undefined || parseLabNetwork(value) === undefined) throw Error('--lab-network needs an operator-created docker network name (1..64 of [a-zA-Z0-9_.-]; not host, none or bridge)');
        if (options.labNetwork !== undefined) throw Error('--lab-network may be given only once');
        options.labNetwork = value; continue;
      }
      if (token === '--loop') {
        const value = tokens[++index];
        if (value !== 'manual' && value !== 'event-driven') throw Error('--loop must be manual or event-driven');
        options.loopMode = value; continue;
      }
      if (token === '--executors') {
        const value = tokens[++index];
        // A7.2: `session[:N]` opens long-lived, run-owned executors; N defaults to the target-operation cap and can only
        // narrow it, because a session must never multiply target pressure.
        const match = typeof value === 'string' ? /^(shared|isolated|session)(?::([1-9][0-9]?))?$/.exec(value) : null;
        if (!match) throw Error('--executors must be shared, isolated, or session[:N] with N 1..99');
        options.executorMode = match[1] as 'shared' | 'isolated' | 'session';
        if (match[2] !== undefined) options.sessionLimit = Number(match[2]);
        continue;
      }
      if (token === '--refer-workspace') {
        const peek = tokens[index + 1];
        const value = peek !== undefined && REFER_WORKSPACE_VALUE.test(peek) ? peek : 'latest';
        if (value === peek) index += 1;
        options.referWorkspace = value === 'latest' || value === 'all' ? value : value.split(',');
        continue;
      }
      if (token !== '--workers' && token !== '--max-depth' && token !== '--target-ops') throw new Error(`Unknown option ${token.slice(0, 40)}; usage: /p2o --target <directory|http(s)-URL> [--workers N] [--max-depth D] [--goal "text"] [--avoid "text"] [--allow "text"] [--mode assess|exploit] [--effect <class>]... [--heartbeat-seconds N] [--callback <http(s)-URL>] [--lab-network <name>]`);
      const value = tokens[index + 1];
      if (!value || !/^\d+$/.test(value)) throw new Error(`${token} needs an integer value`);
      index += 1;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw Error(`${token} needs a safe integer`);
      if (token === '--target-ops') {
        if (parsed < 1) throw Error('--target-ops must be positive');
        options.maxTargetOperations = parsed;
      } else if (token === '--workers') {
        if (parsed < 1 || parsed > MAX_WORKERS) throw new Error(`--workers must be 1..${MAX_WORKERS}`);
        options.workers = parsed;
      } else {
        if (parsed < 0 || parsed > MAX_DEPTH) throw new Error(`--max-depth must be 0..${MAX_DEPTH}`);
        options.maxDepth = parsed;
      }
    }
  }
  if (options.origin !== undefined && /^[a-z][a-z\d+.-]*:\/\//i.test(target)) throw new Error('--origin goes with a source directory target: use --target <directory> --origin <http(s)-URL>');
  // An effect class is only meaningful inside an explicitly named ladder, whatever the flag order was.
  if (options.effectClasses?.length && options.mode !== 'exploit') throw Error(options.mode === 'assess'
    ? '--effect goes with exploit mode; assess mode authorizes no effect classes'
    : '--effect requires --mode exploit: name the ladder explicitly when you narrow its effect classes');
  if (options.effectClasses) options.effectClasses = CASE_EFFECTS.filter(effect => options.effectClasses!.includes(effect));
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

export async function classifyTarget(value: string, cwd: string, origin?: string): Promise<Target> {
  if (origin !== undefined) {
    const source = await classifyTarget(value, cwd);
    if (source.kind !== 'directory') throw new Error('--origin goes with a source directory target');
    const url = webURL(origin);
    return { kind: 'hybrid', path: source.path, url: url.href, origin: url.origin };
  }
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
 * Resolve the destination and record its address class. There is no origin comparison: any http(s) URL the caller
 * asks for is allowed, including private, loopback and metadata addresses (planning_update.md Part XI).
 */
export async function scopedRequest(target: Target, value: string, resolveIP: ResolveAddress = resolveAddresses): Promise<{ url: URL } & ScopedAddress> {
  // 2026-10-25 (planning_update.md Part XI): the target is a starting label, not a boundary. A relative value resolves
  // against the target URL when there is one; an absolute value is used as given. Resolution is transport bookkeeping.
  const url = webURL(hasOrigin(target) ? new URL(value, target.url).href : new URL(value).href);
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
  /** A7.4/Q11: the operator-declared principal a cookie jar belongs to; the jar key is principal + session + origin. */
  principal?: string;
  /** Optional per-hop/connect probe deadlines in seconds; zero/omitted disables extension limits. */
  timeout?: number;
  connectTimeout?: number;
}
export type NormalizedHttpRequest = HttpRequest & { principal: string; session: string; resetSession: boolean; timeout: number; connectTimeout: number };

/** Optional task deadline only, never run/worker authority. No 60/300-second ceiling. */
export function taskTimeout(value: unknown, name = 'timeout'): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw Error(`${name} must be a non-negative safe integer in seconds; 0 disables it`);
  return value;
}
export const MAX_BODY_BYTES = 48 * 1024;
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
    if (typeof value !== 'string' || Buffer.byteLength(value) > 8 * 1024 || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new Error(`Invalid value for header ${name.slice(0, 40)}`);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > 16 * 1024) throw new Error('Request headers must total at most 16384 bytes');
    if (Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase())) throw new Error('Duplicate case-insensitive header name');
    headers[name] = value;
  }
  return headers;
}

/** Model-facing request validation. Bodies and headers are bounded; URLs stay within the confirmed origin. */
export function httpRequest(input: unknown): NormalizedHttpRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('HTTP request must be an object');
  const params = input as Record<string, unknown>;
  if (typeof params.url !== 'string' || !params.url || params.url.length > 8 * 1024) throw new Error('url must be 1..8192 characters');
  if (params.method !== undefined && typeof params.method !== 'string') throw new Error('method must be an HTTP token of 1..32 characters');
  const method = (params.method as string | undefined) ?? 'GET';
  if (!new RegExp(HTTP_METHOD_PATTERN).test(method)) throw new Error('method must be an HTTP token of 1..32 characters');
  const maxRedirects = params.maxRedirects ?? 3;
  if (typeof maxRedirects !== 'number' || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) throw new Error('maxRedirects must be 0..20');
  if (params.followRedirects !== undefined && typeof params.followRedirects !== 'boolean') throw new Error('followRedirects must be boolean');
  if (params.resetSession !== undefined && typeof params.resetSession !== 'boolean') throw new Error('resetSession must be boolean');
  const session = params.session ?? 'default';
  if (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(session)) throw new Error('session must be a name of 1..40 characters, or none');
  // A7.4: a principal is a declared name, never a credential: the value the operator sealed never appears here.
  const principal = params.principal ?? 'default';
  if (typeof principal !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(principal)) throw new Error('principal must be a name of 1..64 characters of [a-z0-9-]');
  const headers = httpHeaders(params.headers);
  const body = params.body;
  if (body !== undefined && typeof body !== 'string') throw new Error('body must be a string');
  if (typeof body === 'string' && Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error(`Request body must be at most ${MAX_BODY_BYTES} bytes`);
  // Standard convenience is case-insensitive; extension methods retain their exact token spelling.
  const normalized = (HTTP_METHODS as readonly string[]).includes(method.toUpperCase()) ? method.toUpperCase() : method;
  if (normalized === 'HEAD' && body !== undefined) throw new Error('HEAD requests cannot carry a body');
  return { url: params.url, method: normalized, headers, body, followRedirects: params.followRedirects ?? true,
    maxRedirects, session, resetSession: params.resetSession ?? false, principal,
    timeout: taskTimeout(params.timeout), connectTimeout: taskTimeout(params.connectTimeout, 'connectTimeout') } as NormalizedHttpRequest;
}

export function targetLabel(target: Target): string { return target.kind === 'directory' ? target.path : target.kind === 'hybrid' ? `${target.path} + ${target.url}` : target.url; }
