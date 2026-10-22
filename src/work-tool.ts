import { Type } from 'typebox';
import { choices } from './schema-kit.js';
import { OUTPUT_FIELDS, OUTPUT_KINDS, WORK_DISPOSITIONS, WORK_PURPOSES } from './work.js';
import { PLAN_DISPOSITIONS, PLAN_KINDS } from './planning.js';

const key = () => Type.String({ minLength: 1, maxLength: 160 });
const ids = () => Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 10 });
export const workSpecSchema = Type.Object({
  assetRefs: Type.Array(Type.Object({ id: Type.String({ pattern: '^asset-[a-f0-9]{24}$' }), revision: Type.Optional(Type.Integer({ minimum: 1 })), variant: Type.Optional(key()) }, { additionalProperties: false }), { minItems: 1, maxItems: 10 }),
  questionKey: key(), policyKey: Type.Optional(key()), actorContext: Type.Optional(key()), tenantContext: Type.Optional(key()),
  methodFamily: key(), purpose: choices(WORK_PURPOSES),
  claimRefs: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { minItems: 1, maxItems: 10, uniqueItems: true })),
}, { additionalProperties: false });
export const workDecisionSchema = Type.Object({
  disposition: choices(WORK_DISPOSITIONS), reason: Type.String({ minLength: 10, maxLength: 1000 }),
  relatedTaskId: Type.Optional(Type.String({ maxLength: 80 })), changeReason: Type.Optional(Type.String({ minLength: 10, maxLength: 1000 })),
}, { additionalProperties: false });
export const outputContractSchema = Type.Object({
  kind: choices(OUTPUT_KINDS), required: Type.Array(choices(OUTPUT_FIELDS), { minItems: 1, maxItems: 8, uniqueItems: true }),
  partialAllowed: Type.Boolean(), artifactPolicy: choices(['ids-only', 'bounded-text']), notes: Type.Optional(Type.String({ maxLength: 1000 })),
}, { additionalProperties: false });
export const planEntrySchema = Type.Object({
  kind: choices(PLAN_KINDS), title: Type.String({ minLength: 5, maxLength: 500 }), status: Type.String({ maxLength: 20 }), reason: Type.String({ minLength: 10, maxLength: 1000 }),
  criteria: Type.Optional(Type.Array(Type.String({ minLength: 5, maxLength: 500 }), { maxItems: 10 })), exclusions: Type.Optional(Type.Array(Type.String({ minLength: 5, maxLength: 500 }), { maxItems: 10 })),
  taskIds: Type.Optional(ids()), goalIds: Type.Optional(ids()), supportRefs: Type.Optional(ids()),
  decision: Type.Optional(Type.Object({ disposition: choices(PLAN_DISPOSITIONS), chosenTaskIds: ids(), deferredTaskIds: ids(), revisitCondition: Type.Optional(Type.String({ minLength: 5, maxLength: 500 })) }, { additionalProperties: false })),
}, { additionalProperties: false });
export const PLAN_ACTIONS = ['create', 'revise', 'list', 'view'] as const;
/** P13e: exhaustive per action; `list` is spelled out rather than left to a default branch. */
export const PLAN_ACTION_PARAMETERS: Readonly<Record<typeof PLAN_ACTIONS[number], readonly string[]>> = {
  create: ['action','entry','requestId'], revise: ['action','entry','id','revision','requestId'], view: ['action','id'], list: ['action','cursor','limit','kind'],
};
/** Root object survives legacy provider projections; the host validates action-specific fields. */
export const planParameters = Type.Object({
  action: choices(PLAN_ACTIONS),
  entry: Type.Optional(planEntrySchema), id: Type.Optional(Type.String({ maxLength: 80 })), revision: Type.Optional(Type.Integer({ minimum: 1 })),
  requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  kind: Type.Optional(choices(PLAN_KINDS)),
}, { additionalProperties: false });
