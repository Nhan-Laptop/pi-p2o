import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerP2O } from '../../extensions/p2o/index.js';
import { Broker, BrokerClient, type WorkerRegistration } from '../../src/broker.js';
import { runFixed, type RunProcess } from '../../src/process.js';
import { Sandbox } from '../../src/sandbox.js';
import { taskTimeout, httpRequest } from '../../src/target.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, InertSandbox } from './helpers/fake-pi.js';

const result={code:0,stdout:'local fixture',stderr:'',truncated:false};
const registration:WorkerRegistration={workerId:'p2o-general-aaaaaa',name:'p2o-general-aaaaaa',paneId:'fixture',role:'general',depth:1,parentWorkerId:null,token:'a'.repeat(32),used:0,startedAt:0,stopped:false};

describe('explicit run ownership, no elapsed-time limits',()=>{
  it('keeps lead, late workers and owned tasks active after a year; stop still revokes tickets and tools',async()=>{
    const root=await mkdtemp(join(tmpdir(),'p2o-lifetime-'));await mkdir(join(root,'source'));
    const owner=createFakePi(),herdr=createSimpleHerdr(),sandboxes:InertSandbox[]=[];
    const ctx=createContext({cwd:root});let time=Date.now();let worker:ReturnType<typeof createFakePi>|undefined;
    registerP2O(owner.pi,{extensionPath:EXTENSION_PATH,controlRoot:join(root,'control'),settingsPath:join(root,'fixture-settings.json'),herdr:herdr.client,createSandbox:sandboxFactory(sandboxes),now:()=>time});
    const timer=vi.spyOn(globalThis,'setTimeout');
    try{
      await owner.commands.get('p2o').handler('--target ./source',ctx.ctx);
      expect(owner.messages).toHaveLength(1);
      expect(timer.mock.calls.some(([,ms])=>ms===30*60*1000)).toBe(false);
      time+=365*24*60*60*1000;
      const lead=await owner.tools.get('p2o_loop').execute('lead',{action:'status'},undefined,undefined,ctx.ctx);
      expect(lead.details.state).toBe('waiting');
      await expect(owner.tools.get('p2o_shell').execute('lead',{command:'Planner must delegate'},undefined,undefined,ctx.ctx)).rejects.toThrow('PLANNER_ONLY');
      const delegated=await owner.tools.get('p2o_delegate').execute('delegate',{focus:'late focused question',task:'Inspect this controlled local fixture only',role:'general'},undefined,undefined,ctx.ctx);
      const workerId=delegated.details.workerId;
      const control=join(root,'control',(await readdir(join(root,'control')))[0]);
      const ticketPath=join(control,`ticket-${workerId}.json`);
      const ticket=JSON.parse(await readFile(ticketPath,'utf8'));
      expect(ticket).toMatchObject({version:2,lifetime:'until-stopped'});expect(ticket).not.toHaveProperty('expiresAt');
      worker=createFakePi();worker.allowWorkerFlag(ticketPath);registerP2O(worker.pi,{extensionPath:EXTENSION_PATH,now:()=>time});
      const workerCtx=createContext({cwd:root});await worker.events.get('session_start')![0]({},workerCtx.ctx);
      expect(workerCtx.notices.join(' ')).not.toContain('rejected');
      expect((await worker.tools.get('p2o_shell').execute('worker',{command:'late worker inspection'},undefined,undefined,workerCtx.ctx)).content[0].text).toContain('INERT_SANDBOX');
      const event={systemPrompt:'host policy',systemPromptOptions:{sections:{} as Record<string,string>}};
      await owner.events.get('before_agent_start')![0](event,ctx.ctx);
      expect(event.systemPromptOptions.sections.p2o_assessment).toContain('No elapsed-time limit');
      expect(herdr.calls.find(c=>c.op==='prompt')?.text).not.toContain('ticket expires');
      await owner.commands.get('p2o').handler('stop',ctx.ctx);
      expect(sandboxes[0].stopCount).toBe(1);
      expect(owner.active).toEqual(['read','bash','edit','write']);
      await expect(worker.tools.get('p2o_shell').execute('stale',{command:'must not execute'},undefined,undefined,workerCtx.ctx)).rejects.toThrow(/closed|stopped|unavailable|connection|ENOENT/i);
      expect(sandboxes[0].commands.map(c=>c.command)).not.toContain('must not execute');
      const replay=await owner.events.get('tool_call')![0]({toolName:'p2o_shell'},ctx.ctx);expect(replay.block).toBe(true);
    }finally{timer.mockRestore();if(worker)await worker.events.get('session_shutdown')![0]({},ctx.ctx);await owner.commands.get('p2o').handler('stop',ctx.ctx);await rm(root,{recursive:true,force:true});}
  });
  it('validates optional probe timeouts without a 60/300 second ceiling',()=>{
    expect(taskTimeout(undefined)).toBe(0);expect(taskTimeout(0)).toBe(0);expect(taskTimeout(24*60*60)).toBe(86400);
    for(const value of [-1,1.5,NaN,Infinity,'30',null,Number.MAX_SAFE_INTEGER+1])expect(()=>taskTimeout(value)).toThrow('non-negative');
    expect(httpRequest({url:'/'})).toMatchObject({timeout:0,connectTimeout:0});
    expect(httpRequest({url:'/',timeout:900,connectTimeout:120})).toMatchObject({timeout:900,connectTimeout:120});
    for(const patch of [{timeout:-1},{connectTimeout:'5'},{timeout:1.5}])expect(()=>httpRequest({url:'/',...patch})).toThrow('non-negative');
  });
  it('disables subprocess task timers explicitly while preserving infrastructure watchdogs and abort',async()=>{
    const timer=vi.spyOn(globalThis,'setTimeout');
    try{
      expect((await runFixed(process.execPath,['-e','process.stdout.write("ok")'],{timeoutMs:null})).stdout).toBe('ok');
      expect(timer).not.toHaveBeenCalled();
      await runFixed(process.execPath,['-e','process.stdout.write("ok")']);expect(timer.mock.calls.some(([,ms])=>ms===30000)).toBe(true);
    }finally{timer.mockRestore();}
    const abort=new AbortController();
    const pending=runFixed(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:null,signal:abort.signal});
    abort.abort();await expect(pending).rejects.toThrow('Cancelled');
    await expect(runFixed(process.execPath,['-e','throw Error("must not start")'],{timeoutMs:null,signal:abort.signal})).rejects.toThrow('Cancelled');
  });
  it('lets task RPCs exceed coordination timeouts; explicit cancellation revokes the worker and interrupts its executor',async()=>{
    const root=await mkdtemp(join(tmpdir(),'p2o-rpc-lifetime-'));let cancelled=false,started!:()=>void;
    const running=new Promise<void>(resolve=>{started=resolve;});
    const broker=new Broker(root,{
      exec:async(command,seconds,_workdir,signal)=>{expect(seconds).toBe(0);if(command==='slow'){await delay(60);return result;}started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(Error('Cancelled'));},{once:true}));},
      http:async()=>result,note:async()=>{},ledger:async()=>[],delegate:async()=>{throw Error('unused');},report:async()=>{},
    },{});broker.register({...registration});await broker.start();
    const client=new BrokerClient(broker.socket,registration.token,{requestMs:5,connectMs:2000});
    try{
      await expect(client.request('exec',{command:'slow'},{timeoutMs:null})).resolves.toMatchObject(result);
      const abort=new AbortController();const task=client.request('exec',{command:'forever'},{timeoutMs:null,signal:abort.signal});
      const rejected=expect(task).rejects.toThrow(/cancelled/);await running;abort.abort();await rejected;
      for(let i=0;i<40&&!cancelled;i++)await delay(5);
      expect(cancelled).toBe(true);expect(broker.registration(registration.workerId)?.stopped).toBe(true);
      const copied=new BrokerClient(broker.socket,registration.token,{connectMs:2000});
      try{await expect(copied.request('exec',{command:'must not execute'})).rejects.toThrow(/Unauthorized|rejected/i);}finally{copied.close();}
    }finally{client.close();await broker.stop();await rm(root,{recursive:true,force:true});}
  });
  it('cancels HTTP even while DNS is pending; a late resolution cannot create a request container',async()=>{
    const names=new Set<string>();let created=0,resolve!: (value:string[])=>void,started!:()=>void;
    const dns=new Promise<string[]>(r=>{resolve=r;}),pending=new Promise<void>(r=>{started=r;});
    const run:RunProcess=async args=>{const a=args[0]==='--host'?args.slice(2):args;let stdout='';
      if(a[0]==='context')stdout='"unix:///fixture.sock"';if(a[0]==='info')stdout='linux';if(a[0]==='inspect')stdout='true';
      if(a[0]==='create'){names.add(a[a.indexOf('--name')+1]);created++;}if(a[0]==='rm')names.delete(a.at(-1)!);
      if(a[0]==='container')stdout=[...names].join('\n');return {...result,stdout};};
    const sandbox=new Sandbox({kind:'url',url:'https://fixture.invalid/',origin:'https://fixture.invalid'},run,()=>{started();return dns;});await sandbox.start();
    const task=sandbox.http({url:'/',method:'GET',followRedirects:false,maxRedirects:0});const rejected=expect(task).rejects.toThrow('Cancelled');
    await pending;await sandbox.stop();await rejected;resolve(['127.0.0.1']);await delay(0);
    expect(created).toBe(1);expect(names.size).toBe(0);
  });
});
