// Inert model + inert sandbox. Tests real Pi's prompt/session/tool loop, not a live provider.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';
import { registerP2O } from '../../../extensions/p2o/index.js';
import { Sandbox } from '../../../src/sandbox.js';

export default function (pi: ExtensionAPI) {
  pi.registerProvider('p2o-inert', {
    baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'inert-placeholder', api: 'openai-completions',
    models: [{ id: 'current-agent', name: 'Mechanical fixture, NOT live AI', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context) {
      const names = getCurrentTools(context.messages).map(tool => tool.name);
      if (!names.includes('p2o_shell') || names.includes('bash')) throw new Error('Sandbox-only tool loadout missing');
      if (!getCurrentSystemPrompt(context.messages).includes('P2O ASSESSMENT: YOU')) throw new Error('Scope prompt missing');
      const last = context.messages.filter(m => m.role === 'toolResult').at(-1);
      const content: AssistantMessage['content'] = last?.toolName === 'p2o_finish'
        ? [{ type: 'text', text: 'DIRECT_CURRENT_AGENT_REPORT: inert observation, no independent verification.' }]
        : last?.toolName === 'p2o_shell'
          ? [{ type: 'toolCall', id: 'finish', name: 'p2o_finish', arguments: {} }]
          : [{ type: 'text', text: 'DIRECT_CURRENT_AGENT_PLAN: inspect within scope.' }, { type: 'toolCall', id: 'shell', name: 'p2o_shell', arguments: { command: 'id' } }];
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
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); stream.end(message); return stream;
    },
  });
  class InertSandbox extends Sandbox {
    override async start() {}
    override async stop() {}
    override async exec() { return { code: 0, stdout: 'INERT_SANDBOX_OBSERVATION', stderr: '', truncated: false }; }
  }
  registerP2O(pi, process.env.P2O_NATIVE_REAL_DOCKER === '1' ? {} : { createSandbox: target => new InertSandbox(target) });
}
