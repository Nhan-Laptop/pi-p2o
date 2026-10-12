import { Type } from 'typebox';

/**
 * String enum as `{type:'string', enum:[…]}`. A union of `const` literals spells every value as its own `anyOf` branch, which makes the
 * declaration longer on every turn and is refused by providers without anyOf/const support; Pi's own `StringEnum` emits the same shape.
 */
export const choices = <const T extends readonly string[]>(values: T) => Type.Unsafe<T[number]>({ type: 'string', enum: [...values] });
