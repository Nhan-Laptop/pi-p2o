import { runHerdr, type ProcessResult, type RunProcess } from './process.js';
import { workerName } from './ticket.js';

/**
 * Minimal Herdr client modelled on pi-herdr's adapter: split a pane on the tiling rule, start a
 * real visible `pi` process in it, prompt it, and read its status. Nothing here is an AI agent —
 * it is the transport that makes delegated visibility possible.
 */
export interface HerdrAgent { name: string; paneId: string; status: string }
export interface PaneRect { paneId: string; x: number; y: number; width: number; height: number }
export const MIN_CELL_WIDTH = 24;
export const MIN_CELL_HEIGHT = 6;

export interface HerdrClient {
  available(): Promise<boolean>;
  split(options: { cwd: string }): Promise<string>;
  start(options: { name: string; paneId: string; args: string[] }): Promise<void>;
  prompt(options: { name: string; text: string }): Promise<void>;
  get(name: string): Promise<HerdrAgent>;
  statuses(names: string[]): Promise<Map<string, string>>;
  interrupt(name: string): Promise<void>;
  /** Returns whether the pane is really gone; a refused close is reported, never assumed. */
  closePane(paneId: string): Promise<boolean>;
}

/** A result that must parse as `{ result: ... }`; a Herdr failure is a clear error, never silent. */
function parseResult(result: ProcessResult, what: string): any {
  if (result.code !== 0) throw new Error(`herdr ${what} failed: ${(result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 400)}`);
  const text = result.stdout.trim();
  if (!text) throw new Error(`herdr ${what} returned no output`);
  let parsed: any;
  try { parsed = JSON.parse(text.slice(text.indexOf('{'))); }
  catch { throw new Error(`herdr ${what} returned non-JSON output`); }
  if (!parsed || typeof parsed !== 'object' || !('result' in parsed)) throw new Error(`herdr ${what} returned an unexpected shape`);
  return parsed.result;
}

export function chooseSplit(panes: PaneRect[]): { paneId: string; direction: 'right' | 'down' } | undefined {
  const usable = panes.filter(pane => pane && pane.width > 0 && pane.height > 0);
  if (!usable.length) return undefined;
  const fits = (pane: PaneRect, direction: 'right' | 'down') => direction === 'right'
    ? Math.floor(pane.width / 2) >= MIN_CELL_WIDTH && pane.height >= MIN_CELL_HEIGHT
    : pane.width >= MIN_CELL_WIDTH && Math.floor(pane.height / 2) >= MIN_CELL_HEIGHT;
  const preferred = (pane: PaneRect): 'right' | 'down' => (pane.width / 2 >= pane.height ? 'right' : 'down');
  const ranked = [...usable].sort((a, b) => (b.width * b.height) - (a.width * a.height) || (b.x + b.y) - (a.x + a.y));
  const target = ranked.find(pane => fits(pane, preferred(pane)) || fits(pane, preferred(pane) === 'right' ? 'down' : 'right')) ?? ranked[0];
  const primary = preferred(target);
  const alternate = primary === 'right' ? 'down' : 'right';
  return { paneId: target.paneId, direction: fits(target, primary) ? primary : alternate };
}

export function createHerdrClient(run: RunProcess = runHerdr, env: NodeJS.ProcessEnv = process.env): HerdrClient {
  // Read -> choose -> split runs one at a time, otherwise N spawns shave the same pane.
  let splitQueue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = splitQueue.then(task, task);
    splitQueue = next.then(() => undefined, () => undefined);
    return next;
  };
  const statusOf = async (name: string): Promise<string> => {
    try {
      const agent = parseResult(await run(['agent', 'get', name], { timeoutMs: 15_000 }), `agent get ${name}`);
      return typeof agent?.agent?.agent_status === 'string' ? agent.agent.agent_status : 'unknown';
    } catch { return 'unknown'; }
  };
  return {
    async available() {
      if (env.HERDR_ENV !== '1') return false;
      try { return (await run(['status', 'server'], { timeoutMs: 10_000 })).code === 0; }
      catch { return false; }
    },
    split({ cwd }) {
      return serialize(async () => {
        let paneId: string | undefined;
        let direction: 'right' | 'down' = 'right';
        try {
          const layout = parseResult(await run(['pane', 'layout', '--current'], { timeoutMs: 15_000 }), 'pane layout');
          const panes: PaneRect[] = (layout?.layout?.panes ?? []).map((pane: any) => ({
            paneId: String(pane.pane_id), x: Number(pane.rect?.x ?? 0), y: Number(pane.rect?.y ?? 0),
            width: Number(pane.rect?.width ?? 0), height: Number(pane.rect?.height ?? 0),
          }));
          const choice = chooseSplit(panes);
          if (choice) { paneId = choice.paneId; direction = choice.direction; }
        } catch { /* fall back to splitting the caller's pane */ }
        const args = ['pane', 'split', '--no-focus', ...(paneId ? ['--pane', paneId] : ['--current']), '--direction', direction, '--ratio', '0.5', '--cwd', cwd];
        const result = parseResult(await run(args, { timeoutMs: 20_000 }), 'pane split');
        const created = String(result?.pane?.pane_id ?? '');
        if (!created) throw new Error('herdr pane split returned no pane id');
        return created;
      });
    },
    async start({ name, paneId, args }) {
      parseResult(await run(['agent', 'start', name, '--kind', 'pi', '--pane', paneId, '--', ...args], { timeoutMs: 90_000 }), 'agent start');
    },
    async prompt({ name, text }) {
      // No --wait: a long worker turn must never block the owner's turn.
      parseResult(await run(['agent', 'prompt', name, text], { timeoutMs: 30_000 }), `agent prompt ${name}`);
    },
    async get(name) {
      const result = parseResult(await run(['agent', 'get', name], { timeoutMs: 15_000 }), `agent get ${name}`);
      return { name: String(result?.agent?.name ?? name), paneId: String(result?.agent?.pane_id ?? ''), status: String(result?.agent?.agent_status ?? 'unknown') };
    },
    async statuses(names) {
      const entries = await Promise.all(names.map(async name => [name, await statusOf(name)] as const));
      return new Map(entries);
    },
    async interrupt(name) {
      try { await run(['agent', 'send-keys', name, 'ctrl-c'], { timeoutMs: 15_000 }); } catch { /* the pane may already be gone */ }
    },
    async closePane(paneId) {
      try { await run(['pane', 'close', paneId], { timeoutMs: 15_000 }); }
      catch { /* the pane may already be closed; the listing below decides */ }
      // Positive check: the pane is closed only when the workspace listing no longer contains it. A failed
      // lookup is "unverified", never "closed".
      try {
        const result = parseResult(await run(['pane', 'list'], { timeoutMs: 15_000 }), 'pane list');
        const panes: any[] = result?.panes ?? [];
        return !panes.some(pane => String(pane?.pane_id) === paneId);
      } catch { return false; }
    },
  };
}

export { workerName };
