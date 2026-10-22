import { randomUUID } from 'node:crypto';
import { appendRecords, appendGeneratedRecords, ownerNoteFrontier, readLedger, type LedgerIndex } from './records.js';
import type { MutationRequest } from './state/store.js';
import { redact } from './evidence.js';
import { exact, plain, TEXT_CONTROL } from './validate.js';
import { LedgerBoard } from './board.js';
import { taskFrontier } from './tasks.js';
import type { PhasePacket } from './phase.js';

export const PLAN_KINDS=['goal','todo','decision'] as const;
export const PLAN_DISPOSITIONS=['new','reuse','refine','validate','retest','defer'] as const;
export type PlanKind=typeof PLAN_KINDS[number];
export interface PlanDecision { disposition:typeof PLAN_DISPOSITIONS[number]; chosenTaskIds:string[]; deferredTaskIds:string[]; revisitCondition?:string }
export interface PlanDraft {
  id?:string; kind:PlanKind; title:string; status:string; reason:string; criteria?:string[]; exclusions?:string[];
  taskIds?:string[]; goalIds?:string[]; supportRefs?:string[]; decision?:PlanDecision;
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
function proseList(value:unknown,label:string):string[]{
  if(value===undefined)return[];if(!Array.isArray(value)||value.length>10)throw Error(`Invalid plan ${label}`);return value.map(item=>text(item,label,500,5));
}
export function validatePlanDraft(value:unknown):PlanDraft{
  const row=plain(value,'plan entry');exact(row,['id','kind','title','status','reason','criteria','exclusions','taskIds','goalIds','supportRefs','decision'],'Plan entry');
  if(typeof row.kind!=='string'||!(PLAN_KINDS as readonly string[]).includes(row.kind))throw Error('Invalid plan kind');const kind=row.kind as PlanKind;
  if(typeof row.status!=='string'||!statuses[kind].includes(row.status))throw Error('Invalid plan status');
  const result:PlanDraft={kind,title:text(row.title,'title',500),status:row.status,reason:text(row.reason,'reason',1000,10),
    criteria:proseList(row.criteria,'criteria'),exclusions:proseList(row.exclusions,'exclusions'),taskIds:list(row.taskIds,'task ID'),goalIds:list(row.goalIds,'goal ID'),supportRefs:list(row.supportRefs,'support reference')};
  if(row.id!==undefined)result.id=id(row.id);
  if(kind==='goal'&&!result.criteria?.length)throw Error('Goal needs bounded acceptance criteria');
  if(kind!=='goal'&&(result.criteria!.length||result.exclusions!.length))throw Error('Only goals define criteria/exclusions');
  if(kind==='decision'){
    if(!row.decision||typeof row.decision!=='object'||Array.isArray(row.decision)||Object.getPrototypeOf(row.decision)!==Object.prototype)throw Error('Decision entry needs a structured disposition');const d=row.decision as Record<string,unknown>;
    if(Object.keys(d).some(key=>!['disposition','chosenTaskIds','deferredTaskIds','revisitCondition'].includes(key))||typeof d.disposition!=='string'||!(PLAN_DISPOSITIONS as readonly string[]).includes(d.disposition))throw Error('Invalid plan decision');
    result.decision={disposition:d.disposition as PlanDecision['disposition'],chosenTaskIds:list(d.chosenTaskIds,'chosen task ID'),deferredTaskIds:list(d.deferredTaskIds,'deferred task ID'),...(d.revisitCondition!==undefined?{revisitCondition:text(d.revisitCondition,'revisit condition',500,5)}:{})};
    if(!result.decision.chosenTaskIds.length&&!result.decision.deferredTaskIds.length)throw Error('Decision needs a chosen or deferred task reference');
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
    if(value.kind!=='decision'&&plans.filter(plan=>plan.kind!=='decision'&&!['closed','done','cancelled'].includes(plan.status)).length>=100)throw Error('Live goal/todo frontier limit reached (100); review/close or cancel retained entries');
    this.references(value,index,plans);if(value.kind==='goal'&&(GOAL_SETTLED as readonly string[]).includes(value.status))throw Error('Create goals proposed/active; review and close need explicit revisions');return {draft:value,revision:1};
  },request?boundPlanRequest('create',input,request):undefined));}
  revise(idValue:string,revision:number,input:PlanDraft,request?:MutationRequest):Promise<PlanEntry>{const draft=validatePlanDraft(input);return this.mutate((index,plans)=>this.write(()=>{
    const old=plans.find(plan=>plan.id===idValue);if(!old||old.revision!==revision)throw Error('Missing or stale plan revision');if(draft.id&&draft.id!==idValue||draft.kind!==old.kind)throw Error('Cannot change plan identity/kind');
    if(!transitions[old.kind][old.status]?.includes(draft.status))throw Error('Invalid plan transition');const value={...draft,id:idValue};this.references(value,index,plans);
    if(old.kind==='todo'&&old.status==='done'&&plans.filter(plan=>plan.kind!=='decision'&&!['closed','done','cancelled'].includes(plan.status)).length>=100)throw Error('Live goal/todo frontier limit reached (100); cannot reopen retained todo');
    if(value.kind==='goal'&&(GOAL_SETTLED as readonly string[]).includes(value.status)&&!value.supportRefs?.length)throw Error('Reviewed/closed goal needs same-run support references');return {draft:value,revision:old.revision+1,previous:old};
  },request?boundPlanRequest('revise',input,request,idValue,revision):undefined));}
  async list():Promise<PlanEntry[]>{const index=await readLedger(this.path,this.runId);if(!index.complete)throw Error('Plan reconciliation incomplete');return planFrontier(index);}
}

