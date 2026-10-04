import { createHash } from 'node:crypto';
import { invariant } from './errors.js';
export function record(value, label, keys) {
    invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', `${label} must be an object`);
    const obj = value;
    invariant(Object.getPrototypeOf(obj) === Object.prototype || Object.getPrototypeOf(obj) === null, 'INVALID_INPUT', `${label} must be plain JSON`);
    if (keys)
        invariant(Object.keys(obj).every(k => keys.includes(k)), 'INVALID_INPUT', `${label} has unknown fields`);
    return obj;
}
export function text(value, label, max = 512) {
    invariant(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), 'INVALID_INPUT', `${label} must be nonempty text`);
    return value;
}
export function identifier(value, label) {
    const s = text(value, label, 128);
    invariant(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(s), 'INVALID_INPUT', `${label} must be a safe identifier`);
    return s;
}
export function integer(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
    invariant(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_INPUT', `${label} must be a bounded integer`);
    return value;
}
export function list(value, label, parse, min = 0, max = 256) {
    invariant(Array.isArray(value) && value.length >= min && value.length <= max, 'INVALID_INPUT', `${label} must be a bounded array`);
    return value.map((v, i) => parse(v, `${label}[${i}]`));
}
export function strings(value, label, min = 0) {
    const result = list(value, label, text, min);
    invariant(new Set(result).size === result.length, 'INVALID_INPUT', `${label} contains duplicates`);
    return result;
}
export function choice(value, label, allowed) {
    invariant(typeof value === 'string' && allowed.includes(value), 'INVALID_INPUT', `Unsupported ${label}`);
    return value;
}
export function timestamp(value, label) {
    const s = text(value, label, 40);
    invariant(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(s) && Number.isFinite(Date.parse(s)), 'INVALID_INPUT', `${label} must be a UTC timestamp`);
    invariant(new Date(s).toISOString().slice(0, 19) === s.slice(0, 19), 'INVALID_INPUT', `${label} has an invalid calendar date`);
    return s;
}
export function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
export function digest(value) {
    const canonical = (v) => {
        if (Array.isArray(v))
            return `[${v.map(canonical).join(',')}]`;
        if (v && typeof v === 'object')
            return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
        return JSON.stringify(v) ?? 'null';
    };
    return createHash('sha256').update(canonical(value)).digest('hex');
}
