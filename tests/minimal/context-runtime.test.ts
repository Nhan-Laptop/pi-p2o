import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerP2O } from '../../extensions/p2o/index.js';
import { AssessmentStore } from '../../src/state/store.js';
import { BrokerClient } from '../../src/broker.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, InertSandbox, EXTENSION_PATH, type FakePi } from './helpers/fake-pi.js';

async function fixture(work:(h:any)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'p2o-context-runtime-'));await mkdir(join(root,'source'));const pi=createFakePi(),ctx=createContext({cwd:root}),herdr=createSimpleHerdr(),sandboxes:InertSandbox[]=[];registerP2O(pi.pi,{extensionPath:EXTENSION_PATH,settingsPath:join(root,'fixture-settings.json'),controlRoot:join(root,'control'),herdr:herdr.client,createSandbox:sandboxFactory(sandboxes)});
  const emit=async(event:string,payload:any={},which:FakePi=pi,context=ctx)=>{let result:any;for(const handler of which.events.get(event)??[])result=await handler(payload,context.ctx);return result;},call=(name:string,params:any={},which:FakePi=pi,context=ctx)=>which.tools.get(name).execute('context-fixture',params,undefined,undefined,context.ctx),reader=async()=>AssessmentStore.open(join(root,'.p2o-state'),(await readdir(join(root,'.p2o-state')))[0]),command=(value:string)=>pi.commands.get('p2o').handler(value,ctx.ctx),packet=(result:any)=>JSON.parse(result.messages.find((m:any)=>m.customType==='p2o_knowledge_state').content.split('Delivery cursor is not review. ')[1]);
  try{await work({root,pi,ctx,herdr,sandboxes,emit,call,reader,command,packet});}finally{await command('stop');await rm(root,{recursive:true,force:true});}
}
const success={message:{role:'assistant',content:[{type:'text',text:'Inert response, not reviewed proof'}],stopReason:'stop'}};

describe('indexed role packets through the active owner/worker hooks',()=>{
  it('does not ACK at agent_start or provider-error; a successful response advances only delivery',async()=>fixture(async(h)=>{
    await h.command('--target ./source --solo');await h.call('p2o_note',{kind:'open',text:'Old durable unresolved gap'});await h.emit('agent_start');let store=await h.reader();try{expect(store.contextCursor('planner')).toBeUndefined();}finally{store.close();}
    const projection=await h.emit('context',{messages:[]}),prepared=h.packet(projection);expect(prepared.counts.openGaps).toBe(1);expect(prepared.newGaps).toHaveLength(1);expect(h.pi.messages).toHaveLength(1);expect(h.sandboxes[0].commands).toEqual([]);
    await h.command('heads all 0 5');await h.command('digest');store=await h.reader();try{expect(store.contextCursor('planner')).toBeUndefined();expect(store.sequence()).toBe(prepared.asOfSequence);}finally{store.close();}
    await h.emit('message_end',{message:{role:'assistant',stopReason:'error',errorMessage:'Inert provider failure'}});store=await h.reader();try{expect(store.contextCursor('planner')).toBeUndefined();}finally{store.close();}
    const again=await h.emit('context',{messages:projection.messages});expect(h.packet(again)).toEqual(prepared);expect(again.messages.filter((m:any)=>m.customType==='p2o_knowledge_state')).toHaveLength(1);
    await h.emit('message_end',success);store=await h.reader();try{expect(store.contextCursor('planner')).toMatchObject({throughSequence:prepared.cursorAfter.throughSequence});expect(store.knowledgePage({domain:'gap',status:'open'}).total).toBe(1);expect(store.events({since:0,limit:100}).rows.filter((row:{kind:string})=>row.kind==='context.consumed')).toHaveLength(1);}finally{store.close();}
    expect(h.pi.messages).toHaveLength(1);expect(h.sandboxes[0].commands).toEqual([]);
  }));
  it('refuses an aborted projection and keeps pending delta available without a model retry',async()=>fixture(async(h)=>{
    await h.command('--target ./source --solo');await h.call('p2o_note',{kind:'open',text:'Unresolved abort fixture'});await h.emit('context',{messages:[]});h.ctx.ctx.abort();await h.emit('message_end',success);const store=await h.reader();try{expect(store.contextCursor('planner')).toBeUndefined();expect(store.contextPacket({consumerId:'planner',role:'planner'}).counts.openGaps).toBe(1);}finally{store.close();}expect(h.pi.messages).toHaveLength(1);
  }));
  it('delivers assignment-bound worker context/receipts under verified runtime and refuses forged ACKs',async()=>fixture(async(h)=>{
    await h.command('--target ./source');const delegated=(await h.call('p2o_delegate',{focus:'context-worker',task:'Read one inert authorized assignment',role:'general',skills:[]})).details.workerId,control=join(h.root,'control',(await readdir(join(h.root,'control')))[0]),ticketPath=join(control,`ticket-${delegated}.json`),ticket=JSON.parse(await readFile(ticketPath,'utf8')),client=new BrokerClient(ticket.socket,ticket.token);
    try{
      await expect(client.request('context_read')).rejects.toThrow('Verified runtime');await client.request('runtime',{model:'p2o-inert/current-agent',thinking:'off'});
      await expect(client.request('context_read',{taskId:'task-foreign'})).rejects.toThrow('unknown');const value=(await client.request('context_read')).value;expect(value.objective.assignee).toBe(delegated);expect(value.packet).toMatchObject({consumerId:delegated,role:'worker',taskId:ticket.taskId});await expect(client.request('context_ack',{packetSha256:'a'.repeat(64)})).rejects.toThrow('Unknown context');
      const worker=createFakePi(),workerCtx=createContext({cwd:h.root});registerP2O(worker.pi,{extensionPath:EXTENSION_PATH,settingsPath:join(h.root,'worker-settings.json')});worker.flags['p2o-worker']=ticketPath;await h.emit('session_start',{},worker,workerCtx);expect(workerCtx.notices.join('\n')).not.toContain('rejected');
      const projection=await h.emit('context',{messages:[]},worker,workerCtx),packet=h.packet(projection);expect(packet.consumerId).toBe(delegated);await h.emit('message_end',success,worker,workerCtx);const store=await h.reader();try{expect(store.contextCursor(delegated)).toMatchObject({packetSha256:packet.packetSha256});}finally{store.close();}
      expect((await h.call('p2o_state',{action:'heads',domain:'task'},worker,workerCtx)).details.total).toBe(1);expect(h.sandboxes[0].commands).toEqual([]);await h.call('p2o_stop_worker',{workerId:delegated,reason:'Inert context fixture complete'});await expect(client.request('context_read')).rejects.toThrow('stopped');await expect(client.request('context_ack',{packetSha256:packet.packetSha256})).rejects.toThrow('stopped');await h.emit('session_shutdown',{},worker,workerCtx);
    }finally{client.close();}
  }));
});
