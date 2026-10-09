import { describe, expect, it } from 'vitest';
import { ExecutorPool } from '../../src/executors.js';
import { InertSandbox } from './helpers/inert-sandbox.js';
const target={kind:'directory' as const,path:'/inert'};

function fixture(mode:'shared'|'isolated'='isolated',cap=2) {
  const primary=new InertSandbox(target),children:InertSandbox[]=[];let active=true;
  const pool=new ExecutorPool(mode,cap,primary,()=>{const s=new InertSandbox(target);children.push(s);return s;},()=>active);
  return {pool,primary,children,deactivate:()=>{active=false;}};
}
describe('run-owned isolated executors',()=>{
  it('separates assignment scratch/lifecycle and lets B return while A waits',async()=>{
    const f=fixture();await f.pool.acquire('a');await f.pool.acquire('b');let release!:()=>void;
    const a=f.pool.use('a',undefined,()=>new Promise<void>(r=>{release=r;}));
    const b=await f.pool.use('b',undefined,s=>s.exec('short',0,undefined,'/work/b'));
    expect(b.stdout).toContain('short');expect(f.children[1].commands[0].workdir).toBe('/work/b');
    await f.pool.release('b');expect(f.children[1].stopCount).toBe(1);expect(f.children[0].stopCount).toBe(0);
    release();await a;await f.pool.stop();expect(f.children[0].stopCount).toBe(1);expect(f.primary.stopCount).toBe(0);
  });
  it('limits target operations separately from model slots and cancels a queued waiter',async()=>{
    const f=fixture('isolated',1);await f.pool.acquire('a');await f.pool.acquire('b');let release!:()=>void;
    const first=f.pool.use('a',undefined,()=>new Promise<void>(r=>{release=r;}));
    const controller=new AbortController();const second=f.pool.use('b',controller.signal,s=>s.exec('must not execute'));
    expect(f.pool.snapshot()).toMatchObject({runningTargetOperations:1,waitingTargetOperations:1});controller.abort();await expect(second).rejects.toThrow('Cancelled');
    release();await first;expect(f.children[1].commands).toHaveLength(0);await f.pool.stop();
  });
  it('fails closed on a source snapshot mismatch without leaking ownership',async()=>{
    const f=fixture();f.primary.sourceManifest={'file':'initial'};await expect(f.pool.acquire('a')).rejects.toThrow('snapshot changed');
    expect(f.pool.snapshot().ownedAssignmentExecutors).toBe(1);await f.pool.stop();expect(f.children[0].stopCount).toBe(1);
  });
  it('does not drop failed cleanup and rejects all queued/new work after owner stop',async()=>{
    const f=fixture();await f.pool.acquire('a');f.children[0].cleanupFailure=true;await expect(f.pool.stop()).rejects.toThrow('unresolved');expect(f.pool.snapshot().ownedAssignmentExecutors).toBe(1);
    await expect(f.pool.use('a',undefined,s=>s.exec('must not execute'))).rejects.toThrow('inactive');f.children[0].cleanupFailure=false;await f.pool.stop();expect(f.pool.snapshot().ownedAssignmentExecutors).toBe(0);
  });
  it('shared mode keeps exactly one executor and an explicit serial operation ceiling',async()=>{
    const f=fixture('shared',1);await f.pool.acquire('a');await f.pool.use('a',undefined,s=>s.exec('shared'));
    expect(f.children).toHaveLength(0);expect(f.primary.commands).toHaveLength(1);expect(f.pool.snapshot().mode).toBe('shared');await f.pool.stop();
  });
});
