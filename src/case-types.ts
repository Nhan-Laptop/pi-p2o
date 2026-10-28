import { capabilityList, type Capability } from './capabilities.js';
import { CASE_EFFECTS, chainImpact, parseChainReach, type CaseEffect, type ChainImpact, type ChainReach } from './cvss.js';
import { CVSS_VECTOR } from './cvss.js';
import { exact, fieldValidators, plain } from './validate.js';
export const CASE_VERDICTS=['open','confirmed','ruled_out','inconclusive'] as const;
export const CASE_REVIEW_STATUSES=['pending','accepted','disputed','withdrawn'] as const;
export const REMEDIATION_STATUSES=['unplanned','planned','implemented','retest-pending','retested','accepted','failed'] as const;
export const FINDING_SEVERITIES=['critical','high','medium','low','informational'] as const;
export type CaseVerdict=typeof CASE_VERDICTS[number];
export type CaseReviewStatus=typeof CASE_REVIEW_STATUSES[number];
export interface CaseAssetRef {id:string;revision?:number;variant?:string}
export interface CaseTaskRef {taskId:string;revision?:number}
export interface CaseHypothesisRef {id:string;revision:number}
export interface CaseContradiction {evidenceRef:string;status:'open'|'resolved';reason:string}
export interface CaseRemediation {status:typeof REMEDIATION_STATUSES[number];reason:string;evidenceRefs:string[];retestTask?:CaseTaskRef}
/**
 * Owner-attributed rating of one case, stored as its own owner note (`data.caseRating`) and NOT as a case revision: rating a case neither changes its
 * verdict or review status nor stales the coverage cells that pin its revision. The score is computed by the host from `cvssVector` (src/cvss.ts);
 * CWE IDs and references are what the owner recorded, not looked up. An `inferred` policy basis is provenance, not a ceiling: it refuses a high/critical rating only while an inferred-basis claim is not a tested observation, and the accepted rating then carries the host-set `INFERRED_POLICY` flag and a required `limitations`.
 */
export interface CaseFinding {
  severity:typeof FINDING_SEVERITIES[number];basis:string;likelihood?:string;impact?:string;cvssVector?:string;cwe:string[];remediationSteps?:string;references:string[];reproductionEvidenceRefs:string[];reproductionSteps?:ReproductionStep[];independenceWaiver?:string;chain?:CaseChain;
  /** Required when a high/critical rating rests on observed inferred-policy provenance: what the inference still leaves unproven. */
  limitations?:string;
}
/**
 * One ordered link of a composed chain: what the step does, the claim that shows it ran, and the typed capability edge that joins it to the previous step
 * (`gained` of the earlier step satisfies the `needs` of this one). `effect` is what this step's own evidence showed, in impact terms; `reach` is how the
 * step was reached, and is what the impact of the whole chain is scored with. `order` is contiguous from 1; the list order is the execution order.
 * Pre-P14 chain records carried free text in `provides`/`requires`; that text is read into `gained`/`needs` as `legacy` entries, displayed as legacy and
 * never joined, matched or scored.
 */
export interface CaseChainStep {order:number;step:string;claimRef?:string;gained:Capability[];needs:Capability[];effect?:CaseEffect;reach?:ChainReach}
/**
 * A chain the owner actually assembled: ordered steps from the initial primitive to the furthest demonstrated effect. `demonstratedThrough` is the last
 * step whose cited claim was executed; steps beyond it are reasoned and stay unproven, so severity is bounded by the demonstrated depth, not by the plan.
 * `impact` is computed by the host from the demonstrated depth (src/cvss.ts) and is never taken from the caller: severity follows the demonstration.
 */
export interface CaseChain {objective:string;steps:CaseChainStep[];demonstratedThrough?:number;impact?:ChainImpact}
/** Reader-facing label and order for a reproduction receipt. A role is a label, never a proof level; list order is the order to follow. */
export const REPRODUCTION_ROLES=['baseline','proof','verification','supporting'] as const;
export interface ReproductionStep {ref:string;role:typeof REPRODUCTION_ROLES[number];note?:string}
export interface CaseDraft {
  id?:string;title:string;policyKey:string;rootCauseKey?:string;hypothesis?:CaseHypothesisRef;
  /** P10/TR-L01: omitted/empty is allowed at the model boundary when `taskRefs` is present; the host derives both lists and a stored case always carries them. */
  assetRefs?:CaseAssetRef[];claimRefs?:string[];independentEvidenceRefs:string[];taskRefs:CaseTaskRef[];reportRefs:string[];
  contradictions:CaseContradiction[];affectedVariants:string[];relatedCaseIds:string[];duplicateOf?:string;
  verdict:CaseVerdict;reviewStatus:CaseReviewStatus;reviewReason:string;limitations:string;remediation:CaseRemediation;
}
export interface CaseEntry extends CaseDraft {id:string;runId:string;revision:number;recordId:string;assetRefs:CaseAssetRef[];claimRefs:string[]}
/** P10/TR-L06: a case that names no remediation says so honestly; the host records the default instead of inventing work. */
export const DEFAULT_CASE_REMEDIATION:CaseRemediation={status:'unplanned',reason:'No remediation was planned or reviewed for this case yet',evidenceRefs:[]};

