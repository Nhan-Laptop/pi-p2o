import { randomUUID } from 'node:crypto';
import { sha256Hex } from './validate.js';
import { appendGeneratedRecords, appendRecords, ownerNoteFrontier, readGeneratedRecords, readLedger, type AssessmentRecord, type LedgerIndex, type RecordAck } from './records.js';
import { graphCanonical } from './state/graph.js';
import { isSatisfiedTask, taskFrontier, taskReferenceSuperseded, taskRevisionAt, terminalState, type AssessmentTask } from './tasks.js';
import { caseViews, type CaseContext, type CaseView } from './cases.js';
import { isConfirmedClaim, isOpenClaim, isRuledOutClaim, isTestedCell } from './claims.js';
import type { MutationRequest } from './state/store.js';
import { LedgerBoard } from './board.js';
import { validateCoveragePlanDraft, validateStoredCoverageCell, validateStoredCoveragePlan, type CoverageAssessment, type CoverageCaseRef, type CoverageCellDraft, type CoverageCellEntry, type CoverageExecution, type CoveragePlanDraft, type CoveragePlanEntry, type CoverageTaskRef } from './coverage-types.js';
/** Coverage-plan vocabulary, distinct from tasks: a plan is reviewed/closed, never "satisfied". */
const COVERAGE_PLAN_REVIEWED=['reviewed','closed'] as const;
/** A3: a work identity that names no actor/tenant context still has to be placed in one denominator row. */
const DEFAULT_ACTOR='actor:unspecified',DEFAULT_TENANT='tenant:unspecified';

export interface CoverageContext extends CaseContext {targetRevision:()=>string;assetIds?:()=>string[]}
export interface CoverageCellView extends CoverageCellEntry {currentness:'current'|'stale'|'unknown'|'retired';staleReasons:string[];effectiveAssessment:CoverageCellEntry['assessment'];effectiveExecution:CoverageCellEntry['execution'];reviewed:boolean}
/** A3: a task whose work identity names no asset cannot be placed in the denominator. It is reported, never invented into a cell. */
export interface UnmappedCoverageTask {taskId:string;revision:number;question:string;role:string;status:string;reason:string}
export interface CoveragePlanView extends CoveragePlanEntry {cells:CoverageCellView[];counts:{execution:Record<string,number>;assessment:Record<string,number>;stale:number;reviewed:number};discoveredUnplannedAssets:number;omittedCells:number;unmapped:UnmappedCoverageTask[];unmappedCount:number;warning:string}

function taskAt(index:LedgerIndex,id:string,revision:number|undefined):AssessmentTask|undefined{return taskRevisionAt(index,id,revision);}
function claimHeads(index:LedgerIndex):Map<string,AssessmentRecord>{const result=new Map<string,AssessmentRecord>();for(const row of index.records)if(row.kind==='candidate'&&typeof row.data?.candidate==='string')result.set(row.data.candidate,row);return result;}
export const coveragePlans=(index:LedgerIndex):CoveragePlanEntry[]=>ownerNoteFrontier(index,'coveragePlan',validateStoredCoveragePlan);
export const coverageCells=(index:LedgerIndex):CoverageCellEntry[]=>ownerNoteFrontier(index,'coverageCell',validateStoredCoverageCell);
/** M5: the terminal states in which a task ended without an answer, so nothing it touched can be called tested. */
export const INTERRUPTED_TASK_STATES = ['blocked','stopped','exhausted'] as const;
/** Assessments that assert a verdict rather than an attempt, so an interrupted task may not carry them. */
export const VERDICT_ASSESSMENTS = ['confirmed_claim','ruled_out_bounded','accepted'] as const;
export interface InterruptedTask {taskId:string;state:string}
/** M5: which tasks this cell cites that ended without a verdict. Pinned revision, so a later satisfied revision does not launder it. */
export function interruptedCellTasks(index:LedgerIndex,cell:{taskRefs:readonly {taskId:string;revision?:number}[]}):InterruptedTask[]{
  const rows:InterruptedTask[]=[];
  for(const ref of cell.taskRefs){const task=taskAt(index,ref.taskId,ref.revision);if(!task)continue;const state=terminalState(task);if(state&&(INTERRUPTED_TASK_STATES as readonly string[]).includes(state))rows.push({taskId:ref.taskId,state});}
  return rows;
}
/** M5: the cell claims a verdict while a task it cites was interrupted — the one shape the view must downgrade (legacy stored cells). */
export const interruptedVerdict=(index:LedgerIndex,cell:CoverageCellDraft|CoverageCellEntry):InterruptedTask|undefined=>{
  const claimsVerdict=isTestedCell(cell)||(VERDICT_ASSESSMENTS as readonly string[]).includes(cell.assessment);
  return claimsVerdict?interruptedCellTasks(index,cell)[0]:undefined;
};
export function coverageFingerprint(targetRevision:string,input:CoverageCellDraft):string{return sha256Hex(graphCanonical({version:1,targetRevision,assetRef:input.assetRef,questionKey:input.questionKey,policyKey:input.policyKey??null,actorContext:input.actorContext,tenantContext:input.tenantContext,methodFamily:input.methodFamily}));}

