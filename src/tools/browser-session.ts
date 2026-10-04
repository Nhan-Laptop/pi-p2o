import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PackCreationFence, samePackScope, type PackSessionLifecycle } from './pack-session.js';
import { currentProcessIdentity, terminateBrowserOwner, writeBrowserOwner, type BrowserOwnerRecord } from './browser-lifecycle.js';
import { captureIdentity, LinuxProcessProbe, ProcessFamily, sameProcess } from '../runtime/processes.js';
import { checkCancelled, invariant, PolicyError, type PolicyErrorCode } from '../policy/errors.js';
import { deepFreeze, text } from '../policy/validation.js';
import type { Capability, Policy, TargetBudget, ToolContext } from '../policy/index.js';
import { connectCdp, isJsonObject, type CdpClient, type CdpEvent } from './browser-cdp.js';
import { BrowserRequestGate, type NetworkEntry } from './browser-gate.js';
import { chromeIdentityDigest, verifyChromeIdentity, type ChromeIdentity } from './browser-identity.js';
import { startEgressProxy, type EgressProxy, type EgressProxyFactory } from './browser-proxy.js';
import { sha256 } from './redaction.js';
import type { ExecutionSandbox, HostBrowserBoundary } from './sandbox.js';
import type { ToolDescriptor } from './types.js';

export const BROWSER_SESSION_ACTIONS = ['open', 'close', 'status'] as const;
export const BROWSER_ACT_ACTIONS = ['navigate', 'snapshot', 'click', 'fill', 'type', 'press', 'select', 'extract_text', 'extract_html', 'screenshot', 'back', 'tabs'] as const;
export type BrowserSessionAction = typeof BROWSER_SESSION_ACTIONS[number];
export type BrowserActAction = typeof BROWSER_ACT_ACTIONS[number];
export interface BrowserSessionInput { readonly action: BrowserSessionAction; readonly browserId?: string; readonly url?: string; readonly accountId?: string }
export interface BrowserActInput { readonly browserId: string; readonly action: BrowserActAction; readonly url?: string; readonly ref?: string; readonly text?: string; readonly value?: string; readonly key?: string; readonly waitMs?: number }
export type BrowserInput = BrowserSessionInput | BrowserActInput;

export interface BrowserChromeEvidence { readonly version: string; readonly product: string; readonly binarySha256: string; readonly identityDigest: string }
export interface BrowserBudgetEvidence { readonly actions: number; readonly actionsMax: number; readonly requests: number; readonly requestsMax: number }
export interface BrowserRef { readonly ref: string; readonly role: string; readonly name: string }
export interface BrowserSnapshot { readonly digest: string; readonly lines: number; readonly text: string }
export interface BrowserDomEvidence { readonly digest: string; readonly bytes: number; readonly truncated: string }
export interface BrowserExtraction { readonly mediaType: 'text/plain' | 'text/html'; readonly text: string; readonly bytes: number; readonly truncated: string }
export interface BrowserScreenshot { readonly path: string; readonly sha256: string; readonly bytes: number; readonly mediaType: 'image/png' }
export interface BrowserTab { readonly index: number; readonly url: string; readonly title: string; readonly active: string }
export interface BrowserNetworkEvidence { readonly entries: readonly NetworkEntry[]; readonly total: number; readonly allowed: number; readonly blocked: number; readonly dropped: number; readonly refused: string }
export interface BrowserSessionEvidence {
  readonly kind: 'browser-session'; readonly status: 'open' | 'closed'; readonly browserId: string;
  readonly origin: string; readonly url: string; readonly title: string;
  readonly chrome: BrowserChromeEvidence; readonly budget: BrowserBudgetEvidence;
  readonly isolation: string; readonly limits: readonly string[];
}
export interface BrowserActEvidence {
  readonly kind: 'browser-action'; readonly browserId: string; readonly action: BrowserActAction;
  readonly url: string; readonly title: string; readonly dom: BrowserDomEvidence;
  readonly network: BrowserNetworkEvidence; readonly budget: BrowserBudgetEvidence;
  readonly changed?: string; readonly refs?: readonly BrowserRef[]; readonly snapshot?: BrowserSnapshot;
  readonly extraction?: BrowserExtraction; readonly screenshot?: BrowserScreenshot; readonly tabs?: readonly BrowserTab[];
  readonly limits: readonly string[];
}
export type BrowserEvidence = BrowserSessionEvidence | BrowserActEvidence;

