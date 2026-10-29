import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { registerP2O } from '../../extensions/p2o/index.js';
import { BrokerClient } from '../../src/broker.js';
import { readLedger } from '../../src/records.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';
import { seedImpactGoal } from './helpers/report-fixture.js';

/**
 * P18.4/D48: the demand floor. `p2o_loop wait` still ends a round, but a round that owes named work cannot end in prose without
 * answering it once: the first wait is refused with the demand and the two legal next actions, a second wait is accepted, and
 * `blocked` keeps pausing exactly as before. The tests drive the real extension on the fake host.
 */
async function fixture(work:(h:any)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),'p2o-loop-actions-'));await mkdir(join(root,'source'));
  const pi=createFakePi(),ctx=createContext({cwd:root}),herdr=createSimpleHerdr(),sandboxes:InertSandbox[]=[];
  pi.bind(ctx.ctx);
  registerP2O(pi.pi,{extensionPath:EXTENSION_PATH,controlRoot:join(root,'control'),settingsPath:join(root,'fixture-settings.json'),herdr:herdr.client,createSandbox:sandboxFactory(sandboxes)});
  const call=(name:string,params={})=>pi.tools.get(name).execute('call',params,undefined,undefined,ctx.ctx);
  const emit=async(name:string,event:any={})=>{let result:any;for(const f of pi.events.get(name)??[])result=await f(event,ctx.ctx);return result;};
  const command=(s:string)=>pi.commands.get('p2o').handler(s,ctx.ctx);
  const clients:BrokerClient[]=[];
  const control=async()=>join(root,'control',(await readdir(join(root,'control')))[0]);
  const connect=async(id:string)=>{const t=JSON.parse(await readFile(join(await control(),`ticket-${id}.json`),'utf8'));const c=new BrokerClient(t.socket,t.token);clients.push(c);return {client:c,ticket:t};};
  const records=async()=>(await readLedger(join(await control(),'records.sqlite'))).records;
  try {await command('--target ./source');expect(pi.messages).toHaveLength(1);
    await seedImpactGoal({call,emit,pi,ctx});
    await work({root,pi,ctx,herdr,sandboxes,call,emit,command,connect,control,records});}
  finally {for(const c of clients)c.close();await command('stop');await command('close');await rm(root,{recursive:true,force:true});}
}
async function until(p:()=>boolean|Promise<boolean>) {for(let i=0;i<400;i++){if(await p())return;await delay(20);}throw Error('Fixture did not progress');}
const eventRows=async(h:any,event:string)=>((await h.records()) as any[]).filter(row=>row.data?.engine?.event===event);
/** One committed worker report is one semantic event, which is what reserves the round the planner then runs in. */
async function handOff(h:any) {
  const s=(await h.call('p2o_delegate',{focus:'loop-actions-fixture',task:'Bounded observation'})).details;
  const {client}=await h.connect(s.workerId);
  await client.request('report',{report:{summary:'Bounded observation complete',confidence:'low'}});
  await until(()=>h.pi.sessions.length===1);
  // The opening request carries the round's context packet, so the first assistant message is the one that consumes and judges.
  await h.emit('context',{messages:[{role:'user',content:h.pi.messages.at(-1)}]});
  await h.emit('message_end',{message:{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'opening step'}]}});
}
describe('Demand floor: wait semantics (P18.4/D48)',()=>{
  it('refuses the first wait once while a named demand is owed, then accepts a second wait and lets the round end',async()=>{
    await fixture(async h=>{
      await handOff(h);
      const owed=(await h.call('p2o_workers',{})).details.engine;
      expect(owed.remaining).toBeGreaterThan(0);
      expect(owed.demand).toBeTruthy();
      const refused=await h.call('p2o_loop',{action:'wait',reason:'nothing to do yet'});
      expect(refused.terminate).toBe(false);
      expect(refused.details).toMatchObject({refused:'WAIT_REFUSED',remaining:owed.remaining});
      expect(refused.details.demand).toBe(owed.demand);
      expect(refused.details.legalNext).toHaveLength(2);
      expect(refused.details.legalNext[0]).toContain('dispatch');
      expect(refused.details.legalNext[1]).toContain('blocked');
      // The refusal is recorded as a round nudge, so the report can count demand-floor nudges instead of inferring them.
      const nudges=await eventRows(h,'planner.round-nudge');
      expect(nudges).toHaveLength(1);
      expect(nudges[0].data.engine).toMatchObject({round:1,kind:'wait'});
      // A second wait is accepted: the planner may genuinely be at a wall, and the round then ends with the existing stall fact.
      const accepted=await h.call('p2o_loop',{action:'wait',reason:'every feasible approach is exhausted'});
      expect(accepted.terminate).toBe(true);
      expect(accepted.details.decision).toMatchObject({disposition:'wait'});
      // Each provider request re-supplies the context packet; the turn-final message is what the extension consumes and judges.
      await h.emit('context',{messages:[{role:'toolResult',content:'bounded observation'}]});
      await h.emit('message_end',{message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'round ends'}]}});
      expect((await eventRows(h,'planner.stalled')).length).toBeGreaterThan(0);
      expect(await eventRows(h,'planner.round-nudge')).toHaveLength(1);
    });
  });
  it('leaves blocked unchanged: it pauses the campaign immediately and is never refused',async()=>{
    await fixture(async h=>{
      await handOff(h);
      const blocked=await h.call('p2o_loop',{action:'blocked',reason:'no feasible approach remains after the bounded attempts'});
      expect(blocked.terminate).toBe(true);
      expect(blocked.details.state).toBe('blocked');
      expect(blocked.details.paused).toContain('no feasible approach');
      expect(await eventRows(h,'planner.round-nudge')).toEqual([]);
    });
  });
});
