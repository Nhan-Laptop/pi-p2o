import { createHash } from 'node:crypto';
import type { JsonValue } from './types.js';

export interface ValidationIssue { path: string; code: string; message: string }
export type ValidationResult<T> = { success: true; data: T } | { success: false; issues: ValidationIssue[] };
export class ValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(issues.map(i => `${i.path}: ${i.message}`).join('; '));
    this.name = 'ValidationError';
  }
}
export interface RuntimeSchema<T> {
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(input: unknown): T;
  safeParse(input: unknown): ValidationResult<T>;
  validate(input: unknown): input is T;
}
export interface Rule {
  schema: Record<string, unknown>;
  optional?: boolean;
  check(input: unknown, path: string, issues: ValidationIssue[]): void;
}
const issue = (issues: ValidationIssue[], path: string, code: string, message: string) => {
  if (issues.length < 100) issues.push({ path, code, message });
};
const plain = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const forbiddenKey = (key: string) => ['__proto__', 'constructor', 'prototype'].includes(key);
export const rules = {
  string(options: { pattern?: RegExp; minLength?: number; maxLength?: number; format?: string } = {}): Rule {
    const minLength = options.minLength ?? 1;
    const maxLength = options.maxLength ?? 16_384;
    return {
      schema: { type: 'string', minLength, maxLength, ...(options.pattern ? { pattern: options.pattern.source } : {}), ...(options.format ? { format: options.format } : {}) },
      check(v, p, e) {
        if (typeof v !== 'string') return issue(e, p, 'type', 'Expected a string');
        if (v.trim().length < minLength || v.length > maxLength) issue(e, p, 'length', 'String is empty or exceeds its bound');
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v)) issue(e, p, 'control-character', 'Control characters are not allowed');
        if (options.pattern && !options.pattern.test(v)) issue(e, p, 'pattern', 'String has an invalid representation');
        if (options.format === 'date-time' && !isTimestamp(v)) issue(e, p, 'date-time', 'Expected a real UTC ISO timestamp');
      },
    };
  },
  number(integer = false, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): Rule {
    return { schema: { type: integer ? 'integer' : 'number', minimum, maximum }, check(v, p, e) {
      if (typeof v !== 'number' || !Number.isFinite(v) || (integer && !Number.isSafeInteger(v)) || v < minimum || v > maximum) issue(e, p, 'number', 'Number is outside its permitted range');
    } };
  },
  boolean(): Rule { return { schema: { type: 'boolean' }, check(v, p, e) { if (typeof v !== 'boolean') issue(e, p, 'type', 'Expected a boolean'); } }; },
  literal(value: string | number | null): Rule { return { schema: { const: value }, check(v, p, e) { if (v !== value) issue(e, p, 'const', `Expected ${String(value)}`); } }; },
  enum(values: readonly string[]): Rule { return { schema: { type: 'string', enum: [...values] }, check(v, p, e) { if (typeof v !== 'string' || !values.includes(v)) issue(e, p, 'enum', 'Unknown enum value'); } }; },
  optional(rule: Rule): Rule { return { ...rule, optional: true }; },
  array(item: Rule, minItems = 0, unique = false): Rule {
    return { schema: { type: 'array', items: item.schema, minItems, maxItems: 10_000, ...(unique ? { uniqueItems: true } : {}) }, check(v, p, e) {
      if (!Array.isArray(v)) return issue(e, p, 'type', 'Expected an array');
      if (v.length < minItems || v.length > 10_000) return issue(e, p, 'items', 'Array has too few or too many items');
      const descriptors = Object.getOwnPropertyDescriptors(v);
      for (let i = 0; i < v.length; i++) {
        const d = descriptors[String(i)];
        if (!d || !('value' in d)) issue(e, `${p}/${i}`, 'json', 'Sparse arrays and accessors are not JSON');
        else item.check(d.value, `${p}/${i}`, e);
      }
      if (unique && e.length === 0 && new Set(v.map(x => canonicalJson(x))).size !== v.length) issue(e, p, 'duplicate', 'Duplicate array entries');
    } };
  },
  object(fields: Record<string, Rule>): Rule {
    return { schema: { type: 'object', properties: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.schema])), required: Object.entries(fields).filter(([, v]) => !v.optional).map(([k]) => k), additionalProperties: false }, check(v, p, e) {
      if (!plain(v)) return issue(e, p, 'type', 'Expected a plain JSON object');
      const descriptors = Object.getOwnPropertyDescriptors(v);
      if (Reflect.ownKeys(v).length > 10_000) return issue(e, p, 'size', 'Object exceeds its bound');
      for (const key of Reflect.ownKeys(v)) {
        if (typeof key !== 'string' || forbiddenKey(key) || !Object.hasOwn(fields, key)) issue(e, p, 'additional-property', 'Unknown or unsafe object property');
      }
      for (const [key, rule] of Object.entries(fields)) {
        const d = descriptors[key];
        if (!d) { if (!rule.optional) issue(e, `${p}/${key}`, 'required', 'Required field is missing'); }
        else if (!('value' in d)) issue(e, `${p}/${key}`, 'json', 'Accessors are not JSON');
        else rule.check(d.value, `${p}/${key}`, e);
      }
    } };
  },
  record(item: Rule, keyPattern?: RegExp): Rule {
    return { schema: { type: 'object', additionalProperties: item.schema, ...(keyPattern ? { propertyNames: { pattern: keyPattern.source } } : {}) }, check(v, p, e) {
      if (!plain(v)) return issue(e, p, 'type', 'Expected a JSON record');
      if (Reflect.ownKeys(v).length > 10_000) return issue(e, p, 'size', 'Record exceeds its bound');
      for (const key of Reflect.ownKeys(v)) {
        if (typeof key !== 'string' || forbiddenKey(key) || (keyPattern && !keyPattern.test(key))) { issue(e, p, 'key', 'Unsafe record key'); continue; }
        const d = Object.getOwnPropertyDescriptor(v, key)!;
        if (!('value' in d)) issue(e, p, 'json', 'Accessors are not JSON');
        else item.check(d.value, `${p}/${key}`, e);
      }
    } };
  },
  union(...variants: Rule[]): Rule {
    return { schema: { anyOf: variants.map(v => v.schema) }, check(v, p, e) {
      const failures = variants.map(rule => { const errors: ValidationIssue[] = []; rule.check(v, p, errors); return errors; });
      if (failures.some(f => f.length === 0)) return;
      const closest = failures.sort((a, b) => a.length - b.length)[0];
      for (const i of closest) issue(e, i.path, i.code, i.message);
    } };
  },
  jsonObject(): Rule {
    return { schema: { type: 'object', additionalProperties: {} }, check(v, p, e) {
      if (!plain(v)) return issue(e, p, 'type', 'Expected JSON metadata object');
      checkJson(v, p, e, new Set(), 0, { count: 0, chars: 0 });
    } };
  },
};
function checkJson(v: unknown, p: string, e: ValidationIssue[], seen: Set<unknown>, depth: number, budget: { count: number; chars: number }): void {
  if (++budget.count > 50_000 || depth > 32 || budget.chars > 2_000_000) return issue(e, p, 'size', 'JSON exceeds its depth/size bound');
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'string') { budget.chars += v.length; if (v.length > 65_536 || budget.chars > 2_000_000) issue(e, p, 'size', 'JSON strings exceed their per-value/aggregate bound'); return; }
  if (typeof v === 'number' && Number.isFinite(v)) return;
  if (!Array.isArray(v) && !plain(v)) return issue(e, p, 'json', 'Value is not JSON');
  if (seen.has(v)) return issue(e, p, 'json', 'Cyclic value is not JSON');
  seen.add(v);
  if (Reflect.ownKeys(v).length > 10_000) { seen.delete(v); return issue(e, p, 'size', 'JSON object exceeds its property bound'); }
  const descriptors = Object.getOwnPropertyDescriptors(v);
  for (const key of Reflect.ownKeys(v)) {
    if (Array.isArray(v) && key === 'length') continue;
    if (typeof key !== 'string' || forbiddenKey(key)) { issue(e, p, 'key', 'Unsafe JSON key'); continue; }
    budget.chars += key.length;
    const d = descriptors[key];
    if (!d || !('value' in d)) issue(e, p, 'json', 'Accessors are not JSON');
    else checkJson(d.value, `${p}/${key}`, e, seen, depth + 1, budget);
  }
  if (Array.isArray(v) && Object.keys(v).length !== v.length) issue(e, p, 'json', 'Sparse arrays are not JSON');
  seen.delete(v);
}
export function isTimestamp(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v)) return false;
  const n = Date.parse(v);
  return Number.isFinite(n) && new Date(n).toISOString() === (v.includes('.') ? v : v.replace('Z', '.000Z'));
}
export function makeSchema<T>(name: string, rule: Rule, refine?: (value: T, issues: ValidationIssue[]) => void): RuntimeSchema<T> {
  const jsonSchema = Object.freeze({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `urn:p2o:contracts:v1:${name}`, ...rule.schema });
  function safeParse(input: unknown): ValidationResult<T> {
    const issues: ValidationIssue[] = [];
    checkJson(input, '$', issues, new Set(), 0, { count: 0, chars: 0 });
    if (issues.length === 0) rule.check(input, '$', issues);
    if (issues.length === 0) refine?.(input as T, issues);
    if (issues.length) return { success: false, issues };
    // Detached plain JSON prevents a caller from mutating a validated receipt during admission.
    return { success: true, data: JSON.parse(canonicalJson(input)) as T };
  }
  return { jsonSchema, safeParse, parse(input) { const result = safeParse(input); if (!result.success) throw new ValidationError(result.issues); return result.data; }, validate(input): input is T { return safeParse(input).success; } };
}
export function canonicalJson(input: unknown): string {
  const issues: ValidationIssue[] = [];
  checkJson(input, '$', issues, new Set(), 0, { count: 0, chars: 0 });
  if (issues.length) throw new ValidationError(issues);
  const encode = (v: JsonValue): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(encode).join(',')}]`;
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${encode(v[k])}`).join(',')}}`;
  };
  return encode(input as JsonValue);
}
export function digestJson(input: unknown): string { return createHash('sha256').update(canonicalJson(input)).digest('hex'); }