/**
 * A3 (planning_update.md §2.6): coverage cells are a projection of committed work, not a model-authored denominator row.
 * The host reads the reviewed task, its worker claims and the cases that cite it, and fills the cell fields. Nothing here writes
 * to the ledger and nothing here upgrades an assessment: a task without a verdict stays planned or blocked, and a task whose work
 * identity names no asset becomes an unmapped gap instead of a clean cell.
 */
export interface ProjectedCoverageCell extends CoverageCellDraft {fingerprint:string}
export interface CoverageProjection {cells:ProjectedCoverageCell[];unmapped:UnmappedCoverageTask[];counts:{execution:Record<string,number>;assessment:Record<string,number>};warning:string}
interface ClaimLink {record:AssessmentRecord;evidenceRefs:string[];negativeControlRefs:string[];limitations?:string;taskRef:string}
const stringList=(value:unknown):string[]=>Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];
/** Worker claims only: after A2 the planner cannot author one, so an owner-authored legacy candidate is not coverage work. */
function workerClaims(index:LedgerIndex):ClaimLink[]{
  const rows:ClaimLink[]=[];
  for(const row of index.records){
    if(row.kind!=='candidate'||!row.id||typeof row.data?.candidate!=='string'||row.by==='owner'||!row.workerId||typeof row.data?.taskRef!=='string')continue;
    rows.push({record:row,evidenceRefs:stringList(row.data.evidenceRefs).filter(id=>index.byId.get(id)?.kind==='evidence'),negativeControlRefs:stringList(row.data.negativeControls).filter(id=>index.byId.get(id)?.kind==='evidence'),limitations:typeof row.data.limitations==='string'?row.data.limitations:undefined,taskRef:row.data.taskRef});
  }
  return rows;
}
/** The revision at which the owner accepted the task, which is the work the projection may read. */
function reviewedRevision(index:LedgerIndex,task:AssessmentTask):{revision:number;order:number}|undefined{
  let found:{revision:number;order:number}|undefined;
  for(let position=0;position<index.records.length;position++){
    const row=index.records[position],value=row.kind==='task'?row.data?.task as AssessmentTask|undefined:undefined;
    if(!row.id||!value||value.id!==task.id||!isSatisfiedTask(value.status))continue;
    if(!found||value.revision>found.revision||(value.revision===found.revision&&position>found.order))found={revision:value.revision,order:position};
  }
  return found;
}
const recordOrder=(index:LedgerIndex):Map<string,number>=>{const order=new Map<string,number>();for(const [position,row] of index.records.entries())if(row.id)order.set(row.id,position);return order;};
/** Claims the review actually accepted: recorded before the reviewed head, latest record per candidate slug. */
function reviewedClaims(claims:ClaimLink[],taskId:string,reviewedOrder:number|undefined,order:Map<string,number>):ClaimLink[]{
  const bySlug=new Map<string,ClaimLink>();
  for(const claim of claims){if(claim.taskRef!==taskId)continue;const position=order.get(claim.record.id!)??Number.MAX_SAFE_INTEGER;if(reviewedOrder!==undefined&&position>=reviewedOrder)continue;bySlug.set(claim.record.data!.candidate as string,claim);}
  return [...bySlug.values()];
}
function deriveAssessment(task:AssessmentTask,claims:ClaimLink[],accepted:CaseView[]):{execution:CoverageExecution;assessment:CoverageAssessment;claimRefs:string[];caseRefs:CoverageCaseRef[];negativeControlRefs:string[];reason:string;limitations:string}{
  const satisfied=isSatisfiedTask(task.status),terminal=terminalState(task);
  if(satisfied){
    const settled=accepted[0];
    if(settled)return {execution:'tested',assessment:'accepted',claimRefs:[],caseRefs:[{caseId:settled.id,revision:settled.revision}],negativeControlRefs:[],reason:`current accepted case ${settled.id}@r${settled.revision} settles this derived cell`,limitations:settled.limitations};
    const confirmed=claims.find(claim=>isConfirmedClaim(claim.record.data??{})),
      ruledOut=claims.find(claim=>isRuledOutClaim(claim.record.data??{})&&claim.negativeControlRefs.length>0),
      // A ruled-out claim with no negative control is not bounded: it stays an open gap instead of reading as a negative result.
      unbounded=claims.find(claim=>isRuledOutClaim(claim.record.data??{})&&!claim.negativeControlRefs.length),
      open=claims.find(claim=>isOpenClaim(claim.record.data??{}))??unbounded;
    if(confirmed)return {execution:'tested',assessment:'confirmed_claim',claimRefs:[confirmed.record.id!],caseRefs:[],negativeControlRefs:[],reason:`reviewed task ${task.id}@r${task.revision} accepted the confirmed worker claim ${confirmed.record.id}`,limitations:confirmed.limitations??task.stopCondition};
    if(ruledOut)return {execution:'tested',assessment:'ruled_out_bounded',claimRefs:[ruledOut.record.id!],caseRefs:[],negativeControlRefs:ruledOut.negativeControlRefs,reason:`reviewed task ${task.id}@r${task.revision} accepted the ruled-out worker claim ${ruledOut.record.id} with its control`,limitations:ruledOut.limitations??task.stopCondition};
    if(open)return {execution:'tested',assessment:'open_gap',claimRefs:[open.record.id!],caseRefs:[],negativeControlRefs:[],reason:unbounded?`reviewed task ${task.id}@r${task.revision} accepted a ruled-out claim ${open.record.id} with no bounded control, so the cell stays an open gap`:`reviewed task ${task.id}@r${task.revision} accepted an open worker claim ${open.record.id}, so the cell stays an open gap`,limitations:open.limitations??task.stopCondition};
    return {execution:'planned',assessment:'unreviewed',claimRefs:[],caseRefs:[],negativeControlRefs:[],reason:`reviewed task ${task.id}@r${task.revision} recorded receipts but no claim or case verdict, so the cell stays untested`,limitations:task.stopCondition};
  }
  if(terminal)return {execution:'blocked',assessment:'open_gap',claimRefs:[],caseRefs:[],negativeControlRefs:[],reason:`task ${task.id}@r${task.revision} ended as ${task.status} without a verdict${task.outcome?`: ${task.outcome}`:''}`,limitations:task.stopCondition};
  return {execution:'planned',assessment:'unreviewed',claimRefs:[],caseRefs:[],negativeControlRefs:[],reason:`task ${task.id}@r${task.revision} is ${task.status}; it is planned but not yet tested`,limitations:task.stopCondition};
}
/** Latest satisfied revision wins per fingerprint; then the newer task revision; then the later ledger row. */
function compareCandidate(a:{satisfied:number;revision:number;order:number},b:{satisfied:number;revision:number;order:number}):number{
  return a.satisfied!==b.satisfied?a.satisfied-b.satisfied:a.revision!==b.revision?a.revision-b.revision:a.order-b.order;
}
/** One projection per read; the same values feed every live plan view and the report. */
export function projectCoverage(index:LedgerIndex,context:CoverageContext):CoverageProjection{
  const tasks=taskFrontier(index),cases=caseViews(index,context),claims=workerClaims(index),order=recordOrder(index),currentTarget=context.targetRevision(),unmapped:UnmappedCoverageTask[]=[],ranked=new Map<string,{cell:ProjectedCoverageCell;satisfied:number;revision:number;order:number}>();
  for(const task of tasks){
    const assets=task.work?.assetRefs??[];
    if(!task.work||!assets.length){unmapped.push({taskId:task.id,revision:task.revision,question:task.question,role:task.role,status:task.status,reason:'no work.assetRefs: the host has no asset identity to place this task in the coverage denominator'});continue;}
    const reviewed=reviewedRevision(index,task),linked=cases.filter(view=>view.reviewStatus!=='withdrawn'&&(view.taskRefs.some(ref=>ref.taskId===task.id)||view.claimRefs.some(id=>{
      const claim=index.byId.get(id);return claim?.kind==='candidate'&&claim.data?.taskRef===task.id;}))),
      accepted=linked.filter(view=>view.reviewStatus==='accepted'),taskClaims=reviewed?reviewedClaims(claims,task.id,reviewed.order,order):[],
      derived=deriveAssessment(task,taskClaims,accepted),evidenceRefs=[...new Set([...task.evidenceIds,...taskClaims.flatMap(claim=>claim.evidenceRefs)])].filter(id=>index.byId.get(id)?.kind==='evidence');
    for(const asset of assets){
      const draft:CoverageCellDraft={assetRef:{...asset},questionKey:task.work.questionKey,...(task.work.policyKey?{policyKey:task.work.policyKey}:{}),actorContext:task.work.actorContext??DEFAULT_ACTOR,tenantContext:task.work.tenantContext??DEFAULT_TENANT,methodFamily:task.work.methodFamily,
        execution:derived.execution,assessment:derived.assessment,taskRefs:[{taskId:task.id,revision:reviewed?.revision??task.revision}],claimRefs:derived.claimRefs,caseRefs:derived.caseRefs,evidenceRefs,negativeControlRefs:derived.negativeControlRefs,gapRefs:[],reason:derived.reason,limitations:derived.limitations??'Derived from reviewed work; no per-cell limitation beyond the cited task and claim was recorded.'},
        fingerprint=coverageFingerprint(currentTarget,draft),candidate={cell:{...draft,fingerprint},satisfied:isSatisfiedTask(task.status)?1:0,revision:task.revision,order:order.get(task.recordId)??0},prior=ranked.get(fingerprint);
      // Latest satisfied revision wins per fingerprint; an older satisfied row is never a second denominator entry.
      if(!prior||compareCandidate(candidate,prior)>0)ranked.set(fingerprint,candidate);
    }
  }
  const cells=[...ranked.values()].map(item=>item.cell),execution:Record<string,number>={},assessment:Record<string,number>={};
  for(const cell of cells){execution[cell.execution]=(execution[cell.execution]??0)+1;assessment[cell.assessment]=(assessment[cell.assessment]??0)+1;}
  return {cells,unmapped,counts:{execution,assessment},warning:projectionWarning(cells.length,unmapped.length)};
}
function projectionWarning(cells:number,unmapped:number):string{
  const base='Coverage is derived from reviewed worker work; no planner-authored cell exists. The denominator is this explicit plan revision; untested, blocked and unmapped work never implies clean.';
  if(!cells)return `${base} no denominator work: no task declares a work identity, so this plan has zero derived cells — that is not clean coverage.`;
  return unmapped?`${base} ${unmapped} task(s) declare no asset reference and are reported as unmapped gaps, never as clean cells.`:base;
}

