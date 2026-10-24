import { randomUUID } from 'node:crypto';
import { appendRecords, appendGeneratedRecords, ownerNoteFrontier, readLedger, type LedgerIndex } from './records.js';
import type { MutationRequest } from './state/store.js';
import { redact } from './evidence.js';
import { exact, plain, TEXT_CONTROL } from './validate.js';
import { LedgerBoard } from './board.js';
import { capabilityList, type Capability } from './capabilities.js';
import { isEnvironmentId } from './lab.js';
import { goalProofRefusal, proofData, type GoalProof } from './goal-proof.js';
import { defaultRoute, routeSlug } from './routes.js';
import { taskFrontier } from './tasks.js';
import { claimHeadClaims } from './chain-view.js';
import type { PhasePacket } from './phase.js';

export const PLAN_KINDS=['goal','todo','decision'] as const;
export const PLAN_DISPOSITIONS=['new','reuse','refine','validate','retest','defer'] as const;
export type PlanKind=typeof PLAN_KINDS[number];
export interface PlanDecision { disposition:typeof PLAN_DISPOSITIONS[number]; chosenTaskIds:string[]; deferredTaskIds:string[]; revisitCondition?:string }
export interface PlanDraft {
  id?:string; kind:PlanKind; title:string; status:string; reason:string; criteria?:string[]; exclusions?:string[];
  taskIds?:string[]; goalIds?:string[]; supportRefs?:string[]; decision?:PlanDecision;
  /** P16.1: what settles this goal. A goal is a promise about the target; `reviewed`/`closed` needs this to hold. */
  proof?:GoalProof;
  /** P16.5: the mechanism family this step tries (`upload`, `auth`, `sqli`, …); defaults to the method family of what it cites. */
  route?:string;
  /** M1: the same-run candidate records this row stands on. A chain step must cite at least one; other todos may. */
  claimRefs?:string[];
  /** M1: typed capabilities this step consumes. Readiness is derived from what earlier steps' claims gain. */
  needs?:Capability[];
  /** M1: the recorded environment this step runs in, so replay travels with the plan row. */
  environmentRef?:string;
  /** M1: chain identity shared by its steps, and this row's 1-based position in it. */
  chainOf?:string; step?:number;
}
export interface PlanEntry extends PlanDraft { id:string; runId:string; revision:number; recordId:string }
/** Goal vocabulary, distinct from tasks and coverage plans. */
const GOAL_SETTLED=['reviewed','closed'] as const;
const statuses:Record<PlanKind,readonly string[]>={goal:['proposed','active','reviewed','closed','blocked','cancelled'],todo:['open','in-progress','done','deferred','blocked','cancelled'],decision:['recorded','withdrawn']};
const transitions:Record<PlanKind,Record<string,string[]>>={
  goal:{proposed:['active','blocked','cancelled'],active:['reviewed','blocked','cancelled'],reviewed:['closed','active','blocked'],closed:[],blocked:['active','cancelled'],cancelled:[]},
  todo:{open:['in-progress','done','deferred','blocked','cancelled'],'in-progress':['done','deferred','blocked','cancelled'],done:['open'],deferred:['open','cancelled'],blocked:['open','cancelled'],cancelled:[]},
  decision:{recorded:['withdrawn'],withdrawn:[]},
};
function text(value:unknown,label:string,max:number,min=5):string{
  if(typeof value!=='string'||value.trim().length<min||value.length>max||TEXT_CONTROL.test(value))throw Error(`Invalid plan ${label}`);return redact(value);
}
function id(value:unknown,label='ID'):string{if(typeof value!=='string'||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value))throw Error(`Invalid plan ${label}`);return value;}
function list(value:unknown,label:string,max=10,minimum=0):string[]{
  if(value===undefined&&minimum===0)return[];if(!Array.isArray(value)||value.length<minimum||value.length>max)throw Error(`Invalid plan ${label}`);
  const result=value.map(item=>id(item,label));if(new Set(result).size!==result.length)throw Error(`Duplicate plan ${label}`);return result;
}
function linkEnvironment(value:unknown):string{
  if(!isEnvironmentId(value))throw Error('Invalid plan environment');return value;
}
function proseList(value:unknown,label:string):string[]{
  if(value===undefined)return[];if(!Array.isArray(value))throw Error(`Invalid plan ${label}`);return value.map(item=>text(item,label,500,5));
}
function goalProof(value:unknown):GoalProof{
  const row=plain(value,'goal proof');exact(row,['kind','capability','ref'],'Goal proof');
  if(row.kind==='capability'){
    if(row.capability===undefined||row.ref!==undefined)throw Error('Goal proof kind=capability needs a capability and no ref');
    return {kind:'capability',capability:capabilityList([row.capability],'goal proof capability')[0]!};
  }
  if(row.kind==='case'||row.kind==='coverage'){
    if(typeof row.ref!=='string'||row.capability!==undefined)throw Error(`Goal proof kind=${row.kind} needs a ref and no capability`);
    return {kind:row.kind,ref:id(row.ref,'proof reference')};
  }
  throw Error('Goal proof kind must be capability, case or coverage');
}
export function validatePlanDraft(value:unknown):PlanDraft{
  const row=plain(value,'plan entry');exact(row,['id','kind','title','status','reason','criteria','exclusions','taskIds','goalIds','supportRefs','decision','proof','route','claimRefs','needs','environmentRef','chainOf','step'],'Plan entry');
  if(typeof row.kind!=='string'||!(PLAN_KINDS as readonly string[]).includes(row.kind))throw Error('Invalid plan kind');const kind=row.kind as PlanKind;
  if(typeof row.status!=='string'||!statuses[kind].includes(row.status))throw Error('Invalid plan status');
  const result:PlanDraft={kind,title:text(row.title,'title',500),status:row.status,reason:text(row.reason,'reason',1000,10),
    criteria:proseList(row.criteria,'criteria'),exclusions:proseList(row.exclusions,'exclusions'),taskIds:list(row.taskIds,'task ID'),goalIds:list(row.goalIds,'goal ID'),supportRefs:list(row.supportRefs,'support reference')};
  if(row.id!==undefined)result.id=id(row.id);
  // M1: one link vocabulary on the plan board; the fields only exist on a todo, and a chain step always carries both the
  // chain and its position, so a reader never has to guess which group a numbered row belongs to.
  const linkFields=kind==='todo';
  if(!linkFields&&['claimRefs','needs','environmentRef','chainOf','step','route'].some(key=>row[key]!==undefined))throw Error('Only a todo holds a chain link');
  if(linkFields){
    result.claimRefs=list(row.claimRefs,'claim reference',Number.MAX_SAFE_INTEGER);
    if(row.needs!==undefined)result.needs=capabilityList(row.needs,'Plan needs');
    if(row.route!==undefined)result.route=routeSlug(row.route);
    if(row.environmentRef!==undefined)result.environmentRef=linkEnvironment(row.environmentRef);
    const hasChain=row.chainOf!==undefined,hasStep=row.step!==undefined;
    if(hasChain!==hasStep)throw Error('A chain step needs both chainOf and step');
    if(hasChain){
      result.chainOf=id(row.chainOf,'chain ID');
      if(!Number.isSafeInteger(row.step)||(row.step as number)<1)throw Error('Invalid plan step');
      result.step=row.step as number;
      if(!result.claimRefs.length)throw Error('CHAIN_LINEAGE: a chain step must cite the claim it consumes (claimRefs); a plan row with no lineage cannot hold a link');
    }
  }
  if(kind==='goal'&&!result.criteria?.length)throw Error('Goal needs bounded acceptance criteria');
  // P16.1: a goal states how it will be proved before it is created, so "assess the surface" cannot become a goal that is
  // settled by writing a summary.
  if(kind==='goal'){
    if(row.proof===undefined)throw Error('GOAL_UNPROVEN: a goal needs proof (capability, case or coverage); name what would settle it');
    result.proof=goalProof(row.proof);
  } else if(row.proof!==undefined)throw Error('Only a goal carries proof');
  if(kind!=='goal'&&(result.criteria!.length||result.exclusions!.length))throw Error('Only goals define criteria/exclusions');
  if(kind==='decision'){
    if(!row.decision||typeof row.decision!=='object'||Array.isArray(row.decision)||Object.getPrototypeOf(row.decision)!==Object.prototype)throw Error('Decision entry needs a structured disposition');const d=row.decision as Record<string,unknown>;
    if(Object.keys(d).some(key=>!['disposition','chosenTaskIds','deferredTaskIds','revisitCondition'].includes(key))||typeof d.disposition!=='string'||!(PLAN_DISPOSITIONS as readonly string[]).includes(d.disposition))throw Error('Invalid plan decision');
    result.decision={disposition:d.disposition as PlanDecision['disposition'],chosenTaskIds:list(d.chosenTaskIds,'chosen task ID'),deferredTaskIds:list(d.deferredTaskIds,'deferred task ID'),...(d.revisitCondition!==undefined?{revisitCondition:text(d.revisitCondition,'revisit condition',500,5)}:{})};
    // M7: a condition-bounded revisit is a decision about time, not about a task, so a revisit condition can stand alone.
    if(!result.decision.chosenTaskIds.length&&!result.decision.deferredTaskIds.length&&!result.decision.revisitCondition)throw Error('Decision needs a chosen or deferred task reference');
  } else if(row.decision!==undefined)throw Error('Only a decision entry may contain a disposition');
  return result;
}
/** Bind every logical field even if a trusted caller supplies a generic transport payload. */
export function boundPlanRequest(action:'create'|'revise',input:PlanDraft,request:MutationRequest,id?:string,revision?:number):MutationRequest{
  if(request.actorId!=='owner')throw Error('Plan mutations require host-bound owner attribution');
  return {...request,payload:{kind:'plan-entry',action,input,id,revision,submitted:request.payload}};
}
function storedPlan(value:unknown,recordId:string):PlanEntry{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid stored plan');
  const plan=value as unknown as PlanEntry,{runId:_runId,revision:_revision,recordId:_recordId,...input}=plan,draft=validatePlanDraft(input);
  if(typeof plan.revision!=='number'||!Number.isSafeInteger(plan.revision)||plan.revision<1||!plan.id)throw Error('Invalid stored plan');
  return {...draft,id:plan.id,runId:plan.runId,revision:plan.revision,recordId};
}
export const planFrontier=(index:LedgerIndex):PlanEntry[]=>ownerNoteFrontier(index,'plan',storedPlan);
export function phasePackets(index:LedgerIndex):PhasePacket[]{
  const rows:PhasePacket[]=[];for(const row of index.records){const phase=row.kind==='note'&&row.by==='owner'&&!row.workerId?row.data?.phase:undefined;if(!phase||typeof phase!=='object'||Array.isArray(phase))continue;const p=phase as unknown as PhasePacket;
    if(p.version===1&&typeof p.id==='string'&&p.id===row.id&&p.reviewStatus==='pending'&&['reported','blocked'].includes(p.delivery))rows.push(p);}
  return rows;
}

