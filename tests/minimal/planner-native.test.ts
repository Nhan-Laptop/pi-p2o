import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** Real Pi + child Pi + inert provider/executor. No commercial calls or target traffic. */
it.each(['idle','boundary','human-priority'] as const)('real Pi %s wake preserves scoped prompts and rejects stale follow-ups',async(mode)=>{
  const root=await mkdtemp(join(tmpdir(),'p2o-planner-native-')),repo=resolve(import.meta.dirname,'../..');
  await mkdir(join(root,'source'));await writeFile(join(root,'source','code.txt'),'authorized fixture');
  const log=join(root,'provider.jsonl');
  const child=spawn(join(repo,'node_modules/.bin/pi'),['--no-extensions','-e',join(repo,'tests/minimal/fixtures/owner.ts'),'--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--offline','--no-session','--no-approve','--mode','rpc','--provider','p2o-inert','--model','current-agent','--thinking','off'],{
    cwd:root,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:root,PI_CODING_AGENT_DIR:join(root,'agent'),PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',PI_TELEMETRY:'0',P2O_TEST_EVENT_LOOP:'1',P2O_TEST_WAKE_BOUNDARY:mode==='idle'?'0':'1',P2O_TEST_PROVIDER_LOG:log,P2O_TEST_FAKE_HERDR:'1',P2O_TEST_CWD:root,P2O_TEST_PI_BINARY:join(repo,'node_modules/.bin/pi'),P2O_TEST_WORKER_EXT:join(repo,'tests/minimal/fixtures/worker.ts'),P2O_TEST_CONTROL_ROOT:join(root,'control'),...(process.env.P2O_TEST_INSTALLED_EXTENSION?{P2O_TEST_INSTALLED_EXTENSION:process.env.P2O_TEST_INSTALLED_EXTENSION}:{})},
  });
  let buffer='',stderr='',seq=0;const records:any[]=[];const pending=new Map<string,(r:any)=>void>();
  const closed=new Promise<void>(r=>child.once('close',()=>r()));
  child.stderr.setEncoding('utf8');child.stderr.on('data',s=>{stderr+=s;});child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{
    buffer+=s;for(;;){const i=buffer.indexOf('\n');if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;
      const r=JSON.parse(line);records.push(r);if(r.type==='response'){pending.get(r.id)?.(r);pending.delete(r.id);}
      if(r.type==='extension_ui_request'&&r.method==='confirm')child.stdin.write(JSON.stringify({type:'extension_ui_response',id:r.id,confirmed:r.title==='Start authorized assessment?'})+'\n');
    }
  });
  const request=async(type:string,fields:any={})=>{const id=`planner-${++seq}`;let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([new Promise<any>(r=>{pending.set(id,r);child.stdin.write(JSON.stringify({id,type,...fields})+'\n');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`RPC timeout: ${stderr}`)),60000);})]);}
    finally{clearTimeout(timer);pending.delete(id);}
  };
  const text=(m:any)=>typeof m.content==='string'?m.content:JSON.stringify(m.content??'');
  const until=async(p:()=>Promise<boolean>)=>{for(let i=0;i<2000;i++){if(await p())return;await delay(30);}throw Error(`No progress: ${stderr} ${JSON.stringify(records.slice(-10))}`);};
  try{
    expect((await request('get_state')).success).toBe(true);
    expect((await request('prompt',{message:'/p2o --target ./source --loop event-driven --export'})).success).toBe(true);
    if(mode==='human-priority'){
      await until(async()=>records.some(r=>r.type==='tool_execution_end'&&r.toolName==='p2o_delegate'));
      expect((await request('prompt',{message:'HUMAN_PRIORITY: retain this follow-up; never replace human input with an automatic wake.',streamingBehavior:'followUp'})).success).toBe(true);
    }
    await until(async()=>((await request('get_messages')).data?.messages??[]).some((m:any)=>text(m).includes('OWNER_FINAL_REPORT')));
    await until(async()=>records.filter(r=>r.type==='agent_settled').length>=(mode==='idle'?2:1));
    const messages=(await request('get_messages')).data.messages;
    expect(messages.filter((m:any)=>m.role==='toolResult').map((m:any)=>m.toolName)).toEqual(['p2o_delegate','p2o_loop','p2o_workers','p2o_finish']);
    const wakes=messages.filter((m:any)=>m.role==='custom'&&m.customType==='p2o_planner_wake');expect(wakes).toHaveLength(mode==='human-priority'?0:1);
    expect(messages.filter((m:any)=>m.role==='user')).toHaveLength(mode==='boundary'?1:2);
    if(mode==='human-priority')expect(messages.some((m:any)=>m.role==='user'&&text(m).includes('HUMAN_PRIORITY'))).toBe(true); // Kickoff + ONE semantic prompt, never periodic polling.
    expect(records.filter(r=>r.type==='extension_error')).toEqual([]);
    const exportFile=join(root,'.p2o-reports',(await readdir(join(root,'.p2o-reports')))[0]);
    const exported=JSON.parse(await readFile(exportFile,'utf8'));expect(exported.reconciliation.complete).toBe(true);expect(exported.manifest.engine).toMatchObject({mode:'event-driven',rounds:mode==='human-priority'?0:1,state:'stopped'});
    const acceptedBefore=(await readFile(log,'utf8')).split('\n').filter(Boolean).length;
    const settledBefore=records.filter(r=>r.type==='agent_settled').length;
    // Real-Pi read-only command: a custom ENTRY/notification is not a custom MESSAGE or paid request.
    expect((await request('prompt',{message:'/p2o status'})).success).toBe(true);
    await delay(100);
    expect(records.some(r=>r.type==='extension_ui_request'&&r.method==='notify'&&String(r.message).includes('HISTORICAL in-memory'))).toBe(true);
    expect((await request('get_messages')).data.messages).toEqual(messages);
    expect((await readFile(log,'utf8')).split('\n').filter(Boolean)).toHaveLength(acceptedBefore);
    expect(records.filter(r=>r.type==='agent_settled')).toHaveLength(settledBefore);
    expect((await request('prompt',{message:'/fixture-stale-wake'})).success).toBe(true);
    await delay(150);expect(records.filter(r=>r.type==='agent_settled')).toHaveLength(settledBefore); // input veto, not another run.
    expect((await readFile(log,'utf8')).split('\n').filter(Boolean)).toHaveLength(acceptedBefore);
    expect((await request('get_state')).data.isStreaming).toBe(false);
    if(process.env.P2O_TEST_RECEIPT_DIR){await mkdir(process.env.P2O_TEST_RECEIPT_DIR,{recursive:true});await writeFile(join(process.env.P2O_TEST_RECEIPT_DIR,`planner-native-${mode}.json`),JSON.stringify({fixture:'Real Pi, inert provider/executor and genuine child worker. Not paid-provider cancellation or effectiveness proof.',installedExtension:process.env.P2O_TEST_INSTALLED_EXTENSION??null,checks:['wait terminates round','worker report wakes after idle','one coalesced automatic round','one semantic prompt, no periodic polling','obsolete wake aborts before accepted inert request','cleanup/export'],acceptedInertRequests:acceptedBefore,export:exported},null,2));}
  }finally{
    await request('prompt',{message:'/p2o stop'}).catch(()=>{});child.stdin.end();
    if(!await Promise.race([closed.then(()=>true),delay(3000).then(()=>false)])){child.kill('SIGTERM');await closed;}
    await rm(root,{recursive:true,force:true});
  }
},180_000);