/** Bounded proof-aware matrix view. Staleness only downgrades; it never upgrades an assessment. */
export function coverageViews(index:LedgerIndex,context:CoverageContext):CoveragePlanView[]{
  const plans=coveragePlans(index),cells=coverageCells(index),tasks=taskFrontier(index),claims=claimHeads(index),cases=caseViews(index,context),caseMap=new Map(cases.map(item=>[item.id,item])),resolved=new Set(index.records.flatMap(row=>row.resolves??[])),currentTarget=context.targetRevision(),projection=plans.some(plan=>plan.derivation==='projected')?projectCoverage(index,context):undefined;
  const cellView=(cell:CoverageCellEntry,plan:CoveragePlanEntry,derived:boolean):CoverageCellView=>{const reasons:string[]=[];let unknown=false;
    if(!derived&&(cell.retired||!plan.cellIds.includes(cell.id)))return {...cell,currentness:'retired',staleReasons:[],effectiveAssessment:cell.assessment,effectiveExecution:cell.execution,reviewed:false};
    if(cell.targetRevision!==currentTarget)reasons.push(`stale-target:${cell.targetRevision}->${currentTarget}`);const asset=context.assetRevision?.(cell.assetRef.id);if(!context.assetRevision)unknown=true;else if(asset===undefined)reasons.push(`missing-asset:${cell.assetRef.id}`);else if(cell.assetRef.revision===undefined)reasons.push(`unpinned-asset:${cell.assetRef.id}`);else if(asset!==cell.assetRef.revision)reasons.push(`stale-asset:${cell.assetRef.id}@r${cell.assetRef.revision}->r${asset}`);
    for(const ref of cell.taskRefs){const task=taskAt(index,ref.taskId,ref.revision),head=tasks.find(item=>item.id===ref.taskId);if(!task)reasons.push(`missing-task:${ref.taskId}@r${ref.revision??'?'}`);else if(head&&taskReferenceSuperseded(index,ref.taskId,ref.revision))reasons.push(`superseded-task:${ref.taskId}@r${ref.revision}`);}
    for(const id of cell.claimRefs){const claim=index.byId.get(id),key=claim?.data?.candidate;if(claim?.kind!=='candidate'||typeof key!=='string')reasons.push(`missing-claim:${id}`);else if(claims.get(key)?.id!==id)reasons.push(`superseded-claim:${id}`);}
    for(const ref of cell.caseRefs){const item=caseMap.get(ref.caseId);if(!item)reasons.push(`missing-case:${ref.caseId}`);else if(item.revision!==ref.revision)reasons.push(`superseded-case:${ref.caseId}@r${ref.revision}`);else if(item.currentness!=='current')reasons.push(`stale-case:${ref.caseId}`);}
    for(const id of [...cell.evidenceRefs,...cell.negativeControlRefs])if(index.byId.get(id)?.kind!=='evidence')reasons.push(`missing-evidence:${id}`);
    for(const id of cell.gapRefs)if(index.byId.get(id)?.kind!=='open')reasons.push(`missing-gap:${id}`);else if(resolved.has(id))reasons.push(`resolved-gap-pin:${id}`);
    // M5: a task that ended without a verdict cannot carry the verdict its cell asserts. Downgrade to an attempt, keep it in the backlog,
    // and say which task did it, so the lead can re-dispatch instead of reading the direction as closed.
    const interrupted=interruptedVerdict(index,cell);
    if(interrupted)reasons.push(`interrupted-task:${interrupted.taskId}:${interrupted.state}`);
    const currentness=reasons.length?'stale':unknown?'unknown':'current',
      reviewed=!interrupted&&currentness==='current'&&cell.assessment==='accepted'&&cell.caseRefs.some(ref=>{const item=caseMap.get(ref.caseId);return item?.revision===ref.revision&&item.reviewStatus==='accepted';});
    return {...cell,currentness,staleReasons:[...new Set(reasons)].slice(0,40),
      effectiveAssessment:interrupted?'open_gap':currentness==='stale'?'stale':cell.assessment,
      effectiveExecution:interrupted?'attempted':cell.execution,reviewed};};
  return plans.map(plan=>{const derived=plan.derivation==='projected',
    entries:CoverageCellEntry[]=derived?projection!.cells.map(cell=>({...cell,id:`coverage-cell-${cell.fingerprint.slice(0,24)}`,runId:plan.runId,revision:1,recordId:`derived-${cell.fingerprint.slice(0,32)}`,planId:plan.id,planRevision:plan.revision,targetRevision:plan.targetRevision,retired:false})):
      plan.cellIds.map(id=>cells.find(cell=>cell.id===id)).filter((cell):cell is CoverageCellEntry=>Boolean(cell)),
    selected=entries.map(cell=>cellView(cell,plan,derived)),execution:Record<string,number>={},assessment:Record<string,number>={};
    for(const cell of selected){execution[cell.effectiveExecution]=(execution[cell.effectiveExecution]??0)+1;assessment[cell.effectiveAssessment]=(assessment[cell.effectiveAssessment]??0)+1;}
    const planned=new Set(selected.map(cell=>cell.assetRef.id)),all=context.assetIds?.(),discoveredUnplannedAssets=all?new Set(all.filter(id=>!planned.has(id))).size:0,unmapped=derived?projection!.unmapped:[];
    return {...plan,cells:selected,counts:{execution,assessment,stale:selected.filter(cell=>cell.currentness==='stale').length,reviewed:selected.filter(cell=>cell.reviewed).length},discoveredUnplannedAssets,omittedCells:derived?0:Math.max(0,plan.cellIds.length-selected.length),unmapped,unmappedCount:unmapped.length,
      warning:derived?projection!.warning:'Coverage denominator is this explicit plan revision. Blocked/untested/unplanned cells and discovered assets never imply clean; case review never completes a goal.'};});
}

