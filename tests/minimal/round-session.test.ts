import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { registerP2O, testSeamFor } from '../../extensions/p2o/index.js';
import { BrokerClient } from '../../src/broker.js';
import { readLedger } from '../../src/records.js';
import { parseRoundCommandArgs, parseWakePrompt, roundBriefPrompt, parseRoundBrief, roundCommandText } from '../../src/planner-bridge.js';
import { ROUND_BRIEF_MAX_BYTES } from '../../src/round-brief.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';
import { seedImpactGoal } from './helpers/report-fixture.js';

/**
 * P18.1/D45: a round is a fresh Pi session. The engine dispatches an internal command with the wake it is about to deliver;
 * the command replaces the session and sends the round opening into the replacement. The tests drive the real extension on
 * the fake host: no model, no Docker, no target traffic.
 */
async function fixture(work:(h:any)=>Promise<void>,args='',options:{settings?:unknown;models?:Array<{provider:string;id:string}>}={}) {
  const root=await mkdtemp(join(tmpdir(),'p2o-round-session-'));await mkdir(join(root,'source'));
  const settingsPath=join(root,'fixture-settings.json');
  if(options.settings)await writeFile(settingsPath,JSON.stringify(options.settings),{mode:0o600});
  const pi=createFakePi(),ctx=createContext({cwd:root}),herdr=createSimpleHerdr(),sandboxes:InertSandbox[]=[];
  if(options.models)ctx.setModels(options.models);
  // Binding the command context is what makes the fake host able to dispatch `/p2o-round` and replace a session; an unbound
  // fake keeps the P17 shape (a follow-up prompt in the current session), which the rest of the extension suite exercises.
  pi.bind(ctx.ctx);
  registerP2O(pi.pi,{extensionPath:EXTENSION_PATH,controlRoot:join(root,'control'),settingsPath,herdr:herdr.client,createSandbox:sandboxFactory(sandboxes)});
  // S1/B10: the hidden delegate/task-start verbs are gone; the harness runs their code through the registration seam.
  const seam=(name:string,params:any)=>name==='p2o_delegate'?testSeamFor(pi.pi).spawn(params):name==='p2o_task_start'?testSeamFor(pi.pi).startTask(params):undefined;
  const call=(name:string,params={})=>seam(name,params)??pi.tools.get(name).execute('call',params,undefined,undefined,ctx.ctx);
  const emit=async(name:string,event:any={})=>{let result:any;for(const f of pi.events.get(name)??[])result=await f(event,ctx.ctx);return result;};
  const command=(s:string)=>pi.commands.get('p2o').handler(s,ctx.ctx);
  const roundCommand=(argsText:string,commandCtx:any)=>pi.commands.get('p2o-round').handler(argsText,commandCtx);
  const clients:BrokerClient[]=[];
  const control=async()=>join(root,'control',(await readdir(join(root,'control')))[0]);
  const connect=async(id:string)=>{const t=JSON.parse(await readFile(join(await control(),`ticket-${id}.json`),'utf8'));const c=new BrokerClient(t.socket,t.token);clients.push(c);return {client:c,ticket:t};};
  const records=async()=>(await readLedger(join(await control(),'records.sqlite'))).records;
  try {await command(`--target ./source ${args}`);expect(pi.messages).toHaveLength(1);
    await seedImpactGoal({call,emit,pi,ctx});
    await work({root,pi,ctx,herdr,sandboxes,call,emit,command,roundCommand,connect,control,records});}
  finally {for(const c of clients)c.close();await command('stop');await command('close');await rm(root,{recursive:true,force:true});}
}
async function until(p:()=>boolean|Promise<boolean>) {for(let i=0;i<400;i++){if(await p())return;await delay(20);}throw Error('Fixture did not progress');}
const eventRows=async(h:any,event:string)=>((await h.records()) as any[]).filter(row=>row.data?.engine?.event===event);
const fallbackReasons=async(h:any)=>(await eventRows(h,'planner.round-session-fallback')).map(row=>row.data.engine.reason);
async function handOff(h:any,summary='Bounded observation complete') {
  const s=(await h.call('p2o_delegate',{focus:'round-session-fixture',task:'Bounded observation'})).details;
  const {client}=await h.connect(s.workerId);
  await client.request('report',{report:{summary,confidence:'low'}});
  return {workerId:s.workerId};
}

