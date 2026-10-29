import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssessmentEngine, type EngineDeps, type PlannerWake } from '../../src/engine.js';
import type { AssessmentTask } from '../../src/tasks.js';

function fixture(ownerIdle=false,cap=3) {
  let active=true,idle=ownerIdle,live=0,peak=0;
  const tasks:AssessmentTask[]=Array.from({length:30},(_,i)=>({id:`task-${i}`,revision:1,status:'proposed',question:`Question ${i}`,surface:`surface-${i}`,role:'general'} as AssessmentTask));
  const spawns:string[]=[],wakes:PlannerWake[]=[],journal:unknown[]=[],problems:string[]=[];
  const readiness=new Map<string,string>();
  const deps:EngineDeps={active:()=>active,list:async()=>tasks,readiness:async id=>readiness.has(id)?{ready:false,reason:readiness.get(id)}:{ready:true},capacity:()=>cap-live,reap:async()=>true,
    spawn:async input=>{const t=tasks.find(t=>t.id===input.taskId)!;t.status='running';live++;peak=Math.max(peak,live);spawns.push(t.id);},persist:async(text,data)=>{journal.push({text,data});},wake:w=>wakes.push(w),idle:()=>idle,problem:s=>problems.push(s)};
  const engine=new AssessmentEngine('run-fixture','event-driven',deps,10);
  const queue=(ids:number[])=>engine.enqueue(ids.map(i=>({taskId:`task-${i}`,input:{taskId:`task-${i}`,focus:`surface-${i}`,task:`Question ${i}`}})));
  const complete=(id:string)=>{tasks.find(t=>t.id===id)!.status='reported';live--;engine.notify('worker-report',id);};
  return {engine,queue,complete,tasks,spawns,wakes,journal,problems,readiness,deps,get peak(){return peak;},setActive:(v:boolean)=>{active=v;},setIdle:(v:boolean)=>{idle=v;}};
}
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
const tick=()=>vi.advanceTimersByTimeAsync(15);

