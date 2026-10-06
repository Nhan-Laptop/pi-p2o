import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { HerdrAgent, HerdrClient } from '../../../src/herdr.js';

/**
 * Test double for the Herdr transport. It keeps the same contract as the real CLI but replaces a pane
 * with a real child `pi` process driven over RPC, so worker activation, brokering and reporting are
 * exercised for real without opening panes or calling a live model.
 */
interface Child {
  name: string; paneId: string; process: ChildProcess; status: string; buffer: string; stderr: string;
  pending: Map<string, (value: any) => void>; sequence: number; ready: Promise<void>; lastPromptAt: number;
}

export interface FakeHerdrOptions { cwd: string; env?: NodeJS.ProcessEnv; piBinary: string; replaceExtensionArg?: string }

export function createFakeHerdr(options: FakeHerdrOptions): HerdrClient & { children: Map<string, Child>; closed: string[]; stop(): Promise<void> } {
  const children = new Map<string, Child>();
  const closed: string[] = [];
  let panes = 0;

  const request = (child: Child, type: string, fields: Record<string, unknown> = {}): Promise<any> => {
    const id = `h${++child.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake herdr: ${type} timed out for ${child.name}: ${child.stderr.slice(-400)}`)), 20_000);
      child.pending.set(id, value => { clearTimeout(timer); resolve(value); });
      child.process.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  };

  const startChild = (args: string[]): Promise<Child> => {
    const nameIndex = args.indexOf('--p2o-worker');
    if (nameIndex < 0) throw new Error('fake herdr: worker spawn is missing --p2o-worker');
    const effective = [...args];
    if (options.replaceExtensionArg) {
      const index = effective.indexOf('-e');
      if (index < 0) throw new Error('fake herdr: worker spawn is missing -e');
      effective[index + 1] = options.replaceExtensionArg;
    }
    const child = spawn(options.piBinary, [...effective, '--mode', 'rpc'], {
      cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcess;
    const entry: Child = { name: '', paneId: `w1T:p${panes}`, process: child, status: 'working', buffer: '', stderr: '', pending: new Map(), sequence: 0, ready: Promise.resolve(), lastPromptAt: Date.now() };
    entry.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake herdr: worker did not start: ${entry.stderr.slice(-800)}`)), 20_000);
      entry.pending.set('ready', () => { clearTimeout(timer); resolve(); });
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', text => {
      entry.buffer += text;
      for (;;) {
        const index = entry.buffer.indexOf('\n');
        if (index < 0) break;
        const line = entry.buffer.slice(0, index); entry.buffer = entry.buffer.slice(index + 1);
        if (!line.trim()) continue;
        let record: any; try { record = JSON.parse(line); } catch { continue; }
        if (record.type === 'response' && entry.pending.has(record.id)) {
          const resolve = entry.pending.get(record.id)!; entry.pending.delete(record.id); resolve(record);
        }
        if (record.type === 'agent_end') entry.status = 'idle';
        if (record.type === 'turn_start') entry.status = 'working';
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', text => { entry.stderr += text; });
    child.on('exit', () => { entry.status = 'done'; const ready = entry.pending.get('ready'); if (ready) { entry.pending.delete('ready'); ready({}); } });
    return Promise.resolve(entry);
  };

  return {
    children, closed,
    async available() { return true; },
    async split() { panes += 1; return `w1T:p${panes}`; },
    async start({ name, paneId, args }) {
      const child = await startChild(args);
      child.name = name; child.paneId = paneId;
      children.set(name, child);
      await request(child, 'get_state');
      // The worker section must be present before the brief, exactly as the real pipeline does.
      const state = await request(child, 'get_messages');
      void state;
    },
    async prompt({ name, text }) {
      const child = children.get(name);
      if (!child) throw new Error(`fake herdr: unknown agent ${name}`);
      child.status = 'working'; child.lastPromptAt = Date.now();
      await request(child, 'prompt', { message: text });
    },
    async get(name) {
      const child = children.get(name);
      if (!child) throw new Error(`fake herdr: unknown agent ${name}`);
      return { name, paneId: child.paneId, status: child.status } as HerdrAgent;
    },
    async statuses(names) {
      const map = new Map<string, string>();
      for (const name of names) map.set(name, children.get(name)?.status ?? 'unknown');
      return map;
    },
    async interrupt(name) {
      const child = children.get(name);
      if (!child || child.status === 'done') return;
      child.status = 'done';
      child.process.kill('SIGINT');
      await delay(50);
    },
    async closePane(paneId): Promise<boolean> {
      closed.push(paneId);
      for (const child of children.values()) {
        if (child.paneId !== paneId) continue;
        if (child.status !== 'done') { child.status = 'done'; child.process.kill('SIGTERM'); }
        await new Promise<void>(resolve => {
          if (child.process.exitCode !== null) { resolve(); return; }
          const timer = setTimeout(() => { child.process.kill('SIGKILL'); resolve(); }, 3000);
          child.process.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
      return true;
    },
    async stop() {
      for (const child of children.values()) {
        if (child.status === 'done') continue;
        child.process.kill('SIGTERM');
        await new Promise<void>(resolve => {
          if (child.process.exitCode !== null) { resolve(); return; }
          const timer = setTimeout(() => { child.process.kill('SIGKILL'); resolve(); }, 3000);
          child.process.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
    },
  };
}
