import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { reporterTools } from '../../src/tool-policy.js';
import { AssessmentStore, type StoreFault } from '../../src/state/store.js';
import { BrokerClient } from '../../src/broker.js';
import { parseSettings } from '../../src/roles.js';
import { parseCommand } from '../../src/target.js';
import { parseWorkspaceCommand } from '../../src/ui/workspace.js';
import { bundlePath } from '../../src/state/bundle.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';
import { seedClaim, seedImpactGoal } from './helpers/report-fixture.js';
import type { SandboxOptions } from '../../src/sandbox.js';
import { runFixed } from '../../src/process.js';
import { scratchPrefixHash, type ScratchSnapshot } from '../../src/scratch.js';

async function fixture(work:(h:any)=>Promise<void>,storeFault?:StoreFault,provisionFails=false) {
  const root=await mkdtemp(join(tmpdir(),'p2o-workspace-runtime-'));
  await mkdir(join(root,'source'));
  const pi=createFakePi(),ctx=createContext({cwd:root}),herdr=createSimpleHerdr(),sandboxes:InertSandbox[]=[],profiles:SandboxOptions[]=[];
  const options={extensionPath:EXTENSION_PATH,storeFault,controlRoot:join(root,'control'),settingsPath:join(root,'isolated-settings.json'),herdr:herdr.client,
    createSandbox:(target:any,profile:SandboxOptions)=>{const sandbox=new InertSandbox(target);if(provisionFails&&sandboxes.length>0)sandbox.failProvision=true;sandboxes.push(sandbox);profiles.push(profile);return sandbox;}};
  registerP2O(pi.pi,options);
  const command=(s:string)=>pi.commands.get('p2o').handler(s,ctx.ctx);
  const call=(s:string,p:any={})=>pi.tools.get(s).execute(randomUUID(),p,undefined,undefined,ctx.ctx);
  const runId=async()=> (await readdir(join(root,'.p2o-state')))[0];
  const reader=async()=>AssessmentStore.open(join(root,'.p2o-state'),await runId());
  const ticket=async(id:string)=>{
    const control=join(root,'control',(await readdir(join(root,'control')))[0]);
    return JSON.parse(await readFile(join(control,`ticket-${id}.json`),'utf8'));
  };
  const screen=()=>ctx.screens.at(-1).render(200).join('\n');
  try {await work({root,pi,ctx,herdr,sandboxes,profiles,options,command,call,runId,reader,ticket,screen});}
  finally {await command('stop');await command('close');await rm(root,{recursive:true,force:true});}
}

