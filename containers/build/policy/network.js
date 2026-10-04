import { isIP } from 'node:net';
import { invariant } from './errors.js';
function parseAddress(input) {
    invariant(typeof input === 'string' && !input.includes('%'), 'ADDRESS_DENIED', 'Invalid IP address');
    const raw = input.replace(/^\[|\]$/g, '').toLowerCase();
    const family = isIP(raw);
    invariant(family !== 0, 'ADDRESS_DENIED', 'Expected a literal IP address');
    if (family === 4) {
        const parts = raw.split('.').map(Number);
        return { family: 4, bits: 32, value: parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n), text: parts.join('.') };
    }
    let expanded = raw;
    if (expanded.includes('.')) {
        const at = expanded.lastIndexOf(':');
        const v4 = parseAddress(expanded.slice(at + 1));
        expanded = `${expanded.slice(0, at)}:${(v4.value >> 16n).toString(16)}:${(v4.value & 65535n).toString(16)}`;
    }
    const halves = expanded.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
    const parts = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    const value = parts.reduce((n, p) => (n << 16n) | BigInt(`0x${p}`), 0n);
    // Normalize IPv4-mapped peers so a v6 spelling cannot bypass IPv4 exclusions.
    if (value >> 32n === 65535n) {
        const v4 = value & 0xffffffffn;
        const text = [24n, 16n, 8n, 0n].map(b => Number((v4 >> b) & 255n)).join('.');
        return { family: 4, bits: 32, value: v4, text };
    }
    return { family: 6, bits: 128, value, text: parts.map((p) => BigInt(`0x${p}`).toString(16)).join(':') };
}
export function normalizeAddress(value) { return parseAddress(value).text; }
export function validateCidr(cidr) {
    invariant(typeof cidr === 'string', 'INVALID_INPUT', 'Invalid CIDR');
    const [ip, prefix, ...extra] = cidr.split('/');
    const a = parseAddress(ip);
    invariant(extra.length === 0 && prefix !== undefined && /^\d+$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= a.bits, 'INVALID_INPUT', 'CIDR must have a bounded nonzero prefix');
}
export function addressInCidr(address, cidr) {
    validateCidr(cidr);
    const a = parseAddress(address);
    const [base, prefix] = cidr.split('/');
    const b = parseAddress(base);
    if (a.family !== b.family)
        return false;
    const shift = BigInt(a.bits - Number(prefix));
    return (a.value >> shift) === (b.value >> shift);
}
export function isLoopback(address) {
    return addressInCidr(address, '127.0.0.0/8') || addressInCidr(address, '::1/128');
}
export function isForbiddenAddress(address) {
    return ['0.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4', '::/128', 'fe80::/10', 'ff00::/8'].some(c => addressInCidr(address, c));
}
export function stableAddressSet(addresses) {
    invariant(addresses.length > 0 && addresses.length <= 32, 'ADDRESS_DENIED', 'Empty or excessive DNS answer');
    return [...new Set(addresses.map(normalizeAddress))].sort();
}
