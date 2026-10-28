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
  shortcuts: Map<string, any>;
  active: string[];
  messages: string[];
  customMessages: Array<{message:any; options:any}>;
  flags: Record<string, string | boolean>;
  entries: Array<{customType:string; data:any}>;
  entryRenderers: Map<string, any>;
  /** P18/D45: `/p2o-round …` dispatches made through `sendUserMessage(…, {expandPromptTemplates:true})`. */
  dispatches: Array<{text:string; args:string}>;
  /** P18/D45: replacement sessions created through the bound command context, in order. */
  sessions: Array<{ctx: any; name?: string}>;
  sessionNames: string[];
  modelChoices: any[];
  thinkingChoices: any[];
  compactions: number;
  /** Bind the command context a dispatched command runs in and that `newSession` replaces. Unbound fakes have no command
   * dispatch, so a wake falls back to the in-session prompt exactly as it did before P18.1. */
  bind: (ctx: ExtensionCommandContext) => void;
  setContextPercent: (percent: number | null) => void;
  allowWorkerFlag: (value: string) => void;
}

export function createFakePi(options: { active?: string[] } = {}): FakePi {
  const tools = new Map<string, any>(); const commands = new Map<string, any>(); const events = new Map<string, any>(); const shortcuts = new Map<string, any>();
  let active = [...(options.active ?? ['read', 'bash', 'edit', 'write'])];
  const messages: string[] = [];
  const customMessages: Array<{message:any; options:any}> = [];
  const flags: Record<string, string | boolean> = {};
  const entries: Array<{customType:string; data:any}> = [], entryRenderers = new Map<string, any>();
  const dispatches: Array<{text:string; args:string}> = [], sessions: Array<{ctx:any; name?:string}> = [], sessionNames: string[] = [];
  const modelChoices: any[] = [], thinkingChoices: any[] = [];
  let compactions = 0, contextPercent: number | null = null, sessionCounter = 0, commandContext: any, dispatchChain: Promise<unknown> = Promise.resolve();
  const api = {
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    registerCommand: (name: string, command: any) => { commands.set(name, command); },
    registerShortcut: (key: string, shortcut: any) => { shortcuts.set(key, shortcut); },
    registerFlag: (name: string) => { flags[name] = flags[name] ?? ''; },
    getFlag: (name: string) => flags[name] === '' ? undefined : flags[name],
    on: (event: string, handler: any) => { const list = events.get(event) ?? []; list.push(handler); events.set(event, list); },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    sendUserMessage: (text: string, sendOptions?: {deliverAs?: string; expandPromptTemplates?: boolean}) => {
      const value = Array.isArray(text) ? '' : String(text);
      // P18.1: a command dispatch is not a user message. It runs the registered handler in the bound command context, and
      // the handler's replacement session is what sends the round prompt. Without a bound context the dispatch throws, which
      // is the same failure the extension falls back from on an older host.
      if (sendOptions?.expandPromptTemplates && value.startsWith('/')) {
        const space = value.indexOf(' '), name = value.slice(1, space < 0 ? undefined : space), args = space < 0 ? '' : value.slice(space + 1);
        const command = commands.get(name);
        if (!command || !commandContext) throw new Error(`Command dispatch unavailable: /${name}`);
        dispatches.push({ text: value, args });
        dispatchChain = dispatchChain.then(() => command.handler(args, commandContext)).catch(() => {});
        return;
      }
      messages.push(value);
    },
    sendMessage: (message:any, options:any) => {customMessages.push({message,options});},
    setSessionName: (name: string) => { sessionNames.push(name); if (sessions.length) sessions.at(-1)!.name = name; },
    setModel: async (model: any) => { modelChoices.push(model); return true; },
    setThinkingLevel: (level: any) => { thinkingChoices.push(level); },
    compact: () => { compactions += 1; },
    appendEntry: (customType:string, data:any) => { entries.push({customType,data}); },
    registerEntryRenderer: (customType:string, renderer:any) => { entryRenderers.set(customType,renderer); },
  } as unknown as ExtensionAPI;
  const bind = (ctx: ExtensionCommandContext) => {
    commandContext = ctx;
    const session = ctx as any;
    if (typeof session.newSession === 'function') return;
    session.getContextUsage = () => contextPercent === null ? undefined : { tokens: Math.round(contextPercent), contextWindow: 100, percent: contextPercent };
    session.compact = () => { compactions += 1; };
    // The replaced context is a live view of the same extension state (ui, model registry, abort signal) with its own session
    // identity and message senders, so a rebind in `withSession` behaves like Pi's ReplacedSessionContext.
    const replaced = (id: string) => {
      const view: any = Object.create(session);
      view.sessionManager = { getSessionId: () => id, getBranch: () => [] };
      view.sendUserMessage = (text: string, sendOptions?: any) => api.sendUserMessage(text, sendOptions);
      view.sendMessage = (message: any, sendOptions: any) => api.sendMessage(message, sendOptions);
      return view;
    };
    session.newSession = async (sessionOptions: { setup?: (sessionManager: any) => Promise<void>; withSession?: (ctx: any) => Promise<void> } = {}) => {
      for (const handler of events.get('session_before_switch') ?? []) {
        const result = await handler({ type: 'session_before_switch', reason: 'new' }, session);
        if (result?.cancel === true || result?.cancelled === true) return { cancelled: true };
      }
      // Pi tears the outgoing session down (session_shutdown with the replacement's reason) before the new one exists.
      for (const handler of events.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'new' }, session);
      sessionCounter += 1;
      const replacedCtx = replaced(`session-${sessionCounter}`);
      if (sessionOptions.setup) await sessionOptions.setup({ setSessionName: () => {}, getSessionId: () => `session-${sessionCounter}` });
      sessions.push({ ctx: replacedCtx });
      // P18.1/D45: a real host re-runs the extension factory for the replacement and fires session_start("new") before
      // withSession. The fake keeps one instance, but firing the same event is what lets the extension restore its boundary.
      for (const handler of events.get('session_start') ?? []) await handler({ type: 'session_start', reason: 'new' }, replacedCtx);
      try { if (sessionOptions.withSession) await sessionOptions.withSession(replacedCtx); }
      finally { commandContext = replacedCtx; }
      return { cancelled: false };
    };
  };
  const fake: FakePi = {
    pi: api, tools, commands, events, shortcuts, get active() { return active; }, messages, customMessages, flags, entries, entryRenderers,
    dispatches, sessions, sessionNames, modelChoices, thinkingChoices, get compactions() { return compactions; },
    bind, setContextPercent: (percent: number | null) => { contextPercent = percent; },
    allowWorkerFlag: (value: string) => { flags['p2o-worker'] = value; },
  } as FakePi;
  Object.defineProperty(fake, 'active', { get: () => active });
  return fake;
}

