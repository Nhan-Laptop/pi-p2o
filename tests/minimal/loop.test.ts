import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile, readFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecord, readLedger, ledgerPage, summarizeRecords, type AssessmentRecord } from '../../src/records.js';
import { EvidenceStore, type Candidate } from '../../src/evidence.js';
import { persistReport, recoverReports, reportProjection } from '../../src/report.js';
import { TaskBoard, taskCapsule, type TaskDraft } from '../../src/tasks.js';
import { ProgressState } from '../../src/progress.js';

async function fixture(work: (root:string,path:string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(),'p2o-loop-'));
  try { const path=join(root,'records.jsonl'); await appendRecord(path,{runId:'run-test',by:'owner',at:'2030',kind:'lifecycle',text:'test start'}); await work(root,path); }
  finally { await rm(root,{recursive:true,force:true}); }
}
const draft = (id:string,patch:Partial<TaskDraft>={}):TaskDraft => ({id,question:'Does the observed gate protect the consumer?',surface:'/surface',risk:'authorization',role:'discovery',roleReason:'Lead selected a concrete boundary question',expectedTrue:'Consumer receives permitted actor only',expectedFalse:'Consumer receives an unpermitted actor',stopCondition:'Stop after the contrasting observation or missing prerequisite',evidenceIds:[],prerequisites:[],method:{skills:[],reason:'Bounded offline trace'},...patch});
const candidate = (receipt:string,patch:Partial<Candidate>={}):Candidate => ({candidate:'gate',surface:'/surface',risk:'authorization',closure:'confirmed',execution:'tested',proof:'offline_reproduction',evidenceRefs:[receipt],negativeControls:[],limitations:'Inert fixture, not security proof',policyBasis:'boundary_invariant',expectedPolicy:'Only the declared principal reaches the consumer',...patch});
const result={code:0,stdout:'fixture observation',stderr:'',truncated:false};

