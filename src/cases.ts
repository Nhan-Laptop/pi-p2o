import { randomUUID } from 'node:crypto';
import { appendGeneratedRecords, appendRecords, ownerNoteFrontier, readGeneratedRecords, readLedger, type AssessmentRecord, type LedgerIndex } from './records.js';
import { taskFrontier, taskHead, taskRevisionAt, type AssessmentTask } from './tasks.js';
import type { MutationRequest } from './state/store.js';
import { LedgerBoard } from './board.js';
import { validateCaseDraft, validateFinding, validateStoredCase, type CaseDraft, type CaseEntry, type CaseFinding, type CaseTaskRef } from './case-types.js';

export type CaseCurrentness='current'|'stale'|'withdrawn'|'unknown';
export interface CaseView extends CaseEntry {
  currentness:CaseCurrentness;staleReasons:string[];independentCurrent:boolean;acceptedFinding:boolean;canonicalCaseId:string;
  /** Latest owner rating of this case id and the case revision it was recorded against; a rating of an older revision is kept but flagged. */
  finding?:CaseFinding;ratedRevision?:number;ratingCurrent?:boolean;
}
export interface CaseContext {assetRevision?:(id:string)=>number|undefined;assertionRevision?:(id:string)=>number|undefined}
const terminalReview=new Set(['withdrawn']);
/** A case whose review is still open: pending, or disputed after a review. */
export const needsCaseReview=(view:{reviewStatus?:unknown}):boolean=>view.reviewStatus==='pending'||view.reviewStatus==='disputed';

const candidateKey=(record:AssessmentRecord)=>typeof record.data?.candidate==='string'?record.data.candidate:undefined;
const candidateRecords=(index:LedgerIndex)=>index.records.filter(row=>row.kind==='candidate'&&row.id&&candidateKey(row));
function candidateHeads(index:LedgerIndex):Map<string,AssessmentRecord>{const heads=new Map<string,AssessmentRecord>();for(const row of candidateRecords(index))heads.set(candidateKey(row)!,row);return heads;}
function actorCandidateHeads(index:LedgerIndex):Map<string,AssessmentRecord>{const heads=new Map<string,AssessmentRecord>();for(const row of candidateRecords(index))heads.set(`${row.by}\u0000${candidateKey(row)}`,row);return heads;}
function taskRevision(index:LedgerIndex,ref:CaseTaskRef):AssessmentTask|undefined{return taskRevisionAt(index,ref.taskId,ref.revision);}

export const caseFrontier=(index:LedgerIndex):CaseEntry[]=>ownerNoteFrontier(index,'case',validateStoredCase);

function independentReceiptCurrent(index:LedgerIndex,claim:AssessmentRecord,evidenceId:string,actors:Map<string,AssessmentRecord>):boolean{
  const evidence=index.byId.get(evidenceId),key=candidateKey(claim);if(evidence?.kind!=='evidence'||!evidence.workerId||!key||evidence.by===claim.by)return false;
  const validator=actors.get(`${evidence.by}\u0000${key}`);return Boolean(validator&&validator.surface===claim.surface&&validator.risk===claim.risk&&validator.data?.closure==='confirmed'&&validator.data?.execution==='tested'
    &&validator.data?.proof!=='static_trace'&&validator.refs?.includes(evidenceId));
}

/** Latest owner rating per case id, in ledger order. Malformed or foreign-run notes are not promoted, as for cases. */
export function caseRatings(index:LedgerIndex):Map<string,{finding:CaseFinding;caseRevision:number;recordId:string}>{
  const latest=new Map<string,{finding:CaseFinding;caseRevision:number;recordId:string}>();
  for(const row of index.records){const value=row.kind==='note'&&row.by==='owner'&&!row.workerId?row.data?.caseRating as Record<string,unknown>|undefined:undefined;if(!row.id||!value||typeof value!=='object')continue;
    try{const caseId=value.caseId,revision=value.caseRevision;if(typeof caseId!=='string'||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(caseId)||!Number.isSafeInteger(revision)||Number(revision)<1)continue;latest.set(caseId,{finding:validateFinding(value.finding),caseRevision:Number(revision),recordId:row.id});}catch{/* Untrusted/legacy notes are not promoted. */}}
  return latest;
}

