import { randomUUID } from 'node:crypto';
import { appendGeneratedRecords, appendRecords, ownerNoteFrontier, readGeneratedRecords, readLedger, type AssessmentRecord, type LedgerIndex } from './records.js';
import { taskFrontier, taskHead, taskRevisionAt, taskReferenceSuperseded, type AssessmentTask } from './tasks.js';
import type { MutationRequest } from './state/store.js';
import { LedgerBoard } from './board.js';
import { validateCaseDraft, validateFinding, validateStoredCase, type CaseDraft, type CaseEntry, type CaseFinding, type CaseTaskRef } from './case-types.js';
import { isDemonstrated } from './claims.js';
import { chainImpact, severityRank } from './cvss.js';
import { isSatisfiedTask } from './tasks.js';
import { caseValidation } from './validation.js';
import { boundRetestRequest, caseRetests, retestCurrent, validateRetest, type CaseRetest } from './retest.js';

export type CaseCurrentness='current'|'stale'|'withdrawn'|'unknown';
/** Host-set provenance of an accepted high/critical rating: the effect was tested and observed, while the policy basis stays inferred. */
export type RatingProvenance='INFERRED_POLICY';
export interface CaseView extends CaseEntry {
  currentness:CaseCurrentness;staleReasons:string[];independentCurrent:boolean;independenceReason?:string;acceptedFinding:boolean;readyToRate:boolean;canonicalCaseId:string;
  /** Latest owner rating of this case id and the case revision it was recorded against; a rating of an older revision is kept but flagged. */
  finding?:CaseFinding;ratedRevision?:number;ratingCurrent?:boolean;ratingProvenance?:RatingProvenance;
  /** Latest owner retest of this case id; a retest is recorded once per case revision and an older one stays read-only history. */
  retest?:CaseRetest;retestCurrent?:boolean;
}
export interface CaseContext {assetRevision?:(id:string)=>number|undefined;assertionRevision?:(id:string)=>number|undefined}
const terminalReview=new Set(['withdrawn']);
/** A case whose review is still open: pending, or disputed after a review. */
export const needsCaseReview=(view:{reviewStatus?:unknown}):boolean=>view.reviewStatus==='pending'||view.reviewStatus==='disputed';

const candidateKey=(record:AssessmentRecord)=>typeof record.data?.candidate==='string'?record.data.candidate:undefined;
const candidateRecords=(index:LedgerIndex)=>index.records.filter(row=>row.kind==='candidate'&&row.id&&candidateKey(row));
function candidateHeads(index:LedgerIndex):Map<string,AssessmentRecord>{const heads=new Map<string,AssessmentRecord>();for(const row of candidateRecords(index))heads.set(candidateKey(row)!,row);return heads;}
/** The join the chain board and case ratings speak: a candidate record id, or the latest same-run claim with that slug (P13a). */
function candidateByReference(index:LedgerIndex,runId:string,ref:string):AssessmentRecord|undefined{
  const direct=index.byId.get(ref);
  if(direct?.kind==='candidate'&&direct.runId===runId)return direct;
  return index.records.filter(row=>row.kind==='candidate'&&row.runId===runId&&row.data?.candidate===ref).at(-1);
}
/** P10/TR-L01: the claims one task's review accepted — latest record per candidate slug before the reviewed head (mirrors src/coverage.ts). */
function reviewedClaimRecords(index:LedgerIndex,runId:string,taskId:string):AssessmentRecord[]{
  let reviewedAt:number|undefined;
  for(let position=0;position<index.records.length;position++){const row=index.records[position],task=row.kind==='task'?row.data?.task as AssessmentTask|undefined:undefined;
    if(task?.id===taskId&&task.runId===runId&&isSatisfiedTask(task.status))reviewedAt=position;}
  const latest=new Map<string,AssessmentRecord>();
  for(let position=0;position<index.records.length;position++){const row=index.records[position];
    if(row.kind!=='candidate'||!row.id||row.runId!==runId||typeof row.data?.candidate!=='string'||row.data?.taskRef!==taskId)continue;
    if(reviewedAt!==undefined&&position>=reviewedAt)continue;
    latest.set(row.data.candidate as string,row);}
  return [...latest.values()];
}
function taskRevision(index:LedgerIndex,ref:CaseTaskRef):AssessmentTask|undefined{return taskRevisionAt(index,ref.taskId,ref.revision);}

export const caseFrontier=(index:LedgerIndex):CaseEntry[]=>ownerNoteFrontier(index,'case',validateStoredCase);

/**
 * P14.12: independence is a reproduction, not a second opinion. The old rule asked for another actor's candidate with the *same slug*, which a
 * peer can only produce by superseding this claim — so it was either self-validation or nothing. The rule now asks for the peer's own
 * demonstrated claim against the receipt it cites, running the same payload bytes (sha256 stamped at write time) in an environment with the
 * same recipe fingerprint. A mismatch is named, because "not independent" without a reason is the annotation this phase removes.
 */