export interface BrowserPackExecutionInput {
  context: ToolContext;
  capability: Capability;
  input: unknown;
  descriptor: ToolDescriptor;
  signal?: AbortSignal;
  touchedTargets: Set<string>;
}
export interface BrowserPackOptions {
  policy: Policy;
  budgets: TargetBudget;
  sandbox: ExecutionSandbox;
  resolver: (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;
  sessionTtlMs?: number;
  launchTimeoutMs?: number;
  captureTimeoutMs?: number;
  maxScreenshotBytes?: number;
  maxExtractBytes?: number;
  maxSnapshotNodes?: number;
  /** [B2] Optional capture-capable egress proxy; the interception pack supplies one so browser traffic is recorded. */
  egressProxy?: EgressProxyFactory;
  maxTabs?: number;
  /** Explicit runtime enrollment + fence (no ambient/default registration). */
  lifecycle?: PackSessionLifecycle;
}
export interface BrowserPack {
  /** Broker-side dispatch authorization target for a browser capability call. */
  authorizeTarget(capability: Capability, input: unknown): { url: string; method: string; accountId: string };
  execute(execution: BrowserPackExecutionInput): Promise<BrowserEvidence>;
  /** Attempt-release hook: kills every session owned by the attempt and tombstones it. */
  releaseAttempt(context: Pick<ToolContext, 'runId' | 'taskId' | 'attemptId'>): Promise<number>;
  outstanding(context: Pick<ToolContext, 'runId' | 'taskId' | 'attemptId'>): number;
  close(): Promise<void>;
  inspect(sessionId: string): { network: readonly NetworkEntry[]; blocked: readonly NetworkEntry[]; proxyBlocked: number; proxyErrors: number; chromeVersion: string; pid: number; profile: string; proxyPort: number; endpoint: string } | undefined;
  readonly sessions: number;
}

interface AxNode { readonly ignored?: boolean; readonly role?: unknown; readonly name?: unknown; readonly value?: unknown; readonly backendDOMNodeId?: number }
interface Session {
  readonly id: string;
  readonly context: ToolContext;
  readonly accountId: string;
  readonly origin: string;
  targetId: string;
  readonly identity: ChromeIdentity;
  readonly identityDigest: string;
  readonly child: ChildProcess;
  readonly pid: number;
  readonly profile: string;
  readonly owner: BrowserOwnerRecord;
  teardown?: Promise<void>;
  readonly cdp: CdpClient;
  cdpSessionId: string;
  pageTargetId: string;
  readonly proxy: EgressProxy;
  readonly gate: BrowserRequestGate;
  expiresAt: number;
  actionsUsed: number;
  closed: boolean;
  url: string;
  title: string;
  refs: Map<string, number>;
  monotonic: Map<string, number>;
  busy: Promise<unknown>;
  watchdog: ReturnType<typeof setInterval>;
}
interface Tombstone { readonly id: string; readonly context: ToolContext; readonly url: string; readonly accountId: string; readonly closedAt: number; readonly reason: string }

const LIMITS = Object.freeze([
  'Host browser on the host kernel with a pinned Chrome binary and a throwaway profile: this is NOT container isolation and is never reported as one.',
  'Every navigation and every subresource/websocket request is authorized by policy at the CDP Fetch layer; non-scope requests are failed before egress.',
  'A mandatory loopback egress proxy refuses any connection the CDP layer did not authorize, pins the resolved address, and charges the target request/byte budget.',
  'Sessions are bound to one attempt, expire with the grant/authorization, and are killed on release, dead line or owner failure; a stale session is never reusable.',
  'Screenshots are bounded PNG bytes in the private artifact root with a recorded digest; they are not text-redacted and are explicitly marked redacted:false.',
  'Only anonymous approved accounts; broker-held credentials, downloads, extensions, the host profile and the host HOME are never used.',
]);
const SKIPPED_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'ListMarker', 'none']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'tab', 'slider', 'spinbutton', 'switch', 'textarea']);
const KEY_EVENTS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
/**
 * Signal the whole browser process group. Chrome's launcher `exec`s the browser (same pid), but it still
 * forks zygote/renderer/utility children that can outlive a lone SIGTERM and keep writing to the profile
 * after cleanup; the session spawns the browser as a group leader so the group can be signalled as one.
 */
const browserOwners = new WeakMap<ChildProcess, BrowserOwnerRecord>();
function signalBrowser(child: ChildProcess, signal: NodeJS.Signals): void {
  const owner = browserOwners.get(child);
  if (!owner?.process) return;
  const current = captureIdentity(owner.process.pid, owner.process.bootId);
  if (!current || !sameProcess(current, owner.process)) return;
  try { process.kill(current.pgid === current.pid ? -current.pid : current.pid, signal); } catch { /* already gone; no blind fallback */ }
}
const valueOf = (field: unknown): string => {
  if (isJsonObject(field) && typeof field.value === 'string') return field.value;
  return '';
};
const nodeSuffix = (node: AxNode): string => {
  const value = valueOf(node.value);
  return value ? ` value="${value.slice(0, 120)}"` : '';
};
/** Chrome runs with an empty host environment, a throwaway profile and disabled background services. */
function chromeArgs(profile: string, proxyUrl: string, sessionId: string): string[] {
  return [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--p2o-session-id=${sessionId}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-component-extensions-with-background-pages',
    '--disable-component-update', '--disable-background-networking', '--disable-sync', '--disable-translate', '--disable-default-apps',
    '--disable-domain-reliability', '--disable-client-side-phishing-detection', '--disable-breakpad', '--disable-crash-reporter',
    '--metrics-recording-only', '--no-pings', '--no-service-autorun', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio',
    '--hide-scrollbars', '--window-size=1280,720', '--dns-prefetch-disable', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-features=Translate,MediaRouter,OptimizationHints,OptimizationGuideModelDownloading,BackForwardCache,InterestFeedContentSuggestions,NetworkTimeServiceQuerying,SegmentationPlatform,PreconnectToSearch',
    `--proxy-server=${proxyUrl}`, '--proxy-bypass-list=<-loopback>', 'about:blank',
  ];
}

/**
 * One process-level exit hook for every live browser process of every pack: a graceful controller exit
 * kills the browsers synchronously (an ungraceful SIGKILL exit is recovered by the pid-file sweep on the
 * next run). Keeping it module-level avoids one `exit` listener per pack.
 */
const liveBrowsers = new Set<ChildProcess>();
let exitHooked = false;
function hookExit(child: ChildProcess): void {
  liveBrowsers.add(child);
  child.once('exit', () => liveBrowsers.delete(child));
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => { for (const browser of liveBrowsers) signalBrowser(browser, 'SIGKILL'); });
}

