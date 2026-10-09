import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { registerP2O } from '../../extensions/p2o/index.js';
import { BrokerClient } from '../../src/broker.js';
import { parseWakePrompt,plannerWakeMessage } from '../../src/planner-bridge.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

async function fixture(work:(h:any)=>Promise<void>,args='',budget?:number) {
  const root=await mkdtemp(join(tmpdir(),'p2o-planner-'));await mkdir(join(root,'source'));
  const pi=createFakePi(),ctx=createContext({cwd:root}),herdr=createSimpleHerdr(),sandboxes:InertSandbox[]=[];
  registerP2O(pi.pi,{extensionPath:EXTENSION_PATH,controlRoot:join(root,'control'),herdr:herdr.client,createSandbox:sandboxFactory(sandboxes),totalCommandBudget:budget});
  const call=(name:string,params={})=>pi.tools.get(name).execute('call',params,undefined,undefined,ctx.ctx);
  const emit=async(name:string,event:any={})=>{let result:any;for(const f of pi.events.get(name)??[])result=await f(event,ctx.ctx);return result;};
  const command=(s:string)=>pi.commands.get('p2o').handler(s,ctx.ctx);
  const clients:BrokerClient[]=[];
  const control=async()=>join(root,'control',(await readdir(join(root,'control')))[0]);
  const connect=async(id:string)=>{const t=JSON.parse(await readFile(join(await control(),`ticket-${id}.json`),'utf8'));const c=new BrokerClient(t.socket,t.token);clients.push(c);return {client:c,ticket:t};};
  try {await command(`--target ./source ${args}`);expect(pi.messages).toHaveLength(1);await work({root,pi,ctx,herdr,sandboxes,call,emit,command,connect,control});}
  finally {for(const c of clients)c.close();await command('stop');await rm(root,{recursive:true,force:true});}
}
const draft=(surface:string)=>({question:`Inspect the fixture at ${surface}`,surface,risk:'fixture',role:'general',roleReason:'Bounded controlled fixture observation',expectedTrue:'Receipt supports this particular observation',expectedFalse:'Receipt refutes this particular observation',stopCondition:'Stop after the bounded observation or missing prerequisite',evidenceIds:[],prerequisites:[],skills:[],methodReason:'Controlled inert fixture; not security proof'});
async function until(p:()=>boolean) {for(let i=0;i<400;i++){if(p())return;await delay(20);}throw Error('Fixture did not progress');}

