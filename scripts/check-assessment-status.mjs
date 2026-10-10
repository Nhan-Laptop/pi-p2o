// K6 deterministic status/widget projection corpus ONLY: no target, provider, Worker or reference execution.
// Compares the former O(history) path (store.records + indexRecords + statusView) with the incremental canonical adapter
// (cold load, warm read, read after one commit) that /p2o status and the TUI widget use. `--mixed` adds owner cases, claims and a
// coverage plan with cells through the real CaseBoard/CoverageBoard so the case/coverage projections are measured too.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const source=process.argv.includes('--source'),argument=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.split('=')[1],count=Number(argument('records')??32),quotaMiB=Number(argument('quota-mib')??256),reps=Number(argument('reps')??7),incrementalOnly=process.argv.includes('--incremental-only'),mixed=process.argv.includes('--mixed');
if(![32,10000,100000].includes(count)||!Number.isInteger(quotaMiB)||quotaMiB<8||quotaMiB>1024||!Number.isInteger(reps)||reps<3||reps>15)throw Error('records default 32, choices 32/10000/100000; quota-mib default 256, min 8, max 1024; reps default 7, min 3, max 15. Large corpora require an explicitly selected fixture disk quota, never an operator-settings change.');
if(mixed&&count<10000)throw Error('--mixed needs records 10000 or 100000');
let AssessmentStore,indexRecords,readLedger,bindAssessmentStore,statusView,uiRefreshDelay,CaseBoard,CoverageBoard;
if(source){const require=createRequire(import.meta.resolve('@earendil-works/pi-coding-agent')),{createJiti}=require('jiti'),jiti=createJiti(import.meta.url),load=relative=>jiti.import(new URL(relative,import.meta.url).pathname);
  ({AssessmentStore}=await load('../src/state/store.ts'));({indexRecords,readLedger}=await load('../src/records.ts'));({bindAssessmentStore}=await load('../src/state/adapter.ts'));({statusView}=await load('../src/ui/state.ts'));({uiRefreshDelay}=await load('../src/ui/refresh.ts'));({CaseBoard}=await load('../src/cases.ts'));({CoverageBoard}=await load('../src/coverage.ts'));}
