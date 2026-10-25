import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { visibleWidth } from '@earendil-works/pi-tui';
import { registerP2O } from '../../extensions/p2o/index.js';
import { appendRecord, observeRecords, readLedger } from '../../src/records.js';
import { BrokerClient } from '../../src/broker.js';
import { AssessmentStore } from '../../src/state/store.js';
import { parseStateCommand, statusView } from '../../src/ui/state.js';
import { StateScreen, widgetComponent } from '../../src/ui/screen.js';
import { createFakePi, createContext, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, type InertSandbox } from './helpers/fake-pi.js';

const draft = {question:'Inspect the fixture boundary',surface:'fixture',risk:'policy',role:'general',roleReason:'Controlled local fixture observation',expectedTrue:'Specific observable support',expectedFalse:'Specific contradictory support',stopCondition:'Stop after the bounded observation',evidenceIds:[],prerequisites:[],skills:[],methodReason:'Controlled inert fixture, not security proof'};
async function fixture(work: (h: any) => Promise<void>, args = '') {
  const root = await mkdtemp(join(tmpdir(), 'p2o-visibility-'));
  await mkdir(join(root, 'source'));
  const pi = createFakePi(), ctx = createContext({cwd:root}), herdr = createSimpleHerdr(), sandboxes:InertSandbox[] = [];
  registerP2O(pi.pi, {extensionPath:EXTENSION_PATH,controlRoot:join(root,'control'),settingsPath:join(root,'nonexistent-test-settings.json'),herdr:herdr.client,createSandbox:sandboxFactory(sandboxes)});
  const command = (s:string) => pi.commands.get('p2o').handler(s,ctx.ctx);
  const call = (s:string,p={}) => pi.tools.get(s).execute('call',p,undefined,undefined,ctx.ctx);
  const path = async () => join(root,'control',(await readdir(join(root,'control')))[0],'records.sqlite');
  const screen = () => ctx.screens.at(-1).render(150).join('\n');
  try {await command(`--target ./source ${args}`);expect(pi.messages).toHaveLength(1);await work({root,pi,ctx,herdr,sandboxes,command,call,path,screen});}
  finally {await command('stop');await rm(root,{recursive:true,force:true});}
}

