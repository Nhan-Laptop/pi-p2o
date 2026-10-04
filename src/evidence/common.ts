import { createHash } from 'node:crypto';
import { canonicalJson, ID_PATTERN, isTimestamp, makeSchema, rules } from '../contracts/index.js';

export class EvidenceError extends Error {
  constructor(public readonly code: string, message: string) { super(`${message} (${code})`); this.name = 'EvidenceError'; }
}
export function requireEvidence(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new EvidenceError(code, message);
}
export function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function snapshot<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
export function checkId(value: string): void { requireEvidence(ID_PATTERN.test(value), 'identity', 'Expected a bounded machine identity'); }
export function checkTime(value: string): number { requireEvidence(isTimestamp(value), 'timestamp', 'Expected a real UTC timestamp'); return Date.parse(value); }
export const idRule = rules.string({ pattern: ID_PATTERN, maxLength: 128 });
export const digestRule = rules.string({ pattern: /^[a-f0-9]{64}$/, maxLength: 64 });
export const timeRule = rules.string({ format: 'date-time', maxLength: 24 });
export function checkedJson(value: unknown): unknown { return makeSchema<unknown>('evidence-json', rules.jsonObject()).parse(value); }
export function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every(v => right.includes(v));
}
export function normalized(value: string): string { return value.trim().replace(/\s+/g, ' '); }
