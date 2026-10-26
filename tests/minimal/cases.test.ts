import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssessmentStore, type StoreFault } from '../../src/state/store.js';
import { bindAssessmentStore } from '../../src/state/adapter.js';
import { CaseBoard, caseViews, type CaseView } from '../../src/cases.js';
import type { CaseDraft, CaseEntry } from '../../src/case-types.js';
import { readLedger, type AssessmentRecord } from '../../src/records.js';

const runId='run-cases';
// P14.12: a claim that names what it ran carries the payload sha256 and the environment recipe fingerprint stamped by the host.
const PAYLOAD='a'.repeat(64),FINGERPRINT='b'.repeat(64);
const replay={payloadSha256:PAYLOAD,environmentFingerprint:FINGERPRINT};
async function fixture(work:(h:{store:AssessmentStore;board:CaseBoard;assetId:string;path:string;receipt:(by:string)=>string;claim:(input:{by:string;candidate?:string;closure?:string;supersedes?:string;independentEvidenceRef?:string;evidenceRefs?:string[];payloadSha256?:string;environmentFingerprint?:string})=>string;views:()=>Promise<CaseView[]>})=>Promise<void>,fault?:StoreFault){
  const root=await mkdtemp(join(tmpdir(),'p2o-cases-')),store=AssessmentStore.create(root,{runId,retention:'durable-local',targetKind:'directory',targetIdentity:'fixture',targetDisplay:'fixture',profile:{runtimeHash:'fixture',image:'fixture',loopMode:'manual',executorMode:'shared'}},{fault}),path=join(root,'alias.sqlite'),unbind=bindAssessmentStore(path,store);
  const assetId=store.recordGraph({assets:[{asset:{kind:'endpoint',key:'GET /object'}}]})[0].entityId,context={assetRevision:(id:string)=>store.assetRevision(id),assertionRevision:(id:string)=>store.assertionRevision(id)},board=new CaseBoard(runId,path,()=>true,context);
  const receipt=(by:string)=>store.commitRecords([{id:randomUUID(),runId,at:'2030-01-01',by,workerId:by==='owner'?undefined:by,kind:'evidence',text:'Bounded inert receipt, not automatic finding proof'}])[0].recordId;
  const claim=(input:{by:string;candidate?:string;closure?:string;supersedes?:string;independentEvidenceRef?:string;evidenceRefs?:string[];payloadSha256?:string;environmentFingerprint?:string})=>{const candidate=input.candidate??'case-claim',closure=input.closure??'confirmed',evidenceRefs=input.evidenceRefs??[receipt(input.by)],record:AssessmentRecord={id:randomUUID(),runId,at:'2030-01-02',by:input.by,workerId:input.by==='owner'?undefined:input.by,kind:'candidate',text:'Attributed fixture claim',surface:'/object',risk:'authorization',outcome:closure as any,refs:evidenceRefs,supersedes:input.supersedes,data:{candidate,closure,execution:closure==='confirmed'?'tested':'not_tested',proof:closure==='confirmed'?'offline_reproduction':'static_trace',evidenceRefs,negativeControls:[],limitations:'Fixture limitations remain explicit',policyBasis:'boundary_invariant',expectedPolicy:'Declared fixture boundary',...(input.independentEvidenceRef?{independentEvidenceRef:input.independentEvidenceRef}:{}),...(input.payloadSha256?{payloadSha256:input.payloadSha256}:{}),...(input.environmentFingerprint?{environmentFingerprint:input.environmentFingerprint}:{})}};store.commitRecords([record]);return record.id!;};
  try{await work({store,board,assetId,path,receipt,claim,views:async()=>caseViews(await readLedger(path,runId),context)});}finally{unbind();store.close();await rm(root,{recursive:true,force:true});}
}
function editable(entry:CaseEntry):CaseDraft{const {runId:_,revision:__,recordId:___,...draft}=entry;return draft;}
function draft(assetId:string,claimRef:string,overrides:Partial<CaseDraft>={}):CaseDraft{return {title:'Object boundary case',policyKey:'policy:object-access',rootCauseKey:'root:missing-owner-check',assetRefs:[{id:assetId,revision:1}],claimRefs:[claimRef],independentEvidenceRefs:[],taskRefs:[],reportRefs:[],contradictions:[],affectedVariants:['variant:read'],relatedCaseIds:[],verdict:'confirmed',reviewStatus:'pending',reviewReason:'Pending owner review of exact claim and evidence revisions',limitations:'Only the declared fixture actor and object variant were assessed',remediation:{status:'unplanned',reason:'No remediation has been reviewed or implemented',evidenceRefs:[]},...overrides};}