describe('complete bounded state and report integrity',()=>{
  it('retains old evidence and unresolved work past 100/500/10000; traverses every page and exports every row',async()=>fixture(async(root,path)=>{
    const store=new EvidenceStore('run-test',path,'fixture'); const receipt=await store.receipt('owner','shell','fixture',result,'2030');
    await appendRecord(path,{id:'old-open',runId:'run-test',by:'owner',at:'2030',kind:'open',text:'old unanswered question'});
    const rows=Array.from({length:10100},(_,i)=>JSON.stringify({version:2,id:`note-${i}`,runId:'run-test',by:'owner',at:'2030',kind:'note',text:`row ${i}`}));
    await appendFile(path,rows.join('\n')+'\n');
    const index=await readLedger(path,'run-test'); expect(index.complete).toBe(true);expect(index.byId.has(receipt)).toBe(true);
    expect(summarizeRecords(index.records).open[0].id).toBe('old-open');
    let cursor=0,total=0;for(;;){const page=ledgerPage(index,{cursor,limit:100});total+=page.records.length;if(page.nextCursor===undefined)break;expect(page.nextCursor).toBeGreaterThan(cursor);cursor=page.nextCursor;}
    expect(total).toBe(index.records.length);
    await store.candidate('owner',candidate(receipt,{resolves:['old-open']}));
    const output=JSON.parse(await readFile(await store.exportTo(root,{}),'utf8'));expect(output.records.length).toBe(index.records.length+1);expect(output.reconciliation.complete).toBe(true);
  }));
  it('excludes explicit foreign runs; diagnoses duplicate IDs, damage and resource bounds rather than asserting completeness',async()=>fixture(async(_root,path)=>{
    await appendRecord(path,{runId:'foreign',id:'foreign',by:'owner',at:'2030',kind:'open',text:'not this run'});
    let index=await readLedger(path,'run-test');expect(index.foreign).toBe(1);expect(index.byId.has('foreign')).toBe(false);expect(index.complete).toBe(true);
    await appendRecord(path,{id:'duplicate',by:'owner',at:'2030',kind:'note',text:'one'});
    await appendRecord(path,{id:'duplicate',by:'owner',at:'2030',kind:'note',text:'two'});
    await appendFile(path,'{"damaged":');index=await readLedger(path,'run-test');expect(index.complete).toBe(false);expect(index.issueCount).toBeGreaterThan(0);
    await expect(new EvidenceStore('run-test',path,'fixture').candidate('owner',candidate('missing'))).rejects.toThrow('incomplete');
  }));
  it('bounds Unicode pages by bytes and rejects invalid cursors',async()=>fixture(async(_root,path)=>{
    for(let i=0;i<20;i++)await appendRecord(path,{by:'owner',at:'2030',kind:'note',text:'観'.repeat(3000)});
    const index=await readLedger(path); const page=ledgerPage(index,{cursor:0,limit:100});expect(page.records.length).toBeLessThan(20);expect(page.truncated).toBe(true);expect(page.nextCursor).toBe(page.records.length);
    expect(()=>ledgerPage(index,{cursor:-1})).toThrow();
  }));
  it('splits a full normalized report under append limits and freezes current state; missing parts remain explicit',async()=>fixture(async(_root,path)=>{
    const report={summary:'observed partial state',findings:['観'.repeat(900),...Array(19).fill('x'.repeat(900))],evidence:['receipt'],coverage:[],openItems:['pending control'],confidence:'low' as const,blocked:'missing prerequisite',outcome:'prerequisite-blocked' as const};
    await persistReport(path,'run-test','worker',report);
    const index=await readLedger(path,'run-test');const recovered=recoverReports(index);expect(recovered.reports[0].report).toEqual(report);expect(recovered.diagnostics).toEqual([]);
    expect(index.records.every(r=>Buffer.byteLength(JSON.stringify(r))<16*1024)).toBe(true);
    const frozen=reportProjection(index);expect(frozen.counts.reports).toBe(1);expect(frozen.complete).toBe(true);
    index.byId.delete(index.records.find(r=>r.kind==='report_part')!.id!);expect(reportProjection(index).complete).toBe(false);
    await appendRecord(path,{runId:'run-test',by:'worker',at:'2030',kind:'report_part',text:'orphan',data:{reportId:'absent'}});expect(recoverReports(await readLedger(path)).diagnostics.join(' ')).toContain('Uncommitted');
  }));
  it('retains report framing/hashes across redacted export without suppressing ordinary data redaction',async()=>fixture(async(root,path)=>{
    const report={summary:'Authorization: fixture-secret',findings:['password=fixture-secret'],evidence:[],coverage:[],openItems:[],confidence:'low' as const};
    await persistReport(path,'run-test','worker',report);
    const store=new EvidenceStore('run-test',path,'fixture');const output=JSON.parse(await readFile(await store.exportTo(root,{}),'utf8'));
    expect(JSON.stringify(output)).not.toContain('fixture-secret');
    const index=await readLedger(path);index.records=output.records;index.byId=new Map(output.records.map((r:AssessmentRecord)=>[r.id,r]));
    expect(recoverReports(index).diagnostics).toEqual([]);expect(recoverReports(index).reports[0].report.summary).toContain('REDACTED');
  }));
  it('reports byte/row integrity limits and does not use a resource-limited tail',async()=>fixture(async(_root,path)=>{
    const file=await open(path,'r+');try{await file.truncate(65*1024*1024);}finally{await file.close();}
    const index=await readLedger(path,'run-test');expect(index.complete).toBe(false);expect(index.records).toHaveLength(0);expect(index.diagnostics.join(' ')).toContain('64 MiB');
  }));
  it('rejects withdrawn independent validation while retaining prior history',async()=>fixture(async(_root,path)=>{
    const store=new EvidenceStore('run-test',path,'fixture');const independent=await store.receipt('validator','shell','fixture',result,'2030');
    const a=await store.candidate('validator',candidate(independent));
    const b=await store.candidate('owner',candidate(independent,{supersedes:a.id,independentEvidenceRef:independent}));
    const c=await store.candidate('validator',candidate(independent,{supersedes:b.id,closure:'open_proof_gap',execution:'not_tested',proof:'static_trace'}));
    await expect(store.candidate('owner',candidate(independent,{supersedes:c.id,independentEvidenceRef:independent}))).rejects.toThrow('own demonstrated claim');
    expect((await readLedger(path)).records.filter(r=>r.kind==='candidate')).toHaveLength(3);
  }));
});

