import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Opt-in real-Herdr integration (P2O_TEST_HERDR=1). Spawns an actual neighbour pane running a real
 * `pi` worker, then asserts the owner saw it through Herdr and cleaned the pane up. The model is still
 * inert, so this exercises the transport, not live AI.
 */
it.skipIf(process.env.P2O_TEST_HERDR !== '1')('real Herdr: the owner delegates into a visible pane, reads its Herdr status, and closes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-herdr-'));
  const repo = resolve(import.meta.dirname, '../..');
  await mkdir(join(root, 'repo'));
  await writeFile(join(root, 'repo', 'code.txt'), 'authorized inert source');
  const sandboxLog = join(root, 'sandbox.jsonl'), settings = join(root, 'settings.json');
  // Hermetic role-model pin: the A2 first intent is recon, so the worker role model is pinned to the inert provider instead of
  // an unreachable packaged default; the transport, not live AI, is what this opt-in test exercises.
  await writeFile(settings, JSON.stringify({ p2o: { roles: Object.fromEntries(['recon', 'discovery', 'validation', 'reporting', 'exploit', 'general'].map(role => [role, { model: 'p2o-inert/current-agent' }])) } }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    P2O_TEST_CONTROL_ROOT: join(root, 'control'), P2O_TEST_SANDBOX_LOG: sandboxLog, P2O_TEST_SETTINGS: settings,
    P2O_TEST_WORKER_EXT: join(repo, 'tests/minimal/fixtures/worker.ts'),
    HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1',
  };
  const child = spawn(join(repo, 'node_modules/.bin/pi'), ['--no-extensions', '-e', join(repo, 'tests/minimal/fixtures/owner.ts'),
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--no-session', '--no-approve',
    '--mode', 'rpc', '--provider', 'p2o-inert', '--model', 'current-agent', '--thinking', 'off'],
  { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', sequence = 0;
  const dialogs: string[] = [];
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  const closed = new Promise<void>(resolve => child.once('close', () => { for (const waiter of pending.values()) waiter.reject(new Error(`Pi exited: ${stderr}`)); pending.clear(); resolve(); }));
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', text => {
    buffer += text;
    for (;;) {
      const index = buffer.indexOf('\n'); if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
      let record: any; try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'response') { pending.get(record.id)?.resolve(record); pending.delete(record.id); }
      if (record.type === 'extension_ui_request' && record.method === 'confirm') {
        dialogs.push(record.title);
        child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: record.id, confirmed: record.title === 'Start authorized assessment?' })}\n`);
      }
    }
  });
  const request = async (type: string, fields = {}): Promise<any> => {
    const id = `herdr-${++sequence}`; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`RPC timeout ${type}: ${stderr}`)), 60_000); })]);
    } finally { clearTimeout(timer); pending.delete(id); }
  };
  const text = (message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
  try {
    expect((await request('get_state')).success).toBe(true);
    expect((await request('prompt', { message: '/p2o --target ./repo' })).success).toBe(true);
    let messages: any[] = [];
    for (let attempt = 0; attempt < 300; attempt += 1) {
      messages = (await request('get_messages')).data?.messages ?? [];
      if (messages.some((message: any) => text(message).includes('OWNER_FINAL_REPORT'))) break;
      await delay(200);
    }
    expect(messages.some((message: any) => text(message).includes('OWNER_FINAL_REPORT')), JSON.stringify({ stderr, tail: messages.slice(-6).map(text) })).toBe(true);
    const results = messages.filter((message: any) => message.role === 'toolResult');
    expect(results.map((message: any) => message.toolName)).toEqual(['p2o_net', 'p2o_task_author', 'p2o_task_dispatch', 'p2o_workers', 'p2o_finish']);
    // A1: no target tool on the planner surface; the Engine spawns the worker from the dispatched intent.
    expect(results[0].isError).toBe(true);
    expect(text(results[0])).toContain('not found');
    // A real Herdr pane answered: the status the owner read came from `herdr agent get`.
    expect(text(results[3])).toMatch(/\[(idle|working|done|blocked|reported)\]/);
    expect(text(results[3])).toContain('WORKER_REPORT');
    const journal = (await readFile(sandboxLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(journal.filter((entry: any) => entry.op === 'exec')).toHaveLength(1);
    expect(text(results[4])).toContain('Container removal verified');
    expect(dialogs).toEqual(['Start authorized assessment?']);
  } finally {
    child.stdin.end();
    const exited = await Promise.race([closed.then(() => true), delay(10_000).then(() => false)]);
    if (!exited) { child.kill('SIGTERM'); await closed; }
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
