import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssessmentStore, type StoreFault } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { CoverageBoard, type CoveragePlanView } from '../../src/coverage.js';
import type { CoverageCellDraft, CoveragePlanDraft } from '../../src/coverage-types.js';
import { CaseBoard } from '../../src/cases.js';
import type { CaseDraft, CaseEntry } from '../../src/case-types.js';
import { TaskBoard, type TaskDraft } from '../../src/tasks.js';
import { readLedger, type AssessmentRecord } from '../../src/records.js';
import { prepareReport, reportProjection } from '../../src/report.js';
import { finishPreflight } from '../../src/finish-preflight.js';

const runId='run-coverage';
async function fixture(work:(h:{store:AssessmentStore;coverage:CoverageBoard;cases:CaseBoard;tasks:TaskBoard;assetId:string;asset2:string;path:string;receipt:(by:string)=>string;claim:(closure?:string,supersedes?:string)=>string;acceptedCase:(verdict?:'confirmed'|'ruled_out')=>Promise<CaseEntry>;reviewedTask:()=>Promise<{id:string;revision:number;evidenceId:string}>;views:()=>Promise<CoveragePlanView[]>})=>Promise<void>,fault?:StoreFault){
 const root=await mkdtemp(join(tmpdir(),'p2o-coverage-')),store=AssessmentStore.create(root,{runId,retention:'durable-local',targetKind:'directory',targetIdentity:'fixture',targetDisplay:'fixture',profile:{runtimeHash:'fixture',image:'fixture',loopMode:'manual',executorMode:'shared'}},{fault}),path=join(root,'alias.sqlite'),unbind=bindAssessmentStore(path,store);
 const [assetId,asset2]=store.recordGraph({assets:[{asset:{kind:'endpoint',key:'GET /a'}},{asset:{kind:'endpoint',key:'GET /b'}}]}).map(row=>row.entityId),caseContext={assetRevision:(id:string)=>store.assetRevision(id),assertionRevision:(id:string)=>store.assertionRevision(id)},coverageContext={...caseContext,targetRevision:()=>store.graphScope(),assetIds:()=>store.assetEntityIds()},cases=new CaseBoard(runId,path,()=>true,caseContext),coverage=new CoverageBoard(runId,path,()=>true,coverageContext),tasks=new TaskBoard(runId,path,()=>true,Date.now,()=>store.graphScope(),id=>store.assetRevision(id));
 const receipt=(by:string)=>store.commitRecords([{id:randomUUID(),runId,at:'2030',by,workerId:by==='owner'?undefined:by,kind:'evidence',text:'Inert coverage receipt'}])[0].recordId;
 let latest:string|undefined;const claim=(closure='confirmed',supersedes=latest)=>{const evidence=receipt('worker-a'),record:AssessmentRecord={id:randomUUID(),runId,at:'2030',by:'worker-a',workerId:'worker-a',kind:'candidate',text:'Bounded claim',surface:'/a',risk:'authorization',outcome:closure as any,refs:[evidence],supersedes,data:{candidate:'coverage-claim',closure,execution:closure==='confirmed'?'tested':'not_tested',proof:closure==='confirmed'?'offline_reproduction':'static_trace',evidenceRefs:[evidence],negativeControls:closure==='ruled_out'?[evidence]:[],control:closure==='ruled_out'?'Fixture control':'',limitations:'Only fixture actor/object tested',policyBasis:'boundary_invariant',expectedPolicy:'Fixture access boundary'}};store.commitRecords([record]);return latest=record.id!;};
 const editable=(entry:CaseEntry):CaseDraft=>{const {runId:_,revision:__,recordId:___,...draft}=entry;return draft;};
 const acceptedCase=async(verdict:'confirmed'|'ruled_out'='confirmed')=>{const claimId=claim(verdict),draft:CaseDraft={title:'Coverage case',policyKey:'policy:coverage',rootCauseKey:verdict==='confirmed'?'root:gate':'root:effective-control',assetRefs:[{id:assetId,revision:store.assetRevision(assetId)!}],claimRefs:[claimId],independentEvidenceRefs:[],taskRefs:[],reportRefs:[],contradictions:[],affectedVariants:['variant:a'],relatedCaseIds:[],verdict,reviewStatus:'pending',reviewReason:'Pending exact support review',limitations:'Bounded fixture only',remediation:{status:'unplanned',reason:'No remediation review applies to this fixture',evidenceRefs:[]}},created=await cases.create(draft);return cases.revise(created.id,1,{...editable(created),reviewStatus:'accepted',reviewReason:'Owner accepted exact bounded support and limitations'});};
 const reviewedTask=async()=>{const input:TaskDraft={question:'Did the bounded fixture observation execute?',surface:'/a',risk:'authorization',role:'general',roleReason:'Coverage fixture task only',expectedTrue:'Receipt records the expected observation',expectedFalse:'Receipt records the control result',stopCondition:'Stop after one inert observation and owner review',evidenceIds:[],prerequisites:[],method:{skills:[],reason:'Inert fixture method without target activity'}},task=await tasks.create(input);await tasks.reserve(task.id,'owner');await tasks.transition(task.id,'running','Owner began inert coverage fixture');const evidenceId=receipt('owner'),reviewed=await tasks.transition(task.id,'reviewed','Owner reviewed the bounded receipt',[evidenceId]);return {id:reviewed.id,revision:reviewed.revision,evidenceId};};
 try{await work({store,coverage,cases,tasks,assetId,asset2,path,receipt,claim,acceptedCase,reviewedTask,views:()=>coverage.list()});}finally{unbind();store.close();await rm(root,{recursive:true,force:true});}
}
const plan=(overrides:Partial<CoveragePlanDraft>={}):CoveragePlanDraft=>({title:'Declared authorization matrix',status:'active',reason:'Explicit bounded denominator for the fixture plan',exclusions:['No undeclared actors or routes'],unknownScope:['Deployment parity outside fixture is unknown'],...overrides});
const cell=(assetId:string,overrides:Partial<CoverageCellDraft>={}):CoverageCellDraft=>({assetRef:{id:assetId,revision:1},questionKey:'question:object-access',policyKey:'policy:coverage',actorContext:'actor:a',tenantContext:'tenant:a',methodFamily:'offline-observation',execution:'planned',assessment:'unreviewed',taskRefs:[],claimRefs:[],caseRefs:[],evidenceRefs:[],negativeControlRefs:[],gapRefs:[],reason:'This cell is explicitly planned but not yet tested',limitations:'No inference beyond the declared actor and asset variant',...overrides});