export interface FakeContext {
  ctx: ExtensionCommandContext;
  notices: string[];
  dialogs: string[];
  confirmBodies: string[];
  aborts: number;
  waitForIdleCalls: number;
  screens: any[];
  overlays: Array<{ component: any; options: any; handle: any }>;
  widgets: Map<string, any>;
  renderRequests: number;
  setConfirm: (value: boolean) => void;
  setIdle: (value: boolean) => void;
  setPendingMessages: (value: boolean) => void;
  setContextUsage: (percent: number | null) => void;
  /** P18.6/D50: the models `ctx.modelRegistry.find` may resolve; the extension resolves a routed id through this. */
  setModels: (list: Array<{ provider: string; id: string }>) => void;
}

export function createContext(options: { cwd: string; hasUI?: boolean; model?: { provider: string; id: string } | null; confirm?: boolean } ): FakeContext {
  const notices: string[] = []; const dialogs: string[] = [], confirmBodies:string[] = [];
  let confirmed = options.confirm ?? true;
  let idle = true, pendingMessages = false, contextPercent: number | null = null;
  let aborts = 0; let waitForIdleCalls = 0, renderRequests = 0;
  const models: Array<{ provider: string; id: string; [key: string]: unknown }> = [];
  const screens: any[] = [], overlays: Array<{ component: any; options: any; handle: any }> = [], widgets = new Map<string, any>();
  const controller = new AbortController();
  const tui = { requestRender: () => { renderRequests += 1; } };
  const ctx = {
    cwd: options.cwd, hasUI: options.hasUI ?? true, mode: 'tui',
    model: options.model === undefined ? { provider: 'p2o-inert', id: 'current-agent' } : options.model,
    thinkingLevel: 'off',
    ui: {
      notify: (text: string) => { notices.push(text); },
      confirm: async (title: string, body?: string) => { dialogs.push(title); confirmBodies.push(body ?? ''); return confirmed; },
      setStatus: () => {},
      setWidget: (key:string, value:any) => { if (value === undefined) widgets.delete(key); else widgets.set(key,value); },
      custom: async (factory:any, custOptions?: any) => {
        const component = await factory(tui, {}, {}, () => {});
        if (custOptions?.overlay) {
          let hidden = false;
          const handle = { hide: () => { hidden = true; }, setHidden: (v: boolean) => { hidden = v; }, isHidden: () => hidden, focus: () => {}, unfocus: () => {}, isFocused: () => false, getBounds: () => undefined };
          overlays.push({ component, options: custOptions, handle });
          custOptions.onHandle?.(handle);
        } else screens.push(component);
      },
    },
    abort: () => { aborts += 1; controller.abort(); },
    waitForIdle: async () => { waitForIdleCalls += 1; },
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    getContextUsage: () => contextPercent === null ? undefined : { tokens: Math.round(contextPercent), contextWindow: 100, percent: contextPercent },
    signal: controller.signal,
    // P18.6/D50: routing resolves a configured `provider/model` id through this registry, exactly as the host's does.
    modelRegistry: {
      find: (provider: string, id: string) => models.find(entry => entry.provider === provider && entry.id === id),
      getAll: () => [...models],
      getAvailable: () => [...models],
    },
    sessionManager: { getBranch: () => [], getSessionId: () => 'session-0' },
  } as unknown as ExtensionCommandContext;
  return {
    ctx, notices, dialogs, confirmBodies, screens, overlays, widgets, get renderRequests() { return renderRequests; }, get aborts() { return aborts; }, get waitForIdleCalls() { return waitForIdleCalls; },
    setConfirm: (value: boolean) => { confirmed = value; },
    setIdle: (value: boolean) => {idle=value;},
    setPendingMessages: (value: boolean) => { pendingMessages = value; },
    setContextUsage: (percent: number | null) => { contextPercent = percent; },
    setModels: (list: Array<{ provider: string; id: string }>) => { models.splice(0, models.length, ...list); },
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
