import { Type } from 'typebox';
import { OUTPUT_FIELDS, OUTPUT_KINDS, WORK_DISPOSITIONS, WORK_PURPOSES } from './work.js';
import { PLAN_DISPOSITIONS, PLAN_KINDS } from './planning.js';

const key = () => Type.String({ minLength: 1, maxLength: 160 });
const ids = () => Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 10 });
export const workSpecSchema = Type.Object({
  assetRefs: Type.Array(Type.Object({ id: Type.String({ pattern: '^asset-[a-f0-9]{24}$' }), revision: Type.Optional(Type.Integer({ minimum: 1 })), variant: Type.Optional(key()) }, { additionalProperties: false }), { minItems: 1, maxItems: 10 }),
  questionKey: key(), policyKey: Type.Optional(key()), actorContext: Type.Optional(key()), tenantContext: Type.Optional(key()),
  methodFamily: key(), purpose: Type.Union(WORK_PURPOSES.map(value => Type.Literal(value))),
}, { additionalProperties: false });
export const workDecisionSchema = Type.Object({
  disposition: Type.Union(WORK_DISPOSITIONS.map(value => Type.Literal(value))), reason: Type.String({ minLength: 10, maxLength: 1000 }),
  relatedTaskId: Type.Optional(Type.String({ maxLength: 80 })), changeReason: Type.Optional(Type.String({ minLength: 10, maxLength: 1000 })),
}, { additionalProperties: false });
export const outputContractSchema = Type.Object({
  kind: Type.Union(OUTPUT_KINDS.map(value => Type.Literal(value))), required: Type.Array(Type.Union(OUTPUT_FIELDS.map(value => Type.Literal(value))), { minItems: 1, maxItems: 8, uniqueItems: true }),
  partialAllowed: Type.Boolean(), artifactPolicy: Type.Union([Type.Literal('ids-only'), Type.Literal('bounded-text')]), notes: Type.Optional(Type.String({ maxLength: 1000 })),
}, { additionalProperties: false });
export const planEntrySchema = Type.Object({
  kind: Type.Union(PLAN_KINDS.map(value => Type.Literal(value))), title: Type.String({ minLength: 5, maxLength: 500 }), status: Type.String({ maxLength: 20 }), reason: Type.String({ minLength: 10, maxLength: 1000 }),
  criteria: Type.Optional(Type.Array(Type.String({ minLength: 5, maxLength: 500 }), { maxItems: 10 })), exclusions: Type.Optional(Type.Array(Type.String({ minLength: 5, maxLength: 500 }), { maxItems: 10 })),
  taskIds: Type.Optional(ids()), goalIds: Type.Optional(ids()), supportRefs: Type.Optional(ids()),
  decision: Type.Optional(Type.Object({ disposition: Type.Union(PLAN_DISPOSITIONS.map(value => Type.Literal(value))), chosenTaskIds: ids(), deferredTaskIds: ids(), revisitCondition: Type.Optional(Type.String({ minLength: 5, maxLength: 500 })) }, { additionalProperties: false })),
}, { additionalProperties: false });
/** Root object survives legacy provider projections; the host validates action-specific fields. */
export const planParameters = Type.Object({
  action: Type.Union(['create', 'revise', 'list', 'view'].map(value => Type.Literal(value))),
  entry: Type.Optional(planEntrySchema), id: Type.Optional(Type.String({ maxLength: 80 })), revision: Type.Optional(Type.Integer({ minimum: 1 })),
  requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  kind: Type.Optional(Type.Union(PLAN_KINDS.map(value => Type.Literal(value)))),
}, { additionalProperties: false });
