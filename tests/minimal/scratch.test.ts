import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SCRATCH_READER, scratchPath, scratchRoot, scratchBound, scratchOffset, parseScratchSnapshot, scratchPrefixHash, type ScratchSnapshot } from '../../src/scratch.js';
import { runFixed } from '../../src/process.js';
import { OutputCapture } from '../../src/artifacts.js';
import { AssessmentStore } from '../../src/state/store.js';

async function fixture(work:(root:string)=>Promise<void>) {const root=await mkdtemp(join(tmpdir(),'p2o-scratch-unit-'));try{await work(root);}finally{await rm(root,{recursive:true,force:true});}}
async function reader(root:string,path:string,maxBytes=1024,env?:NodeJS.ProcessEnv,offset=0) {
  const stdout=new OutputCapture(maxBytes),metadata:Buffer[]=[];
  try {
    const result=await runFixed('/usr/bin/python3',['-I','-S','-c',SCRATCH_READER,JSON.stringify({root,path,maxBytes,offset})],{timeoutMs:null,env,onOutput:(stream,data)=>stream==='stdout'?stdout.observe(stream,data):metadata.push(Buffer.from(data))});
    return {result,snapshot:JSON.parse(Buffer.concat(metadata).toString('utf8')),bytes:Buffer.from(stdout.parts()[0]?.input??Buffer.alloc(0))};
  }finally{stdout.dispose();}
}
const snapshot=(input:Buffer,totalBytes=input.length,path='out.txt',root='/work',offset=0):ScratchSnapshot=>({version:1,path,root,totalBytes,offset,capturedBytes:input.length,prefixSha256:scratchPrefixHash(input),before:{size:totalBytes,device:'1',inode:'2',mtimeNs:'3',ctimeNs:'4',links:1},after:{size:totalBytes,device:'1',inode:'2',mtimeNs:'3',ctimeNs:'4',links:1},stable:true,encoding:'utf8-prefix'});

