import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssessmentStore, type StoreFault } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { TaskBoard, taskCapsule, type AssessmentTask, type TaskDraft } from '../../src/tasks.js';
import { workIdentity, validateWorkFields } from '../../src/work.js';
import { phasePackets } from '../../src/planning.js';
import { readLedger } from '../../src/records.js';

const runId='run-work';
const base=(id:string,assetId:string):TaskDraft=>({id,question:'Which observation distinguishes the declared policy?',surface:'/fixture',risk:'authorization',role:'general',roleReason:'Bounded inert source comparison only',
  expectedTrue:'Declared actor reaches the consumer',expectedFalse:'Control actor does not reach the consumer',stopCondition:'Stop after the bounded observation or a concrete gap',evidenceIds:[],prerequisites:[],method:{skills:[],reason:'Controlled offline fixture, not a target assessment'},
  work:{assetRefs:[{id:assetId,revision:1}],questionKey:'policy:object-access',policyKey:'policy:declared-contract',actorContext:'actor:fixture-a',tenantContext:'tenant:fixture',methodFamily:'source-trace',purpose:'investigation'},
  decision:{disposition:'new',reason:'No prior retained attempt for this structured identity'},outputContract:{kind:'investigation',required:['evidence','gaps'],partialAllowed:true,artifactPolicy:'ids-only'}});
async function fixture(work:(h:{store:AssessmentStore;board:TaskBoard;path:string;assetId:string;another:()=>TaskBoard})=>Promise<void>,fault?:StoreFault){
  const root=await mkdtemp(join(tmpdir(),'p2o-work-')),store=AssessmentStore.create(root,{runId,retention:'durable-local',targetKind:'directory',targetIdentity:'inert',targetDisplay:'inert',profile:{runtimeHash:'inert',image:'inert',loopMode:'manual',executorMode:'shared'}},{fault});
  const path=join(root,'alias.sqlite'),unbind=bindAssessmentStore(path,store),another=()=>new TaskBoard(runId,path,()=>true,Date.now,()=>store.graphScope(),id=>store.assetRevision(id));
  const assetId=store.recordGraph({assets:[{asset:{kind:'endpoint',key:'GET /fixture'}}]})[0].entityId;
  try{await work({store,board:another(),another,path,assetId});}finally{unbind();store.close();await rm(root,{recursive:true,force:true});}
}
async function closeReviewed(board:TaskBoard,store:AssessmentStore,task:AssessmentTask,assignee='owner'){
  await board.reserve(task.id,assignee);await board.transition(task.id,'running','Inert assignment began');
  if(assignee!=='owner')await board.transition(task.id,'reported','Inert report committed');
  const ref=store.commitRecords([{runId,at:'2030',by:assignee,kind:'evidence',text:'Inert fixture receipt; not semantic finding proof'}])[0].recordId;
  await board.transition(task.id,'reviewed','Owner accepted bounded coordination receipt',[ref]);return board.transition(task.id,'closed','Bounded task closed, not a verified finding');
}

