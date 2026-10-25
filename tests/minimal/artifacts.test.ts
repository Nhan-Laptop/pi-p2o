import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OutputCapture, utf8Prefix } from '../../src/artifacts.js';
import { OUTPUT_LIMIT, runFixed, type RunProcess } from '../../src/process.js';
import { Sandbox } from '../../src/sandbox.js';
import { AssessmentStore } from '../../src/state/store.js';

const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
async function fixture(work: (store: AssessmentStore) => void) {
  const root = await mkdtemp(join(tmpdir(),'p2o-capture-'));
  const store = AssessmentStore.create(join(root,'state'),{runId:'run-capture',retention:'durable-local',targetKind:'directory',targetIdentity:'fixture',targetDisplay:'fixture',profile:{runtimeHash:'fixture',image:'fixture',loopMode:'manual',executorMode:'shared'}});
  try {work(store);} finally {store.close();await rm(root,{recursive:true,force:true});}
}

describe('host-owned pre-truncation capture',()=>{
  it('observes real process bytes beyond the unchanged display limit without serializing buffers',async()=>{
    const capture=new OutputCapture(160000);
    try {
      const result=await runFixed(process.execPath,['-e',"process.stdout.write('x'.repeat(120000)+'END-OF-STREAM');"],{timeoutMs:null,onOutput:capture.observe});
      expect(Buffer.byteLength(result.stdout)).toBe(OUTPUT_LIMIT);expect(result.truncated).toBe(true);
      expect(capture.parts()[0].input.toString().endsWith('END-OF-STREAM')).toBe(true);
      expect(capture.receipt()).toMatchObject({available:true,observedBytes:120013,capturedBytes:120013});
      expect(JSON.stringify(capture)).not.toContain('xxxxx');expect(JSON.stringify(result)).not.toContain('END-OF-STREAM');
    } finally {capture.dispose();}
  });
  it('caps combined streams with fixed metadata even for tiny chunks and preserves stream order',()=>{
    const c=new OutputCapture(5);
    c.observe('stdout',Buffer.from('abc'));c.observe('stderr',Buffer.from('def'));
    for(let n=0;n<100000;n++)c.observe('stdout',Buffer.from('x'));
    expect(c.receipt()).toMatchObject({observedBytes:100006,capturedBytes:5,maxBytes:5});
    const parts=c.parts();expect(parts.map(p=>p.input.toString())).toEqual(['abc','de']);expect(parts).toHaveLength(2);
    const borrowed=parts[0].input;c.dispose();c.dispose();expect(borrowed.equals(Buffer.alloc(3))).toBe(true);
    expect(()=>c.observe('stdout',Buffer.from('late'))).toThrow('closed');expect(()=>c.parts()).toThrow('closed');
  });
  it('records unavailable observation honestly and announces genuinely empty real process output',async()=>{
    const unsupported=new OutputCapture(1024);expect(unsupported.receipt()).toMatchObject({available:false,warning:expect.stringContaining('cannot be reconstructed')});unsupported.dispose();
    const c=new OutputCapture(1024);
    try {await runFixed(process.execPath,['-e',''],{onOutput:c.observe});expect(c.receipt()).toMatchObject({available:true,observedBytes:0});expect(c.parts()).toEqual([]);}finally{c.dispose();}
  });
  it('retains an observed prefix on actual cancellation without changing unlimited task default',async()=>{
    const capture=new OutputCapture(1024),controller=new AbortController();
    try {
      await expect(runFixed(process.execPath,['-e',"process.stdout.write('prefix-observed');setInterval(()=>{},1000)"],{timeoutMs:null,signal:controller.signal,
        onOutput:(stream,bytes)=>{capture.observe(stream,bytes);if(bytes.length)controller.abort();}})).rejects.toThrow('Cancelled');
      expect(capture.parts()[0].input.toString()).toBe('prefix-observed');
    }finally{capture.dispose();}
  });
  it('observer failure kills the local CLI and is unknown remote outcome, never successful output',async()=>{
    await expect(runFixed(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:null,onOutput:()=>{throw Error('fixture');}})).rejects.toThrow('remote outcome unknown');
  });
  it('redacts across input chunks and a cut-off private key before file publication, with explicit hash scopes',async()=>{
    await fixture(store=>{
      const c=new OutputCapture(4096);c.observe('stdout',Buffer.from('pass'));c.observe('stdout',Buffer.from('word=should-not-be-retained\n-----BEGIN RSA PRIVATE KEY-----\ncut-off-private-material'));
      try {
        const part=c.parts()[0],a=store.ingestArtifact('owner',part.input,{maxBytes:4096,totalBytes:part.totalBytes,captureOutcome:'interrupted'}),page=store.artifact(a.id);
        expect(page.text).not.toContain('should-not-be-retained');expect(page.text).not.toContain('cut-off-private-material');expect(page.text).toContain('INCOMPLETE PRIVATE KEY');
        expect(a.redactionVersion).toBe(3);expect(a.beforeRedactionSha256).toBe(hash(part.input));expect(a.hashScope).toBe('captured-prefix-before-redaction');expect(a.sha256).toBe(hash(page.text));expect(a.truncated).toBe(true);
      } finally {c.dispose();}
    });
  });
  it('labels capture, decoding loss and redaction-expansion caps instead of claiming original-byte retention',async()=>{
    await fixture(store=>{
      const a=store.ingestArtifact('owner',Buffer.from('€'),{maxBytes:2});expect(a).toMatchObject({capturedInputBytes:2,totalBytes:3,truncated:true,decodingLossy:true});
      const b=store.ingestArtifact('owner',Buffer.from('token=x'),{maxBytes:7});expect(b).toMatchObject({truncated:true,captureReason:'redaction expansion byte cap'});
      const d=store.ingestArtifact('owner',Buffer.from('prefix'),{totalBytes:100,maxBytes:6});expect(d).toMatchObject({truncated:true,captureReason:'capture byte cap'});
      expect(()=>store.ingestArtifact('owner',Buffer.from('x'),{captureOutcome:'invented' as any})).toThrow('outcome');
    });
  });
  it('does not cut a codepoint when the redacted representation grows beyond the byte cap',async()=>{
    for(const body of ['é😀€'.repeat(4),'token=x '+ '€'.repeat(100)]){
      const original=Buffer.from(body);for(let cap=0;cap<=original.length;cap++){const p=utf8Prefix(original,cap);expect(p.length).toBeLessThanOrEqual(cap);expect(Buffer.from(p.toString()).equals(p)).toBe(true);expect(original.subarray(0,p.length).equals(p)).toBe(true);}
    }
    await fixture(store=>{const a=store.ingestArtifact('owner',Buffer.from('token=x '+ '€'.repeat(20)),{maxBytes:50}),bytes=store.artifactBytes(a.id).bytes;expect(a).toMatchObject({redactionVersion:3,truncated:true,decodingLossy:false});expect(bytes.toString()).toContain('[REDACTED]');expect(bytes.toString()).not.toContain('\ufffd');expect(Buffer.from(bytes.toString()).equals(bytes)).toBe(true);expect(a.sha256).toBe(hash(bytes));});
    expect(()=>utf8Prefix(Buffer.from('x'),-1)).toThrow('bound');
  });
  it('keeps snapshot hash integrity separate from partial captured data, missing files and unknown outcomes',async()=>{
    await fixture(store=>{
      const a=store.ingestArtifact('owner',Buffer.from('prefix'),{totalBytes:100,captureOutcome:'interrupted'});
      const checkpoint=store.checkpoint('partial byte boundary'),view=store.inspectCheckpoint(checkpoint.id);
      expect(checkpoint).toMatchObject({integrityStatus:'complete',dataStatus:'partial',capturePartialArtifactIds:[a.id],missingRefs:[]});
      expect(view).toMatchObject({integrityStatus:'complete',dataStatus:'partial',authorityRestored:false});
    });
  });
  it('wires only target exec/curl streams through Sandbox, keeping redirects, cookies, bodies and scope gates',async()=>{
    const calls:Array<{args:string[];observed:boolean;stdin?:string}>=[],names=new Set<string>();
    const first='HTTP/1.1 302 Found\r\nSet-Cookie: sid=secret; Path=/\r\nLocation: /next\r\n\r\n';
    const second='HTTP/1.1 200 OK\r\n\r\n'+'b'.repeat(60000),queue=[first,second];
    const runner:RunProcess=async(args,options)=>{
      const flags=args[0]==='--host'?args.slice(2):args;calls.push({args:flags,observed:!!options?.onOutput,stdin:options?.stdin});let stdout='';
      if(flags[0]==='context')stdout='"unix:///var/run/docker.sock"';if(flags[0]==='info')stdout='linux';if(flags[0]==='inspect')stdout='true';
      if(flags[0]==='create')names.add(flags[flags.indexOf('--name')+1]);if(flags[0]==='rm')names.delete(flags.at(-1)!);
      if(flags[0]==='exec')stdout='s'.repeat(60000);if(flags[0]==='start'&&flags.includes('--attach'))stdout=queue.shift()!;
      options?.onOutput?.('stdout',Buffer.from(stdout));return {code:0,stdout:stdout.slice(0,OUTPUT_LIMIT),stderr:'',truncated:stdout.length>OUTPUT_LIMIT};
    };
    const sandbox=new Sandbox({kind:'url',url:'https://example.com',origin:'https://example.com'},runner,async()=>['93.184.216.34']),shell=new OutputCapture(100000),http=new OutputCapture(100000);
    try {
      await sandbox.start();await sandbox.exec('inert command',0,undefined,'/work',undefined,shell.observe);
      expect(shell.receipt().observedBytes).toBe(60000);
      const result=await sandbox.http({url:'/start',method:'POST',body:'provided-body',followRedirects:true,maxRedirects:3},undefined,undefined,'actor',http.observe);
      expect(result.hops).toHaveLength(2);expect(http.parts()[0].input.toString()).toBe(first+second);
      const creates=calls.filter(c=>c.args.includes('/usr/bin/curl'));expect(creates[1].args).toContain('Cookie: sid=secret');expect(creates[1].args).toContain('GET');
      expect(calls.filter(c=>c.observed).map(c=>c.args[0])).toEqual(['exec','start','start']);expect(calls.find(c=>c.args.includes('--attach'))?.stdin).toBe('provided-body');
      // Part XI: another origin would be allowed now; the fixture queue has no response for it, so only the wiring is asserted here.
      expect(calls.filter(c=>c.args.includes('--attach'))).toHaveLength(2);
    } finally {shell.dispose();http.dispose();await sandbox.stop();}
  });
});
