import { CONTROL, exact, plain, sha256Hex, TEXT_CONTROL } from './validate.js';
import { redact } from './evidence.js';
import { redactArtifactPrefix } from './artifacts.js';
import { graphCanonical } from './state/graph.js';
import { capabilityList, type Capability } from './capabilities.js';
import { isEnvironmentId } from './lab.js';

/** Structured exact-work identity. It is coordination knowledge, never scope authorization. */
export const WORK_IDENTITY_VERSION = 1;
// planning_update.md P14.4: exploitation and chaining are purposes, so taking a primitive to impact is a job with a duty
// instead of root-cause work with none.
export const WORK_PURPOSES = ['mapping','discovery','investigation','refinement','validation','retest','exploitation','chaining','reporting'] as const;
export const WORK_DISPOSITIONS = ['new','refine','validate','retest','retry'] as const;
export const OUTPUT_KINDS = ['inventory','policy','investigation','validation','retest','report','custom'] as const;
export const OUTPUT_FIELDS = ['assets','facts','evidence','controls','gaps','candidates','artifacts','coverage'] as const;

export interface WorkAssetRef { id:string; revision?:number; variant?:string }
export interface WorkSpec {
  assetRefs:WorkAssetRef[]; questionKey:string; policyKey?:string; actorContext?:string; tenantContext?:string;
  methodFamily:string; purpose:typeof WORK_PURPOSES[number];
  /** P9 lineage: same-run candidate record IDs this task builds on. It is what a plan is allowed to stand on, not dedup identity. */
  claimRefs?:string[];
  /**
   * P14.10: the typed capability this step consumes, so a task copied from the chain frontier says what it stands on instead of describing it
   * in prose. It is the `needs` the chain view joined, not a permission: a task is dispatched by the lead exactly as before.
   */
  needs?:Capability[];
  /** P14.10: the recorded environment (P14.3) the step must run in, when the chain it came from demonstrated one. */
  environmentRef?:string;
  /**
   * P14.11: the command allowance this task asks for. Omitted means the purpose's class decides (200 for research work, 400 for
   * exploitation and chaining, which spend commands on build/run/adjust cycles). It is an allowance, not identity: the same work with a
   * larger allowance is the same work, so it stays out of the fingerprint.
   */
  budget?:{commands?:number};
}
export interface WorkDecision {
  disposition:typeof WORK_DISPOSITIONS[number]; reason:string; relatedTaskId?:string; changeReason?:string;
}
export interface TaskOutputContract {
  kind:typeof OUTPUT_KINDS[number]; required:Array<typeof OUTPUT_FIELDS[number]>; partialAllowed:boolean;
  artifactPolicy:'ids-only'|'bounded-text'; notes?:string;
}
export interface WorkIdentity {
  confidence:'exact'|'unknown'; targetRevision:string; fingerprint?:string; overlapKey?:string; reason?:string;
}
export interface WorkTaskLike {
  id?:string; prerequisites:Array<{taskId:string;revision?:number}>; work?:WorkSpec; decision?:WorkDecision;
  validationOf?:string; retestOf?:string; outputContract?:TaskOutputContract;
}

const slugPattern=/^[a-z0-9][a-z0-9._:@/-]{0,159}$/;
function identity(value:unknown,label:string,max=160):string{
  if(typeof value!=='string'||value.length<1||value.length>max||value!==value.trim()||value!==value.normalize('NFC')
    ||CONTROL.test(value)||!slugPattern.test(value))throw Error(`Invalid work ${label}`);
  if(redactArtifactPrefix(value,redact)!==value)throw Error(`Work ${label} contains secret-bearing identity text; use an opaque non-secret handle`);
  return value;
}
function prose(value:unknown,label:string,max:number,min=5):string{
  if(typeof value!=='string'||value.trim().length<min||value.length>max||TEXT_CONTROL.test(value))throw Error(`Invalid work ${label}`);
  return redactArtifactPrefix(value,redact);
}
function taskId(value:unknown,label:string):string{
  if(typeof value!=='string'||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value))throw Error(`Invalid ${label}`);return value;
}
function revision(value:unknown,label:string):number|undefined{
  if(value===undefined)return;if(!Number.isSafeInteger(value)||Number(value)<1)throw Error(`Invalid ${label}`);return Number(value);
}

