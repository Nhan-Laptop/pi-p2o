// MODEL-INERT scripted provider shared by the owner/worker Pi fixtures. No network, no live AI.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  const blocks = (value as Array<{ type?: string; text?: string }> | undefined) ?? [];
  return blocks.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n');
}

export function registerInertProvider(pi: ExtensionAPI, mode: 'owner' | 'worker'): void {
  pi.registerProvider('p2o-inert', {
    baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'inert-placeholder', api: 'openai-completions',
    models: [{ id: 'current-agent', name: 'Mechanical fixture, NOT live AI', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context) {
      if (mode === 'worker' && process.env.P2O_TEST_WORKER_FAULT === 'quota') {
        const message: AssistantMessage = { role: 'assistant', api: 'openai-completions', provider: model.provider, model: model.id,
          content: [], timestamp: Date.now(), stopReason: 'error', errorMessage: '429 GoUsageLimitError: Go usage limit exceeded',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'error', reason: 'error', error: message }); stream.end(message); return stream;
      }
      const system = getCurrentSystemPrompt(context.messages);
      const tools = getCurrentTools(context.messages).map(tool => tool.name);
      const results = context.messages.filter((message: any) => message.role === 'toolResult');
      const last: any = results.at(-1);
      const lastTool = last?.toolName as string | undefined;
      const lastText = text(last?.content);
      let content: AssistantMessage['content'];

      if (mode === 'owner') {
        if (!system.includes('P2O ASSESSMENT')) throw new Error('owner scope section missing');
        if (!tools.includes('p2o_delegate') || tools.includes('bash') || tools.includes('read')) throw new Error(`owner tool loadout was not applied: ${tools.join(',')}`);
        if (!last) content = [{ type: 'toolCall', id: 'delegate-1', name: 'p2o_delegate', arguments: {
          focus: 'surface-recon', role: 'general',
          task: 'Inspect /target/code.txt in the sandbox and report what it contains. Success: a command, its output, and coverage for that surface. Stop if the sandbox is unavailable.',
          context: 'The lead has not inspected the target yet; nothing is already known and no surface is covered.',
        } }];
        else if (lastTool === 'p2o_delegate') content = [{ type: 'toolCall', id: 'workers-1', name: 'p2o_workers', arguments: { waitFor: 'all-report', timeoutSeconds: 30 } }];
        else if (lastTool === 'p2o_workers') content = [{ type: 'toolCall', id: 'finish-1', name: 'p2o_finish', arguments: {} }];
        else if (lastTool === 'p2o_finish') content = [{ type: 'text', text: 'OWNER_FINAL_REPORT: inert owner run; worker claim repeated only as a labelled, unverified assertion.' }];
        else if (lastTool === 'p2o_stop_worker') content = [{ type: 'text', text: 'OWNER_STOPPED_WORKER.' }];
        else content = [{ type: 'text', text: 'OWNER_UNEXPECTED_TOOL.' }];
      } else {
        if (!system.includes('P2O WORKER')) throw new Error('worker scope section missing');
        if (!tools.includes('p2o_shell') || !tools.includes('p2o_report') && tools.includes('p2o_ledger') || tools.includes('p2o_finish') || tools.includes('bash') || tools.includes('read')) throw new Error(`worker tool loadout was not applied: ${tools.join(',')}`);
        if (!last) content = [{ type: 'toolCall', id: 'shell-1', name: 'p2o_shell', arguments: { command: 'id -u; cat /target/code.txt; pwd' } }];
        else if (lastTool === 'p2o_shell') content = [{ type: 'toolCall', id: 'report-1', name: 'p2o_report', arguments: {
          summary: 'WORKER_REPORT: brokered shell ran inside the owner sandbox and read the authorized source copy.',
          findings: [],
          evidence: [`p2o_shell exit ${/Exit:\s*(\S+)/.exec(lastText)?.[1] ?? '?'}: id -u; cat /target/code.txt; pwd`],
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
      return stream;
    },
  });
}
