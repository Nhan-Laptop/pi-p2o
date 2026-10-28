// Real Pi host + real extension, inert sandbox and inert model: proves the planner loadout without Docker.
// The sandbox factory is inert so this fixture runs in the default suite; the real-container claim lives in the
// opt-in Docker tests (tests/minimal/artifacts-docker.test.ts), where the fake-Pi harness calls owner target tools.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';
import { registerP2O } from '../../../extensions/p2o/index.js';
import type { SandboxOptions } from '../../../src/sandbox.js';
import type { Target } from '../../../src/target.js';
import { PLANNER_TOOLS } from '../../../src/tool-policy.js';
import { InertSandbox } from '../helpers/inert-sandbox.js';
import { createFakeHerdr } from './fake-herdr.js';

export default async function (pi: ExtensionAPI) {
  const installed = process.env.P2O_TEST_INSTALLED_EXTENSION;
  const register = installed ? (await import(installed)).registerP2O : registerP2O;
  pi.registerProvider('p2o-docker-inert', {
    baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'inert-placeholder', api: 'openai-completions',
    models: [{ id: 'docker-agent', name: 'Mechanical fixture, NOT live AI', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context) {
      const system = getCurrentSystemPrompt(context.messages);
      const tools = getCurrentTools(context.messages).map(tool => tool.name).sort();
      if (!system.includes('P2O ASSESSMENT') || !system.includes('RECON → INVESTIGATION')) throw new Error('lead scope/recon section missing');
      if (tools.includes('p2o_capabilities') || system.includes('CAPABILITIES')) throw new Error('removed capability interface still exposed');
      // A1/D1: Pi enforces the role by activating only the planner set. Any host tool or target/lab tool here is a leak.
      const expected = [...PLANNER_TOOLS].sort();
      if (tools.length !== expected.length || tools.some((name, index) => name !== expected[index])) throw new Error(`declared tools are not the planner loadout: ${tools.join(',')}`);
      const results = context.messages.filter((message: any) => message.role === 'toolResult');
      const last: any = results.at(-1);
      let content: AssistantMessage['content'];
      // Turn 1 asks for a host tool the planner does not hold: Pi must answer with its unknown-tool result, and nothing runs.
      if (!last) content = [{ type: 'toolCall', id: 'host-1', name: 'bash', arguments: { command: 'echo HOST_BYPASS' } }];
      else if (last.toolName === 'bash') content = [{ type: 'toolCall', id: 'finish-1', name: 'p2o_finish', arguments: { partial: 'inert loadout fixture stops before any plan goal was recorded, so its default campaign ends incomplete.' } }];
      else content = [{ type: 'text', text: 'PLANNER_LOADOUT_FINAL_REPORT: the host tool was refused by the loadout and no target operation ran.' }];
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
    // P18/D48: a run refuses to start without a worker backend, so the fixture supplies the test transport. Nothing is ever
    // dispatched here (the scripted model only asks for a host tool and then finishes); no pane or child process is opened.
    herdr: createFakeHerdr({ cwd: process.env.P2O_TEST_CWD ?? process.cwd(), piBinary: process.env.P2O_TEST_PI_BINARY ?? 'pi' }),
    // No Docker: the loadout claim is about declared tools, and the inert sandbox keeps the run startable offline.
    createSandbox: (target: Target, profile: SandboxOptions) => new InertSandbox(target, undefined, undefined, profile),
  });
}
