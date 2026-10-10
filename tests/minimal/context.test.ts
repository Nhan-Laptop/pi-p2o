import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssessmentStore, type StoreFault, type StoreManifest } from '../../src/state/store.js';
import type { AssessmentRecord } from '../../src/records.js';
import { replayKnowledgeIndex, type KnowledgeIndexSnapshot } from '../../src/context.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { CaseBoard } from '../../src/cases.js';
import { CoverageBoard } from '../../src/coverage.js';
import type { CaseDraft } from '../../src/case-types.js';

const manifest:StoreManifest={runId:'run-context',retention:'durable-local',targetKind:'directory',targetIdentity:'fixture-context',targetDisplay:'authorized inert context',profile:{runtimeHash:'inert',image:'inert',loopMode:'manual',executorMode:'shared'}};
const record=(id:string,kind:AssessmentRecord['kind']='observation',by='owner'):AssessmentRecord=>({id,runId:manifest.runId,at:'2030',kind,by,text:`Untrusted navigation ${id}`});
const task=(id:string,status='reported',revision=1,supersedes?:string):AssessmentRecord=>({...record(`${id}-r${revision}`,'task'),supersedes,data:{task:{id,runId:manifest.runId,revision,status,role:'general',question:`Question ${id}`,prerequisites:[]}}});
async function fixture(work:(store:AssessmentStore,root:string)=>Promise<void>,fault?:StoreFault){const root=await mkdtemp(join(tmpdir(),'p2o-context-'));let store:AssessmentStore|undefined;try{store=AssessmentStore.create(root,manifest,{fault});await work(store,root);}finally{store?.close();await rm(root,{recursive:true,force:true});}}

