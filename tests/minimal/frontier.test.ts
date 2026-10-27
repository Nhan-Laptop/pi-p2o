import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TaskBoard, type TaskDraft } from '../../src/tasks.js';
import { appendRecord } from '../../src/records.js';
let root:string,board:TaskBoard,path:string;
const draft=(id:string):TaskDraft=>({id,question:'Which harmless observation distinguishes the hypotheses?',surface:id,risk:'boundary',role:'general',roleReason:'Bounded independent source observation',expectedTrue:'An authorized observation supports the hypothesis',expectedFalse:'An effective control contradicts the hypothesis',stopCondition:'Stop after one observation or a missing prerequisite',evidenceIds:[],prerequisites:[],method:{skills:[],reason:'Smallest local observation for this fixture'}});
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'p2o-frontier-'));path=join(root,'ledger.jsonl');await writeFile(path,'',{mode:0o600});board=new TaskBoard('run-frontier',path,()=>true);});
afterEach(async()=>rm(root,{recursive:true,force:true}));
it('retains more than 100 terminal tasks and has no live-frontier cap (Part XI)',async()=>{
  for(let i=0;i<120;i++){const t=await board.create(draft(`old-${i}`));await board.transition(t.id,'cancelled','Fixture assignment explicitly withdrawn');}
  for(let i=0;i<180;i++)await board.create(draft(`live-${i}`));
  expect(await board.list()).toHaveLength(300);
  await board.create(draft('overflow'));
  const old=(await board.list()).find(t=>t.id==='old-0')!;await board.revise(old.id,old.revision,draft(old.id));
  expect(await board.list()).toHaveLength(301);
},20000);
it('allows a future reviewed dependency, pins only accepted revisions and rejects revision changes at command admission',async()=>{
  const a=await board.create(draft('predecessor'));
  const b=await board.create({...draft('dependent'),prerequisites:[{taskId:a.id}]});
  expect(await board.readiness(b.id)).toMatchObject({ready:false});await expect(board.reserve(b.id,'second-worker')).rejects.toThrow('accepted evidence');
  await board.reserve(a.id,'first-worker');await board.transition(a.id,'running','Fixture worker assignment launched');await board.transition(a.id,'reported','Fixture report persisted before acceptance');
  const ref=randomUUID();await appendRecord(path,{id:ref,runId:'run-frontier',at:new Date().toISOString(),by:'first-worker',kind:'evidence',text:'Harmless fixture observation; not semantic proof'});
  const reviewed=await board.transition(a.id,'reviewed','Accept attributed receipt, not a security conclusion',[ref]);
  expect(await board.readiness(b.id)).toMatchObject({ready:true});const reserved=await board.reserve(b.id,'second-worker');expect(reserved.prerequisites).toEqual([{taskId:a.id,revision:reviewed.revision}]);
  await board.transition(b.id,'running','Fixture dependent launched');await board.assertReady('second-worker');
  // P10/TR-H10: a substantive revision of the prerequisite is refused at the next admission/readiness, not on every command of
  // the dependent worker that is already running against the pinned premise.
  await board.revise(a.id,reviewed.revision,draft(a.id));await expect(board.assertReady('second-worker')).resolves.toBeUndefined();
});