export function createBrowserPack(options: BrowserPackOptions): BrowserPack {
  const sessions = new Map<string, Session>();
  const tombstones = new Map<string, Tombstone>();
  let closed = false;

  const boundary = (): HostBrowserBoundary => {
    const browser = options.sandbox.browser;
    invariant(browser && browser.enabled === true, 'UNAVAILABLE', 'Browser capabilities require an explicitly acknowledged host-browser sandbox');
    return browser;
  };
  const creation = new PackCreationFence(options.lifecycle);
  let closing: Promise<void> | undefined;
  const releases = new Map<string, Promise<number>>();

  const forget = (session: Session, reason: string): void => {
    if (session.closed) return;
    session.closed = true;
    clearInterval(session.watchdog);
    sessions.delete(session.id);
    tombstones.set(session.id, { id: session.id, context: { ...session.context }, url: session.url, accountId: session.accountId, closedAt: Date.now(), reason });
    if (tombstones.size > 64) { const first = tombstones.keys().next().value; if (first !== undefined) tombstones.delete(first); }
  };
  const kill = (session: Session, reason: string): Promise<void> => {
    if (session.teardown) return session.teardown;
    session.closed = true; // deny actions immediately, but retain attribution until absence is proved
    clearInterval(session.watchdog);
    session.teardown = (async () => {
      const failures: unknown[] = [];
      try { session.cdp.close(); } catch (error) { failures.push(error); }
      try { await session.proxy.close(); } catch (error) { failures.push(error); }
      try { await terminateBrowserOwner(session.owner); } catch (error) { failures.push(error); }
      if (failures.length) throw new Error(`Browser session teardown is unverified: ${failures.map(String).join('; ')}`);
      await options.lifecycle?.resolve(session.context, session.id);
      session.closed = false; // forget owns the final tombstone/public count transition
      forget(session, reason);
    })().catch(error => { session.teardown = undefined; throw error; });
    return session.teardown;
  };
  const requireOwnership = (context: ToolContext, sessionId: string): { session?: Session; tombstone?: Tombstone } => {
    const session = sessions.get(sessionId);
    if (session) {
      const same = session.context.runId === context.runId && session.context.taskId === context.taskId && session.context.attemptId === context.attemptId;
      invariant(same, 'IDENTITY_DENIED', 'Browser session belongs to a different attempt');
      return { session };
    }
    const tombstone = tombstones.get(sessionId);
    invariant(tombstone, 'INVALID_INPUT', 'Unknown browser session');
    const same = tombstone.context.runId === context.runId && tombstone.context.taskId === context.taskId && tombstone.context.attemptId === context.attemptId;
    invariant(same, 'IDENTITY_DENIED', 'Browser session belonged to a different attempt and cannot be reused');
    return { tombstone };
  };
  const assertLive = (session: Session): void => {
    invariant(!closed, 'UNAVAILABLE', 'Browser pack is closed');
    invariant(!session.closed && sessions.has(session.id), 'UNAVAILABLE', 'Browser session is no longer live');
    invariant(Date.now() < session.expiresAt, 'EXPIRED', 'Browser session lifetime expired');
    options.policy.assertActive(session.context); // grant/attempt deadline is the session deadline
    invariant(!session.cdp.closed, 'UNAVAILABLE', 'Browser session transport is closed');
  };

  async function launch(identity: ChromeIdentity, profileRoot: string, launchTimeoutMs: number, proxyUrl: string, sessionId: string, context: ToolContext): Promise<{ child: ChildProcess; profile: string; wsUrl: string; pid: number; owner: BrowserOwnerRecord }> {
    const profile = await mkdtemp(join(profileRoot, 'p2o-browser-'));
    const owner: BrowserOwnerRecord = { version: 2, sessionId, profile, scope: { runId: context.runId, taskId: context.taskId, attemptId: context.attemptId }, controller: currentProcessIdentity() };
    let child: ChildProcess | undefined;
    try {
      await options.lifecycle?.update(context, sessionId, { ...owner });
      writeBrowserOwner(owner);
      await creation.check(context);
      child = spawn(identity.launcher, chromeArgs(profile, proxyUrl, sessionId), {
        stdio: ['ignore', 'ignore', 'ignore'], detached: true,
        env: { PATH: '/usr/bin:/bin', HOME: profile, XDG_DATA_HOME: join(profile, 'xdg-data'), XDG_CONFIG_HOME: join(profile, 'xdg-config'), XDG_CACHE_HOME: join(profile, 'xdg-cache') },
      });
      invariant(child.pid, 'UNAVAILABLE', 'Browser process could not be started');
      owner.process = currentProcessIdentity(child.pid);
      browserOwners.set(child, owner);
      writeBrowserOwner(owner);
      hookExit(child);
      await options.lifecycle?.update(context, sessionId, { ...owner });
      const portFile = join(profile, 'DevToolsActivePort');
      const deadline = performance.now() + launchTimeoutMs;
      while (!existsSync(portFile)) {
        await creation.check(context);
        invariant(child.exitCode === null && child.signalCode === null, 'UNAVAILABLE', 'Browser process exited before its debugging endpoint was ready');
        invariant(performance.now() < deadline, 'TIMEOUT', 'Browser debugging endpoint was not ready in time');
        await sleep(50);
      }
      const contents = (await readFile(portFile, 'utf8')).split('\n');
      const port = Number(contents[0]), wsPath = (contents[1] ?? '').trim();
      invariant(Number.isInteger(port) && port > 0 && port <= 65535, 'UNAVAILABLE', 'Browser debugging endpoint reported an invalid port');
      invariant(/^\/devtools\/browser\/[a-f0-9-]{8,}$/.test(wsPath), 'UNAVAILABLE', 'Browser debugging endpoint reported an invalid path');
      owner.endpoint = `ws://127.0.0.1:${port}${wsPath}`;
      const family = new ProcessFamily(new LinuxProcessProbe(), [owner.process]);
      await family.inspect(); owner.processes = family.identities();
      writeBrowserOwner(owner);
      await options.lifecycle?.update(context, sessionId, { ...owner });
      await creation.check(context);
      return { child, profile, wsUrl: owner.endpoint, pid: child.pid, owner };
    } catch (error) {
      // The caller enrolled this session BEFORE launch, so proved absence retires the durable record even
      // when the first identity update failed mid-flight. An unverified teardown stays enrolled for retry.
      await terminateBrowserOwner(owner);
      if (options.lifecycle) await options.lifecycle.resolve(context, sessionId);
      throw error;
    }
  }

  function attachNetworkLog(session: Session): void {
    session.cdp.on((event: CdpEvent) => {
      if (event.sessionId !== session.cdpSessionId) return;
      const params = event.params;
      const requestId = typeof params.requestId === 'string' ? params.requestId : undefined;
      if (!requestId) return;
      switch (event.method) {
        case 'Fetch.requestPaused': {
          const request = isJsonObject(params.request) ? params.request : {};
          const url = typeof request.url === 'string' ? request.url : '';
          const method = typeof request.method === 'string' ? request.method : 'GET';
          const resourceType = typeof params.resourceType === 'string' ? params.resourceType : 'Other';
          void (async () => {
            let check;
            try { await creation.check(session.context); check = await session.gate.check(url, method, resourceType, { requestId, signal: undefined }); }
            catch { check = { allowed: false, reason: 'CANCELLED' } as const; }
            try {
              if (check.allowed) await session.cdp.send('Fetch.continueRequest', { requestId }, session.cdpSessionId);
              else await session.cdp.send('Fetch.failRequest', { requestId, errorReason: check.reason === 'CANCELLED' ? 'Aborted' : 'BlockedByClient' }, session.cdpSessionId);
            } catch { /* the request may already be gone with its frame */ }
          })();
          return;
        }
        case 'Fetch.authRequired':
          void session.cdp.send('Fetch.continueWithAuth', { requestId, authChallengeResponse: { response: 'CancelAuth' } }, session.cdpSessionId).catch(() => {});
          return;
        case 'Network.requestWillBeSent': {
          const redirect = isJsonObject(params.redirectResponse) ? params.redirectResponse : undefined;
          const request = isJsonObject(params.request) ? params.request : {};
          const url = typeof request.url === 'string' ? request.url : '';
          const method = isJsonObject(params.request) && typeof params.request.method === 'string' ? params.request.method : 'GET';
          const type = typeof params.type === 'string' ? params.type : 'Other';
          if (redirect) session.gate.recordRedirect(requestId, url || String(redirect.url ?? ''), typeof redirect.status === 'number' ? redirect.status : 0);
          session.gate.recordRequestStarted(requestId, { method, url, resourceType: type });
          session.monotonic.set(requestId, Date.now());
          return;
        }
        case 'Network.responseReceived': {
          const response = isJsonObject(params.response) ? params.response : {};
          const started = session.monotonic.get(requestId);
          const ms = typeof started === 'number' ? Math.max(0, Date.now() - started) : undefined;
          session.gate.recordResponse(requestId, typeof response.status === 'number' ? response.status : 0, undefined, ms);
          return;
        }
        case 'Network.loadingFinished': {
          const bytes = typeof params.encodedDataLength === 'number' ? params.encodedDataLength : undefined;
          const started = session.monotonic.get(requestId);
          session.gate.recordFinished(requestId, bytes, typeof started === 'number' ? Math.max(0, Date.now() - started) : undefined);
          session.monotonic.delete(requestId);
          return;
        }
        case 'Network.loadingFailed':
          session.gate.recordFailed(requestId, typeof params.errorText === 'string' ? params.errorText : 'failed');
          return;
        case 'Page.javascriptDialogOpening':
          void session.cdp.send('Page.handleJavaScriptDialog', { accept: false }, session.cdpSessionId).catch(() => {});
          return;
        case 'Page.frameNavigated': {
          const frame = isJsonObject(params.frame) ? params.frame : {};
          if (frame.parentId === undefined && typeof frame.url === 'string' && /^https?:/i.test(frame.url)) session.url = frame.url;
          return;
        }
        default: return;
      }
    });
  }

  async function setupSession(session: Session, signal?: AbortSignal): Promise<void> {
    const version = await session.cdp.send<{ product?: unknown; protocolVersion?: unknown }>('Browser.getVersion');
    invariant(typeof version.product === 'string' && version.product.includes(session.identity.version), 'UNAVAILABLE', 'Runtime browser product does not match the pinned identity');
    invariant(version.product.startsWith('Chrome/') || version.product.startsWith('HeadlessChrome/'), 'UNAVAILABLE', 'Runtime browser product is not the pinned Chrome build');
    const created = await session.cdp.send<{ targetId?: unknown }>('Target.createTarget', { url: 'about:blank' });
    invariant(typeof created.targetId === 'string', 'UNAVAILABLE', 'Browser could not create a page target');
    const attached = await session.cdp.send<{ sessionId?: unknown }>('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    invariant(typeof attached.sessionId === 'string', 'UNAVAILABLE', 'Browser could not attach to the page target');
    checkCancelled(signal);
    for (const domain of ['Page.enable', 'Network.enable', 'Runtime.enable', 'DOM.enable', 'Accessibility.enable']) await session.cdp.send(domain, {}, attached.sessionId);
    await session.cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }, { urlPattern: 'ws://*' }, { urlPattern: 'wss://*' }] }, attached.sessionId);
    try { await session.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }); } catch { /* not supported on every build; downloads still cannot escape the pinned scope */ }
    session.cdpSessionId = attached.sessionId;
    session.pageTargetId = created.targetId;
  }

  async function evaluate(session: Session, expression: string, signal?: AbortSignal): Promise<unknown> {
    checkCancelled(signal);
    const result = await session.cdp.send<{ result?: unknown; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, session.cdpSessionId);
    invariant(!result.exceptionDetails, 'UNAVAILABLE', 'Page evaluation failed');
    return isJsonObject(result.result) ? result.result.value : undefined;
  }
  async function refreshState(session: Session, signal?: AbortSignal): Promise<void> {
    const raw = await evaluate(session, 'JSON.stringify({ url: location.href, title: document.title || "" })', signal);
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as { url?: unknown; title?: unknown };
        if (typeof parsed.url === 'string' && parsed.url.length <= 8192) session.url = parsed.url;
        if (typeof parsed.title === 'string') session.title = parsed.title.slice(0, 512);
      } catch { /* keep the previous observation */ }
    }
  }
  async function waitForLoad(session: Session, signal?: AbortSignal, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      checkCancelled(signal);
      const state = await evaluate(session, 'document.readyState', signal).catch(() => undefined);
      if (state === 'complete' || state === 'interactive') return;
      invariant(Date.now() < deadline, 'TIMEOUT', 'Page did not finish loading in time');
      await sleep(50);
    }
  }
  async function navigate(session: Session, url: string, signal?: AbortSignal): Promise<void> {
    const probe = await session.gate.probe(url, 'GET', signal);
    if (!probe.allowed) throw new PolicyError(probe.reason, probe.detail);
    const started = Date.now();
    const result = await session.cdp.send<{ errorText?: unknown }>('Page.navigate', { url: probe.url }, session.cdpSessionId);
    if (typeof result.errorText === 'string' && result.errorText.length > 0) {
      const blocked = session.gate.inspectBlocked(1)[0];
      if (blocked && Date.now() - started < 15000) throw new PolicyError((blocked.reason ?? 'TARGET_DENIED') as PolicyErrorCode, 'Navigation was refused by the scope gate');
      throw new PolicyError('UNAVAILABLE', 'Navigation failed');
    }
    await waitForLoad(session, signal);
    await refreshState(session, signal);
  }

  async function domDigest(session: Session, signal?: AbortSignal): Promise<BrowserDomEvidence> {
    const raw = await evaluate(session, 'document.documentElement ? document.documentElement.outerHTML : ""', signal);
    const html = typeof raw === 'string' ? raw : '';
    const bytes = Buffer.byteLength(html);
    const limit = 262144;
    const clipped = html.slice(0, limit);
    return { digest: sha256(clipped), bytes, truncated: html.length > limit ? 'yes' : 'no' };
  }
  async function snapshot(session: Session, signal?: AbortSignal): Promise<{ snapshot: BrowserSnapshot; refs: BrowserRef[] }> {
    const response = await session.cdp.send<{ nodes?: unknown }>('Accessibility.getFullAXTree', {}, session.cdpSessionId);
    checkCancelled(signal);
    const nodes = Array.isArray(response.nodes) ? response.nodes as AxNode[] : [];
    const maxNodes = options.maxSnapshotNodes ?? 250;
    const lines: string[] = [];
    const refs: BrowserRef[] = [];
    const next = new Map<string, number>();
    for (const node of nodes) {
      if (refs.length >= maxNodes) break;
      if (node.ignored === true) continue;
      const role = valueOf(node.role);
      if (!role || SKIPPED_ROLES.has(role)) continue;
      const name = valueOf(node.name);
      if (!name && !INTERACTIVE_ROLES.has(role)) continue;
      const ref = `@e${refs.length + 1}`;
      if (typeof node.backendDOMNodeId === 'number') next.set(ref, node.backendDOMNodeId);
      lines.push(`${ref} [${role}] "${name.slice(0, 120)}"${nodeSuffix(node)}`);
      refs.push({ ref, role, name: name.slice(0, 160) });
    }
    session.refs = next;
    const text_ = lines.join('\n').slice(0, 8192);
    return { snapshot: { digest: sha256(text_), lines: refs.length, text: text_ }, refs };
  }
  async function resolveRef(session: Session, ref: string): Promise<string> {
    const backendNodeId = session.refs.get(ref);
    invariant(typeof backendNodeId === 'number', 'INVALID_INPUT', 'Unknown or stale snapshot ref; take a fresh snapshot');
    const resolved = await session.cdp.send<{ object?: unknown }>('DOM.resolveNode', { backendNodeId }, session.cdpSessionId);
    const object = isJsonObject(resolved.object) ? resolved.object : {};
    invariant(typeof object.objectId === 'string', 'INVALID_INPUT', 'Snapshot ref is no longer attached to the document');
    return object.objectId;
  }
  async function callOn(session: Session, objectId: string, declaration: string, args: unknown[] = []): Promise<unknown> {
    const response = await session.cdp.send<{ result?: unknown; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
      objectId, functionDeclaration: declaration, returnByValue: true,
      arguments: args.map(value => ({ value })),
    }, session.cdpSessionId);
    invariant(!response.exceptionDetails, 'UNAVAILABLE', 'Page element action failed');
    return isJsonObject(response.result) ? response.result.value : undefined;
  }

  function chromeEvidence(session: Session): BrowserChromeEvidence {
    return { version: session.identity.version, product: session.identity.product, binarySha256: session.identity.executableSha256, identityDigest: session.identityDigest };
  }
  function budgetEvidence(session: Session): BrowserBudgetEvidence {
    const browser = boundary();
    return { actions: session.actionsUsed, actionsMax: browser.maxActionsPerSession, requests: session.gate.requestCount, requestsMax: browser.maxRequestsPerSession };
  }
  function networkEvidence(session: Session): BrowserNetworkEvidence {
    const summary = session.gate.summary(24);
    return { entries: summary.entries, total: summary.total, allowed: summary.allowed, blocked: summary.blocked, dropped: summary.dropped, refused: summary.refused ? 'yes' : 'no' };
  }
  function sessionEvidence(session: Session, status: 'open' | 'closed'): BrowserSessionEvidence {
    return deepFreeze({
      kind: 'browser-session' as const, status, browserId: session.id, origin: session.origin, url: session.url, title: session.title,
      chrome: chromeEvidence(session), budget: budgetEvidence(session), isolation: options.sandbox.boundary, limits: LIMITS,
    });
  }

  function syncTouched(execution: BrowserPackExecutionInput, session: Session): void {
    for (const id of session.gate.touched) execution.touchedTargets.add(id);
  }
  async function open(execution: BrowserPackExecutionInput, input: BrowserSessionInput): Promise<BrowserSessionEvidence> {
    await creation.check(execution.context);
    const browser = boundary();
    invariant(!closed, 'UNAVAILABLE', 'Browser pack is closed');
    invariant(sessions.size < browser.maxSessions, 'BUDGET_EXCEEDED', 'Browser session limit reached');
    const url = text(input.url, 'url', 8192);
    const accountId = text(input.accountId, 'accountId', 128);
    const signal = execution.signal;
    checkCancelled(signal);
    const identity = browser.identity;
    await verifyChromeIdentity(identity, signal);
    const gate = new BrowserRequestGate({ policy: options.policy, sandbox: options.sandbox, context: execution.context, accountId, resolver: options.resolver, capability: 'browser.session' });
    const probe = await gate.probe(url, 'GET', signal);
    if (!probe.allowed) throw new PolicyError(probe.reason, probe.detail);
    const grant = options.policy.assertActive(execution.context);
    // The absolute bound is the grant/authorization deadline; the session TTL only starts counting once
    // the session is actually usable (after setup + first navigation), so a slow launch never eats it.
    const expiresAt = Math.min(Date.parse(grant.expiresAt), Date.parse(options.policy.scope.authorization.expiresAt));
    const id = `bs-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await options.lifecycle?.enroll(execution.context, id, { version: 2, sessionId: id, scope: { runId: execution.context.runId, taskId: execution.context.taskId, attemptId: execution.context.attemptId }, controller: currentProcessIdentity(), profile: '' });
    const proxy = options.egressProxy
      ? await options.egressProxy.start({ gate, budgets: options.budgets, context: execution.context, accountId, origin: new URL(probe.url).origin })
      : await startEgressProxy({ gate, budgets: options.budgets, maxConnections: 64 });
    let launched: Awaited<ReturnType<typeof launch>>;
    try { launched = await launch(identity, browser.profileRoot, options.launchTimeoutMs ?? 10000, proxy.url, id, execution.context); }
    catch (error) { await proxy.close(); throw error; }
    const cdp = await connectCdp(launched.wsUrl, { timeoutMs: 8000, commandTimeoutMs: options.captureTimeoutMs ?? 20000, signal }).catch(async error => {
      await proxy.close(); await terminateBrowserOwner(launched.owner); await options.lifecycle?.resolve(execution.context, id);
      throw error;
    });
    const session: Session = {
      id, context: { ...execution.context }, accountId, origin: new URL(probe.url).origin, targetId: probe.targetId,
      identity, identityDigest: chromeIdentityDigest(identity), child: launched.child, pid: launched.pid, profile: launched.profile, owner: launched.owner,
      cdp, cdpSessionId: '', pageTargetId: '', proxy, gate, expiresAt, actionsUsed: 0, closed: false,
      url: probe.url, title: '', refs: new Map(), monotonic: new Map(), busy: Promise.resolve(),
      watchdog: setInterval(() => { void expire(session).catch(() => {}); }, 1000),
    };
    session.watchdog.unref?.();
    sessions.set(id, session);
    hookExit(launched.child);
    try {
      await setupSession(session, signal);
      attachNetworkLog(session);
      await navigate(session, url, signal);
      session.expiresAt = Math.min(session.expiresAt, Date.now() + (options.sessionTtlMs ?? browser.sessionTtlMs));
      const family = new ProcessFamily(new LinuxProcessProbe(), [session.owner.process!, ...(session.owner.processes ?? [])]);
      await family.inspect(); session.owner.processes = family.identities();
      writeBrowserOwner(session.owner);
      await options.lifecycle?.update(session.context, id, { ...session.owner });
      await creation.check(execution.context);
      checkCancelled(signal);
      syncTouched(execution, session);
      return sessionEvidence(session, 'open');
    } catch (error) {
      await kill(session, 'open-failed');
      throw error;
    }
  }
  async function expire(session: Session): Promise<void> {
    if (session.closed) return;
    const expired = Date.now() >= session.expiresAt;
    let revoked = false;
    try { options.policy.assertActive(session.context); await creation.check(session.context); } catch { revoked = true; }
    if (expired || revoked) await kill(session, expired ? 'deadline' : 'grant-revoked');
  }

  async function closeSession(execution: BrowserPackExecutionInput, input: BrowserSessionInput): Promise<BrowserSessionEvidence> {
    const sessionId = text(input.browserId, 'browserId', 128);
    const found = requireOwnership(execution.context, sessionId);
    if (!found.session) {
      const tombstone = found.tombstone!;
      return deepFreeze({
        kind: 'browser-session' as const, status: 'closed' as const, browserId: tombstone.id, origin: new URL(tombstone.url).origin, url: tombstone.url, title: '',
        chrome: { version: boundary().identity.version, product: boundary().identity.product, binarySha256: boundary().identity.executableSha256, identityDigest: chromeIdentityDigest(boundary().identity) },
        budget: { actions: 0, actionsMax: boundary().maxActionsPerSession, requests: 0, requestsMax: boundary().maxRequestsPerSession },
        isolation: options.sandbox.boundary, limits: LIMITS,
      });
    }
    const session = found.session;
    syncTouched(execution, session);
    const evidence = sessionEvidence(session, 'closed');
    await kill(session, 'closed');
    return evidence;
  }
  async function status(execution: BrowserPackExecutionInput, input: BrowserSessionInput): Promise<BrowserSessionEvidence> {
    await creation.check(execution.context);
    const sessionId = text(input.browserId, 'browserId', 128);
    const found = requireOwnership(execution.context, sessionId);
    if (!found.session) return await closeSession(execution, input);
    const session = found.session;
    if (!session.closed) { try { await refreshState(session, execution.signal); } catch { /* report the last bounded observation */ } }
    syncTouched(execution, session);
    return sessionEvidence(session, session.closed ? 'closed' : 'open');
  }

  async function act(execution: BrowserPackExecutionInput, input: BrowserActInput): Promise<BrowserActEvidence> {
    const browser = boundary();
    const sessionId = text(input.browserId, 'browserId', 128);
    const found = requireOwnership(execution.context, sessionId);
    invariant(found.session, 'UNAVAILABLE', 'Browser session is closed and cannot be acted on');
    const session = found.session;
    await creation.check(execution.context);
    assertLive(session);
    invariant(!session.gate.refused, 'BUDGET_EXCEEDED', 'Session request budget exhausted');
    invariant(session.actionsUsed < browser.maxActionsPerSession, 'BUDGET_EXCEEDED', 'Session action budget exhausted');
    session.actionsUsed += 1;
    session.gate.useCapability('browser.act');
    const signal = execution.signal;
    const run = async (): Promise<BrowserActEvidence> => {
      checkCancelled(signal);
      await creation.check(execution.context);
      assertLive(session);
      const before = await domDigest(session, signal);
      const extra: { snapshot?: BrowserSnapshot; refs?: readonly BrowserRef[]; extraction?: BrowserExtraction; screenshot?: BrowserScreenshot; tabs?: readonly BrowserTab[] } = {};
      switch (input.action) {
        case 'navigate': {
          const url = text(input.url, 'url', 8192);
          await navigate(session, url, signal);
          break;
        }
        case 'snapshot': {
          const fresh = await snapshot(session, signal);
          extra.snapshot = fresh.snapshot; extra.refs = fresh.refs;
          break;
        }
        case 'click': {
          const ref = text(input.ref, 'ref', 16);
          invariant(/^@e\d{1,4}$/.test(ref), 'INVALID_INPUT', 'Invalid element ref');
          const objectId = await resolveRef(session, ref);
          await callOn(session, objectId, "function(){ this.scrollIntoView({block:'center', inline:'center'}); this.click(); return true; }");
          break;
        }
        case 'fill':
        case 'type': {
          const ref = text(input.ref, 'ref', 16);
          invariant(/^@e\d{1,4}$/.test(ref), 'INVALID_INPUT', 'Invalid element ref');
          const value = input.action === 'fill' ? text(input.value, 'value', 65536) : text(input.text, 'text', 65536);
          const objectId = await resolveRef(session, ref);
          const declaration = input.action === 'fill'
            ? "function(v){ const p = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(p, 'value').set; this.focus(); setter.call(this, v); this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true})); return this.value; }"
            : "function(v){ const p = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(p, 'value').set; this.focus(); setter.call(this, (this.value || '') + v); this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true})); return this.value; }";
          await callOn(session, objectId, declaration, [value]);
          break;
        }
        case 'press': {
          const key = text(input.key, 'key', 16);
          const mapped = KEY_EVENTS[key];
          invariant(mapped, 'INVALID_INPUT', 'Unsupported key');
          if (input.ref) {
            const objectId = await resolveRef(session, text(input.ref, 'ref', 16));
            await callOn(session, objectId, 'function(){ this.focus(); return true; }');
          }
          const base = { key: mapped.key, code: mapped.code, windowsVirtualKeyCode: mapped.windowsVirtualKeyCode, ...(mapped.text === undefined ? {} : { text: mapped.text }) };
          await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, session.cdpSessionId);
          await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, session.cdpSessionId);
          break;
        }
        case 'select': {
          const ref = text(input.ref, 'ref', 16);
          invariant(/^@e\d{1,4}$/.test(ref), 'INVALID_INPUT', 'Invalid element ref');
          const value = text(input.value, 'value', 4096);
          const objectId = await resolveRef(session, ref);
          await callOn(session, objectId, "function(v){ this.value = v; this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true})); return this.value; }", [value]);
          break;
        }
        case 'extract_text':
        case 'extract_html': {
          const limit = options.maxExtractBytes ?? 65536;
          const expression = input.action === 'extract_text' ? 'document.body ? document.body.innerText : ""' : 'document.documentElement ? document.documentElement.outerHTML : ""';
          const raw = await evaluate(session, expression, signal);
          const full = typeof raw === 'string' ? raw : '';
          const clipped = full.slice(0, limit);
          extra.extraction = { mediaType: input.action === 'extract_text' ? 'text/plain' : 'text/html', text: clipped, bytes: Buffer.byteLength(full), truncated: full.length > limit ? 'yes' : 'no' };
          break;
        }
        case 'screenshot': {
          const captured = await session.cdp.send<{ data?: unknown }>('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, session.cdpSessionId);
          invariant(typeof captured.data === 'string' && captured.data.length > 0, 'UNAVAILABLE', 'Browser did not return a screenshot');
          const png = Buffer.from(captured.data, 'base64');
          invariant(png.byteLength > 0 && png.byteLength <= (options.maxScreenshotBytes ?? 2097152), 'OUTPUT_LIMIT', 'Screenshot exceeds the bounded byte limit');
          const grant = options.policy.assertActive(execution.context);
          options.budgets.chargeArtifact(grant, png.byteLength);
          const artifact = await options.sandbox.filesystem.writeArtifactBytes(execution.context, png, signal);
          extra.screenshot = { path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes, mediaType: 'image/png' };
          break;
        }
        case 'back': {
          const history = await session.cdp.send<{ currentIndex?: unknown; entries?: unknown }>('Page.getNavigationHistory', {}, session.cdpSessionId);
          const index = typeof history.currentIndex === 'number' ? history.currentIndex : 0;
          const entries = Array.isArray(history.entries) ? history.entries : [];
          invariant(index > 0 && entries.length > 0, 'INVALID_INPUT', 'No previous history entry');
          const previous = entries[index - 1];
          const entryId = isJsonObject(previous) && typeof previous.id === 'number' ? previous.id : undefined;
          invariant(entryId !== undefined, 'UNAVAILABLE', 'Browser history entry is unavailable');
          await session.cdp.send('Page.navigateToHistoryEntry', { entryId }, session.cdpSessionId);
          await waitForLoad(session, signal);
          break;
        }
        case 'tabs': {
          const targets = await session.cdp.send<{ targetInfos?: unknown }>('Target.getTargets');
          const infos = Array.isArray(targets.targetInfos) ? targets.targetInfos : [];
          const tabs: BrowserTab[] = [];
          for (const info of infos.slice(0, options.maxTabs ?? 16)) {
            if (!isJsonObject(info) || info.type !== 'page') continue;
            tabs.push({
              index: tabs.length, url: typeof info.url === 'string' ? info.url.slice(0, 8192) : '', title: typeof info.title === 'string' ? info.title.slice(0, 512) : '',
              active: info.targetId === session.pageTargetId ? 'yes' : 'no',
            });
          }
          extra.tabs = tabs;
          break;
        }
        default: throw new PolicyError('INVALID_INPUT', 'Unsupported browser action');
      }
      await sleep(150);
      await refreshState(session, signal);
      const after = await domDigest(session, signal);
      // Refs are snapshot-scoped: any action may re-render the DOM, so stale refs are never reusable.
      if (input.action !== 'snapshot') session.refs.clear();
      await creation.check(execution.context);
      syncTouched(execution, session);
      return deepFreeze({
        kind: 'browser-action' as const, browserId: session.id, action: input.action, url: session.url, title: session.title,
        dom: after, network: networkEvidence(session), budget: budgetEvidence(session),
        ...(extra as object), changed: before.digest !== after.digest ? 'yes' : 'no', limits: LIMITS,
      });
    };
    const queued = session.busy.then(run, run);
    session.busy = queued.then(() => undefined, () => undefined);
    return await queued;
  }

  return Object.freeze({
    get sessions() { return sessions.size; },
    authorizeTarget(capability: Capability, input: unknown): { url: string; method: string; accountId: string } {
      boundary();
      if (capability === 'browser.session') {
        const parsed = input as BrowserSessionInput;
        if (parsed.action === 'open') return { url: text(parsed.url, 'url', 8192), method: 'GET', accountId: text(parsed.accountId, 'accountId', 128) };
        const sessionId = text(parsed.browserId, 'browserId', 128);
        const found = sessions.get(sessionId) ?? tombstones.get(sessionId);
        invariant(found, 'INVALID_INPUT', 'Unknown browser session');
        return { url: found.url, method: 'GET', accountId: found.accountId };
      }
      invariant(capability === 'browser.act', 'CAPABILITY_DENIED', 'Not a browser capability');
      const parsed = input as BrowserActInput;
      const sessionId = text(parsed.browserId, 'browserId', 128);
      const session = sessions.get(sessionId);
      invariant(session && !session.closed, 'UNAVAILABLE', 'Browser session is not live');
      return { url: session.url, method: 'GET', accountId: session.accountId };
    },
    async execute(execution: BrowserPackExecutionInput): Promise<BrowserEvidence> {
      invariant(execution.capability === 'browser.session' || execution.capability === 'browser.act', 'CAPABILITY_DENIED', 'Not a browser capability');
      if (execution.capability === 'browser.act') return await act(execution, execution.input as BrowserActInput);
      const input = execution.input as BrowserSessionInput;
      if (input.action === 'open') return await creation.create(execution.context, () => open(execution, input));
      if (input.action === 'close') return await closeSession(execution, input);
      if (input.action === 'status') return await status(execution, input);
      throw new PolicyError('INVALID_INPUT', 'Unsupported browser session action');
    },
    releaseAttempt(context: Pick<ToolContext, 'runId' | 'taskId' | 'attemptId'>): Promise<number> {
      const key = JSON.stringify([context.runId, context.taskId, context.attemptId]);
      let pending = releases.get(key);
      if (!pending) {
        pending = (async () => {
          await creation.seal(context);
          const owned = [...sessions.values()].filter(session => samePackScope(session.context, context));
          await Promise.all(owned.map(session => kill(session, 'attempt-released')));
          return owned.length;
        })();
        releases.set(key, pending);
        void pending.catch(() => { releases.delete(key); });
      }
      return pending;
    },
    outstanding(context: Pick<ToolContext, 'runId' | 'taskId' | 'attemptId'>): number {
      return [...sessions.values()].filter(session => samePackScope(session.context, context)).length;
    },
    close(): Promise<void> {
      closed = true;
      closing ??= (async () => {
        await creation.close();
        const results = await Promise.allSettled([...sessions.values()].map(session => kill(session, 'pack-closed')));
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length) throw new Error(`Browser pack shutdown unverified: ${failures.map(result => String(result.reason)).join('; ')}`);
      })().catch(error => { closing = undefined; throw error; });
      return closing;
    },
    inspect(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) return undefined;
      return {
        network: session.gate.inspect(), blocked: session.gate.inspectBlocked(), proxyBlocked: session.proxy.blocked, proxyErrors: session.proxy.errors,
        chromeVersion: session.identity.version, pid: session.pid, profile: session.profile, proxyPort: session.proxy.port, endpoint: session.owner.endpoint!,
      };
    },
  });
}
