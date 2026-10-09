import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { SandboxOptions } from '../../../src/sandbox.js';
import type { Target } from '../../../src/target.js';
import type { HerdrClient } from '../../../src/herdr.js';
import { InertSandbox } from './inert-sandbox.js';

export { InertSandbox };
export const EXTENSION_PATH = fileURLToPath(new URL('../../../extensions/p2o/index.ts', import.meta.url));

export interface FakePi {
  pi: ExtensionAPI;
  tools: Map<string, any>;
  commands: Map<string, any>;
  events: Map<string, any>;
  active: string[];
  messages: string[];
  customMessages: Array<{message:any; options:any}>;
  flags: Record<string, string | boolean>;
  allowWorkerFlag: (value: string) => void;
}

export function createFakePi(options: { active?: string[] } = {}): FakePi {
  const tools = new Map<string, any>(); const commands = new Map<string, any>(); const events = new Map<string, any>();
  let active = [...(options.active ?? ['read', 'bash', 'edit', 'write'])];
  const messages: string[] = [];
  const customMessages: Array<{message:any; options:any}> = [];
  const flags: Record<string, string | boolean> = {};
  const api = {
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    registerCommand: (name: string, command: any) => { commands.set(name, command); },
    registerFlag: (name: string) => { flags[name] = flags[name] ?? ''; },
    getFlag: (name: string) => flags[name] === '' ? undefined : flags[name],
    on: (event: string, handler: any) => { const list = events.get(event) ?? []; list.push(handler); events.set(event, list); },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    sendUserMessage: (text: string) => { messages.push(text); },
    sendMessage: (message:any, options:any) => {customMessages.push({message,options});},
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  const fake: FakePi = {
    pi: api, tools, commands, events, get active() { return active; }, messages, customMessages, flags,
    allowWorkerFlag: (value: string) => { flags['p2o-worker'] = value; },
  } as FakePi;
  Object.defineProperty(fake, 'active', { get: () => active });
  return fake;
}

export interface FakeContext {
  ctx: ExtensionCommandContext;
  notices: string[];
  dialogs: string[];
  aborts: number;
  waitForIdleCalls: number;
  setConfirm: (value: boolean) => void;
  setIdle: (value: boolean) => void;
}

export function createContext(options: { cwd: string; hasUI?: boolean; model?: { provider: string; id: string } | null; confirm?: boolean } ): FakeContext {
  const notices: string[] = []; const dialogs: string[] = [];
  let confirmed = options.confirm ?? true;
  let idle = true;
  let aborts = 0; let waitForIdleCalls = 0;
  const controller = new AbortController();
  const ctx = {
    cwd: options.cwd, hasUI: options.hasUI ?? true, mode: 'tui',
    model: options.model === undefined ? { provider: 'p2o-inert', id: 'current-agent' } : options.model,
    thinkingLevel: 'off',
    ui: {
      notify: (text: string) => { notices.push(text); },
      confirm: async (title: string) => { dialogs.push(title); return confirmed; },
      setStatus: () => {},
      custom: async () => undefined,
    },
    abort: () => { aborts += 1; controller.abort(); },
    waitForIdle: async () => { waitForIdleCalls += 1; },
    isIdle: () => idle,
    signal: controller.signal,
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionCommandContext;
  return {
    ctx, notices, dialogs, get aborts() { return aborts; }, get waitForIdleCalls() { return waitForIdleCalls; },
    setConfirm: (value: boolean) => { confirmed = value; },
    setIdle: (value: boolean) => {idle=value;},
  } as FakeContext;
}

/** In-memory Herdr double for extension-level tests; the real-child driver lives in fake-herdr.ts. */
export function createSimpleHerdr(options: { available?: boolean } = {}) {
  const calls: Array<{ op: string; name?: string; paneId?: string; args?: string[]; text?: string }> = [];
  const closedPanes: string[] = [];
  const statuses = new Map<string, string>();
  let panes = 0;
  const client: HerdrClient = {
    async available() { return options.available ?? true; },
    async split() { panes += 1; const paneId = `w1T:p${panes + 1}`; calls.push({ op: 'split', paneId }); return paneId; },
    async start({ name, paneId, args }) { calls.push({ op: 'start', name, paneId, args }); statuses.set(name, 'working'); },
    async prompt({ name, text }) { calls.push({ op: 'prompt', name, text }); },
    async get(name) { return { name, paneId: 'w1T:p2', status: statuses.get(name) ?? 'unknown' }; },
    async statuses(names) { return new Map(names.map(name => [name, statuses.get(name) ?? 'unknown'])); },
    async interrupt(name) { calls.push({ op: 'interrupt', name }); statuses.set(name, 'done'); },
    async closePane(paneId) { calls.push({ op: 'close', paneId }); statuses.set([...statuses.keys()].find(key => statuses.get(key) !== 'done') ?? '', 'done'); return Boolean(closedPanes.splice(0, 1).length === 0); },
  };
  return { client, calls, statuses, refuseClose: () => { closedPanes.push('refuse'); }, setStatus: (name: string, status: string) => statuses.set(name, status) };
}

export function sandboxFactory(sandboxes: InertSandbox[]) {
  return (target: Target, _options: SandboxOptions) => { const sandbox = new InertSandbox(target); sandboxes.push(sandbox); return sandbox; };
}
