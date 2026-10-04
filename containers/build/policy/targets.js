import { isIP } from 'node:net';
import { invariant } from './errors.js';
/** Refuse parser-ambiguous inputs instead of trusting WHATWG's dot-segment cleanup. */
export function normalizeWebTarget(value) {
    invariant(typeof value === 'string' && value.length > 0 && value.length <= 8192, 'INVALID_INPUT', 'Invalid URL size');
    invariant(!/[\s\u0000-\u0020\u007f\\]/u.test(value), 'INVALID_INPUT', 'URL contains whitespace, control or backslash');
    invariant(/^https?:\/\//i.test(value), 'TARGET_DENIED', 'Only absolute HTTP(S) URLs are supported');
    const rawPath = value.replace(/^https?:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0];
    invariant(!/%(?:2f|5c|2e|25)/i.test(rawPath), 'TARGET_DENIED', 'Encoded separators, dot segments or nested escapes are not supported');
    invariant(!rawPath.split('/').some(p => p === '.' || p === '..'), 'TARGET_DENIED', 'Dot segments are not supported');
    let canonicalPath;
    try {
        canonicalPath = decodeURIComponent(rawPath || '/').normalize('NFKC').replace(/\/+/g, '/');
    }
    catch {
        invariant(false, 'INVALID_INPUT', 'Malformed path encoding');
    }
    invariant(!/[\u0000-\u0020\u007f\\%;?#]/.test(canonicalPath) && !canonicalPath.split('/').some(p => p === '.' || p === '..'), 'TARGET_DENIED', 'Ambiguous decoded path or matrix parameters');
    let url;
    try {
        url = new URL(value);
    }
    catch {
        invariant(false, 'INVALID_INPUT', 'Invalid URL');
    }
    invariant(!url.username && !url.password, 'ACCOUNT_DENIED', 'URL credentials are forbidden');
    invariant(url.protocol === 'http:' || url.protocol === 'https:', 'TARGET_DENIED', 'Unsupported protocol');
    invariant(!url.hostname.includes('%'), 'TARGET_DENIED', 'Zone identifiers are forbidden');
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    invariant(hostname.length > 0 && (isIP(hostname) > 0 || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)), 'TARGET_DENIED', 'Invalid hostname');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    invariant(Number.isInteger(port) && port > 0 && port <= 65535, 'TARGET_DENIED', 'Invalid port');
    // Dispatch the canonical path too: %61dmin and duplicate/compatibility separators
    // cannot pass a check on one representation and reach a different server path.
    url.pathname = canonicalPath;
    url.pathname = url.pathname.replace(/%[0-9a-f]{2}/gi, p => p.toUpperCase());
    invariant(url.href.length <= 8192, 'INVALID_INPUT', 'Canonical URL exceeds byte limit');
    return Object.freeze({ url: url.href, origin: url.origin, protocol: url.protocol, hostname, port, path: url.pathname });
}
export function normalizeOrigin(value) {
    const n = normalizeWebTarget(value);
    const u = new URL(n.url);
    invariant(n.path === '/' && !u.search && !value.includes('#'), 'INVALID_INPUT', 'Origin must not include a path, query or fragment');
    return n.origin;
}
export function normalizePathPrefix(value) {
    invariant(typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[?#]/.test(value), 'INVALID_INPUT', 'Invalid path prefix');
    const p = normalizeWebTarget(`https://policy.invalid${value}`).path;
    return p.length > 1 ? p.replace(/\/+$/, '') : p;
}
export function pathWithin(path, prefix) {
    return prefix === '/' || path === prefix || path.startsWith(`${prefix}/`);
}
