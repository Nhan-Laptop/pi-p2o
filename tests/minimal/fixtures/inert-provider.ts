// MODEL-INERT scripted provider shared by the owner/worker Pi fixtures. No network, no live AI.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';

export function registerInertProvider(pi: ExtensionAPI, mode: 'owner' | 'worker'): void {
  pi.registerProvider('p2o-inert', {
    baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'inert-placeholder', api: 'openai-completions',
    models: [{ id: 'current-agent', name: 'Mechanical fixture, NOT live AI', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      // A conforming provider must honor an already-aborted request BEFORE network/usage.
      // This fixture never contacts a provider; journaling counts accepted inert requests only.
      options?.signal?.throwIfAborted();
      if (process.env.P2O_TEST_PROVIDER_LOG) appendFileSync(process.env.P2O_TEST_PROVIDER_LOG,JSON.stringify({mode,at:Date.now()})+'\n');
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
      if (mode === 'worker' && !descriptions.find(tool => tool.name === 'p2o_http')?.description.includes('bounded redirect following')) throw new Error('http guidance missing');
      if (mode === 'worker' && !descriptions.find(tool => tool.name === 'p2o_net')?.description.includes('connect scans')) throw new Error('network tool guidance missing');
      const results = context.messages.filter((message: any) => message.role === 'toolResult');
      const last: any = results.at(-1);
      const lastTool = last?.toolName as string | undefined;
      options?.signal?.throwIfAborted();
      let content: AssistantMessage['content'];

      if (mode === 'owner') {
        if (!system.includes('P2O ASSESSMENT')) throw new Error('owner scope section missing');
        const policy = system.split('<p2o_assessment>')[1]?.split('</p2o_assessment>')[0];
        if (!policy || /\bp2o_[a-z_]+\b|nextOffset|supersedes=|policyBasis=/.test(policy)) throw new Error('lead policy duplicates tool guidance');
        if ((system.match(/<p2o_assessment>/g) ?? []).length !== 1) throw new Error('lead policy duplicated');
        const candidate = descriptions.find(tool => tool.name === 'p2o_candidate');
        if (!(candidate?.parameters as any)?.properties?.evidenceRefs || !(candidate?.parameters as any)?.properties?.policyBasis) throw new Error('candidate schema lost');
        if (!tools.includes('p2o_delegate') || tools.includes('bash') || tools.includes('read')) throw new Error(`owner tool loadout was not applied: ${tools.join(',')}`);
        if (!last) content = [{ type: 'toolCall', id: 'delegate-1', name: 'p2o_delegate', arguments: {
          focus: 'surface-recon', role: 'general',
          task: 'Inspect /target/code.txt in the sandbox and report what it contains. Success: a command, its output, and coverage for that surface. Stop if the sandbox is unavailable.',
          context: 'The lead has not inspected the target yet; nothing is already known and no surface is covered.',
        } }];
        else if (lastTool === 'p2o_delegate' && process.env.P2O_TEST_EVENT_LOOP === '1') content = [{type:'toolCall',id:'loop-wait',name:'p2o_loop',arguments:{action:'wait',reason:'Engine should await the delayed worker report without model polling'}}];
        else if (lastTool === 'p2o_loop') content = [{type:'toolCall',id:'workers-after-wake',name:'p2o_workers',arguments:{}}];
        else if (lastTool === 'p2o_delegate') content = [{ type: 'toolCall', id: 'workers-1', name: 'p2o_workers', arguments: { waitFor: 'all-report', timeoutSeconds: 30 } }];
        else if (lastTool === 'p2o_workers') content = [{ type: 'toolCall', id: 'finish-1', name: 'p2o_finish', arguments: {} }];
        else if (lastTool === 'p2o_finish') content = [{ type: 'text', text: 'OWNER_FINAL_REPORT: inert owner run; worker claim repeated only as a labelled, unverified assertion.' }];
        else if (lastTool === 'p2o_stop_worker') content = [{ type: 'text', text: 'OWNER_STOPPED_WORKER.' }];
        else content = [{ type: 'text', text: 'OWNER_UNEXPECTED_TOOL.' }];
      } else {
        if (!system.includes('P2O WORKER')) throw new Error('worker scope section missing');
        if (!tools.includes('p2o_shell') || !tools.includes('p2o_report') && tools.includes('p2o_ledger') || tools.includes('p2o_finish') || tools.includes('bash') || tools.includes('read')) throw new Error(`worker tool loadout was not applied: ${tools.join(',')}`);
        if (!last) content = [{ type: 'toolCall', id: 'handoff-1', name: 'p2o_skill_read', arguments: { id: 'shared:handoffs' } }];
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
      if (mode === 'owner' && process.env.P2O_TEST_WAKE_BOUNDARY === '1' && lastTool === 'p2o_delegate') await delay(1000);
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