describe('deterministic frontier and semantic wake loop',()=>{
  it('processes 30 successive assignments on 3 slots without a lifetime spawn ceiling',async()=>{
    const f=fixture();await f.queue(Array.from({length:25},(_,i)=>i));await f.queue([25,26,27,28,29]);await tick();expect(f.spawns).toHaveLength(3);
    for(let i=0;i<30;i++){expect(f.spawns[i]).toBeDefined();f.complete(f.spawns[i]);await tick();}
    expect(f.peak).toBe(3);expect(new Set(f.spawns).size).toBe(30);expect(f.engine.snapshot().pendingIntents).toBe(0);expect(f.wakes).toEqual([]);f.engine.stop();
  });
  it('pause during asynchronous readiness preserves the accepted frontier without launching',async()=>{
    const f=fixture();let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(r=>{release=r;});const started=new Promise<void>(r=>{entered=r;});
    f.deps.readiness=async()=>{entered();await blocked;return {ready:true};};
    await f.queue([0]);const pumping=tick();await started;f.engine.pause('Human pause');release();await pumping;
    expect(f.spawns).toEqual([]);expect(f.engine.snapshot().pendingIntents).toBe(1);f.engine.resume();await tick();expect(f.spawns).toEqual(['task-0']);f.engine.stop();
  });
  it('validates a batch before commit and does not double enqueue accepted IDs',async()=>{
    const f=fixture();await expect(f.queue([0,99])).rejects.toThrow('proposed');expect(f.journal).toHaveLength(0);await f.queue([0]);await expect(f.queue([0])).rejects.toThrow('already queued');f.engine.stop();
  });
  it('waits for evidence readiness, invalidates a changed intent and never repeats a failed launch',async()=>{
    const f=fixture();f.readiness.set('task-0','Reviewed receipt prerequisite unavailable');await f.queue([0,1]);f.tasks[1].question='A different question';
    await tick();expect(f.spawns).toEqual([]);expect(f.engine.snapshot().events[0].kind).toBe('intent-invalidated');expect(f.engine.snapshot().intents[0].reason).toContain('prerequisite');
    f.readiness.delete('task-0');f.deps.spawn=async()=>{throw Error('Pane transport failed');};f.engine.kick();await tick();expect(f.engine.snapshot().pendingIntents).toBe(0);await tick();expect(f.engine.snapshot().events.some(e=>e.kind==='intent-blocked')).toBe(true);
    // P19/F: the refusal is a bounded ledger fact, not only a console notification, so a task left proposed can be explained.
    expect(f.journal.find(entry=>String((entry as any).text).includes('dispatch refused for task-0'))).toMatchObject({data:{event:'intent-blocked',taskId:'task-0',code:'DISPATCH_REFUSED',reason:'Pane transport failed'}});
    f.engine.stop();
  });
  it('P10/TR-H12: keeps a queued intent across an identity-preserving revision and invalidates a changed question',async()=>{
    const f=fixture();await f.queue([0]);
    // A revision that leaves the accepted work identity alone (here only the revision counter moved) must not discard the intent.
    const before=f.tasks[0].revision;f.tasks[0].revision+=1;await tick();
    expect(f.spawns).toEqual(['task-0']);expect(f.tasks[0].revision).toBeGreaterThan(before);expect(f.engine.snapshot().pendingIntents).toBe(0);
    f.complete('task-0');await tick();
    // A changed question is a different intent: it is dropped with an explicit event, not silently dispatched.
    await f.queue([1]);f.tasks[1].revision+=1;f.tasks[1].question='Question 1, rewritten';await tick();
    expect(f.spawns).toEqual(['task-0']);expect(f.engine.snapshot().pendingIntents).toBe(0);expect(f.engine.snapshot().events.find(event=>event.kind==='intent-invalidated')?.id).toBe('task-1');
    f.engine.stop();
  });
  it('coalesces semantic events, waits locally, and consumes only at a request projection',async()=>{
    const f=fixture(true);for(let i=0;i<100;i++)f.engine.notify('worker-report','same-worker');await tick();expect(f.wakes).toHaveLength(1);expect(f.engine.snapshot().pendingEvents).toBe(1);
    expect(f.engine.validWake(f.wakes[0])).toBe(true);await vi.advanceTimersByTimeAsync(24*60*60*1000);expect(f.wakes).toHaveLength(1);
    f.engine.started();expect(f.engine.consume()).toHaveLength(1);f.engine.settled();await tick();expect(f.wakes).toHaveLength(1);f.engine.stop();
  });
  it('ACKs only projected semantic events and never drops a signal arriving during the request',()=>{
    const f=fixture(true);f.engine.started();f.engine.notify('worker-report','old');const through=f.engine.snapshot().sequence;
    f.engine.notify('worker-report','late');expect(f.engine.consume(through).map(event=>event.id)).toEqual(['old']);
    expect(f.engine.snapshot()).toMatchObject({pendingEvents:1,consumedSequence:through});expect(f.engine.snapshot().events[0].id).toBe('late');
    expect(()=>f.engine.consume(through+2)).toThrow('barrier');expect(f.engine.consume().map(event=>event.id)).toEqual(['late']);f.engine.stop();
  });
  it('coalesces a semantic event storm into one reservation until a request projection consumes it',async()=>{
    // P18/D48: every run is the automatic loop, so the storm path has one shape instead of a manual-mode contrast.
    const driven=fixture(true);for(let i=0;i<200;i++)driven.engine.notify('worker-report',`worker-${i}`);await tick();await tick();
    expect(driven.wakes).toHaveLength(1);expect(driven.wakes[0]).toMatchObject({round:1,through:200,reason:'event'});expect(driven.engine.snapshot()).toMatchObject({rounds:1,pendingEvents:200});
    for(let i=0;i<200;i++)driven.engine.notify('worker-report',`worker-${i}`);await tick();await tick();await tick();expect(driven.wakes,'repeats coalesce onto the same keys and one reservation stays in flight until a request projection consumes it').toHaveLength(1);expect(driven.engine.snapshot()).toMatchObject({rounds:1,pendingEvents:200,sequence:400});driven.engine.stop();
  });
  it('retains events while busy and supplies exactly one boundary continuation',async()=>{
    const f=fixture(true);f.engine.started();f.setIdle(false);f.engine.notify('worker-report','a');await tick();expect(f.wakes).toEqual([]);
    const wake=f.engine.boundary()!;expect(wake.round).toBe(1);expect(f.engine.boundary()).toBeUndefined();expect(f.engine.validWake(wake)).toBe(true);
    f.engine.consume();f.engine.notify('worker-report','b');expect(f.engine.boundary()!.round).toBe(2);f.engine.stop();
  });
  it('pause/stop invalidates reserved wakes, preserves the round count and never resurrects authority',async()=>{
    const f=fixture(true);f.engine.notify('worker-report','a');await tick();const wake=f.wakes[0];f.engine.pause('Human pause');expect(f.engine.validWake(wake)).toBe(false);
    await f.queue([0]);await tick();expect(f.spawns).toEqual([]);f.engine.resume();await tick();expect(f.spawns).toHaveLength(1);expect(f.wakes).toHaveLength(2);
    f.engine.stop();f.engine.notify('worker-report','late');await tick();expect(f.wakes).toHaveLength(2);await expect(f.queue([1])).rejects.toThrow('inactive');
  });
  it('has no automatic wake ceiling: a productive run keeps waking and resume never refuses',async()=>{
    // There is no round allowance to renew: only evidence (M6) or the human ends the loop.
    const f=fixture(true);for(let i=0;i<5;i++){f.engine.notify('worker-report',`w-${i}`);await tick();f.engine.consume();}
    expect(f.wakes).toHaveLength(5);expect(f.engine.snapshot().paused).toBeUndefined();expect(()=>f.engine.resume()).not.toThrow();f.engine.stop();
  });
  it('stops new dispatch after stop while an asynchronous spawn is still owned',async()=>{
    const f=fixture();let release!:()=>void;f.deps.spawn=()=>new Promise<void>(resolve=>{release=resolve;});await f.queue([0,1]);await tick();f.engine.stop();release();await f.engine.join();expect(f.engine.snapshot().state).toBe('stopped');
  });
  it('P10/TR-H11: pane cleanup uncertainty records one backpressure fact and skips the round instead of pausing the campaign',async()=>{
    const f=fixture();f.deps.reap=async()=>false;await f.queue([0]);await tick();
    expect(f.engine.snapshot().paused).toBeUndefined();expect(f.spawns).toHaveLength(0);expect(f.engine.snapshot().pendingIntents).toBe(1);
    const facts=()=>(f.journal as Array<{data?:{event?:string}}>).filter(entry=>entry.data?.event==='engine.reap-unverified');
    expect(facts()).toHaveLength(1);
    f.engine.kick();await tick();expect(f.spawns).toHaveLength(0);expect(facts()).toHaveLength(1);
    // A later successful reap retries the accepted intent in place; no human resume is needed.
    f.deps.reap=async()=>true;f.engine.kick();await tick();expect(f.spawns).toEqual(['task-0']);f.engine.stop();
  });
  it('P18/A9: reports the round budget and wakes on a demand the wait never answered',async()=>{
    const f=fixture(true);
    const budget={steps:40,seconds:900,wrapSteps:6,contextWrapPercent:80,contextHardPercent:92};
    f.deps.roundBudget=()=>budget;
    expect(f.engine.snapshot().roundBudget).toEqual(budget);
    f.engine.consume(undefined,{testedCells:0,closures:0,assets:0,chainDepth:0,remaining:2,demand:'review the two open proofs'});
    await f.engine.disposition('wait','No feasible direction in this round');
    f.engine.settled();await tick();expect(f.wakes,'the wait answered this exact demand, so no debt wake').toEqual([]);
    // The round still owes work and the ledger now names a different obligation: that demand is not the one the wait answered.
    f.engine.notify('worker-report','w-1');f.engine.consume(undefined,{testedCells:1,closures:0,assets:0,chainDepth:0,remaining:2,demand:'a new handoff needs review'});
    f.engine.settled();await tick();
    expect(f.wakes).toHaveLength(1);expect(f.wakes[0]).toMatchObject({reason:'debt',demand:'a new handoff needs review'});
    f.engine.stop();
  });
  it('bounded event retention diagnoses overflow and cannot silently resume',async()=>{
    const f=fixture(true);for(let i=0;i<257;i++)f.engine.notify('worker-report',String(i));await tick();expect(f.engine.snapshot().paused).toContain('overflow');expect(f.engine.snapshot().pendingEvents).toBe(256);expect(f.wakes).toEqual([]);f.engine.stop();
  });
});