describe('canonical vulnerability cases and currentness (K5)',()=>{
  it('keeps Worker claims pending until an explicit owner revision accepts exact current support',async()=>fixture(async({board,assetId,claim})=>{
    const claimId=claim({by:'worker-a'}),created=await board.create(draft(assetId,claimId));expect(created).toMatchObject({revision:1,reviewStatus:'pending'});expect((await board.list())[0]).toMatchObject({currentness:'current',acceptedFinding:false,independentCurrent:false});
    const accepted=await board.revise(created.id,1,{...editable(created),reviewStatus:'accepted',reviewReason:'Owner reviewed current receipt, policy basis and bounded limitations'});expect(accepted.revision).toBe(2);
    expect((await board.list())[0]).toMatchObject({currentness:'current',acceptedFinding:true,canonicalCaseId:created.id});
  }));
  it('makes a reviewed case stale when its exact claim is revised or independent validator withdraws, and emits invalidation history',async()=>fixture(async({board,assetId,receipt,claim,store})=>{
    const independent=receipt('validator-a'),validator=claim({by:'validator-a',candidate:'validator-replay',evidenceRefs:[independent],...replay}),ownerClaim=claim({by:'owner',independentEvidenceRef:independent,evidenceRefs:[independent],...replay}),created=await board.create(draft(assetId,ownerClaim,{independentEvidenceRefs:[independent]}));
    await board.revise(created.id,1,{...editable(created),reviewStatus:'accepted',reviewReason:'Owner reviewed separate validator receipt and matching current claim'});expect((await board.list())[0]).toMatchObject({acceptedFinding:true,independentCurrent:true});
    claim({by:'validator-a',closure:'open_proof_gap',supersedes:ownerClaim,evidenceRefs:[independent]});const stale=(await board.list())[0];expect(stale.acceptedFinding).toBe(false);expect(stale.currentness).toBe('stale');expect(stale.staleReasons).toEqual(expect.arrayContaining([expect.stringContaining('superseded-claim'),expect.stringContaining('independent-receipt-withdrawn')]));
    expect(store.events({since:0,limit:100}).rows.some(event=>event.kind==='support.invalidated'&&event.payloadRefs.includes(stale.recordId))).toBe(true);
  }));
  it('retains contradictions and refuses accepted review until each is explicitly resolved',async()=>fixture(async({board,assetId,claim,receipt})=>{
    const claimId=claim({by:'worker-a'}),counter=receipt('worker-b'),created=await board.create(draft(assetId,claimId,{contradictions:[{evidenceRef:counter,status:'open',reason:'Control receipt conflicts with the claimed effect and needs review'}]}));
    await expect(board.revise(created.id,1,{...editable(created),reviewStatus:'accepted',reviewReason:'Attempted acceptance while contradiction remains open'})).rejects.toThrow(/Accepted case|contradiction/);
    const accepted=await board.revise(created.id,1,{...editable(created),reviewStatus:'accepted',reviewReason:'Owner reconciled the bounded control with the exact claim context',contradictions:[{evidenceRef:counter,status:'resolved',reason:'Control used a different declared actor and does not contradict this bounded claim'}]});expect(accepted.reviewStatus).toBe('accepted');expect((await board.list())[0].acceptedFinding).toBe(true);
  }));
  it('does not merge uncertain or mismatched root causes; accepted duplicates point to one current canonical case',async()=>fixture(async({board,assetId,claim})=>{
    const claimId=claim({by:'worker-a'}),canonical=await board.create(draft(assetId,claimId));await board.revise(canonical.id,1,{...editable(canonical),reviewStatus:'accepted',reviewReason:'Canonical exact root cause and policy were reviewed'});
    const uncertain=await board.create(draft(assetId,claimId,{id:undefined,title:'Possibly related submission',rootCauseKey:undefined,duplicateOf:canonical.id,reviewReason:'Pending duplicate disposition because root cause is unknown'}));
    await expect(board.revise(uncertain.id,1,{...editable(uncertain),reviewStatus:'accepted',reviewReason:'Cannot accept a duplicate without a reviewed root-cause identity'})).rejects.toThrow(/root cause|root-cause/);
    const related=await board.revise(uncertain.id,1,{...editable(uncertain),duplicateOf:undefined,relatedCaseIds:[canonical.id],reviewStatus:'disputed',reviewReason:'Keep possibly related without destructive merge'});expect(related.relatedCaseIds).toEqual([canonical.id]);
    const duplicate=await board.create(draft(assetId,claimId,{title:'Exact duplicate submission',duplicateOf:canonical.id,reviewReason:'Pending root-cause duplicate review'}));await board.revise(duplicate.id,1,{...editable(duplicate),reviewStatus:'accepted',reviewReason:'Same reviewed policy and root-cause identity; preserve original submission history'});
    const views=await board.list(),dupe=views.find(value=>value.id===duplicate.id)!;expect(dupe).toMatchObject({currentness:'current',acceptedFinding:false,canonicalCaseId:canonical.id});expect(views.filter(value=>value.acceptedFinding)).toHaveLength(1);
  }));
  it('pins asset revisions and invalidates accepted cases after an asset changes',async()=>fixture(async({board,assetId,claim,store})=>{
    const claimId=claim({by:'worker-a'}),created=await board.create(draft(assetId,claimId));await board.revise(created.id,1,{...editable(created),reviewStatus:'accepted',reviewReason:'Owner reviewed the current asset revision and exact claim'});
    store.recordGraph({assets:[{asset:{kind:'endpoint',key:'GET /object',label:'new deployment revision',expectedRevision:1}}]});const stale=(await board.list())[0];expect(stale.currentness).toBe('stale');expect(stale.staleReasons).toContain(`stale-asset:${assetId}@r1->r2`);expect(stale.acceptedFinding).toBe(false);
  }));
  it('uses retained request ACKs and transactional head checks instead of duplicating revisions',async()=>fixture(async({board,assetId,claim,store,path})=>{
    const claimId=claim({by:'worker-a'}),value=draft(assetId,claimId),request={actorId:'owner',requestId:'create-case',payload:{submitted:'same'}};
    const first=await board.create(value,request),sequence=store.sequence(),second=await board.create(value,request);expect(second.recordId).toBe(first.recordId);expect(store.sequence()).toBe(sequence);
    await expect(board.create({...value,title:'Changed logical input'},request)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    const other=new CaseBoard(runId,path,()=>true,{assetRevision:id=>store.assetRevision(id),assertionRevision:id=>store.assertionRevision(id)}),accepted={...editable(first),reviewStatus:'accepted' as const,reviewReason:'Owner reviewed exact current support before concurrent revision'};
    const outcomes=await Promise.allSettled([board.revise(first.id,1,accepted),other.revise(first.id,1,{...accepted,reviewReason:'Competing owner review must not create another head'})]);expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect((await board.list()).find(value=>value.id===first.id)?.revision).toBe(2);
  }));
  it('recovers retained case ACKs after commit without duplicating a case revision',async()=>{let armed=false;await fixture(async({board,assetId,claim,store})=>{const value=draft(assetId,claim({by:'worker-a'})),request={actorId:'owner',requestId:'lost-case-ack',payload:{transport:'same'}};armed=true;await expect(board.create(value,request)).rejects.toThrow('lost case ACK');expect(store.records().filter(row=>row.data?.case)).toHaveLength(1);const sequence=store.sequence(),replay=await board.create(value,request);expect(replay.revision).toBe(1);expect(store.sequence()).toBe(sequence);expect(store.records().filter(row=>row.data?.case)).toHaveLength(1);},stage=>{if(armed&&stage==='after-commit'){armed=false;throw Error('lost case ACK');}});});
  it('does not equate case review, remediation text or report delivery with goal completion',async()=>fixture(async({board,assetId,claim,store})=>{
    const claimId=claim({by:'worker-a'}),created=await board.create(draft(assetId,claimId,{remediation:{status:'implemented',reason:'A source change was described but no retest was reviewed',evidenceRefs:[]}}));const accepted=await board.revise(created.id,1,{...editable(created),reviewStatus:'accepted',reviewReason:'Case proof accepted; remediation remains only implemented'});expect((await board.list())[0]).toMatchObject({acceptedFinding:true,remediation:{status:'implemented'}});
    const {recordId:_,...stored}=accepted;expect(()=>store.commitRecords([{id:randomUUID(),runId,at:'2030',by:'owner',kind:'note',text:'forged case head',data:{case:{...stored,revision:99}}}])).toThrow('Invalid owned case revision');
    expect(store.records().filter(row=>row.data?.plan&&((row.data.plan as any).kind==='goal'))).toHaveLength(0);
  }));
});

// planning_update.md P8: readiness to rate is derived from the facts on record instead of asserted when the mood strikes.
describe('independent replay of the effect (P14.12)',()=>{
  it('accepts a peer claim that ran the same payload bytes in the same environment fingerprint',async()=>fixture(async({board,assetId,claim,receipt})=>{
    const independent=receipt('validator-b'),peer=claim({by:'validator-b',candidate:'validator-b-replay',evidenceRefs:[independent],...replay});
    const authorClaim=claim({by:'worker-a',independentEvidenceRef:independent,evidenceRefs:[independent],...replay});
    const created=await board.create(draft(assetId,authorClaim,{independentEvidenceRefs:[independent]}));
    expect((await board.list())[0]).toMatchObject({independentCurrent:true,currentness:'current',staleReasons:[]});
    void peer;void created;
  }));
  it('names a payload hash mismatch instead of reporting a vague stale support',async()=>fixture(async({board,assetId,claim,receipt})=>{
    const independent=receipt('validator-b');
    claim({by:'validator-b',candidate:'validator-b-replay',evidenceRefs:[independent],...replay,payloadSha256:'c'.repeat(64)});
    const authorClaim=claim({by:'worker-a',independentEvidenceRef:independent,evidenceRefs:[independent],...replay});
    await board.create(draft(assetId,authorClaim,{independentEvidenceRefs:[independent]}));
    const view=(await board.list())[0];
    expect(view.independentCurrent).toBe(false);
    expect(view.staleReasons).toEqual(expect.arrayContaining([expect.stringMatching(/^independent-payload-mismatch:aaaaaaaaaaaa!=cccccccccccc$/)]));
  }));
  it('refuses a replay in a drifted environment fingerprint',async()=>fixture(async({board,assetId,claim,receipt})=>{
    const independent=receipt('validator-b');
    claim({by:'validator-b',candidate:'validator-b-replay',evidenceRefs:[independent],...replay,environmentFingerprint:'d'.repeat(64)});
    const authorClaim=claim({by:'worker-a',independentEvidenceRef:independent,evidenceRefs:[independent],...replay});
    await board.create(draft(assetId,authorClaim,{independentEvidenceRefs:[independent]}));
    const view=(await board.list())[0];
    expect(view.staleReasons).toEqual(expect.arrayContaining([expect.stringMatching(/^independent-environment-mismatch:bbbbbbbbbbbb!=dddddddddddd$/)]));
  }));
  it('needs the payload once the claim names an artifact: a half-named replay cannot be independent',async()=>fixture(async({board,assetId,claim,receipt})=>{
    const independent=receipt('validator-b');
    claim({by:'validator-b',candidate:'validator-b-replay',evidenceRefs:[independent],...replay});
    const authorClaim=claim({by:'worker-a',independentEvidenceRef:independent,evidenceRefs:[independent],environmentFingerprint:FINGERPRINT});
    await board.create(draft(assetId,authorClaim,{independentEvidenceRefs:[independent]}));
    const view=(await board.list())[0];
    expect(view.independentCurrent).toBe(false);
    expect(view.staleReasons).toContain('independent-payload-missing');
  }));
  it('keeps the peer-claim rule when the effect names no artifact to replay',async()=>fixture(async({board,assetId,claim,receipt})=>{
    const independent=receipt('validator-b');
    claim({by:'validator-b',candidate:'validator-b-replay',evidenceRefs:[independent]});
    const authorClaim=claim({by:'worker-a',independentEvidenceRef:independent,evidenceRefs:[independent]});
    await board.create(draft(assetId,authorClaim,{independentEvidenceRefs:[independent]}));
    // Nothing to replay: independence is the peer's own demonstrated claim against its receipt, and the view says nothing more.
    expect((await board.list())[0]).toMatchObject({independentCurrent:true,staleReasons:[]});
  }));
  it('keeps a case ratable but not independent when no peer reproduced it',async()=>fixture(async({board,assetId,claim,receipt})=>{
    const independent=receipt('validator-b'),authorClaim=claim({by:'worker-a',independentEvidenceRef:independent,evidenceRefs:[independent],...replay});
    const created=await board.create(draft(assetId,authorClaim,{independentEvidenceRefs:[independent]}));
    const view=(await board.list())[0];
    expect(view).toMatchObject({independentCurrent:false,readyToRate:false});
    expect(view.staleReasons).toEqual(expect.arrayContaining([expect.stringMatching(/^independent-receipt-uncited:/)]));
    // Rating is an attributed owner judgement, not a claim of independence: it stays available and says what it covers.
    const rated=await board.rate(created.id,1,{severity:'medium',basis:'Owner rated the bounded effect without peer replay'});
    expect(rated.finding.severity).toBe('medium');
  }));
});

// P5.1 P3: acceptance is no looser than before, but a refusal now names the uncited receipt and the two legal ways to make a case independent.
describe('case acceptance refusal is actionable (P5.1 P3)',()=>{
  it('names the uncited independent receipt and the two legal independence paths when acceptance is refused',async()=>fixture(async({board,assetId,receipt,claim})=>{
    const independent=receipt('validator-b'),authorClaim=claim({by:'worker-a',evidenceRefs:[independent]}),created=await board.create(draft(assetId,authorClaim,{independentEvidenceRefs:[independent]})),view=(await board.list())[0];
    expect(view).toMatchObject({currentness:'stale',independentCurrent:false,independenceReason:`independent-support-uncited:${independent}`});
    expect(view.staleReasons).toContain(`independent-support-uncited:${independent}`);
    let message='';try{await board.revise(created.id,1,{...editable(created),reviewStatus:'accepted',reviewReason:'Attempted acceptance while the cited receipt has no peer claim and no reviewed validation'});}catch(error){message=(error as Error).message;}
    expect(message).toMatch(/^Case review is stale\/incomplete: independent-support-uncited:/);
    expect(message).toContain(`independent-support-uncited:${independent}`);
    // The two legal paths are named: a peer claim carrying the evidence id, or a cited reviewed validation task (host-owned W4).
    expect(message).toContain('Independence needs a reviewed peer claim whose data.independentEvidenceRef names the evidence id, or a reviewed validation task that the case cites through taskRefs (host-owned W4 path); make one current, then revise again.');
    expect((await board.list())[0]).toMatchObject({reviewStatus:'pending',revision:1}); // the refusal wrote nothing
  }));
  it('bounds the refusal reason list to three and counts the omitted receipts',async()=>fixture(async({board,assetId,receipt,claim})=>{
    const independent=Array.from({length:5},(_,index)=>receipt(`validator-${index}`)),authorClaim=claim({by:'worker-a',evidenceRefs:[independent[0]]}),created=await board.create(draft(assetId,authorClaim,{independentEvidenceRefs:independent}));
    let message='';try{await board.revise(created.id,1,{...editable(created),reviewStatus:'accepted',reviewReason:'Attempted acceptance while five cited receipts have no peer support'});}catch(error){message=(error as Error).message;}
    expect(message).toContain('(+2 more)');
    expect(message.match(/independent-support-uncited:/g)).toHaveLength(3);
    expect(message).toContain(independent[0]);expect(message).not.toContain(independent[3]);expect(message).not.toContain(independent[4]);
  }));
});

describe('rate-readiness is derived, not asserted (P8)',()=>{
  it('is true only when the case is current and keeps a current independent receipt',async()=>fixture(async({board,assetId,claim,receipt})=>{
    const independent=receipt('validator-a'),validator=claim({by:'validator-a',candidate:'validator-replay',evidenceRefs:[independent],...replay}),ownerClaim=claim({by:'owner',independentEvidenceRef:independent,evidenceRefs:[independent],...replay});
    const pending=await board.create(draft(assetId,ownerClaim)),unready=(await board.list())[0];
    expect(unready).toMatchObject({currentness:'current',readyToRate:false,independentCurrent:false});
    const accepted=await board.revise(pending.id,1,{...editable(pending),independentEvidenceRefs:[independent],reviewStatus:'accepted',reviewReason:'Owner reviewed the separate validator receipt and matching current claim'});
    expect((await board.list())[0]).toMatchObject({readyToRate:true,independentCurrent:true,acceptedFinding:true});
    // The same case loses readiness the moment its support goes stale: readiness is a reading of the record, not a stored flag.
    claim({by:'validator-a',closure:'open_proof_gap',supersedes:ownerClaim,evidenceRefs:[independent]});
    expect((await board.list())[0]).toMatchObject({readyToRate:false,currentness:'stale'});
    expect(accepted.reviewStatus).toBe('accepted');
  }));
  it('is false for a withdrawn case even when its old support is still current',async()=>fixture(async({board,assetId,claim,receipt})=>{
    const independent=receipt('validator-a'),validator=claim({by:'validator-a',candidate:'validator-replay',evidenceRefs:[independent],...replay}),ownerClaim=claim({by:'owner',independentEvidenceRef:independent,evidenceRefs:[independent],...replay});
    const created=await board.create(draft(assetId,ownerClaim,{independentEvidenceRefs:[independent]}));
    const accepted=await board.revise(created.id,1,{...editable(created),independentEvidenceRefs:[independent],reviewStatus:'accepted',reviewReason:'Owner reviewed current support and the separate validator receipt before withdrawing the case'});
    expect((await board.list())[0]).toMatchObject({readyToRate:true,currentness:'current'});
    await board.revise(accepted.id,2,{...editable(accepted),independentEvidenceRefs:[independent],reviewStatus:'withdrawn',reviewReason:'Owner withdrew the case after the target changed'});
    expect((await board.list())[0]).toMatchObject({readyToRate:false,currentness:'withdrawn'});
  }));
});