export function independentReceiptCurrent(index:LedgerIndex,claim:AssessmentRecord,evidenceId:string):{ok:boolean;reason?:string}{
  const evidence=index.byId.get(evidenceId);
  if(evidence?.kind!=='evidence'||!evidence.workerId)return {ok:false,reason:`independent-receipt-missing:${evidenceId}`};
  if(evidence.by===claim.by)return {ok:false,reason:`independent-receipt-not-independent:${evidenceId}`};
  // The peer's *latest* claim against that receipt decides: a later non-demonstrated claim is a withdrawal of support, not a stale note.
  const validator=index.records.filter(row=>row.kind==='candidate'&&row.by===evidence.by&&row.workerId&&row.refs?.includes(evidenceId)).at(-1);
  if(!validator)return {ok:false,reason:`independent-receipt-uncited:${evidenceId}`};
  if(!isDemonstrated(validator.data??{})||validator.data?.proof==='static_trace')return {ok:false,reason:`independent-receipt-withdrawn:${evidenceId}`};
  if(validator.surface!==claim.surface||validator.risk!==claim.risk)return {ok:false,reason:`independent-receipt-different-surface:${evidenceId}`};
  const ran=claim.data??{},replayed=validator.data??{},hash=(value:unknown)=>typeof value==='string'&&value.length>=12?value:'';
  // P21/A2: a reproduction claim names the claim it replayed, so the byte comparison is against *that* claim's recorded replay
  // hash instead of guessing from whichever claim the author recorded last against the receipt. A legacy target with no host
  // hash keeps the old rule: the peer's own demonstrated claim is the independence.
  if(claim.data?.reproducedClaimRef!==undefined){
    const target=typeof claim.data.reproducedClaimRef==='string'?index.byId.get(claim.data.reproducedClaimRef):undefined;
    if(!target||target.kind!=='candidate')return {ok:false,reason:`independent-target-missing:${String(claim.data.reproducedClaimRef).slice(0,80)}`};
    if(!isDemonstrated(target.data??{})||target.data?.proof==='static_trace')return {ok:false,reason:`independent-target-withdrawn:${target.id}`};
    if(target.surface!==claim.surface||target.risk!==claim.risk)return {ok:false,reason:`independent-target-different-surface:${target.id}`};
    const targetSha=hash(target.data?.payloadSha256),claimSha=hash(claim.data?.payloadSha256),targetEnv=hash(target.data?.environmentFingerprint),claimEnv=hash(claim.data?.environmentFingerprint);
    if(targetSha&&targetSha!==claimSha)return {ok:false,reason:`independent-payload-mismatch:${targetSha.slice(0,12)}!=${claimSha.slice(0,12)||'none'}`};
    if(targetEnv&&targetEnv!==claimEnv)return {ok:false,reason:`independent-environment-mismatch:${targetEnv.slice(0,12)}!=${claimEnv.slice(0,12)||'none'}`};
    return {ok:true};
  }
  // An effect with no stored artifact has nothing to replay, and its independence stays what it always was: a peer's own demonstrated claim
  // against the receipt it cites. Once the author names a payload or an environment, the peer must match it exactly.
  if(!hash(ran.payloadSha256)&&!hash(ran.environmentFingerprint))return {ok:true};
  if(!hash(ran.payloadSha256))return {ok:false,reason:'independent-payload-missing'};
  if(hash(ran.payloadSha256)!==hash(replayed.payloadSha256))return {ok:false,reason:`independent-payload-mismatch:${hash(ran.payloadSha256).slice(0,12)}!=${hash(replayed.payloadSha256).slice(0,12)||'none'}`};
  if(!hash(ran.environmentFingerprint))return {ok:false,reason:'independent-environment-missing'};
  if(hash(ran.environmentFingerprint)!==hash(replayed.environmentFingerprint))return {ok:false,reason:`independent-environment-mismatch:${hash(ran.environmentFingerprint).slice(0,12)}!=${hash(replayed.environmentFingerprint).slice(0,12)||'none'}`};
  return {ok:true};
}

/** Latest owner rating per case id, in ledger order. Malformed or foreign-run notes are not promoted, as for cases. */
export function caseRatings(index:LedgerIndex):Map<string,{finding:CaseFinding;caseRevision:number;recordId:string;provenance?:RatingProvenance}>{
  const latest=new Map<string,{finding:CaseFinding;caseRevision:number;recordId:string;provenance?:RatingProvenance}>();
  for(const row of index.records){const value=row.kind==='note'&&row.by==='owner'&&!row.workerId?row.data?.caseRating as Record<string,unknown>|undefined:undefined;if(!row.id||!value||typeof value!=='object')continue;
    try{const caseId=value.caseId,revision=value.caseRevision;if(typeof caseId!=='string'||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(caseId)||!Number.isSafeInteger(revision)||Number(revision)<1)continue;const provenance=value.provenance==='INFERRED_POLICY'?'INFERRED_POLICY' as const:undefined;latest.set(caseId,{finding:validateFinding(value.finding),caseRevision:Number(revision),recordId:row.id,...(provenance?{provenance}:{})});}catch{/* Untrusted/legacy notes are not promoted. */}}
  return latest;
}

