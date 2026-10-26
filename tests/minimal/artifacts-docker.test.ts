import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Sandbox, IMAGE } from '../../src/sandbox.js';
import { OutputCapture } from '../../src/artifacts.js';
import { AssessmentStore } from '../../src/state/store.js';
import { registerP2O } from '../../extensions/p2o/index.js';
import { createContext, createFakePi, createSimpleHerdr, EXTENSION_PATH } from './helpers/fake-pi.js';
import { BrokerClient } from '../../src/broker.js';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

it.skipIf(process.env.P2O_TEST_DOCKER !== '1')('real Docker: bounded shell/curl capture before display truncation, immutable redaction/ranges, scope and cleanup',async()=>{
  const root=await mkdtemp(join(tmpdir(),'p2o-artifact-docker-')),runId=`run-${randomUUID()}`;
  const requests:string[]=[];
  const server=createServer((request,response)=>{
    requests.push(request.url!);
    if(request.url==='/large'){response.writeHead(200,{'Set-Cookie':'sid=sensitive-capture-cookie; Path=/','Content-Type':'text/plain'});response.end('b'.repeat(120000)+'HTTP-TAIL');}
    else {response.writeHead(200);response.end(request.headers.cookie==='sid=sensitive-capture-cookie'?'SESSION-PRESERVED':'NO-SESSION');}
  });
  await new Promise<void>(resolve=>server.listen(0,'0.0.0.0',resolve));
  const origin=`http://host.docker.internal:${(server.address() as {port:number}).port}`;
  const store=AssessmentStore.create(join(root,'state'),{runId,retention:'ephemeral',targetKind:'url',targetIdentity:origin,targetDisplay:origin,profile:{runtimeHash:'fixture',image:IMAGE,loopMode:'manual',executorMode:'shared'}});
  const sandbox=new Sandbox({kind:'url',url:origin,origin},undefined,undefined,{runId}),shell=new OutputCapture(1024*1024),http=new OutputCapture(1024*1024);
  try {
    await sandbox.start();
    const result=await sandbox.exec('python3 -c "import sys;sys.stdout.write(\'s\'*80000+\'SHELL-TAIL\')"',0,undefined,'/work',undefined,shell.observe);
    expect(result.code).toBe(0);expect(result.truncated).toBe(true);expect(result.stdout).not.toContain('SHELL-TAIL');
    const part=shell.parts()[0],a=store.ingestArtifact('owner',part.input,{totalBytes:part.totalBytes,captureOutcome:'returned'});
    expect(store.artifact(a.id,79000).text).toContain('SHELL-TAIL');expect(a.truncated).toBe(false);
    const received=await sandbox.http({url:'/large',method:'GET',followRedirects:false,maxRedirects:0},undefined,undefined,http.observe);
    expect(received.code).toBe(0);expect(received.truncated).toBe(true);expect(received.stdout).not.toContain('HTTP-TAIL');
    const body=http.parts().find(p=>p.stream==='stdout')!,h=store.ingestArtifact('owner',body.input,{totalBytes:body.totalBytes,captureOutcome:'returned'});
    expect(store.artifact(h.id).text).not.toContain('sensitive-capture-cookie');expect(store.artifact(h.id,119000).text).toContain('HTTP-TAIL');
    const reused=await sandbox.http({url:'/session',method:'GET',followRedirects:false,maxRedirects:0});expect(reused.stdout).toContain('SESSION-PRESERVED');
    await expect(sandbox.http({url:`http://127.0.0.1:${(server.address() as {port:number}).port}/outside`,method:'GET',followRedirects:false,maxRedirects:0})).rejects.toThrow('Out of scope');expect(requests).toEqual(['/large','/session']);
    expect(store.checkpoint('captured byte boundary').dataStatus).toBe('complete');
    await sandbox.stop();await sandbox.assertNoRunContainers();
  } finally {
    shell.dispose();http.dispose();
    try {await sandbox.stop();} finally {store.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
  }
},90000);

it.skipIf(process.env.P2O_TEST_DOCKER !== '1')('real Docker owner runtime: validated scratch text/empty/cap/immutability, path/FD/binary denials, redacted preview and cleanup',async()=>{
  const root=await mkdtemp(join(tmpdir(),'p2o-scratch-docker-'));await mkdir(join(root,'source'));await writeFile(join(root,'source','approved.txt'),'approved fixture');
  const pi=createFakePi(),ctx=createContext({cwd:root}),sandboxes:Sandbox[]=[];
  registerP2O(pi.pi,{extensionPath:EXTENSION_PATH,controlRoot:join(root,'control'),settingsPath:join(root,'isolated-settings.json'),createSandbox:(target,profile)=>{const s=new Sandbox(target,undefined,undefined,profile);sandboxes.push(s);return s;}});
  const command=(args:string)=>pi.commands.get('p2o').handler(args,ctx.ctx),call=(name:string,params:any)=>pi.tools.get(name).execute(randomUUID(),params,undefined,undefined,ctx.ctx);
  try{
    await command('--target ./source');expect(sandboxes).toHaveLength(1);
    const made=await call('p2o_shell',{command:`python3 -c "from pathlib import Path; p=Path('/work/sub space'); p.mkdir(); (p/'report;quoted.txt').write_text('password=PRIVATE_CAPTURE_VALUE\\n'+'x'*60000+'SCRATCH-TAIL'); Path('/work/empty').write_text(''); Path('/tmp/outside').write_text('OUTSIDE_NOT_IMPORTED'); Path('/work/binary').write_bytes(bytes([0,1,2]))"; ln -s /tmp/outside /work/link; ln -s /tmp /work/dir-link; printf plain > /work/hard; ln /work/hard /work/hard-link; mkfifo /work/fifo; printf ready`});expect(made.details.exitCode).toBe(0);
    const first=await call('p2o_capture',{path:'sub space/report;quoted.txt'}),id=first.details.capture.artifacts[0].id;expect(JSON.stringify(first)).not.toContain('PRIVATE_CAPTURE_VALUE');expect(first.content[0].text).toContain('Artifact ID:');expect(first.details.capture.artifacts[0]).toMatchObject({truncated:false,capturedInputBytes:60043,totalBytes:60043});
    const run=(await readdir(join(root,'.p2o-state')))[0],store=AssessmentStore.open(join(root,'.p2o-state'),run);
    try{expect(store.artifact(id,59500).text).toContain('SCRATCH-TAIL');expect(store.artifact(id).manifest.captureSource).toMatchObject({root:'/work',path:'sub space/report;quoted.txt',stable:true});expect(store.record(first.details.evidenceId)?.data?.receiptRedactionVersion).toBe(2);}finally{store.close();}
    const segment=await call('p2o_capture',{path:'sub space/report;quoted.txt',offset:1,});expect(segment.details.capture.artifacts[0]).toMatchObject({offset:1,totalBytes:60043});expect(JSON.stringify(segment)).not.toContain('PRIVATE_CAPTURE_VALUE');
    const segmentStore=AssessmentStore.open(join(root,'.p2o-state'),run);try{const page=segmentStore.artifact(segment.details.capture.artifacts[0].id);expect(page.text.startsWith('[REDACTED LEADING LINE FRAGMENT]')).toBe(true);expect(page.text).not.toContain('PRIVATE_CAPTURE_VALUE');expect(page.manifest).toMatchObject({redactionVersion:3,truncated:true,decodingLossy:false});expect(page.manifest.captureSource).toMatchObject({version:2,offset:1,totalBytes:60043,stable:true,redactionContext:{leadingFragment:true,privateKey:'none'}});const tail=segmentStore.artifact(segment.details.capture.artifacts[0].id,page.manifest.bytes-12);expect(tail.text).toContain('SCRATCH-TAIL');}finally{segmentStore.close();}
    await expect(call('p2o_capture',{path:'sub space/report;quoted.txt',offset:60044})).rejects.toThrow('OFFSET_BEYOND_EOF');
    await call('p2o_shell',{command:"printf replacement > '/work/sub space/report;quoted.txt'"});await call('p2o_capture',{path:'sub space/report;quoted.txt'});const old=AssessmentStore.open(join(root,'.p2o-state'),run);try{expect(old.artifact(id,59500).text).toContain('SCRATCH-TAIL');}finally{old.close();}
    await expect(call('p2o_capture',{path:'sub space/report;quoted.txt',offset:60044})).rejects.toThrow('OFFSET_BEYOND_EOF');
    const empty=await call('p2o_capture',{path:'empty'});expect(empty.details.capture.artifacts[0]).toMatchObject({bytes:0,totalBytes:0,capturedInputBytes:0});
    await call('p2o_shell',{command:`python3 -c "from pathlib import Path; Path('/work/utf8').write_text('€'*400000+'\\nUTF8-END')"`});
    const unicode=await call('p2o_capture',{path:'utf8'});expect(unicode.details.capture.source).toMatchObject({version:2,capturedBytes:1048575,totalBytes:1200009});
    const unicodeStore=AssessmentStore.open(join(root,'.p2o-state'),run);try{const a=unicodeStore.artifact(unicode.details.capture.artifacts[0].id);expect(a.manifest.decodingLossy).toBe(false);expect(a.manifest.capturedInputBytes).toBe(1048575);expect(unicodeStore.artifactBytes(a.manifest.id).bytes.toString('utf8')).not.toContain('\ufffd');expect(unicodeStore.artifact(a.manifest.id,0,16383).text).toBe('€'.repeat(5461));}finally{unicodeStore.close();}
    const next=await call('p2o_capture',{path:'utf8',offset:unicode.details.capture.source.capturedBytes});expect(next.details.capture.source.offset+next.details.capture.source.capturedBytes).toBe(1200009);expect(next.content[0].text).toContain('UTF8-END');
    for(const path of ['link','dir-link/outside','hard-link','fifo','binary','sub space','missing'])await expect(call('p2o_capture',{path})).rejects.toThrow('Scratch capture denied');
    for(const path of ['/tmp/outside','../tmp/outside'])await expect(call('p2o_capture',{path})).rejects.toThrow('Scratch path');expect(sandboxes[0].isStopped).toBe(false);
    await call('p2o_shell',{command:"printf after-denials > /work/after"});expect((await call('p2o_capture',{path:'after'})).content[0].text).toContain('after-denials');
    await command('stop');await sandboxes[0].assertNoRunContainers();expect(await readdir(join(root,'control'))).toEqual([]);const retained=AssessmentStore.open(join(root,'.p2o-state'),run);try{expect(retained.artifact(id,59500).text).toContain('SCRATCH-TAIL');expect(retained.outcome()?.resourceOutcome).toBe('cleaned');}finally{retained.close();}
  }finally{await command('stop');await command('close');await rm(root,{recursive:true,force:true});}
},120000);

it.skipIf(process.env.P2O_TEST_DOCKER !== '1')('real isolated Docker + authenticated broker: scratch root ownership/cap/admission, retained artifact and revoked capture',async()=>{
  const root=await mkdtemp(join(tmpdir(),'p2o-scratch-worker-docker-'));await mkdir(join(root,'source'));await writeFile(join(root,'source','approved.txt'),'approved fixture');await writeFile(join(root,'isolated-settings.json'),JSON.stringify({p2o:{artifactCaptureKiB:1}}));
  const pi=createFakePi(),ctx=createContext({cwd:root}),herdr=createSimpleHerdr(),sandboxes:Sandbox[]=[];
  registerP2O(pi.pi,{extensionPath:EXTENSION_PATH,herdr:herdr.client,controlRoot:join(root,'control'),settingsPath:join(root,'isolated-settings.json'),createSandbox:(target,profile)=>{const s=new Sandbox(target,undefined,undefined,profile);sandboxes.push(s);return s;}});
  const command=(s:string)=>pi.commands.get('p2o').handler(s,ctx.ctx),call=(name:string,params:any)=>pi.tools.get(name).execute(randomUUID(),params,undefined,undefined,ctx.ctx);let client:BrokerClient|undefined;
  try{
    await command('--target ./source --executors isolated --target-ops 2 --workers 2');const actor=(await call('p2o_delegate',{focus:'scratch',task:'capture authorized local fixture'})).details;
    const control=join(root,'control',(await readdir(join(root,'control')))[0]),ticket=JSON.parse(await readFile(join(control,`ticket-${actor.workerId}.json`),'utf8'));client=new BrokerClient(ticket.socket,ticket.token);
    await client.request('runtime',{model:ticket.requestedRuntime.model,thinking:ticket.requestedRuntime.thinking});await client.request('exec',{command:`python3 -c "from pathlib import Path; Path('out.txt').write_text('password=PRIVATE_WORKER_VALUE\\n'+'z'*4000)"`});
    const captured=await client.request('capture',{path:'out.txt',root:'/work/other',workdir:'/etc',maxBytes:8388608,by:'owner'});expect(JSON.stringify(captured)).not.toContain('PRIVATE_WORKER_VALUE');expect(captured.capture.artifacts[0]).toMatchObject({capturedInputBytes:1024,truncated:true});expect(captured.capture.source.root).toBe(`/work/${actor.workerId}`);expect((await client.request('status')).used).toBe(2);expect(sandboxes).toHaveLength(2);
    const runId=(await readdir(join(root,'.p2o-state')))[0],store=AssessmentStore.open(join(root,'.p2o-state'),runId);try{const a=store.artifact(captured.capture.artifacts[0].id);expect(a.manifest.producer).toBe(actor.workerId);expect(a.manifest.captureSource?.root).toBe(`/work/${actor.workerId}`);expect(a.text).not.toContain('PRIVATE_WORKER_VALUE');}finally{store.close();}
    await call('p2o_workers',{action:'stop',workerId:actor.workerId,reason:'artifact fixture complete'});await expect(client.request('capture',{path:'out.txt'})).rejects.toThrow('stopped');expect(sandboxes[0].isStopped).toBe(false);await command('stop');for(const sandbox of sandboxes)await sandbox.assertNoRunContainers();
  }finally{client?.close();await command('stop');await command('close');await rm(root,{recursive:true,force:true});}
},120000);