describe('owner-maintained tasks and context, not autonomous dispatch',()=>{
  it('serializes competing assignments and releases blocked work',async()=>fixture(async(_root,path)=>{
    const board=new TaskBoard('run-test',path,()=>true,()=>0);
    await board.create(draft('task-a'));await board.create(draft('task-b'));
    const results=await Promise.allSettled([board.reserve('task-a','worker-a'),board.reserve('task-b','worker-b')]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    await board.transition('task-a','blocked','Spawn failed; reservation withdrawn');await board.reserve('task-b','worker-b');
    await board.transition('task-b','running','Worker launch registered');await board.assertReady('worker-b');
    await board.releaseAll('human stop');await expect(board.assertReady('worker-b')).rejects.toThrow('running');
  }));
  it('accepts same-run evidence, rejects stale dependencies and supports explicit independent overlap',async()=>fixture(async(_root,path)=>{
    const board=new TaskBoard('run-test',path,()=>true,()=>0),store=new EvidenceStore('run-test',path,'fixture');
    const ref=await store.receipt('owner','shell','fixture',result,'2030');await board.create(draft('prior'));await board.reserve('prior','owner');await board.transition('prior','running','Lead inspecting gate');
    await expect(board.transition('prior','reviewed','Review without evidence')).rejects.toThrow('receipts');
    const accepted=await board.transition('prior','reviewed','Lead accepts this bounded offline prerequisite',[ref]);
    const discovery=await board.create(draft('new-discovery',{prerequisites:[{taskId:'prior',revision:accepted.revision}]}));await board.reserve(discovery.id,'worker');await board.transition(discovery.id,'running','Bounded discovery running');
    const validation=await board.create(draft('independent',{role:'validation',validationOf:'prior',prerequisites:[{taskId:'prior',revision:accepted.revision}]}));await board.reserve(validation.id,'validator');
    await board.revise('prior',accepted.revision,draft('prior',{question:'Revised evidence changes the original gate question'}));
    // P10/TR-H10: per-command readiness is structural, so a prerequisite revision does not freeze the dependent worker mid-task;
    // it is refused at the next admission/readiness instead (see frontier.test.ts).
    await expect(board.assertReady('worker')).resolves.toBeUndefined();
    expect(taskCapsule(await board.forWorker('worker'))).toContain('P2O OBJECTIVE STATE');
  }));
  it('rejects cycles, foreign evidence, authority injection and stopped-run replay, not elapsed time',async()=>fixture(async(_root,path)=>{
    let active=true,time=0;const board=new TaskBoard('run-test',path,()=>active,()=>time);
    await expect(board.create({...draft('bad'),deadline:2000} as any)).rejects.toThrow('authority');
    await expect(board.create(draft('bad',{evidenceIds:['foreign']}))).rejects.toThrow('same-run');
    await board.create(draft('one'));await board.reserve('one','owner');await board.transition('one','running','Lead bounded observation');
    const store=new EvidenceStore('run-test',path,'fixture');const ref=await store.receipt('owner','shell','fixture',result,'2030');const a=await board.transition('one','reviewed','Accepted known-good baseline',[ref]);
    const two=await board.create(draft('two',{surface:'/other',prerequisites:[{taskId:'one',revision:a.revision}]}));await board.reserve(two.id,'owner');await board.transition(two.id,'running','Second bounded observation');const b=await board.transition(two.id,'reviewed','Accepted another baseline',[ref]);
    await expect(board.revise('one',a.revision,draft('one',{prerequisites:[{taskId:'two',revision:b.revision}]}))).rejects.toThrow('cycle');
    time=365*24*60*60*1000;await expect(board.create(draft('three',{surface:'/third'}))).resolves.toMatchObject({status:'proposed'});
    active=false;await expect(board.reserve('three','worker')).rejects.toThrow('inactive');
    await board.releaseAll('Owner revoked the run');
  }));
  it('blocks declared missing prerequisites and requires the reviewed revision for validation overlap',async()=>fixture(async(_root,path)=>{
    const board=new TaskBoard('run-test',path,()=>true,()=>0);
    const task=await board.create(draft('blocked',{missingPrerequisites:['Authenticated transport is unavailable under this scope']}));expect(task.status).toBe('blocked');
    await expect(board.reserve(task.id,'worker')).rejects.toThrow('available');
    await expect(board.transition(task.id,'reviewed','Pretend transport exists',['unknown'])).rejects.toThrow('prerequisites');
    expect(taskCapsule(task)).toContain('missingPrerequisites');
  }));
  it('diagnoses quiet queued/running states without interpreting silence or starting work',()=>{
    let time=0;const progress=new ProgressState(()=>time);expect(progress.view('worker').state).toBe('unknown');
    progress.record('worker','queued','shell');time=100;expect(progress.view('worker',10).stallSuspected).toBe(true);expect(progress.view('worker').state).toBe('queued');
    progress.record('worker','running','shell');progress.record('worker','returned','shell');time=1000000;expect(progress.view('worker',10).stallSuspected).toBe(false);expect(progress.view('worker').commandsSubmitted).toBe(1);
  });
});