export function validateWorkSpec(value:unknown):WorkSpec{
  const row=plain(value,'work identity');exact(row,['assetRefs','questionKey','policyKey','actorContext','tenantContext','methodFamily','purpose','claimRefs','needs','environmentRef','budget'],'Work identity');
  if(!Array.isArray(row.assetRefs)||row.assetRefs.length<1||row.assetRefs.length>10)throw Error('Work identity needs 1..10 asset references');
  const seen=new Set<string>(),assetRefs=row.assetRefs.map((raw,index)=>{
    const item=plain(raw,`work asset ${index}`);exact(item,['id','revision','variant'],`Work asset ${index}`);
    const id=identity(item.id,'asset ID',80);if(!/^asset-[a-f0-9]{24}$/.test(id))throw Error('Work asset ID must be a retained graph entity ID');
    const pinned=revision(item.revision,'work asset revision');
    const result={id,...(pinned!==undefined?{revision:pinned}:{}),...(item.variant!==undefined?{variant:identity(item.variant,'variant',120)}:{})};
    const key=graphCanonical(result);if(seen.has(key))throw Error('Duplicate work asset reference');seen.add(key);return result;
  }).sort((a,b)=>graphCanonical(a)<graphCanonical(b)?-1:1);
  const purpose=identity(row.purpose,'purpose',32);if(!(WORK_PURPOSES as readonly string[]).includes(purpose))throw Error('Invalid work purpose');
  let claimRefs:string[]|undefined;
  if(row.claimRefs!==undefined){if(!Array.isArray(row.claimRefs)||row.claimRefs.length<1||row.claimRefs.length>10)throw Error('Work lineage needs 1..10 parent claim references');
    const seenClaim=new Set<string>();claimRefs=row.claimRefs.map((raw,index)=>{const id=identity(raw,`parent claim ${index}`,80);if(seenClaim.has(id))throw Error('Duplicate work parent claim reference');seenClaim.add(id);return id;}).sort();}
  const needs=row.needs===undefined?undefined:capabilityList(row.needs,'work needs');
  if(row.environmentRef!==undefined&&!isEnvironmentId(row.environmentRef))throw Error('Invalid work environment reference');
  let budget:{commands?:number}|undefined;
  if(row.budget!==undefined){
    const claimed=plain(row.budget,'work budget');exact(claimed,['commands'],'Work budget');
    if(claimed.commands!==undefined){if(!Number.isSafeInteger(claimed.commands)||Number(claimed.commands)<1||Number(claimed.commands)>5000)throw Error('Invalid work command budget');budget={commands:Number(claimed.commands)};}
    else budget={};
  }
  return {assetRefs,questionKey:identity(row.questionKey,'question key'),methodFamily:identity(row.methodFamily,'method family',80),purpose:purpose as WorkSpec['purpose'],
    ...(claimRefs?{claimRefs}:{}),...(needs?{needs}:{}),...(row.environmentRef!==undefined?{environmentRef:row.environmentRef as string}:{}),...(budget?{budget}:{}),
    ...(row.policyKey!==undefined?{policyKey:identity(row.policyKey,'policy key')}:{ }),...(row.actorContext!==undefined?{actorContext:identity(row.actorContext,'actor context')}:{ }),
    ...(row.tenantContext!==undefined?{tenantContext:identity(row.tenantContext,'tenant context')}:{ })};
}

export function validateWorkDecision(value:unknown,spec:WorkSpec,links:{validationOf?:string;retestOf?:string}):WorkDecision{
  const row=plain(value,'work decision');exact(row,['disposition','reason','relatedTaskId','changeReason'],'Work decision');
  const disposition=identity(row.disposition,'disposition',20);if(!(WORK_DISPOSITIONS as readonly string[]).includes(disposition))throw Error('Invalid work disposition');
  const result:WorkDecision={disposition:disposition as WorkDecision['disposition'],reason:prose(row.reason,'decision reason',1000,10),
    ...(row.relatedTaskId!==undefined?{relatedTaskId:taskId(row.relatedTaskId,'related task ID')}:{ }),...(row.changeReason!==undefined?{changeReason:prose(row.changeReason,'material change reason',1000,10)}:{ })};
  const linked=result.relatedTaskId;
  if(disposition==='new'&&(linked||result.changeReason))throw Error('New work cannot claim a prior task/change reason');
  if(disposition==='refine'&&(spec.purpose!=='refinement'||!linked))throw Error('Refinement needs purpose=refinement and relatedTaskId');
  if(disposition==='validate'&&(spec.purpose!=='validation'||!links.validationOf||linked!==links.validationOf))throw Error('Validation needs purpose=validation and matching validationOf/relatedTaskId');
  if(disposition==='retest'&&(spec.purpose!=='retest'||!links.retestOf||linked!==links.retestOf||!result.changeReason))throw Error('Retest needs purpose=retest, matching retestOf and a material change reason');
  if(disposition==='retry'&&(!linked||!result.changeReason))throw Error('Retry needs a prior task and an explicit reason after inspecting its gaps');
  if(spec.purpose==='refinement'&&disposition!=='refine'||spec.purpose==='validation'&&disposition!=='validate'||spec.purpose==='retest'&&disposition!=='retest')throw Error('Work purpose and disposition do not agree');
  return result;
}