export function boundCoverageRequest(action:string,input:unknown,request:MutationRequest):MutationRequest{if(request.actorId!=='owner')throw Error('Coverage mutations require host-bound owner attribution');return {...request,payload:{kind:'coverage-mutation',action,input,submitted:request.payload}};}

/** Canonical owner matrix service. Records and tasks remain the only writable sources; no execution queue. */
export class CoverageBoard extends LedgerBoard{
  constructor(runId:string,path:string,active:()=>boolean,private context:CoverageContext,private now=()=>Date.now()){super(runId,path,active,'Coverage','Coverage');}
  private mutate<T>(work:(index:LedgerIndex,plans:CoveragePlanEntry[])=>Promise<T>):Promise<T>{return this.serialized(index=>work(index,coveragePlans(index)));}
  private planTransitions(previous:string,next:string):boolean{return ({draft:['draft','active','cancelled'],active:['active','reviewed','closed','cancelled'],reviewed:['active','reviewed','closed'],closed:[],cancelled:[]} as Record<string,string[]>)[previous]?.includes(next)??false;}
  private async write(records:()=>AssessmentRecord[],request?:MutationRequest):Promise<RecordAck[]>{this.gate();return request?appendGeneratedRecords(this.path,records,request):appendRecords(this.path,records());}
  private retained(request:MutationRequest|undefined){return request?readGeneratedRecords(this.path,request):Promise.resolve(undefined);}
  private async retainedPlan(acks:RecordAck[]):Promise<CoveragePlanEntry>{const index=await readLedger(this.path,this.runId),row=index.byId.get(acks[0].recordId);if(!index.complete||!row?.data?.coveragePlan)throw Error('Retained coverage plan detail unavailable');return validateStoredCoveragePlan(row.data.coveragePlan,row.id!);}
  /** A3: the plan is the planner's only coverage write; its denominator is derived, so no cell identity can be submitted. */
  async createPlan(value:CoveragePlanDraft,request?:MutationRequest):Promise<CoveragePlanEntry>{const input=validateCoveragePlanDraft(value),bound=request?boundCoverageRequest('plan-create',value,request):undefined,prior=await this.retained(bound);if(prior)return this.retainedPlan(prior);return this.mutate(async(_index,plans)=>{const id=input.id??`coverage-plan-${randomUUID()}`;if(plans.some(plan=>plan.id===id))throw Error('Duplicate coverage plan');if(plans.filter(plan=>!['closed','cancelled'].includes(plan.status)).length>=10)throw Error('Live coverage plan limit reached (10)');if(!['draft','active'].includes(input.status))throw Error('Create coverage plans as draft/active; review/close needs a revision');const stored={...input,id,runId:this.runId,revision:1,targetRevision:this.context.targetRevision(),cellIds:[],derivation:'projected' as const},make=()=>{const recordId=randomUUID();return [{id:recordId,runId:this.runId,at:new Date(this.now()).toISOString(),by:'owner',kind:'note' as const,text:`coverage plan ${id}@r1: ${input.status}; denominator derived from reviewed work, not assessment completion`,data:{coveragePlan:stored}}];},acks=await this.write(make,bound),index=await readLedger(this.path,this.runId);return validateStoredCoveragePlan(index.byId.get(acks[0].recordId)!.data!.coveragePlan,acks[0].recordId);});}
  async revisePlan(id:string,revision:number,value:CoveragePlanDraft,request?:MutationRequest):Promise<CoveragePlanEntry>{const input=validateCoveragePlanDraft(value),bound=request?boundCoverageRequest('plan-revise',{id,revision,input},request):undefined,prior=await this.retained(bound);if(prior)return this.retainedPlan(prior);return this.mutate(async(index,plans)=>{const old=plans.find(plan=>plan.id===id);if(!old||old.revision!==revision)throw Error('Missing or stale coverage plan revision');if(input.id&&input.id!==id)throw Error('Cannot change coverage plan identity');if(!this.planTransitions(old.status,input.status))throw Error('Invalid coverage plan transition');
    // A3: a legacy plan still owes its stored denominator; a projected plan owes a derived one (a plan with no work cannot be reviewed).
    if((COVERAGE_PLAN_REVIEWED as readonly string[]).includes(input.status)&&(old.derivation==='projected'?!projectCoverage(index,this.context).cells.length:!old.cellIds.length))throw Error('Reviewed/closed coverage plan needs at least one denominator cell; no task declares a work identity, so there is no coverage work to review yet');
    const stored={...input,id,runId:this.runId,revision:old.revision+1,targetRevision:old.targetRevision,cellIds:old.cellIds,...(old.derivation?{derivation:old.derivation}:{})},make=()=>[{id:randomUUID(),runId:this.runId,at:new Date(this.now()).toISOString(),by:'owner',kind:'note' as const,text:`coverage plan ${id}@r${stored.revision}: ${input.status}; denominator ${old.derivation==='projected'?'derived from reviewed work':old.cellIds.length}, not whole-target safety`,supersedes:old.recordId,data:{coveragePlan:stored}}],acks=await this.write(make,bound),index2=await readLedger(this.path,this.runId);return validateStoredCoveragePlan(index2.byId.get(acks[0].recordId)!.data!.coveragePlan,acks[0].recordId);});}
  async list():Promise<CoveragePlanView[]>{const index=await readLedger(this.path,this.runId);if(!index.complete)throw Error('Coverage reconciliation incomplete');return coverageViews(index,this.context);}
}
