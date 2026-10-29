import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { registerP2O } from '../../extensions/p2o/index.js';
import { BrokerClient } from '../../src/broker.js';
import { readLedger } from '../../src/records.js';
import { closingTools, plannerTools } from '../../src/tool-policy.js';
import { parseRoundBrief } from '../../src/planner-bridge.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';
import { seedImpactGoal } from './helpers/report-fixture.js';

/**
 * P18.3/D47: one round is a bounded work package. The wrapping round is told to hand the ledger back and loses the two verbs
 * that would start work it cannot finish; a round that reaches its hard bound is aborted and *classified* at settlement, so the
 * campaign continues in the next round instead of pausing as if the provider failed. The tests drive the real extension on the
 * fake host: no model, no Docker, no target traffic.
 */
async function fixture(work:(h:any)=>Promise<void>,args='') {
  const root=await mkdtemp(join(tmpdir(),'p2o-round-wrapup-'));await mkdir(join(root,'source'));
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
  try {await command(`--target ./source ${args}`);expect(pi.messages).toHaveLength(1);
    await seedImpactGoal({call,emit,pi,ctx});
    await work({root,pi,ctx,herdr,sandboxes,call,emit,command,connect,control,records});}
  finally {for(const c of clients)c.close();await command('stop');await command('close');await rm(root,{recursive:true,force:true});}
}
async function until(p:()=>boolean|Promise<boolean>) {for(let i=0;i<400;i++){if(await p())return;await delay(20);}throw Error('Fixture did not progress');}
const eventRows=async(h:any,event:string)=>((await h.records()) as any[]).filter(row=>row.data?.engine?.event===event);
/** A committed worker report is one semantic event, which is what reserves the round. */
async function handOff(h:any) {
  const s=(await h.call('p2o_delegate',{focus:'round-budget-fixture',task:'Bounded observation'})).details;
  const {client}=await h.connect(s.workerId);
  await client.request('report',{report:{summary:'Bounded observation complete',confidence:'low'}});
  return {workerId:s.workerId};
}
/** One planner step is one assistant message: the same count the host charges a provider turn for. */
const steps=async(h:any,count:number)=>{for(let i=0;i<count;i++)await h.emit('message_end',{message:{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'bounded step'}]}});};
/**
 * The provider request path: the extension judges the budget here and returns the projection it would send. The round opening
 * request ends with the wake user message; every later request in the same turn ends with a tool result, which is what the
 * real host sends and what keeps the stale-wake guard silent.
 */
const contextTurn=async(h:any,opening=false)=>h.emit('context',{messages:[opening?{role:'user',content:h.pi.messages.at(-1)}:{role:'toolResult',content:'bounded observation'}]});
const directiveOf=(projection:any)=>projection.messages.filter((m:any)=>m.customType==='p2o_round_directive');