/** Derived, read-only currentness. It cannot upgrade a claim, goal or target authority. */
export function caseViews(index:LedgerIndex,context:CaseContext={}):CaseView[]{
  const entries=caseFrontier(index),ratings=caseRatings(index),claims=candidateHeads(index),actors=actorCandidateHeads(index),entryMap=new Map(entries.map(entry=>[entry.id,entry])),views=new Map<string,CaseView>(),visiting=new Set<string>();
  const view=(entry:CaseEntry):CaseView=>{
    const cached=views.get(entry.id);if(cached)return cached;const reasons:string[]=[];let unknown=false;
    if(entry.reviewStatus==='withdrawn')reasons.push('case-review-withdrawn');
    for(const ref of entry.assetRefs){const current=context.assetRevision?.(ref.id);if(!context.assetRevision)unknown=true;else if(current===undefined)reasons.push(`missing-asset:${ref.id}`);else if(ref.revision===undefined)reasons.push(`unpinned-asset:${ref.id}`);else if(current!==ref.revision)reasons.push(`stale-asset:${ref.id}@r${ref.revision}->r${current}`);}
    if(entry.hypothesis){const current=context.assertionRevision?.(entry.hypothesis.id);if(!context.assertionRevision)unknown=true;else if(current===undefined)reasons.push(`missing-hypothesis:${entry.hypothesis.id}`);else if(current!==entry.hypothesis.revision)reasons.push(`stale-hypothesis:${entry.hypothesis.id}@r${entry.hypothesis.revision}->r${current}`);}
    const citedClaims:AssessmentRecord[]=[];for(const id of entry.claimRefs){const claim=index.byId.get(id),key=claim&&candidateKey(claim);if(!claim||claim.kind!=='candidate'||!key){reasons.push(`missing-claim:${id}`);continue;}citedClaims.push(claim);if(claims.get(key)?.id!==id)reasons.push(`superseded-claim:${id}`);}
    for(const ref of entry.taskRefs){const task=taskRevision(index,ref);if(!task)reasons.push(`missing-task-revision:${ref.taskId}@r${ref.revision??'?'}`);else{const head=taskHead(index,ref.taskId);if(head&&head.revision!==ref.revision)reasons.push(`superseded-task:${ref.taskId}@r${ref.revision}`);}}
    for(const id of entry.reportRefs)if(index.byId.get(id)?.kind!=='report')reasons.push(`missing-report:${id}`);
    for(const item of entry.contradictions)if(index.byId.get(item.evidenceRef)?.kind!=='evidence')reasons.push(`missing-contradiction:${item.evidenceRef}`);else if(item.status==='open')reasons.push(`open-contradiction:${item.evidenceRef}`);
    let independentCurrent=entry.independentEvidenceRefs.length>0;
    for(const evidenceId of entry.independentEvidenceRefs){const supporting=citedClaims.some(claim=>claim.data?.independentEvidenceRef===evidenceId&&independentReceiptCurrent(index,claim,evidenceId,actors));if(!supporting){independentCurrent=false;reasons.push(`independent-support-stale:${evidenceId}`);}}
    if(entry.verdict==='confirmed'&&!citedClaims.some(claim=>claim.data?.closure==='confirmed'&&claim.data?.execution==='tested'&&claim.data?.policyBasis!=='inferred'))reasons.push('confirmed-verdict-lacks-current-tested-claim');
    if(entry.verdict==='ruled_out'&&!citedClaims.some(claim=>claim.data?.closure==='ruled_out'&&typeof claim.data?.control==='string'))reasons.push('ruled-out-verdict-lacks-bounded-control');
    for(const id of entry.remediation.evidenceRefs)if(index.byId.get(id)?.kind!=='evidence')reasons.push(`missing-remediation-evidence:${id}`);
    if(entry.remediation.retestTask){const task=taskRevision(index,entry.remediation.retestTask);if(!task||!['reviewed','closed'].includes(task.status)||!task.evidenceIds.length)reasons.push(`retest-not-currently-reviewed:${entry.remediation.retestTask.taskId}`);}
    let canonicalCaseId=entry.id;
    if(entry.duplicateOf){if(visiting.has(entry.id)){reasons.push('duplicate-cycle');}else{visiting.add(entry.id);const target=entryMap.get(entry.duplicateOf);if(!target)reasons.push(`missing-canonical-case:${entry.duplicateOf}`);else{const canonical=view(target);canonicalCaseId=canonical.canonicalCaseId;if(!entry.rootCauseKey||entry.rootCauseKey!==target.rootCauseKey||entry.policyKey!==target.policyKey)reasons.push('duplicate-without-matching-reviewed-root-cause');if(target.duplicateOf)reasons.push('duplicate-target-is-not-canonical');if(!canonical.acceptedFinding)reasons.push('duplicate-target-not-current-accepted-finding');}visiting.delete(entry.id);}}
    const currentness:CaseCurrentness=entry.reviewStatus==='withdrawn'?'withdrawn':reasons.length?'stale':unknown?'unknown':'current';
    const acceptedFinding=entry.reviewStatus==='accepted'&&entry.verdict==='confirmed'&&!entry.duplicateOf&&currentness==='current';
    const rating=ratings.get(entry.id),result:CaseView={...entry,currentness,staleReasons:[...new Set(reasons)].slice(0,40),independentCurrent,acceptedFinding,canonicalCaseId,...(rating?{finding:rating.finding,ratedRevision:rating.caseRevision,ratingCurrent:rating.caseRevision===entry.revision}:{})};views.set(entry.id,result);return result;
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
  private pin(input:CaseDraft,index:LedgerIndex):CaseDraft{return {...input,assetRefs:input.assetRefs.map(ref=>({...ref,revision:ref.revision??this.context.assetRevision?.(ref.id)})),taskRefs:input.taskRefs.map(ref=>({...ref,revision:ref.revision??taskFrontier(index).find(task=>task.id===ref.taskId)?.revision})),
    ...(input.remediation.retestTask?{remediation:{...input.remediation,retestTask:{...input.remediation.retestTask,revision:input.remediation.retestTask.revision??taskFrontier(index).find(task=>task.id===input.remediation.retestTask!.taskId)?.revision}}}:{})};}
  private references(input:CaseDraft,index:LedgerIndex,cases:CaseEntry[]):void{
    for(const ref of input.assetRefs){const current=this.context.assetRevision?.(ref.id);if(this.context.assetRevision&&current===undefined)throw Error(`Unknown same-run case asset ${ref.id}`);if(ref.revision===undefined)throw Error('Case asset revision must be pinned');}
    if(input.hypothesis){const current=this.context.assertionRevision?.(input.hypothesis.id);if(this.context.assertionRevision&&current===undefined)throw Error('Unknown same-run case hypothesis');}
    for(const ref of input.claimRefs)if(index.byId.get(ref)?.kind!=='candidate'||index.byId.get(ref)?.runId!==this.runId)throw Error(`Unknown same-run candidate claim ${ref}`);
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
    if(input.reviewStatus!=='accepted')return;const provisional:CaseEntry={...input,id:input.id!,runId:this.runId,revision:previous.revision+1,recordId:'case-provisional'};
    const view=caseViews(indexRecordsWithCase(index,provisional,previous),this.context).find(item=>item.id===input.id);
    if(!view||view.currentness!=='current')throw Error(`Case review is stale/incomplete: ${view?.staleReasons.join(',')||'unknown'}`);
    if(input.duplicateOf&&!input.rootCauseKey)throw Error('Uncertain root cause cannot be merged; use relatedCaseIds');
  }
  private async write(make:()=>{draft:CaseDraft;revision:number;previous?:CaseEntry},request?:MutationRequest):Promise<CaseEntry>{
    const records=()=>{this.gate();const {draft,revision,previous}=make(),id=draft.id!,at=new Date(this.now()).toISOString(),value={...draft,id,runId:this.runId,revision},recordId=randomUUID();return [{id:recordId,runId:this.runId,at,by:'owner',kind:'note' as const,text:`case ${id}@r${revision}: ${draft.verdict}/${draft.reviewStatus}; owner review, not goal completion`,supersedes:previous?.recordId,refs:[...draft.claimRefs,...draft.independentEvidenceRefs].slice(0,10),data:{case:value}}];};
    const acks=request?await appendGeneratedRecords(this.path,records,request):await appendRecords(this.path,records()),index=await readLedger(this.path,this.runId),row=index.byId.get(acks[0].recordId);if(!index.complete||!row?.data?.case)throw Error('Case ACK retained but detail unavailable; inspect without replay');return validateStoredCase(row.data.case,row.id!);
  }
  private async retained(request:MutationRequest|undefined):Promise<CaseEntry|undefined>{if(!request)return;const acks=await readGeneratedRecords(this.path,request);if(!acks)return;const index=await readLedger(this.path,this.runId),row=index.byId.get(acks[0].recordId);if(!index.complete||!row?.data?.case)throw Error('Retained case ACK detail unavailable');return validateStoredCase(row.data.case,row.id!);}
  async create(value:CaseDraft,request?:MutationRequest):Promise<CaseEntry>{const input=validateCaseDraft(value),bound=request?boundCaseRequest('create',value,request):undefined,prior=await this.retained(bound);if(prior)return prior;return this.mutate(async(index,cases)=>{const id=input.id??`case-${randomUUID()}`,draft=this.pin({...input,id},index);if(cases.some(entry=>entry.id===id))throw Error('Duplicate case identity');if(cases.filter(entry=>!terminalReview.has(entry.reviewStatus)).length>=100)throw Error('Live case frontier limit reached (100)');if(draft.reviewStatus!=='pending')throw Error('Create a pending case; acceptance/dispute/withdrawal needs an explicit revision');this.references(draft,index,cases);return this.write(()=>({draft,revision:1}),bound);});}
  async revise(id:string,revision:number,value:CaseDraft,request?:MutationRequest):Promise<CaseEntry>{const input=validateCaseDraft(value),bound=request?boundCaseRequest('revise',value,request,id,revision):undefined,prior=await this.retained(bound);if(prior)return prior;return this.mutate(async(index,cases)=>{const old=cases.find(entry=>entry.id===id);if(!old||old.revision!==revision)throw Error('Missing or stale case revision');if(input.id&&input.id!==id)throw Error('Cannot change case identity');const draft=this.pin({...input,id},index),allowed:Record<string,string[]>={pending:['pending','accepted','disputed','withdrawn'],accepted:['pending','accepted','disputed','withdrawn'],disputed:['pending','disputed','withdrawn'],withdrawn:[]};if(!allowed[old.reviewStatus].includes(draft.reviewStatus))throw Error('Invalid case review transition');this.references(draft,index,cases);this.acceptance(draft,index,cases,old);return this.write(()=>({draft,revision:old.revision+1,previous:old}),bound);});}
  /**
   * Owner rating of an existing case, recorded against the exact case revision as a separate note. Verdict, review status and revision are untouched, so
   * coverage cells that pin the case stay current. A case on an inferred policy basis cannot be rated above medium; reproduction evidence must be same-run.
   */
  async rate(id:string,revision:number,value:unknown,request?:MutationRequest):Promise<{caseId:string;caseRevision:number;finding:CaseFinding;recordId:string}>{
    const finding=validateFinding(value),bound=request?boundRatingRequest(id,revision,value,request):undefined;
    const prior=bound?await readGeneratedRecords(this.path,bound):undefined;
    const read=async(acks:{recordId:string}[])=>{const index=await readLedger(this.path,this.runId),row=index.byId.get(acks[0].recordId),data=row?.data?.caseRating as {caseId:string;caseRevision:number;finding:CaseFinding}|undefined;if(!index.complete||!row?.id||!data)throw Error('Retained rating detail unavailable');return {caseId:data.caseId,caseRevision:data.caseRevision,finding:validateFinding(data.finding),recordId:row.id};};
    if(prior)return read(prior);
    return this.mutate(async(index,cases)=>{
      const entry=cases.find(item=>item.id===id);if(!entry||entry.revision!==revision)throw Error('Missing or stale case revision');
      if(entry.reviewStatus==='withdrawn')throw Error('A withdrawn case cannot be rated');
      for(const ref of finding.reproductionEvidenceRefs)if(index.byId.get(ref)?.kind!=='evidence'||index.byId.get(ref)?.runId!==this.runId)throw Error(`Unknown same-run reproduction evidence ${ref}`);
      if(['critical','high'].includes(finding.severity)&&entry.claimRefs.some(ref=>index.byId.get(ref)?.data?.policyBasis==='inferred'))throw Error('A case resting on an inferred policy basis cannot be rated above medium');
      const records=()=>{this.gate();return [{id:randomUUID(),runId:this.runId,at:new Date(this.now()).toISOString(),by:'owner',kind:'note' as const,text:`case ${id}@r${revision} rated ${finding.severity}; owner rating, not review`,refs:finding.reproductionEvidenceRefs.slice(0,10),data:{caseRating:{caseId:id,caseRevision:revision,finding}}}];};
      const acks=bound?await appendGeneratedRecords(this.path,records,bound):await appendRecords(this.path,records());return read(acks);
    });
  }
  async list():Promise<CaseView[]>{const index=await readLedger(this.path,this.runId);if(!index.complete)throw Error('Case reconciliation incomplete');return caseViews(index,this.context);}
}

/** Add a provisional head only for pure validation; never persists or creates authority. */
function indexRecordsWithCase(index:LedgerIndex,entry:CaseEntry,previous:CaseEntry):LedgerIndex{
  const {recordId:_,...stored}=entry,record:AssessmentRecord={id:entry.recordId,runId:entry.runId,version:2,at:new Date(0).toISOString(),by:'owner',kind:'note',text:'provisional case validation',supersedes:previous.recordId,data:{case:stored}};
  return {records:[...index.records,record],byId:new Map([...index.byId,[record.id!,record]]),complete:index.complete,diagnostics:[...index.diagnostics],issueCount:index.issueCount,foreign:index.foreign,bytes:index.bytes,snapshotSequence:index.snapshotSequence};
}
