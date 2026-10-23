import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, InertSandbox, type FakePi } from './helpers/fake-pi.js';

interface Harness {
  root: string; pi: FakePi; sandboxes: InertSandbox[]; herdr: ReturnType<typeof createSimpleHerdr>;
  start: (args?: string, confirm?: boolean) => Promise<ReturnType<typeof createContext>>;
  call: (name: string, params?: any, ctx?: any) => Promise<any>;
  emit: (event: string, payload?: any, ctx?: any) => Promise<any>;
  command: (args: string, ctx?: any) => Promise<void>;
  runDir: () => Promise<string>;
  tickets: () => Promise<string[]>;
  records: () => Promise<any[]>;
  readonly contexts: ReturnType<typeof createContext>;
}

async function harness(options: { settings?: unknown; herdrAvailable?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'p2o-owner-'));
  await mkdir(join(root, 'repo'), { recursive: true });
  const settingsPath = join(root, 'settings.json');
  if (options.settings) await writeFile(settingsPath, JSON.stringify(options.settings), { mode: 0o600 });
  const pi = createFakePi();
  const sandboxes: InertSandbox[] = [];
  const herdr = createSimpleHerdr({ available: options.herdrAvailable ?? true });
  registerP2O(pi.pi, {
    createSandbox: sandboxFactory(sandboxes), herdr: herdr.client,
    settingsPath, controlRoot: join(root, 'control'), extensionPath: EXTENSION_PATH,
  });
  let context: ReturnType<typeof createContext> | undefined;
  const contextFor = () => (context ??= createContext({ cwd: root }));
  const runDirectory = async () => {
    const entries = await readdir(join(root, 'control'));
    const created = entries.find(name => name.startsWith('p2o-run-'));
    if (!created) throw new Error('no control directory was created');
    return join(root, 'control', created);
  };
  return {
    root, pi, sandboxes, herdr, runDir: runDirectory,
    async start(args = '--target ./repo', confirm = true) {
      context = createContext({ cwd: root, confirm });
      await pi.commands.get('p2o').handler(args, context.ctx);
      if (pi.messages.length === 0 && context.notices.length) throw new Error(`start failed: ${context.notices.at(-1)}`);
      return context;
    },
    call(name, params = {}, ctx) {
      return pi.tools.get(name).execute('call', params, undefined, undefined, ctx ?? contextFor().ctx);
    },
    async emit(event, payload = {}, ctx) {
      const handlers = pi.events.get(event) ?? [];
      let result: unknown;
      for (const handler of handlers) result = await handler(payload, ctx ?? contextFor().ctx);
      return result;
    },
    command(args: string, ctx?: any) { return pi.commands.get('p2o').handler(args, ctx ?? contextFor().ctx); },
    get contexts() { return contextFor(); },
    async tickets() { return (await readdir(await runDirectory())).filter(name => name.startsWith('ticket-')); },
    async records(): Promise<any[]> {
      const {readLedger} = await import('../../src/records.js');
      return (await readLedger(join(await runDirectory(),'records.sqlite'))).records;
    },
  };
}

