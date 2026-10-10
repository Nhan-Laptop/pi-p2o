import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AssessmentStore, type StoreFault } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { PlanBoard, planFrontier, validatePlanDraft, type PlanDraft } from '../../src/planning.js';
import { readLedger } from '../../src/records.js';
import { parseStateCommand, stateLines } from '../../src/ui/state.js';
import { planParameters } from '../../src/work-tool.js';
import { TaskBoard, type TaskDraft } from '../../src/tasks.js';

const runId='run-plan',goal:PlanDraft={kind:'goal',title:'Inspect one declared inert boundary',status:'active',reason:'Bounded local planning fixture, not finding verification',criteria:['Attribution and control must be reviewed'],exclusions:['No live target or provider'],supportRefs:[]};
const draft:TaskDraft={id:'task-inert',question:'Which inert observation reaches the consumer?',surface:'fixture',risk:'boundary',role:'general',roleReason:'Single offline fixture question',expectedTrue:'Declared fixture observation reaches the consumer',expectedFalse:'Control fixture does not reach the consumer',stopCondition:'Stop after this bounded fixture question',evidenceIds:[],prerequisites:[],method:{skills:[],reason:'One inert observation, not live assessment'}};
async function fixture(work:(h:{root:string;store:AssessmentStore;board:PlanBoard;tasks:TaskBoard;path:string;setActive:(active:boolean)=>void})=>Promise<void>,fault?:StoreFault){
  const root=await mkdtemp(join(tmpdir(),'p2o-plan-')),store=AssessmentStore.create(root,{runId,retention:'durable-local',targetKind:'directory',targetIdentity:'inert',targetDisplay:'inert',profile:{runtimeHash:'inert',image:'inert',loopMode:'manual',executorMode:'shared'}},{fault}),path=join(root,'alias.sqlite'),unbind=bindAssessmentStore(path,store);
  let active=true;const board=new PlanBoard(runId,path,()=>active),tasks=new TaskBoard(runId,path,()=>active);
  try{await work({root,store,board,tasks,path,setActive:value=>{active=value;}});}finally{unbind();store.close();await rm(root,{recursive:true,force:true});}
}

