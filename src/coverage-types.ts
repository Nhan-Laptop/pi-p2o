export const COVERAGE_EXECUTION=['unplanned','planned','running','attempted','tested','blocked','not_applicable'] as const;
export const COVERAGE_ASSESSMENT=['unreviewed','confirmed_claim','ruled_out_bounded','open_gap','accepted','stale'] as const;
export const COVERAGE_PLAN_STATUS=['draft','active','reviewed','closed','cancelled'] as const;
export type CoverageExecution=typeof COVERAGE_EXECUTION[number];
export type CoverageAssessment=typeof COVERAGE_ASSESSMENT[number];
export type CoveragePlanStatus=typeof COVERAGE_PLAN_STATUS[number];
export interface CoverageTaskRef {taskId:string;revision?:number}
export interface CoverageCaseRef {caseId:string;revision:number}
export interface CoveragePlanDraft {id?:string;title:string;status:CoveragePlanStatus;reason:string;exclusions:string[];unknownScope:string[]}
export interface CoveragePlanEntry extends CoveragePlanDraft {id:string;runId:string;revision:number;recordId:string;targetRevision:string;cellIds:string[]}
export interface CoverageCellDraft {
  id?:string;assetRef:{id:string;revision?:number;variant?:string};questionKey:string;policyKey?:string;actorContext:string;tenantContext:string;methodFamily:string;
  execution:CoverageExecution;assessment:CoverageAssessment;taskRefs:CoverageTaskRef[];claimRefs:string[];caseRefs:CoverageCaseRef[];evidenceRefs:string[];negativeControlRefs:string[];gapRefs:string[];
  reason:string;limitations:string;
}
export interface CoverageCellEntry extends CoverageCellDraft {id:string;runId:string;revision:number;recordId:string;planId:string;planRevision:number;targetRevision:string;fingerprint:string;retired:boolean}
const CONTROL=/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
function plain(value:unknown,label:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw Error(`Invalid ${label}`);return value as Record<string,unknown>}
function exact(row:Record<string,unknown>,allowed:string[],label:string){if(Object.keys(row).some(key=>!allowed.includes(key)))throw Error(`${label} contains host-owned or unknown fields`)}
function text(value:unknown,label:string,max:number,min=1):string{if(typeof value!=='string'||value.trim().length<min||value.length>max||value!==value.normalize('NFC')||CONTROL.test(value))throw Error(`Invalid coverage ${label}`);return value}
function key(value:unknown,label:string,max=160):string{const result=text(value,label,max);if(!/^[a-z0-9][a-z0-9._:/-]*$/.test(result))throw Error(`Invalid coverage ${label}`);return result}
function id(value:unknown,label:string):string{const result=text(value,label,80);if(!/^[a-z0-9][a-z0-9-]{0,79}$/.test(result))throw Error(`Invalid coverage ${label}`);return result}
function revision(value:unknown,label:string):number{if(!Number.isSafeInteger(value)||Number(value)<1)throw Error(`Invalid coverage ${label}`);return Number(value)}
function ids(value:unknown,label:string,max=10):string[]{if(!Array.isArray(value)||value.length>max)throw Error(`Invalid coverage ${label}`);const result=value.map(item=>id(item,label));if(new Set(result).size!==result.length)throw Error(`Duplicate coverage ${label}`);return result}
function prose(value:unknown,label:string,max=10):string[]{if(!Array.isArray(value)||value.length>max)throw Error(`Invalid coverage ${label}`);return value.map(item=>text(item,label,500,5));}