describe('Planner/Engine/Worker extension contract',()=>{
  it('denies Planner target execution and reporter broker bypass; solo keeps direct access',async()=>{
    await fixture(async(h)=>{
      for(const name of ['p2o_shell','p2o_net','p2o_http']) {expect(h.pi.active).not.toContain(name);expect(await h.emit('tool_call',{toolName:name})).toMatchObject({block:true});}
      await expect(h.call('p2o_shell',{command:'must not execute'})).rejects.toThrow('PLANNER_ONLY');
      const spawned=(await h.call('p2o_delegate',{focus:'report-only',task:'Synthesize existing ledger only',role:'reporting'})).details;
      const {client}=await h.connect(spawned.workerId);
      for(const op of ['exec','net','http','candidate','delegate']) await expect(client.request(op,{command:'must not execute',url:'https://example.invalid/'})).rejects.toThrow('synthesis-only');
      const proposal=await client.request('request_subtask',{focus:'review-gap',task:'Missing proof requires separate validation'});expect(proposal.value.accepted).toBe(false);
      expect(h.herdr.calls.filter((c:any)=>c.op==='start')).toHaveLength(1);await client.request('report',{report:{summary:'Existing evidence only',confidence:'low'}});expect(h.sandboxes[0].commands).toHaveLength(0);
    });
    await fixture(async(h)=>{expect(h.pi.active).toContain('p2o_shell');expect((await h.call('p2o_shell',{command:'solo'})).details.exitCode).toBe(0);},'--solo');
  });
  it('reuses three slots for 30 attributed assignments, with unique tickets and no budget reset',async()=>{
    await fixture(async(h)=>{
      const ids:string[]=[];for(let i=0;i<30;i++)ids.push((await h.call('p2o_task',{action:'create',draft:draft(`surface-${i}`)})).details.id);
      await h.call('p2o_task',{action:'dispatch',ids:ids.slice(0,25)});await h.call('p2o_task',{action:'dispatch',ids:ids.slice(25)});
      for(let i=0;i<30;i++){
        await until(()=>h.herdr.calls.filter((c:any)=>c.op==='start').length>i);
        const starts=h.herdr.calls.filter((c:any)=>c.op==='start');const id=starts[i].name;
        const {client,ticket}=await h.connect(id);expect(ticket.parentWorkerId).toBeNull();
        await client.request('exec',{command:'one bounded observation'});await client.request('report',{report:{summary:`Assignment ${i} partial observation`,confidence:'low'}});
        await expect(client.request('exec',{command:'stale'})).rejects.toThrow('stopped');
        const view=(await h.call('p2o_workers')).details;expect(view.workers.filter((w:any)=>w.live).length).toBeLessThanOrEqual(3);
      }
      await until(()=>h.herdr.calls.filter((c:any)=>c.op==='close').length>=27);
      const view=(await h.call('p2o_workers')).details;expect(view.workers).toHaveLength(30);expect(view.budgets.workerUsed).toBe(30);expect(view.engine.pendingIntents).toBe(0);
      expect(new Set(h.herdr.calls.filter((c:any)=>c.op==='start').map((c:any)=>c.name)).size).toBe(30);
      expect(h.pi.customMessages).toHaveLength(0);expect(h.sandboxes[0].commands.some((c:any)=>c.command==='stale')).toBe(false);
    },'--workers 3');
  },20000);
  it('publishes only committed terminal reports, coalesces wakes, and gives human pending input priority',async()=>{
    await fixture(async(h)=>{
      h.ctx.setIdle(false);await h.emit('agent_start');
      const s=(await h.call('p2o_delegate',{focus:'delayed-worker',task:'Bounded observation'})).details;
      const {client}=await h.connect(s.workerId);await client.request('note',{kind:'note',text:'A noisy observation'});expect((await h.call('p2o_loop',{action:'status'})).details.pendingEvents).toBe(0);
      await client.request('report',{report:{summary:'Committed worker handoff',confidence:'low'}});
      const view=(await h.call('p2o_workers')).details;expect(view.workers[0]).toMatchObject({reported:true,live:false});expect(view.engine.pendingEvents).toBe(1);
      expect(await h.emit('agent_before_settle',{outcome:'completed',continue:false,context:{pendingMessages:[{role:'user',content:'Human steer'}]}})).toBeUndefined();
      const boundary=await h.emit('agent_before_settle',{outcome:'completed',continue:false,context:{pendingMessages:[]}});expect(boundary.continue).toBe(true);expect(boundary.entries[0].customType).toBe('p2o_planner_wake');
      const message={role:'custom',...boundary.entries[0],timestamp:0};const projection=await h.emit('context',{messages:[message]});expect(JSON.stringify(projection)).toContain('worker-report');
      expect(await h.emit('agent_before_settle',{outcome:'completed',continue:false,context:{pendingMessages:[]}})).toBeUndefined();expect(h.pi.customMessages).toHaveLength(0);
    },'--loop event-driven');
  });
  it('wakes after idle but stop invalidates a late/deferred wake before target access',async()=>{
    await fixture(async(h)=>{
      const s=(await h.call('p2o_delegate',{focus:'idle-worker',task:'Bounded observation'})).details;const {client}=await h.connect(s.workerId);
      await client.request('report',{report:{summary:'Worker completed after owner idle',confidence:'low'}});await until(()=>h.pi.messages.length===2);
      const prompt=h.pi.messages[1];const wake=plannerWakeMessage(parseWakePrompt(prompt)!);
      expect((await h.call('p2o_loop',{action:'status'})).details.rounds).toBe(1);
      await h.command('stop');const aborted=h.ctx.aborts;
      expect(await h.emit('input',{source:'extension',text:prompt})).toEqual({action:'handled'});
      await h.emit('context',{messages:[{role:'custom',...wake,timestamp:0}]});expect(h.ctx.aborts).toBe(aborted+1);expect(h.pi.active).toContain('bash');
      await expect(h.call('p2o_shell',{command:'must not execute'})).rejects.toThrow('NO_ASSESSMENT');await delay(150);expect(h.pi.messages).toHaveLength(2);
    },'--loop event-driven');
  });
  it('does not use a new worker identity to renew exhausted target-command allowance',async()=>{
    await fixture(async(h)=>{
      const s=(await h.call('p2o_delegate',{focus:'bounded',task:'Single-command assignment'})).details;const {client}=await h.connect(s.workerId);
      await client.request('exec',{command:'one'});await client.request('report',{report:{summary:'Budget consumed; retain gaps',confidence:'low',outcome:'partial-budget'}});
      await expect(h.call('p2o_delegate',{focus:'renewal',task:'Do not renew budget'})).rejects.toThrow('COMMAND_BUDGET');
      expect((await h.call('p2o_loop',{action:'status'})).details.mode).toBe('manual');
    },'',2);
  });
  it('isolated profile allocates fresh owned executors, leaves peers alive when one is withdrawn, and cleans all leases',async()=>{
    await fixture(async(h)=>{
      const a=(await h.call('p2o_delegate',{focus:'first',task:'Observe first surface'})).details,b=(await h.call('p2o_delegate',{focus:'second',task:'Observe second surface'})).details;
      expect(h.sandboxes).toHaveLength(3);const ca=await h.connect(a.workerId),cb=await h.connect(b.workerId);
      await ca.client.request('exec',{command:'A'});await cb.client.request('exec',{command:'B'});
      expect(h.sandboxes[1].commands[0].command).toBe('A');expect(h.sandboxes[2].commands[0].command).toBe('B');
      await h.call('p2o_stop_worker',{workerId:a.workerId,reason:'Only withdraw A'});expect(h.sandboxes[1].stopCount).toBe(1);expect(h.sandboxes[2].stopCount).toBe(0);
      await cb.client.request('exec',{command:'B continues'});await h.command('stop');expect(h.sandboxes[2].stopCount).toBe(1);expect(h.sandboxes[0].stopCount).toBe(1);
    },'--executors isolated --target-ops 2');
  });
});
