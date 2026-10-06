// MODEL-INERT + BACKEND-INERT. Loaded by the real Pi RPC integration test only; no network or worker.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';
import { registerP2O } from '../../../extensions/p2o/index.js';
import { FakeBackend, FakeEntry } from '../../interface/helpers.js';
import { contractOwnerConsent } from '../owner-consent-fixture.js';

export default function (pi: ExtensionAPI) {
  pi.registerProvider('native-fixture', {
    baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'inert-placeholder', api: 'openai-completions',
    models: [{ id: 'inert-orchestrator', name: 'Native foreground mechanical fixture, NOT live AI', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context) {
      const names = getCurrentTools(context.messages).map(tool => tool.name);
      if (!names.includes('p2o_orchestrate') || names.includes('bash')) throw new Error('Native tool loadout was not applied');
      const system = getCurrentSystemPrompt(context.messages);
      if (!system.includes('P2O FOREGROUND ORCHESTRATOR')) throw new Error('Native orchestration system section missing');
      const results = context.messages.filter(m => m.role === 'toolResult');
      const last = results.at(-1);
      const value = last?.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      let data: any; try { data = JSON.parse(value ?? 'null'); } catch { /* error text is not data */ }
      let content: AssistantMessage['content'];
      if (data?.report) content = [{ type: 'text', text: 'NATIVE_FOREGROUND_FINAL: qualified inert report; no live AI or vulnerability qualification.' }];
      else if (system.includes('Phase: terminal.')) content = [{ type: 'toolCall', id: 'finish-call', name: 'p2o_orchestrate', arguments: { runId: 'run-1', action: 'finish' } }];
      else if (data?.phase === 'planning') content = [{ type: 'toolCall', id: 'draft-call', name: 'p2o_orchestrate', arguments: { runId: 'run-1', action: 'propose', draft: {
        steps: ['Read only the approved immutable inventory; independent verification unsupported.'], ownerMenu: [{ taskId: 'task-1', observationId: 'source-inventory' }],
      } } }];
      else if (data?.phase === 'awaiting-approval') content = [{ type: 'text', text: 'NATIVE_FOREGROUND_PLAN: review /p2o approve plan-1. No worker started.' }];
      else content = [{ type: 'toolCall', id: 'context-call', name: 'p2o_orchestrate', arguments: { runId: 'run-1', action: 'context' } }];
      const message: AssistantMessage = { role: 'assistant', api: 'openai-completions', provider: model.provider, model: model.id,
        content, timestamp: Date.now(), stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop',
        usage: { input: 12, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 17, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } });
      const block = content[0];
      if (block.type === 'toolCall') {
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: { ...message, content: [{ ...block, arguments: {} }], stopReason: 'pending' } });
        stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(block.arguments), partial: message });
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: message });
      } else if (block.type === 'text') {
        stream.push({ type: 'text_start', contentIndex: 0, partial: { ...message, content: [{ type: 'text', text: '' }], stopReason: 'pending' } });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: block.text, partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content: block.text, partial: message });
      }
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      stream.end(message);
      return stream;
    },
  });
  const backend = new FakeBackend(), entry = new FakeEntry();
  entry.prepareOverrides.spend = { modelAccounting: 'informational', maxTokens: null, maxCostUsd: null, maxRequests: 20, maxToolCalls: 20, maxAttempts: 2 };
  entry.plan = async () => { throw new Error('NESTED_PLANNER_USED'); };
  const approve = entry.approve.bind(entry);
  entry.approve = async input => { const receipt = await approve(input); backend.snapshotValue.run = { ...backend.snapshotValue.run as object, state: 'completed' }; return receipt; };
  backend.entry = entry;
  registerP2O(pi, { backendFactory: () => backend, onboardingFor: async input => {
    const owner = await contractOwnerConsent(input); if (owner.status !== 'ready') return owner;
    const limits = { ...owner.effectiveLimits, modelAccounting: 'informational' as const, maxTokens: null, maxCostUsd: null };
    return { ...owner, effectiveLimits: limits, configuration: { ...owner.configuration, limits } };
  } });
}
