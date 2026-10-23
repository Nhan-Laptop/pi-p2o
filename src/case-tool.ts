import { Type } from 'typebox';
import { choices } from './schema-kit.js';
import { CASE_REVIEW_STATUSES, CASE_VERDICTS, FINDING_SEVERITIES, REMEDIATION_STATUSES, REPRODUCTION_ROLES } from './case-types.js';
import { CASE_EFFECTS, CHAIN_REACH_METRICS } from './cvss.js';
/** The executed depth must name what it demonstrated: the host turns this into CVSS 4.0 impact and refuses a higher rating. */
const effectSchema = Type.Unsafe<CaseEffect>({ type: 'string', enum: [...CASE_EFFECTS], description: 'Effect the executed step itself showed. The host maps it to CVSS 4.0 impact, and the finding severity cannot exceed the result' });
import { capabilitySchema } from './tool-schemas.js';
import type { CaseEffect } from './cvss.js';
import { COVERAGE_ASSESSMENT, COVERAGE_EXECUTION, COVERAGE_PLAN_STATUS } from './coverage-types.js';
const id=()=>Type.String({minLength:1,maxLength:80}),ids=()=>Type.Array(id(),{maxItems:10,uniqueItems:true}),key=(max=160)=>Type.String({minLength:1,maxLength:max});
const taskRef=Type.Object({taskId:id(),revision:Type.Optional(Type.Integer({minimum:1}))},{additionalProperties:false});
export const caseEntrySchema=Type.Object({
  title:Type.String({minLength:5,maxLength:500}),policyKey:key(),rootCauseKey:Type.Optional(key()),hypothesis:Type.Optional(Type.Object({id:Type.String({pattern:'^assertion-[a-f0-9]{24}$'}),revision:Type.Integer({minimum:1})},{additionalProperties:false})),
  assetRefs:Type.Array(Type.Object({id:Type.String({pattern:'^asset-[a-f0-9]{24}$'}),revision:Type.Optional(Type.Integer({minimum:1})),variant:Type.Optional(key(120))},{additionalProperties:false}),{minItems:1,maxItems:10}),
  claimRefs:Type.Array(id(),{minItems:1,maxItems:10,uniqueItems:true}),independentEvidenceRefs:ids(),taskRefs:Type.Array(taskRef,{maxItems:10}),reportRefs:ids(),
  contradictions:Type.Array(Type.Object({evidenceRef:id(),status:choices(['open', 'resolved']),reason:Type.String({minLength:10,maxLength:1000})},{additionalProperties:false}),{maxItems:10}),
  affectedVariants:Type.Array(key(120),{maxItems:20,uniqueItems:true}),relatedCaseIds:ids(),duplicateOf:Type.Optional(id()),
  verdict:choices(CASE_VERDICTS),reviewStatus:choices(CASE_REVIEW_STATUSES),reviewReason:Type.String({minLength:10,maxLength:1500}),limitations:Type.String({minLength:10,maxLength:2000}),
  remediation:Type.Object({status:choices(REMEDIATION_STATUSES),reason:Type.String({minLength:10,maxLength:1000}),evidenceRefs:ids(),retestTask:Type.Optional(taskRef)},{additionalProperties:false}),
},{additionalProperties:false});
/** Rating of one case, supplied only with action=rate. The host validates every field (patterns, lengths, evidence IDs) and computes the CVSS score from the vector, so the schema stays short. `chain` is the ordered execution chain the owner assembled; `claimRef` on a step names the candidate that ran that step. */
export const findingSchema=Type.Object({severity:choices(FINDING_SEVERITIES),basis:Type.String({maxLength:1000}),likelihood:Type.Optional(Type.String({maxLength:800})),impact:Type.Optional(Type.String({maxLength:800})),
  cvssVector:Type.Optional(Type.String()),cwe:Type.Optional(Type.Array(Type.String(),{maxItems:5})),remediationSteps:Type.Optional(Type.String({maxLength:2000})),
  references:Type.Optional(Type.Array(Type.String(),{maxItems:5})),reproductionEvidenceRefs:Type.Optional(Type.Array(Type.String(),{maxItems:5})),reproductionSteps:Type.Optional(Type.Array(Type.Object({ref:Type.String(),role:choices(REPRODUCTION_ROLES),note:Type.Optional(Type.String({maxLength:200}))},{additionalProperties:false}),{minItems:1,maxItems:5})),independenceWaiver:Type.Optional(Type.String({maxLength:300})),
  chain:Type.Optional(Type.Object({objective:Type.String({maxLength:600}),steps:Type.Array(Type.Object({order:Type.Integer(),step:Type.String({minLength:5,maxLength:400}),claimRef:Type.Optional(id()),
      gained:Type.Optional(Type.Array(capabilitySchema,{maxItems:10,description:'Typed capabilities this step hands to the next one; prose is not joined'})),
      needs:Type.Optional(Type.Array(capabilitySchema,{maxItems:10,description:'Typed capabilities this step needs from an earlier step'})),
      effect:Type.Optional(effectSchema),
      reach:Type.Optional(Type.Object({AV:choices(CHAIN_REACH_METRICS.AV),AC:choices(CHAIN_REACH_METRICS.AC),AT:choices(CHAIN_REACH_METRICS.AT),PR:choices(CHAIN_REACH_METRICS.PR),UI:choices(CHAIN_REACH_METRICS.UI)},{additionalProperties:false,description:'How the attacker reached this step. The chain scores at the easiest reach any executed step reported; unreported reach scores at the least favourable values, so missing evidence can only lower the score'}))},{additionalProperties:false}),{minItems:1,maxItems:8}),demonstratedThrough:Type.Optional(Type.Integer())},{additionalProperties:false}))},{additionalProperties:false});