/** Derived, read-only currentness. It cannot upgrade a claim, goal or target authority. */
export function caseViews(index:LedgerIndex,context:CaseContext={}):CaseView[]{
  const entries=caseFrontier(index),ratings=caseRatings(index),retests=caseRetests(index),claims=candidateHeads(index),tasks=taskFrontier(index),entryMap=new Map(entries.map(entry=>[entry.id,entry])),views=new Map<string,CaseView>(),visiting=new Set<string>();
  const view=(entry:CaseEntry):CaseView=>{
    const cached=views.get(entry.id);if(cached)return cached;const reasons:string[]=[];let unknown=false;
    if(entry.reviewStatus==='withdrawn')reasons.push('case-review-withdrawn');
    for(const ref of entry.assetRefs){const current=context.assetRevision?.(ref.id);if(!context.assetRevision)unknown=true;else if(current===undefined)reasons.push(`missing-asset:${ref.id}`);else if(ref.revision===undefined)reasons.push(`unpinned-asset:${ref.id}`);else if(current!==ref.revision)reasons.push(`stale-asset:${ref.id}@r${ref.revision}->r${current}`);}
    if(entry.hypothesis){const current=context.assertionRevision?.(entry.hypothesis.id);if(!context.assertionRevision)unknown=true;else if(current===undefined)reasons.push(`missing-hypothesis:${entry.hypothesis.id}`);else if(current!==entry.hypothesis.revision)reasons.push(`stale-hypothesis:${entry.hypothesis.id}@r${entry.hypothesis.revision}->r${current}`);}
    const citedClaims:AssessmentRecord[]=[];for(const id of entry.claimRefs){const claim=index.byId.get(id),key=claim&&candidateKey(claim);if(!claim||claim.kind!=='candidate'||!key){reasons.push(`missing-claim:${id}`);continue;}citedClaims.push(claim);if(claims.get(key)?.id!==id)reasons.push(`superseded-claim:${id}`);}
    for(const ref of entry.taskRefs){const task=taskRevision(index,ref);if(!task)reasons.push(`missing-task-revision:${ref.taskId}@r${ref.revision??'?'}`);else{const head=taskHead(index,ref.taskId);if(head&&taskReferenceSuperseded(index,ref.taskId,ref.revision))reasons.push(`superseded-task:${ref.taskId}@r${ref.revision}`);}}
    for(const id of entry.reportRefs)if(index.byId.get(id)?.kind!=='report')reasons.push(`missing-report:${id}`);
    for(const item of entry.contradictions)if(index.byId.get(item.evidenceRef)?.kind!=='evidence')reasons.push(`missing-contradiction:${item.evidenceRef}`);else if(item.status==='open')reasons.push(`open-contradiction:${item.evidenceRef}`);
    let independentCurrent=entry.independentEvidenceRefs.length>0;
    const independenceFailures:string[]=[];
    for(const evidenceId of entry.independentEvidenceRefs){
      // Every listed receipt is checked; the first failing one names why, so the reason is actionable instead of "stale". With no peer
      // claim even naming the receipt the missing step is a citation, not a stale receipt, and the reason says which evidence is uncited.
      let failure:string|undefined;
      const supporting=citedClaims.some(claim=>{if(claim.data?.independentEvidenceRef!==evidenceId)return false;const check=independentReceiptCurrent(index,claim,evidenceId);failure??=check.reason;return check.ok;});
      if(!supporting){const reason=failure??`independent-support-uncited:${evidenceId}`;independentCurrent=false;independenceFailures.push(reason);reasons.push(reason);}
    }
    // W4: a reviewed validation task is the host-owned independence path. It can make the case independent even when the older
    // peer-receipt field is empty; when the older path already holds, its failures still stay visible as stale reasons.
    const validation=caseValidation(index,citedClaims,entry.taskRefs,tasks);
    let independenceReason:string|undefined=independenceFailures[0];
    if(validation.current){independentCurrent=true;independenceReason=undefined;}
    else if(!independentCurrent)independenceReason=independenceFailures[0]??validation.reason??'validation-missing';
    if(entry.verdict==='confirmed'&&!citedClaims.some(claim=>isDemonstrated(claim.data??{})&&claim.data?.policyBasis!=='inferred'))reasons.push('confirmed-verdict-lacks-current-tested-claim');
    if(entry.verdict==='ruled_out'&&!citedClaims.some(claim=>claim.data?.closure==='ruled_out'&&typeof claim.data?.control==='string'))reasons.push('ruled-out-verdict-lacks-bounded-control');
    for(const id of entry.remediation.evidenceRefs)if(index.byId.get(id)?.kind!=='evidence')reasons.push(`missing-remediation-evidence:${id}`);
    if(entry.remediation.retestTask){const task=taskRevision(index,entry.remediation.retestTask);if(!task||!isSatisfiedTask(task.status)||!task.evidenceIds.length)reasons.push(`retest-not-currently-reviewed:${entry.remediation.retestTask.taskId}`);}
    let canonicalCaseId=entry.id;
    if(entry.duplicateOf){if(visiting.has(entry.id)){reasons.push('duplicate-cycle');}else{visiting.add(entry.id);const target=entryMap.get(entry.duplicateOf);if(!target)reasons.push(`missing-canonical-case:${entry.duplicateOf}`);else{const canonical=view(target);canonicalCaseId=canonical.canonicalCaseId;if(!entry.rootCauseKey||entry.rootCauseKey!==target.rootCauseKey||entry.policyKey!==target.policyKey)reasons.push('duplicate-without-matching-reviewed-root-cause');if(target.duplicateOf)reasons.push('duplicate-target-is-not-canonical');if(!canonical.acceptedFinding)reasons.push('duplicate-target-not-current-accepted-finding');}visiting.delete(entry.id);}}
    const currentness:CaseCurrentness=entry.reviewStatus==='withdrawn'?'withdrawn':reasons.length?'stale':unknown?'unknown':'current';
    const acceptedFinding=entry.reviewStatus==='accepted'&&entry.verdict==='confirmed'&&!entry.duplicateOf&&currentness==='current';
    const rating=ratings.get(entry.id),ratedChain=rating?.finding.chain;
    // A chain is ready to rate when its executed depth is stated, or the record explicitly has no executed steps.
    const chainDepthStated=!ratedChain||ratedChain.demonstratedThrough!==undefined||ratedChain.steps.every(step=>step.claimRef===undefined);
    const readyToRate=currentness==='current'&&independentCurrent&&chainDepthStated;
    const retest=retests.get(entry.id),result:CaseView={...entry,currentness,staleReasons:[...new Set(reasons)].slice(0,40),independentCurrent,...(independenceReason?{independenceReason}:{}),acceptedFinding,readyToRate,canonicalCaseId,...(rating?{finding:rating.finding,ratedRevision:rating.caseRevision,ratingCurrent:rating.caseRevision===entry.revision,...(rating.provenance?{ratingProvenance:rating.provenance}:{})}:{} ),...(retest?{retest,retestCurrent:retestCurrent(retest,entry.revision)}:{})};views.set(entry.id,result);return result;
  };
  return entries.map(view);
}

