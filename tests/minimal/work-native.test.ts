import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AssessmentStore } from '../../src/state/store.js';

/** Real Pi request context, tool validator and RPC; inert provider/sandbox, never a paid assessment. */
it('real Pi preserves structured work/plan arguments, dedup/replay and historical cards without extra model turns',async()=>{
  const root=await mkdtemp(join(tmpdir(),'p2o-work-native-')),repo=resolve(import.meta.dirname,'../..');await mkdir(join(root,'source'));await writeFile(join(root,'source','code.txt'),'authorized inert fixture');
  const log=join(root,'provider.jsonl'),child=spawn(join(repo,'node_modules/.bin/pi'),['--no-extensions','-e',join(repo,'tests/minimal/fixtures/owner.ts'),'--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--offline','--no-session','--no-approve','--mode','rpc','--provider','p2o-inert','--model','current-agent','--thinking','off'],{
    cwd:root,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:root,PI_CODING_AGENT_DIR:join(root,'agent'),PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',PI_TELEMETRY:'0',P2O_TEST_WORK_OWNER:'1',P2O_TEST_PROVIDER_LOG:log,P2O_TEST_FAKE_HERDR:'1',P2O_TEST_CWD:root,P2O_TEST_PI_BINARY:join(repo,'node_modules/.bin/pi'),P2O_TEST_CONTROL_ROOT:join(root,'control')},
  });
  let buffer='',stderr='',sequence=0;const records:any[]=[],pending=new Map<string,(value:any)=>void>(),closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  child.stderr.setEncoding('utf8');child.stderr.on('data',value=>{stderr+=value;});child.stdout.setEncoding('utf8');child.stdout.on('data',value=>{
    buffer+=value;for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const record=JSON.parse(line);records.push(record);
      if(record.type==='response'){pending.get(record.id)?.(record);pending.delete(record.id);}
      if(record.type==='extension_ui_request'&&record.method==='confirm')child.stdin.write(JSON.stringify({type:'extension_ui_response',id:record.id,confirmed:record.title==='Start authorized assessment?'})+'\n');
    }
  });
  const request=async(type:string,fields:any={})=>{const id=`work-native-${++sequence}`;let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([new Promise<any>(resolve=>{pending.set(id,resolve);child.stdin.write(JSON.stringify({id,type,...fields})+'\n');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`RPC timeout: ${stderr}`)),60000);})]);}finally{clearTimeout(timer);pending.delete(id);}
  };
  const text=(message:any)=>typeof message.content==='string'?message.content:JSON.stringify(message.content??'');
  const until=async(check:()=>Promise<boolean>)=>{for(let i=0;i<300;i++){if(await check())return;await delay(30);}throw Error(`Native work did not progress: ${stderr} ${JSON.stringify(records.slice(-8))}`);};
  try{
    expect((await request('get_state')).success).toBe(true);expect((await request('prompt',{message:'/p2o --target ./source --solo'})).success).toBe(true);
    await until(async()=>((await request('get_messages')).data?.messages??[]).some((message:any)=>text(message).includes('OWNER_WORK_DONE')));await until(async()=>records.some(record=>record.type==='agent_settled'));
    const messages=(await request('get_messages')).data.messages,results=messages.filter((message:any)=>message.role==='toolResult');
    expect(results.map((result:any)=>result.toolName)).toEqual(['p2o_graph','p2o_task','p2o_plan','p2o_plan','p2o_task','p2o_finish']);expect(results.every((result:any)=>!result.isError)).toBe(true);
    const task=results[1].details,plan=results[2].details;expect(task).toMatchObject({dedupConfidence:'exact',status:'proposed',outputContract:{required:['evidence','gaps']}});
    expect(results[3].details).toMatchObject({id:plan.id,replayed:true});expect(results[4].details.already_covered_by).toEqual([task.id]);expect(records.filter(record=>record.type==='extension_error')).toEqual([]);
    const runId=(await readdir(join(root,'.p2o-state')))[0],store=AssessmentStore.open(join(root,'.p2o-state'),runId);
    try{expect(store.records().filter(row=>row.data?.plan)).toHaveLength(1);expect(store.records().filter(row=>row.kind==='task').at(-1)!.data!.task).toMatchObject({status:'cancelled'});
      expect(store.outcome()).toMatchObject({assessmentOutcome:'incomplete',resourceOutcome:'cleaned'});expect(store.events({since:0,limit:100}).rows.some(row=>row.kind.startsWith('operation.'))).toBe(false);
      expect(store.checkpoints().at(-1)?.planning).toMatchObject({goals:1,phasePackets:0});
    }finally{store.close();}
    const accepted=(await readFile(log,'utf8')).split('\n').filter(Boolean).length,settled=records.filter(record=>record.type==='agent_settled').length;
    for(const command of [`open ${runId}`,'plans',`plan ${plan.id}`,'phases',`task ${task.id}`])expect((await request('prompt',{message:'/p2o '+command})).success).toBe(true);
    await until(async()=>records.some(record=>record.type==='extension_ui_request'&&record.method==='notify'&&String(record.message).includes('Owner coordination only')));
    expect((await request('get_messages')).data.messages).toEqual(messages);expect((await readFile(log,'utf8')).split('\n').filter(Boolean)).toHaveLength(accepted);expect(records.filter(record=>record.type==='agent_settled')).toHaveLength(settled);expect((await request('get_state')).data.isStreaming).toBe(false);
  }finally{await request('prompt',{message:'/p2o close'}).catch(()=>{});await request('prompt',{message:'/p2o stop'}).catch(()=>{});child.stdin.end();if(!await Promise.race([closed.then(()=>true),delay(3000).then(()=>false)])){child.kill('SIGTERM');await closed;}await rm(root,{recursive:true,force:true});}
},180_000);