/** Durable owner-authored planning over the canonical record backend; never a second task queue. */
export class PlanBoard extends LedgerBoard{
  constructor(runId:string,path:string,active:()=>boolean,private now=()=>Date.now()){super(runId,path,active,'Plan','Plan');}
  private mutate<T>(work:(index:LedgerIndex,plans:PlanEntry[])=>Promise<T>):Promise<T>{return this.serialized(index=>work(index,planFrontier(index)));}
  private references(draft:PlanDraft,index:LedgerIndex,plans:PlanEntry[]):void{
    const tasks=taskFrontier(index);for(const taskId of draft.taskIds??[])if(!tasks.some(task=>task.id===taskId))throw Error(`Unknown plan task ${taskId}`);
    for(const goalId of draft.goalIds??[])if(!plans.some(plan=>plan.id===goalId&&plan.kind==='goal'))throw Error(`Unknown plan goal ${goalId}`);
    const edges=new Map(plans.map(plan=>[plan.id,plan.goalIds??[]]));if(draft.id)edges.set(draft.id,draft.goalIds??[]);
    const visiting=new Set<string>(),visited=new Set<string>();const visit=(key:string)=>{if(visiting.has(key))throw Error('Plan goal cycle');if(visited.has(key))return;visiting.add(key);for(const parent of edges.get(key)??[])visit(parent);visiting.delete(key);visited.add(key);};if(draft.id)visit(draft.id);
    for(const ref of draft.supportRefs??[])if(index.byId.get(ref)?.kind!=='evidence'||index.byId.get(ref)?.runId!==this.runId)throw Error(`Plan support ${ref} is not same-run evidence`);
    for(const taskId of [...(draft.decision?.chosenTaskIds??[]),...(draft.decision?.deferredTaskIds??[])])if(!tasks.some(task=>task.id===taskId))throw Error(`Unknown decision task ${taskId}`);
    // M1: lineage is a same-run candidate record, so the chain board can resolve a step's needs against what that claim gains.
    for(const ref of draft.claimRefs??[])if(index.byId.get(ref)?.kind!=='candidate'||index.byId.get(ref)?.runId!==this.runId)throw Error(`Unknown plan claim ${ref}: a claim reference must be a same-run candidate record`);
    if(draft.chainOf&&draft.step!==undefined){
      // One row per position: two rows claiming step 2 of the same chain would make readiness ambiguous.
      const clash=plans.find(plan=>plan.id!==draft.id&&plan.chainOf===draft.chainOf&&plan.step===draft.step);
      if(clash)throw Error(`Duplicate chain step ${draft.step} in ${draft.chainOf}`);
    }
  }
  private async write(make:()=>{draft:PlanDraft;revision:number;previous?:PlanEntry},request?:MutationRequest):Promise<PlanEntry>{
    const makeRecords=()=>{this.gate();const {draft,revision,previous}=make(),idValue=draft.id!,recordId=randomUUID(),at=new Date(this.now()).toISOString(),plan={...draft,id:idValue,runId:this.runId,revision};
      return [{id:recordId,runId:this.runId,at,by:'owner',kind:'note' as const,text:`${draft.kind} ${idValue}@r${revision}: ${draft.status}; ${draft.reason}`,supersedes:previous?.recordId,refs:draft.supportRefs?.slice(0,10),data:{plan}}];};
    const acks=request?await appendGeneratedRecords(this.path,makeRecords,request):await appendRecords(this.path,makeRecords()),index=await readLedger(this.path,this.runId),row=index.byId.get(acks[0].recordId);
    if(!index.complete||!row?.data?.plan)throw Error('Plan ACK retained but detail unavailable; inspect retained state without replay');
    return {...row.data.plan as unknown as PlanEntry,recordId:row.id!};
  }
  create(input:PlanDraft,request?:MutationRequest):Promise<PlanEntry>{const draft=validatePlanDraft(input);return this.mutate((index,plans)=>this.write(()=>{
    const generated=draft.id??`${draft.kind}-${randomUUID()}`,value={...draft,id:generated};if(plans.some(plan=>plan.id===generated))throw Error('Duplicate plan identity');
    // P16.5: a todo always states its route; when the lead did not name one, the method family of what it cites does.
    if(value.kind==='todo'&&!value.route)value.route=defaultRoute(value,claimHeadClaims(index));
    this.references(value,index,plans);if(value.kind==='goal'&&(GOAL_SETTLED as readonly string[]).includes(value.status))throw Error('Create goals proposed/active; review and close need explicit revisions');return {draft:value,revision:1};
  },request?boundPlanRequest('create',input,request):undefined));}
  revise(idValue:string,revision:number,input:PlanDraft,request?:MutationRequest):Promise<PlanEntry>{const draft=validatePlanDraft(input);return this.mutate((index,plans)=>this.write(()=>{
    const old=plans.find(plan=>plan.id===idValue);if(!old||old.revision!==revision)throw Error('Missing or stale plan revision');if(draft.id&&draft.id!==idValue||draft.kind!==old.kind)throw Error('Cannot change plan identity/kind');
    if(!transitions[old.kind][old.status]?.includes(draft.status))throw Error('Invalid plan transition');const value={...draft,id:idValue};
    if(value.kind==='todo'&&!value.route)value.route=defaultRoute(value,claimHeadClaims(index));this.references(value,index,plans);
    if(value.kind==='goal'&&(GOAL_SETTLED as readonly string[]).includes(value.status)){
      if(!value.supportRefs?.length)throw Error('Reviewed/closed goal needs same-run support references');
      // P16.1: status is a statement about the run; the proof is a statement about the target. Both have to hold.
      const refusal=goalProofRefusal(value.proof!,proofData(index));if(refusal)throw Error(refusal);
    }
    return {draft:value,revision:old.revision+1,previous:old};
  },request?boundPlanRequest('revise',input,request,idValue,revision):undefined));}
  async list():Promise<PlanEntry[]>{const index=await readLedger(this.path,this.runId);if(!index.complete)throw Error('Plan reconciliation incomplete');return planFrontier(index);}
}

