// Bounded native graph mechanics/performance fixture. No Engine, model, target, worker or reference execution.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const source = process.argv.includes('--source');
const argument = process.argv.find(arg => arg.startsWith('--assets='));
const count = argument ? Number(argument.slice('--assets='.length)) : 200;
if (![200, 1000, 4000].includes(count)) throw Error('Use --assets=200|1000|4000; this fixture has explicit storage/row bounds');
let AssessmentStore, applyGraphEvents, GRAPH_RESPONSE_BYTES;
if (source) {
  const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const { createJiti } = require('jiti'), jiti = createJiti(import.meta.url);
  ({ AssessmentStore } = await jiti.import(new URL('../src/state/store.ts', import.meta.url).pathname));
  ({ applyGraphEvents, GRAPH_RESPONSE_BYTES } = await jiti.import(new URL('../src/state/graph.ts', import.meta.url).pathname));
} else {
  ({ AssessmentStore } = await import('../dist/src/state/store.js'));
  ({ applyGraphEvents, GRAPH_RESPONSE_BYTES } = await import('../dist/src/state/graph.js'));
}
const root = await mkdtemp(join(tmpdir(), 'p2o-native-graph-'));
const manifest = { runId: 'run-native-graph-fixture', retention: 'durable-local', targetKind: 'directory', targetIdentity: 'inert-graph-fixture', targetDisplay: 'no assessment',
  profile: { runtimeHash: 'fixture', image: 'fixture', loopMode: 'manual', executorMode: 'shared' } };
let store;
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.ceil(values.length*p)-1)];
const distribution = values => ({ p50Ms: percentile(values,.5), p95Ms: percentile(values,.95), samples:values.length });
try {
  store = AssessmentStore.create(root,manifest);
  const ids = [], commits = [], duplicates = [], batchSize = 16;
  const asset = (i, changed=false) => ({kind:'file',key:`src/handler-${i}.ts`,label:`handler ${i}`,attributes:{fixture:'inert',revision:changed?'updated':'initial'},anchors:[{kind:'symbol',value:`handler_${i}`,locator:{line:'1'}}]});
  const batch = start => {
    const indexes = Array.from({length:Math.min(batchSize,count-start)},(_,n)=>start+n);
    return { assets:indexes.map(i=>({ref:`item-${i}`,asset:asset(i)})),
      facts:indexes.map(i=>({assetId:`@item-${i}`,kind:'inferred',statement:`fixture question ${i}; not a verified finding`,confidence:'low'})),
      relations:indexes.filter(i=>i>0 && i%4===0).map(i=>({kind:'depends_on',fromId:`@item-${i}`,toId:i===start?ids[i-1]:`@item-${i-1}`,basis:'inferred',note:'fixture only'})) };
  };
  for (let start=0;start<count;start+=batchSize) {
    const packet=batch(start), clock=performance.now(), acks=store.recordGraph(packet,{actorId:'producer-a',requestId:`initial-${start}`,payload:{fixture:'graph',start}},{actorId:'producer-a',taskId:'task-fixture-a',role:'general',depth:1});
    commits.push(performance.now()-clock);ids.push(...acks.filter(a=>a.kind==='asset').map(a=>a.entityId));
    assert.equal(acks.every(a=>a.created),true);assert.ok(Buffer.byteLength(JSON.stringify(acks))<=GRAPH_RESPONSE_BYTES);
    const duplicateClock=performance.now(), repeated=store.recordGraph(packet,{actorId:'producer-b',requestId:`initial-${start}`,payload:{fixture:'graph',start}},{actorId:'producer-b',taskId:'task-fixture-b',role:'general',depth:1});
    duplicates.push(performance.now()-duplicateClock);assert.equal(repeated.every(a=>!a.created),true);
  }
  const summary=store.graphSummary();assert.equal(summary.assets,count);assert.equal(summary.assetRevisions,count);assert.equal(summary.assertions,count);assert.equal(summary.anchors,count);
  assert.equal(summary.relations,Math.floor((count-1)/4));assert.equal(store.assetView(ids[0]).counts.provenance,6);
  const barrier=store.sequence(), checkpointClock=performance.now(), checkpoint=store.checkpoint('native inert graph fixture'), checkpointMs=performance.now()-checkpointClock;
  const inspected=store.inspectCheckpoint(checkpoint.id);assert.equal(inspected.integrityStatus,'complete');assert.equal(checkpoint.asOfSequence,barrier);
  for(let i=0;i<count;i+=20) store.recordGraph({assets:[{asset:{...asset(i,true),expectedRevision:1}}]},{actorId:'producer-a',requestId:`update-${i}`,payload:{fixture:'graph',i}},{actorId:'producer-a',taskId:'task-fixture-a',role:'general',depth:1});
  const tail=[];let cursor=barrier;
  for(;;){const page=store.events({since:cursor,limit:100});tail.push(...page.rows);if(page.nextCursor===undefined)break;cursor=page.nextCursor;}
  assert.deepEqual(applyGraphEvents(inspected.snapshot.graph,tail),store.graphSnapshot());
  assert.equal(store.assetView(ids[0]).assertions[0].stale,true);
  const timings={page:[],view:[],export:[]}, responseBytes={};
  for(let round=0;round<32;round++)for(const [key,read] of [['page',()=>store.graphPage({limit:20})],['view',()=>store.assetView(ids[0],{limit:20})],['export',()=>store.graphExport({limit:200})]]){
    const clock=performance.now(), result=read();timings[key].push(performance.now()-clock);const bytes=Buffer.byteLength(JSON.stringify(result));
    assert.ok(bytes<=GRAPH_RESPONSE_BYTES,`${key} exceeds encoded response cap: ${bytes}`);responseBytes[key]=bytes;
  }
  const health=store.health();store.close();store=AssessmentStore.open(root,manifest.runId);
  assert.equal(store.graphSummary().assets,count);assert.equal(store.health().authorityRestored,false);
  assert.throws(()=>store.recordGraph({assets:[{asset:{kind:'file',key:'denied.ts'}}]}),/read-only/);
  const sqlite=new DatabaseSync(':memory:'),sqliteVersion=sqlite.prepare('SELECT sqlite_version() AS v').get().v;sqlite.close();
  console.log(JSON.stringify({node:process.version,sqlite:sqliteVersion,loader:source?'Pi dependency jiti/source TS':'compiled ESM',
    corpus:{assets:count,assertions:count,anchors:count,relations:summary.relations,producers:2,assetRevisions:count+Math.ceil(count/20),batchSize},
    performance:{commit:distribution(commits),sameContentSecondProducer:distribution(duplicates),page:distribution(timings.page),view:distribution(timings.view),export:distribution(timings.export),checkpointMs},
    responseBytes,storage:health,rssBytes:process.memoryUsage().rss,hardware:{platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem()},runtimeIntegrated:false,
    limitations:['Synthetic store-only corpus; not UI/Planner/context or assessment acceptance','No ARTEX execution/comparison','No paid/provider/worker/target activity','No effectiveness, savings, finding correctness or global optimality claim']}));
} finally { store?.close();await rm(root,{recursive:true,force:true}); }
