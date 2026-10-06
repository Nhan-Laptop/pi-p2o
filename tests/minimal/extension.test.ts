import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { Sandbox } from '../../src/sandbox.js';
import type { Target } from '../../src/target.js';

export class FakeSandbox extends Sandbox {
  started = 0; stopCount = 0; commands: string[] = []; cleanupFailure = false; startFailure = false;
  constructor(target: Target) { super(target); }
  override async start() { this.started++; if (this.startFailure) throw new Error('missing image'); }
  override async stop() { this.stopCount++; if (this.cleanupFailure) throw new Error('cleanup not verified'); }
  override async exec(command: string) { this.commands.push(command); return { code: 0, stdout: 'inert sandbox output', stderr: '', truncated: false }; }
}

function setup(options: { failStart?: boolean; deferredStart?: Promise<void> } = {}) {
  const tools = new Map<string, any>(); const events = new Map<string, any>(); const messages: string[] = []; const notices: string[] = []; const dialogs: string[] = [];
  let active = ['read', 'bash']; let confirmed = true; let sandbox: FakeSandbox | undefined;
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (_name: string, command: any) => { handler = command.handler; },
    on: (event: string, fn: any) => events.set(event, fn),
    getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = [...names]; },
    sendUserMessage: (text: string) => messages.push(text),
  } as unknown as ExtensionAPI;
  const ctx = { cwd: '/tmp', hasUI: true, model: { provider: 'existing', id: 'existing-model' },
    ui: { notify: (text: string) => notices.push(text), confirm: async (title: string) => { dialogs.push(title); return confirmed; }, setStatus: () => {} },
    abort: () => {}, waitForIdle: async () => {},
  } as unknown as ExtensionCommandContext;
  let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  registerP2O(pi, { createSandbox: target => {
    sandbox = new FakeSandbox(target); sandbox.startFailure = options.failStart ?? false;
    if (options.deferredStart) sandbox.start = () => options.deferredStart!;
    return sandbox;
  } });
  return { ctx, tools, events, messages, notices, dialogs, get sandbox() { return sandbox!; }, get active() { return active; },
    decline: () => { confirmed = false; }, command: (args: string) => handler(args, ctx),
    call: (name: string, input = {}) => tools.get(name).execute('call', input, undefined, undefined, ctx),
    emit: (name: string, data = {}) => events.get(name)?.(data, ctx),
  };
}