describe('model-free assessment visibility (canonical runtime + legacy reader)' , () => {
  it('parses human navigation, strict cursors/IDs and no authority options', () => {
    expect(parseStateCommand('status')).toEqual({action:'status'});
    expect(parseStateCommand('log 0')).toEqual({action:'log',cursor:0});
    expect(parseStateCommand('--target ./source')).toBeUndefined();
    for (const s of ['status --resume','log -1','log 1.5','log 9007199254740992','report auto']) expect(() => parseStateCommand(s)).toThrow();
  });
  it('renders narrow Unicode views, scrolling, resize and close', () => {
    let closed = 0;
    const source = Array.from({length:45}, (_,i) => `${i} đọc nhận xét 🧪 漢字 é long line`);
    const screen = new StateScreen(source, () => {closed++;});
    for (const width of [1,8,20,80]) expect(screen.render(width).every(x => visibleWidth(x) <= width)).toBe(true);
    screen.render(80); screen.handleInput('\u001b[B');
    expect(screen.render(80)[0]).toContain('1 đọc');
    screen.invalidate(); expect(screen.render(8).every(x=>visibleWidth(x)<=8)).toBe(true);
    screen.handleInput('q');expect(closed).toBe(1);
    expect(widgetComponent(source.slice(0,3)).render(10).every(x=>visibleWidth(x)<=10)).toBe(true);
  });
  it('status/log/report never consume Planner signals, call a model or execute target work', async () => {
    await fixture(async h => {
      const before = (await h.call('p2o_loop',{action:'status'})).details;
      for (const s of ['status','log 0','report']) await h.command(s);
      const after = (await h.call('p2o_loop',{action:'status'})).details;
      expect(after).toEqual(before);
      expect(h.pi.messages).toHaveLength(1);expect(h.pi.customMessages).toHaveLength(0);
      expect(h.herdr.calls).toHaveLength(0);expect(h.sandboxes[0].commands).toHaveLength(0);
      expect(h.pi.entries).toHaveLength(3);
      expect(h.pi.entries.every((e:any)=>e.customType==='p2o-state-view' && !('lines' in e.data))).toBe(true);
    });
  });
  it('empty state and retention warning do not pretend safety, persistence or phase completion', async () => {
    await fixture(async h => {
      await h.command('status');
      const text=h.screen();
      expect(text).toContain('Empty findings/queue do not mean');
      expect(text).toContain('Durable-local knowledge');
      expect(text).toContain('Reported ≠ reviewed');
      expect(text).toContain('manual/shared');
    });
  });
  it('returns durable note IDs/sequence and resolves exactly the same ledger row', async () => {
    await fixture(async h => {
      const ack=(await h.call('p2o_note',{kind:'note',text:'Observed bounded fixture'})).details;
      expect(ack.recordId).toMatch(/^[a-f0-9-]{36}$/);expect(ack.sequence).toBeGreaterThan(0);expect(ack.storeVersion).toBe(7);
      const result=await h.call('p2o_ledger',{id:ack.recordId});
      expect(result.details.records).toHaveLength(1);expect(result.details.records[0].text).toBe('Observed bounded fixture');
      await h.command('log 0');expect(h.screen()).toContain(ack.recordId);
    });
  });
  it('broker notes return server-produced IDs and cannot forge owner attribution', async () => {
    await fixture(async h => {
      const spawn=(await h.call('p2o_delegate',{focus:'one fixture',task:'Observe the inert fixture only'})).details;
      const {readFile}=await import('node:fs/promises');
      const ticket=JSON.parse(await readFile(join(await h.path(),'..',`ticket-${spawn.workerId}.json`),'utf8'));
      const c=new BrokerClient(ticket.socket,ticket.token);
      try {
        const ack=await c.request<{recordId:string}>('note',{kind:'note',text:'Worker observation',by:'owner',runId:'foreign'});
        const row=(await h.call('p2o_ledger',{id:ack.recordId})).details.records[0];
        expect(row.by).toBe(spawn.workerId);expect(row.runId).toBe(ticket.runId);
      } finally {c.close();}
    });
  });
  it('reported handoff remains awaiting review, not a verified finding or completed goal', async () => {
    await fixture(async h => {
      const task=(await h.call('p2o_task_create',{draft})).details;
      const spawn=(await h.call('p2o_delegate',{focus:'one fixture',task:task.question,taskId:task.id})).details;
      const {readFile}=await import('node:fs/promises');
      const ticket=JSON.parse(await readFile(join(await h.path(),'..',`ticket-${spawn.workerId}.json`),'utf8'));
      const c=new BrokerClient(ticket.socket,ticket.token);
      try {await c.request('report',{report:{summary:'Bounded handoff, not proof',confidence:'low',outcome:'completed'}});} finally {c.close();}
      await h.command('heads task 0 20 reported');expect(h.screen()).toContain(task.id);expect(h.screen()).toContain('[reported]');
      await h.command(`show task ${task.id}`);expect(h.ctx.screens.at(-1).render(4000).join('\n')).toContain(draft.question);
      await h.command('status');expect(h.screen()).toContain('awaiting-review 1');expect(h.screen()).toContain('closed 0');
      // planning_update.md P1.3: the pending-review count surfaces right after the title, not only buried in the task-count/attention lines.
      const statusLines=h.screen().split('\n');expect(statusLines.findIndex((line:string)=>line.includes('⚠ 1 worker report awaiting Planner review'))).toBeLessThan(statusLines.findIndex((line:string)=>line.startsWith('Tasks ')));
    });
  });
  it('paginates all history and labels counts as records, not unique tested cells', async () => {
    await fixture(async h => {
      for(let i=0;i<27;i++)await h.call('p2o_note',{kind:'observation',text:`marker-${i}`});
      await h.command('log 0');expect(h.screen()).toContain('Next: /p2o log 20');
      await h.command('log 20');expect(h.screen()).toContain('marker-26');
      await h.command('log 900');expect(h.ctx.notices.at(-1)).toContain('cursor');
    });
  });
  it('redacts secrets before canonical retention and terminal controls in UI', async () => {
    await fixture(async h => {
      const ack=(await h.call('p2o_note',{kind:'note',text:'password=fixture-secret \u001b[31m malicious'})).details;
      await h.command('log 0');expect(h.screen()).not.toContain('fixture-secret');expect(h.screen()).not.toContain('\u001b');
      const index=await readLedger(await h.path());expect(index.byId.get(ack.recordId)?.text).not.toContain('fixture-secret');
    });
  });
  it('RPC gets readable state without TUI dependency or model turns', async () => {
    await fixture(async h => {
      (h.ctx.ctx as any).mode='rpc';await h.command('status');
      expect(h.ctx.screens).toHaveLength(0);expect(h.ctx.notices.at(-1)).toContain('Tasks 0');expect(h.pi.messages).toHaveLength(1);
    });
  });
  it('updates the compact widget on commits, keeps other widgets and clears on stop', async () => {
    await fixture(async h => {
      h.ctx.widgets.set('other-extension', ['keep']);
      await h.call('p2o_task_create',{draft});await delay(80);
      expect(h.ctx.widgets.get('p2o-progress')({},{}).render(90).join('\n')).toContain('Queue:');
      expect(h.pi.messages).toHaveLength(1);
      await h.command('stop');await delay(80);
      expect(h.ctx.widgets.has('p2o-progress')).toBe(false);expect(h.ctx.widgets.get('other-extension')).toEqual(['keep']);
      await h.command('status');expect(h.screen()).toContain('HISTORICAL in-memory');expect(h.screen()).toContain('no active authority');
    });
  });
  it('does not scan the whole ledger for a widget only the TUI can show', async () => {
    const records = vi.spyOn(AssessmentStore.prototype, 'recordsSince');
    try {
      await fixture(async h => {
        (h.ctx.ctx as any).mode = 'rpc'; await delay(120); // let any scan scheduled while still in TUI mode finish
        records.mockClear();
        await h.call('p2o_note', { kind: 'observation', text: 'rpc-marker' }); await delay(120);
        expect(records).not.toHaveBeenCalled();
        (h.ctx.ctx as any).mode = 'tui';
        await h.call('p2o_note', { kind: 'observation', text: 'tui-marker' }); await delay(120);
        expect(records).toHaveBeenCalled();
        expect(h.ctx.widgets.get('p2o-progress')({}, {}).render(90).join('\n')).toContain('Queue:');
        expect(h.pi.messages).toHaveLength(1);
      });
    } finally { records.mockRestore(); }
  });
  it('paces the next widget scan by the measured cost of the last one without dropping the update', async () => {
    const original = AssessmentStore.prototype.recordsSince;
    const records = vi.spyOn(AssessmentStore.prototype, 'recordsSince').mockImplementation(function (this: AssessmentStore, ...args: Parameters<AssessmentStore['recordsSince']>) {
      const end = performance.now() + 40; while (performance.now() < end) { /* a deliberately slow ledger read */ }
      return original.apply(this, args);
    });
    try {
      await fixture(async h => {
        await h.call('p2o_note', { kind: 'observation', text: 'first' }); await delay(200); // first scan measures >= 40 ms
        const scans = records.mock.calls.length;
        await h.call('p2o_note', { kind: 'observation', text: 'second' }); await delay(100);
        expect(records.mock.calls.length, 'a slow scan must delay the next one').toBe(scans);
        for (let attempt = 0; attempt < 60 && records.mock.calls.length === scans; attempt += 1) await delay(50);
        expect(records.mock.calls.length, 'the delayed update must still be delivered').toBeGreaterThan(scans);
        expect(h.pi.messages).toHaveLength(1);
      });
    } finally { records.mockRestore(); }
  });
  it('keeps the widget current through a storm of semantic state in manual mode with no model message, while event-driven coalesces the same storm into one wake', async () => {
    const plan = (title: string) => ({ title, status: 'active', reason: 'Explicit bounded denominator for the storm fixture', exclusions: ['No undeclared actors'], unknownScope: ['Deployment parity is unknown'] });
    const storm = async (h: any) => { // 8 live plans (distinct semantic events) plus 30 revisions that coalesce onto them, plus 40 plain committed notes
      const plans: Array<{ id: string; revision: number }> = [];
      for (let i = 0; i < 8; i++) { const created = (await h.call('p2o_coverage_plan', {plan: plan(`Storm plan ${i}`) })).details; plans.push({ id: created.id, revision: created.revision }); }
      for (let n = 0; n < 30; n++) { const entry = plans[n % plans.length], revised = (await h.call('p2o_coverage_plan', {id: entry.id, revision: entry.revision, plan: plan(`Storm plan revision ${n}`) })).details; entry.revision = revised.revision; }
      for (let i = 0; i < 40; i++) await h.call('p2o_note', { kind: 'observation', text: `storm-note-${i}` });
      await delay(300);
    };
    await fixture(async h => {
      await storm(h);
      const widget = h.ctx.widgets.get('p2o-progress')({}, {}).render(120).join('\n');
      expect(Number(/records @(\d+)/.exec(widget)?.[1]), 'the widget follows every committed row').toBeGreaterThanOrEqual(78);
      expect(h.pi.messages, 'a manual run never spends a model request on committed state').toHaveLength(1);
      expect(h.sandboxes.flatMap((s: InertSandbox) => s.commands)).toEqual([]);
      expect((await h.call('p2o_loop', { action: 'status' })).details).toMatchObject({ mode: 'manual', rounds: 0, pendingEvents: 8 }); // retained for inspection, never consumed by a wake
    });
    await fixture(async h => {
      await storm(h);
      expect(h.pi.messages, 'one coalesced reservation, not one per event').toHaveLength(2);
      expect((await h.call('p2o_loop', { action: 'status' })).details).toMatchObject({ mode: 'event-driven', rounds: 1 });
    }, '--loop event-driven');
  });
  it('flags corrupt/uncommitted state and never grants authority through navigation', async () => {
    await fixture(async h => {
      await appendRecord(await h.path(),{at:new Date().toISOString(),by:'owner',kind:'report_part',text:'Controlled uncommitted fragment',data:{reportId:'missing-manifest',part:0,value:'{}',sha256:'0'.repeat(64),redacted:true}});await h.command('status');
      expect(h.screen()).toContain('INCOMPLETE');expect(h.pi.messages).toHaveLength(1);
      expect(h.pi.active).toContain('p2o_shell');
    });
  });
  it('does not restore history or authority from a fresh extension instance', async () => {
    await fixture(async h => {
      await h.command('stop');
      const pi=createFakePi(),ctx=createContext({cwd:h.root});registerP2O(pi.pi,{extensionPath:EXTENSION_PATH});
      await pi.commands.get('p2o').handler('status',ctx.ctx);
      expect(ctx.notices.at(-1)).toContain('No active');expect(pi.messages).toHaveLength(0);
      expect((await pi.events.get('tool_call')![0]({toolName:'p2o_shell'},ctx.ctx)).block).toBe(true);
    });
  });
  it('observer failure cannot mask commit and failed write emits no commit notification', async () => {
    const root=await mkdtemp(join(tmpdir(),'p2o-observe-')),path=join(root,'records.jsonl');let calls=0;
    const off=observeRecords(path,()=>{calls++;throw Error('render failed');});
    try {
      const ack=await appendRecord(path,{at:new Date().toISOString(),by:'owner',kind:'note',text:'committed'});
      expect((await readLedger(path)).byId.has(ack.recordId)).toBe(true);expect(calls).toBe(1);
      await expect(appendRecord(path,{at:'now',by:'owner',kind:'note',text:'x'.repeat(20000)})).rejects.toThrow('too large');expect(calls).toBe(1);
      off();await appendRecord(path,{at:'now',by:'owner',kind:'note',text:'after unsubscribe'});expect(calls).toBe(1);
    } finally {off();await rm(root,{recursive:true,force:true});}
  });
});