describe('owner role', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.command('stop'); await rm(h.root, { recursive: true, force: true }); });

  it('registers the owner and worker tools plus one command, and does no work before the command', () => {
    expect([...h.pi.tools.keys()].sort()).toEqual(['p2o_artifact', 'p2o_candidate', 'p2o_capture', 'p2o_case', 'p2o_coverage', 'p2o_delegate', 'p2o_finish', 'p2o_graph', 'p2o_http', 'p2o_lab', 'p2o_ledger', 'p2o_loop', 'p2o_net', 'p2o_note', 'p2o_plan', 'p2o_report', 'p2o_request_subtask', 'p2o_research', 'p2o_shell', 'p2o_skill_list', 'p2o_skill_read', 'p2o_state', 'p2o_surface', 'p2o_task', 'p2o_workers']);
    expect(h.pi.messages).toEqual([]);
    expect(h.sandboxes).toEqual([]);
    expect([...h.pi.commands.keys()]).toEqual(['p2o']);
    expect(h.pi.flags['p2o-worker']).toBeDefined();
  });

  it('confirms once, names the delegation budget, and hands the task to the current agent', async () => {
    const started = await h.start();
    expect(started.dialogs).toEqual(['Start authorized assessment?']);
    expect(started.dialogs.join(' ')).toContain('Start authorized assessment');
    expect(h.pi.messages).toHaveLength(1);
    expect(h.pi.messages[0]).toContain('Begin the confirmed assessment');
    expect(h.pi.messages[0].length).toBeLessThan(200);
    expect(h.pi.messages[0]).not.toMatch(/p2o_|P2O ASSESSMENT|DELEGATION/);
    const event = { systemPrompt: 'BASE PROMPT', systemPromptOptions: { sections: { other: 'KEEP OTHER GUIDANCE' } as Record<string, string> } };
    expect(await h.emit('before_agent_start', event)).toBeUndefined();
    expect(event.systemPromptOptions.sections.p2o_assessment).toContain('P2O ASSESSMENT');
    expect(event.systemPromptOptions.sections.p2o_assessment).toContain('Only the human can change confirmed scope');
    expect(event.systemPromptOptions.sections.p2o_assessment).toContain('DELEGATION');
    expect(event.systemPromptOptions.sections.other).toBe('KEEP OTHER GUIDANCE');
    expect(h.sandboxes[0].stopCount).toBe(0);
    expect(h.pi.active).toEqual(['p2o_task', 'p2o_plan', 'p2o_case', 'p2o_coverage', 'p2o_ledger', 'p2o_state', 'p2o_graph', 'p2o_artifact', 'p2o_skill_list', 'p2o_skill_read', 'p2o_research', 'p2o_candidate', 'p2o_lab', 'p2o_note', 'p2o_surface', 'p2o_delegate', 'p2o_workers', 'p2o_loop', 'p2o_finish']);
    expect(await h.tickets()).toEqual([]);
  });

  it('replaces only its own prompt section and clears active policy after finish, stop or replay', async () => {
    const options = { sections: { p2o_assessment: 'STALE', other: 'UNRELATED' } as Record<string, string>, selectedTools: ['read'], toolGuidelines: { read: ['READ_GUIDE'] } };
    const event = { systemPrompt: 'PI BASE PROMPT', systemPromptOptions: options };
    await h.emit('before_agent_start', event);
    expect(options.sections).toEqual({ other: 'UNRELATED' });
    await h.start('--target ./repo --solo');
    await h.emit('before_agent_start', event);
    const active = options.sections.p2o_assessment;
    expect(active).not.toMatch(/\bp2o_[a-z_]+\b|nextOffset|supersedes=|policyBasis=/);
    await h.emit('before_agent_start', event);
    expect(options.sections.p2o_assessment).toBe(active); // replacement, not appended copies
    expect(options.selectedTools).toEqual(['read']);
    expect(options.toolGuidelines).toEqual({ read: ['READ_GUIDE'] });
    expect(event.systemPrompt).toBe('PI BASE PROMPT');
    await h.call('p2o_finish');
    await h.emit('before_agent_start', event);
    expect(options.sections.p2o_assessment).toContain('P2O FINALIZATION');
    expect(options.sections.p2o_assessment).not.toContain('P2O ASSESSMENT');
    await h.emit('agent_before_settle', { outcome: 'completed' });
    await h.emit('before_agent_start', event);
    expect(options.sections).toEqual({ other: 'UNRELATED' });
    await h.start('--target ./repo --solo');
    await h.emit('before_agent_start', event);
    await h.command('stop');
    await h.emit('before_agent_start', event);
    expect(options.sections).toEqual({ other: 'UNRELATED' });
  });

  it('rejects unknown/mismatched methods and changed hashes; URL methods cannot unlock transport', async () => {
    await h.start('--target https://example.com');
    const draft:any={question:'What can the approved anonymous baseline establish?',surface:'/surface',risk:'authorization',role:'general',roleReason:'Lead chose a bounded source-policy question',expectedTrue:'Known permitted observation is available',expectedFalse:'Required identity contrast is unavailable',stopCondition:'Stop at the missing transport prerequisite',evidenceIds:[],prerequisites:[],skills:['web-object-authorization'],methodReason:'Trace policy before selecting an unavailable identity comparison'};
    await expect(h.call('p2o_task',{action:'create',draft:{...draft,workflow:'not-a-workflow'}})).rejects.toThrow('WORKFLOW_UNKNOWN');
    await expect(h.call('p2o_task',{action:'create',draft:{...draft,skills:['not-a-skill']}})).rejects.toThrow(/SKILL_UNKNOWN|unknown/i);
    const blocked=(await h.call('p2o_task',{action:'create',draft:{...draft,workflow:'controlled-identity-comparison',missingPrerequisites:['Authenticated comparison transport is not authorized in this URL scope']}})).details;
    expect(blocked.status).toBe('blocked');await expect(h.call('p2o_delegate',{focus:'blocked',task:'Do not broaden access',taskId:blocked.id})).rejects.toThrow('available');
    expect(h.herdr.calls.filter(c=>c.op==='start')).toHaveLength(0);expect(h.pi.active).not.toContain('agent_browser');
    const task=(await h.call('p2o_task',{action:'create',draft:{...draft,surface:'/other'}})).details;
    const {appendRecord}=await import('../../src/records.js');
    await appendRecord(join(await h.runDir(),'records.sqlite'),{at:'2030',runId:task.runId,by:'owner',kind:'task',text:'Controlled hash fault',supersedes:task.recordId,data:{task:{...task,revision:task.revision+1,method:{...task.method,skills:task.method.skills.map((s:any)=>({...s,sha256:'0'.repeat(64)}))}}}});
    await expect(h.call('p2o_delegate',{focus:'fault',task:'Do not use stale method',taskId:task.id})).rejects.toThrow('TASK_METHOD_STALE');
    expect(h.herdr.calls.filter(c=>c.op==='start')).toHaveLength(0);
    await h.command('stop');
  });

  it('lets a recon task omit roleReason/expectedTrue/expectedFalse/stopCondition/methodReason, but still requires them for every other role (planning_update.md P1.1)', async () => {
    await h.start('--target ./repo --solo');
    const lean: any = { question: 'What does this endpoint expose?', surface: '/surface', risk: 'mapping', role: 'recon', evidenceIds: [], prerequisites: [] };
    const recon = (await h.call('p2o_task', { action: 'create', draft: lean })).details;
    expect(recon.roleReason).toBe(''); expect(recon.expectedTrue).toBe(''); expect(recon.expectedFalse).toBe(''); expect(recon.stopCondition).toBe(''); expect(recon.method.reason).toBe('');
    await expect(h.call('p2o_task', { action: 'create', draft: { ...lean, role: 'general' } })).rejects.toThrow('Invalid task roleReason');
    await h.command('stop');
  });

  it('records a cheap recon surface-inventory entry and flags a normalized-key duplicate without blocking it (planning_update.md P1.2)', async () => {
    await h.start('--target ./repo --solo');
    const first = (await h.call('p2o_surface', { component: 'Login API', entryPoint: '/api/login' })).details;
    expect(first.duplicate).toBe(false);
    const again = (await h.call('p2o_surface', { component: '  login api  ', entryPoint: 'API/Login' })).details;
    expect(again.duplicate).toBe(false); // entryPoint is case/whitespace-sensitive beyond NFC/trim/lowercase, so a differently-cased path is a distinct key
    const repeat = (await h.call('p2o_surface', { component: '  LOGIN api', entryPoint: '/api/login' })).details;
    expect(repeat.duplicate).toBe(true); expect(repeat.priorRecordId).toBe(first.recordId);
    await h.command('stop');
  });

  it('nudges the owner when a worker report lands in manual loop mode, naming the pending-review count (planning_update.md P1.3)', async () => {
    await h.start('--target ./repo');
    const draft: any = { question: 'What does this surface expose?', surface: '/surface', risk: 'mapping', role: 'recon', evidenceIds: [], prerequisites: [] };
    const task = (await h.call('p2o_task', { action: 'create', draft })).details;
    const worker = (await h.call('p2o_delegate', { focus: 'recon', task: 'map the surface', taskId: task.id })).details;
    const { BrokerClient } = await import('../../src/broker.js');
    const ticket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${worker.workerId}.json`), 'utf8'));
    const client = new BrokerClient(ticket.socket, ticket.token);
    await client.request('report', { report: { summary: 'bounded recon packet', confidence: 'low' } });
    client.close();
    expect(h.contexts.notices.at(-1)).toContain('1 worker report awaiting Planner review');
  });

  it('maintains a per-surface recon/discovery/independent-validation loop, rejects stale conclusions and freezes before cleanup', async () => {
    await h.start('--target ./repo --export');
    const makeDraft = (role: string, prerequisites: any[] = [], validationOf?: string) => ({question:'Which actor reaches the controlled consumer?',surface:'/surface',risk:'authorization',role,
      roleReason:'Lead selected this role from the current unanswered question',expectedTrue:'Known baseline reaches the intended consumer',expectedFalse:'Contrasting observation refutes the boundary hypothesis',
      stopCondition:'Stop after the contrast, a missing prerequisite or explicit owner withdrawal',evidenceIds:[],prerequisites,validationOf,methodReason:'Bounded offline method; no deployment claims'});
    const recon = (await h.call('p2o_task',{action:'create',draft:makeDraft('recon')})).details;
    await expect(h.call('p2o_task',{action:'start',id:recon.id})).rejects.toThrow('PLANNER_ONLY');
    const reconWorker = (await h.call('p2o_delegate',{focus:'controlled-recon',task:'Observe the bounded fixture',taskId:recon.id})).details;
    const {BrokerClient:ReconClient}=await import('../../src/broker.js');
    const rt=JSON.parse(await readFile(join(await h.runDir(),`ticket-${reconWorker.workerId}.json`),'utf8'));
    const rc=new ReconClient(rt.socket,rt.token);
    const observation=await rc.request('exec',{command:'printf controlled-baseline'});
    await rc.request('report',{report:{summary:'Bounded recon packet',evidence:[observation.evidenceId],confidence:'low'}});rc.close();
    const lead={details:{evidenceId:observation.evidenceId}};
    const accepted = (await h.call('p2o_task',{action:'review',id:recon.id,reason:'Lead accepts this bounded source observation, not deployment proof',evidenceIds:[lead.details.evidenceId]})).details;
    const discovery = (await h.call('p2o_task',{action:'create',draft:makeDraft('discovery',[{taskId:recon.id,revision:accepted.revision}])})).details;
    const context = await h.emit('context',{messages:[{role:'compactionSummary',summary:'compact fixture',tokensBefore:1000,timestamp:0}]});
    expect(context.messages.filter((m:any)=>m.customType==='p2o_objective_state')).toHaveLength(1);
    expect(JSON.stringify(context.messages)).toContain(discovery.id);
    const a = (await h.call('p2o_delegate',{focus:'discovery',task:'Follow the owner-authored objective',taskId:discovery.id})).details;
    const {BrokerClient}=await import('../../src/broker.js');
    const connect = async(id:string) => {const t=JSON.parse(await readFile(join(await h.runDir(),`ticket-${id}.json`),'utf8'));return new BrokerClient(t.socket,t.token);};
    const first=await connect(a.workerId);
    const base={candidate:'controlled-gate',surface:'/surface',risk:'authorization',policyBasis:'boundary_invariant',expectedPolicy:'Fixture-only principal/consumer contract',negativeControls:[],limitations:'Inert receipts are mechanical metadata, not semantic security proof'};
    try {
      await expect(first.request('note',{kind:'task',text:'Forge owner state'})).rejects.toThrow('kind');
      const obs=await first.request('exec',{command:'printf observation'});
      const initial=(await first.request('candidate',{candidate:{...base,closure:'open_proof_gap',execution:'not_tested',proof:'static_trace',evidenceRefs:[obs.evidenceId]}})).value;
      await first.request('report',{report:{summary:'Discovery packet; source-only boundary remains unknown',evidence:[obs.evidenceId],confidence:'low',outcome:'completed'}});
      await expect(first.request('exec',{command:'true'})).rejects.toThrow('stopped');
      const reviewed=(await h.call('p2o_task',{action:'review',id:discovery.id,reason:'Lead accepts the packet for a contrasting validation question',evidenceIds:[obs.evidenceId]})).details;
      const validation=(await h.call('p2o_task',{action:'create',draft:makeDraft('validation',[{taskId:discovery.id,revision:reviewed.revision}],discovery.id)})).details;
      const b=(await h.call('p2o_delegate',{focus:'validation',task:'Follow the separate validation objective',taskId:validation.id})).details;
      const second=await connect(b.workerId);
      try {
        const probe=await second.request('exec',{command:'printf contrasting-observation'});
        const v=(await second.request('candidate',{candidate:{...base,closure:'confirmed',execution:'tested',proof:'offline_reproduction',evidenceRefs:[probe.evidenceId],supersedes:initial.id}})).value;
        const claim=(await h.call('p2o_candidate',{...base,closure:'confirmed',execution:'tested',proof:'offline_reproduction',evidenceRefs:[obs.evidenceId,probe.evidenceId],supersedes:v.id,independentEvidenceRef:probe.evidenceId})).details;
        const withdrawn=(await second.request('candidate',{candidate:{...base,closure:'open_proof_gap',execution:'not_tested',proof:'static_trace',evidenceRefs:[probe.evidenceId],supersedes:claim.id}})).value;
        await expect(h.call('p2o_candidate',{...base,closure:'confirmed',execution:'tested',proof:'offline_reproduction',evidenceRefs:[probe.evidenceId],supersedes:withdrawn.id,independentEvidenceRef:probe.evidenceId})).rejects.toThrow('own demonstrated claim');
        await second.request('report',{report:{summary:'Withdrawn conclusion; retain missing proof',confidence:'low',evidence:[probe.evidenceId],blocked:'Missing independent effect',openItems:['Controlled boundary remains a proof gap'],outcome:'prerequisite-blocked'}});
        await h.call('p2o_task',{action:'review',id:validation.id,reason:'Review accepts the observation only; withdrawn effect remains open',evidenceIds:[probe.evidenceId]});
      } finally {second.close();}
      const view=await h.call('p2o_workers',{cursor:0});expect(view.details.changes.total).toBeGreaterThan(0);expect(view.details.budgets.workerUsed).toBe(3); // Recon is now a worker, not Planner execution.
      const finish=await h.call('p2o_finish');expect(finish.details.report.complete).toBe(true);expect(finish.details.report.counts.reports).toBe(3);expect(finish.details.report.counts.open).toBeGreaterThan(0);
      const exported=JSON.parse(await readFile(finish.details.exportPath,'utf8'));expect(exported.manifest.report.version).toBe(finish.details.report.version);
      expect(exported.records.some((r:any)=>r.kind==='task')).toBe(true);
      expect(await h.emit('tool_call',{toolName:'p2o_task'})).toMatchObject({block:true});
      const after=await h.emit('context',{messages:context.messages});expect(after.messages.some((m:any)=>m.customType==='p2o_objective_state')).toBe(false);
    } finally {first.close();}
  });

  it('accepts only immutable operator-selected images and forwards the exact binding to workers', async () => {
    h.pi.flags['p2o-image'] = 'sha256:' + 'a'.repeat(64);
    await h.start();
    await h.call('p2o_delegate', { focus: 'image-binding', task: 'read source', role: 'general', model: 'openai-codex-account-3/gpt-6.1-sol', thinking: 'xhigh' });
    const args = h.herdr.calls.find(call => call.op === 'start')!.args!;
    expect(args[args.indexOf('--p2o-image') + 1]).toBe(h.pi.flags['p2o-image']);
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-6.1-sol');
    expect(args[args.indexOf('--provider') + 1]).toBe('openai-codex-account-3');
    expect(args[args.indexOf('--thinking') + 1]).toBe('xhigh');
    const ticket = JSON.parse(await readFile(join(await h.runDir(), (await h.tickets())[0]), 'utf8'));
    expect(ticket.image).toBe(h.pi.flags['p2o-image']);
    await h.command('stop');
    h.pi.flags['p2o-image'] = 'image:latest';
    await h.command('--target ./repo');
    expect(h.contexts.notices.at(-1)).toContain('immutable');
  });

  it('gives an exploitation task 400 brokered commands, honours a declared budget, and leaves research work at 200', async () => {
    // P14.11: the ticket is what the broker enforces, so the allowance class has to reach it.
    const ticketBudget = async (h: any) => JSON.parse(await readFile(join(await h.runDir(), (await h.tickets())[0]), 'utf8'));
    const delegated = async (h: any, extra: Record<string, unknown> = {}) => {
      const asset = (await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /fixture' } }] } })).details.acks[0];
      // P14.5: an exploitation task has to cite the primitive it takes further, so the fixture records one first.
      const primitive = (await h.call('p2o_candidate', { candidate: 'fixture-primitive', surface: '/fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'not_tested',
        proof: 'static_trace', evidenceRefs: [], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared fixture boundary', limitations: 'Nothing executed yet' })).details;
      const task = (await h.call('p2o_task', { action: 'create', draft: {
        question: 'Does the recorded primitive reach the effect the chain claims?', surface: '/fixture', risk: 'authorization', role: 'exploit',
        roleReason: 'Chain frontier step with every capability already demonstrated', expectedTrue: 'The step runs and is recorded as confirmed and tested',
        expectedFalse: 'The step is refused and the restriction is recorded as a gap', stopCondition: 'Stop after one bounded attempt', evidenceIds: [], prerequisites: [],
        methodReason: 'One bounded chain step against the recorded surface', skills: [],
        work: { assetRefs: [{ id: asset.entityId, revision: 1 }], questionKey: 'chain:fixture', policyKey: 'policy:fixture', actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'chain-step', purpose: 'exploitation', claimRefs: [primitive.id], ...extra },
        decision: { disposition: 'new', reason: 'First task that executes this chain step' },
        outputContract: { kind: 'validation', required: ['evidence', 'candidates'], partialAllowed: false, artifactPolicy: 'ids-only' },
      } })).details;
      await h.call('p2o_delegate', { focus: 'chain-step', task: 'Run the recorded chain step', taskId: task.id });
      return ticketBudget(h);
    };
    h = await harness();
    await h.start();
    expect(await delegated(h)).toMatchObject({ purpose: 'exploitation', commandBudget: 400 });
    await h.command('stop'); await rm(h.root, { recursive: true, force: true });

    h = await harness();
    await h.start();
    expect(await delegated(h, { budget: { commands: 60 } })).toMatchObject({ purpose: 'exploitation', commandBudget: 60 });
    await h.command('stop'); await rm(h.root, { recursive: true, force: true });

    // A validation task is research work: it keeps the recon allowance and asks for no wrap-up.
    h = await harness();
    await h.start();
    const asset = (await h.call('p2o_graph', { action: 'record', batch: { assets: [{ asset: { kind: 'endpoint', key: 'GET /fixture' } }] } })).details.acks[0];
    const discovery = (await h.call('p2o_task', { action: 'create', draft: {
      question: 'Which bounded observations describe the recorded fixture?', surface: '/fixture', risk: 'authorization', role: 'discovery',
      roleReason: 'Bounded enumeration of one recorded surface', expectedTrue: 'The enumeration returns the recorded observation set', expectedFalse: 'The enumeration returns nothing and the receipt says so',
      stopCondition: 'Stop after one bounded command', evidenceIds: [], prerequisites: [], methodReason: 'One bounded command against the recorded surface', skills: [],
      work: { assetRefs: [{ id: asset.entityId, revision: 1 }], questionKey: 'discover:fixture', policyKey: 'policy:fixture', actorContext: 'actor:fixture', tenantContext: 'tenant:fixture', methodFamily: 'output-observation', purpose: 'discovery' },
      decision: { disposition: 'new', reason: 'First bounded enumeration of the recorded surface' },
      outputContract: { kind: 'inventory', required: ['assets'], partialAllowed: false, artifactPolicy: 'ids-only' },
    } })).details;
    await h.call('p2o_delegate', { focus: 'surface-enumeration', task: 'Enumerate the recorded surface', taskId: discovery.id });
    expect(await ticketBudget(h)).toMatchObject({ purpose: 'discovery', commandBudget: 200 });
  });

  it('asks for confirmation with the worker plan, and declining starts nothing', async () => {
    h = await harness();
    const context = createContext({ cwd: h.root, confirm: false });
    await h.command('--target ./repo --workers 2 --max-depth 1', context.ctx);
    expect(h.sandboxes).toEqual([]); expect(h.pi.messages).toEqual([]);
    expect(context.dialogs).toEqual(['Start authorized assessment?']);
    expect(context.notices.at(-1)).toContain('Cancelled');
  });

  it('delegates a worker: mints a private ticket, starts a visible pi pane with the worker flag, and briefs it', async () => {
    await h.start();
    const result = await h.call('p2o_delegate', { focus: 'idor', task: 'Validate the idor claim', context: 'nothing known', role: 'validation', skills: ['exploitability-assessment'] });
    expect(result.details.workerId).toMatch(/^p2o-validation-[0-9a-f]{6}$/);
    expect(result.details.depth).toBe(1);
    const start = h.herdr.calls.find(call => call.op === 'start')!;
    expect(start.args).toContain('--p2o-worker');
    expect(start.args).toContain('--no-extensions');
    expect(start.args).toContain('--no-approve');
    expect(start.args?.[start.args.indexOf('-e') + 1]).toBe(EXTENSION_PATH);
    // A worker gets no skill index (it cannot read host files); the selected skill is inlined in the brief.
    expect(start.args).toContain('--no-skills');
    expect(start.args).toContain('--no-context-files');
    expect(start.args?.some(value => value.endsWith('exploitability-assessment'))).toBe(false);
    const ticketFiles = await h.tickets();
    expect(ticketFiles).toHaveLength(1);
    const ticket = JSON.parse(await readFile(join(await h.runDir(), ticketFiles[0]), 'utf8'));
    expect(ticket).toMatchObject({ depth: 1, role: 'validation', parentWorkerId: null, runId: expect.any(String) });
    expect(ticket.socket).toBe(join(await h.runDir(), 'sandbox.sock'));
    const briefing = h.herdr.calls.find(call => call.op === 'prompt')!;
    expect(briefing.text).toContain('FOCUS: idor');
    expect(briefing.text).toContain('background only');
    expect(briefing.text).toContain('p2o_report');
    expect(String(briefing.text)).toContain('== Given skills');
    expect(String(briefing.text)).toContain('exploitability-assessment');
    expect(String(briefing.text).toUpperCase()).toContain('EXPLOITABILITY');
    const records = await h.records();
    expect(records.some(entry => entry.kind === 'lifecycle' && String(entry.text).includes('delegated'))).toBe(true);
  });

  it('shows --avoid constraints in the confirm dialog and in every worker brief', async () => {
    const started = await h.start('--target ./repo --avoid "No payment flows" --avoid "Stay off /admin"');
    const dialog = started.confirmBodies.at(-1)!;
    expect(dialog).toContain('Operator constraints (sent to every worker as model-level guidance, not enforcement');
    expect(dialog).toContain('- No payment flows'); expect(dialog).toContain('- Stay off /admin');
    await h.call('p2o_delegate', { focus: 'idor', task: 'Validate the idor claim', context: 'nothing known', role: 'validation' });
    const brief = String(h.herdr.calls.find(call => call.op === 'prompt')!.text);
    expect(brief).toContain('OPERATOR CONSTRAINTS'); expect(brief).toContain('- "No payment flows"'); expect(brief).toContain('- "Stay off /admin"');
  });
  it('shows no constraints block in the dialog or the worker brief without --avoid', async () => {
    const started = await h.start();
    expect(started.confirmBodies.at(-1)).not.toContain('Operator constraints');
    await h.call('p2o_delegate', { focus: 'idor', task: 'Validate the idor claim', context: 'nothing known', role: 'validation' });
    expect(String(h.herdr.calls.find(call => call.op === 'prompt')!.text)).not.toContain('OPERATOR CONSTRAINTS');
  });
  it('shows the hybrid confirm dialog for a source-plus-origin target and mints worker tickets with kind hybrid and the origin (U10)', async () => {
    const started = await h.start('--target ./repo --origin https://example.com/app');
    const dialog = started.confirmBodies.at(-1)!;
    expect(dialog).toContain('Hybrid target: a bounded source copy');
    expect(dialog).toContain('https://example.com/app');
    expect(dialog).toContain('neither widens the other');
    await h.call('p2o_delegate', { focus: 'idor', task: 'Validate the idor claim', context: 'nothing known', role: 'validation' });
    const ticketFiles = await h.tickets();
    const ticket = JSON.parse(await readFile(join(await h.runDir(), ticketFiles[0]), 'utf8'));
    expect(ticket.target).toMatchObject({ kind: 'hybrid', origin: 'https://example.com', label: expect.stringContaining('https://example.com/app') });
  });

  it('refuses delegation when solo, capped, too deep, without the skill, or without Herdr', async () => {
    await h.start('--target ./repo --solo');
    await expect(h.call('p2o_delegate', { focus: 'x', task: 'y' })).rejects.toThrow(/DELEGATION_UNAVAILABLE/);
    await h.command('stop');

    h = await harness({ herdrAvailable: false });
    await h.start();
    await expect(h.call('p2o_delegate', { focus: 'x', task: 'y' })).rejects.toThrow(/DELEGATION_UNAVAILABLE/);
    const event = { systemPrompt: 'BASE', systemPromptOptions: { sections: {} as Record<string, string> } };
    await h.emit('before_agent_start', event);
    expect(event.systemPromptOptions.sections.p2o_assessment).toContain('Delegation is NOT available');
    await h.command('stop');

    h = await harness({ settings: { p2o: { maxWorkers: 1, maxDepth: 1 } } });
    await h.start();
    await expect(h.call('p2o_delegate', { focus: 'x', task: 'y', skills: ['not-a-skill'] })).rejects.toThrow(/SKILL_UNKNOWN/);
    await h.call('p2o_delegate', { focus: 'one', task: 'first' });
    await expect(h.call('p2o_delegate', { focus: 'two', task: 'second' })).rejects.toThrow(/DELEGATION_CAP/);
  });

  it('denies nested spawning even when requested by a worker and preserves attributed report state', async () => {
    h = await harness({ settings: { p2o: { maxWorkers: 2, maxDepth: 1 } } });
    await h.start();
    await h.call('p2o_delegate', { focus: 'recon', task: 'map the surface' });
    const workerId = h.herdr.calls.find(call => call.op === 'start')!.name!;
    const ticket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${workerId}.json`), 'utf8'));
    const { BrokerClient } = await import('../../src/broker.js');
    const client = new BrokerClient(ticket.socket, ticket.token, { connectMs: 2000, requestMs: 5000 });
    try {
      await expect(client.request('delegate', { focus: 'deep', task: 'nested work', role: 'validation' })).rejects.toThrow(/PLANNER_ONLY/);
      const view = await h.call('p2o_workers', {});
      expect(view.details.workers).toHaveLength(1);
      expect(view.details.workers[0]).toMatchObject({ workerId, status: 'working', depth: 1 });
      expect(view.details.workers[0].role).toBe('general');
      await client.request('note', { kind: 'observation', text: 'worker observed /x' });
      await client.request('report', { report: { summary: 'WORKER_SAYS_DONE', confidence: 'high', findings: ['maybe an idor'], evidence: ['cmd'], coverage: [{ surface: '/x', risk: 'rce', outcome: 'clean' }], openItems: ['no auth surface tested'] } });
      const after = await h.call('p2o_workers', {});
      expect(after.details.workers[0]).toMatchObject({ reported: true, confidence: 'high' });
      expect(after.content[0].text).toContain('WORKER_SAYS_DONE');
      // The report's coverage lands in the shared ledger for the owner.
      expect(after.details.coverage).toHaveLength(1);
      expect(after.details.coverage[0]).toMatchObject({ surface: '/x', risk: 'rce', outcome: 'clean', by: workerId });
      expect(after.details.open).toHaveLength(1);
      expect(after.content[0].text).toContain('coverage: 1');
    } finally { client.close(); }
  });

  it('persists a worker subtask proposal without spawning or accepting it even when depth allows', async () => {
    h = await harness({ settings: { p2o: { maxWorkers: 3, maxDepth: 2 } } });
    await h.start();
    await h.call('p2o_delegate', { focus: 'recon', task: 'map the surface' });
    const parentId = h.herdr.calls.find(call => call.op === 'start')!.name!;
    const parentTicket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${parentId}.json`), 'utf8'));
    const { BrokerClient } = await import('../../src/broker.js');
    const client = new BrokerClient(parentTicket.socket, parentTicket.token, { connectMs: 2000, requestMs: 5000 });
    try {
      await expect(client.request('delegate',{focus:'validate-idor',task:'Unaccepted follow-up'})).rejects.toThrow('PLANNER_ONLY');
      const proposal = (await client.request('request_subtask',{focus:'validate-idor',task:'Propose bounded validation',role:'validation'})).value;
      expect(proposal).toMatchObject({accepted:false,recordId:expect.any(String)});
      expect(h.herdr.calls.filter(call => call.op === 'start')).toHaveLength(1);
      expect((await h.tickets()).length).toBe(1);
      const records=await h.records();
      const record=records.find(r => r.id === proposal.recordId);
      expect(record).toMatchObject({by:parentId,workerId:parentId,kind:'open',data:{proposal:{role:'validation'}}});
      expect(records.filter(r => r.kind === 'task')).toHaveLength(3);
      const view = await h.call('p2o_workers',{});expect(view.details.workers).toHaveLength(1);
    } finally { client.close(); }
  });

  it('serializes parallel delegation so the worker cap and depth hold, and finish waits for in-flight spawns', async () => {
    h = await harness({ settings: { p2o: { maxWorkers: 1, maxDepth: 2 } } });
    await h.start();
    const [first, second] = await Promise.allSettled([
      h.call('p2o_delegate', { focus: 'one', task: 'first objective' }),
      h.call('p2o_delegate', { focus: 'two', task: 'second objective' }),
    ]);
    expect([first, second].filter(entry => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = [first, second].find(entry => entry.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/DELEGATION_CAP/);
    expect(h.herdr.calls.filter(call => call.op === 'start')).toHaveLength(1);
    expect(await h.tickets()).toHaveLength(1);
    // A finish issued while a spawn is still in flight must not report success for that worker.
    const spawning = h.call('p2o_delegate', { focus: 'late', task: 'races finish' });
    await expect(h.call('p2o_finish')).rejects.toThrow(/WORKERS_ACTIVE|DELEGATION_CAP|cap/);
    await spawning.catch(() => {});
  });

  it('reports a pane Herdr refused to close instead of claiming verified teardown', async () => {
    await h.start();
    await h.call('p2o_delegate', { focus: 'recon', task: 'map' });
    const workerId = h.herdr.calls.find(call => call.op === 'start')!.name!;
    const ticket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${workerId}.json`), 'utf8'));
    const { BrokerClient } = await import('../../src/broker.js');
    const client = new BrokerClient(ticket.socket, ticket.token, { connectMs: 2000, requestMs: 5000 });
    await client.request('report', { report: { summary: 'done', confidence: 'low' } });
    client.close();
    h.herdr.refuseClose();
    const finish = await h.call('p2o_finish', {});
    expect(finish.content[0].text).toContain('still present');
    expect(finish.details.panesClosed).toBe(0);
    expect(finish.details.unclosedPanes).toEqual([workerId]);
    expect(h.sandboxes[0].stopCount).toBe(1);
  });

  it('inlines the role default skill for a specialist and allows a skill-less general worker', async () => {
    h = await harness({ settings: { p2o: { maxWorkers: 2, maxDepth: 2 } } });
    await h.start();
    const specialist = await h.call('p2o_delegate', { focus: 'source', task: 'review it', role: 'discovery' });
    expect(specialist.details.role).toBe('discovery');
    const specialistBrief = String(h.herdr.calls.filter(call => call.op === 'prompt').at(-1)!.text);
    expect(specialistBrief).toContain('== Given skills');
    expect(specialistBrief).toContain('<source-code-auditing>');
    // A general worker is a valid skill-less worker: no skill section at all.
    await h.call('p2o_delegate', { focus: 'x', task: 'y', role: 'general' });
    const generalBrief = String(h.herdr.calls.filter(call => call.op === 'prompt').at(-1)!.text);
    expect(generalBrief).not.toContain('== Given skills');
    // An explicitly requested unknown skill is still refused before any pane is created.
    const panes = h.herdr.calls.filter(call => call.op === 'start').length;
    await expect(h.call('p2o_delegate', { focus: 'x', task: 'y', role: 'general', skills: ['not-a-skill'] })).rejects.toThrow(/SKILL_UNKNOWN|DELEGATION_CAP/);
    expect(h.herdr.calls.filter(call => call.op === 'start').length).toBe(panes);
  });

  it('steers a worker, refuses unknown ones, and stops one on request (p2o_workers action steer/stop, S2)', async () => {
    await h.start();
    await expect(h.call('p2o_workers', { action: 'steer', workerId: 'p2o-recon-000000', message: 'hi' })).rejects.toThrow(/WORKER_UNKNOWN/);
    await h.call('p2o_delegate', { focus: 'recon', task: 'map' });
    const workerId = h.herdr.calls.find(call => call.op === 'start')!.name!;
    await h.call('p2o_workers', { action: 'steer', workerId, message: 'narrow to /login only' });
    const steer = h.herdr.calls.filter(call => call.op === 'prompt').at(-1)!;
    expect(steer.text).toContain('steer from the assessment lead');
    expect(steer.text).toContain('narrow to /login only');
    const stopped = await h.call('p2o_workers', { action: 'stop', workerId, reason: 'objective met' });
    expect(stopped.details.status).toBe('done');
    expect(h.herdr.calls.some(call => call.op === 'close')).toBe(true);
    await expect(h.call('p2o_workers', { action: 'steer', workerId, message: 'again' })).rejects.toThrow(/WORKER_STOPPED/);
  });

  it('refuses to finish while a worker is still working, then cleans everything up', async () => {
    await h.start();
    await h.call('p2o_delegate', { focus: 'recon', task: 'map' });
    await expect(h.call('p2o_finish')).rejects.toThrow(/WORKERS_ACTIVE/);
    const workerId = h.herdr.calls.find(call => call.op === 'start')!.name!;
    const ticket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${workerId}.json`), 'utf8'));
    const { BrokerClient } = await import('../../src/broker.js');
    const client = new BrokerClient(ticket.socket, ticket.token, { connectMs: 2000, requestMs: 5000 });
    await client.request('report', { report: { summary: 'reported before finish', confidence: 'medium' } });
    client.close();
    await h.emit('agent_before_settle', { outcome: 'completed' });
    const finish = await h.call('p2o_finish', {});
    expect(finish.details.sandboxRemoved).toBe(true);
    expect(finish.content[0].text).toContain('Container removal verified');
    expect(h.sandboxes[0].stopCount).toBe(1);
    expect(h.herdr.calls.some(call => call.op === 'close')).toBe(true);
    expect((await readdir(join(h.root, 'control'))).filter(name => name.startsWith('p2o-run-'))).toEqual([]);
    // The gate holds through the final response, then ordinary tools come back.
    expect(await h.emit('tool_call', { toolName: 'bash' })).toMatchObject({ block: true });
    await expect(h.call('p2o_shell', { command: 'id' })).rejects.toThrow(/No active p2o assessment/);
    await h.emit('agent_before_settle', { outcome: 'completed' });
    expect(h.pi.active).toContain('bash');
    expect(await h.emit('tool_call', { toolName: 'bash' })).toBeUndefined();
  });

  it('blocks host, nested and other-extension tools while active, and no tool can reach the target after stop', async () => {
    await h.start('--target ./repo --solo');
    for (const toolName of ['read', 'bash', 'edit', 'write', 'codemode', 'herd_spawn', 'agent_browser']) {
      expect(await h.emit('tool_call', { toolName }), toolName).toMatchObject({ block: true });
    }
    expect(await h.emit('tool_call', { toolName: 'p2o_shell', input: { command: 'id' } })).toBeUndefined();
    expect(await h.emit('tool_call', { toolName: 'p2o_report' })).toMatchObject({ block: true });
    await expect(h.emit('user_bash')).rejects.toThrow(/Host shell is blocked/);
    await h.call('p2o_shell', { command: 'id -u' });
    expect(h.sandboxes[0].commands).toEqual([{ command: 'id -u', workdir: '/work', timeout:0 }]);
    await h.command('stop');
    await expect(h.call('p2o_shell', { command: 'id' })).rejects.toThrow(/No active p2o assessment/);
    expect(h.pi.active).toContain('bash');
  });

  it('records owner notes, requires coverage fields, and refuses nonsense kinds', async () => {
    await h.start();
    await h.call('p2o_note', { kind: 'note', text: 'recon started' });
    await expect(h.call('p2o_note', { kind: 'coverage', text: 'clean' })).rejects.toThrow(/needs surface, risk and outcome/);
    await h.call('p2o_note', { kind: 'coverage', text: 'clean surface', surface: '/x', risk: 'sqli', outcome: 'clean', refs: ['record-1'] });
    const records = await h.records();
    expect(records.map(entry => entry.kind)).toContain('note');
    expect(records.find(entry => entry.kind === 'coverage')).toMatchObject({ surface: '/x', risk: 'sqli', outcome: 'clean', by: 'owner' });
    expect(await h.tickets()).toEqual([]);
  });

  it('keeps the gate when cleanup cannot be verified and lets /p2o stop retry', async () => {
    await h.start();
    await h.call('p2o_delegate', { focus: 'recon', task: 'map' });
    const workerId = h.herdr.calls.find(call => call.op === 'start')!.name!;
    const ticket = JSON.parse(await readFile(join(await h.runDir(), `ticket-${workerId}.json`), 'utf8'));
    const { BrokerClient } = await import('../../src/broker.js');
    const client = new BrokerClient(ticket.socket, ticket.token, { connectMs: 2000, requestMs: 5000 });
    await client.request('report', { report: { summary: 'done', confidence: 'low' } });
    client.close();
    h.sandboxes[0].cleanupFailure = true;
    await h.command('stop');
    expect(h.contexts.notices.at(-1)).toContain('cleanup not verified');
    expect(await h.emit('tool_call', { toolName: 'bash' })).toMatchObject({ block: true });
    expect(h.sandboxes[0].stopCount).toBe(1);
    // The retry must actually run cleanup again, not return early and claim success.
    h.sandboxes[0].cleanupFailure = false;
    await h.command('stop');
    expect(h.sandboxes[0].stopCount).toBe(2);
    expect(h.contexts.notices.at(-1)).toContain('sandbox removal verified');
    expect(h.pi.active).toContain('bash');
  });

  it('blocks automatic scheduling on provider failure, cleans on explicit stop/navigation, and denies replay', async () => {
    await h.start();
    await h.emit('agent_before_settle', { outcome: 'error' });
    expect(h.sandboxes[0].stopCount).toBe(0);
    expect((await h.call('p2o_loop',{action:'status'})).details.state).toBe('blocked');
    await expect(h.call('p2o_delegate',{focus:'retry',task:'No unattended replay'})).rejects.toThrow('LOOP_PAUSED');
    await h.command('stop');expect(h.sandboxes[0].stopCount).toBe(1);expect(h.pi.active).toContain('bash');

    h = await harness();
    await h.start();
    const leaving = await h.emit('session_before_switch');
    expect(leaving).toBeUndefined();
    expect(h.sandboxes[0].stopCount).toBe(1);

    // A fresh process never activates a run from history, and stale p2o tools stay blocked.
    h = await harness();
    await h.emit('session_start', {});
    expect(h.pi.active).not.toContain('p2o_shell');
    expect(await h.emit('tool_call', { toolName: 'p2o_shell' })).toMatchObject({ block: true });
    expect(await h.emit('tool_call', { toolName: 'p2o_delegate' })).toMatchObject({ block: true });
  });

  it('treats fork and tree navigation like a session switch: authority closes before the branch changes and nothing is restored', async () => {
    for (const event of ['session_before_fork', 'session_before_tree'] as const) {
      h = await harness(); await h.start();
      expect(h.pi.active).not.toContain('bash');
      expect(await h.emit(event)).toBeUndefined(); // navigation is allowed once cleanup is verified
      expect(h.sandboxes[0].stopCount, event).toBe(1);
      expect(h.pi.active, event).toContain('bash'); expect(await h.emit('tool_call', { toolName: 'p2o_shell' })).toMatchObject({ block: true });
      await expect(h.call('p2o_shell', { command: 'id' })).rejects.toThrow(/No active p2o assessment/);
      h = await harness(); await h.start(); h.sandboxes[0].cleanupFailure = true;
      expect(await h.emit(event), `${event} must not leave while teardown is unverified`).toMatchObject({ cancel: true });
      h.sandboxes[0].cleanupFailure = false; await h.command('stop');
    }
  });
  it('materializes a shipped skill script into the caller\'s own scratch and reports the package hash (P14.7)', async () => {
    await h.start();
    const { sha256Hex } = await import('../../src/validate.js');
    const packageBytes = await readFile(join(EXTENSION_PATH, '..', '..', '..', 'skills/exploit-design/scripts/payload-replay.py'));
    const result = (await h.call('p2o_skill_read', { id: 'exploit-design:payload-replay', materialize: true })).details as { path: string; sha256: string; bytes: number };
    expect(result.path).toBe('/work/owner/skills/exploit-design-payload-replay.py');
    expect(result.sha256).toBe(sha256Hex(packageBytes));
    expect(result.bytes).toBe(packageBytes.length);
    const sandbox = h.sandboxes[0];
    expect(sandbox.writes).toHaveLength(1);
    expect(sandbox.writes[0]).toMatchObject({ path: 'skills/exploit-design-payload-replay.py', workdir: '/work/owner', bytes: packageBytes.length, mode: 0o500 });
    // The document is still readable as text; materializing is a copy, not a replacement for reading.
    expect((await h.call('p2o_skill_read', { id: 'exploit-design:effect-ladder' })).details).toMatchObject({ id: 'exploit-design:effect-ladder' });
    await expect(h.call('p2o_skill_read', { id: 'exploit-design', materialize: true })).rejects.toThrow(/Only a registered skill script/);
  }, 20_000);
  it('cleans up when the sandbox cannot start and never briefs the agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-failstart-'));
    try {
      const pi = createFakePi();
      const sandbox = Object.assign(new InertSandbox({ kind: 'url', url: 'https://example.com', origin: 'https://example.com' }), { failStart: true });
      const herdr = createSimpleHerdr();
      registerP2O(pi.pi, { createSandbox: () => sandbox, herdr: herdr.client, controlRoot: join(root, 'control'), extensionPath: EXTENSION_PATH });
      const context = createContext({ cwd: root });
      await pi.commands.get('p2o').handler('--target https://example.com', context.ctx);
      expect(pi.messages).toEqual([]);
      expect(sandbox.stopCount).toBeGreaterThan(0);
      expect(context.notices.at(-1)).toContain('docker pull');
      const handlers = pi.events.get('tool_call') ?? [];
      let blocked: unknown;
      for (const handler of handlers) blocked = await handler({ toolName: 'bash' }, context.ctx);
      expect(blocked).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);
});