export function validateCoveragePlanDraft(value:unknown):CoveragePlanDraft{
  const row=plain(value,'coverage plan');exact(row,['id','title','status','reason','exclusions','unknownScope'],'Coverage plan');if(typeof row.status!=='string'||!(COVERAGE_PLAN_STATUS as readonly string[]).includes(row.status))throw Error('Invalid coverage plan status');
  const result:CoveragePlanDraft={title:text(row.title,'plan title',500,5),status:row.status as CoveragePlanStatus,reason:text(row.reason,'plan reason',1500,10),exclusions:prose(row.exclusions,'plan exclusion'),unknownScope:prose(row.unknownScope,'unknown scope')};if(row.id!==undefined)result.id=id(row.id,'plan ID');return result;
}
export function validateStoredCoveragePlan(value:unknown,recordId:string):CoveragePlanEntry{
  const row=plain(value,'stored coverage plan'),{runId,revision:rev,targetRevision,cellIds,...input}=row,plan=validateCoveragePlanDraft(input);if(!plan.id)throw Error('Stored coverage plan needs an ID');
  const cells=ids(cellIds,'plan cell ID',100);return {...plan,id:id(plan.id,'plan ID'),runId:id(runId,'run ID'),revision:revision(rev,'plan revision'),recordId:id(recordId,'record ID'),targetRevision:text(targetRevision,'target revision',160),cellIds:cells};
}
export function validateCoverageCellDraft(value:unknown):CoverageCellDraft{
  const row=plain(value,'coverage cell');exact(row,['id','assetRef','questionKey','policyKey','actorContext','tenantContext','methodFamily','execution','assessment','taskRefs','claimRefs','caseRefs','evidenceRefs','negativeControlRefs','gapRefs','reason','limitations'],'Coverage cell');
  const asset=plain(row.assetRef,'coverage asset');exact(asset,['id','revision','variant'],'Coverage asset');const assetId=text(asset.id,'asset ID',80);if(!/^asset-[a-f0-9]{24}$/.test(assetId))throw Error('Invalid coverage asset ID');const assetRef:CoverageCellDraft['assetRef']={id:assetId};if(asset.revision!==undefined)assetRef.revision=revision(asset.revision,'asset revision');if(asset.variant!==undefined)assetRef.variant=key(asset.variant,'asset variant',120);
  if(typeof row.execution!=='string'||!(COVERAGE_EXECUTION as readonly string[]).includes(row.execution)||typeof row.assessment!=='string'||!(COVERAGE_ASSESSMENT as readonly string[]).includes(row.assessment))throw Error('Invalid coverage axes');
  if(!Array.isArray(row.taskRefs)||row.taskRefs.length>10)throw Error('Invalid coverage task references');const taskRefs=row.taskRefs.map((value,index)=>{const item=plain(value,`coverage task ${index}`);exact(item,['taskId','revision'],`Coverage task ${index}`);const result:CoverageTaskRef={taskId:id(item.taskId,'task ID')};if(item.revision!==undefined)result.revision=revision(item.revision,'task revision');return result;});if(new Set(taskRefs.map(item=>item.taskId)).size!==taskRefs.length)throw Error('Duplicate coverage task reference');
  if(!Array.isArray(row.caseRefs)||row.caseRefs.length>10)throw Error('Invalid coverage case references');const caseRefs=row.caseRefs.map((value,index)=>{const item=plain(value,`coverage case ${index}`);exact(item,['caseId','revision'],`Coverage case ${index}`);return {caseId:id(item.caseId,'case ID'),revision:revision(item.revision,'case revision')};});if(new Set(caseRefs.map(item=>item.caseId)).size!==caseRefs.length)throw Error('Duplicate coverage case reference');
  const result:CoverageCellDraft={assetRef,questionKey:key(row.questionKey,'question key'),actorContext:key(row.actorContext,'actor context'),tenantContext:key(row.tenantContext,'tenant context'),methodFamily:key(row.methodFamily,'method family',80),execution:row.execution as CoverageExecution,assessment:row.assessment as CoverageAssessment,taskRefs,caseRefs,
    claimRefs:ids(row.claimRefs,'claim reference'),evidenceRefs:ids(row.evidenceRefs,'evidence reference'),negativeControlRefs:ids(row.negativeControlRefs,'negative-control reference'),gapRefs:ids(row.gapRefs,'gap reference'),reason:text(row.reason,'cell reason',1500,10),limitations:text(row.limitations,'cell limitations',2000,10)};
  if(row.id!==undefined)result.id=id(row.id,'cell ID');if(row.policyKey!==undefined)result.policyKey=key(row.policyKey,'policy key');return result;
}
export function validateStoredCoverageCell(value:unknown,recordId:string):CoverageCellEntry{
  const row=plain(value,'stored coverage cell'),{runId,revision:rev,planId,planRevision,targetRevision,fingerprint,retired,...input}=row,cell=validateCoverageCellDraft(input);if(!cell.id)throw Error('Stored coverage cell needs an ID');
  if(typeof retired!=='boolean'||typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint))throw Error('Invalid host coverage identity');return {...cell,id:id(cell.id,'cell ID'),runId:id(runId,'run ID'),revision:revision(rev,'cell revision'),recordId:id(recordId,'record ID'),planId:id(planId,'plan ID'),planRevision:revision(planRevision,'cell plan revision'),targetRevision:text(targetRevision,'target revision',160),fingerprint,retired};
}