describe('structured work admission over canonical TaskBoard (K4)',()=>{
  it('hashes explicit identity/pins rather than prose, and missing context stays unknown',()=>{
    const task=base('a','asset-'+'a'.repeat(24)),original=workIdentity('scope-a',task);
    const paraphrase={...task,question:'Different wording',surface:'alias'};expect(original.confidence).toBe('exact');expect(workIdentity('scope-a',paraphrase).fingerprint).toBe(original.fingerprint);
    expect(workIdentity('scope-b',task).fingerprint).not.toBe(original.fingerprint);
    expect(workIdentity('scope-a',{...task,work:{...task.work!,actorContext:undefined}})).toMatchObject({confidence:'unknown'});
    expect(workIdentity('scope-a',{...task,work:{...task.work!,assetRefs:[{id:task.work!.assetRefs[0].id}]}}).fingerprint).toBeUndefined();
    expect(workIdentity('scope-a',{...task,prerequisites:[{taskId:'prior'}]}).confidence).toBe('unknown');
    expect(workIdentity('scope-a',{...task,work:{...task.work!,methodFamily:'differential'}}).fingerprint).not.toBe(original.fingerprint);
    expect(()=>validateWorkFields({...task,work:{...task.work!,scope:'spoof'} as never})).toThrow('host-owned');
    expect(()=>validateWorkFields({...task,decision:{disposition:'new',reason:'An explicit reason',relatedTaskId:'other'}})).toThrow('prior');
  });
  it('returns active exact coverage across paraphrases/labels without creating a task or launching work',async()=>fixture(async({board,store,assetId})=>{
    const first=await board.create(base('first',assetId)),sequence=store.sequence(),candidate={...base('second',assetId),question:'Reword the same canonical policy question',surface:'another textual alias'};
    const match=await board.match(candidate);expect(match.active).toEqual([{taskId:first.id,revision:1,status:'proposed'}]);
    await expect(board.create(candidate)).rejects.toThrow('exact work already active');expect(store.sequence()).toBe(sequence);expect(await board.list()).toHaveLength(1);
    await board.reserve(first.id,'owner');await board.transition(first.id,'running','Inert source inspection started');
    expect((await board.match(candidate)).active[0]).toMatchObject({taskId:first.id,status:'running'});
  }));
  it('warns about actor/method overlaps instead of treating them as exact duplicates',async()=>fixture(async({board,assetId})=>{
    const a=await board.create(base('a',assetId)),input=base('b',assetId);input.work={...input.work!,actorContext:'actor:fixture-b',methodFamily:'differential'};
    const b=await board.create(input);expect(b.workFingerprint).not.toBe(a.workFingerprint);expect(b.overlapWarnings).toContain('overlap:a');
    await board.reserve(a.id,'worker-a');await expect(board.reserve(b.id,'worker-b')).resolves.toMatchObject({status:'reserved'});
  }));
  it('P10/TR-L02: allows a surface/risk overlap when the declared method differs, and records it on the reserved revision',async()=>fixture(async({board,assetId})=>{
    // The reserved task declares a method but leaves its structured identity unknown (no actor context): the coarse guard now has
    // to compare mechanisms instead of refusing every same surface/risk overlap.
    const busy=base('busy',assetId);busy.work={...busy.work!,actorContext:undefined};
    const running=await board.create(busy);expect(running.dedupConfidence).toBe('unknown');
    await board.reserve(running.id,'worker-a');await board.transition(running.id,'running','Inert worker began against the declared mechanism');
    const same=base('same-method',assetId);expect((await board.readiness((await board.create(same)).id))).toMatchObject({ready:false});
    await expect(board.reserve('same-method','worker-b')).rejects.toThrow('ASSIGNMENT_CONFLICT');
    const different=base('different-method',assetId);different.work={...different.work!,methodFamily:'differential'};
    const created=await board.create(different);expect((await board.readiness(created.id))).toMatchObject({ready:true});
    const reserved=await board.reserve(created.id,'worker-b');
    expect(reserved.overlapWarnings).toContain(`method-different-overlap:${running.id}`);
  }));
  it('indexes full history beyond a recent display tail and returns reviewed reuse without automatic completion',async()=>fixture(async({board,store,assetId})=>{
    const first=await closeReviewed(board,store,await board.create(base('old-work',assetId)));
    for(let i=0;i<35;i++){const input=base('noise-'+i,assetId);delete input.work;delete input.decision;delete input.outputContract;input.surface='noise-'+i;const task=await board.create(input);await board.transition(task.id,'cancelled','Inert irrelevant history withdrawn');}
    const candidate=base('next',assetId),match=await board.match(candidate);expect(match.reusable).toEqual([{taskId:first.id,revision:first.revision,status:'closed'}]);
    expect(store.workHistory(first.workFingerprint!)).toMatchObject({heads:1,active:0,reusable:1,omitted:0});await expect(board.create(candidate)).rejects.toThrow('REUSE_CANDIDATE');
    expect((await board.list()).find(t=>t.id==='old-work')!.status).toBe('closed');
  }));
  it('requires an explicit reasoned retry after partial/blocked history, never silently retries a target',async()=>fixture(async({board,store,assetId})=>{
    const old=await board.create(base('old',assetId));await board.transition(old.id,'blocked','Missing policy fixture; no investigation occurred');
    await expect(board.create(base('new',assetId))).rejects.toThrow('PRIOR_PARTIAL');
    const retry=base('retry',assetId);retry.decision={disposition:'retry',reason:'Inspected retained gap and chose a separate attempt',relatedTaskId:'old',changeReason:'Operator supplied the missing inert policy fixture'};
    const created=await board.create(retry);expect(created.overlapWarnings).toContain('prior-partial:old');await expect(board.reserve(created.id,'fresh-worker')).resolves.toMatchObject({status:'reserved'});
    expect(store.events({since:0,limit:100}).rows.filter(row=>row.kind.startsWith('operation.'))).toEqual([]);
  }));
  it('uses a unique atomic reservation, rolling back an entire conflicting multi-task packet',async()=>fixture(async({board,store,assetId})=>{
    const a=await board.create(base('a',assetId)),b={...a,id:'b',recordId:'not-persisted'};
    store.commitRecords([{id:randomUUID(),runId,at:'2030',by:'owner',kind:'task',text:'Second concurrent proposal',data:{task:b}}]);
    const headB=(await board.list()).find(t=>t.id==='b')!,before=store.sequence(),count=store.records().length;
    const reservation=(task:AssessmentTask)=>({id:randomUUID(),runId,at:'2030',by:'owner',kind:'task' as const,text:'Atomic reservation',supersedes:task.recordId,data:{task:{...task,revision:2,status:'reserved',assignee:'worker-'+task.id}}});
    expect(()=>store.commitRecords([reservation(a),reservation(headB)],{actorId:'owner',requestId:'twins',payload:{}})).toThrow('exact work fingerprint already reserved');
    expect(store.sequence()).toBe(before);expect(store.records()).toHaveLength(count);expect((await board.list()).map(t=>t.status)).toEqual(['proposed','proposed']);
    const outcomes=await Promise.allSettled([board.reserve('a','worker-a'),new TaskBoard(runId,board.path,()=>true,Date.now,()=>store.graphScope(),id=>store.assetRevision(id)).reserve('b','worker-b')]);
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect((await board.list()).filter(t=>t.status==='reserved')).toHaveLength(1);
  }));
  it('P10/TR-H10: records asset drift as one warning while admission still pins the revision it reviews',async()=>fixture(async({board,store,assetId})=>{
    const task=await board.create(base('a',assetId));await board.reserve(task.id,'worker-a');await board.transition(task.id,'running','Inert worker began');
    store.recordGraph({assets:[{asset:{kind:'endpoint',key:'GET /fixture',label:'new confirmed attribute',expectedRevision:1}}]});
    // The running worker keeps running against the premise it was dispatched with; the drift is a recorded warning fact.
    await expect(board.assertReady('worker-a')).resolves.toBeUndefined();
    const drift=async()=>(await readLedger(board.path,runId)).records.filter(row=>row.kind==='note'&&row.data?.warning==='STALE_WORK_REFERENCE');
    expect(await drift()).toHaveLength(1);
    expect((await drift())[0].data).toMatchObject({taskId:task.id,assetId,pinnedRevision:1,currentRevision:2});
    // Deduplicated: every command re-checks structurally, but the fact is recorded once.
    await board.assertReady('worker-a');expect(await drift()).toHaveLength(1);
    // Admission stays authoritative: a new task pinned to the old revision is refused, an explicit re-pin is accepted.
    const stale=base('b',assetId);const repin=base('c',assetId);repin.work!.assetRefs[0].revision=2;
    await expect(board.create(stale)).rejects.toThrow('STALE_WORK_REFERENCE');
    const pinned=await board.create(repin);await expect(board.reserve(pinned.id,'worker-c')).resolves.toMatchObject({status:'reserved'});
    // The atomic running transition still refuses an asset that moved after reservation.
    store.recordGraph({assets:[{asset:{kind:'endpoint',key:'GET /fixture',label:'third revision',expectedRevision:2}}]});
    await expect(board.transition(pinned.id,'running','Inert worker start attempted')).rejects.toThrow('STALE_WORK_REFERENCE');
  }));
  it('requires separate validation attempts and retest reasons while retaining discovery history',async()=>fixture(async({board,store,assetId})=>{
    const discovery=await closeReviewed(board,store,await board.create(base('discovery',assetId)),'discovery-worker'),validation=base('validation',assetId);
    validation.role='validation';validation.validationOf=discovery.id;validation.prerequisites=[{taskId:discovery.id,revision:discovery.revision}];validation.work!.purpose='validation';validation.decision={disposition:'validate',reason:'Independent attempt to compare retained discovery evidence',relatedTaskId:discovery.id};
    const second=await board.create(validation);await expect(board.reserve(second.id,'discovery-worker')).rejects.toThrow('separate worker');await board.reserve(second.id,'validation-worker');
    const retest=base('retest',assetId);retest.retestOf=discovery.id;retest.work!.purpose='retest';retest.decision={disposition:'retest',reason:'Explicit retest decision after reading prior limitations',relatedTaskId:discovery.id};
    await expect(board.create(retest)).rejects.toThrow('material change reason');retest.decision.changeReason='Changed inert policy fixture selected by the operator';const third=await board.create(retest);expect(third.retestOf).toBe(discovery.id);
    expect(taskCapsule(third)).toContain('Changed inert policy');expect((await board.list()).find(t=>t.id==='discovery')!.status).toBe('closed');
  }));
  it('rejects forged host fingerprints and worker-authored task/plan/phase metadata',async()=>fixture(async({board,store,assetId})=>{
    const task=await board.create(base('a',assetId));
    expect(()=>store.commitRecords([{id:randomUUID(),runId,by:'owner',at:'2030',kind:'task',text:'spoof',data:{task:{...task,id:'bad',workFingerprint:'0'.repeat(64)}}}])).toThrow('host target/source namespace');
    expect(()=>store.commitRecords([{runId,by:'worker',workerId:'worker',at:'2030',kind:'note',text:'spoof',data:{plan:{id:'goal-a',runId,kind:'goal',revision:1}}}])).toThrow('owned plan');
    expect(()=>store.commitRecords([{runId,by:'worker',workerId:'worker',at:'2030',kind:'note',text:'spoof',data:{phase:{id:'x',version:1,taskId:'a',delivery:'reported',reviewStatus:'pending'}}}])).toThrow('phase packet');
  }));
  it('commits the blocked phase card atomically and retained replay appends nothing',async()=>fixture(async({board,store,path,assetId})=>{
    const task=await board.create(base('a',assetId));await board.reserve(task.id,'worker-a');
    const report={summary:'No-investigation provider failure',findings:[],evidence:[],coverage:[],openItems:['Prior output not complete; inspect before retry'],confidence:'low' as const,outcome:'provider-error' as const,blocked:'Inert provider unavailable'},request={actorId:'worker-a',requestId:'blocked-phase',payload:{report}};
    const ack=await board.handoff(task.id,'worker-a',report,'general',1,request),before=store.sequence();expect(await board.handoff(task.id,'worker-a',report,'general',1,request)).toEqual(ack);expect(store.sequence()).toBe(before);
    const card=phasePackets(await readLedger(path))[0];expect(card).toMatchObject({delivery:'blocked',reviewStatus:'pending',outcome:'provider-error',observed:{evidence:0,findingClaims:0},unreviewedRequired:['evidence','gaps']});
    const current=(await board.list())[0];expect(current.phasePacketId).toBe(card.id);expect(current.reviewReason).toBeUndefined();expect(store.checkpoint('partial phase')).toMatchObject({planning:{phasePackets:1,pendingPhasePacketIds:[card.id]},pendingReviews:[task.id]});
  }));
});