const {text,key,id,revision,ids}=fieldValidators('case');
function taskRef(value:unknown,label:string,revisionRequired=false):CaseTaskRef{const row=plain(value,label);exact(row,['taskId','revision'],label);const result:CaseTaskRef={taskId:id(row.taskId,`${label} task ID`)};if(row.revision!==undefined)result.revision=revision(row.revision,`${label} revision`);if(revisionRequired&&result.revision===undefined)throw Error(`${label} revision must be pinned`);return result}
/** WSTG test keys (lower case, e.g. wstg-athn-02) or https URLs without credentials or fragments; recorded as text, never rendered as a link. */
const REFERENCE=/^(?:wstg-[a-z]{4}-\d{2}|https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'*+,;=:@%\/-]*)?(?:\?[A-Za-z0-9._~!$&'*+,;=:@%\/?-]*)?)$/;
export function validateFinding(value:unknown):CaseFinding{
  const row=plain(value,'case finding');exact(row,['severity','basis','likelihood','impact','cvssVector','cwe','remediationSteps','references','reproductionEvidenceRefs','reproductionSteps','independenceWaiver','chain','limitations'],'Case finding');
  if(typeof row.severity!=='string'||!(FINDING_SEVERITIES as readonly string[]).includes(row.severity))throw Error('Invalid case finding severity');
  const cwe=row.cwe===undefined?[]:row.cwe;if(!Array.isArray(cwe)||cwe.length>5||cwe.some(item=>typeof item!=='string'||!/^CWE-[1-9][0-9]{0,4}$/.test(item))||new Set(cwe).size!==cwe.length)throw Error('Invalid case finding CWE list');
  const references=row.references===undefined?[]:row.references;if(!Array.isArray(references)||references.length>5||references.some(item=>typeof item!=='string'||item.length>300||!REFERENCE.test(item))||new Set(references).size!==references.length)throw Error('Invalid case finding references');
  const result:CaseFinding={severity:row.severity as CaseFinding['severity'],basis:text(row.basis,'finding basis',1000,10),cwe:cwe as string[],references:references as string[],reproductionEvidenceRefs:row.reproductionEvidenceRefs===undefined?[]:ids(row.reproductionEvidenceRefs,'finding reproduction evidence',5)};
  if(row.reproductionSteps!==undefined){
    const steps=row.reproductionSteps;if(!Array.isArray(steps)||steps.length<1||steps.length>5)throw Error('Invalid case finding reproduction steps');
    const parsed=steps.map((item):ReproductionStep=>{const step=plain(item,'finding reproduction step');exact(step,['ref','role','note'],'Finding reproduction step');
      if(typeof step.role!=='string'||!(REPRODUCTION_ROLES as readonly string[]).includes(step.role))throw Error('Invalid case finding reproduction step role');
      return {ref:id(step.ref,'finding reproduction step ref'),role:step.role as ReproductionStep['role'],...(step.note===undefined?{}:{note:text(step.note,'finding reproduction step note',200,3)})};});
    if(new Set(parsed.map(step=>step.ref)).size!==parsed.length)throw Error('Duplicate case finding reproduction step ref');
    if(row.reproductionEvidenceRefs!==undefined&&result.reproductionEvidenceRefs.join('\n')!==parsed.map(step=>step.ref).join('\n'))throw Error('Case finding reproductionEvidenceRefs must match reproductionSteps refs in order, or be omitted');
    result.reproductionEvidenceRefs=parsed.map(step=>step.ref);result.reproductionSteps=parsed;
  }
  if(row.likelihood!==undefined)result.likelihood=text(row.likelihood,'finding likelihood',800,5);if(row.impact!==undefined)result.impact=text(row.impact,'finding impact',800,5);
  if(row.cvssVector!==undefined){if(typeof row.cvssVector!=='string'||!CVSS_VECTOR.test(row.cvssVector))throw Error('Invalid case finding CVSS:3.1 vector');result.cvssVector=row.cvssVector;}
  if(row.remediationSteps!==undefined)result.remediationSteps=text(row.remediationSteps,'finding remediation steps',2000,10);
  if(row.independenceWaiver!==undefined)result.independenceWaiver=text(row.independenceWaiver,'finding independence waiver',300,10);
  // Empty is accepted here so `rate()` can name `INFERRED_POLICY` when the provenance rule requires a limitation.
  if(row.limitations!==undefined)result.limitations=text(row.limitations,'finding limitations',2000,0);
  if(row.chain!==undefined){
    // `impact` is accepted on a stored row and then recomputed from the depth, so a replay round-trips while no caller can choose a score.
    const chain=plain(row.chain,'finding chain');exact(chain,['objective','steps','demonstratedThrough','impact'],'Finding chain');
    if(!Array.isArray(chain.steps)||chain.steps.length<1||chain.steps.length>8)throw Error('Finding chain needs 1..8 ordered steps');
    const steps=chain.steps.map((item,index):CaseChainStep=>{const step=plain(item,`finding chain step ${index+1}`);exact(step,['order','step','claimRef','provides','requires','gained','needs','effect','reach'],`Finding chain step ${index+1}`);
      if(step.order!==index+1)throw Error('Finding chain steps must be numbered 1..n in execution order');
      const legacy=(key:'provides'|'requires',target:'gained'|'needs'):Capability[]=>{
        if(step[key]===undefined)return [];
        if(step[target]!==undefined)throw Error(`Finding chain step ${index+1} sends both ${key} text and typed ${target}; send only the typed list`);
        return [{legacy:text(step[key],`finding chain step ${index+1} ${key}`,300,5)}];};
      // A step declares no edge by sending nothing: an empty list is the stored form of that, so it must re-read as itself.
      const edges=(key:'gained'|'needs',list:unknown,label:string):Capability[]=>list===undefined?[]:Array.isArray(list)&&list.length===0?[]:capabilityList(list,label);
      const gained=step.gained===undefined?legacy('provides','gained'):edges('gained',step.gained,`finding chain step ${index+1} gained`);
      const needs=step.needs===undefined?legacy('requires','needs'):edges('needs',step.needs,`finding chain step ${index+1} needs`);
      const parsed:CaseChainStep={order:index+1,step:text(step.step,'finding chain step',400,5),gained,needs};
      if(step.claimRef!==undefined)parsed.claimRef=id(step.claimRef,'finding chain claim');
      if(step.effect!==undefined){if(typeof step.effect!=='string'||!(CASE_EFFECTS as readonly string[]).includes(step.effect))throw Error(`Finding chain step ${index+1} effect must be one of ${CASE_EFFECTS.join(', ')}`);parsed.effect=step.effect as CaseEffect;}
      if(step.reach!==undefined)parsed.reach=parseChainReach(step.reach,`Finding chain step ${index+1} reach`);
      return parsed;});
    result.chain={objective:text(chain.objective,'finding chain objective',600,10),steps};
    if(chain.demonstratedThrough!==undefined){
      const depth=chain.demonstratedThrough;
      if(typeof depth!=='number'||!Number.isInteger(depth)||depth<1||depth>steps.length)throw Error('Finding chain demonstratedThrough must name one of its steps');
      if(steps.slice(0,depth).some(step=>!step.claimRef))throw Error('Every chain step up to demonstratedThrough needs the claim that ran it');
      result.chain.demonstratedThrough=depth;
    }
    // Computed, never accepted: a caller that repeats the stored impact gets the same answer from the demonstrated depth.
    const impact=chainImpact(steps,result.chain.demonstratedThrough);
    if(impact)result.chain.impact=impact;
  }
  return result;
}
function unique<T>(items:T[],identity:(item:T)=>string,label:string):T[]{if(new Set(items.map(identity)).size!==items.length)throw Error(`Duplicate case ${label}`);return items}

