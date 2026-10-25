// Real extension + real Docker, inert model. Delegation is off (no Herdr) so no pane is opened.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';
import { registerP2O } from '../../../extensions/p2o/index.js';

export default async function (pi: ExtensionAPI) {
  const installed = process.env.P2O_TEST_INSTALLED_EXTENSION;
  const register = installed ? (await import(installed)).registerP2O : registerP2O;
  pi.registerProvider('p2o-docker-inert', {
    baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'inert-placeholder', api: 'openai-completions',
    models: [{ id: 'docker-agent', name: 'Mechanical fixture, NOT live AI', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context) {
      const system = getCurrentSystemPrompt(context.messages);
      const tools = getCurrentTools(context.messages).map(tool => tool.name);
      if (!system.includes('P2O ASSESSMENT') || !system.includes('RECON → INVESTIGATION')) throw new Error('lead scope/recon section missing');
      if (tools.includes('p2o_capabilities') || system.includes('CAPABILITIES')) throw new Error('removed capability interface still exposed');
      if (tools.includes('bash') || tools.includes('read')) throw new Error(`host tools were declared: ${tools.join(',')}`);
      const results = context.messages.filter((message: any) => message.role === 'toolResult');
      const last: any = results.at(-1);
      let content: AssistantMessage['content'];
      if (!last) content = [{ type: 'toolCall', id: 'host-1', name: 'bash', arguments: { command: 'echo HOST_BYPASS' } }];
      else if (last.toolName === 'bash') content = [{ type: 'toolCall', id: 'shell-1', name: 'p2o_shell', arguments: { command: 'id -u; cat /target/code.txt; grep CapEff /proc/self/status; test ! -e /var/run/docker.sock && echo NO_DOCKER_SOCKET' } }];
      else if (last.toolName === 'p2o_shell') content = [{ type: 'toolCall', id: 'finish-1', name: 'p2o_finish', arguments: {} }];
      else content = [{ type: 'text', text: 'DOCKER_OWNER_FINAL_REPORT: sandbox evidence recorded from the real container.' }];
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
  register(pi, {
    ...(installed ? { extensionPath: installed } : {}),
    ...(process.env.P2O_TEST_CONTROL_ROOT ? { controlRoot: process.env.P2O_TEST_CONTROL_ROOT } : {}),
  });
}