export const CASE_ACTIONS=['create','revise','rate','list','view'] as const;
/** P13e: exhaustive per action, so dropping `rate`'s requestId cannot slip through a default branch. */
export const CASE_ACTION_PARAMETERS: Readonly<Record<typeof CASE_ACTIONS[number], readonly string[]>> = {
  create:['action','entry','requestId'], revise:['action','entry','id','revision','requestId'],
  rate:['action','finding','id','revision','requestId'], view:['action','id'], list:['action','cursor','limit','status'],
};
/** Root object preserves fields through legacy provider projections. Host enforces action shape. */
export const caseParameters=Type.Object({action:choices(CASE_ACTIONS),entry:Type.Optional(caseEntrySchema),finding:Type.Optional(findingSchema),id:Type.Optional(id()),revision:Type.Optional(Type.Integer({minimum:1})),requestId:Type.Optional(id()),cursor:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),status:Type.Optional(choices(CASE_REVIEW_STATUSES))},{additionalProperties:false});
export const coveragePlanSchema=Type.Object({title:Type.String({minLength:5,maxLength:500}),status:choices(COVERAGE_PLAN_STATUS),reason:Type.String({minLength:10,maxLength:1500}),exclusions:Type.Array(Type.String({minLength:5,maxLength:500}),{maxItems:10}),unknownScope:Type.Array(Type.String({minLength:5,maxLength:500}),{maxItems:10})},{additionalProperties:false});
export const coverageCellSchema=Type.Object({assetRef:Type.Object({id:Type.String({pattern:'^asset-[a-f0-9]{24}$'}),revision:Type.Optional(Type.Integer({minimum:1})),variant:Type.Optional(key(120))},{additionalProperties:false}),questionKey:key(),policyKey:Type.Optional(key()),actorContext:key(),tenantContext:key(),methodFamily:key(80),execution:choices(COVERAGE_EXECUTION),assessment:choices(COVERAGE_ASSESSMENT),taskRefs:Type.Array(taskRef,{maxItems:10}),claimRefs:ids(),caseRefs:Type.Array(Type.Object({caseId:id(),revision:Type.Integer({minimum:1})},{additionalProperties:false}),{maxItems:10}),evidenceRefs:ids(),negativeControlRefs:ids(),gapRefs:ids(),reason:Type.String({minLength:10,maxLength:1500}),limitations:Type.String({minLength:10,maxLength:2000})},{additionalProperties:false});
export const COVERAGE_MUTATIONS=['plan-create','plan-revise','cell-create','cell-revise','cell-retire'] as const;
export const COVERAGE_ACTIONS=[...COVERAGE_MUTATIONS,'list','view','suggest'] as const;
/** P13e: exhaustive per action, enumerated instead of inferred from COVERAGE_MUTATIONS order. */
export const COVERAGE_ACTION_PARAMETERS: Readonly<Record<typeof COVERAGE_ACTIONS[number], readonly string[]>> = {
  'plan-create':['action','plan','requestId'], 'plan-revise':['action','plan','id','revision','requestId'],
  'cell-create':['action','cell','planId','planRevision','requestId'], 'cell-revise':['action','cell','id','revision','requestId'],
  'cell-retire':['action','id','revision','reason','requestId'], list:['action','cursor','limit'], view:['action','id'],
  suggest:['action','features','modes','cursor','limit'],
};
export const coverageParameters=Type.Object({action:choices(COVERAGE_ACTIONS),plan:Type.Optional(coveragePlanSchema),cell:Type.Optional(coverageCellSchema),id:Type.Optional(id()),revision:Type.Optional(Type.Integer({minimum:1})),planId:Type.Optional(id()),planRevision:Type.Optional(Type.Integer({minimum:1})),reason:Type.Optional(Type.String({minLength:10,maxLength:1000})),requestId:Type.Optional(id()),cursor:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),features:Type.Optional(Type.Array(Type.String({maxLength:40}),{maxItems:20})),modes:Type.Optional(Type.String({maxLength:5}))},{additionalProperties:false});