/** Untrusted model/operator draft only. Host run/revision/record fields are never accepted here. */
export function validateCaseDraft(value:unknown):CaseDraft{
  const row=plain(value,'case');exact(row,['id','title','policyKey','rootCauseKey','hypothesis','assetRefs','claimRefs','independentEvidenceRefs','taskRefs','reportRefs','contradictions','affectedVariants','relatedCaseIds','duplicateOf','verdict','reviewStatus','reviewReason','limitations','remediation'],'Case');
  // P10/TR-L01: refs may be omitted when taskRefs is present; the board derives them before the reference checks run.
  const assetRows=row.assetRefs===undefined?[]:row.assetRefs;
  if(!Array.isArray(assetRows)||assetRows.length>10)throw Error('Case needs at most 10 asset references');
  const assetRefs=unique(assetRows.map((value,index)=>{const item=plain(value,`case asset ${index}`);exact(item,['id','revision','variant'],`Case asset ${index}`);const result:CaseAssetRef={id:text(item.id,'asset ID',80)};
    if(!/^asset-[a-f0-9]{24}$/.test(result.id))throw Error('Invalid case asset ID');if(item.revision!==undefined)result.revision=revision(item.revision,'asset revision');if(item.variant!==undefined)result.variant=key(item.variant,'asset variant',120);return result;}),item=>`${item.id}\u0000${item.variant??''}`,'asset reference');
  let hypothesis:CaseHypothesisRef|undefined;if(row.hypothesis!==undefined){const item=plain(row.hypothesis,'case hypothesis');exact(item,['id','revision'],'Case hypothesis');const hypothesisId=text(item.id,'hypothesis ID',80);if(!/^assertion-[a-f0-9]{24}$/.test(hypothesisId))throw Error('Invalid case hypothesis ID');hypothesis={id:hypothesisId,revision:revision(item.revision,'hypothesis revision')};}
  if(typeof row.verdict!=='string'||!(CASE_VERDICTS as readonly string[]).includes(row.verdict))throw Error('Invalid case verdict');
  // P10/TR-L05: a case that omits its review status is a pending submission; only an explicit revision may accept or dispute it.
  const reviewStatus=row.reviewStatus===undefined?'pending':row.reviewStatus;
  if(typeof reviewStatus!=='string'||!(CASE_REVIEW_STATUSES as readonly string[]).includes(reviewStatus))throw Error('Invalid case review status');
  if(!Array.isArray(row.taskRefs)||row.taskRefs.length>10)throw Error('Invalid case task references');const taskRefs=unique(row.taskRefs.map((item,index)=>taskRef(item,`task reference ${index}`)),item=>item.taskId,'task reference');
  if(!Array.isArray(row.contradictions)||row.contradictions.length>10)throw Error('Invalid case contradictions');const contradictions=unique(row.contradictions.map((value,index)=>{const item=plain(value,`contradiction ${index}`);exact(item,['evidenceRef','status','reason'],`Case contradiction ${index}`);if(item.status!=='open'&&item.status!=='resolved')throw Error('Invalid contradiction status');return {evidenceRef:id(item.evidenceRef,'contradiction evidence'),status:item.status as CaseContradiction['status'],reason:text(item.reason,'contradiction reason',1000,10)};}),item=>item.evidenceRef,'contradiction evidence');
  const variants=Array.isArray(row.affectedVariants)?row.affectedVariants.map(item=>key(item,'affected variant',120)):[];if(variants.length>20||new Set(variants).size!==variants.length)throw Error('Invalid or duplicate affected variants');
  // P10/TR-L06: remediation is authoritative only when recorded; an omitted one says "unplanned" with an honest reason.
  let remediation:CaseRemediation={...DEFAULT_CASE_REMEDIATION,evidenceRefs:[]};
  if(row.remediation!==undefined){
    const remediationRow=plain(row.remediation,'case remediation');exact(remediationRow,['status','reason','evidenceRefs','retestTask'],'Case remediation');if(typeof remediationRow.status!=='string'||!(REMEDIATION_STATUSES as readonly string[]).includes(remediationRow.status))throw Error('Invalid remediation status');
    remediation={status:remediationRow.status as CaseRemediation['status'],reason:text(remediationRow.reason,'remediation reason',1000,10),evidenceRefs:ids(remediationRow.evidenceRefs,'remediation evidence')};if(remediationRow.retestTask!==undefined)remediation.retestTask=taskRef(remediationRow.retestTask,'retest task');
  }
  const result:CaseDraft={title:text(row.title,'title',500,5),policyKey:key(row.policyKey,'policy key'),assetRefs,claimRefs:row.claimRefs===undefined?[]:ids(row.claimRefs,'claim reference',10),independentEvidenceRefs:ids(row.independentEvidenceRefs,'independent evidence'),taskRefs,reportRefs:ids(row.reportRefs,'report reference'),contradictions,affectedVariants:variants,
    relatedCaseIds:ids(row.relatedCaseIds,'related case ID'),verdict:row.verdict as CaseVerdict,reviewStatus:reviewStatus as CaseReviewStatus,reviewReason:text(row.reviewReason,'review reason',1500,10),limitations:text(row.limitations,'limitations',2000,10),remediation};
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
  // P10/TR-L01: derivation happens once, on the write path; a stored case is refused if it still has no exact asset/claim references.
  if(!validated.assetRefs?.length)throw Error('Stored case needs exact asset references');
  if(!validated.claimRefs?.length)throw Error('Stored case needs exact claim references');
  return {...validated,id:id(validated.id,'ID'),runId:id(runId,'run ID'),revision:revision(rev,'revision'),recordId:id(recordId,'record ID'),assetRefs:validated.assetRefs,claimRefs:validated.claimRefs};
}