describe('Round wrap-up and classified stop (P18.3/D47)',()=>{
  it('wraps the round once at the step boundary: wrap-up directive, closing loadout, one budget fact',async()=>{
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      await h.emit('agent_start');
      // Default budget: 40 steps, wrapping inside the last 6. Step 33 is still open.
      await steps(h,33);
      const open=await contextTurn(h,true);
      expect(directiveOf(open)).toHaveLength(0);
      expect(h.pi.active).toEqual(plannerTools());
      // Step 34 is the boundary: the same request carries the directive but starts no new work.
      await steps(h,1);
      const wrapping=await contextTurn(h);
      const directive=directiveOf(wrapping);
      expect(directive).toHaveLength(1);
      expect(directive[0].content).toContain('P2O ROUND WRAP-UP');
      expect(directive[0].content).toContain('34/40 planner steps');
      expect(directive[0].content).toContain('end the round with the loop wait action');
      expect(h.pi.active).toEqual(closingTools());
      expect(h.pi.active).not.toContain('p2o_task_author');
      expect(h.pi.active).not.toContain('p2o_task_dispatch');
      expect(h.pi.active).toContain('p2o_goal_author');
      const budget=await eventRows(h,'planner.round-budget');
      expect(budget).toHaveLength(1);
      expect(budget[0].data.engine).toMatchObject({round:1,state:'wrap',steps:34});
      // The boundary is crossed once per round: later requests keep the directive but record no second wrap fact.
      await steps(h,2);
      const again=await contextTurn(h);
      expect(directiveOf(again)).toHaveLength(1);
      expect(await eventRows(h,'planner.round-budget')).toHaveLength(1);
    });
  });
  it('wraps on the context and time axes and aborts without pausing when the hard bound is reached',async()=>{
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      await h.emit('agent_start');
      // Context axis: Pi's reported usage is the same number status prints, so 85% is inside the last fifth of the window.
      // A bound fake host reports usage through the fake-pi setter, the same channel the session replacement keeps live.
      h.pi.setContextPercent(85);
      const wrapping=await contextTurn(h);
      expect(directiveOf(wrapping)[0].content).toContain('context 85%');
      expect((await eventRows(h,'planner.round-budget'))[0].data.engine).toMatchObject({state:'wrap'});
      // Hard bound: the aborted turn is classified, never a provider failure. The round is aborted, the campaign is not paused.
      h.pi.setContextPercent(93);
      const aborts=h.ctx.aborts;
      await contextTurn(h);
      expect(h.ctx.aborts, 'the hard bound aborts the turn').toBe(aborts+1);
      const budget=await eventRows(h,'planner.round-budget');
      expect(budget.map(row=>row.data.engine.state)).toEqual(['wrap','exhausted']);
      expect(budget[1].data.engine.round).toBe(1);
      const settled=await h.emit('agent_before_settle',{outcome:'aborted',continue:false,context:{pendingMessages:[]}});
      expect(settled).toBeUndefined();
      const end=await eventRows(h,'planner.round-end');
      expect(end).toHaveLength(1);
      expect(end[0].data.engine).toMatchObject({round:1,reason:'round-budget'});
      expect((await h.call('p2o_workers',{})).details.engine.paused).toBeUndefined();
      // Settlement lets the engine open the next round in a fresh session: the campaign continues, the brief names the frontier.
      await h.emit('agent_settled');
      await until(()=>h.pi.sessions.length===2);
      const second=parseRoundBrief(h.pi.messages.at(-1))!;
      expect(second.wake.round).toBe(2);
      expect(second.brief).toContain('## Completion and demand');
      expect(second.brief).toContain('Since the last round:');
      expect(await eventRows(h,'planner.round-end')).toHaveLength(1);
    });
  });
  it('wraps on the time axis when the round has used its window',async()=>{
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      await h.emit('agent_start');
      await delay(950);
      const wrapping=await contextTurn(h);
      const content=directiveOf(wrapping)[0]?.content ?? '';
      expect(content).toContain('P2O ROUND WRAP-UP');
      expect(content).toMatch(/round time \d+s\/1s/);
    },'--round-seconds 1');
  });
  it('nudges a text-only round at settlement at most twice, with the demand and no new round',async()=>{
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      await h.emit('agent_start');
      // The opening request carries the round packet; the first assistant message is the turn-final one, so the engine judges
      // the round and the settlement nudge reads a real obligation count.
      await contextTurn(h,true);
      await h.emit('message_end',{message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'I will wait.'}]}});
      const first=await h.emit('agent_before_settle',{outcome:'completed',continue:false,context:{pendingMessages:[]}});
      expect(first.continue).toBe(true);
      const firstEntry=first.entries[0];
      expect(firstEntry.customType).toBe('p2o_round_nudge');
      expect(firstEntry.content).toContain('P2O SETTLEMENT NUDGE (1/2, round 1)');
      expect(firstEntry.content).toContain('create and dispatch one bounded intent');
      expect(firstEntry.content).toContain('record blocked');
      // The nudge continues the same round: no session was replaced and no round was reserved.
      expect(h.pi.sessions).toHaveLength(1);
      // A second text-only settlement gets the second nudge; a third is left to the round boundary.
      await h.emit('message_end',{message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Still waiting.'}]}});
      const second=await h.emit('agent_before_settle',{outcome:'completed',continue:false,context:{pendingMessages:[]}});
      expect(second.entries[0].content).toContain('P2O SETTLEMENT NUDGE (2/2, round 1)');
      expect(h.pi.sessions).toHaveLength(1);
      await h.emit('message_end',{message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Waiting again.'}]}});
      expect(await h.emit('agent_before_settle',{outcome:'completed',continue:false,context:{pendingMessages:[]}})).toBeUndefined();
      const nudges=await eventRows(h,'planner.round-nudge');
      expect(nudges.map(row=>row.data.engine.nudge)).toEqual([1,2]);
      expect(nudges.every(row=>row.data.engine.kind==='settle')).toBe(true);
      // The round now settles and the engine kick opens the next round in a fresh session.
      await h.emit('agent_settled');
      await until(()=>h.pi.sessions.length===2);
    });
  });
  it('does not nudge a round that made a tool call',async()=>{
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      await h.emit('agent_start');
      await contextTurn(h,true);
      await h.emit('message_end',{message:{role:'assistant',stopReason:'stop',content:[{type:'toolCall',id:'call-1',name:'p2o_board',arguments:{}}]}});
      // A round that acted is not text-only, so settlement has nothing to nudge; the round boundary handles continuation.
      expect(await h.emit('agent_before_settle',{outcome:'completed',continue:false,context:{pendingMessages:[]}})).toBeUndefined();
      expect(await eventRows(h,'planner.round-nudge')).toEqual([]);
    });
  });
  it('blocks an injected authoring verb and an untracked worker brief while the round wraps',async()=>{
    // S1/A8 (planning_update.md F-07): the closing loadout is the contract of a wrapping round, so the defense-in-depth
    // tool gate must read it too, and a brief to a live worker is new untracked work rather than write-back.
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      await h.emit('agent_start');
      await steps(h,34);
      await contextTurn(h);
      expect(h.pi.active).toEqual(closingTools());
      const gate=async(toolName:string)=>{let result:any;for(const handler of h.pi.events.get('tool_call')??[])result=(await handler({toolName},h.ctx.ctx))??result;return result;};
      expect(await gate('p2o_task_author')).toMatchObject({block:true});
      expect(await gate('p2o_task_dispatch')).toMatchObject({block:true});
      expect(await gate('p2o_goal_author')).toBeUndefined();
      // The wrap refusal is decided before any worker lookup, so a live ticket is not needed to prove it.
      await expect(h.call('p2o_workers',{action:'continue',workerId:'p2o-recon-aaaaaa',brief:'one more narrow look at the same ticket'})).rejects.toThrow(/wrapping up/);
    });
  });
  it('leaves an unbounded round open when the step axis is disabled',async()=>{
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      await h.emit('agent_start');
      await steps(h,50);
      const projection=await contextTurn(h);
      expect(directiveOf(projection)).toHaveLength(0);
      expect(await eventRows(h,'planner.round-budget')).toEqual([]);
      expect(h.pi.active).toEqual(plannerTools());
    },'--round-steps 0 --round-seconds 0');
  });
});
