import { Type } from 'typebox';
import { choices } from './schema-kit.js';
import { capabilitySchema } from './schema-kit.js';
import { OUTPUT_FIELDS, OUTPUT_KINDS, WORK_DISPOSITIONS, WORK_PURPOSES } from './work.js';
import { PLAN_DISPOSITIONS, PLAN_KINDS } from './planning.js';

const key = () => Type.String({ minLength: 1, maxLength: 160 });
const ids = () => Type.Array(Type.String({ minLength: 1, maxLength: 80 }));
export const workSpecSchema = Type.Object({
  assetRefs: Type.Array(Type.Object({ id: Type.String({ pattern: '^asset-[a-f0-9]{24}$' }), revision: Type.Optional(Type.Integer({ minimum: 1 })), variant: Type.Optional(key()) }, { additionalProperties: false }), { minItems: 1 }),
  questionKey: key(), policyKey: Type.Optional(key()), actorContext: Type.Optional(key()), tenantContext: Type.Optional(key()),
  methodFamily: key(), purpose: choices(WORK_PURPOSES),
  claimRefs: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { minItems: 1, uniqueItems: true })),
  needs: Type.Optional(Type.Array(capabilitySchema, { minItems: 1, description: 'Typed capability this step consumes; copy it from the chain frontier rather than describing it' })),
  environmentRef: Type.Optional(Type.String({ pattern: '^env-[a-f0-9-]{36}$', description: 'Recorded environment this step must run in (p2o_lab env); a task without one is a task nobody can replay' })),
}, { additionalProperties: false });
export const workDecisionSchema = Type.Object({
  disposition: choices(WORK_DISPOSITIONS), reason: Type.String({ minLength: 10, maxLength: 1000 }),
  relatedTaskId: Type.Optional(Type.String({ maxLength: 80 })), changeReason: Type.Optional(Type.String({ minLength: 10, maxLength: 1000 })),
}, { additionalProperties: false });
export const outputContractSchema = Type.Object({
  kind: choices(OUTPUT_KINDS), required: Type.Array(choices(OUTPUT_FIELDS), { minItems: 1, uniqueItems: true }),
  partialAllowed: Type.Boolean(), artifactPolicy: choices(['ids-only', 'bounded-text']), notes: Type.Optional(Type.String({ maxLength: 1000 })),
}, { additionalProperties: false });
export const planEntrySchema = Type.Object({
  kind: choices(PLAN_KINDS), title: Type.String({ minLength: 5, maxLength: 500 }), status: Type.String({ maxLength: 20 }), reason: Type.String({ minLength: 10, maxLength: 1000 }),
  criteria: Type.Optional(Type.Array(Type.String({ minLength: 5, maxLength: 500 }))), exclusions: Type.Optional(Type.Array(Type.String({ minLength: 5, maxLength: 500 }))),
  taskIds: Type.Optional(ids()), goalIds: Type.Optional(ids()), supportRefs: Type.Optional(ids()),
  /** P16.1: what settles this goal. Every goal names one; `reviewed`/`closed` is refused until it holds. */
  proof: Type.Optional(Type.Object({ kind: choices(['capability', 'case', 'coverage']), capability: Type.Optional(capabilitySchema), ref: Type.Optional(ids()) }, { additionalProperties: false, description: 'capability: a typed capability a confirmed+tested claim gains; case: an accepted confirmed case id; coverage: a coverage plan id whose cells are all terminal' })),
  /** M1: a chain link is derived on read, so the row stores only which claims it stands on and what it consumes. */
  decision: Type.Optional(Type.Object({ disposition: choices(PLAN_DISPOSITIONS), chosenTaskIds: ids(), deferredTaskIds: ids(), revisitCondition: Type.Optional(Type.String({ minLength: 5, maxLength: 500 })) }, { additionalProperties: false })),
  // P16.5: the mechanism family this step tries; when omitted the method family of what it cites becomes the route.
  route: Type.Optional(Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,31}$', description: 'P16.5: mechanism family this step tries (upload, auth, sqli, deser, ssrf, path, injection, business-logic); defaults from the cited claim\'s risk/capability' })),
  // M1: a chain step names the claims it stands on and the capabilities it consumes; readiness is derived from those, never stored.
  claimRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, uniqueItems: true, description: 'Same-run candidate record IDs this step stands on; a chain step must cite at least one' })),
  needs: Type.Optional(Type.Array(capabilitySchema, { minItems: 1, description: 'Typed capabilities this step consumes; copy them from the chain frontier' })),
  environmentRef: Type.Optional(Type.String({ pattern: '^env-[a-f0-9-]{36}$', description: 'Recorded environment this step runs in (p2o_lab env)' })),
  chainOf: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-z0-9][a-z0-9-]*$', description: 'Chain identity shared by its steps' })),
  step: Type.Optional(Type.Integer({ minimum: 1, description: '1-based position in the chain' })),
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
