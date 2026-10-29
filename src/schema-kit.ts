import { Type } from 'typebox';
import { CAPABILITY_KINDS } from './capabilities.js';

/**
 * String enum as `{type:'string', enum:[…]}`. A union of `const` literals spells every value as its own `anyOf` branch, which makes the
 * declaration longer on every turn and is refused by providers without anyOf/const support; Pi's own `StringEnum` emits the same shape.
 */
export const choices = <const T extends readonly string[]>(values: T, description?: string) => Type.Unsafe<T[number]>({ type: 'string', enum: [...values], ...(description ? { description } : {}) });

/**
 * planning_update.md P14.1: one capability shape, used by every tool that writes one. It lives here rather than in tool-schemas.ts because
 * both the tool declarations and the work identity describe capabilities, and a cycle between those two modules would evaluate one of them
 * before the other had defined it. S1/C3 (F-43): the triple is declared 7x across the tool schemas, so its field descriptions are the one
 * place prose is paid seven times; the meaning lives in `src/capabilities.ts` and docs/KNOWLEDGE.md instead of the wire schema.
 */
export const capabilitySchema = Type.Object({
  kind: choices(CAPABILITY_KINDS),
  subject: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  scope: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
}, { additionalProperties: false });
