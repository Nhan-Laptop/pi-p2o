import { invariant } from '../policy/errors.js';
import { integer, record } from '../policy/validation.js';
import type { Schema } from './types.js';

/** Small complete validator for the registry's deliberately limited JSON-schema vocabulary. */
export function validateSchema(schema: Schema, value: unknown, path = 'input', depth = 0): void {
  invariant(depth < 24, 'INVALID_INPUT', 'Schema nesting limit exceeded');
  if (schema.type === 'object') {
    const o = record(value, path);
    for (const required of schema.required ?? []) invariant(Object.hasOwn(o, required), 'INVALID_INPUT', `${path}.${required} is required`);
    for (const [key, v] of Object.entries(o)) {
      invariant(!['__proto__', 'prototype', 'constructor'].includes(key), 'INVALID_INPUT', 'Unsafe object key');
      const property = schema.properties?.[key];
      const next = property ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
      invariant(next, 'INVALID_INPUT', `${path} contains unknown fields`);
      validateSchema(next, v, `${path}.${key}`, depth + 1);
    }
  } else if (schema.type === 'array') {
    invariant(Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? 256), 'INVALID_INPUT', `${path} is not a bounded array`);
    invariant(schema.items, 'INVALID_INPUT', 'Array schema needs items');
    value.forEach((v, i) => validateSchema(schema.items!, v, `${path}[${i}]`, depth + 1));
  } else if (schema.type === 'string') {
    invariant(typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? 8192), 'INVALID_INPUT', `${path} is not bounded text`);
    if (schema.enum) invariant(schema.enum.includes(value), 'INVALID_INPUT', `${path} is not an approved value`);
  } else if (schema.type === 'integer') integer(value, path, schema.minimum ?? 0, schema.maximum ?? Number.MAX_SAFE_INTEGER);
  else invariant(false, 'INVALID_INPUT', 'Unsupported schema type');
}
