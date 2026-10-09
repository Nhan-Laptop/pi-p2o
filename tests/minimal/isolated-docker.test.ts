import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Sandbox } from '../../src/sandbox.js';
import { ExecutorPool } from '../../src/executors.js';

/** Opt-in local Docker mechanics only. No model, external target, downloads or image pull. */
it.skipIf(process.env.P2O_TEST_DOCKER !== '1')('isolated Docker: B returns while A runs; cancelling A preserves B; run cleanup sweeps every executor',async()=>{
  const root=await mkdtemp(join(tmpdir(),'p2o-isolated-docker-'));await mkdir(join(root,'source'));await writeFile(join(root,'source','fixture.txt'),'authorized fixture');
  const target={kind:'directory' as const,path:join(root,'source')},options={runId:`isolation-${randomUUID()}`};
  const primary=new Sandbox(target,undefined,undefined,options),children:Sandbox[]=[];let active=true;
  const pool=new ExecutorPool('isolated',2,primary,()=>{const s=new Sandbox(target,undefined,undefined,options);children.push(s);return s;},()=>active);
  const cancellation=new AbortController();
  try{
    await primary.start();await pool.acquire('a');await pool.acquire('b');
    let started!:()=>void;const running=new Promise<void>(r=>{started=r;});
    const a=pool.use('a',cancellation.signal,s=>s.exec('printf A-start; sleep 30; printf A-end',0,cancellation.signal,'/work/a',started));
    const failure=a.catch(e=>String(e));await running;
    const began=Date.now();const b=await pool.use('b',undefined,s=>s.exec('printf B-ready; cat /target/fixture.txt',0,undefined,'/work/b'));
    expect(b.stdout).toContain('B-ready');expect(b.stdout).toContain('authorized fixture');expect(Date.now()-began).toBeLessThan(10000);
    cancellation.abort();expect(await failure).toMatch(/cancel|abort/i);expect(children[0].isStopped).toBe(true);expect(children[1].isStopped).toBe(false);
    const again=await pool.use('b',undefined,s=>s.exec('printf B-still-alive',0,undefined,'/work/b'));expect(again.stdout).toBe('B-still-alive');
    await pool.release('a');expect(primary.isStopped).toBe(false);
  }finally{
    cancellation.abort();active=false;await pool.stop();await primary.stop();await primary.assertNoRunContainers();await rm(root,{recursive:true,force:true});
  }
},90000);