export function boundCaseRequest(action:'create'|'revise',input:CaseDraft,request:MutationRequest,id?:string,revision?:number):MutationRequest{
  if(request.actorId!=='owner')throw Error('Case mutations require host-bound owner attribution');return {...request,payload:{kind:'case-entry',action,input,id,revision,submitted:request.payload}};
}

/** Idempotency binding of a rating request; the finding is validated first so a replay compares the same canonical payload. */
export function boundRatingRequest(id:string,revision:number,value:unknown,request:MutationRequest):MutationRequest{
  if(request.actorId!=='owner')throw Error('Case ratings require host-bound owner attribution');return {...request,payload:{kind:'case-rating',id,revision,finding:validateFinding(value),submitted:request.payload}};
}

/** Owner review service over candidate/task/evidence records; no finding store or execution queue. */
export class CaseBoard extends LedgerBoard{
  constructor(runId:string,path:string,active:()=>boolean,private context:CaseContext={},private now=()=>Date.now()){super(runId,path,active,'Case review','Case');}
  private mutate<T>(work:(index:LedgerIndex,cases:CaseEntry[])=>Promise<T>):Promise<T>{return this.serialized(index=>work(index,caseFrontier(index)));}
  private pin(input:CaseDraft,index:LedgerIndex):CaseDraft{return {...input,assetRefs:(input.assetRefs??[]).map(ref=>({...ref,revision:ref.revision??this.context.assetRevision?.(ref.id)})),taskRefs:input.taskRefs.map(ref=>({...ref,revision:ref.revision??taskFrontier(index).find(task=>task.id===ref.taskId)?.revision})),
    ...(input.remediation.retestTask?{remediation:{...input.remediation,retestTask:{...input.remediation.retestTask,revision:input.remediation.retestTask.revision??taskFrontier(index).find(task=>task.id===input.remediation.retestTask!.taskId)?.revision}}}:{})};}
  /** P10/TR-L01: a case that cites reviewed tasks may omit both reference lists; the host derives the pinned asset refs and the
   * claims the review accepted, and resolves a candidate slug to the record id the rest of the case board speaks. */
  private deriveRefs(input:CaseDraft,index:LedgerIndex):CaseDraft{
    const suppliedAssets=input.assetRefs??[],suppliedClaims=input.claimRefs??[];
    const assets=[...suppliedAssets],claims=[...suppliedClaims],seenAssets=new Set(assets.map(ref=>ref.id));
    for(const ref of input.taskRefs){
      const task=taskRevision(index,ref);if(!task)continue; // references() names an unknown or unpinned task
      if(!suppliedAssets.length)for(const asset of task.work?.assetRefs??[])if(!seenAssets.has(asset.id)&&assets.length<10){seenAssets.add(asset.id);assets.push({...asset,revision:asset.revision??this.context.assetRevision?.(asset.id)});}
      if(!suppliedClaims.length)for(const claim of reviewedClaimRecords(index,this.runId,ref.taskId))if(claims.length<10&&(isDemonstrated(claim.data??{})||claim.data?.closure==='ruled_out'))claims.push(claim.id!);
    }
    if(!assets.length)throw Error('Case needs exact asset references: pass assetRefs, or cite the reviewed task(s) in taskRefs whose work identity names the asset so the host derives them; legalNext: create the task with work.assetRefs, or copy the asset id from p2o_graph');
    if(!claims.length)throw Error('Case needs exact claim references: pass claimRefs (a candidate record id or slug), or cite a reviewed task in taskRefs whose review accepted a demonstrated or ruled-out claim so the host derives them; legalNext: review the worker claim first (p2o_task_review), or copy the claim record id from p2o_ledger');
    return {...input,assetRefs:assets,claimRefs:[...new Set(claims.map(ref=>this.resolveClaim(ref,index)))]};
  }
  /** A claim ref may be a record id or the slug the chain join keys on; the stored case always carries the resolved record id. */
  private resolveClaim(ref:string,index:LedgerIndex):string{
    const claim=candidateByReference(index,this.runId,ref);
    if(!claim?.id)throw Error(`Unknown case claim reference ${ref}: a same-run candidate record ID or its candidate slug is required; legalNext: copy the record ID from p2o_ledger, or the slug the chain join reads (a slug resolves to its latest head)`);
    return claim.id;
  }
  private references(input:CaseDraft,index:LedgerIndex,cases:CaseEntry[]):void{
    for(const ref of input.assetRefs??[]){const current=this.context.assetRevision?.(ref.id);if(this.context.assetRevision&&current===undefined)throw Error(`Unknown same-run case asset ${ref.id}`);if(ref.revision===undefined)throw Error('Case asset revision must be pinned');}
    if(input.hypothesis){const current=this.context.assertionRevision?.(input.hypothesis.id);if(this.context.assertionRevision&&current===undefined)throw Error('Unknown same-run case hypothesis');}
    for(const ref of input.claimRefs??[])if(index.byId.get(ref)?.kind!=='candidate'||index.byId.get(ref)?.runId!==this.runId)throw Error(`Unknown same-run candidate claim ${ref}`);
    for(const ref of input.independentEvidenceRefs)if(index.byId.get(ref)?.kind!=='evidence'||index.byId.get(ref)?.runId!==this.runId)throw Error(`Unknown same-run independent evidence ${ref}`);
    for(const ref of input.taskRefs)if(ref.revision===undefined||!taskRevision(index,ref))throw Error(`Unknown or unpinned case task ${ref.taskId}`);
    for(const ref of input.reportRefs)if(index.byId.get(ref)?.kind!=='report'||index.byId.get(ref)?.runId!==this.runId)throw Error(`Unknown same-run case report ${ref}`);
    for(const item of input.contradictions)if(index.byId.get(item.evidenceRef)?.kind!=='evidence'||index.byId.get(item.evidenceRef)?.runId!==this.runId)throw Error(`Unknown same-run contradiction evidence ${item.evidenceRef}`);
    for(const ref of input.remediation.evidenceRefs)if(index.byId.get(ref)?.kind!=='evidence'||index.byId.get(ref)?.runId!==this.runId)throw Error(`Unknown same-run remediation evidence ${ref}`);
    if(input.remediation.retestTask&&(input.remediation.retestTask.revision===undefined||!taskRevision(index,input.remediation.retestTask)))throw Error('Unknown or unpinned remediation retest task');
    for(const id of input.relatedCaseIds)if(!cases.some(entry=>entry.id===id))throw Error(`Unknown related case ${id}`);
    if(input.duplicateOf&&!cases.some(entry=>entry.id===input.duplicateOf))throw Error(`Unknown canonical case ${input.duplicateOf}`);
    const graph=new Map(cases.map(entry=>[entry.id,entry.duplicateOf]));if(input.id)graph.set(input.id,input.duplicateOf);const seen=new Set<string>();let cursor=input.id;while(cursor){if(seen.has(cursor))throw Error('Case duplicate chain cycle');seen.add(cursor);cursor=graph.get(cursor);}
  }
  private acceptance(input:CaseDraft,index:LedgerIndex,cases:CaseEntry[],previous:CaseEntry):void{
    if(input.reviewStatus!=='accepted')return;const provisional:CaseEntry={...input,assetRefs:input.assetRefs??[],claimRefs:input.claimRefs??[],id:input.id!,runId:this.runId,revision:previous.revision+1,recordId:'case-provisional'};
    const view=caseViews(indexRecordsWithCase(index,provisional,previous),this.context).find(item=>item.id===input.id);
    if(!view||view.currentness!=='current'){
      // The refusal and its strictness do not change; the message bounds an otherwise unbounded reason list and names the legal next step.
      const stale=view?.staleReasons??[],shown=stale.slice(0,3),omitted=stale.length-shown.length;
      const listed=shown.length?`${shown.join(', ')}${omitted>0?` (+${omitted} more)`:''}`:'unknown';
      const hint=stale.some(reason=>reason.startsWith('independent-')||reason.startsWith('validation-'))
        ?' Independence needs a reviewed peer claim whose data.independentEvidenceRef names the evidence id, or a reviewed validation task that the case cites through taskRefs (host-owned W4 path); make one current, then revise again.'
        :' Fix the listed reasons and revise again.';
      throw Error(`Case review is stale/incomplete: ${listed}.${hint}`);
    }
    if(input.duplicateOf&&!input.rootCauseKey)throw Error('Uncertain root cause cannot be merged; use relatedCaseIds');
  }
  private async write(make:()=>{draft:CaseDraft;revision:number;previous?:CaseEntry},request?:MutationRequest):Promise<CaseEntry>{
    const records=()=>{this.gate();const {draft,revision,previous}=make(),id=draft.id!,at=new Date(this.now()).toISOString(),value={...draft,id,runId:this.runId,revision},recordId=randomUUID();return [{id:recordId,runId:this.runId,at,by:'owner',kind:'note' as const,text:`case ${id}@r${revision}: ${draft.verdict}/${draft.reviewStatus}; owner review, not goal completion`,supersedes:previous?.recordId,refs:[...(draft.claimRefs??[]),...draft.independentEvidenceRefs].slice(0,10),data:{case:value}}];};
    const acks=request?await appendGeneratedRecords(this.path,records,request):await appendRecords(this.path,records()),index=await readLedger(this.path,this.runId),row=index.byId.get(acks[0].recordId);if(!index.complete||!row?.data?.case)throw Error('Case ACK retained but detail unavailable; inspect without replay');return validateStoredCase(row.data.case,row.id!);
  }
  private async retained(request:MutationRequest|undefined):Promise<CaseEntry|undefined>{if(!request)return;const acks=await readGeneratedRecords(this.path,request);if(!acks)return;const index=await readLedger(this.path,this.runId),row=index.byId.get(acks[0].recordId);if(!index.complete||!row?.data?.case)throw Error('Retained case ACK detail unavailable');return validateStoredCase(row.data.case,row.id!);}
  async create(value:CaseDraft,request?:MutationRequest):Promise<CaseEntry>{const input=validateCaseDraft(value),bound=request?boundCaseRequest('create',value,request):undefined,prior=await this.retained(bound);if(prior)return prior;return this.mutate(async(index,cases)=>{const id=input.id??`case-${randomUUID()}`,draft=this.deriveRefs(this.pin({...input,id},index),index);if(cases.some(entry=>entry.id===id))throw Error('Duplicate case identity');if(cases.filter(entry=>!terminalReview.has(entry.reviewStatus)).length>=100)throw Error('Live case frontier limit reached (100)');if(draft.reviewStatus!=='pending')throw Error('Create a pending case; acceptance/dispute/withdrawal needs an explicit revision');this.references(draft,index,cases);return this.write(()=>({draft,revision:1}),bound);});}
  async revise(id:string,revision:number,value:CaseDraft,request?:MutationRequest):Promise<CaseEntry>{const input=validateCaseDraft(value),bound=request?boundCaseRequest('revise',value,request,id,revision):undefined,prior=await this.retained(bound);if(prior)return prior;return this.mutate(async(index,cases)=>{const old=cases.find(entry=>entry.id===id);if(!old||old.revision!==revision)throw Error('Missing or stale case revision');if(input.id&&input.id!==id)throw Error('Cannot change case identity');const draft=this.deriveRefs(this.pin({...input,id},index),index),allowed:Record<string,string[]>={pending:['pending','accepted','disputed','withdrawn'],accepted:['pending','accepted','disputed','withdrawn'],disputed:['pending','disputed','withdrawn'],withdrawn:[]};if(!allowed[old.reviewStatus].includes(draft.reviewStatus))throw Error('Invalid case review transition');this.references(draft,index,cases);this.acceptance(draft,index,cases,old);return this.write(()=>({draft,revision:old.revision+1,previous:old}),bound);});}
  /**
   * Owner rating of an existing case, recorded against the exact case revision as a separate note. Verdict, review status and revision are untouched, so
   * coverage cells that pin the case stay current. A high/critical rating is refused while any inferred-basis claim is not a tested observation
   * (confirmed closure, tested execution, non-static proof); when every inferred-basis claim was observed it is allowed at demonstrated depth,
   * records the INFERRED_POLICY provenance flag and needs a non-empty finding limitation. Reproduction evidence must be same-run.
   */
  async rate(id:string,revision:number,value:unknown,request?:MutationRequest):Promise<{caseId:string;caseRevision:number;finding:CaseFinding;recordId:string;provenance?:RatingProvenance}>{
    const finding=validateFinding(value),bound=request?boundRatingRequest(id,revision,value,request):undefined;
    const prior=bound?await readGeneratedRecords(this.path,bound):undefined;
    const read=async(acks:{recordId:string}[])=>{const index=await readLedger(this.path,this.runId),row=index.byId.get(acks[0].recordId),data=row?.data?.caseRating as {caseId:string;caseRevision:number;finding:CaseFinding;provenance?:unknown}|undefined;if(!index.complete||!row?.id||!data)throw Error('Retained rating detail unavailable');const provenance=data.provenance==='INFERRED_POLICY'?'INFERRED_POLICY' as const:undefined;return {caseId:data.caseId,caseRevision:data.caseRevision,finding:validateFinding(data.finding),recordId:row.id,...(provenance?{provenance}:{})};};
    if(prior)return read(prior);
    return this.mutate(async(index,cases)=>{
      const entry=cases.find(item=>item.id===id);if(!entry||entry.revision!==revision)throw Error('Missing or stale case revision');
      if(entry.reviewStatus==='withdrawn')throw Error('A withdrawn case cannot be rated');
      for(const ref of finding.reproductionEvidenceRefs)if(index.byId.get(ref)?.kind!=='evidence'||index.byId.get(ref)?.runId!==this.runId)throw Error(`Unknown same-run reproduction evidence ${ref}`);
      // A chain step may cite the candidate record id or its slug: the join and the rating must speak one language (P13a).
      const chainClaim=(ref:string)=>candidateByReference(index,this.runId,ref);
      for(const step of finding.chain?.steps??[])if(step.claimRef&&!chainClaim(step.claimRef))throw Error(`Unknown same-run chain claim ${step.claimRef}`);
      if(finding.chain?.demonstratedThrough)for(const step of finding.chain.steps.slice(0,finding.chain.demonstratedThrough)){const claim=chainClaim(step.claimRef!);
        if(claim?.data?.closure!=='confirmed'||claim?.data?.execution!=='tested')throw Error(`Chain step ${step.order} is recorded as executed but its claim is not a confirmed tested result`);}
      // P14.9: the rating is derived from the demonstration. Nothing executed demonstrates nothing, and a rating above what the chain showed is
      // refused instead of recorded. Under-claiming stays allowed: a chain may demonstrate more than the owner chose to write down.
      if(finding.chain){const depth=finding.chain.demonstratedThrough,impact=depth===undefined?undefined:chainImpact(finding.chain.steps,depth);
        if(!impact){if(severityRank(finding.severity)>0)throw Error(depth===undefined?'A rating needs a demonstrated effect: state the executed depth with demonstratedThrough and the effect that depth showed, then rate':'The chain depth names no effect, so no impact was demonstrated; record the effect that executed step showed, then rate');}
        else if(severityRank(finding.severity)>severityRank(impact.severity))throw Error(`Finding severity ${finding.severity} exceeds what step ${depth} demonstrated: ${impact.effect} scores ${impact.severity} (${impact.vector} = ${impact.score.toFixed(1)}). Rate at or below that, or record a deeper executed step.`);}
      // D35: the inferred ceiling is about what the effect showed, not where the policy came from. An inferred-basis claim that ran and was
      // observed is a demonstration; an untested one is still a hypothesis, so the medium ceiling and the authority invariants do not move.
      let provenance:RatingProvenance|undefined;
      if(['critical','high'].includes(finding.severity)){
        const inferred=entry.claimRefs.filter(ref=>index.byId.get(ref)?.data?.policyBasis==='inferred');
        const observed=(ref:string)=>{const data=index.byId.get(ref)?.data;return isDemonstrated(data??{})&&data?.proof!=='static_trace';};
        const unobserved=inferred.find(ref=>!observed(ref));
        if(unobserved)throw Error(`A case resting on an inferred policy basis cannot be rated above medium while claim ${unobserved} is not a tested observation: inference is provenance, not proof. Record the effect as a confirmed+tested claim with a non-static proof, or rate at medium or below.`);
        if(inferred.length){
          if(!finding.limitations?.trim())throw Error('INFERRED_POLICY: a high/critical rating on inferred policy provenance needs a non-empty finding.limitations naming what the inference leaves unproven');
          provenance='INFERRED_POLICY';
        }
      }
      const records=()=>{this.gate();return [{id:randomUUID(),runId:this.runId,at:new Date(this.now()).toISOString(),by:'owner',kind:'note' as const,text:`case ${id}@r${revision} rated ${finding.severity}${provenance?` (${provenance})`:''}; owner rating, not review`,refs:finding.reproductionEvidenceRefs.slice(0,10),data:{caseRating:{caseId:id,caseRevision:revision,finding,...(provenance?{provenance}:{})}}}];};
      const acks=bound?await appendGeneratedRecords(this.path,records,bound):await appendRecords(this.path,records());return read(acks);
    });
  }
  /**
   * R3.5: record one owner retest against an accepted, current case revision. The retest is a note, not a case revision, so verdict,
   * review status and coverage cells that pin the case stay current; only the finding's current state changes. A second retest of the
   * same case revision is refused (a retest answers one revision), a case that is not a current accepted finding is refused, and the
   * two evidentiary verdicts need same-run evidence while cannot_confirm may cite none. A retest never rates and never re-accepts.
   */
  async retest(id:string,revision:number,value:unknown,request?:MutationRequest):Promise<CaseRetest>{
    const input=validateRetest(value??{}),bound=request?boundRetestRequest(id,revision,value,request):undefined;
    const prior=bound?await readGeneratedRecords(this.path,bound):undefined;
    const read=async(acks:{recordId:string}[])=>{const index=await readLedger(this.path,this.runId),row=index.byId.get(acks[0].recordId),data=row?.data?.caseRetest as {caseId?:unknown;caseRevision?:unknown;verdict?:unknown;reason?:unknown;evidenceRefs?:unknown}|undefined;
      if(!index.complete||!row?.id||!data)throw Error('Retained retest detail unavailable');
      const stored=validateRetest({verdict:data.verdict,reason:data.reason,evidenceRefs:data.evidenceRefs??[]});
      return {caseId:data.caseId as string,caseRevision:Number(data.caseRevision),...stored,recordId:row.id};};
    if(prior)return read(prior);
    return this.mutate(async(index,cases)=>{
      const entry=cases.find(item=>item.id===id);if(!entry||entry.revision!==revision)throw Error('Missing or stale case revision');
      const view=caseViews(index,this.context).find(item=>item.id===id);
      if(!view)throw Error('Unknown case');
      if(entry.reviewStatus!=='accepted'||entry.verdict!=='confirmed')throw Error('Only an accepted confirmed finding can be retested: a retest reports whether the demonstrated effect still holds, so the case must first be an accepted finding');
      if(!view.acceptedFinding){const stale=view.staleReasons.slice(0,3),omitted=view.staleReasons.length-stale.length;throw Error(`A case that is not a current accepted finding cannot be retested: ${stale.join(', ')||'acceptedFinding=false'}${omitted>0?` (+${omitted} more)`:''}; fix the stale references or revise the case, then retest`);}
      const existing=caseRetests(index).get(id);
      if(existing?.caseRevision===revision)throw Error(`Case revision ${revision} was already retested (${existing.verdict}): a retest answers one case revision, so revise the case if the assessment changed, or record the next observation against the new revision`);
      if(input.verdict!=='cannot_confirm'&&!input.evidenceRefs.length)throw Error('A still_reproducible or fixed retest needs same-run evidence IDs: the verdict is the observation, so cite the receipt that shows it; only cannot_confirm may cite none');
      for(const ref of input.evidenceRefs)if(index.byId.get(ref)?.kind!=='evidence'||index.byId.get(ref)?.runId!==this.runId)throw Error(`Unknown same-run retest evidence ${ref}`);
      const records=()=>{this.gate();return [{id:randomUUID(),runId:this.runId,at:new Date(this.now()).toISOString(),by:'owner',kind:'note' as const,text:`case ${id}@r${revision} retest ${input.verdict}; owner retest, not a rating`,refs:input.evidenceRefs.slice(0,10),data:{caseRetest:{caseId:id,caseRevision:revision,...input}}}];};
      const acks=bound?await appendGeneratedRecords(this.path,records,bound):await appendRecords(this.path,records());
      return read(acks);
    });
  }
  async list():Promise<CaseView[]>{const index=await readLedger(this.path,this.runId);if(!index.complete)throw Error('Case reconciliation incomplete');return caseViews(index,this.context);}
}

/** Add a provisional head only for pure validation; never persists or creates authority. */
function indexRecordsWithCase(index:LedgerIndex,entry:CaseEntry,previous:CaseEntry):LedgerIndex{
  const {recordId:_,...stored}=entry,record:AssessmentRecord={id:entry.recordId,runId:entry.runId,version:2,at:new Date(0).toISOString(),by:'owner',kind:'note',text:'provisional case validation',supersedes:previous.recordId,data:{case:stored}};
  return {records:[...index.records,record],byId:new Map([...index.byId,[record.id!,record]]),complete:index.complete,diagnostics:[...index.diagnostics],issueCount:index.issueCount,foreign:index.foreign,bytes:index.bytes,snapshotSequence:index.snapshotSequence};
}