describe('Rounds as fresh sessions (P18.1/D45)',()=>{
  it('opens the automatic round in a replacement session and sends the round opening there',async()=>{
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      expect(h.pi.dispatches).toHaveLength(1);
      expect(h.pi.dispatches[0].text).toBe(roundCommandText(parseRoundCommandArgs(h.pi.dispatches[0].args)!));
      expect(h.pi.dispatches[0].text.startsWith('/p2o-round ')).toBe(true);
      const opening=h.pi.messages[1];
      // The round opening keeps the wake marker first, so the wake parsers, the settle continuation and the stale-wake abort
      // keep one path; the deterministic briefing follows the marker on the next line (P18.2/D46).
      const wake=parseWakePrompt(opening);
      expect(wake).toMatchObject({round:1});
      expect(opening).toContain('--- p2o round ---');
      const brief=parseRoundBrief(opening)!;
      expect(brief.brief.startsWith('P2O round brief: round 1')).toBe(true);
      expect(Buffer.byteLength(brief.brief)).toBeLessThanOrEqual(ROUND_BRIEF_MAX_BYTES);
      for(const section of ['## Campaign frame','## Completion and demand','## Goals and proof','## Ready chain steps','## Workers','## Round facts']) expect(brief.brief).toContain(section);
      expect(brief.brief).toContain('Objective:');
      expect(h.pi.sessions[0].name).toBe(`p2o ${wake!.runId} round 1`);
      // The planner loadout is re-applied to the fresh session before its first turn; the run never keeps target tools.
      expect(h.pi.active).not.toContain('p2o_shell');
      const start=await eventRows(h,'planner.round-start'),session=await eventRows(h,'planner.round-session');
      expect(start).toHaveLength(1); expect(start[0].data.engine.round).toBe(1);
      // The fact records the projection it delivered, so the ledger and the replacement session cannot disagree about it.
      expect(start[0].data.engine.brief.bytes).toBe(Buffer.byteLength(brief.brief));
      expect(session).toHaveLength(1); expect(session[0].data.engine.session).toBe(h.pi.sessions[0].ctx.sessionManager.getSessionId());
      expect(await fallbackReasons(h)).toEqual([]);
    });
  });
  it('renders the round in flight in /p2o status: number, replacement session, budget state and last round fact',async()=>{
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      await h.command('status');
      const screen=h.ctx.screens.at(-1).render(600).join('\n');
      expect(screen).toContain(`Round: 1 in session ${h.pi.sessions[0].ctx.sessionManager.getSessionId()}`);
      expect(screen).toContain('budget open');
      expect(screen).toContain('0/40 steps');
      expect(screen).toMatch(/last round fact: planner\./);
      // P18.5/D51: the view is a projection — it spends no model call and opens no further round.
      expect(h.pi.messages).toHaveLength(2);
      expect(h.pi.sessions).toHaveLength(1);
    });
  });
  it('briefs the second round from the same read: a delta since round 1 and older material folded into the digest',async()=>{
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      const first=parseRoundBrief(h.pi.messages[1])!.brief;
      expect(first).toContain('First round:');
      expect(first).toContain('No older records folded');
      // The host's real order for one Planner round: agent_start, the context hook (which prepares the delivery packet), the
      // turn-final assistant message (which is what consumes and judges), then settlement. Replaying it is what lets the next
      // wake open round 2 exactly as the engine would.
      await h.emit('agent_start');
      await h.emit('context',{messages:[{role:'user',content:h.pi.messages[1]}]});
      // R1.7: the graph moved during round 1, so the round 2 opening names that movement instead of leaving the lead to ask.
      const asset=(await h.call('p2o_graph_record',{batch:{assets:[{asset:{kind:'endpoint',key:'/round-two'}}]}})).details.acks[0];
      await h.emit('message_end',{message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'round one done'}]}});
      await h.emit('agent_settled');
      await until(()=>h.pi.sessions.length===2);
      const second=parseRoundBrief(h.pi.messages[2])!;
      expect(second.wake.round).toBe(2);
      // P18.2/D46: the delta compares against the counters the engine judged, not a second counter, and the previous round's
      // records stay the window while everything before them folds into one bounded digest.
      expect(second.brief).toContain('Since the last round:');
      expect(second.brief).not.toContain('First round:');
      expect(second.brief).toContain('## Older material');
      expect(second.brief).toMatch(/Folded \d+ older record\(s\)/);
      // R1.7: the asset recorded in round 1 is the round 2 delta, read from the store sequence the round opened at.
      expect(second.brief).toMatch(/Graph since \d+: 1 new asset\(s\), \d+ changed; \d+ with no claim;/);
      expect(second.brief).toContain('New assets: endpoint /round-two');
      expect(asset.entityId).toMatch(/^asset-[a-f0-9]{24}$/);
      expect(Buffer.byteLength(second.brief)).toBeLessThanOrEqual(ROUND_BRIEF_MAX_BYTES);
      expect((await eventRows(h,'planner.round-session')).map(row=>row.data.engine.round)).toEqual([1,2]);
    });
  });
  it('dispatches one round for one wake: the command never opens a second session for the same reservation',async()=>{
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      await delay(300);
      expect(h.pi.dispatches).toHaveLength(1);
      expect(h.pi.sessions).toHaveLength(1);
      expect(await eventRows(h,'planner.round-session')).toHaveLength(1);
    });
  });
  it('refuses a malformed or stale wake before touching the session',async()=>{
    await fixture(async h=>{
      expect(await h.roundCommand('not-json',h.ctx.ctx)).toBeUndefined();
      expect(await h.roundCommand(JSON.stringify({runId:'other-run',epoch:0,through:0,round:1}),h.ctx.ctx)).toBeUndefined();
      expect(h.pi.sessions).toHaveLength(0);
      expect(h.pi.messages).toHaveLength(1);
      expect(await eventRows(h,'planner.round-start')).toHaveLength(0);
    });
  });
  it('keeps the round in the current session while streaming or with operator input queued, and records why',async()=>{
    await fixture(async h=>{
      // Queued operator input: the wake is reserved while the input is waiting, so the round arrives as a follow-up prompt
      // and the reason is recorded. The wake is parsed back out of that message and reused below, which is exactly the state a
      // dispatch race leaves behind.
      h.ctx.setPendingMessages(true);
      await handOff(h);
      await until(()=>h.pi.messages.some((text:string)=>text.startsWith('[p2o semantic wake] ')));
      expect(h.pi.sessions).toHaveLength(0);
      expect(await fallbackReasons(h)).toContain('operator messages pending');
      const wake=parseWakePrompt(h.pi.messages.at(-1));
      expect(wake).toBeDefined();
      // Streaming: a command dispatched just before the host started a turn must not replace the session mid-turn.
      h.ctx.setPendingMessages(false); h.ctx.setIdle(false);
      await h.roundCommand(JSON.stringify(wake),h.ctx.ctx);
      expect(h.pi.sessions).toHaveLength(0);
      expect(await fallbackReasons(h)).toContain('session busy');
      // The same still-valid wake opens the round once the host is idle, so no dispatch is lost to a guard.
      h.ctx.setIdle(true);
      await h.roundCommand(JSON.stringify(wake),h.ctx.ctx);
      await until(()=>h.pi.sessions.length===1);
      expect(await eventRows(h,'planner.round-session')).toHaveLength(1);
    });
  });
  it('falls back to the in-session wake when the host cancels or fails the switch',async()=>{
    for(const [reason,newSession] of [
      ['session switch cancelled',async()=>({cancelled:true})],
      ['session switch failed',async()=>{throw new Error('session file unavailable');}],
    ] as const){
      await fixture(async h=>{
        h.ctx.ctx.newSession=newSession as any;
        await handOff(h);
        // The dispatched command cannot switch, so the round arrives as the P17 follow-up prompt in the current session.
        await until(()=>h.pi.messages.length===2);
        expect(parseWakePrompt(h.pi.messages[1])).toBeDefined();
        expect(h.pi.messages[1]).not.toContain('--- p2o round ---');
        expect(h.pi.sessions).toHaveLength(0);
        const reasons=await fallbackReasons(h);
        expect(reasons.some(value=>value.startsWith(reason)),`${reason}: ${JSON.stringify(reasons)}`).toBe(true);
        expect(await eventRows(h,'planner.round-start')).toHaveLength(1);
        expect(await eventRows(h,'planner.round-session')).toHaveLength(0);
      });
    }
  });
  it('refuses a stale captured context after a switch, so a late dispatch cannot open a third session',async()=>{
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      const args=h.pi.dispatches[0].args, messages=h.pi.messages.length;
      // The old context belongs to the replaced session; a duplicated command delivered through it must be inert.
      await h.roundCommand(args,h.ctx.ctx);
      expect(h.pi.sessions).toHaveLength(1);
      expect(h.pi.messages).toHaveLength(messages);
      expect(await fallbackReasons(h)).toEqual([]);
    });
  });
  it('still stops the run on an operator switch or fork, and does not treat the internal teardown as one',async()=>{
    await fixture(async h=>{
      await handOff(h);
      // The internal switch emits session_before_switch and session_shutdown too; reaching a live session past them proves the
      // extension distinguishes the replacement from a host shutdown.
      await until(()=>h.pi.sessions.length===1);
      expect(h.sandboxes[0].stopCount).toBe(0);
      for(const event of ['session_before_switch','session_before_fork'] as const){
        // An operator-initiated switch after the round still closes the run and restores the ordinary tools.
        const leaving=await h.emit(event);
        expect(leaving).toBeUndefined();
        expect(h.sandboxes[0].stopCount).toBe(1);
        expect(h.pi.active).toContain('bash');
        break; // one switch closes the run; the second event would have no live assessment left to clean
      }
      await expect(h.call('p2o_shell',{command:'id'})).rejects.toThrow(/No active p2o assessment/);
      expect(await h.emit('session_before_fork')).toBeUndefined();
    });
  });
  it('routes the round model and thinking level from p2o.plannerModels before the first turn',async()=>{
    const plannerModels={base:'fixture/base',escalate:'fixture/escalate',thinkingBase:'medium',thinkingEscalate:'high'};
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      // The fixture's round owes review (one reported task, no ready chain step), so D50 routes the base loadout, and both
      // axes are applied to the replacement session before its opening message.
      expect(h.pi.modelChoices).toHaveLength(1); expect(h.pi.modelChoices[0]).toMatchObject({provider:'fixture',id:'base'});
      expect(h.pi.thinkingChoices).toEqual(['medium']);
      const rows=await eventRows(h,'planner.round-model');
      expect(rows).toHaveLength(1);
      expect(rows[0].data.engine).toMatchObject({round:1,model:'fixture/base',thinking:'medium',escalated:false});
      expect(rows[0].data.engine.reason).toContain('base loadout');
      expect(await eventRows(h,'planner.round-model-fallback')).toEqual([]);
      // The plan's loadout never reaches the tools or the wake: authority is unchanged by routing.
      expect(h.pi.active).not.toContain('p2o_shell');
    },'',{settings:{p2o:{plannerModels}},models:[{provider:'fixture',id:'base'},{provider:'fixture',id:'escalate'}]});
  });
  it('keeps the current model and records a fallback when the routed model cannot be applied',async()=>{
    const plannerModels={base:'fixture/base',thinkingBase:'medium'};
    // Registry miss: the configured id is not installed on this host.
    await fixture(async h=>{
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      expect(h.pi.modelChoices).toEqual([]); expect(h.pi.thinkingChoices).toEqual([]);
      const rows=await eventRows(h,'planner.round-model-fallback');
      expect(rows).toHaveLength(1);
      expect(rows[0].data.engine.reason).toContain('not in the host registry');
      expect(await eventRows(h,'planner.round-model')).toEqual([]);
      // The round still opened with its brief; a failed optimization degrades to today's loop.
      expect(parseRoundBrief(h.pi.messages[1])?.brief).toContain('## Round facts');
    },'',{settings:{p2o:{plannerModels}}});
    // Refused set: the model exists but the provider has no usable auth, so `setModel` reports false.
    await fixture(async h=>{
      h.pi.pi.setModel=async()=>false;
      await handOff(h);
      await until(()=>h.pi.sessions.length===1);
      const rows=await eventRows(h,'planner.round-model-fallback');
      expect(rows).toHaveLength(1);
      expect(rows[0].data.engine.reason).toContain('no usable auth');
      expect(await eventRows(h,'planner.round-model')).toEqual([]);
    },'',{settings:{p2o:{plannerModels}},models:[{provider:'fixture',id:'base'}]});
  });
  it('skips a progress render that lands before the replacement binds the new context (P19/G)',async()=>{
    await fixture(async h=>{
      // Pi invalidates the outgoing ctx when the replacement starts and binds the new one only in `session_start`. Hold the
      // switch inside that window: an event that refreshes the progress widget must skip the repaint, not read the stale
      // context (on the timer path that second read escapes the promise chain and exits pi).
      let windowOpen!: () => void; const inWindow = new Promise<void>(resolve => { windowOpen = resolve; });
      let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
      h.pi.holdSessionSwitch = async () => { windowOpen(); await held; };
      await handOff(h);
      await until(()=>h.pi.dispatches.length===1);
      await inWindow;
      await h.emit('agent_settled');
      expect(h.ctx.notices.filter((text:string)=>text.includes('Progress view unavailable'))).toEqual([]);
      release();
      await until(()=>h.pi.sessions.length===1);
      expect(await eventRows(h,'planner.round-session')).toHaveLength(1);
      expect(await eventRows(h,'planner.round-start')).toHaveLength(1);
    });
  });
  it('publishes the round opening as a user message whose marker and briefing survive a parse round-trip',async()=>{
    const wake={runId:'run-x',epoch:0,through:7,round:3,reason:'heartbeat' as const};
    const prompt=roundBriefPrompt(wake,'# Round 3 brief\n- one obligation');
    expect(parseWakePrompt(prompt)).toEqual(wake);
    expect(parseRoundBrief(prompt)).toEqual({wake,brief:'# Round 3 brief\n- one obligation'});
    expect(parseRoundBrief('[p2o semantic wake] {"runId":"run-x","epoch":0,"through":7,"round":3}')).toBeUndefined();
  });
});
