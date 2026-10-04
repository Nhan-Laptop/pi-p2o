import { isAbsolute, resolve } from 'node:path';
import { canonicalJson, type JsonValue } from '../contracts/index.js';

/** Strict config validation. Unknown fields are rejected; types are never coerced. */
export class ApplicationError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ApplicationError';
  }
}

export function fail(code: string, message: string): never {
  throw new ApplicationError(code, message);
}

export function isJsonValue(value: unknown): value is JsonValue {
  try { canonicalJson(value); return true; } catch { return false; }
}

export function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid-config', `${label} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key)) fail('invalid-config', `unknown ${label} field: ${key}`);
  return record;
}

export function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f]/.test(value)) {
    fail('invalid-config', `${label} must be a bounded non-empty string`);
  }
  return value;
}

export function optionalText(value: unknown, label: string, max = 4096): string | undefined {
  return value === undefined ? undefined : text(value, label, max);
}

export function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail('invalid-config', `${label} must be a boolean`);
  return value;
}

export function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('invalid-config', `${label} must be an integer in [${min}, ${max}]`);
  return value as number;
}

export function list<T>(value: unknown, label: string, item: (entry: unknown, index: number) => T, max = 4096): T[] {
  if (!Array.isArray(value) || value.length > max) fail('invalid-config', `${label} must be an array of at most ${max} entries`);
  return value.map((entry, index) => item(entry, index));
}

export function absolutePath(value: unknown, label: string): string {
  const path = text(value, label, 4096);
  if (!isAbsolute(path) || resolve(path) !== path) fail('invalid-config', `${label} must be a canonical absolute path`);
  return path;
}

export function literal<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail('invalid-config', `${label} must be one of ${allowed.join(', ')}`);
  return value as T;
}

export function optionalObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : object(value, keys, label);
}

/**
 * Strict worker observation selection. A worker may only name an owner-approved observation; inputs, kinds,
 * summaries, test outcomes and metadata are never accepted from worker payloads.
 */
export function parseObservationSelection(payload: unknown): { observationId: string } {
  const call = object(payload, ['observationId'], 'bridge call');
  return { observationId: text(call.observationId, 'observationId', 128) };
}
