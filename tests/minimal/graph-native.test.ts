import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AssessmentStore } from '../../src/state/store.js';

/** Actual Pi RPC/tool validator + inert provider/sandbox. Not a paid API or target assessment. */
it('real Pi executes graph tools, unwraps retained ACKs, and reads retained graph through human RPC without another model turn',async()=>{
  const root=await mkdtemp(join(tmpdir(),'p2o-graph-native-')),repo=resolve(import.meta.dirname,'../..');
  await mkdir(join(root,'source'));await writeFile(join(root,'source','code.txt'),'authorized fixture');
  const log=join(root,'provider.jsonl');
  const child=spawn(join(repo,'node_modules/.bin/pi'),['--no-extensions','-e',join(repo,'tests/minimal/fixtures/owner.ts'),'--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--offline','--no-session','--no-approve','--mode','rpc','--provider','p2o-inert','--model','current-agent','--thinking','off'],{
    cwd:root,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:root,PI_CODING_AGENT_DIR:join(root,'agent'),PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',PI_TELEMETRY:'0',P2O_TEST_GRAPH_OWNER:'1',P2O_TEST_PROVIDER_LOG:log,P2O_TEST_FAKE_HERDR:'1',P2O_TEST_CWD:root,P2O_TEST_PI_BINARY:join(repo,'node_modules/.bin/pi'),P2O_TEST_CONTROL_ROOT:join(root,'control')},
  });
  let buffer='',stderr='',sequence=0;const records:any[]=[];const pending=new Map<string,(r:any)=>void>();
  const closed=new Promise<void>(r=>child.once('close',()=>r()));
  child.stderr.setEncoding('utf8');child.stderr.on('data',s=>{stderr+=s;});child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{
    buffer+=s;for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
      const r=JSON.parse(line);records.push(r);if(r.type==='response'){pending.get(r.id)?.(r);pending.delete(r.id);}
      if(r.type==='extension_ui_request'&&r.method==='confirm')child.stdin.write(JSON.stringify({type:'extension_ui_response',id:r.id,confirmed:r.title==='Start authorized assessment?'})+'\n');
    }
  });
  const request=async(type:string,fields:any={})=>{const id=`graph-native-${++sequence}`;let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([new Promise<any>(r=>{pending.set(id,r);child.stdin.write(JSON.stringify({id,type,...fields})+'\n');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`RPC timeout: ${stderr}`)),60000);})]);}
    finally{clearTimeout(timer);pending.delete(id);}
  };
  const text=(m:any)=>typeof m.content==='string'?m.content:JSON.stringify(m.content??'');
  const until=async(p:()=>Promise<boolean>)=>{for(let i=0;i<2000;i++){if(await p())return;await delay(30);}throw Error(`No native graph progress: ${stderr} ${JSON.stringify(records.slice(-8))}`);};
  try{
    expect((await request('get_state')).success).toBe(true);
    expect((await request('prompt',{message:'/p2o --target ./source'})).success).toBe(true);
    await until(async()=>((await request('get_messages')).data?.messages??[]).some((m:any)=>text(m).includes('OWNER_GRAPH_DONE')));
    await until(async()=>records.some(r=>r.type==='agent_settled'));
    const messages=(await request('get_messages')).data.messages,results=messages.filter((m:any)=>m.role==='toolResult');
    expect(results.map((r:any)=>r.toolName)).toEqual(['p2o_graph','p2o_graph','p2o_graph','p2o_graph','p2o_finish']);
    expect(results.every((r:any)=>!r.isError)).toBe(true);expect(results[1].details).toMatchObject({replayed:true,acks:results[0].details.acks});
    const id=results[0].details.acks[0].entityId;expect(results[2].details).toMatchObject({entityId:id,counts:{revisions:1,assertions:1,provenance:2}});
    expect(results[3].details.mermaid).toContain('graph LR');expect(records.filter(r=>r.type==='extension_error')).toEqual([]);
    const runId=(await readdir(join(root,'.p2o-state')))[0],store=AssessmentStore.open(join(root,'.p2o-state'),runId);
    try{expect(store.graphSummary()).toMatchObject({assets:1,assertions:1,assetRevisions:1});expect(store.outcome()).toMatchObject({assessmentOutcome:'incomplete',resourceOutcome:'cleaned'});
      expect(store.records().filter(r=>r.kind==='evidence')).toEqual([]);expect(store.events({since:0}).rows.some(r=>r.kind.startsWith('operation.'))).toBe(false);}
    finally{store.close();}
    const accepted=(await readFile(log,'utf8')).split('\n').filter(Boolean).length,settled=records.filter(r=>r.type==='agent_settled').length;
    for(const command of [`open ${runId}`,'graph',`graph ${id}`,'graph export'])expect((await request('prompt',{message:'/p2o '+command})).success).toBe(true);
    await until(async()=>records.some(r=>r.type==='extension_ui_request'&&r.method==='notify'&&String(r.message).includes('Graph JSON/Mermaid')));
    expect(records.some(r=>r.type==='extension_ui_request'&&r.method==='notify'&&String(r.message).includes('graph LR'))).toBe(true);
    expect((await request('get_messages')).data.messages).toEqual(messages);
    expect((await readFile(log,'utf8')).split('\n').filter(Boolean)).toHaveLength(accepted);expect(records.filter(r=>r.type==='agent_settled')).toHaveLength(settled);
    expect((await request('get_state')).data.isStreaming).toBe(false);
  }finally{
    await request('prompt',{message:'/p2o close'}).catch(()=>{});await request('prompt',{message:'/p2o stop'}).catch(()=>{});child.stdin.end();
    if(!await Promise.race([closed.then(()=>true),delay(3000).then(()=>false)])){child.kill('SIGTERM');await closed;}
    await rm(root,{recursive:true,force:true});
  }
},180_000);
