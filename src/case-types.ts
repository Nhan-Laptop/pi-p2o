import { exact, fieldValidators, plain } from './validate.js';
export const CASE_VERDICTS=['open','confirmed','ruled_out','inconclusive'] as const;
export const CASE_REVIEW_STATUSES=['pending','accepted','disputed','withdrawn'] as const;
export const REMEDIATION_STATUSES=['unplanned','planned','implemented','retest-pending','retested','accepted','failed'] as const;
export type CaseVerdict=typeof CASE_VERDICTS[number];
export type CaseReviewStatus=typeof CASE_REVIEW_STATUSES[number];
export interface CaseAssetRef {id:string;revision?:number;variant?:string}
export interface CaseTaskRef {taskId:string;revision?:number}
export interface CaseHypothesisRef {id:string;revision:number}
export interface CaseContradiction {evidenceRef:string;status:'open'|'resolved';reason:string}
export interface CaseRemediation {status:typeof REMEDIATION_STATUSES[number];reason:string;evidenceRefs:string[];retestTask?:CaseTaskRef}
export interface CaseDraft {
  id?:string;title:string;policyKey:string;rootCauseKey?:string;hypothesis?:CaseHypothesisRef;
  assetRefs:CaseAssetRef[];claimRefs:string[];independentEvidenceRefs:string[];taskRefs:CaseTaskRef[];reportRefs:string[];
  contradictions:CaseContradiction[];affectedVariants:string[];relatedCaseIds:string[];duplicateOf?:string;
  verdict:CaseVerdict;reviewStatus:CaseReviewStatus;reviewReason:string;limitations:string;remediation:CaseRemediation;
}
export interface CaseEntry extends CaseDraft {id:string;runId:string;revision:number;recordId:string}

const {text,key,id,revision,ids}=fieldValidators('case');
function taskRef(value:unknown,label:string,revisionRequired=false):CaseTaskRef{const row=plain(value,label);exact(row,['taskId','revision'],label);const result:CaseTaskRef={taskId:id(row.taskId,`${label} task ID`)};if(row.revision!==undefined)result.revision=revision(row.revision,`${label} revision`);if(revisionRequired&&result.revision===undefined)throw Error(`${label} revision must be pinned`);return result}
function unique<T>(items:T[],identity:(item:T)=>string,label:string):T[]{if(new Set(items.map(identity)).size!==items.length)throw Error(`Duplicate case ${label}`);return items}