describe('direct current-agent extension', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => { h = setup(); });
  it('registers only three sandbox tools and does no startup work', () => {
    expect([...h.tools.keys()]).toEqual(['p2o_shell', 'p2o_http', 'p2o_finish']);
    expect(h.messages).toEqual([]); expect(h.sandbox).toBeUndefined();
    for (const tool of h.tools.values()) expect(tool.exposure).toBe('model-only');
  });
  it('uses one dialog and directly prompts the current agent, without a plan or model configuration', async () => {
    await h.command('--target https://example.com');
    expect(h.dialogs).toEqual(['Start authorized assessment?']);
    expect(h.messages).toHaveLength(1); expect(h.messages[0]).toContain('YOU are the investigating agent');
    expect(h.messages[0]).toContain('Do not spawn another agent');
    expect(h.sandbox.started).toBe(1); expect(h.sandbox.commands).toEqual([]);
    expect(h.active).toEqual(['p2o_shell', 'p2o_http', 'p2o_finish']);
    await h.command('stop'); expect(h.active).toEqual(['read', 'bash']);
  });
  it('does not create a sandbox or model turn after declined consent or bad grammar', async () => {
    h.decline(); await h.command('--target https://example.com');
    expect(h.messages).toEqual([]); expect(h.sandbox).toBeUndefined();
    await h.command('--target x --headless'); expect(h.sandbox).toBeUndefined();
  });
  it('blocks host, nested, codemode, worker and other-extension tools while active', async () => {
    await h.command('--target https://example.com');
    for (const toolName of ['read', 'bash', 'codemode', 'herd_spawn', 'agent_browser', 'p2o_start']) {
      expect(h.emit('tool_call', { toolName, input: {}, parentToolCallId: 'nested' })).toMatchObject({ block: true });
    }
    expect(h.emit('tool_call', { toolName: 'p2o_shell', input: { command: 'id' } })).toBeUndefined();
    expect(() => h.emit('user_bash')).toThrow('blocked');
    await h.call('p2o_shell', { command: 'id' }); expect(h.sandbox.commands).toEqual(['id']);
    await h.command('stop');
  });
  it('keeps the gate through the final response, then restores previous tools', async () => {
    await h.command('--target https://example.com');
    const result = await h.call('p2o_finish'); expect(result.details.sandboxRemoved).toBe(true);
    expect(h.emit('tool_call', { toolName: 'bash' })).toMatchObject({ block: true });
    await expect(h.call('p2o_shell', { command: 'id' })).rejects.toThrow('No active');
    await h.emit('agent_before_settle', { outcome: 'completed' }); expect(h.active).toEqual(['read', 'bash']);
    expect(h.emit('tool_call', { toolName: 'p2o_shell' })).toMatchObject({ block: true });
  });
  it('retains the gate on cleanup failure and retries from the human stop command', async () => {
    await h.command('--target https://example.com'); h.sandbox.cleanupFailure = true;
    await h.command('stop'); expect(h.notices.at(-1)).toContain('not verified');
    expect(h.emit('tool_call', { toolName: 'bash' })).toMatchObject({ block: true });
    h.sandbox.cleanupFailure = false; await h.command('stop'); expect(h.active).toEqual(['read', 'bash']);
  });
  it('aborts and removes the sandbox on session navigation and agent error', async () => {
    await h.command('--target https://example.com'); await h.emit('session_before_switch');
    expect(h.active).toEqual(['read', 'bash']); expect(h.sandbox.stopCount).toBe(1);
    await h.command('--target https://example.com'); await h.emit('agent_before_settle', { outcome: 'error' });
    expect(h.active).toEqual(['read', 'bash']);
  });
  it('injects scope for ordinary subsequent turns and refuses a second target', async () => {
    await h.command('--target https://example.com');
    const prompt = h.emit('before_agent_start', { systemPrompt: 'original system' });
    expect(prompt.systemPrompt).toContain('original system'); expect(prompt.systemPrompt).toContain('https://example.com');
    await h.command('--target https://other.com'); expect(h.messages).toHaveLength(1);
    await h.command('stop');
  });
  it('cleans up a failed startup and never sends the current agent a task', async () => {
    h = setup({ failStart: true }); await h.command('--target https://example.com');
    expect(h.messages).toEqual([]); expect(h.sandbox.stopCount).toBe(1);
    expect(h.active).toEqual(['read', 'bash']); expect(h.notices.at(-1)).toContain('docker pull');
  });
  it('stop during startup waits for ownership, then prevents a late task handoff', async () => {
    let ready!: () => void;
    h = setup({ deferredStart: new Promise<void>(resolve => { ready = resolve; }) });
    const starting = h.command('--target https://example.com');
    for (let i = 0; i < 10 && !h.sandbox; i++) await Promise.resolve();
    expect(h.sandbox).toBeDefined();
    const stopping = h.command('stop'); ready(); await Promise.all([starting, stopping]);
    expect(h.messages).toEqual([]); expect(h.active).toEqual(['read', 'bash']);
  });
  it('cancels navigation when cleanup cannot be verified', async () => {
    await h.command('--target https://example.com'); h.sandbox.cleanupFailure = true;
    expect(await h.emit('session_before_switch')).toEqual({ cancel: true });
    h.sandbox.cleanupFailure = false; await h.command('stop');
  });
  it('requires a live session even if a model calls the executor directly without the hook', async () => {
    await expect(h.call('p2o_shell', { command: 'id' })).rejects.toThrow('No active');
  });
});