else {({AssessmentStore}=await import('../dist/src/state/store.js'));({indexRecords,readLedger}=await import('../dist/src/records.js'));({bindAssessmentStore}=await import('../dist/src/state/adapter.js'));({statusView}=await import('../dist/src/ui/state.js'));({uiRefreshDelay}=await import('../dist/src/ui/refresh.js'));({CaseBoard}=await import('../dist/src/cases.js'));({CoverageBoard}=await import('../dist/src/coverage.js'));}
const root=await mkdtemp(join(tmpdir(),'p2o-status-corpus-')),runId='run-status-corpus',heads=Math.min(200,count-20),alias=join(root,'ledger-alias.sqlite');let store,unbind;
const p=(values,quantile)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*quantile)-1],time=work=>{const start=performance.now(),value=work();return [performance.now()-start,value];};
try{
  store=AssessmentStore.create(root,{runId,retention:'durable-local',targetKind:'directory',targetIdentity:'inert-status-corpus',targetDisplay:'no assessment, synthetic state only',profile:{runtimeHash:'fixture',image:'fixture',loopMode:'manual',executorMode:'shared'}},{maxBytes:quotaMiB*1024*1024});
  unbind=bindAssessmentStore(alias,store);
  const caseContext={assetRevision:id=>store.assetRevision(id),assertionRevision:id=>store.assertionRevision(id)},coverageContext={...caseContext,targetRevision:()=>store.graphScope(),assetIds:()=>store.assetEntityIds()},viewContext={cases:caseContext,coverage:coverageContext};
  const latest=new Map();let written=0;
  const row=i=>{
    if(i<20)return {id:`old-gap-${i}`,runId,at:'2030',by:'owner',kind:'open',text:`Retained unresolved gap ${i}; never assume clean`};
    const id=`task-${(i-20)%heads}`,prior=latest.get(id),revision=(prior?.revision??0)+1,recordId=`${id}-r${revision}`,status=revision%3===0?'reported':revision%3===1?'proposed':'blocked';
    latest.set(id,{revision,recordId});
    return {id:recordId,runId,at:'2030',by:'owner',kind:'task',text:`Synthetic task revision ${recordId}; no execution`,supersedes:prior?.recordId,data:{task:{id,runId,revision,status,role:'general',question:`Synthetic question ${id}`,prerequisites:[],evidenceIds:[]}}};
  };
  const fill=target=>{for(;written<target;){const batch=[];for(let i=0;i<100&&written<target;i++)batch.push(row(written++));store.commitRecords(batch);}};
  const initial=count-2*reps,reserve=mixed?400:0; // the steady-state loop commits two more rows per rep so the store ends at exactly `count` (its 100000-row cap)
  fill(initial-reserve);
  let mixedShape;
  if(mixed){
    const assets=store.recordGraph({assets:[{asset:{kind:'endpoint',key:'GET /a'}},{asset:{kind:'endpoint',key:'GET /b'}},{asset:{kind:'endpoint',key:'GET /c'}}]}).map(item=>item.entityId);
    const claims=[],evidence=by=>store.commitRecords([{id:randomUUID(),runId,at:'2030',by,workerId:by==='owner'?undefined:by,kind:'evidence',text:'Inert fixture receipt'}])[0].recordId;
    for(let i=0;i<12;i++){const receipt=evidence('worker-a'),id=randomUUID();store.commitRecords([{id,runId,at:'2030',by:'worker-a',workerId:'worker-a',kind:'candidate',text:'Attributed fixture claim',surface:`/s${i}`,risk:'authorization',outcome:'confirmed',refs:[receipt],data:{candidate:`claim-${i}`,closure:'confirmed',execution:'tested',proof:'offline_reproduction',evidenceRefs:[receipt],negativeControls:[],limitations:'Fixture limitations remain explicit',policyBasis:'boundary_invariant',expectedPolicy:'Declared fixture boundary'}}]);claims.push(id);}
    const taskRef=(n,stale)=>{const head=latest.get(`task-${n%heads}`);return {taskId:`task-${n%heads}`,revision:stale?Math.max(1,head.revision-1):head.revision};};
    const cases=new CaseBoard(runId,alias,()=>true,caseContext),coverage=new CoverageBoard(runId,alias,()=>true,coverageContext),made=[];
    for(let i=0;i<9;i++){const entry=await cases.create({title:`Fixture case ${i}`,policyKey:`policy:case-${i}`,rootCauseKey:`root:case-${i}`,assetRefs:[{id:assets[i%3],revision:store.assetRevision(assets[i%3])}],claimRefs:[claims[i]],independentEvidenceRefs:[],taskRefs:[0,1,2,3,4].map(n=>taskRef(i*7+n,n===4&&i%2===0)),reportRefs:[],contradictions:[],affectedVariants:['variant:read'],relatedCaseIds:[],verdict:'confirmed',reviewStatus:'pending',reviewReason:'Pending owner review of exact claim and evidence revisions',limitations:'Only the declared fixture actor and variant were assessed',remediation:{status:'unplanned',reason:'No remediation has been reviewed or implemented',evidenceRefs:[]}});made.push(entry);}
    const plan=await coverage.createPlan({title:'Fixture authorization matrix',status:'active',reason:'Explicit bounded denominator for the measured corpus',exclusions:['No undeclared actors or routes'],unknownScope:['Deployment parity is unknown']});let revision=plan.revision;
    for(let i=0;i<40;i++){const added=await coverage.addCell(plan.id,revision,{assetRef:{id:assets[i%3],revision:store.assetRevision(assets[i%3])},questionKey:`question:matrix-${i}`,policyKey:'policy:matrix',actorContext:`actor:${i%4}`,tenantContext:'tenant:a',methodFamily:'offline-observation',execution:'planned',assessment:'unreviewed',taskRefs:[taskRef(i*3,false),taskRef(i*3+1,i%3===0)],claimRefs:[claims[i%12]],caseRefs:[{caseId:made[i%9].id,revision:made[i%9].revision}],evidenceRefs:[],negativeControlRefs:[],gapRefs:[],reason:'This cell is explicitly planned but not yet tested',limitations:'No inference beyond the declared actor and asset'});revision=added.plan.revision;}
    mixedShape={claims:claims.length,cases:made.length,coveragePlans:1,coverageCells:40,tasksPerCase:5};
  }
  fill(initial-(store.records().length-written)); // mixed rows count toward the cap too
  const profile={runId,target:'synthetic corpus',lifecycle:'active',delegation:false,maxWorkers:3,workerUsed:0,workerCeiling:600,exportEnabled:false,engine:{mode:'manual',pendingIntents:0,rounds:0,maxAutomaticRounds:100,paused:undefined,decision:undefined},executor:{mode:'shared',maxTargetOperations:1},retention:'durable-local',stateLocation:root};
  globalThis.gc?.();const populatedRss=process.memoryUsage().rss,populatedHeap=process.memoryUsage().heapUsed,series={fullScanRecords:[],fullScanIndex:[],fullScanWidgetPath:[],coldLoad:[],warmRead:[],readAfterCommit:[],status:[],widgetPath:[]};

  // Former path, kept as the reference: reload and re-validate the whole history for every refresh.
  if(!incrementalOnly)for(let i=0;i<reps;i++){const [a,rows]=time(()=>store.records()),[b]=time(()=>indexRecords(rows,runId)),[c]=time(()=>statusView({...indexRecords(store.records(),runId),snapshotSequence:store.sequence()},profile,viewContext));series.fullScanRecords.push(a);series.fullScanIndex.push(b);series.fullScanWidgetPath.push(c);}

  // Incremental adapter: a fresh bind for every cold load, then steady-state refreshes that each follow one new commit.
  for(let i=0;i<reps;i++){unbind?.();unbind=bindAssessmentStore(alias,store);const start=performance.now();await readLedger(alias,runId);series.coldLoad.push(performance.now()-start);}
  let sample;
  for(let i=0;i<reps;i++){
    store.commitRecords([row(written++)]);
    let start=performance.now();const index=await readLedger(alias,runId);series.readAfterCommit.push(performance.now()-start);
    start=performance.now();const view=statusView(index,profile,viewContext);series.status.push(performance.now()-start);
    store.commitRecords([row(written++)]);
    start=performance.now();const refreshed=statusView(await readLedger(alias,runId),profile,viewContext);series.widgetPath.push(performance.now()-start);sample=refreshed;
    start=performance.now();await readLedger(alias,runId);series.warmRead.push(performance.now()-start);assert.ok(view.complete);
  }
  globalThis.gc?.();const retainedRss=process.memoryUsage().rss,retainedHeap=process.memoryUsage().heapUsed;
  // Differential check on the exact data just measured: the incremental snapshot must render the same status/widget as a full scan.
  if(!incrementalOnly){const incremental=await readLedger(alias,runId),full={...indexRecords(store.records(),runId),snapshotSequence:store.sequence()};
    assert.equal(incremental.records.length,full.records.length);assert.equal(incremental.records.at(-1).id,full.records.at(-1).id);assert.equal(incremental.bytes,full.bytes);assert.equal(incremental.complete,full.complete);
    const viewA=statusView(incremental,profile,viewContext),viewB=statusView(full,profile,viewContext);assert.deepEqual(viewA.lines,viewB.lines);assert.deepEqual(viewA.widget,viewB.widget);}
  assert.equal(store.records().length,count);assert.equal(sample.complete,true);assert.equal(sample.openEntries,20);assert.equal(sample.asOfRecordCount,store.records().length);
  if(mixed){assert.equal(sample.coverageCells,40);assert.ok(sample.pendingCaseReviews>=1);assert.ok(sample.staleCases>=1,'the corpus must contain stale case pins so those branches are measured');}
  const afterRss=process.memoryUsage().rss,health=store.health(),summarize=names=>Object.fromEntries(names.map(key=>[key,{p50Ms:+p(series[key],.5).toFixed(2),p95Ms:+p(series[key],.95).toFixed(2)}])),incrementalMs=summarize(['coldLoad','warmRead','readAfterCommit','status','widgetPath']),fullScanMs=incrementalOnly?undefined:summarize(['fullScanRecords','fullScanIndex','fullScanWidgetPath']);
  console.log(JSON.stringify({node:process.version,schemaVersion:health.schemaVersion,loader:source?'Pi dependency jiti/source TS':'compiled ESM',corpus:{records:count,hotTaskHeads:heads,openGaps:20,coldRevisions:count-heads-20,batchSize:100,quotaMiB,reps,synthetic:true,mixed:mixedShape??false},fullScanMs,incrementalMs,
    widgetPacing:{measuredRefreshP50Ms:incrementalMs.widgetPath.p50Ms,nextScanDelayMs:uiRefreshDelay(incrementalMs.widgetPath.p50Ms),minMs:25,maxMs:5000,factor:4},heapUsedAfterGc:{populatedBytes:populatedHeap,retainedBytes:retainedHeap,note:'live JS heap; RSS also holds freed pages V8 has not returned to the OS'},rss:{populatedRss,afterRss,retainedAfterIncrementalGc:retainedRss,peakRss:process.resourceUsage().maxRSS*1024,explicitGc:Boolean(globalThis.gc),incrementalOnly},storage:health,
    hardware:{platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem()},authorityRestored:false,
    limitations:['Projection microbench only: not TUI render latency, proof quality or installed acceptance',mixed?'Mixed corpus: 9 owner cases (5 task pins each, some superseded) and one 40-cell coverage plan; real runs may differ':'The corpus has no cases/coverage plans/cells; rerun with --mixed for their projections','statusView still derives its counts from the whole in-memory snapshot (O(history) per refresh, bounded by the 100000-record ledger cap); loading/validation is incremental and the content digest is lazy','No paid/live/Herdr/effectiveness proof']}));
}finally{unbind?.();store?.close();await rm(root,{recursive:true,force:true});}