describe('proof-aware coverage plan and denominator (K5)',()=>{
 it('records an explicit plan-version denominator and discovered-but-unplanned assets without claiming clean',async()=>fixture(async({coverage,assetId})=>{const created=await coverage.createPlan(plan()),added=await coverage.addCell(created.id,created.revision,cell(assetId)),view=(await coverage.list())[0];expect(added.plan).toMatchObject({revision:2,cellIds:[added.cell.id]});expect(view).toMatchObject({revision:2,counts:{execution:{planned:1},assessment:{unreviewed:1},stale:0,reviewed:0},discoveredUnplannedAssets:1});expect(view.warning).toContain('never imply clean');}));
 it('requires reviewed receipts for tested cells and a current accepted case for accepted assessment',async()=>fixture(async({coverage,assetId,reviewedTask,acceptedCase})=>{const p=await coverage.createPlan(plan()),task=await reviewedTask(),accepted=await acceptedCase(),tested=cell(assetId,{execution:'tested',assessment:'accepted',taskRefs:[{taskId:task.id,revision:task.revision}],evidenceRefs:[task.evidenceId],caseRefs:[{caseId:accepted.id,revision:accepted.revision}],reason:'Reviewed task receipt and case support this bounded cell'}),added=await coverage.addCell(p.id,p.revision,tested),view=(await coverage.list())[0];expect(added.cell).toMatchObject({execution:'tested',assessment:'accepted'});expect(view.cells[0]).toMatchObject({currentness:'current',effectiveAssessment:'accepted',reviewed:true});}));
 it('never turns blocked or untested work into clean/accepted coverage',async()=>fixture(async({coverage,assetId,store})=>{const p=await coverage.createPlan(plan()),gap=store.commitRecords([{id:randomUUID(),runId,at:'2030',by:'owner',kind:'open',text:'Missing actor fixture'}])[0].recordId;await expect(coverage.addCell(p.id,p.revision,cell(assetId,{execution:'blocked',assessment:'unreviewed'}))).rejects.toThrow('open gap');const added=await coverage.addCell(p.id,p.revision,cell(assetId,{execution:'blocked',assessment:'open_gap',gapRefs:[gap],reason:'Blocked until the declared second actor fixture exists'}));expect((await coverage.list())[0].cells[0]).toMatchObject({execution:'blocked',effectiveAssessment:'open_gap',reviewed:false});await expect(coverage.revisePlan(p.id,added.plan.revision,plan({status:'closed',reason:'Plan closed partial with a retained blocker, not clean'}))).resolves.toMatchObject({status:'closed'});}));
 it('downgrades accepted cells to stale when case support or asset revision changes',async()=>fixture(async({coverage,assetId,acceptedCase,reviewedTask,claim,store})=>{const p=await coverage.createPlan(plan()),task=await reviewedTask(),accepted=await acceptedCase(),added=await coverage.addCell(p.id,p.revision,cell(assetId,{execution:'tested',assessment:'accepted',taskRefs:[{taskId:task.id,revision:task.revision}],evidenceRefs:[task.evidenceId],caseRefs:[{caseId:accepted.id,revision:accepted.revision}],reason:'Current reviewed fixture support'}));expect((await coverage.list())[0].cells[0].reviewed).toBe(true);claim('open_proof_gap');let stale=(await coverage.list())[0].cells[0];expect(stale).toMatchObject({currentness:'stale',effectiveAssessment:'stale',reviewed:false});expect(stale.staleReasons).toContain(`stale-case:${accepted.id}`);store.recordGraph({assets:[{asset:{kind:'endpoint',key:'GET /a',label:'changed revision',expectedRevision:1}}]});stale=(await coverage.list())[0].cells[0];expect(stale.staleReasons).toContain(`stale-asset:${assetId}@r1->r2`);expect(added.plan.cellIds).toHaveLength(1);}));
 it('requires bounded controls for ruled-out cells and preserves separate execution/assessment axes',async()=>fixture(async({coverage,assetId,acceptedCase,reviewedTask,receipt})=>{const p=await coverage.createPlan(plan()),task=await reviewedTask(),ruled=await acceptedCase('ruled_out'),control=receipt('worker-control');await expect(coverage.addCell(p.id,p.revision,cell(assetId,{execution:'tested',assessment:'ruled_out_bounded',taskRefs:[{taskId:task.id,revision:task.revision}],evidenceRefs:[task.evidenceId],caseRefs:[{caseId:ruled.id,revision:ruled.revision}],reason:'Attempted bounded ruled-out result without a negative control'}))).rejects.toThrow('negative controls');const added=await coverage.addCell(p.id,p.revision,cell(assetId,{execution:'tested',assessment:'ruled_out_bounded',taskRefs:[{taskId:task.id,revision:task.revision}],evidenceRefs:[task.evidenceId],negativeControlRefs:[control],caseRefs:[{caseId:ruled.id,revision:ruled.revision}],reason:'Specific control bounds the ruled-out result'}));expect((await coverage.list())[0].counts).toMatchObject({execution:{tested:1},assessment:{ruled_out_bounded:1}});expect(added.cell.assessment).toBe('ruled_out_bounded');}));
 it('changes the denominator atomically, retains retired history and rejects exact duplicate cells',async()=>fixture(async({coverage,assetId,store})=>{const p=await coverage.createPlan(plan()),first=await coverage.addCell(p.id,p.revision,cell(assetId));await expect(coverage.addCell(p.id,first.plan.revision,cell(assetId,{id:'coverage-cell-other'}))).rejects.toThrow('Duplicate exact');const before=store.records().length,retired=await coverage.retireCell(first.cell.id,1,'Cell was replaced by an explicitly versioned target revision');expect(retired.plan.cellIds).toEqual([]);expect(retired.cell).toMatchObject({retired:true,revision:2});expect(store.records().length).toBe(before+2);expect((await coverage.list())[0]).toMatchObject({cells:[],omittedCells:0});expect(store.events({since:0,limit:100}).rows.filter(event=>event.kind==='coverage.revised').length).toBeGreaterThanOrEqual(4);}));
 it('builds a bounded final report index with unique cases/coverage and does not count repeated handoff delivery as findings',async()=>fixture(async({coverage,assetId,path,store,acceptedCase})=>{const accepted=await acceptedCase(),planEntry=await coverage.createPlan(plan()),packet=await coverage.addCell(planEntry.id,planEntry.revision,cell(assetId,{execution:'attempted',assessment:'confirmed_claim',claimRefs:accepted.claimRefs,caseRefs:[{caseId:accepted.id,revision:accepted.revision}],evidenceRefs:[],reason:'Attempted claim remains separate from owner-accepted finding review'}));
    for(let i=0;i<2;i++)store.commitRecords(prepareReport(runId,'worker-report',{summary:'Repeated attributed delivery '+i,findings:['same textual claim'],evidence:[],coverage:[],openItems:[],confidence:'low',outcome:'completed'}).records);
    const context={assetRevision:(id:string)=>store.assetRevision(id),assertionRevision:(id:string)=>store.assertionRevision(id)},projection=reportProjection(await readLedger(path,runId),{cases:context,coverage:{...context,targetRevision:()=>store.graphScope(),assetIds:()=>store.assetEntityIds()}});expect(projection.counts).toMatchObject({reports:1,reportHistory:2,cases:1,uniqueAcceptedFindings:1,duplicateCases:0,coveragePlans:1,coverageCells:1});expect(projection.cases).toHaveLength(1);expect(projection.coveragePlans[0]).toMatchObject({id:packet.plan.id,cellCount:1});expect(projection.reports[0].findings).toBe(1);
  }));
 it('rolls back a whole plan+cell packet before commit and replays a committed packet without duplicate denominator effects',async()=>{let mode:'before'|'after'|undefined;await fixture(async({coverage,assetId,store})=>{const planEntry=await coverage.createPlan(plan()),beforeRecords=store.records().length,beforeSequence=store.sequence(),firstRequest={actorId:'owner',requestId:'coverage-before',payload:{transport:'before'}};mode='before';await expect(coverage.addCell(planEntry.id,1,cell(assetId,{questionKey:'question:before'}),firstRequest)).rejects.toThrow('coverage before commit');expect(store.records()).toHaveLength(beforeRecords);expect(store.sequence()).toBe(beforeSequence);expect((await coverage.list())[0]).toMatchObject({revision:1,cellIds:[]});
    const request={actorId:'owner',requestId:'coverage-after',payload:{transport:'after'}};mode='after';await expect(coverage.addCell(planEntry.id,1,cell(assetId,{questionKey:'question:after'}),request)).rejects.toThrow('coverage after commit');expect(store.records().filter(row=>row.data?.coverageCell)).toHaveLength(1);const committed=store.sequence(),replay=await coverage.addCell(planEntry.id,1,cell(assetId,{questionKey:'question:after'}),request);expect(replay.plan.revision).toBe(2);expect(store.sequence()).toBe(committed);expect(store.records().filter(row=>row.data?.coverageCell)).toHaveLength(1);
  },stage=>{if(mode==='before'&&stage==='before-commit'){mode=undefined;throw Error('coverage before commit');}if(mode==='after'&&stage==='after-commit'){mode=undefined;throw Error('coverage after commit');}});});
 it('uses retained mutation ACKs and atomic plan heads under concurrent writers',async()=>fixture(async({coverage,assetId,path,store})=>{const request={actorId:'owner',requestId:'coverage-plan',payload:{transport:'same'}},created=await coverage.createPlan(plan(),request),sequence=store.sequence(),replay=await coverage.createPlan(plan(),request);expect(replay.recordId).toBe(created.recordId);expect(store.sequence()).toBe(sequence);await expect(coverage.createPlan(plan({title:'Changed title'}),request)).rejects.toThrow('IDEMPOTENCY_CONFLICT');const other=new CoverageBoard(runId,path,()=>true,{targetRevision:()=>store.graphScope(),assetRevision:id=>store.assetRevision(id),assertionRevision:id=>store.assertionRevision(id),assetIds:()=>store.assetEntityIds()}),results=await Promise.allSettled([coverage.addCell(created.id,1,cell(assetId,{questionKey:'question:a'})),other.addCell(created.id,1,cell(assetId,{questionKey:'question:b'}))]);expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect((await coverage.list())[0].cellIds).toHaveLength(1);}));
});