describe('canonical owner runtime (inert execution, real SQLite and Unix broker)',()=>{
  it('parses retention bounds and read-only commands, not arbitrary host paths or resume authority',()=>{
    expect(parseSettings(undefined)).toMatchObject({retention:'durable-local',storageQuotaMiB:256,artifactCaptureKiB:1024,graphCapacity:2});
    // P9/B (Q29): graph capacity is a multiplier on the hard ceilings; a bad value falls back to the raised default.
    expect(parseSettings({p2o:{graphCapacity:4}})).toMatchObject({graphCapacity:4});
    for(const value of [0,5,1.5,'3'])expect(parseSettings({p2o:{graphCapacity:value}}).graphCapacity).toBe(2);
    expect(parseSettings({p2o:{retention:'ephemeral',storageQuotaMiB:8,artifactCaptureKiB:8192}})).toMatchObject({retention:'ephemeral',storageQuotaMiB:8,artifactCaptureKiB:8192});
    for(const value of [0,7,1025,1.5,'256'])expect(parseSettings({p2o:{storageQuotaMiB:value}}).storageQuotaMiB).toBe(256);
    expect(parseCommand('--target x --retention ephemeral')).toMatchObject({options:{retention:'ephemeral'}});
    expect(()=>parseCommand('--target x --retention auto')).toThrow();
    expect(parseWorkspaceCommand('open run-fixture')).toEqual({action:'open',runId:'run-fixture'});
    expect(parseWorkspaceCommand('reconcile run-fixture process died')).toEqual({action:'reconcile',runId:'run-fixture',reason:'process died'});
    expect(parseWorkspaceCommand('reconcile run-fixture')).toEqual({action:'reconcile',runId:'run-fixture'});
    expect(()=>parseWorkspaceCommand('reconcile')).toThrow();expect(()=>parseWorkspaceCommand('reconcile ../../etc')).toThrow();expect(()=>parseWorkspaceCommand(`reconcile run-x ${'r'.repeat(2001)}`)).toThrow();
    expect(parseWorkspaceCommand('export /tmp/bundle')).toEqual({action:'export',path:'/tmp/bundle'});
    expect(parseWorkspaceCommand('import "/tmp/bundle dir"')).toEqual({action:'import',path:'/tmp/bundle dir'});
    expect(()=>parseWorkspaceCommand('export relative')).toThrow();expect(()=>parseWorkspaceCommand('export')).toThrow();expect(()=>parseWorkspaceCommand('import /tmp/\u0000bad')).toThrow();
    expect(bundlePath('/tmp/ok','export')).toBe('/tmp/ok');
    for(const s of ['open ../../outside','open run-a --resume','recover /tmp/state','close extra','artifact ../../secret','artifact artifact-a -1','checkpoints bad'])expect(()=>parseWorkspaceCommand(s)).toThrow();
    // S1: the five bespoke list+detail command pairs (tasks/task, plans/plan, phases/phase, findings/finding, coverage/coverage-cell)
    // are retired in favor of the already-generic heads/show over the same 13 KNOWLEDGE_DOMAINS.
    expect(parseWorkspaceCommand('heads task 0 20 blocked')).toEqual({action:'heads',domain:'task',cursor:0,limit:20,status:'blocked'});
    expect(parseWorkspaceCommand('heads goal')).toEqual({action:'heads',domain:'goal',cursor:0,limit:20});
    expect(parseWorkspaceCommand('show task task-a')).toEqual({action:'show',domain:'task',id:'task-a'});
    for(const s of ['heads not-a-domain','heads task 0 0','heads task 0 101',`heads task 0 20 ${'x'.repeat(81)}`,'show','show not-a-domain id-a','show task ../../etc'])expect(()=>parseWorkspaceCommand(s)).toThrow();
  });
  it('always confirms retention/location/sensitivity before creating durable knowledge or resources',async()=>{
    await fixture(async h=>{
      h.ctx.setConfirm(false);await h.command('--target ./source');
      expect(h.ctx.confirmBodies[0]).toContain('DURABLE-LOCAL');expect(h.ctx.confirmBodies[0]).toContain(join(h.root,'.p2o-state'));
      expect(h.ctx.confirmBodies[0]).toContain('256 MiB');expect(h.ctx.confirmBodies[0]).toContain('sensitive data');expect(h.ctx.confirmBodies[0]).toMatch(/^Runtime: p2o \S+ · [0-9a-f]{12}\n/);
      expect(h.sandboxes).toHaveLength(0);expect(h.pi.messages).toHaveLength(0);
      await expect(stat(join(h.root,'.p2o-state'))).rejects.toThrow();await expect(stat(join(h.root,'control'))).rejects.toThrow();
      h.ctx.setConfirm(true);await h.command('--target ./source');await h.command('stop');
      const fresh=createContext({cwd:h.root});await h.pi.commands.get('p2o').handler('--target ./source',fresh.ctx);
      expect(h.ctx.dialogs.length+fresh.dialogs.length).toBe(3);expect(await readdir(join(h.root,'.p2o-state'))).toHaveLength(2);
      expect(h.sandboxes).toHaveLength(2);expect(h.pi.messages).toHaveLength(2);
    });
  });
  it('--refer-workspace tags prior same-target runs as context only, never same-run evidence, and ignores runs on a different target',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');await seedImpactGoal(h);const firstRunId=await h.runId();
      const asset=(await h.call('p2o_graph',{action:'record',batch:{assets:[{asset:{kind:'endpoint',key:'GET /refer-fixture'}}]}})).details.acks[0];
      const taskDraft={question:'Does the refer-fixture observation match the declared policy?',surface:'/refer-fixture',risk:'authorization',role:'general',roleReason:'Bounded inert observation for the refer-workspace fixture',expectedTrue:'Receipt records the expected policy observation',expectedFalse:'Receipt records the contrasting control',stopCondition:'Stop after one inert command and owner review',evidenceIds:[],prerequisites:[],skills:[],methodReason:'One inert command with no external target',
        // A3: the work identity is what places this reviewed intent in the prior run's derived coverage denominator.
        work:{assetRefs:[{id:asset.entityId,revision:1}],questionKey:'wstg-info-01',policyKey:'policy:refer',actorContext:'actor:fixture',tenantContext:'tenant:fixture',methodFamily:'offline-observation',purpose:'mapping'}};
      const task=(await h.call('p2o_task_author',{draft:taskDraft})).details,running=(await h.call('p2o_task_start',{id:task.id})).details;
      const observation=(await h.call('p2o_shell',{command:'printf bounded-refer-observation'})).details;
      // A2/A3: the tested cell comes from a worker claim the projection can link to this intent, so the fixture seeds the
      // record the broker would commit before the review head that makes it readable.
      await seedClaim(h,{candidate:'refer-observed-claim',surface:'/refer-fixture',risk:'authorization',closure:'open_proof_gap',execution:'tested',proof:'offline_reproduction',evidenceRefs:[observation.evidenceId],negativeControls:[],policyBasis:'boundary_invariant',expectedPolicy:'Declared fixture boundary',limitations:'Bounded inert fixture only'},task.id);
      await h.call('p2o_task_review',{id:task.id,revision:running.revision,reason:'Owner reviewed the exact inert receipt for the refer-workspace fixture',evidenceIds:[observation.evidenceId]});
      // A2: the claim is worker-authored; the fixture seeds the record the broker would commit.
      await seedClaim(h,{candidate:'refer-leftover-claim',surface:'/refer-fixture',risk:'authorization',closure:'open_proof_gap',execution:'not_tested',proof:'static_trace',evidenceRefs:[],negativeControls:[],policyBasis:'inferred',expectedPolicy:'Declared fixture boundary',limitations:'Proof remains open for this fixture'});
      const plan=(await h.call('p2o_coverage_plan',{plan:{title:'Refer fixture plan',status:'active',reason:'One declared cell for the refer-workspace fixture',exclusions:[],unknownScope:[]}})).details;
      const derived=(await h.call('p2o_board',{board:'coverage',id:plan.id})).details.cells[0];
      expect(derived).toMatchObject({questionKey:'wstg-info-01',execution:'tested',effectiveExecution:'tested'});
      await h.command('stop');
      await mkdir(join(h.root,'elsewhere'));
      await h.pi.commands.get('p2o').handler('--target ./elsewhere',createContext({cwd:h.root}).ctx);const otherRunId=(await readdir(join(h.root,'.p2o-state'))).find(id=>id!==firstRunId)!;await h.command('stop');
      const fresh=createContext({cwd:h.root});
      await h.pi.commands.get('p2o').handler('--target ./source --refer-workspace latest',fresh.ctx);
      expect(fresh.confirmBodies[0]).toContain(`Referencing 1 prior workspace run on this same target: ${firstRunId}`);
      expect(fresh.confirmBodies[0]).not.toContain(otherRunId);
      const secondRunId=(await readdir(join(h.root,'.p2o-state'))).find(id=>id!==firstRunId&&id!==otherRunId)!;
      const store=AssessmentStore.open(join(h.root,'.p2o-state'),secondRunId);
      try {
        const reference=store.records().find(r=>r.kind==='lifecycle'&&(r.data as any)?.reference)!;
        expect((reference.data!.reference as any).runs).toMatchObject([{runId:firstRunId,currency:'current'}]);
        expect(reference.text).toContain('never same-run evidence');
        const gaps=(reference.data!.reference as any).gaps;
        expect(gaps.covered).toMatchObject([{kind:'coverage',runId:firstRunId,fingerprint:derived.fingerprint,questionKey:'wstg-info-01'}]);
        expect(gaps.leftOpen).toMatchObject([{kind:'candidate',runId:firstRunId,candidate:'refer-observed-claim'},{kind:'candidate',runId:firstRunId,candidate:'refer-leftover-claim'}]);
        expect(gaps.stale).toEqual([]);expect(gaps.unknown).toEqual([]);
        expect(gaps.neverReached).not.toContain('wstg-info-01');expect(gaps.neverReached).toContain('wstg-info-02');
      } finally {store.close();}
      const heads=(await h.call('p2o_state',{action:'heads',domain:'reference'})).details;
      expect(heads.rows).toHaveLength(1);expect(heads.rows[0]).toMatchObject({domain:'reference',status:'current'});
      await h.pi.commands.get('p2o').handler('stop',fresh.ctx);
    });
  });
  it('p2o_state names the action that filters when search is called with domain/status (A1 host-shape fix)',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');
      // The search RPC takes q/cursor/limit only. Forwarding domain/status used to fail host-side shape validation with
      // "Knowledge search has an invalid shape or unknown fields" instead of naming the action that does filter by them.
      await expect(h.call('p2o_state',{action:'search',q:'fixture',domain:'task'})).rejects.toThrow(/domain\/status filter action=heads/);
      await expect(h.call('p2o_state',{action:'search',q:'fixture',status:'current'})).rejects.toThrow(/action=search takes q, cursor and limit only/);
      await expect(h.call('p2o_state',{action:'heads',q:'fixture'})).rejects.toThrow(/action=heads takes domain, status, cursor and limit only/);
      await expect(h.call('p2o_state',{action:'search',q:'fixture'})).resolves.toBeTruthy();
    });
  });
  it('stores over-long cosmetic prose truncated with a warning instead of failing argument validation (A1)',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');
      const note=await h.call('p2o_note',{kind:'note',text:'N'.repeat(3000),surface:'S'.repeat(400),risk:'R'.repeat(400)});
      expect(note.details.warnings).toEqual(['truncated:text (stored 2000 of 3000 characters)','truncated:surface (stored 200 of 400 characters)','truncated:risk (stored 200 of 400 characters)']);
      expect(note.content[0].text).toContain('Admission warnings:');
      const notes=await h.reader();
      try{const row=notes.records().filter((r:any)=>r.kind==='note').at(-1)!;expect(row.text).toHaveLength(2000);expect(row).toMatchObject({surface:'S'.repeat(200),risk:'R'.repeat(200)});}finally{notes.close();}
      const surface=await h.call('p2o_surface',{component:'C'.repeat(300),entryPoint:'E'.repeat(300),text:'T'.repeat(1500)});
      expect(surface.details.warnings).toHaveLength(3);
      const inventory=await h.reader();
      try{const row=inventory.records().filter((r:any)=>r.kind==='surface').at(-1)!;expect((row.data as any).component).toHaveLength(200);expect(row.text).toHaveLength(1000);}finally{inventory.close();}
    });
  });
  it('--refer-workspace records an explicit Unknown reason (never silently clean) when no prior run shares the target, and omitting the flag writes no reference record at all',async()=>{
    await fixture(async h=>{
      const fresh=createContext({cwd:h.root});
      await h.pi.commands.get('p2o').handler('--target ./source --refer-workspace all',fresh.ctx);
      expect(fresh.confirmBodies[0]).toContain('No prior workspace run on this same target was found for --refer-workspace');
      const runId=(await readdir(join(h.root,'.p2o-state')))[0];
      const store=AssessmentStore.open(join(h.root,'.p2o-state'),runId);
      try {
        const reference=store.records().find(r=>(r.data as any)?.reference)!;
        expect((reference.data!.reference as any).runs).toEqual([]);
        expect((reference.data!.reference as any).gaps.unknown).toEqual(['no eligible prior run exists for --refer-workspace on this target']);
        expect((reference.data!.reference as any).gaps).toMatchObject({covered:[],leftOpen:[],stale:[],neverReached:[]});
      } finally {store.close();}
      await h.pi.commands.get('p2o').handler('stop',fresh.ctx);
      await h.pi.commands.get('p2o').handler('--target ./source',createContext({cwd:h.root}).ctx);
      const plainRunId=(await readdir(join(h.root,'.p2o-state'))).find(id=>id!==runId)!;
      const plainStore=AssessmentStore.open(join(h.root,'.p2o-state'),plainRunId);
      try {expect(plainStore.records().some(r=>(r.data as any)?.reference)).toBe(false);} finally {plainStore.close();}
    });
  });
  it('--refer-workspace currency for a hybrid target requires both halves (source snapshot and the full path+origin display) to match (U10)',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source --origin https://example.com/app');
      const firstRunId=await h.runId();
      await h.command('stop');
      const fresh=createContext({cwd:h.root});
      await h.pi.commands.get('p2o').handler(`--target ./source --origin https://example.com/app --refer-workspace ${firstRunId}`,fresh.ctx);
      const secondRunId=(await readdir(join(h.root,'.p2o-state'))).find(id=>id!==firstRunId)!;
      const store=AssessmentStore.open(join(h.root,'.p2o-state'),secondRunId);
      try {
        const reference=store.records().find(r=>r.kind==='lifecycle'&&(r.data as any)?.reference)!;
        expect((reference.data!.reference as any).runs).toMatchObject([{runId:firstRunId,currency:'current'}]);
      } finally {store.close();}
      await h.pi.commands.get('p2o').handler('stop',fresh.ctx);
      const fresh2=createContext({cwd:h.root});
      // Same origin, different path on that origin: still the same eligible target, but the full display no longer matches, so it is stale, not current.
      await h.pi.commands.get('p2o').handler(`--target ./source --origin https://example.com/other --refer-workspace ${firstRunId}`,fresh2.ctx);
      const thirdRunId=(await readdir(join(h.root,'.p2o-state'))).find(id=>id!==firstRunId&&id!==secondRunId)!;
      const store2=AssessmentStore.open(join(h.root,'.p2o-state'),thirdRunId);
      try {
        const reference=store2.records().find(r=>r.kind==='lifecycle'&&(r.data as any)?.reference)!;
        expect((reference.data!.reference as any).runs).toMatchObject([{runId:firstRunId,currency:'stale'}]);
      } finally {store2.close();}
      await h.pi.commands.get('p2o').handler('stop',fresh2.ctx);
    });
  });
  it('keeps durable knowledge/checkpoints but destroys control/tickets, and opens without an Engine/model/target',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');const ack=(await h.call('p2o_note',{kind:'note',text:'retained bounded observation'})).details;
      const id=await h.runId();await h.command('checkpoint operator barrier');expect(h.screen()).toContain('integrity complete');
      await h.command('stop');expect(await readdir(join(h.root,'control'))).toEqual([]);
      const store:AssessmentStore=await h.reader();try {expect(store.record(ack.recordId)?.text).toBe('retained bounded observation');expect(store.checkpoints()).toHaveLength(2);expect(store.outcome()).toMatchObject({assessmentOutcome:'cancelled',resourceOutcome:'cleaned'});} finally {store.close();}
      const fresh=createFakePi(),ctx=createContext({cwd:h.root});registerP2O(fresh.pi,h.options);
      await fresh.commands.get('p2o').handler(`open ${id}`,ctx.ctx);
      expect(ctx.screens.at(-1).render(200).join('\n')).toContain('HISTORICAL');expect(fresh.messages).toHaveLength(0);
      expect(h.sandboxes).toHaveLength(1);expect(h.herdr.calls).toHaveLength(0);
      expect((await fresh.events.get('tool_call')![0]({toolName:'p2o_shell'},ctx.ctx)).block).toBe(true);
      await fresh.commands.get('p2o').handler('tasks',ctx.ctx);
      await fresh.commands.get('p2o').handler('checkpoint forbidden',ctx.ctx);expect(ctx.notices.at(-1)).toContain('read-only');
      await fresh.commands.get('p2o').handler('close',ctx.ctx);
    });
  });
  it('ephemeral uses the same canonical services in-run but deletes knowledge and warns at consent',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source --retention ephemeral');expect(h.ctx.confirmBodies[0]).toContain('EPHEMERAL');
      await h.call('p2o_note',{kind:'note',text:'temporary observation'});await h.command('checkpoint temporary barrier');expect(h.screen()).toContain('ephemeral');
      await expect(stat(join(h.root,'.p2o-state'))).rejects.toThrow();await h.command('stop');
      expect(await readdir(join(h.root,'control'))).toEqual([]);await h.command('status');expect(h.screen()).toContain('Ephemeral');expect(h.screen()).toMatch(/Runtime: p2o \S+ · [0-9a-f]{12} \(digest of the entry file \+ src closure/);
    });
  });
  it('blocks before a worker pane when executor provisioning fails',async()=>fixture(async h=>{
    await h.command('--target ./source --executors isolated --target-ops 2');
    const failure=await h.call('p2o_delegate',{focus:'fixture',task:'inspect inert fixture'}).then(()=>undefined,(error:unknown)=>error);
    expect(String(failure)).toMatch(/EXECUTOR_PROVISION_FAILED|provision executor/);
    expect(h.herdr.calls.filter((call:any)=>call.op==='split')).toHaveLength(0);
    expect(h.sandboxes[1].provisionCount).toBe(1);expect(h.sandboxes[1].stopCount).toBe(1);
    const store:AssessmentStore=await h.reader();
    try {const task=store.records().filter(row=>row.kind==='task').at(-1);expect(task?.data?.task).toMatchObject({status:'blocked'});} finally {store.close();}
  },undefined,true));
  it('P10/TR-H09: shared stays serial by default while an explicit --target-ops N removes that guarantee and is recorded',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');
      const body=h.ctx.confirmBodies[0] as string;
      expect(body).toContain('shared is serial');
      expect(body).toContain('ONE AT A TIME');
      expect(h.profiles[0].concurrentOperations).toBeUndefined();
      const store:AssessmentStore=await h.reader();
      try {expect(store.manifest()).toMatchObject({profile:{executorMode:'shared',maxTargetOperations:1}});expect(store.records().some(row=>row.kind==='lifecycle'&&String(row.text).startsWith('executor profile: shared executor'))).toBe(false);} finally {store.close();}
    });
    await fixture(async h=>{
      await h.command('--target ./source --target-ops 2');
      const body=h.ctx.confirmBodies[0] as string;
      expect(body).not.toContain('shared is serial');
      expect(body).toContain('explicitly raised the cap with --target-ops');
      expect(body).toContain('share the explicit target-operation cap 2: up to that many target operations may run at once');
      expect(h.profiles[0].concurrentOperations).toBe(2);
      const store:AssessmentStore=await h.reader();
      try {expect(store.manifest()).toMatchObject({profile:{executorMode:'shared',maxTargetOperations:2}});
        expect(store.records().some(row=>row.kind==='lifecycle'&&String(row.text).includes('the default serial guarantee was removed by the operator (--target-ops 2)'))).toBe(true);} finally {store.close();}
    });
  });
  it('hands exclusion paths to both shared and isolated executors outside all container mounts',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source --executors isolated --target-ops 2');
      await h.call('p2o_delegate',{focus:'fixture',task:'inspect inert fixture'});
      expect(h.profiles).toHaveLength(2);
      for(const p of h.profiles){expect(p.sourceExcludePaths).toContain(join(h.root,'.p2o-state'));expect(p.sourceExcludePaths[0]).toContain('control/p2o-run-');}
      const store:AssessmentStore=await h.reader();try{expect(store.manifest()).toMatchObject({targetKind:'directory',sourceEntries:0,profile:{executorMode:'isolated',maxTargetOperations:2}});expect(store.manifest().sourceSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);}finally{store.close();}
    });
  });
  it('idempotent authenticated notes return the original ACK without spending budget/event effects twice',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');const spawn=(await h.call('p2o_delegate',{focus:'fixture',task:'inspect inert fixture'})).details,ticket=await h.ticket(spawn.workerId),c=new BrokerClient(ticket.socket,ticket.token);
      try {
        const payload={kind:'note',text:'one canonical observation',by:'owner',runId:'foreign'},requestId='note-delivery';
        const first=await c.request('note',payload,{requestId});const second=await c.request('note',{runId:'foreign',by:'owner',text:payload.text,kind:'note'},{requestId});
        expect(second).toMatchObject({recordId:first.recordId,sequence:first.sequence,replayed:true});
        await expect(c.request('note',{...payload,text:'changed'},{requestId})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
        const store:AssessmentStore=await h.reader();try {const rows=store.records().filter(r=>r.text===payload.text);expect(rows).toHaveLength(1);expect(rows[0].by).toBe(spawn.workerId);expect(rows[0].runId).toBe(ticket.runId);} finally {store.close();}
      } finally {c.close();}
    });
  });
  it('report replay/lost connection permits ACK-only inspection, never copied-ticket target authority or duplicate state',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');const spawn=(await h.call('p2o_delegate',{focus:'fixture',task:'inspect inert fixture'})).details,ticket=await h.ticket(spawn.workerId),c=new BrokerClient(ticket.socket,ticket.token);
      const original={report:{summary:'bounded partial report',confidence:'low',coverage:[{surface:'fixture',risk:'policy',outcome:'needs_follow_up'}],openItems:['policy unknown']}},requestId='handoff-delivery';
      const first=await c.request('report',original,{requestId});const replay=await c.request('report',original,{requestId});expect(replay.acks).toEqual(first.acks);expect(replay.replayed).toBe(true);
      await expect(c.request('exec',{command:'true'})).rejects.toThrow('stopped');c.close();await delay(10);
      const forbidden=new BrokerClient(ticket.socket,ticket.token,{connectMs:100});try {await expect(forbidden.request('exec',{command:'true'})).rejects.toThrow('Unauthorized');} finally {forbidden.close();}
      const receipt=new BrokerClient(ticket.socket,ticket.token,{receiptOnly:true});try {
        const retained=await receipt.request('mutation_ack',{mutationOp:'report',original},{requestId});expect(retained.acks).toEqual(first.acks);
        await expect(receipt.request('exec',{command:'true'})).rejects.toThrow('Receipt-only');
        await expect(receipt.request('mutation_ack',{mutationOp:'report',original:{report:{...original.report,summary:'changed'}}},{requestId})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      } finally {receipt.close();}
      const store:AssessmentStore=await h.reader();try {expect(store.records().filter(r=>r.kind==='report')).toHaveLength(1);expect(store.records().filter(r=>r.kind==='coverage')).toHaveLength(1);expect(store.records().filter(r=>r.kind==='open')).toHaveLength(1);expect((store.records().filter(r=>r.kind==='task').at(-1)?.data?.task as {status:string}).status).toBe('reported');} finally {store.close();}
      expect(h.sandboxes[0].commands).toHaveLength(0);
    });
  });
  it('post-commit callback failure looks up ACK, revokes once, and never replays target/report writes',async()=>{
    let armed=false;await fixture(async h=>{
      await h.command('--target ./source');const spawn=(await h.call('p2o_delegate',{focus:'fixture',task:'inspect inert fixture'})).details,ticket=await h.ticket(spawn.workerId),c=new BrokerClient(ticket.socket,ticket.token);
      try {armed=true;const result=await c.request('report',{report:{summary:'postcommit report',confidence:'low'}},{requestId:'postcommit'});expect(result.acks).toHaveLength(4);await expect(c.request('exec',{command:'true'})).rejects.toThrow('stopped');}
      finally{c.close();}
      const store:AssessmentStore=await h.reader();try{expect(store.records().filter(r=>r.kind==='report')).toHaveLength(1);expect(store.events().rows.filter(e=>e.correlationId==='postcommit')).toHaveLength(4);expect(store.records().filter(r=>r.data?.phase)).toHaveLength(1);}finally{store.close();}
      expect((await h.call('p2o_workers')).details.workers[0].reported).toBe(true);expect(h.sandboxes[0].commands).toHaveLength(0);
    },stage=>{if(armed && stage==='after-commit'){armed=false;throw Error('Lost post-commit callback ACK fixture');}});
  });
  it('recovers a genuinely unobserved report ACK after dropping the paused client socket',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');const spawn=(await h.call('p2o_delegate',{focus:'fixture',task:'inspect inert fixture'})).details,ticket=await h.ticket(spawn.workerId);
      const socket=createConnection(ticket.socket);socket.setEncoding('utf8');
      const hello=new Promise<string>((resolve,reject)=>{socket.once('data',value=>resolve(String(value)));socket.once('error',reject);});
      socket.write(`${JSON.stringify({token:ticket.token})}\n`);expect(JSON.parse((await hello).trim()).ok).toBe(true);
      socket.pause();const requestId='ack-never-observed',original={report:{summary:'lost response fixture',confidence:'low',openItems:['bounded gap']}};
      socket.write(`${JSON.stringify({brokerRequestId:1,op:'report',requestId,...original})}\n`);
      let reported=false;for(let i=0;i<100;i++){reported=(await h.call('p2o_workers')).details.workers[0].reported;if(reported)break;await delay(5);}expect(reported).toBe(true);
      const closed=new Promise<void>(resolve=>socket.once('close',()=>resolve()));socket.destroy();await closed;
      const receipt=new BrokerClient(ticket.socket,ticket.token,{receiptOnly:true});
      try {const ack=await receipt.request('mutation_ack',{mutationOp:'report',original},{requestId});expect(ack.replayed).toBe(true);expect(ack.acks).toHaveLength(5);}finally{receipt.close();}
      const store:AssessmentStore=await h.reader();try {expect(store.records().filter(r=>r.kind==='report')).toHaveLength(1);expect(store.records().filter(r=>r.kind==='open')).toHaveLength(1);}finally{store.close();}
      expect(h.pi.messages).toHaveLength(1);expect(h.sandboxes[0].commands).toHaveLength(0);
    });
  });
  it('checkpoints in-flight work and stop records local cancellation/unknown remote outcome without replay',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');const sandbox=h.sandboxes[0] as InertSandbox;
      let started!:()=>void,rejectOperation:((e:Error)=>void)|undefined;const ready=new Promise<void>(resolve=>{started=resolve;});
      sandbox.exec=async(_command,_seconds,_signal,_workdir,onRunning)=>{onRunning?.();started();return new Promise((_resolve,reject)=>{rejectOperation=reject;});};
      const stop=sandbox.stop.bind(sandbox);sandbox.stop=async()=>{rejectOperation?.(Error('Cancelled'));await stop();};
      const operation=h.call('p2o_shell',{command:'inert long operation'}).catch((error:Error)=>error);await ready;
      await h.command('checkpoint in-flight barrier');
      const before:AssessmentStore=await h.reader();let id:string;try{id=before.checkpoints().at(-1)!.inFlightOperationIds[0];expect(id).toMatch(/^operation-/);}finally{before.close();}
      await h.command('stop');expect(await operation).toBeInstanceOf(Error);
      const after:AssessmentStore=await h.reader();try{expect(after.events({operationId:id!}).rows.map(e=>e.kind)).toEqual(['operation.requested','operation.started','operation.cancelled','operation.unknown-terminal']);expect(after.checkpoints().at(-1)!.inFlightOperationIds).toContain(id!);}finally{after.close();}
      expect(h.pi.messages).toHaveLength(1);expect(h.sandboxes).toHaveLength(1);
    });
  });
  it('records requested/started/returned with task/actor/receipt links, not finding correctness',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');const result=await h.call('p2o_shell',{command:'echo inert'});expect(result.details.operationId).toMatch(/^operation-/);
      const store:AssessmentStore=await h.reader();try {
        const events=store.events({operationId:result.details.operationId}).rows;expect(events.map(e=>e.kind)).toEqual(['operation.requested','operation.started','artifact.retained','operation.returned']);
        expect(events.every(e=>e.actorId==='owner')).toBe(true);expect(events.at(-1)?.payloadRefs).toEqual([result.details.evidenceId,...result.details.capture.artifacts.map((a:{id:string})=>a.id)]);
        expect(store.record(result.details.evidenceId)?.kind).toBe('evidence');
      } finally {store.close();}
    });
  });
  it('closes target authority on SQLite directory replacement; failed retention does not hold cleanup open',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');await h.call('p2o_note',{kind:'note',text:'prior commit'});
      const id=await h.runId(),path=join(h.root,'.p2o-state',id);await rename(path,`${path}-moved`);await mkdir(path,{mode:0o700});
      await expect(h.call('p2o_shell',{command:'must-not-run'})).rejects.toThrow();
      for(let i=0;i<60 && h.sandboxes[0].stopCount===0;i++)await delay(10);
      await h.command('stop');expect(h.sandboxes[0].commands).toHaveLength(0);expect(h.sandboxes[0].stopCount).toBeGreaterThan(0);
      expect(h.ctx.notices.join('\n')).toContain('execution authority closed');expect(await readdir(path)).toEqual([]);
      expect(await readdir(join(h.root,'control'))).toEqual([]);expect((await stat(join(`${path}-moved`,'assessment.sqlite'))).size).toBeGreaterThan(0);
    });
  });
  it('retains real process output before display truncation with owner receipts/ranges and no raw buffer delivery',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');let executed=0;
      h.sandboxes[0].exec=async(_c:string,_s:number,signal:AbortSignal,_w:string,onRunning:()=>void,onOutput:any)=>{executed++;onRunning?.();return runFixed(process.execPath,['-e',"process.stdout.write('x'.repeat(60000)+'\\npassword=not-for-retention\\n'+'z'.repeat(10000)+'TAIL-RETAINED')"],{timeoutMs:null,signal,onOutput});};
      const result=await h.call('p2o_shell',{command:'inert large stream'});expect(result.details.truncated).toBe(true);
      const capture=result.details.capture;expect(capture.available).toBe(true);expect(capture.observedBytes).toBeGreaterThan(60000);expect(capture.artifacts).toHaveLength(1);
      expect(result.content[0].text).toContain('Artifact ID:');expect(JSON.stringify(result)).not.toContain('TAIL-RETAINED');expect(JSON.stringify(result)).not.toContain('not-for-retention');expect(JSON.stringify(result)).not.toContain('\"type\":\"Buffer\"');
      const store:AssessmentStore=await h.reader();try{const a=capture.artifacts[0],page=store.artifact(a.id,60000);expect(page.text).toContain('TAIL-RETAINED');expect(page.text).not.toContain('not-for-retention');expect(page.manifest).toMatchObject({operationId:result.details.operationId,producer:'owner',captureOutcome:'returned',truncated:false});expect((store.record(result.details.evidenceId)!.data!.capture as any).artifacts[0].id).toBe(a.id);}finally{store.close();}
      const modelPage=await h.call('p2o_artifact',{id:capture.artifacts[0].id,offset:60000});expect(modelPage.details.returnedBytes).toBe(8192);expect(modelPage.details.nextOffset).toBe(68192);expect(modelPage.content[0].text).not.toContain('not-for-retention');
      const tail=await h.call('p2o_artifact',{id:capture.artifacts[0].id,offset:modelPage.details.nextOffset});expect(tail.content[0].text).toContain('TAIL-RETAINED');
      await expect(h.call('p2o_artifact',{id:capture.artifacts[0].id,length:49153})).rejects.toThrow('range');await expect(h.call('p2o_artifact',{id:'artifact-00000000-0000-0000-0000-000000000000'})).rejects.toThrow('Unknown artifact ID');
      expect(executed).toBe(1);await h.command(`artifact ${capture.artifacts[0].id} 60000`);h.screen();for(let n=0;n<4;n++)h.ctx.screens.at(-1).handleInput('\u001b[6~');expect(h.screen()).toContain('TAIL-RETAINED');
    });
  });
  it('enforces the confirmed combined capture setting in authenticated worker delivery, without serializing raw buffers',async()=>{
    await fixture(async h=>{
      await writeFile(join(h.root,'isolated-settings.json'),JSON.stringify({p2o:{artifactCaptureKiB:1}}));await h.command('--target ./source');
      const spawn=(await h.call('p2o_delegate',{focus:'fixture',task:'inspect inert fixture'})).details,ticket=await h.ticket(spawn.workerId),c=new BrokerClient(ticket.socket,ticket.token);
      const sandbox=h.sandboxes[0];let executed=0;sandbox.exec=async(_c:string,_s:number,signal:AbortSignal,_w:string,onRunning:()=>void,onOutput:any)=>{executed++;onRunning?.();return runFixed(process.execPath,['-e',"process.stdout.write('a'.repeat(3000));process.stderr.write('b'.repeat(3000))"],{timeoutMs:null,signal,onOutput});};
      try{await c.request('runtime',{model:ticket.requestedRuntime?.model??'p2o-inert/current-agent',thinking:ticket.requestedRuntime?.thinking??'off'});const result=await c.request('net',{command:'inert bounded stream'});expect(result.capture).toMatchObject({maxBytes:1024,observedBytes:6000,capturedBytes:1024});expect(result.capture.artifacts).toHaveLength(2);expect(result.capture.artifacts.every((a:any)=>a.truncated)).toBe(true);expect(executed).toBe(1);const store:AssessmentStore=await h.reader();try{expect(store.artifacts().reduce((n,a)=>n+a.capturedInputBytes,0)).toBe(1024);expect(store.artifacts().every(a=>a.producer===spawn.workerId)).toBe(true);}finally{store.close();}}finally{c.close();}
    });
  });
  it('allows reporting-role reads and target work, and still denies oversized/foreign/revoked reads',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');const investigator=(await h.call('p2o_delegate',{focus:'fixture',task:'inspect inert fixture'})).details,t=await h.ticket(investigator.workerId),c=new BrokerClient(t.socket,t.token);let artifactId:string;
      h.sandboxes[0].exec=async(_c:string,_s:number,_signal:AbortSignal,_w:string,onRunning:()=>void,onOutput:any)=>{onRunning();onOutput('stdout',Buffer.from('\x01'.repeat(12000)));return {code:0,stdout:'bounded excerpt',stderr:'',truncated:false};};
      try{await c.request('runtime',{model:t.requestedRuntime.model,thinking:t.requestedRuntime.thinking});artifactId=(await c.request('exec',{command:'inert escape-heavy stream'})).capture.artifacts[0].id;}finally{c.close();}
      const reporter=(await h.call('p2o_delegate',{focus:'report',task:'synthesize existing receipts',role:'reporting'})).details,rt=await h.ticket(reporter.workerId),r=new BrokerClient(rt.socket,rt.token);
      try{await r.request('runtime',{model:rt.requestedRuntime.model,thinking:rt.requestedRuntime.thinking});const status=await r.request('status');const read=await r.request('artifact_read',{artifactId:artifactId!,length:8192});expect(read.value.returnedBytes).toBe(8192);expect(read.value.nextOffset).toBe(8192);expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThan(64*1024);expect((await r.request('status')).used).toBe(status.used);
        const store:AssessmentStore=await h.reader();let s:number;try{s=store.sequence();}finally{store.close();}await r.request('artifact_read',{artifactId:artifactId!,offset:8192});const after:AssessmentStore=await h.reader();try{expect(after.sequence()).toBe(s!);}finally{after.close();}
        expect(await r.request('exec',{command:'reporting-may-run'})).toBeDefined();await expect(r.request('artifact_read',{artifactId:artifactId!,length:49153})).rejects.toThrow('range');await expect(r.request('artifact_read',{artifactId:'../../host-file'})).rejects.toThrow('opaque ID');
        await r.request('report',{report:{summary:'bounded synthesis',confidence:'low'}});await expect(r.request('artifact_read',{artifactId:artifactId!})).rejects.toThrow('stopped');
      }finally{r.close();}
    });
  });
  it('keeps cancellation prefixes explicitly interrupted/partial while closing authority before finalization',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');let ready!:()=>void,rejectOperation:((error:Error)=>void)|undefined;const started=new Promise<void>(resolve=>{ready=resolve;});
      const sandbox=h.sandboxes[0];sandbox.exec=async(_c:string,_s:number,_signal:AbortSignal,_w:string,onRunning:()=>void,onOutput:any)=>{onRunning?.();onOutput('stdout',Buffer.from('observed before cancellation'));ready();return new Promise((_resolve,reject)=>{rejectOperation=reject;});};
      const stop=sandbox.stop.bind(sandbox);sandbox.stop=async()=>{rejectOperation?.(Error('Cancelled'));await stop();};const operation=h.call('p2o_shell',{command:'inert interrupted stream'}).catch((e:Error)=>e);await started;await h.command('stop');expect(await operation).toBeInstanceOf(Error);
      const store:AssessmentStore=await h.reader();try{const a=store.artifacts()[0];expect(a).toMatchObject({captureOutcome:'interrupted',truncated:true});expect(store.artifact(a.id).text).toBe('observed before cancellation');expect(store.events({operationId:a.operationId}).rows.at(-1)?.kind).toBe('operation.unknown-terminal');}finally{store.close();}
    });
  });
  it('artifact publication/quota failure preserves known return, closes target authority and never retries execution',async()=>{
    let armed=false;await fixture(async h=>{
      await h.command('--target ./source');await h.call('p2o_note',{kind:'note',text:'prior retained commit'});armed=true;
      await expect(h.call('p2o_shell',{command:'single inert execution'})).rejects.toThrow('artifact publication failure');await h.command('stop');expect(h.sandboxes[0].commands).toHaveLength(1);expect(h.ctx.notices.join('\n')).toContain('execution authority closed');
      const store:AssessmentStore=await h.reader();try{expect(store.artifacts()).toEqual([]);expect(store.records().some(r=>r.text==='prior retained commit')).toBe(true);const returned=store.events({since:0}).rows.find(e=>e.kind==='operation.returned');expect(returned?.data).toMatchObject({retentionIncomplete:true,remoteOutcome:'returned'});expect(store.events({since:0}).rows.some(e=>e.kind==='operation.unknown-terminal')).toBe(false);}finally{store.close();}
    },stage=>{if(armed&&stage==='artifact-published'){armed=false;throw Error('injected private artifact publication failure');}});
  });
  it('ingests scratch with immutable producer/provenance links, empty-file support, redacted preview and no host path',async()=>{
    await fixture(async h=>{
      await writeFile(join(h.root,'isolated-settings.json'),JSON.stringify({p2o:{artifactCaptureKiB:1}}));
      await h.command('--target ./source');let bytes=Buffer.from('password=not-for-retention\nfirst retained file'),executed=0;
      h.sandboxes[0].captureScratch=async(path:string,maxBytes:number,_signal:AbortSignal,workdir:string,onRunning:()=>void,onOutput:any)=>{executed++;onRunning();onOutput('stdout',bytes);const before={size:bytes.length,device:'1',inode:'2',mtimeNs:'3',ctimeNs:'4',links:1};return {code:0,stdout:bytes.toString(),stderr:'',truncated:false,previewLimit:8192,scratchSnapshot:{version:1,path,root:workdir,totalBytes:bytes.length,offset:0,capturedBytes:bytes.length,prefixSha256:scratchPrefixHash(bytes),before,after:before,stable:true,encoding:'utf8-prefix'} as ScratchSnapshot};};
      const first=await h.call('p2o_capture',{path:'out.txt'});expect(first.content[0].text).toContain('first retained file');expect(JSON.stringify(first)).not.toContain('not-for-retention');expect(first.details.capture.artifacts).toHaveLength(1);const id=first.details.capture.artifacts[0].id;
      bytes=Buffer.from('replacement');await h.call('p2o_capture',{path:'out.txt'});const store:AssessmentStore=await h.reader();try{expect(store.artifact(id).text).toContain('first retained file');expect(store.artifact(id).manifest).toMatchObject({kind:'scratch-file',producer:'owner',captureSource:{path:'out.txt',root:'/work'}});expect((store.record(first.details.evidenceId)!.data!.capture as any).source.path).toBe('out.txt');}finally{store.close();}
      bytes=Buffer.alloc(0);const empty=await h.call('p2o_capture',{path:'empty.txt'});expect(empty.details.capture.artifacts[0]).toMatchObject({capturedInputBytes:0,totalBytes:0,bytes:0});
      // Segment capture: one long scratch file retained in bounded pieces, each with its own offset/hash range.
      const long=Buffer.from('A'.repeat(1023)+'\n'+'B'.repeat(1000)+'TAIL-SEGMENT-TWO'),segments:Array<{offset:number;bytes:Buffer}>=[];
      h.sandboxes[0].captureScratch=async(path:string,maxBytes:number,_signal:AbortSignal,workdir:string,onRunning:()=>void,onOutput:any,_seconds:number,offset=0)=>{executed++;onRunning();const slice=long.subarray(offset,offset+maxBytes);onOutput('stdout',slice);const before={size:long.length,device:'1',inode:'2',mtimeNs:'3',ctimeNs:'4',links:1};return {code:0,stdout:slice.toString(),stderr:'',truncated:false,scratchSnapshot:{version:2,path,root:workdir,totalBytes:long.length,offset,capturedBytes:slice.length,prefixSha256:scratchPrefixHash(slice),before,after:before,stable:true,encoding:'utf8-prefix',redactionContext:{bytes:Math.min(offset,8192),leadingFragment:offset>0&&long[offset-1]!==10,privateKey:'none'}} as ScratchSnapshot};};
      const firstSegment=await h.call('p2o_capture',{path:'long.txt',offset:0});segments.push({offset:0,bytes:long.subarray(0,1024)});
      const secondSegment=await h.call('p2o_capture',{path:'long.txt',offset:1024});segments.push({offset:1024,bytes:long.subarray(1024)});
      const segmented:AssessmentStore=await h.reader();try{for(const [index,receipt] of [firstSegment,secondSegment].entries()){const artifact=segmented.artifact(receipt.details.capture.artifacts[0].id);expect(artifact.manifest.captureSource).toMatchObject({path:'long.txt',offset:segments[index].offset,totalBytes:long.length});expect(artifact.text).toBe(segments[index].bytes.toString());expect(receipt.details.capture.artifacts[0]).toMatchObject({offset:segments[index].offset,totalBytes:long.length});}}finally{segmented.close();}
      expect(secondSegment.content[0].text).toContain('TAIL-SEGMENT-TWO');expect(secondSegment.details.capture.source.offset).toBe(1024);
      await expect(h.call('p2o_capture',{path:'long.txt',offset:-1})).rejects.toThrow('Scratch offset');await expect(h.call('p2o_capture',{path:'long.txt',offset:1073741825})).rejects.toThrow('Scratch offset');
      for(const path of ['/etc/passwd','../outside','x/../outside'])await expect(h.call('p2o_capture',{path})).rejects.toThrow('Scratch path');expect(executed).toBe(5);await h.command('stop');await expect(h.call('p2o_capture',{path:'out.txt'})).rejects.toThrow('No active');
    });
  });
  it('lets one capture lower the run cap but never raise it (P9/B TR-S07)',async()=>{
    await fixture(async h=>{
      await writeFile(join(h.root,'isolated-settings.json'),JSON.stringify({p2o:{artifactCaptureKiB:4}}));
      await h.command('--target ./source');
      const bounds:number[]=[];
      h.sandboxes[0].captureScratch=async(path:string,maxBytes:number,_signal:AbortSignal,workdir:string,onRunning:()=>void,onOutput:any)=>{bounds.push(maxBytes);onRunning();const bytes=Buffer.from('x'.repeat(maxBytes));const before={size:bytes.length,device:'1',inode:'2',mtimeNs:'3',ctimeNs:'4',links:1};onOutput('stdout',bytes);return {code:0,stdout:bytes.toString(),stderr:'',truncated:false,scratchSnapshot:{version:1,path,root:workdir,totalBytes:bytes.length,offset:0,capturedBytes:bytes.length,prefixSha256:scratchPrefixHash(bytes),before,after:before,stable:true,encoding:'utf8-prefix'} as ScratchSnapshot};};
      await h.call('p2o_capture',{path:'out.txt',maxKiB:1});
      // A per-call cap above the run setting is clamped to the setting, never used to raise it.
      await h.call('p2o_capture',{path:'out.txt',maxKiB:64});
      await h.call('p2o_capture',{path:'out.txt'});
      expect(bounds).toEqual([1024,4096,4096]);
      await expect(h.call('p2o_capture',{path:'out.txt',maxKiB:0})).rejects.toThrow('maxKiB');
    });
  });
  it('authenticates scratch roots/caps and command budgets; a stopped worker still cannot bypass admission',async()=>{
    await fixture(async h=>{
      await writeFile(join(h.root,'isolated-settings.json'),JSON.stringify({p2o:{artifactCaptureKiB:1}}));await h.command('--target ./source');
      const actor=(await h.call('p2o_delegate',{focus:'fixture',task:'capture inert scratch'})).details,ticket=await h.ticket(actor.workerId),c=new BrokerClient(ticket.socket,ticket.token);let rootSeen='',maxSeen=0,executed=0;
      h.sandboxes[0].captureScratch=async(path:string,maxBytes:number,_signal:AbortSignal,workdir:string,onRunning:()=>void,onOutput:any)=>{rootSeen=workdir;maxSeen=maxBytes;executed++;onRunning();const bytes=Buffer.from('x'.repeat(maxBytes)),before={size:4000,device:'1',inode:'2',mtimeNs:'3',ctimeNs:'4',links:1};onOutput('stdout',bytes);return {code:0,stdout:'preview',stderr:'',truncated:true,scratchSnapshot:{version:1,path,root:workdir,totalBytes:4000,offset:0,capturedBytes:bytes.length,prefixSha256:scratchPrefixHash(bytes),before,after:before,stable:true,encoding:'utf8-prefix'}};};
      try{await c.request('runtime',{model:ticket.requestedRuntime.model,thinking:ticket.requestedRuntime.thinking});const before=await c.request('status');const result=await c.request('capture',{path:'out.txt',root:'/etc',workdir:'/work/other',maxBytes:8388608,by:'owner'});expect(rootSeen).toBe(`/work/${actor.workerId}`);expect(maxSeen).toBe(1024);expect((await c.request('status')).used).toBe(before.used+1);expect(result.capture.artifacts[0]).toMatchObject({totalBytes:4000,capturedInputBytes:1024,truncated:true});expect(result.capture.source.root).toBe(rootSeen);const lowered=await c.request('capture',{path:'out.txt',maxBytes:512});expect(maxSeen).toBe(512);expect((await c.request('status')).used).toBe(before.used+2);expect(lowered.capture.artifacts[0]).toMatchObject({capturedInputBytes:512});await expect(c.request('capture',{path:'../outside'})).rejects.toThrow('Scratch path');expect(executed).toBe(2);}finally{c.close();}
      const reporter=(await h.call('p2o_delegate',{focus:'report',task:'synthesize existing receipts',role:'reporting'})).details,rt=await h.ticket(reporter.workerId),r=new BrokerClient(rt.socket,rt.token);try{await r.request('runtime',{model:rt.requestedRuntime.model,thinking:rt.requestedRuntime.thinking});expect(await r.request('capture',{path:'out.txt'})).toBeDefined();expect((await r.request('status')).used).toBe(1);await r.request('report',{report:{summary:'partial synthesis',confidence:'low'}});await expect(r.request('capture',{path:'out.txt'})).rejects.toThrow('stopped');}finally{r.close();}
    });
  });
  it('rejects forged scratch producer/hash metadata after a known read without closing authority or replaying',async()=>{
    await fixture(async h=>{await h.command('--target ./source');let executed=0;h.sandboxes[0].captureScratch=async(_path:string,_cap:number,_signal:AbortSignal,_workdir:string,onRunning:()=>void,onOutput:any)=>{executed++;onRunning();const bytes=Buffer.from('captured'),before={size:bytes.length,device:'1',inode:'2',mtimeNs:'3',ctimeNs:'4',links:1};onOutput('stdout',bytes);return {code:0,stdout:'preview',stderr:'',truncated:false,scratchSnapshot:{version:1,path:'out.txt',root:'/work/other',totalBytes:bytes.length,offset:0,capturedBytes:bytes.length,prefixSha256:'a'.repeat(64),before,after:before,stable:true,encoding:'utf8-prefix'}};};await expect(h.call('p2o_capture',{path:'out.txt'})).rejects.toThrow('provenance');
      // A forged capture is an artifact-input refusal, not a storage fault: no authority shutdown, and the run keeps working.
      expect(h.ctx.notices.join('\n')).not.toContain('execution authority closed');await h.call('p2o_shell',{command:'after forged capture'});
      await h.command('stop');expect(executed).toBe(1);const store:AssessmentStore=await h.reader();try{expect(store.artifacts().filter(a=>a.kind==='scratch-file')).toEqual([]);expect(store.events({since:0}).rows.find(e=>e.kind==='operation.returned'&&(e.data as any)?.retentionIncomplete)?.data).toMatchObject({retentionIncomplete:true,remoteOutcome:'returned'});}finally{store.close();}});
  });
  it('exports and imports a portable bundle through human commands only, preserving knowledge without authority',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');const ack=(await h.call('p2o_note',{kind:'note',text:'retained for portable export'})).details;await h.call('p2o_shell',{command:'inert portable artifact'});await h.command('checkpoint before export');
      const bundle=join(h.root,'portable-bundle');
      await h.command(`export ${bundle}`);expect(h.screen()).toContain('Exported');expect(h.ctx.confirmBodies.at(-1)).toContain('redacted');
      const index=JSON.parse(await readFile(join(bundle,'manifest.json'),'utf8'));expect(index).toMatchObject({runId:await h.runId(),redactionVersion:2,authorityRestored:false});expect(index.files.length).toBeGreaterThan(1);expect(index.files.some((f:{kind:string})=>f.kind==='artifact')).toBe(true);
      await h.command(`export ${bundle}`);expect(h.ctx.notices.at(-1)).toContain('already exists');
      await h.command(`export ${join(h.root,'.p2o-state','nested')}`);expect(h.ctx.notices.at(-1)).toContain('outside the private state');
      await h.command('export relative/dir');expect(h.ctx.notices.at(-1)).toContain('absolute host directory');
      const runId=await h.runId();await h.command('stop');const fresh=createFakePi(),ctx=createContext({cwd:h.root});registerP2O(fresh.pi,h.options);const freshCommand=(s:string)=>fresh.commands.get('p2o').handler(s,ctx.ctx);
      await freshCommand(`import ${bundle}`);expect(ctx.notices.at(-1)).toContain('No active or explicitly opened knowledge store');
      await freshCommand(`open ${runId}`);await freshCommand(`export ${join(h.root,'historical-bundle')}`);expect(ctx.notices.at(-1)).toContain('requires the active owner run');
      await freshCommand(`import ${bundle}`);expect(ctx.notices.at(-1)).toContain('requires the active owner run');await freshCommand('close');
      const freshCall=(name:string,params:any)=>fresh.tools.get(name).execute(randomUUID(),params,undefined,undefined,ctx.ctx);
      await freshCommand('--target ./source');await freshCall('p2o_note',{kind:'note',text:'target run knowledge'});
      ctx.setConfirm(true);await freshCommand(`import ${bundle}`);expect(ctx.confirmBodies.at(-1)).toContain('never same-run evidence');expect(ctx.screens.at(-1).render(200).join('\n')).toContain('Knowledge only');
      const imported=[];for(const id of await readdir(join(h.root,'.p2o-state'))){const candidate=AssessmentStore.open(join(h.root,'.p2o-state'),id);try{if(candidate.records().some(r=>r.data?.bundleSha256===index.bundleSha256))imported.push({id,store:candidate});}catch{/* not a readable run */}finally{if(!imported.some(entry=>entry.store===candidate))candidate.close();}}
      expect(imported).toHaveLength(1);const {id:importRunId,store}=imported[0];
      try{expect(store.records().some(r=>r.kind==='evidence')).toBe(false);expect(store.artifacts().filter(a=>a.importedFrom)).toHaveLength(index.counts.files);expect(store.record(ack.recordId)).toBeUndefined();expect(importRunId).not.toBe(runId);}finally{store.close();}
      await freshCommand(`import ${bundle}`);expect(ctx.notices.at(-1)).toContain('already imported');
      await writeFile(join(bundle,index.files.find((f:{kind:string})=>f.kind==='artifact').name),'tampered');await freshCommand(`import ${bundle}`);expect(ctx.notices.at(-1)).toContain('integrity is partial');
      await expect(freshCall('p2o_artifact',{id:'artifact-'+'0'.repeat(36)})).rejects.toThrow('Unknown artifact ID');
    });
  });
  it('reconciles a stopped run only with confirmation, and refuses while a live writer holds the lock',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');let ready!:()=>void,rejectOperation:((error:Error)=>void)|undefined;const started=new Promise<void>(resolve=>{ready=resolve;});const sandbox=h.sandboxes[0];
      sandbox.exec=async(_c:string,_s:number,_signal:AbortSignal,_w:string,onRunning:()=>void)=>{onRunning?.();ready();return new Promise((_resolve,reject)=>{rejectOperation=reject;});};
      const stop=sandbox.stop.bind(sandbox);sandbox.stop=async()=>{rejectOperation?.(Error('Cancelled'));await stop();};const operation=h.call('p2o_shell',{command:'inert hanging work'}).catch((e:Error)=>e);await started;await h.command('stop');await operation;
      const runId=await h.runId();
      const live=AssessmentStore.open(join(h.root,'.p2o-state'),runId,{readOnly:false});
      try{await h.command(`reconcile ${runId}`);expect(h.ctx.notices.at(-1)).toMatch(/locked|busy/i);const blocked:AssessmentStore=await h.reader();try{expect(blocked.interruptedState().latestReconciliation).toBeUndefined();}finally{blocked.close();}}finally{live.close();}
      const fresh=createFakePi(),ctx=createContext({cwd:h.root});registerP2O(fresh.pi,h.options);const freshCommand=(s:string)=>fresh.commands.get('p2o').handler(s,ctx.ctx);
      ctx.setConfirm(false);await freshCommand(`reconcile ${runId}`);expect(ctx.confirmBodies.at(-1)).toContain('non-terminal');expect(ctx.confirmBodies.at(-1)).toContain('not rewritten');const unchanged:AssessmentStore=await h.reader();try{expect(unchanged.interruptedState().latestReconciliation).toBeUndefined();}finally{unchanged.close();}
      ctx.setConfirm(true);await freshCommand(`reconcile ${runId} process exited mid-operation`);const screen=ctx.screens.at(-1).render(200).join('\n');expect(screen).toContain('Interruption reconciled');expect(screen).toContain('HISTORICAL');
      const store:AssessmentStore=await h.reader();try{const state=store.interruptedState();expect(state.latestReconciliation?.data?.reconciliation).toMatchObject({by:'owner',reason:'process exited mid-operation',authorityRestored:false,resume:false});expect(state.unknownOperationIds).toHaveLength(1);expect(state.runningTaskIds).toEqual([]);expect(store.records().find(r=>r.id===state.latestReconciliation!.id)?.kind).toBe('lifecycle');}finally{store.close();}
      await freshCommand(`open ${runId}`);expect(ctx.screens.at(-1).render(200).join('\n')).toContain('Reconciled @');
      await freshCommand(`reconcile ${runId} second pass`);expect(ctx.screens.at(-1).render(200).join('\n')).toContain('Interruption reconciled');
      await freshCommand('close');
    });
  });
  it('records and reads the typed asset graph through owner/worker tools with role limits and idempotent replay',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');
      const assetId='asset-'+'0'.repeat(24),before=await h.call('p2o_graph',{action:'page'});
      const recorded=await h.call('p2o_graph',{action:'record',batch:{assets:[{asset:{kind:'endpoint',key:'GET /admin'}}]}});
      expect(recorded.details.acks[0]).toMatchObject({kind:'asset',revision:1,created:true});
      const entityId=recorded.details.acks[0].entityId as string;
      const evidenceId=(await h.call('p2o_note',{kind:'evidence',text:'bounded inert receipt'})).details.recordId as string;
      // A1: the note kind is optional and omitted means the generic note, recorded without refusing the call.
      expect((await h.call('p2o_note',{text:'default-kind observation'})).details.kind).toBe('note');
      await h.call('p2o_graph',{action:'record',batch:{facts:[{assetId:entityId,kind:'observed',statement:'gate runs server-side',confidence:'high',evidenceRefs:[evidenceId]}]}});
      await expect(h.call('p2o_graph',{action:'record',batch:{facts:[{assetId:entityId,kind:'observed',statement:'unbacked claim',confidence:'low'}]}})).rejects.toThrow('same-run evidence receipt');
      expect(await h.call('p2o_graph',{action:'record',batch:{assets:[{asset:{kind:'endpoint',key:'GET /admin'}}]}})).toMatchObject({details:{acks:[{created:false}]}});
      const view=await h.call('p2o_graph',{action:'view',id:entityId});expect(view.details.assertions[0]).toMatchObject({statement:'gate runs server-side',stale:false});
      const exported=await h.call('p2o_graph',{action:'export',limit:10});expect(exported.details.mermaid).toContain('graph LR');expect(exported.content[0].text).toContain('graph LR');
      await h.command('graph');expect(h.screen()).toContain('Asset graph scope');expect(h.screen()).toContain('GET /admin');
      await h.command(`graph ${entityId}`);expect(h.screen()).toContain('fact');expect(h.screen()).toContain('gate runs server-side');
      await expect(h.call('p2o_graph',{action:'view',id:assetId})).rejects.toThrow('Unknown asset entity');
      // Worker: assets/facts/anchors allowed over the authenticated broker, owner-only rows denied; replay is ACK-only.
      const worker=(await h.call('p2o_delegate',{focus:'graph fixture',task:'record inert graph rows'})).details,ticket=await h.ticket(worker.workerId),client=new BrokerClient(ticket.socket,ticket.token);
      try {
        await client.request('runtime',{model:ticket.requestedRuntime.model,thinking:ticket.requestedRuntime.thinking});
        const first=await client.request('graph_record',{batch:{assets:[{asset:{kind:'file',key:'src/gate.py'}}]}},{requestId:'worker-graph-1'});
        expect(first.value[0]).toMatchObject({kind:'asset',revision:1,created:true});
        const replay=await client.request('graph_record',{batch:{assets:[{asset:{kind:'file',key:'src/gate.py'}}]}},{requestId:'worker-graph-1'});
        expect(replay.replayed).toBe(true);expect(replay.value).toEqual(first.value);
        await expect(client.request('graph_record',{batch:{assets:[{asset:{kind:'file',key:'src/other.py'}}]}},{requestId:'worker-graph-1'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
        await expect(client.request('graph_record',{batch:{hypotheses:[{assetId:first.value[0].entityId,statement:'owner-only',status:'open'}]}})).rejects.toThrow('owner review work');
        await expect(client.request('graph_record',{batch:{relations:[{kind:'depends_on',fromId:first.value[0].entityId,toId:first.value[0].entityId}]}})).rejects.toThrow('owner review work');
        const read=await client.request('graph_read',{graphOp:'view',assetId:first.value[0].entityId});expect(read.value.assertions).toEqual([]);
        const store:AssessmentStore=await h.reader();try{expect(store.events({since:0}).rows.filter(row=>row.kind==='asset.upserted')).toHaveLength(2);}finally{store.close();}
      } finally { client.close(); }
      const reporter=(await h.call('p2o_delegate',{focus:'report',task:'synthesize existing receipts',role:'reporting'})).details,rt=await h.ticket(reporter.workerId),reportClient=new BrokerClient(rt.socket,rt.token);
      try { await reportClient.request('runtime',{model:rt.requestedRuntime.model,thinking:rt.requestedRuntime.thinking});
        await expect(reportClient.request('graph_record',{batch:{assets:[{asset:{kind:'file',key:'reporter.py'}}]}})).rejects.toThrow('synthesis-only');
        const allowed=await reportClient.request('graph_read',{graphOp:'page',limit:5});expect(allowed.value.total).toBeGreaterThan(0);
      } finally { reportClient.close(); }
      expect(before.details.total).toBe(0);
    });
  });
  it('deduplicates two concurrently authenticated graph writers, keeps both assignment provenances, and does not execute or wake a model',async()=>fixture(async h=>{
    await h.command('--target ./source');const clients:BrokerClient[]=[],workers:any[]=[];
    try{
      for(let i=0;i<2;i++){const w=(await h.call('p2o_delegate',{focus:'recon-'+i,task:'record only bounded knowledge'})).details,t=await h.ticket(w.workerId),c=new BrokerClient(t.socket,t.token);workers.push(w);clients.push(c);
        await c.request('runtime',{model:t.requestedRuntime.model,thinking:t.requestedRuntime.thinking});}
      const batch={assets:[{asset:{kind:'endpoint',key:'GET https://out-of-scope.invalid/private'}}]};
      const results=await Promise.all(clients.map((c,i)=>c.request('graph_record',{batch},{requestId:'concurrent-'+i})));
      expect(results[0].value[0].entityId).toBe(results[1].value[0].entityId);expect(results.filter(r=>r.value[0].created)).toHaveLength(1);
      const view=(await clients[0].request('graph_read',{graphOp:'view',assetId:results[0].value[0].entityId})).value;
      expect(view.counts).toMatchObject({revisions:1,provenance:2});expect(view.provenance.map((p:any)=>p.actorId).sort()).toEqual(workers.map(w=>w.workerId).sort());
      for(const p of view.provenance){expect(p.role).toBe('general');expect(p.depth).toBe(1);expect(p.taskId).toMatch(/^task-[a-f0-9-]{36}$/);}
      await expect(clients[0].request('graph_record',{batch,producer:{actorId:'owner'}})).rejects.toThrow('host-owned');
      await expect(clients[0].request('graph_read',{graphOp:'page',limit:'10'})).rejects.toThrow('cursor/limit');
      await expect(clients[0].request('graph_read',{graphOp:'page',scope:'foreign'})).rejects.toThrow('host-owned');
      expect(h.sandboxes.flatMap((s:InertSandbox)=>s.commands)).toEqual([]);expect(h.sandboxes.flatMap((s:InertSandbox)=>s.httpCalls)).toEqual([]);expect(h.pi.messages).toHaveLength(1);
      await h.command('graph export');expect(h.screen()).toContain('Graph JSON/Mermaid');expect(h.screen()).toContain('https://out-of-scope.invalid/private');
      h.ctx.screens.at(-1).handleInput('\u001b[6~');expect(h.screen()).toContain('graph LR');
      const page=await clients[0].request('graph_read',{graphOp:'export',limit:500});expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64*1024);
    }finally{clients.forEach(c=>c.close());}
  }));
  it('exposes working graph reads/ACKs in Worker and reporting tool loadouts, but denies model/broker writes after report',async()=>fixture(async h=>{
    await h.command('--target ./source');const descriptor=(await h.call('p2o_delegate',{focus:'graph worker',task:'inspect graph data',role:'reporting'})).details,ticket=await h.ticket(descriptor.workerId);
    const worker=createFakePi(),model=String(ticket.requestedRuntime.model),slash=model.indexOf('/'),ctx=createContext({cwd:h.root,model:{provider:slash<0?'p2o-inert':model.slice(0,slash),id:slash<0?model:model.slice(slash+1)}});
    (ctx.ctx as {thinkingLevel:string}).thinkingLevel=ticket.requestedRuntime.thinking;registerP2O(worker.pi,{extensionPath:EXTENSION_PATH});
    worker.flags['p2o-worker']=join(h.root,'control',(await readdir(join(h.root,'control')))[0],`ticket-${descriptor.workerId}.json`);
    await worker.events.get('session_start')![0]({},ctx.ctx);expect(worker.active).toEqual(reporterTools()); // read-only second reader: no p2o_graph, no target tools
    const call=(name:string,p:any)=>worker.tools.get(name).execute(randomUUID(),p,undefined,undefined,ctx.ctx);
    try{
      const read=await call('p2o_graph',{action:'page',limit:5});expect(read.details).toMatchObject({uniqueAssets:0,rows:[]});expect(read.content[0].text).toContain('uniqueAssets');
      await expect(call('p2o_graph',{action:'record',batch:{assets:[{asset:{kind:'file',key:'forbidden'}}]}})).rejects.toThrow('synthesis-only');
      await expect(h.call('p2o_graph',{action:'view'})).rejects.toThrow('view needs');await expect(h.call('p2o_graph',{action:'page',batch:{assets:[]}})).rejects.toThrow('host-owned');
      await call('p2o_report',{summary:'read-only synthesis, no findings',findings:[],evidence:[],coverage:[],openItems:[],confidence:'low'});
      await expect(call('p2o_graph',{action:'page'})).rejects.toThrow(/No active|worker/);
    }finally{for(const fn of worker.events.get('session_shutdown')??[])await fn({},ctx.ctx);}
    // Separate general worker: the client envelope is unwrapped into real ACKs and real view details.
    const w=(await h.call('p2o_delegate',{focus:'graph write',task:'record a bounded file observation'})).details;
    const pi=createFakePi(),context=createContext({cwd:h.root});registerP2O(pi.pi,{extensionPath:EXTENSION_PATH});pi.flags['p2o-worker']=join(h.root,'control',(await readdir(join(h.root,'control')))[0],`ticket-${w.workerId}.json`);
    await pi.events.get('session_start')![0]({},context.ctx);
    try{const result=await pi.tools.get('p2o_graph').execute(randomUUID(),{action:'record',batch:{assets:[{asset:{kind:'file',key:'src/gate.py'}}]}},undefined,undefined,context.ctx);
      expect(result.details.acks).toHaveLength(1);const id=result.details.acks[0].entityId;
      const read=await pi.tools.get('p2o_graph').execute(randomUUID(),{action:'view',id},undefined,undefined,context.ctx);expect(read.details.entityId).toBe(id);expect(read.details.counts.provenance).toBe(1);
    }finally{for(const fn of pi.events.get('session_shutdown')??[])await fn({},context.ctx);}
    void ticket;
  }));
  it('matches exact work before dispatch, keeps owner-only plans, and reads human cards without extra model/target work',async()=>fixture(async h=>{
    await h.command('--target ./source');await seedImpactGoal(h);expect(h.pi.active).toContain('p2o_plan_author');
    const asset=(await h.call('p2o_graph',{action:'record',batch:{assets:[{asset:{kind:'endpoint',key:'GET /fixture'}}]}})).details.acks[0];
    const draft={question:'Does the declared fixture gate reach the consumer?',surface:'/fixture',risk:'boundary',role:'general',roleReason:'Bounded inert source comparison only',expectedTrue:'Declared actor reaches the consumer',expectedFalse:'Control actor cannot reach the consumer',stopCondition:'Stop after one bounded observation or a concrete gap',evidenceIds:[],prerequisites:[],skills:[],methodReason:'Smallest inert source observation, no live target',
      work:{assetRefs:[{id:asset.entityId,revision:1}],questionKey:'policy:fixture',actorContext:'actor:fixture',tenantContext:'tenant:fixture',methodFamily:'source-trace',purpose:'investigation'},decision:{disposition:'new',reason:'No prior matching structured attempt exists'},outputContract:{kind:'investigation',required:['evidence','gaps'],partialAllowed:true,artifactPolicy:'ids-only'}};
    const task=(await h.call('p2o_task_author',{draft})).details,goal={kind:'goal',title:'Review one declared fixture boundary',status:'active',reason:'Explicit bounded inert planning fixture only',criteria:['Owner must inspect attribution and an effective control'],taskIds:[task.id],proof:{kind:'capability',capability:{kind:'http.request',subject:'fixture'}}};
    const plan=(await h.call('p2o_plan_author',{entry:goal,requestId:'runtime-goal'})).details;
    const reader:AssessmentStore=await h.reader(),before=reader.sequence();reader.close();
    expect((await h.call('p2o_plan_author',{entry:goal,requestId:'runtime-goal'})).details).toMatchObject({id:plan.id,replayed:true});
    const duplicate=(await h.call('p2o_task_author',{draft:{...draft,question:'Different prose for the same structured question',surface:'another textual alias'}})).details;
    expect(duplicate.already_covered_by).toEqual([task.id]);expect((await h.call('p2o_board',{board: 'tasks'})).details.total).toBe(1);
    // P8.3: create is the only duplicate/history preflight, and an exact active attempt returns the match payload instead of creating.
    expect((await h.call('p2o_task_author',{draft})).details.confidence).toBe('exact');
    await h.call('p2o_board',{board: 'plans'});await h.command('heads goal');expect(h.screen()).toContain(plan.id);await h.command(`show goal ${plan.id}`);expect(h.ctx.screens.at(-1).render(4000).join('\n')).toContain(goal.reason);
    const read:AssessmentStore=await h.reader();try{expect(read.sequence()).toBe(before);}finally{read.close();}
    const context=await h.pi.events.get('context')[0]({messages:[]},h.ctx.ctx);expect(JSON.stringify(context.messages)).toContain(plan.id);
    await expect(h.call('p2o_board',{board: 'plans',entry:goal})).rejects.toThrow('host-owned');await expect(h.call('p2o_task_author',{action:'bogus',id:task.id})).rejects.toThrow('host-owned');
    await h.call('p2o_task_dispatch',{ids:[task.id]});// P18/D49: the fixed 800 ms coalescing window delays the spawn, so wait past it.
    for(let i=0;i<400;i++){if((await h.call('p2o_workers')).details.workers.length)break;await delay(5);}
    expect((await h.call('p2o_workers')).details.workers).toHaveLength(1);expect(h.sandboxes[0].commands).toHaveLength(0);expect(h.pi.messages).toHaveLength(1);
  }));
  it('reviews canonical cases and proof-aware coverage without merging claims, widening scope or adding target/model work',async()=>fixture(async h=>{
    await h.command('--target ./source');await seedImpactGoal(h);expect(h.pi.active).toEqual(expect.arrayContaining(['p2o_case_author','p2o_coverage_plan']));
    const asset=(await h.call('p2o_graph',{action:'record',batch:{assets:[{asset:{kind:'endpoint',key:'GET /case-fixture'}}]}})).details.acks[0],taskDraft={question:'Does the bounded fixture observation match the declared policy?',surface:'/case-fixture',risk:'authorization',role:'general',roleReason:'Bounded inert observation for case review only',expectedTrue:'Receipt records the expected policy observation',expectedFalse:'Receipt records the contrasting control',stopCondition:'Stop after one inert command and owner review',evidenceIds:[],prerequisites:[],skills:[],methodReason:'One inert command with no external target',
      // A3: one structured work identity is the whole denominator entry; the host derives its axes from reviewed work.
      work:{assetRefs:[{id:asset.entityId,revision:1}],questionKey:'question:runtime-case',policyKey:'policy:runtime-case',actorContext:'actor:fixture',tenantContext:'tenant:fixture',methodFamily:'offline-observation',purpose:'investigation'}};
    const task=(await h.call('p2o_task_author',{draft:taskDraft})).details,running=(await h.call('p2o_task_start',{id:task.id})).details,observation=(await h.call('p2o_shell',{command:'printf bounded-case-observation'})).details,reviewed=(await h.call('p2o_task_review',{id:task.id,revision:running.revision,reason:'Owner reviewed the exact inert receipt for bounded coordination',evidenceIds:[observation.evidenceId]})).details;
    const candidate={candidate:'runtime-case-claim',surface:'/case-fixture',risk:'authorization',closure:'confirmed',execution:'tested',proof:'offline_reproduction',evidenceRefs:[observation.evidenceId],negativeControls:[],policyBasis:'boundary_invariant',expectedPolicy:'Declared fixture actor/object boundary',limitations:'Only one inert fixture actor and endpoint were reviewed'},claim=await seedClaim(h,candidate),
      caseDraft={title:'Runtime fixture boundary case',policyKey:'policy:runtime-case',rootCauseKey:'root:fixture-gate',assetRefs:[{id:asset.entityId,revision:1}],claimRefs:[claim.id],independentEvidenceRefs:[],taskRefs:[{taskId:task.id,revision:reviewed.revision}],reportRefs:[],contradictions:[],affectedVariants:['variant:read'],relatedCaseIds:[],verdict:'confirmed',reviewStatus:'pending',reviewReason:'Pending exact owner review of current support',limitations:'Only the retained inert fixture receipt and declared policy are covered',remediation:{status:'unplanned',reason:'No remediation was implemented or reviewed in this fixture',evidenceRefs:[]}},pending=(await h.call('p2o_case_author',{entry:caseDraft,requestId:'runtime-case'})).details;
    expect((await h.call('p2o_case_author',{entry:caseDraft,requestId:'runtime-case'})).details).toMatchObject({id:pending.id,replayed:true});const accepted=(await h.call('p2o_case_author',{id:pending.id,revision:1,entry:{...caseDraft,reviewStatus:'accepted',reviewReason:'Owner reviewed exact current claim, task, asset and limitations'}})).details;expect(accepted).toMatchObject({revision:2,reviewStatus:'accepted'});
    const planInput={title:'Runtime explicit coverage denominator',status:'active',reason:'One declared asset/question/actor cell for inert acceptance',exclusions:['No undeclared endpoints or actors'],unknownScope:['Deployment parity remains unknown']},plan=(await h.call('p2o_coverage_plan',{plan:planInput,requestId:'runtime-coverage'})).details;expect((await h.call('p2o_coverage_plan',{plan:planInput,requestId:'runtime-coverage'})).details).toMatchObject({id:plan.id,replayed:true});
    const cell=(await h.call('p2o_board',{board:'coverage',id:plan.id})).details.cells[0];
    expect(cell).toMatchObject({questionKey:'question:runtime-case',execution:'tested',assessment:'accepted'});const reader:AssessmentStore=await h.reader(),before=reader.sequence();reader.close();const commands=h.sandboxes[0].commands.length,messages=h.pi.messages.length;
    await h.call('p2o_board',{board: 'cases'});await h.call('p2o_board',{board: 'coverage'});await h.command('heads case');expect(h.screen()).toContain(accepted.id);await h.command(`show case ${accepted.id}`);expect(h.ctx.screens.at(-1).render(4000).join('\n')).toContain(caseDraft.title);
    // A3: projected cells have no stored knowledge head, so their own axes/currentness are read from the plan view.
    const cellView=(await h.call('p2o_board',{board:'coverage',id:plan.id})).details.cells.find((row:any)=>row.id===cell.id);expect(cellView).toMatchObject({currentness:'current',effectiveExecution:'tested',effectiveAssessment:'accepted'});expect(String(cellView.reason)).toContain('accepted case');await h.command('report');expect(h.screen()).toContain('acceptedUnique=true');
    const read:AssessmentStore=await h.reader();try{expect(read.sequence()).toBe(before);}finally{read.close();}expect(h.sandboxes[0].commands).toHaveLength(commands);expect(h.pi.messages).toHaveLength(messages);
    await seedClaim(h,{...candidate,closure:'open_proof_gap',execution:'not_tested',proof:'static_trace',supersedes:claim.id,limitations:'Later review withdrew the effect; proof remains open'});expect((await h.call('p2o_board',{board: 'cases',id:accepted.id})).details).toMatchObject({currentness:'stale',acceptedFinding:false});expect((await h.call('p2o_board',{board:'coverage',id:plan.id})).details.cells.find((row:any)=>row.id===cell.id)).toMatchObject({currentness:'stale',effectiveAssessment:'stale'});
    await h.command('checkpoint K5 review queue');const store:AssessmentStore=await h.reader();try{expect(store.checkpoints().at(-1)?.review).toMatchObject({cases:1,uniqueAcceptedFindings:0,staleCases:1,coveragePlans:1,coverageCells:1,staleCoverageCells:1});expect(store.events({since:0,limit:100}).rows.some(row=>row.kind==='support.invalidated')).toBe(true);}finally{store.close();}
  }));
  it('turns reportless provider error into one atomic partial phase card without a further model turn',async()=>fixture(async h=>{
    await h.command('--target ./source');const w=(await h.call('p2o_delegate',{focus:'provider failure',task:'bounded inert observation'})).details,ticket=await h.ticket(w.workerId),pi=createFakePi(),profile=String(ticket.requestedRuntime.model),slash=profile.indexOf('/'),ctx=createContext({cwd:h.root,model:{provider:profile.slice(0,slash),id:profile.slice(slash+1)}});
    (ctx.ctx as {thinkingLevel:string}).thinkingLevel=ticket.requestedRuntime.thinking;registerP2O(pi.pi,{extensionPath:EXTENSION_PATH});pi.flags['p2o-worker']=join(h.root,'control',(await readdir(join(h.root,'control')))[0],`ticket-${w.workerId}.json`);
    await pi.events.get('session_start')[0]({},ctx.ctx);expect(pi.active).not.toContain('p2o_plan_author');expect(pi.active).not.toContain('p2o_case_author');expect(pi.active).not.toContain('p2o_coverage_plan');
    try{
      await expect(pi.tools.get('p2o_board').execute(randomUUID(),{board:'plans'},undefined,undefined,ctx.ctx)).rejects.toThrow('No active');await expect(pi.tools.get('p2o_board').execute(randomUUID(),{board:'cases'},undefined,undefined,ctx.ctx)).rejects.toThrow('No active');await expect(pi.tools.get('p2o_board').execute(randomUUID(),{board:'coverage'},undefined,undefined,ctx.ctx)).rejects.toThrow('No active');
      await pi.events.get('agent_before_settle')[0]({outcome:'error',continue:false,context:{contextMessages:[{role:'assistant',errorMessage:'Inert provider fault'}],pendingMessages:[]}},ctx.ctx);
      const read:AssessmentStore=await h.reader();let phaseId:string;
      try{const rows=read.records().filter(row=>row.data?.phase);expect(rows).toHaveLength(1);const phase=rows[0].data!.phase as {id:string;outcome:string;delivery:string};phaseId=phase.id;
        expect(phase).toMatchObject({outcome:'provider-error',delivery:'blocked',reviewStatus:'pending',observed:{evidence:0,findingClaims:0}});
        expect(read.records().filter(row=>row.kind==='report')).toHaveLength(1);expect(read.records().filter(row=>row.kind==='task').at(-1)!.data!.task).toMatchObject({status:'reported',phasePacketId:phaseId});
      }finally{read.close();}
      await h.command(`show phase ${phaseId!}`);expect(h.screen()).toContain('provider-error');await h.command('heads phase');expect(h.screen()).toContain(phaseId!);
      const client=new BrokerClient(ticket.socket,ticket.token);try{await expect(client.request('exec',{command:'true'})).rejects.toThrow(/stopped|revoked|Unauthorized/);}finally{client.close();}
      expect(pi.messages).toHaveLength(0);expect(h.pi.messages).toHaveLength(1);expect(h.sandboxes[0].commands).toHaveLength(0);
    }finally{for(const fn of pi.events.get('session_shutdown')??[])await fn({},ctx.ctx);}
  }));
  it('recovers a committed plan ACK without duplicating a goal or event, and remains read-only after finish',async()=>{
    let armed=false;await fixture(async h=>{
      await h.command('--target ./source');const entry={kind:'goal',title:'One inert planning checkpoint goal',status:'active',reason:'Explicit local fixture with no target execution',criteria:['Owner must review the retained limitations'],proof:{kind:'capability',capability:{kind:'http.request',subject:'fixture'}}};armed=true;
      const a=(await h.call('p2o_plan_author',{entry,requestId:'lost-plan-ack'})).details;expect(a.replayed).toBe(true);
      const b=(await h.call('p2o_plan_author',{entry,requestId:'lost-plan-ack'})).details;expect(b.id).toBe(a.id);await expect(h.call('p2o_plan_author',{entry:{...entry,title:'different payload'},requestId:'lost-plan-ack'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      const read:AssessmentStore=await h.reader();try{expect(read.records().filter(row=>row.data?.plan)).toHaveLength(1);expect(read.events({limit:100}).rows.filter(row=>row.correlationId==='lost-plan-ack')).toHaveLength(1);}finally{read.close();}
      await h.call('p2o_finish');await expect(h.call('p2o_board',{board: 'plans'})).rejects.toThrow('No active');await h.command('stop');
      const fresh=createFakePi(),context=createContext({cwd:h.root});registerP2O(fresh.pi,h.options);const command=(text:string)=>fresh.commands.get('p2o').handler(text,context.ctx);
      try{await command(`open ${await h.runId()}`);await command('heads goal');expect(context.screens.at(-1).render(200).join('\n')).toContain(a.id);expect(fresh.messages).toHaveLength(0);}finally{await command('close');}
      expect(h.sandboxes[0].commands).toHaveLength(0);
    },stage=>{if(armed&&stage==='after-commit'){armed=false;throw Error('Lost plan ACK after commit');}});
  });
  it('rolls back a failed plan mutation and closes target authority before any retry or finalization',async()=>{
    let armed=false;await fixture(async h=>{
      await h.command('--target ./source');armed=true;
      await expect(h.call('p2o_plan_author',{entry:{kind:'goal',title:'A plan that must not commit',status:'active',reason:'Injected storage fixture only; never retry a target',criteria:['An attributed receipt must be reviewed'],proof:{kind:'capability',capability:{kind:'http.request',subject:'fixture'}}},requestId:'failed-plan'})).rejects.toThrow('plan SQLite fault');
      await expect(h.call('p2o_shell',{command:'true'})).rejects.toThrow(/No active|NO_ASSESSMENT/);expect(h.ctx.notices.join('\n')).toContain('execution authority closed immediately');
      for(let i=0;i<100;i++){const read:AssessmentStore=await h.reader();let done=false;try{done=Boolean(read.outcome());}finally{read.close();}if(done)break;await delay(5);}
      const read:AssessmentStore=await h.reader();try{expect(read.records().filter(row=>row.data?.plan)).toHaveLength(0);expect(read.outcome()).toMatchObject({assessmentOutcome:'blocked',resourceOutcome:'cleaned'});}finally{read.close();}
      expect(h.sandboxes[0].commands).toHaveLength(0);
    },stage=>{if(armed&&stage==='before-commit'){armed=false;throw Object.assign(Error('plan SQLite fault'),{code:'ERR_SQLITE_ERROR'});}});
  });
  it('recovers only committed graph ACKs after a delivery fault and revokes immediately on a genuine graph storage failure',async()=>{
    let mode:'none'|'ack'|'storage'='none';await fixture(async h=>{
      await h.command('--target ./source');const w=(await h.call('p2o_delegate',{focus:'graph receipt',task:'record one bounded asset'})).details,t=await h.ticket(w.workerId),c=new BrokerClient(t.socket,t.token);
      try{await c.request('runtime',{model:t.requestedRuntime.model,thinking:t.requestedRuntime.thinking});mode='ack';
        const batch={assets:[{asset:{kind:'file',key:'committed.py'}}]},first=await c.request('graph_record',{batch},{requestId:'lost-graph-ack'});
        expect(first).toMatchObject({replayed:true,value:[{created:true}]});expect(await c.request('graph_record',{batch},{requestId:'lost-graph-ack'})).toMatchObject({replayed:true,value:first.value});
        const reader:AssessmentStore=await h.reader();try{expect(reader.graphSummary().assets).toBe(1);}finally{reader.close();}
        mode='storage';await expect(h.call('p2o_graph',{action:'record',batch:{assets:[{asset:{kind:'file',key:'must-not-commit.py'}}]}})).rejects.toThrow('graph SQLite fault');
        expect(h.ctx.notices.join('\n')).toContain('execution authority closed immediately');await expect(h.call('p2o_delegate',{focus:'denied',task:'no execution after fault'})).rejects.toThrow(/No active|finishing|stopping/);
      }finally{c.close();}
      await h.command('stop');const final:AssessmentStore=await h.reader();try{expect(final.graphSummary().assets).toBe(1);expect(final.outcome()).toMatchObject({assessmentOutcome:'blocked',resourceOutcome:'cleaned'});}finally{final.close();}
      expect(h.sandboxes.flatMap((s:InertSandbox)=>s.commands)).toEqual([]);
    },stage=>{if(stage==='after-commit'&&mode==='ack'){mode='none';throw Error('lost graph ACK after commit');}if(stage==='before-commit'&&mode==='storage'){mode='none';throw Object.assign(Error('graph SQLite fault'),{code:'ERR_SQLITE_ERROR'});}});
  });
  it('explicit infrastructure recovery refuses a live writer and never launches target work',async()=>{
    await fixture(async h=>{
      await h.command('--target ./source');const id=await h.runId();await h.command('stop');
      const writer=AssessmentStore.open(join(h.root,'.p2o-state'),id,{readOnly:false});
      try {await h.command(`recover ${id}`);expect(h.ctx.notices.at(-1)).toMatch(/locked|busy/i);} finally {writer.close();}
      const before=h.pi.messages.length;await h.command(`recover ${id}`);expect(h.screen()).toContain('HISTORICAL');expect(h.pi.messages).toHaveLength(before);expect(h.sandboxes).toHaveLength(1);
    });
  });
});
