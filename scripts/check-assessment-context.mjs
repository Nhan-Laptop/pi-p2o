// K6 deterministic indexed context/UI corpus ONLY: no target, provider, Worker or reference execution.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const source=process.argv.includes('--source'),argument=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.split('=')[1],count=Number(argument('records')??32),quotaMiB=Number(argument('quota-mib')??256);
if(![32,10000,100000].includes(count)||!Number.isInteger(quotaMiB)||quotaMiB<8||quotaMiB>1024)throw Error('records default 32, choices 32/10000/100000; quota-mib default 256, min 8, max 1024. Large corpora require an explicitly selected fixture disk quota, never an operator-settings change.');
let AssessmentStore,knowledgeLines;
if(source){const require=createRequire(import.meta.resolve('@earendil-works/pi-coding-agent')),{createJiti}=require('jiti'),jiti=createJiti(import.meta.url);({AssessmentStore}=await jiti.import(new URL('../src/state/store.ts',import.meta.url).pathname));({knowledgeLines}=await jiti.import(new URL('../src/ui/workspace.ts',import.meta.url).pathname));}
else {({AssessmentStore}=await import('../dist/src/state/store.js'));({knowledgeLines}=await import('../dist/src/ui/workspace.js'));}
const root=await mkdtemp(join(tmpdir(),'p2o-context-corpus-')),runId='run-context-corpus',heads=Math.min(200,count-20);let store;
try{
  store=AssessmentStore.create(root,{runId,retention:'durable-local',targetKind:'directory',targetIdentity:'inert-context-corpus',targetDisplay:'no assessment, synthetic state only',profile:{runtimeHash:'fixture',image:'fixture',loopMode:'manual',executorMode:'shared'}},{maxBytes:quotaMiB*1024*1024});
  const commits=[],latest=new Map();let gapCount=0;
  for(let offset=0;offset<count;offset+=100){const rows=[];for(let i=offset;i<Math.min(count,offset+100);i++){
    if(i<20){rows.push({id:`old-gap-${i}`,runId,at:'2030',by:'owner',kind:'open',text:`Retained unresolved gap ${i}; never assume clean`});gapCount++;continue;}
    const id=`task-${(i-20)%heads}`,prior=latest.get(id),revision=(prior?.revision??0)+1,recordId=`${id}-r${revision}`,status=revision%3===0?'reported':revision%3===1?'proposed':'blocked';
    rows.push({id:recordId,runId,at:'2030',by:'owner',kind:'task',text:`Synthetic task revision ${recordId}; no execution`,supersedes:prior?.recordId,data:{task:{id,runId,revision,status,role:'general',question:`Synthetic question ${id}`,prerequisites:[],evidenceIds:[]}}});latest.set(id,{revision,recordId});
  }const start=performance.now();store.commitRecords(rows);commits.push(performance.now()-start);}
  const populatedRss=process.memoryUsage().rss;globalThis.gc?.();const beforeQueryRss=process.memoryUsage().rss,packets=[],pages=[],renders=[],reads=[];let packetBytes=0,pageBytes=0,uiBytes=0,maxRecordReads=0;
  const originalRecord=store.record.bind(store);let recordReads=0;store.record=id=>{recordReads++;return originalRecord(id);};store.records=()=>{throw Error('Cold history materialization forbidden during bounded context/UI measurement');};
  const consumer={consumerId:'planner',role:'planner'},original=store.contextPacket(consumer);assert.equal(original.counts.heads,heads+gapCount);assert.equal(original.counts.coldRecords,count-heads-gapCount);assert.equal(original.counts.openGaps,gapCount);assert.equal(original.counts.eventsAfterCursor,count);assert.deepEqual(original,store.contextPacket(consumer));
  for(let i=0;i<64;i++){
    recordReads=0;let start=performance.now();const packet=store.contextPacket(consumer);packets.push(performance.now()-start);packetBytes=Math.max(packetBytes,packet.encodedBytes);maxRecordReads=Math.max(maxRecordReads,recordReads);assert.ok(packetBytes<=20*1024);assert.equal(store.contextCursor('planner'),undefined);
    start=performance.now();const page=store.knowledgePage({domain:'task',limit:20});pages.push(performance.now()-start);assert.equal(page.total,heads);pageBytes=Math.max(pageBytes,Buffer.byteLength(JSON.stringify(page)));
    start=performance.now();const lines=knowledgeLines(store,{action:'heads',domain:'task',cursor:0,limit:20});renders.push(performance.now()-start);uiBytes=Math.max(uiBytes,Buffer.byteLength(lines.join('\n')));reads.push(recordReads);
  }
  // Gap rotation is a delivery receipt, not resolution. New consumer reads after ACK remain bounded.
  const recalled=new Set();for(let i=0;i<3;i++){const packet=store.contextPacket(consumer);packet.newGaps.forEach(row=>recalled.add(row.recordId));store.acknowledgeContext(packet);}assert.equal(recalled.size,gapCount);assert.equal(store.knowledgePage({domain:'gap',status:'open'}).total,gapCount);
  const health=store.health();globalThis.gc?.();const afterQueryRss=process.memoryUsage().rss;store.close();store=AssessmentStore.open(root,runId,{maxBytes:quotaMiB*1024*1024});assert.equal(store.health().authorityRestored,false);assert.equal(store.knowledgePage({domain:'task',limit:1}).total,heads);assert.equal(store.knowledgeRecord('task','task-0').data.task.revision,latest.get('task-0').revision);assert.throws(()=>store.acknowledgeContext(store.contextPacket(consumer)),/read-only/);
  const p=(values,quantile)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*quantile)-1];
  console.log(JSON.stringify({node:process.version,schemaVersion:health.schemaVersion,loader:source?'Pi dependency jiti/source TS':'compiled ESM',corpus:{records:count,hotTaskHeads:heads,openGaps:gapCount,coldRevisions:count-heads-gapCount,batchSize:100,quotaMiB,synthetic:true},performance:{commitBatchP50Ms:p(commits,.5),commitBatchP95Ms:p(commits,.95),contextP50Ms:p(packets,.5),contextP95Ms:p(packets,.95),headPageP50Ms:p(pages,.5),headPageP95Ms:p(pages,.95),humanHeadLinesP50Ms:p(renders,.5),humanHeadLinesP95Ms:p(renders,.95)},bounds:{packetBytes,pageBytes,uiBytes,maxRecordReadsPerContext:maxRecordReads,maxRecordReadsAcrossContextPageLines:Math.max(...reads),contextCalls:64,coldMaterializations:0},rss:{populatedRss,beforeQueryRss,afterQueryRss,explicitGc:Boolean(globalThis.gc)},storage:health,hardware:{platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem()},authorityRestored:false,limitations:['Microbench only: not full status/tasks/report widget or TUI render latency','No checkpoint >64MiB/archive qualification','No paid/live/installed/Herdr/effectiveness proof','Exact counts may scan SQL indexes; bounded result is not constant computational time']}));
}finally{store?.close();await rm(root,{recursive:true,force:true});}