describe('indexed knowledge context delivery, not proof or authority',()=>{
  it('builds deterministic byte-bounded packets without parsing cold records or writing a cursor',async()=>fixture(async(store)=>{
    store.commitRecords([record('old-gap','open'),task('task-old')]);
    for(let page=0;page<20;page++)store.commitRecords(Array.from({length:100},(_,i)=>record(`cold-${page}-${i}`)));
    const sequence=store.sequence();
    // Packet reads do not fall back to an unbounded whole-history/domain reconciliation.
    store.records=()=>{throw Error('Whole-history read forbidden in context');};
    const a=store.contextPacket({consumerId:'planner',role:'planner'}),b=store.contextPacket({consumerId:'planner',role:'planner'});
    expect(a).toEqual(b);expect(a.counts).toMatchObject({heads:2,coldRecords:2000,openGaps:1,pendingReviews:1,eventsAfterCursor:2002});
    expect(a.newGaps.map(row=>row.entityId)).toContain('old-gap');expect(a.newReviews.map(row=>row.entityId)).toContain('task-old');expect(a.omissions.changes).toBe(1982);
    expect(a.encodedBytes).toBe(Buffer.byteLength(JSON.stringify(a)));expect(a.encodedBytes).toBeLessThanOrEqual(20*1024);
    const small=store.contextPacket({consumerId:'planner',role:'planner',maxBytes:4096});expect(small.encodedBytes).toBeLessThanOrEqual(4096);expect(small.omissions.changes).toBeGreaterThan(a.omissions.changes);
    expect(store.contextCursor('planner')).toBeUndefined();expect(store.sequence()).toBe(sequence);
    expect(()=>store.contextPacket({consumerId:'planner',role:'planner',maxBytes:4095})).toThrow('bound');
  }));
  it('rotates every retained unresolved gap/review, including old items after a consumed cursor',async()=>fixture(async(store)=>{
    for(let i=0;i<37;i++)store.commitRecords([record(`gap-${i}`,'open'),task(`task-${i}`)]);
    const gaps=new Set<string>(),reviews=new Set<string>();let first:string[]=[];
    for(let i=0;i<5;i++){const packet=store.contextPacket({consumerId:'planner',role:'planner'});if(i===0)first=packet.newGaps.map(row=>row.entityId);for(const row of packet.newGaps)gaps.add(row.entityId);for(const row of packet.newReviews)reviews.add(row.entityId);store.acknowledgeContext(packet);if(i===4)expect(packet.newGaps.map(row=>row.entityId)).toEqual(first);}
    expect(gaps.size).toBe(37);expect(reviews.size).toBe(37);expect(store.knowledgePage({domain:'gap',status:'open'}).total).toBe(37);
    // Delivery is not resolution; compaction can recall the same unresolved heads again.
    expect(store.contextPacket({consumerId:'planner',role:'planner'}).counts.openGaps).toBe(37);
  }));
  it('ACKs only the packet barrier, retains later events, and rejects stale competing ACKs',async()=>fixture(async(store)=>{
    store.commitRecords([record('gap','open')]);const packet=store.contextPacket({consumerId:'planner',role:'planner'}),competing=store.contextPacket({consumerId:'planner',role:'planner',maxBytes:4096});
    store.commitRecords([record('late-gap','open')]);const ack=store.acknowledgeContext(packet);expect(ack.throughSequence).toBe(1);
    expect(store.acknowledgeContext(packet)).toEqual(ack);const next=store.contextPacket({consumerId:'planner',role:'planner'});expect(next.changes.map(row=>row.payloadRefs).flat()).toContain('late-gap');
    store.acknowledgeContext(next);if(competing.packetSha256!==packet.packetSha256)expect(()=>store.acknowledgeContext(competing)).toThrow('STALE_CONTEXT_PACKET');
    expect(store.contextCursor('planner')).toMatchObject({throughSequence:next.cursorAfter.throughSequence});
    const event=store.events({since:0,limit:100}).rows.find(row=>row.kind==='context.consumed');expect(event?.data?.context).toMatchObject({authorityRestored:false,proofReviewed:false,cursorAfter:packet.cursorAfter});
  }));
  it('rolls back index/cursor/event/outbox before commit and replays a lost post-commit ACK once',async()=>{
    let fail:string|undefined;
    await fixture(async(store)=>{
      fail='before-commit';expect(()=>store.commitRecords([record('rolled-gap','open')])).toThrow('injected');expect(store.knowledgePage().total).toBe(0);expect(store.sequence()).toBe(0);fail=undefined;
      store.commitRecords([record('gap','open')]);const packet=store.contextPacket({consumerId:'planner',role:'planner'}),outbox=store.outbox();
      fail='before-commit';expect(()=>store.acknowledgeContext(packet)).toThrow('injected');expect(store.contextCursor('planner')).toBeUndefined();expect(store.outbox()).toEqual(outbox);expect(store.sequence()).toBe(1);
      fail='after-commit';expect(()=>store.acknowledgeContext(packet)).toThrow('injected');expect(store.contextCursor('planner')).toBeDefined();const committed=store.sequence();
      fail=undefined;expect(store.acknowledgeContext(packet).throughSequence).toBe(1);expect(store.sequence()).toBe(committed);expect(store.events({since:0,limit:100}).rows.filter(row=>row.kind==='context.consumed')).toHaveLength(1);
    },stage=>{if(stage===fail)throw Error('injected ACK fault');});
  });
  it('updates resolutions even when their carrier has no hot head; history remains retrievable',async()=>fixture(async(store)=>{
    store.commitRecords([record('gap','open')]);store.commitRecords([{...record('resolution'),resolves:['gap']}]);
    expect(store.contextPacket({consumerId:'planner',role:'planner'}).counts.openGaps).toBe(0);expect(store.knowledgePage({domain:'gap'}).rows[0].status).toBe('resolved');expect(store.record('gap')).toMatchObject({kind:'open'});
  }));
  it('preserves separate attributed candidate heads and exact cold revision retrieval',async()=>fixture(async(store)=>{
    store.commitRecords([{...record('claim-a','candidate','worker-a'),data:{candidate:'same-label',closure:'open_proof_gap'}},{...record('claim-b','candidate','worker-b'),data:{candidate:'same-label',closure:'open_proof_gap'}}]);
    store.commitRecords([{...record('claim-a2','candidate','worker-a'),supersedes:'claim-a',data:{candidate:'same-label',closure:'open_proof_gap'}}]);
    expect(store.knowledgePage({domain:'candidate'}).total).toBe(2);expect(store.knowledgePage({domain:'candidate'}).rows.map(row=>row.recordId).sort()).toEqual(['claim-a2','claim-b']);expect(store.record('claim-a')).toBeDefined();
  }));
  it('uses indexed exact task relevance and returns matching totals rather than window counts',async()=>fixture(async(store)=>{
    const assigned={...task('task-assigned'),data:{task:{...task('task-assigned').data!.task as object,status:'running',evidenceIds:['evidence-assigned'],assignee:'worker-one'}}};
    store.commitRecords([record('evidence-assigned','evidence'),assigned]);for(let i=0;i<45;i++)store.commitRecords([task(`task-other-${i}`)]);
    const packet=store.contextPacket({consumerId:'worker-one',role:'worker',taskId:'task-assigned'});expect(packet.relevant.map(row=>row.entityId).sort()).toEqual(['evidence-assigned','task-assigned']);
    const page=store.knowledgePage({domain:'task',limit:10});expect(page).toMatchObject({total:46,shown:10,omitted:36});expect(page.nextCursor).toBeDefined();const tail=store.knowledgePage({domain:'task',cursor:page.nextCursor,limit:100});expect(tail.rows).toHaveLength(36);
    expect(()=>store.contextPacket({consumerId:'worker-one',role:'worker'})).toThrow('Invalid context');
  }));
  it('downgrades transitive case/cell hot heads when exact support changes; cold accepted history never masks stale support',async()=>fixture(async(store,root)=>{
    const path=join(root,'alias.sqlite'),unbind=bindAssessmentStore(path,store);try{
      const asset=store.recordGraph({assets:[{asset:{kind:'endpoint',key:'GET /context'}}]})[0].entityId,context={assetRevision:(id:string)=>store.assetRevision(id),assertionRevision:(id:string)=>store.assertionRevision(id)},cases=new CaseBoard(manifest.runId,path,()=>true,context),coverage=new CoverageBoard(manifest.runId,path,()=>true,{...context,targetRevision:()=>store.graphScope(),assetIds:()=>store.assetEntityIds()});
      store.commitRecords([record('receipt','evidence','worker'),{...record('claim','candidate','worker'),surface:'/context',risk:'authorization',refs:['receipt'],data:{candidate:'context-claim',closure:'confirmed',execution:'tested',proof:'offline_reproduction',evidenceRefs:['receipt'],negativeControls:[],limitations:'Bounded inert fixture only',policyBasis:'boundary_invariant',expectedPolicy:'Declared fixture gate'}}]);
      const draft:CaseDraft={title:'Context support case',policyKey:'policy:context',rootCauseKey:'root:context',assetRefs:[{id:asset,revision:1}],claimRefs:['claim'],independentEvidenceRefs:[],taskRefs:[],reportRefs:[],contradictions:[],affectedVariants:['variant:context'],relatedCaseIds:[],verdict:'confirmed',reviewStatus:'pending',reviewReason:'Pending explicit review of context support',limitations:'No live target or provider proof',remediation:{status:'unplanned',reason:'No remediation or retest was claimed',evidenceRefs:[]}},created=await cases.create(draft),accepted=await cases.revise(created.id,1,{...draft,reviewStatus:'accepted',reviewReason:'Owner reviewed exact inert claim support'}),plan=await coverage.createPlan({title:'Context denominator',status:'active',reason:'Explicit inert context denominator',exclusions:[],unknownScope:['Only this fixture is known']}),added=await coverage.addCell(plan.id,plan.revision,{assetRef:{id:asset,revision:1},questionKey:'question:context',policyKey:'policy:context',actorContext:'actor:context',tenantContext:'tenant:context',methodFamily:'offline-observation',execution:'attempted',assessment:'accepted',taskRefs:[],claimRefs:[],caseRefs:[{caseId:accepted.id,revision:accepted.revision}],evidenceRefs:['receipt'],negativeControlRefs:[],gapRefs:[],reason:'Case support retained without assuming reviewed target execution',limitations:'Only bounded inert support'});
      const checkpoint=store.checkpoint('Before support supersession'),snapshot=store.inspectCheckpoint(checkpoint.id).snapshot!.knowledge!;
      store.commitRecords([{...store.record('claim')!,id:'claim-withdrawn',supersedes:'claim',data:{...store.record('claim')!.data,closure:'open_proof_gap',execution:'not_tested',proof:'static_trace'}}]);
      expect(store.knowledgePage({domain:'case'}).rows[0].status).toBe('stale');expect(store.knowledgePage({domain:'coverage-cell'}).rows[0]).toMatchObject({entityId:added.cell.id,status:'stale'});expect(store.contextPacket({consumerId:'planner',role:'planner'}).newReviews.map(row=>row.status)).toEqual(['stale','stale']);
      expect(store.record(accepted.recordId)?.data?.case).toMatchObject({reviewStatus:'accepted'});expect((await cases.list())[0].acceptedFinding).toBe(false);
      expect(replayKnowledgeIndex(snapshot,store.events({since:checkpoint.asOfSequence,limit:100}).rows,id=>store.record(id))).toEqual(store.knowledgeIndex());
    }finally{unbind();}
  }));
  it('rebuilds the same deterministic hot index/cursors from a checkpoint plus contiguous canonical event tail',async()=>fixture(async(store)=>{
    store.commitRecords([record('gap','open'),task('task-replay')]);store.acknowledgeContext(store.contextPacket({consumerId:'planner',role:'planner'}));const checkpoint=store.checkpoint('Knowledge index barrier fixture'),snapshot=store.inspectCheckpoint(checkpoint.id).snapshot!;
    expect(snapshot.knowledge?.authorityRestored).toBe(false);expect(checkpoint.knowledge).toMatchObject({version:1,heads:2,cursors:1});
    store.commitRecords([{...record('resolved'),resolves:['gap']},task('task-replay','closed',2,'task-replay-r1'),record('new-gap','open')]);store.acknowledgeContext(store.contextPacket({consumerId:'planner',role:'planner'}));
    const tail=store.events({since:checkpoint.asOfSequence,limit:100}).rows,replayed=replayKnowledgeIndex(snapshot.knowledge!,tail,id=>store.record(id));expect(replayed).toEqual(store.knowledgeIndex());
    const empty:KnowledgeIndexSnapshot={version:1,runId:manifest.runId,asOfSequence:0,heads:[],links:[],cursors:[],authorityRestored:false};expect(replayKnowledgeIndex(empty,store.events({since:0,limit:100}).rows,id=>store.record(id))).toEqual(store.knowledgeIndex());
    expect(()=>replayKnowledgeIndex(snapshot.knowledge!,tail.slice(1),id=>store.record(id))).toThrow('Non-contiguous');expect(()=>replayKnowledgeIndex({...snapshot.knowledge!,runId:'run-foreign'},tail,id=>store.record(id))).toThrow('foreign');expect(replayed.authorityRestored).toBe(false);
  }));
  it('keeps cursor inspection read-only across reopen without restoring work or rewriting schema',async()=>fixture(async(store,root)=>{
    store.commitRecords([record('gap','open')]);store.acknowledgeContext(store.contextPacket({consumerId:'planner',role:'planner'}));const cursor=store.contextCursor('planner'),reader=AssessmentStore.open(root,manifest.runId);try{expect(reader.contextCursor('planner')).toEqual(cursor);expect(reader.health().authorityRestored).toBe(false);expect(()=>reader.acknowledgeContext(reader.contextPacket({consumerId:'planner',role:'planner'}))).toThrow('read-only');expect(reader.knowledgeRecord('gap','gap')).toMatchObject({id:'gap'});}finally{reader.close();}
  }));
});