describe('scratch path/FD reader and provenance (native local fixture, not host/model capability)',()=>{
  it('preserves ordinary UTF-8/literal encoded names; rejects traversal, ambiguous decoding and overlong components',()=>{
    for(const path of ['out.txt','子目录/a quoted\' file.txt','x%2f..%2fetc','a;touch marker;.txt','--flag'])expect(scratchPath(path)).toBe(path);
    for(const path of ['',null,'/work/out','../out','x/../out','./out','x//y','x/','x\\y','x\nq','x\0y','\ud800','x'.repeat(256),Array(34).fill('x').join('/'),'€'.repeat(1000)])expect(()=>scratchPath(path)).toThrow();
    expect(scratchRoot('/work/worker-1')).toBe('/work/worker-1');for(const root of ['/tmp','/work/../other','/work/.','/work//x'])expect(()=>scratchRoot(root)).toThrow();
    expect(scratchBound(1)).toBe(1);expect(scratchBound(8388608)).toBe(8388608);for(const cap of [0,8388609,1.1,'1024'])expect(()=>scratchBound(cap)).toThrow();
  });
  it('runs only the fixed reader, not file contents, shell-significant filenames or PYTHONPATH shadows',async()=>{
    await fixture(async root=>{
      const name='a;touch P2O_SHOULD_NOT_EXIST;.txt',body="raise Exception('CONTENT_MUST_NOT_EXECUTE')";
      await writeFile(join(root,name),body);await writeFile(join(root,'json.py'),"raise Exception('SHADOW_MUST_NOT_EXECUTE')");
      const read=await reader(root,name,1024,{...process.env,PYTHONPATH:root});expect(read.result.code).toBe(0);expect(read.bytes.toString()).toBe(body);expect(read.snapshot.path).toBe(name);expect(read.snapshot.prefixSha256).toBe(scratchPrefixHash(read.bytes));expect(read.snapshot.stable).toBe(true);
      await expect(stat(join(root,'P2O_SHOULD_NOT_EXIST'))).rejects.toThrow();
    });
  });
  it('caps text prefix including empty/UTF-8 boundary while preserving original file size, not display excerpt size',async()=>{
    await fixture(async root=>{
      await writeFile(join(root,'large'),'€'.repeat(30000));const large=await reader(root,'large',1024);expect(large.result.code).toBe(0);expect(large.bytes).toHaveLength(1023);expect(large.bytes.toString()).toBe('€'.repeat(341));expect(large.snapshot).toMatchObject({totalBytes:90000,capturedBytes:1023,prefixSha256:scratchPrefixHash(large.bytes)});
      await writeFile(join(root,'empty'),'');const empty=await reader(root,'empty');expect(empty.result.code).toBe(0);expect(empty.bytes).toHaveLength(0);expect(empty.snapshot).toMatchObject({totalBytes:0,capturedBytes:0});
    });
  });
  it('preserves every UTF-8 codepoint across repeated bounded segments, without replacement bytes or no-progress success',async()=>{
    await fixture(async root=>{
      for(const [name,body] of [['two','é'.repeat(8)+'tail'],['three','€'.repeat(8)+'tail'],['four','😀'.repeat(8)+'tail'],['mixed','Aé€😀B'.repeat(4)]]){
        const original=Buffer.from(body);await writeFile(join(root,name),original);const parts:Buffer[]=[];let offset=0;
        while(offset<original.length){const read=await reader(root,name,5,undefined,offset);expect(read.result.code).toBe(0);expect(read.bytes.length).toBeGreaterThan(0);expect(read.bytes.length).toBeLessThanOrEqual(5);expect(Buffer.from(read.bytes.toString()).equals(read.bytes)).toBe(true);expect(read.bytes.toString()).not.toContain('\ufffd');
          expect(read.snapshot).toMatchObject({offset,capturedBytes:read.bytes.length,totalBytes:original.length,prefixSha256:scratchPrefixHash(read.bytes)});parts.push(read.bytes);offset+=read.snapshot.capturedBytes;}
        expect(Buffer.concat(parts).equals(original),name).toBe(true);
      }
      await writeFile(join(root,'tiny'),'😀x');const tiny=await reader(root,'tiny',3);expect(tiny.result.code).toBe(78);expect(tiny.snapshot.error).toBe('UTF8_BOUND_TOO_SMALL');expect(tiny.bytes).toHaveLength(0);
      await writeFile(join(root,'broken-at-eof'),Buffer.from([0x41,0xe2,0x82]));const broken=await reader(root,'broken-at-eof',3);expect(broken.result.code).toBe(78);expect(broken.snapshot.error).toBe('INVALID_UTF8_PREFIX');expect(broken.bytes).toHaveLength(0);
    });
  });
  it('refuses symlink files/ancestors, hardlinks, FIFO, directory, binary/invalid UTF-8 and missing files without blocking',async()=>{
    await fixture(async root=>{
      await mkdir(join(root,'inside'));await writeFile(join(root,'inside','plain'),'allowed');await symlink('inside',join(root,'dir-link'));await symlink('inside/plain',join(root,'file-link'));await link(join(root,'inside','plain'),join(root,'hard-link'));
      await writeFile(join(root,'binary'),Buffer.from([0,1,2]));await writeFile(join(root,'invalid-utf8'),Buffer.from([0xff]));execFileSync('/usr/bin/mkfifo',[join(root,'fifo')]);
      for(const path of ['dir-link/plain','file-link','hard-link','fifo','inside','binary','invalid-utf8','missing']){const denied=await reader(root,path);expect(denied.result.code,path).toBe(78);expect(denied.snapshot.ok,path).toBe(false);expect(denied.bytes,path).toHaveLength(0);}
      await symlink(root,join(root,'root-link'));expect((await reader(join(root,'root-link'),'binary')).result.code).toBe(78);
    });
  });
  it('binds strict metadata to requested root/path, exact body bytes and prefix hash; refuses authority fields',()=>{
    const bytes=Buffer.from('prefix'),v=snapshot(bytes),expected={root:'/work',path:v.path,maxBytes:1024,offset:0,observedBytes:bytes.length,sha256:scratchPrefixHash(bytes)};
    expect(parseScratchSnapshot(Buffer.from(JSON.stringify(v)),expected)).toEqual(v);
    for(const wrong of [{...v,path:'other'},{...v,root:'/work/other'},{...v,capturedBytes:4},{...v,prefixSha256:'a'.repeat(64)},{...v,tickets:[]},{...v,before:{...v.before,links:2}},{...v,stable:false}])expect(()=>parseScratchSnapshot(Buffer.from(JSON.stringify(wrong)),expected)).toThrow();
    expect(()=>parseScratchSnapshot(Buffer.alloc(9000),expected)).toThrow('oversized');expect(()=>parseScratchSnapshot(Buffer.alloc(0),expected)).toThrow('missing');
  });
  it('captures bounded segments by byte offset so a long file is retained in pieces without walking it blindly',async()=>{
    await fixture(async root=>{
      const body='A'.repeat(1000)+'€'.repeat(500)+'B'.repeat(1000);await writeFile(join(root,'long.txt'),body);
      const first=await reader(root,'long.txt',512,undefined,0);expect(first.result.code).toBe(0);expect(first.bytes.toString()).toBe('A'.repeat(512));expect(first.snapshot).toMatchObject({offset:0,capturedBytes:512,totalBytes:3500});
      const second=await reader(root,'long.txt',512,undefined,512);expect(second.result.code).toBe(0);expect(second.bytes.toString()).toBe('A'.repeat(488)+'€'.repeat(8)); // 488 + 24 bytes = the 512-byte bound
      expect(second.snapshot).toMatchObject({offset:512,capturedBytes:512});
      expect([first.snapshot.prefixSha256,second.snapshot.prefixSha256].every(hash=>/^[a-f0-9]{64}$/.test(hash))).toBe(true);expect(first.snapshot.prefixSha256).not.toBe(second.snapshot.prefixSha256);
      const atEnd=await reader(root,'long.txt',16,undefined,3500);expect(atEnd.result.code).toBe(0);expect(atEnd.bytes).toHaveLength(0);expect(atEnd.snapshot).toMatchObject({offset:3500,capturedBytes:0,totalBytes:3500});
      expect((await reader(root,'long.txt',16,undefined,3501)).snapshot.error).toBe('OFFSET_BEYOND_EOF');
      // A segment beginning inside a multi-byte character is refused rather than silently mangled.
      expect((await reader(root,'long.txt',16,undefined,1005)).snapshot.error).toBe('INVALID_UTF8_PREFIX');
      expect(scratchOffset(0)).toBe(0);expect(scratchOffset(undefined)).toBe(0);expect(scratchOffset(1073741824)).toBe(1073741824);
      for(const value of [-1,1073741825,1.5,'0',true])expect(()=>scratchOffset(value)).toThrow('Scratch offset');
      const bytes=Buffer.from('segment'),v=snapshot(bytes,3500,'long.txt','/work',2048),expected={root:'/work',path:v.path,maxBytes:4096,offset:2048,observedBytes:bytes.length,sha256:scratchPrefixHash(bytes)};
      expect(parseScratchSnapshot(Buffer.from(JSON.stringify(v)),expected)).toEqual(v);
      expect(()=>parseScratchSnapshot(Buffer.from(JSON.stringify(v)),{...expected,offset:0})).toThrow('identity/byte/hash mismatch');
      expect(()=>parseScratchSnapshot(Buffer.from(JSON.stringify({...v,offset:3499})),{...expected,offset:3499})).toThrow('Invalid scratch snapshot metadata'); // offset+captured beyond totalBytes
    });
  });
  it('marks stat-change observations partial and rejects forged source provenance before publication',async()=>{
    await fixture(async root=>{
      const store=AssessmentStore.create(join(root,'state'),{runId:'run-scratch',retention:'ephemeral',targetKind:'directory',targetIdentity:'fixture',targetDisplay:'fixture',profile:{runtimeHash:'fixture',image:'fixture',loopMode:'manual',executorMode:'shared'}});
      try{const input=Buffer.from('prefix'),s=snapshot(input);s.after={...s.after,mtimeNs:'5'};s.stable=false;
        const a=store.ingestArtifact('owner',input,{kind:'scratch-file',captureOutcome:'returned',captureSource:s});expect(a).toMatchObject({truncated:true,captureReason:expect.stringContaining('not an atomic snapshot'),captureSource:{stable:false}});expect(store.checkpoint('changed observation').dataStatus).toBe('partial');
        const count=store.artifacts().length;await expect(Promise.resolve().then(()=>store.ingestArtifact('owner',input,{captureSource:{...s,root:'/work/worker'}}))).rejects.toThrow('producer');expect(()=>store.ingestArtifact('owner',input,{captureSource:{...s,prefixSha256:'a'.repeat(64)}})).toThrow('hash mismatch');expect(store.artifacts()).toHaveLength(count);
      }finally{store.close();}
    });
  });
  it('redacts credential/header/PEM continuations selected across segment boundaries and labels bounded unknown context',async()=>{
    await fixture(async root=>{
      const secret='PRIVATE_CAPTURE_VALUE',body=`password=${secret}\npublic observation\n`,header=`Authorization: Bearer ${secret}\npublic observation\n`,pem=`-----BEGIN RSA PRIVATE KEY-----\n${secret}\n-----END RSA PRIVATE KEY-----\npublic observation\n`;
      const store=AssessmentStore.create(join(root,'state'),{runId:'run-scratch',retention:'ephemeral',targetKind:'directory',targetIdentity:'fixture',targetDisplay:'fixture',profile:{runtimeHash:'fixture',image:'fixture',loopMode:'manual',executorMode:'shared'}});
      try{
        for(const [name,text,offsets] of [['password',body,[1,9]],['header',header,[1,22]],['pem',pem,[1,5,31,35]]] as const){await writeFile(join(root,name),text);
          for(const offset of offsets){const read=await reader(root,name,1024,undefined,offset);expect(read.result.code).toBe(0);expect(read.snapshot.version).toBe(2);expect(JSON.stringify(read.snapshot)).not.toContain(secret);
            const a=store.ingestArtifact('owner',read.bytes,{totalBytes:read.snapshot.totalBytes,offset,captureSource:{...read.snapshot,root:'/work'}}),retained=store.artifact(a.id).text;
            expect(retained,`${name}@${offset}`).not.toContain(secret);expect(retained,`${name}@${offset}`).not.toContain('CAPTURE_VALUE');expect(retained).toContain('public observation');expect(a.redactionVersion).toBe(3);expect(a.decodingLossy).toBe(false);expect(a.truncated).toBe(true);expect(a.beforeRedactionSha256).toBe(scratchPrefixHash(read.bytes));
          }
        }
        const longKey='-----BEGIN PRIVATE KEY-----\n'+('Q'.repeat(64)+'\n').repeat(200)+'-----END PRIVATE KEY-----\npublic observation\n';await writeFile(join(root,'long-key'),longKey);
        const unknown=await reader(root,'long-key',4096,undefined,9127);expect(unknown.result.code).toBe(0);expect(unknown.snapshot.redactionContext).toMatchObject({bytes:8192,privateKey:'unknown'});
        const a=store.ingestArtifact('owner',unknown.bytes,{totalBytes:unknown.snapshot.totalBytes,offset:9127,captureSource:{...unknown.snapshot,root:'/work'}});expect(store.artifact(a.id).text).not.toContain('Q'.repeat(10));expect(a.captureReason).toContain('unknown context');expect(store.checkpoint('bounded privacy').dataStatus).toBe('partial');
        const invalid={...unknown.snapshot,root:'/work',redactionContext:{...unknown.snapshot.redactionContext,bytes:8193}};expect(()=>store.ingestArtifact('owner',unknown.bytes,{totalBytes:unknown.snapshot.totalBytes,offset:9127,captureSource:invalid})).toThrow('redaction context');
      }finally{store.close();}
    });
  });
  it('publishes immutable redacted text even after scratch modification and keeps pre/post-redaction scopes explicit',async()=>{
    await fixture(async root=>{
      await writeFile(join(root,'out.txt'),'password=sensitive-prefix\nfirst');const first=await reader(root,'out.txt');
      const store=AssessmentStore.create(join(root,'state'),{runId:'run-scratch',retention:'ephemeral',targetKind:'directory',targetIdentity:'fixture',targetDisplay:'fixture',profile:{runtimeHash:'fixture',image:'fixture',loopMode:'manual',executorMode:'shared'}});
      try{const a=store.ingestArtifact('owner',first.bytes,{captureSource:{...first.snapshot,root:'/work'}});await writeFile(join(root,'out.txt'),'replacement');expect(store.artifact(a.id).text).toContain('first');expect(store.artifact(a.id).text).not.toContain('sensitive-prefix');expect(a.beforeRedactionSha256).toBe(first.snapshot.prefixSha256);expect(a.sha256).not.toBe(first.snapshot.prefixSha256);expect(await readFile(join(root,'out.txt'),'utf8')).toBe('replacement');}finally{store.close();}
    });
  });
});
