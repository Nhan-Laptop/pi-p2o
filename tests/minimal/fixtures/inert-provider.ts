// MODEL-INERT scripted provider shared by the owner/worker Pi fixtures. No network, no live AI.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';

/**
 * Wake-boundary determinism: the hermetic Herdr double writes this marker when the worker's p2o_report tool call completes
 * (the broker commit), so its existence proves the report is already in the ledger. The owner provider holds its planning
 * turn on the marker instead of a fixed sleep, which keeps the wake at Pi's settle boundary even when the host is loaded
 * (the fixed window raced settle) and never relies on provider latency.
 */
const reportMarker = (logPath: string) => `${logPath}.worker-report`;
async function waitForReportMarker(logPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (existsSync(reportMarker(logPath))) return; await delay(100); }
}

export function registerInertProvider(pi: ExtensionAPI, mode: 'owner' | 'worker'): void {
  pi.registerProvider('p2o-inert', {
    baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'inert-placeholder', api: 'openai-completions',
    models: [{ id: 'current-agent', name: 'Mechanical fixture, NOT live AI', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      // A conforming provider must honor an already-aborted request BEFORE network/usage.
      // This fixture never contacts a provider; journaling counts accepted inert requests only.
      options?.signal?.throwIfAborted();
      const indexedContext=context.messages.some((m:any)=>(typeof m.content==='string'?m.content:JSON.stringify(m.content??'')).includes('P2O INDEXED KNOWLEDGE'));
      if (process.env.P2O_TEST_PROVIDER_LOG) appendFileSync(process.env.P2O_TEST_PROVIDER_LOG,JSON.stringify({mode,at:Date.now(),indexedContext})+'\n');
      const objectivePresent = context.messages.some((m:any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).includes('P2O OBJECTIVE STATE'));
      if (mode === 'worker' && !objectivePresent) throw Error('Worker objective did not survive request context rebuilding');
      if (mode === 'worker' && process.env.P2O_TEST_WORKER_FAULT === 'quota') {
        const message: AssistantMessage = { role: 'assistant', api: 'openai-completions', provider: model.provider, model: model.id,
          content: [], timestamp: Date.now(), stopReason: 'error', errorMessage: '429 GoUsageLimitError: Go usage limit exceeded',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'error', reason: 'error', error: message }); stream.end(message); return stream;
      }
      const system = getCurrentSystemPrompt(context.messages);
      const tools = getCurrentTools(context.messages).map(tool => tool.name);
      if (tools.includes('p2o_capabilities') || system.includes('CAPABILITIES')) throw new Error('removed capability subsystem is exposed');
      if (!system.includes('RECON → INVESTIGATION') || !system.includes('decision note')) throw new Error('recon contract missing');
      const descriptions = getCurrentTools(context.messages);
      if (mode === 'worker' && !descriptions.find(tool => tool.name === 'p2o_shell')?.description.includes('network egress')) throw new Error('shell guidance missing');
      if (mode === 'worker' && !descriptions.find(tool => tool.name === 'p2o_http')?.description.includes('redirect following up to maxRedirects')) throw new Error('http guidance missing');
      if (mode === 'worker' && !descriptions.find(tool => tool.name === 'p2o_net')?.description.includes('connect scans')) throw new Error('network tool guidance missing');
      const results = context.messages.filter((message: any) => message.role === 'toolResult');
      const last: any = results.at(-1);
      const lastTool = last?.toolName as string | undefined;
      if(lastTool!=='p2o_finish'&&lastTool!=='p2o_report'&&!indexedContext)throw Error('Indexed role packet did not reach the real Pi provider request');
      options?.signal?.throwIfAborted();
      let content: AssistantMessage['content'];

      if (mode === 'owner') {
        if (!system.includes('P2O ASSESSMENT')) throw new Error('owner scope section missing');
        const policy = system.split('<p2o_assessment>')[1]?.split('</p2o_assessment>')[0];
        if (!policy || /\bp2o_[a-z_]+\b|nextOffset|supersedes=|policyBasis=/.test(policy)) throw new Error('lead policy duplicates tool guidance');
        if ((system.match(/<p2o_assessment>/g) ?? []).length !== 1) throw new Error('lead policy duplicated');
        // A1: the planner holds intent/plan/case/coverage-plan/review/read/worker-control only. Target, lab, claim, note,
        // surface and report tools plus the hidden legacy verbs are never declared, so a model call to one is Pi's
        // `Tool <name> not found` before any extension handler runs. The task schema pins the one delegation path instead.
        const plannerMust = ['p2o_task_author', 'p2o_task_dispatch', 'p2o_task_review', 'p2o_task_settle', 'p2o_plan_author',
          'p2o_case_author', 'p2o_coverage_plan', 'p2o_board', 'p2o_ledger', 'p2o_graph', 'p2o_workers', 'p2o_loop', 'p2o_finish'];
        const plannerMustNot = ['p2o_shell', 'p2o_net', 'p2o_http', 'p2o_capture', 'p2o_lab', 'p2o_candidate', 'p2o_note',
          'p2o_surface', 'p2o_report', 'p2o_request_subtask', 'p2o_delegate', 'p2o_task_start', 'p2o_coverage_cell',
          'p2o_coverage_cell_retire', 'bash', 'read'];
        if (!plannerMust.every(name => tools.includes(name)) || plannerMustNot.some(name => tools.includes(name))) throw new Error(`planner tool loadout was not applied: ${tools.join(',')}`);
        if (!(descriptions.find(tool => tool.name === 'p2o_task_author')?.parameters as any)?.properties?.draft) throw new Error('task create schema lost');
        if(process.env.P2O_TEST_CASE_OWNER==='1'){
          const caseSchema=descriptions.find(tool=>tool.name==='p2o_case_author')?.parameters as any,coveragePlanSchema=descriptions.find(tool=>tool.name==='p2o_coverage_plan')?.parameters as any;
          if(caseSchema?.type!=='object'||!caseSchema.properties?.entry||coveragePlanSchema?.type!=='object'||!coveragePlanSchema.properties?.plan)throw Error('case/coverage verb schemas missing in real Pi context');
          // A1/A3: cell authoring left the model surface, so the planner must not see the cell verb or the worker-only claim/shell verbs.
          if(descriptions.some(tool=>['p2o_coverage_cell','p2o_coverage_cell_retire','p2o_candidate','p2o_shell'].includes(tool.name)))throw Error('removed or worker-only verb exposed to the planner');
          if(last?.isError&&lastTool!=='p2o_net')throw Error('Native case fixture tool rejected: '+JSON.stringify(last));
          const graphResults:any[]=results.filter((r:any)=>r.toolName==='p2o_graph'),taskResults:any[]=results.filter((r:any)=>r.toolName==='p2o_task_author'),ledgerResults:any[]=results.filter((r:any)=>r.toolName==='p2o_ledger'),
            caseResults:any[]=results.filter((r:any)=>String(r.toolName).startsWith('p2o_case_')),coverageResults:any[]=results.filter((r:any)=>String(r.toolName).startsWith('p2o_coverage_')),boardResults:any[]=results.filter((r:any)=>r.toolName==='p2o_board'),
            graph=graphResults[0]?.details.acks[0],ledgerRecords:any[]=ledgerResults[0]?.details.records??[],claim=ledgerRecords.filter((r:any)=>r.kind==='candidate').at(-1),
            pending=caseResults[0]?.details,accepted=caseResults[2]?.details,plan=coverageResults[0]?.details,
            draft={question:'Inspect /target/code.txt in the sandbox and report what it contains.',surface:'fixture-case',risk:'boundary',role:'recon',roleReason:'A2: the first intent of an empty run is recon/mapping',expectedTrue:'The declared fixture source is the observed input',expectedFalse:'The source copy is unavailable or different',stopCondition:'Stop at this one bounded inert question',evidenceIds:[],prerequisites:[],methodReason:'Controlled source fixture, no target execution'},
            entry={title:'Native inert canonical case',policyKey:'policy:native-case',rootCauseKey:'root:native-gate',assetRefs:[{id:graph?.entityId,revision:1}],claimRefs:[claim?.id],independentEvidenceRefs:[],taskRefs:[],reportRefs:[],contradictions:[],affectedVariants:['variant:native'],relatedCaseIds:[],verdict:'confirmed',reviewStatus:'pending',reviewReason:'Pending explicit native owner review of exact support',limitations:'Only the scripted inert provider fixture is covered',remediation:{status:'unplanned',reason:'No remediation has been implemented or reviewed',evidenceRefs:[]}},
            planInput={title:'Native inert coverage denominator',status:'active',reason:'No model-authored cells; coverage authoring left the planner surface',exclusions:['No undeclared assets or actors'],unknownScope:['Deployment parity is unknown']};
          if(!last)content=[{type:'toolCall',id:'case-net',name:'p2o_net',arguments:{command:'printf inert-planner-probe'}}];
          else if(lastTool==='p2o_net')content=[{type:'toolCall',id:'case-asset',name:'p2o_graph',arguments:{action:'record',batch:{assets:[{asset:{kind:'endpoint',key:'GET /native-case'}}]}}}];
          else if(lastTool==='p2o_graph')content=[{type:'toolCall',id:'case-task',name:'p2o_task_author',arguments:{draft}}];
          else if(lastTool==='p2o_task_author')content=[{type:'toolCall',id:'case-dispatch',name:'p2o_task_dispatch',arguments:{ids:[taskResults[0].details.id]}}];
          else if(lastTool==='p2o_task_dispatch')content=[{type:'toolCall',id:'case-wait',name:'p2o_workers',arguments:{waitFor:'all-report',timeoutSeconds:30}}];
          else if(lastTool==='p2o_workers')content=[{type:'toolCall',id:'case-ledger',name:'p2o_ledger',arguments:{limit:100}}];
          else if(lastTool==='p2o_ledger'){
            if(!claim)throw Error('Native case fixture found no worker claim in the ledger');
            content=[{type:'toolCall',id:'case-create',name:'p2o_case_author',arguments:{requestId:'native-case-request',entry}}];
          }
          else if(lastTool==='p2o_case_author'&&caseResults.length===1)content=[{type:'toolCall',id:'case-replay',name:'p2o_case_author',arguments:{requestId:'native-case-request',entry}}];
          else if(lastTool==='p2o_case_author'&&caseResults.length===2)content=[{type:'toolCall',id:'case-accept',name:'p2o_case_author',arguments:{id:pending.id,revision:1,entry:{...entry,reviewStatus:'accepted',reviewReason:'Owner reviewed exact native claim, asset and limitations'}}}];
          else if(lastTool==='p2o_case_author'&&caseResults.length===3)content=[{type:'toolCall',id:'coverage-plan',name:'p2o_coverage_plan',arguments:{requestId:'native-coverage-request',plan:planInput}}];
          else if(lastTool==='p2o_coverage_plan'&&coverageResults.length===1)content=[{type:'toolCall',id:'coverage-replay',name:'p2o_coverage_plan',arguments:{requestId:'native-coverage-request',plan:planInput}}];
          else if(lastTool==='p2o_coverage_plan'&&coverageResults.length===2)content=[{type:'toolCall',id:'case-list',name:'p2o_board',arguments:{board: 'cases'}}];
          else if(lastTool==='p2o_board'&&boardResults.length===1)content=[{type:'toolCall',id:'coverage-list',name:'p2o_board',arguments:{board: 'coverage'}}];
          else if(lastTool==='p2o_board'&&boardResults.length===2)content=[{type:'toolCall',id:'case-finish',name:'p2o_finish',arguments:{}}];
          else if(lastTool==='p2o_finish')content=[{type:'text',text:'OWNER_CASE_DONE: one owner-reviewed inert case and an explicit empty coverage plan; no goal or assessment completion.'}];
          else throw Error('Unexpected native case fixture turn');
        }
        else if(process.env.P2O_TEST_WORK_OWNER==='1'){
          const schema=descriptions.find(tool=>tool.name==='p2o_plan_author')?.parameters as any;
          if(schema?.type!=='object'||!schema.properties?.entry)throw Error('plan create schema missing in real Pi context');
          if(last?.isError)throw Error('Native work fixture tool rejected: '+JSON.stringify(last));
          const asset=(results.find((r:any)=>r.toolName==='p2o_graph') as any)?.details.acks[0].entityId,draft={
            question:'Which declared inert policy reaches the consumer?',surface:'fixture-source',risk:'boundary',role:'general',roleReason:'Single inert source-only question',expectedTrue:'Declared fixture gate reaches consumer',expectedFalse:'Effective control does not reach consumer',stopCondition:'Stop at this one bounded inert question',evidenceIds:[],prerequisites:[],skills:[],methodReason:'Controlled source fixture, no target execution',
            work:{assetRefs:[{id:asset,revision:1}],questionKey:'policy:inert',actorContext:'actor:source',tenantContext:'tenant:none',methodFamily:'source-trace',purpose:'investigation'},decision:{disposition:'new',reason:'No known matching retained attempt exists yet'},outputContract:{kind:'investigation',required:['evidence','gaps'],partialAllowed:true,artifactPolicy:'ids-only'},
          };
          if(!last)content=[{type:'toolCall',id:'work-asset',name:'p2o_graph',arguments:{action:'record',batch:{assets:[{asset:{kind:'file',key:'src/gate.py'}}]}}}];
          else if(lastTool==='p2o_graph')content=[{type:'toolCall',id:'work-task',name:'p2o_task_author',arguments:{draft}}];
          else if(lastTool==='p2o_task_author'&&!(results as any[]).some(r=>r.toolName==='p2o_plan_author'))content=[{type:'toolCall',id:'work-goal',name:'p2o_plan_author',arguments:{requestId:'native-work-goal',entry:{kind:'goal',title:'Review one declared inert policy boundary',status:'active',reason:'Explicit controlled fixture; no investigation claimed',proof:{kind:'capability',capability:{kind:'file.read'}},criteria:['Owner must review attribution and a control'],taskIds:[last.details.id]}}}];
          else if(lastTool==='p2o_plan_author'&&results.filter((r:any)=>r.toolName==='p2o_plan_author').length===1)content=[{type:'toolCall',id:'work-goal-replay',name:'p2o_plan_author',arguments:{requestId:'native-work-goal',entry:{kind:'goal',title:'Review one declared inert policy boundary',status:'active',reason:'Explicit controlled fixture; no investigation claimed',proof:{kind:'capability',capability:{kind:'file.read'}},criteria:['Owner must review attribution and a control'],taskIds:[(results.find((r:any)=>r.toolName==='p2o_task_author') as any).details.id]}}}];
          // P8.3: the board match verb is gone; a repeated create is the only duplicate/history preflight and returns the
          // match payload instead of creating a second task.
          else if(lastTool==='p2o_plan_author')content=[{type:'toolCall',id:'work-duplicate',name:'p2o_task_author',arguments:{draft}}];
          else if(lastTool==='p2o_task_author')content=[{type:'toolCall',id:'work-finish',name:'p2o_finish',arguments:{}}];
          else if(lastTool==='p2o_finish')content=[{type:'text',text:'OWNER_WORK_DONE: task cancelled by finish, goal retained active; no proof or investigation.'}];
          else throw Error('Unexpected native work fixture turn');
        }
        else if(process.env.P2O_TEST_GRAPH_OWNER==='1'){
          const schema=descriptions.find(tool=>tool.name==='p2o_graph')?.parameters as any;
          if(schema?.type!=='object'||!schema.properties?.batch||!schema.required?.includes('action'))throw Error('graph root object schema missing in real Pi context');
          const graphResults:any[]=results.filter((r:any)=>r.toolName==='p2o_graph'),batch={assets:[{ref:'entry',asset:{kind:'file',key:'src/gate.py'}}],facts:[{assetId:'@entry',kind:'inferred',statement:'native fixture question; not evidence or a finding',confidence:'low'}]};
          if(!last||graphResults.length===1)content=[{type:'toolCall',id:'native-graph-'+graphResults.length,name:'p2o_graph',arguments:{action:'record',requestId:'native-graph-request',batch}}];
          else if(graphResults.length===2)content=[{type:'toolCall',id:'native-graph-view',name:'p2o_graph',arguments:{action:'view',id:graphResults[0].details.acks[0].entityId}}];
          else if(graphResults.length===3)content=[{type:'toolCall',id:'native-graph-export',name:'p2o_graph',arguments:{action:'export'}}];
          else if(lastTool==='p2o_graph')content=[{type:'toolCall',id:'native-graph-finish',name:'p2o_finish',arguments:{}}];
          else if(lastTool==='p2o_finish')content=[{type:'text',text:'OWNER_GRAPH_DONE: knowledge retained; no investigation or finding verified.'}];
          else throw Error('Unexpected native graph fixture turn');
        }
        // A1: the only delegation path. The planner cannot execute: its first turn deliberately calls a worker-only tool
        // (p2o_net) to prove the model surface, then creates and dispatches one bounded intent and waits for the Engine-
        // spawned worker. The real child worker fixture performs the shell/note/candidate/report sequence through the broker.
        else if (!last) content = [{ type: 'toolCall', id: 'surface-probe', name: 'p2o_net', arguments: { command: 'printf inert-planner-probe' } }];
        else if (lastTool === 'p2o_net') content = [{ type: 'toolCall', id: 'task-create', name: 'p2o_task_author', arguments: { draft: {
          question: 'Inspect /target/code.txt in the sandbox and report what it contains. Success: a command, its output, and coverage for that surface. Stop if the sandbox is unavailable.',
          surface: 'surface-recon', risk: 'boundary', role: 'recon', roleReason: 'A2: the first intent of an empty run is recon/mapping',
          expectedTrue: 'The declared fixture source is the observed input', expectedFalse: 'The source copy is unavailable or different',
          stopCondition: 'Stop at this one bounded inert question', evidenceIds: [], prerequisites: [], methodReason: 'Controlled source fixture, no target execution',
        } } }];
        else if (lastTool === 'p2o_task_author') content = [{ type: 'toolCall', id: 'task-dispatch', name: 'p2o_task_dispatch', arguments: { ids: [last.details.id] } }];
        else if (lastTool === 'p2o_task_dispatch' && process.env.P2O_TEST_EVENT_LOOP === '1') content = [{type:'toolCall',id:'loop-wait',name:'p2o_loop',arguments:{action:'wait',reason:'Engine should await the delayed worker report without model polling'}}];
        else if (lastTool === 'p2o_loop') content = [{type:'toolCall',id:'workers-after-wake',name:'p2o_workers',arguments:{waitFor:'all-report',timeoutSeconds:30}}];
        else if (lastTool === 'p2o_task_dispatch') content = [{ type: 'toolCall', id: 'workers-1', name: 'p2o_workers', arguments: { waitFor: 'all-report', timeoutSeconds: 30 } }];
        else if (lastTool === 'p2o_workers') content = [{ type: 'toolCall', id: 'finish-1', name: 'p2o_finish', arguments: system.includes('CAMPAIGN objective') ? { partial: 'inert owner fixture reaches its pinned wake boundary without a recorded goal, so the campaign ends incomplete.' } : {} }];
        else if (lastTool === 'p2o_finish') content = [{ type: 'text', text: 'OWNER_FINAL_REPORT: inert owner run; worker claim repeated only as a labelled, unverified assertion.' }];
        else content = [{ type: 'text', text: 'OWNER_UNEXPECTED_TOOL.' }];
      } else {
        if (!system.includes('P2O WORKER')) throw new Error('worker scope section missing');
        if (!tools.includes('p2o_shell') || !tools.includes('p2o_report') && tools.includes('p2o_ledger') || tools.includes('p2o_finish') || tools.includes('bash') || tools.includes('read')) throw new Error(`worker tool loadout was not applied: ${tools.join(',')}`);
        if (process.env.P2O_TEST_CASE_WORKER === '1') {
          // Real child Pi worker for the canonical-case fixture: one brokered observation and one demonstrated claim the
          // planner reads back from the ledger. No coverage cell is authored; cell authoring left the model surface.
          if (!last) content = [{ type: 'toolCall', id: 'case-handoff', name: 'p2o_skill_read', arguments: { id: 'shared:handoffs' } }];
          else if (lastTool === 'p2o_skill_read') content = [{ type: 'toolCall', id: 'case-shell', name: 'p2o_shell', arguments: { command: 'printf native-case-observation' } }];
          else if (lastTool === 'p2o_shell') content = [{ type: 'toolCall', id: 'case-claim', name: 'p2o_candidate', arguments: {
            candidate: 'native-case-claim', surface: '/native-case', risk: 'authorization', closure: 'confirmed', execution: 'tested', proof: 'offline_reproduction',
            evidenceRefs: [last.details.evidenceId], negativeControls: [], policyBasis: 'boundary_invariant', expectedPolicy: 'Declared inert fixture boundary',
            limitations: 'Scripted provider and sandbox only',
          } }];
          else if (lastTool === 'p2o_candidate') content = [{ type: 'toolCall', id: 'case-report', name: 'p2o_report', arguments: {
            summary: 'WORKER_REPORT: brokered shell ran and produced one demonstrated inert claim for the native case fixture.',
            findings: [], evidence: [(results.find((r: any) => r.toolName === 'p2o_shell') as any).details.evidenceId],
            coverage: [{ surface: '/native-case', risk: 'authorization', outcome: 'clean' }], openItems: ['No live target or deployment was tested'], confidence: 'medium',
          } }];
          else if (lastTool === 'p2o_report') content = [{ type: 'text', text: 'WORKER_SUMMARY: claim and evidence reported; stopping.' }];
          else content = [{ type: 'text', text: 'WORKER_UNEXPECTED_TOOL.' }];
        }
        else if (!last) content = [{ type: 'toolCall', id: 'handoff-1', name: 'p2o_skill_read', arguments: { id: 'shared:handoffs' } }];
        else if (lastTool === 'p2o_skill_read') content = [{ type: 'toolCall', id: 'shell-1', name: 'p2o_shell', arguments: { command: 'id -u; cat /target/code.txt; pwd' } }];
        else if (lastTool === 'p2o_shell') content = [{ type: 'toolCall', id: 'inventory-1', name: 'p2o_note', arguments: {
          kind: 'note', surface: '/target/code.txt', text: 'Inventory: source entry /target/code.txt; input=text; actor/gate/handler and deployed exposure unknown. Extraction=brokered read; observation is an inert fixture, not target proof.', refs: [last.details.evidenceId],
        } }];
        else if (lastTool === 'p2o_note' && results.filter((r: any) => r.toolName === 'p2o_note').length === 1) content = [{ type: 'toolCall', id: 'decision-1', name: 'p2o_note', arguments: {
          kind: 'note', surface: '/target/code.txt', risk: 'identity boundary', text: 'Decision: correct the assumption that source implies deployment. Next task: map consumer identity before discovery; missing gate has highest information gain in this fixture. Expected observation: a registered handler and principal. Stop if no deployment context is supplied; retain the gap.', refs: [(results.find((r: any) => r.toolName === 'p2o_shell') as any).details.evidenceId],
        } }];
        else if (lastTool === 'p2o_note') content = [{ type: 'toolCall', id: 'candidate-1', name: 'p2o_candidate', arguments: {
          candidate: 'consumer-identity', surface: '/target/code.txt', risk: 'identity boundary', closure: 'open_proof_gap', execution: 'not_tested', proof: 'static_trace',
          evidenceRefs: [(results.find((r: any) => r.toolName === 'p2o_shell') as any).details.evidenceId], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Consumer identity must be established before assessing intended policy', limitations: 'Scripted mechanical fixture; no deployment or live effect established',
        } }];
        else if (lastTool === 'p2o_candidate') content = [{ type: 'toolCall', id: 'report-1', name: 'p2o_report', arguments: {
          summary: 'WORKER_REPORT: brokered shell ran inside the owner sandbox and read the authorized source copy.',
          findings: [],
          evidence: [(results.find((r: any) => r.toolName === 'p2o_shell') as any).details.evidenceId],
          coverage: [{ surface: '/target/code.txt', risk: 'unintended data exposure', outcome: 'clean' }],
          openItems: ['worker did not test any other surface'],
          confidence: 'medium',
        } }];
        else if (lastTool === 'p2o_report') content = [{ type: 'text', text: 'WORKER_SUMMARY: reported to the lead; stopping.' }];
        else content = [{ type: 'text', text: 'WORKER_UNEXPECTED_TOOL.' }];
      }

      const message: AssistantMessage = { role: 'assistant', api: 'openai-completions', provider: model.provider, model: model.id,
        content, timestamp: Date.now(), stopReason: content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop',
        usage: { input: 12, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 17, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      const emit = async () => {
      if (mode === 'worker' && process.env.P2O_TEST_EVENT_LOOP === '1' && !last) await delay(500);
      // Dispatch is asynchronous: the Engine registers the spawned worker after its debounce window, so the planner's
      // wait must not race an empty worker table. A real pane + executor provisions far slower than the child-process
      // double used by the hermetic tests, so the opt-in live fixture gets a wider window (it then blocks on the report).
      if (mode === 'owner' && lastTool === 'p2o_task_dispatch' && process.env.P2O_TEST_EVENT_LOOP !== '1') await delay(process.env.P2O_TEST_FAKE_HERDR === '1' ? 1500 : 15_000);
      // The wake-boundary fixtures hold the post-dispatch turn open until the child Pi worker has committed its report, so
      // the report event already exists inside this planning round and the wake lands at Pi's settle boundary (a custom
      // entry, not a separate user prompt that starts a fresh turn). The marker channel is deterministic under load; the
      // fixed fallback only applies when no provider log path is configured.
      if (mode === 'owner' && process.env.P2O_TEST_WAKE_BOUNDARY === '1' && lastTool === 'p2o_task_dispatch' && process.env.P2O_TEST_EVENT_LOOP === '1') {
        if (process.env.P2O_TEST_PROVIDER_LOG) await waitForReportMarker(process.env.P2O_TEST_PROVIDER_LOG, 90_000);
        else await delay(6000);
      }
      options?.signal?.throwIfAborted();
      stream.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } });
      for (const [index, block] of content.entries()) {
        if (block.type === 'toolCall') {
          stream.push({ type: 'toolcall_start', contentIndex: index, partial: { ...message, stopReason: 'pending' } });
          stream.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(block.arguments), partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: block, partial: message });
        } else if (block.type === 'text') {
          stream.push({ type: 'text_start', contentIndex: index, partial: { ...message, stopReason: 'pending' } });
          stream.push({ type: 'text_delta', contentIndex: index, delta: block.text, partial: message });
          stream.push({ type: 'text_end', contentIndex: index, content: block.text, partial: message });
        }
      }
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      stream.end(message);
      };
      void emit().catch(error => {
        const aborted:AssistantMessage={...message,content:[],stopReason:'aborted',errorMessage:String(error)};
        stream.push({type:'error',reason:'aborted',error:aborted});stream.end(aborted);
      });
      return stream;
    },
  });
}