describe('canonical goals/todo/decisions and read-only cards (K4)',()=>{
  it('uses a root-object tool schema and refuses unknown/authority-bearing entry fields',()=>{
    expect(planParameters.type).toBe('object');expect(planParameters.required).toContain('action');expect(planParameters.properties).toHaveProperty('entry');
    expect(()=>validatePlanDraft({...goal,scope:'outside'})).toThrow('host-owned');expect(()=>validatePlanDraft({...goal,criteria:[]})).toThrow('criteria');
    expect(()=>validatePlanDraft({kind:'todo',title:'one todo',status:'closed',reason:'Explicit local fixture reason'})).toThrow('status');
  });
  it('retains owner revisions on the same record backend, with task/goal references and decision events',async()=>fixture(async({board,tasks,store,path})=>{
    const task=await tasks.create(draft),created=await board.create(goal),todo=await board.create({kind:'todo',title:'Review the retained boundary receipt',status:'open',reason:'The owner needs to review this one task',taskIds:[task.id],goalIds:[created.id]});
    const decision=await board.create({kind:'decision',title:'Defer a task pending source evidence',status:'recorded',reason:'No accepted prerequisite evidence exists yet',taskIds:[task.id],goalIds:[created.id],decision:{disposition:'defer',chosenTaskIds:[],deferredTaskIds:[task.id],revisitCondition:'A fresh same-run receipt is reviewed'}});
    expect(planFrontier(await readLedger(path))).toHaveLength(3);expect(store.events({limit:100}).rows.filter(row=>row.kind==='decision.committed')).toHaveLength(1);
    const revised=await board.revise(todo.id,todo.revision,{kind:'todo',title:todo.title,status:'in-progress',reason:'Owner is inspecting the existing receipt now',taskIds:[task.id],goalIds:[created.id]});expect(revised.revision).toBe(2);
    expect(store.records().filter(row=>row.data?.plan&&(row.data.plan as {id:string}).id===todo.id)).toHaveLength(2);
    expect((await tasks.list())[0].status).toBe('proposed');expect(decision.decision!.disposition).toBe('defer');
  }));
  it('requires explicit evidence-backed goal review/close and preserves no execution authority',async()=>fixture(async({board,store})=>{
    const created=await board.create(goal);await expect(board.revise(created.id,1,{...goal,status:'reviewed'})).rejects.toThrow('support');
    await expect(board.create({...goal,status:'closed'})).rejects.toThrow('explicit revisions');
    const ref=store.commitRecords([{runId,by:'owner',at:'2030',kind:'evidence',text:'Inert receipt, not a verified finding'}])[0].recordId;
    const reviewed=await board.revise(created.id,1,{...goal,status:'reviewed',supportRefs:[ref]}),closed=await board.revise(reviewed.id,reviewed.revision,{...goal,status:'closed',supportRefs:[ref]});
    expect(closed.status).toBe('closed');expect(store.events({limit:100}).rows.filter(row=>row.kind.startsWith('operation.'))).toEqual([]);
    const cp=store.checkpoint('planning only');expect(cp.planning).toMatchObject({goals:1,todo:0,decisions:0,phasePackets:0});expect(store.inspectCheckpoint(cp.id).authorityRestored).toBe(false);
  }));
  it('rejects stale revisions, unknown references, cycles and foreign support',async()=>fixture(async({board,store})=>{
    const a=await board.create({...goal,id:'goal-a'}),b=await board.create({...goal,id:'goal-b',goalIds:[a.id]});
    await expect(board.revise(a.id,1,{...goal,goalIds:[b.id],status:'blocked'})).rejects.toThrow('cycle');
    await expect(board.revise(a.id,99,{...goal,status:'blocked'})).rejects.toThrow('stale');
    await expect(board.create({...goal,taskIds:['missing']})).rejects.toThrow('Unknown plan task');
    await expect(board.create({...goal,supportRefs:['foreign-receipt']})).rejects.toThrow('same-run evidence');
    expect(store.records().filter(row=>row.data?.plan)).toHaveLength(2);
  }));
  it('atomically refuses two independent revisions of the same head',async()=>fixture(async({board,store,path})=>{
    const a=await board.create(goal),other=new PlanBoard(runId,path,()=>true),outcomes=await Promise.allSettled([
      board.revise(a.id,1,{...goal,status:'blocked',reason:'The first owner revision waits for evidence'}),other.revise(a.id,1,{...goal,status:'blocked',reason:'The second concurrent revision must not overwrite'})]);
    expect(outcomes.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect((await board.list())[0].revision).toBe(2);expect(store.records().filter(row=>row.data?.plan)).toHaveLength(2);
  }));
  it('preserves request idempotency across before/after commit faults without repeating a builder',async()=>{
    let stage:string|undefined;await fixture(async({board,store})=>{
      const request={actorId:'owner',requestId:'goal-create',payload:{goal}};stage='before-commit';await expect(board.create(goal,request)).rejects.toThrow('injected');expect(store.records()).toHaveLength(0);
      stage='after-commit';await expect(board.create(goal,request)).rejects.toThrow('injected');expect(store.records()).toHaveLength(1);const sequence=store.sequence();stage=undefined;
      const recovered=await board.create(goal,request);expect(await board.create(goal,request)).toEqual(recovered);expect(store.sequence()).toBe(sequence);
      const next={...goal,status:'blocked'},reviseRequest={actorId:'owner',requestId:'goal-revise',payload:{next}};const revised=await board.revise(recovered.id,1,next,reviseRequest);
      expect(await board.revise(recovered.id,1,next,reviseRequest)).toEqual(revised);expect(store.records()).toHaveLength(2);
      await expect(board.create(goal,{...request,payload:{changed:true}})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      await expect(board.create({...goal,title:'Changed logical input despite same transport payload'},request)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    },at=>{if(at===stage)throw Error('injected plan fault');});
  });
  it('refuses mutations after active ownership closes but still permits read-only inspection',async()=>fixture(async({board,setActive,path,store})=>{
    const a=await board.create(goal);setActive(false);await expect(board.create(goal)).rejects.toThrow('authority inactive');
    expect((await board.list())[0].id).toBe(a.id);const before=store.sequence(),index=await readLedger(path),lines=stateLines(index,parseStateCommand(`plan ${a.id}`) as {action:'plan';id:string});
    expect(lines.join('\n')).toContain('Owner coordination only');expect(store.sequence()).toBe(before);
    expect(parseStateCommand('plans 0')).toEqual({action:'plans',cursor:0});expect(parseStateCommand('phases')).toEqual({action:'phases',cursor:0});expect(()=>parseStateCommand('phases -1')).toThrow();
  }));
  it('does not turn retained decision history into a lifetime plan limit',async()=>fixture(async({board,tasks})=>{
    const task=await tasks.create(draft);for(let i=0;i<105;i++)await board.create({kind:'decision',title:'Recorded inert decision '+i,status:'recorded',reason:'Explicit one-round choice retained as immutable history',decision:{disposition:'defer',chosenTaskIds:[],deferredTaskIds:[task.id],revisitCondition:'Fresh reviewed evidence arrives'}});
    const created=await board.create(goal);expect((await board.list()).filter(entry=>entry.kind==='decision')).toHaveLength(105);expect(created.status).toBe('active');
  }));
  it('opens schema 5 metadata-only and refuses a writer rather than migrating in place',async()=>{
    const root=await mkdtemp(join(tmpdir(),'p2o-plan-old-'));let store:AssessmentStore|undefined;
    try{store=AssessmentStore.create(root,{runId,retention:'durable-local',targetKind:'directory',targetIdentity:'inert',targetDisplay:'inert',profile:{runtimeHash:'inert',image:'inert',loopMode:'manual',executorMode:'shared'}});const location=store.location;store.close();store=undefined;
      const db=new DatabaseSync(join(location,'assessment.sqlite'));db.exec('PRAGMA user_version=5');db.close();
      expect(()=>AssessmentStore.open(root,runId,{readOnly:false})).toThrow('Unsupported state schema 5');store=AssessmentStore.open(root,runId);expect(store.health()).toMatchObject({compatible:false});expect(()=>store!.records()).toThrow('Unsupported');
    }finally{store?.close();await rm(root,{recursive:true,force:true});}
  });
});