export function validateOutputContract(value:unknown):TaskOutputContract{
  const row=plain(value,'task output contract');exact(row,['kind','required','partialAllowed','artifactPolicy','notes'],'Task output contract');
  const kind=identity(row.kind,'output kind',32);if(!(OUTPUT_KINDS as readonly string[]).includes(kind))throw Error('Invalid output contract kind');
  if(!Array.isArray(row.required)||row.required.length<1||row.required.length>8)throw Error('Output contract needs 1..8 required fields');
  const required=[...new Set(row.required.map(item=>identity(item,'output field',32)))];
  if(required.length!==row.required.length||required.some(item=>!(OUTPUT_FIELDS as readonly string[]).includes(item)))throw Error('Invalid or duplicate output contract field');
  if(typeof row.partialAllowed!=='boolean'||!['ids-only','bounded-text'].includes(String(row.artifactPolicy)))throw Error('Invalid output partial/artifact policy');
  return {kind:kind as TaskOutputContract['kind'],required:required as TaskOutputContract['required'],partialAllowed:row.partialAllowed,artifactPolicy:row.artifactPolicy as TaskOutputContract['artifactPolicy'],
    ...(row.notes!==undefined?{notes:prose(row.notes,'output notes',1000,5)}:{ })};
}

export function validateWorkFields(task:WorkTaskLike):void{
  if(task.retestOf!==undefined)taskId(task.retestOf,'retest task ID');
  if(task.work===undefined){if(task.decision!==undefined||task.retestOf!==undefined||task.outputContract!==undefined)throw Error('Structured decision/retest/output contract requires a work identity');return;}
  const spec=validateWorkSpec(task.work);if(task.decision===undefined)throw Error('Structured work needs an explicit dedup disposition/reason');
  validateWorkDecision(task.decision,spec,{validationOf:task.validationOf,retestOf:task.retestOf});
  if(task.outputContract===undefined)throw Error('Structured work needs a desired output contract');validateOutputContract(task.outputContract);
}

export function workIdentity(targetRevision:string,task:WorkTaskLike):WorkIdentity{
  if(typeof targetRevision!=='string'||targetRevision.length<1||targetRevision.length>160)throw Error('Invalid host target revision');
  if(!task.work)return {confidence:'unknown',targetRevision,reason:'Structured asset/question/method identity was not supplied'};
  const work=validateWorkSpec(task.work),prerequisites=task.prerequisites.map(p=>({taskId:taskId(p.taskId,'prerequisite task ID'),revision:revision(p.revision,'prerequisite revision')}))
    .sort((a,b)=>a.taskId<b.taskId?-1:a.taskId>b.taskId?1:(a.revision??0)-(b.revision??0));
  const overlap={version:WORK_IDENTITY_VERSION,targetRevision,assets:work.assetRefs.map(({id,variant})=>({id,variant:variant??null})),questionKey:work.questionKey,policyKey:work.policyKey??null};
  const overlapKey=sha256Hex(graphCanonical(overlap));
  if(prerequisites.some(p=>p.revision===undefined)||work.assetRefs.some(a=>a.revision===undefined)||work.actorContext===undefined||work.tenantContext===undefined)
    return {confidence:'unknown',targetRevision,overlapKey,reason:'Asset/prerequisite revisions or explicit actor/tenant context are missing'};
  // P14.10: what the task needed and where it ran are part of the work identity, not decoration on the task text.
  const full={...overlap,assets:work.assetRefs,actorContext:work.actorContext,tenantContext:work.tenantContext,methodFamily:work.methodFamily,purpose:work.purpose,
    needs:work.needs??null,environmentRef:work.environmentRef??null,prerequisites};
  return {confidence:'exact',targetRevision,overlapKey,fingerprint:sha256Hex(graphCanonical(full))};
}