/**
 * M5 (interrupt honesty): a task that ends without a verdict may not carry the verdict its cell asserts. The writer refuses the
 * dishonest revision with the task and its state named; the view downgrades a stored verdict nobody can support, so an opened
 * old run cannot read as tested; the preflight names the cell under its own code so the report can say what to re-dispatch.
 */
describe('interrupted tasks never count as tested coverage (M5)', () => {
  it('refuses a tested or verified cell whose cited task ended blocked, naming the task and its state', async () => fixture(async ({coverage, tasks, assetId, store, receipt}) => {
    const p = await coverage.createPlan(plan());
    const draft: TaskDraft = { question: 'Can the bounded fixture be observed?', surface: '/a', risk: 'authorization', role: 'general',
      roleReason: 'Interrupt fixture only', expectedTrue: 'The receipt records the observation', expectedFalse: 'The receipt records the control',
      stopCondition: 'Stop after one inert observation', evidenceIds: [], prerequisites: [],
      method: { skills: [], reason: 'Inert fixture method without target activity' } } as TaskDraft;
    const created = await tasks.create(draft);
    await tasks.reserve(created.id, 'owner');
    await tasks.transition(created.id, 'running', 'Owner began the inert interrupt fixture');
    const blockedAt = await tasks.transition(created.id, 'blocked', 'Blocked on an unavailable prerequisite during the fixture', [receipt('owner')]);
    const gap = store.commitRecords([{ id: randomUUID(), runId, at: '2030', by: 'owner', kind: 'open', text: 'Interrupted cell needs another attempt' }])[0].recordId;
    const cited = cell(assetId, { execution: 'tested', assessment: 'open_gap', taskRefs: [{ taskId: created.id, revision: blockedAt.revision }], evidenceRefs: [receipt('owner')], gapRefs: [gap] });
    await expect(coverage.addCell(p.id, p.revision, cited))
      .rejects.toThrow(/INTERRUPT_NOT_EVIDENCE: task .* ended as blocked without a verdict; cell question:object-access stays attempted, not tested/);
    // A ruled-out assessment rests on the same impossible verdict, so it is refused by the same rule.
    await expect(coverage.addCell(p.id, p.revision, cell(assetId, { execution: 'attempted', assessment: 'ruled_out_bounded', taskRefs: [{ taskId: created.id, revision: blockedAt.revision }], evidenceRefs: [receipt('owner')], negativeControlRefs: [receipt('owner')], gapRefs: [gap] })))
      .rejects.toThrow(/INTERRUPT_NOT_EVIDENCE/);
    // The honest version is accepted: an attempt, an open gap, and a reason.
    const added = await coverage.addCell(p.id, p.revision, cell(assetId, { execution: 'attempted', assessment: 'open_gap', taskRefs: [{ taskId: created.id, revision: blockedAt.revision }], gapRefs: [gap] }));
    expect(added.cell.execution).toBe('attempted');
    const views = await coverage.list();
    expect(views[0].counts.execution).toMatchObject({ attempted: 1 });
    expect(views[0].counts.assessment).toMatchObject({ open_gap: 1 });
  }));

  it('downgrades a stored verdict to attempted/open_gap and reports it as the interrupted cell it is', async () => fixture(async ({coverage, tasks, assetId, store, receipt, path}) => {
    const p = await coverage.createPlan(plan());
    const draft: TaskDraft = { question: 'Can the bounded fixture be observed?', surface: '/a', risk: 'authorization', role: 'general',
      roleReason: 'Interrupt fixture only', expectedTrue: 'The receipt records the observation', expectedFalse: 'The receipt records the control',
      stopCondition: 'Stop after one inert observation', evidenceIds: [], prerequisites: [],
      method: { skills: [], reason: 'Inert fixture method without target activity' } } as TaskDraft;
    const created = await tasks.create(draft);
    await tasks.reserve(created.id, 'owner');
    await tasks.transition(created.id, 'running', 'Owner began the inert interrupt fixture');
    const evidenceId = receipt('owner');
    const honest = await coverage.addCell(p.id, p.revision, cell(assetId, { execution: 'planned', assessment: 'unreviewed', taskRefs: [{ taskId: created.id, revision: created.revision }] }));
    const blockedAt = await tasks.transition(created.id, 'blocked', 'Blocked after the cell was written', [evidenceId]);
    // A run written before M5 (or a writer that bypassed the board) can still hold a verdict no task supports. Store it directly.
    const { recordId: _record, ...stored } = { ...honest.cell, execution: 'tested' as const, assessment: 'confirmed_claim' as const, taskRefs: [{ taskId: created.id, revision: blockedAt.revision }], evidenceRefs: [evidenceId], claimRefs: [] };
    store.commitRecords([{ id: randomUUID(), runId, at: '2030', by: 'owner', kind: 'note', text: `coverage cell ${stored.id}@r${stored.revision + 1}: unsupported verdict retained for the fixture`, supersedes: honest.cell.recordId, data: { coverageCell: { ...stored, revision: stored.revision + 1 } } }]);
    const views = await coverage.list();
    const view = views[0].cells[0];
    expect(view.execution).toBe('tested');                 // what was stored
    expect(view.effectiveExecution).toBe('attempted');     // what the cited task supports
    expect(view.effectiveAssessment).toBe('open_gap');
    expect(view.currentness).toBe('stale');
    expect(view.staleReasons.some(reason => reason.startsWith('interrupted-task:'))).toBe(true);
    expect(view.reviewed).toBe(false);
    // The backlog counts the direction as unattempted-but-open, never as tested.
    expect(views[0].counts.execution).toMatchObject({ attempted: 1 });
    expect(views[0].counts.assessment).toMatchObject({ open_gap: 1 });
    // And the finish check names it, so the report says what to re-dispatch.
    const index = await readLedger(path, runId);
    const interrupted = finishPreflight(index, { cases: { assetRevision: () => undefined }, coverage: { targetRevision: () => 'fixture', assetRevision: () => 1 }, integrity: 'annotate' }).advisory.find(item => item.code === 'INTERRUPTED_CELL');
    expect(interrupted).toMatchObject({ count: 1, ids: [view.id] });
    expect(interrupted?.message).toContain('stays attempted');
  }));
});
