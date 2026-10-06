import { lookup } from 'node:dns/promises';
import { realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export type Target = { kind: 'directory'; path: string } | { kind: 'url'; url: string; origin: string };
export type Command = { action: 'help' } | { action: 'stop' } | { action: 'start'; target: string };

/** Deliberately one option. Quoting is supported for directory names with spaces. */
export function parseCommand(args: string): Command {
  const text = args.trim();
  if (!text || text === '--help') return { action: 'help' };
  if (text === 'stop') return { action: 'stop' };
  const match = /^--target\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))$/.exec(text);
  if (!match) throw new Error('Usage: /p2o --target <directory|http(s)-URL> or /p2o stop');
  const target = match[1] ?? match[2] ?? match[3];
  if (target.length > 4096 || /[\x00-\x1f\x7f]/.test(target) || target.startsWith('-')) throw new Error('Invalid target');
  return { action: 'start', target };
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

/** Conservative IPv4-only first version. Reject private, reserved, multicast and documentation ranges. */
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
  return (await lookup(hostname, { all: true, family: 4 })).map(record => record.address);
};

/** Recheck every request, then pin curl to the validated address: DNS cannot rebind after validation. */
export async function scopedRequest(target: Target, value: string, resolveIP: ResolveAddress = resolveAddresses): Promise<{ url: URL; address: string }> {
  if (target.kind !== 'url') throw new Error('HTTP is unavailable for directory assessments');
  const url = webURL(new URL(value, target.url).href);
  if (url.origin !== target.origin) throw new Error(`Out of scope: only ${target.origin} is allowed`);
  const addresses = await resolveIP(url.hostname);
  if (!addresses.length || addresses.some(address => !publicIPv4(address))) throw new Error('Only public IPv4 targets are supported; private/reserved addresses are blocked');
  return { url, address: addresses[0] };
}

export function targetLabel(target: Target): string { return target.kind === 'directory' ? target.path : target.url; }