/** Untrusted model/operator draft only. Host run/revision/record fields are never accepted here. */
export function validateCaseDraft(value:unknown):CaseDraft{
  const row=plain(value,'case');exact(row,['id','title','policyKey','rootCauseKey','hypothesis','assetRefs','claimRefs','independentEvidenceRefs','taskRefs','reportRefs','contradictions','affectedVariants','relatedCaseIds','duplicateOf','verdict','reviewStatus','reviewReason','limitations','remediation'],'Case');
  if(!Array.isArray(row.assetRefs)||row.assetRefs.length<1||row.assetRefs.length>10)throw Error('Case needs 1..10 asset references');
  const assetRefs=unique(row.assetRefs.map((value,index)=>{const item=plain(value,`case asset ${index}`);exact(item,['id','revision','variant'],`Case asset ${index}`);const result:CaseAssetRef={id:text(item.id,'asset ID',80)};
    if(!/^asset-[a-f0-9]{24}$/.test(result.id))throw Error('Invalid case asset ID');if(item.revision!==undefined)result.revision=revision(item.revision,'asset revision');if(item.variant!==undefined)result.variant=key(item.variant,'asset variant',120);return result;}),item=>`${item.id}\u0000${item.variant??''}`,'asset reference');
  let hypothesis:CaseHypothesisRef|undefined;if(row.hypothesis!==undefined){const item=plain(row.hypothesis,'case hypothesis');exact(item,['id','revision'],'Case hypothesis');const hypothesisId=text(item.id,'hypothesis ID',80);if(!/^assertion-[a-f0-9]{24}$/.test(hypothesisId))throw Error('Invalid case hypothesis ID');hypothesis={id:hypothesisId,revision:revision(item.revision,'hypothesis revision')};}
  if(typeof row.verdict!=='string'||!(CASE_VERDICTS as readonly string[]).includes(row.verdict))throw Error('Invalid case verdict');
  if(typeof row.reviewStatus!=='string'||!(CASE_REVIEW_STATUSES as readonly string[]).includes(row.reviewStatus))throw Error('Invalid case review status');
  if(!Array.isArray(row.taskRefs)||row.taskRefs.length>10)throw Error('Invalid case task references');const taskRefs=unique(row.taskRefs.map((item,index)=>taskRef(item,`task reference ${index}`)),item=>item.taskId,'task reference');
  if(!Array.isArray(row.contradictions)||row.contradictions.length>10)throw Error('Invalid case contradictions');const contradictions=unique(row.contradictions.map((value,index)=>{const item=plain(value,`contradiction ${index}`);exact(item,['evidenceRef','status','reason'],`Case contradiction ${index}`);if(item.status!=='open'&&item.status!=='resolved')throw Error('Invalid contradiction status');return {evidenceRef:id(item.evidenceRef,'contradiction evidence'),status:item.status as CaseContradiction['status'],reason:text(item.reason,'contradiction reason',1000,10)};}),item=>item.evidenceRef,'contradiction evidence');
  const variants=Array.isArray(row.affectedVariants)?row.affectedVariants.map(item=>key(item,'affected variant',120)):[];if(variants.length>20||new Set(variants).size!==variants.length)throw Error('Invalid or duplicate affected variants');
  const remediationRow=plain(row.remediation,'case remediation');exact(remediationRow,['status','reason','evidenceRefs','retestTask'],'Case remediation');if(typeof remediationRow.status!=='string'||!(REMEDIATION_STATUSES as readonly string[]).includes(remediationRow.status))throw Error('Invalid remediation status');
  const remediation:CaseRemediation={status:remediationRow.status as CaseRemediation['status'],reason:text(remediationRow.reason,'remediation reason',1000,10),evidenceRefs:ids(remediationRow.evidenceRefs,'remediation evidence')};if(remediationRow.retestTask!==undefined)remediation.retestTask=taskRef(remediationRow.retestTask,'retest task');
  const result:CaseDraft={title:text(row.title,'title',500,5),policyKey:key(row.policyKey,'policy key'),assetRefs,claimRefs:ids(row.claimRefs,'claim reference',10,1),independentEvidenceRefs:ids(row.independentEvidenceRefs,'independent evidence'),taskRefs,reportRefs:ids(row.reportRefs,'report reference'),contradictions,affectedVariants:variants,
    relatedCaseIds:ids(row.relatedCaseIds,'related case ID'),verdict:row.verdict as CaseVerdict,reviewStatus:row.reviewStatus as CaseReviewStatus,reviewReason:text(row.reviewReason,'review reason',1500,10),limitations:text(row.limitations,'limitations',2000,10),remediation};
  if(row.id!==undefined)result.id=id(row.id,'ID');if(row.rootCauseKey!==undefined)result.rootCauseKey=key(row.rootCauseKey,'root-cause key');if(hypothesis)result.hypothesis=hypothesis;if(row.duplicateOf!==undefined)result.duplicateOf=id(row.duplicateOf,'duplicate target');
  if(result.duplicateOf&&result.relatedCaseIds.includes(result.duplicateOf))throw Error('Duplicate target is not a related-case hint');
  if(result.reviewStatus==='accepted'&&result.contradictions.some(item=>item.status==='open'))throw Error('Accepted case cannot retain an unresolved contradiction');
  if(result.reviewStatus==='withdrawn'&&result.remediation.status==='accepted')throw Error('Withdrawn case cannot retain accepted remediation');
  if(result.remediation.status==='accepted'&&(!result.remediation.retestTask||!result.remediation.evidenceRefs.length))throw Error('Accepted remediation needs a pinned retest task and evidence');
  return result;
}

/** Store boundary: validate model fields and exact host-owned fields separately. */
export function validateStoredCase(value:unknown,recordId:string):CaseEntry{
  const row=plain(value,'case entry'),{runId,revision:rev,...draft}=row;const validated=validateCaseDraft(draft);
  if(!validated.id)throw Error('Stored case needs an ID');
  return {...validated,id:id(validated.id,'ID'),runId:id(runId,'run ID'),revision:revision(rev,'revision'),recordId:id(recordId,'record ID')};
}
