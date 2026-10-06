import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';


/**
 * Real Pi, real delegation, real cross-process broker — inert model and inert sandbox only.
 * The owner spawns a genuine child `pi` (standing in for a Herdr pane), the child activates the worker
 * role from its ticket, runs a brokered command against the owner's sandbox, and reports back.
 */
it.each(process.env.P2O_TEST_DOCKER === '1' ? ['inert', 'docker'] : ['inert'])('real Pi + %s sandbox: one confirmation, then the current agent delegates a visible worker end to end', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-native-'));
  const repo = resolve(import.meta.dirname, '../..');
  await mkdir(join(root, 'repo'));
  await writeFile(join(root, 'repo', 'code.txt'), 'authorized inert source');
  const sandboxLog = join(root, 'sandbox.jsonl');
  const real = process.env.P2O_NATIVE_REAL_DOCKER === '1';
  const env = {
    PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'),
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    P2O_TEST_CONTROL_ROOT: join(root, 'control'), P2O_TEST_SANDBOX_LOG: sandboxLog,
    P2O_TEST_FAKE_HERDR: '1', P2O_TEST_CWD: root, P2O_TEST_PI_BINARY: join(repo, 'node_modules/.bin/pi'),
    P2O_TEST_WORKER_EXT: join(repo, 'tests/minimal/fixtures/worker.ts'),
  } as NodeJS.ProcessEnv;
  const child = spawn(join(repo, 'node_modules/.bin/pi'), ['--no-extensions', '-e', join(repo, 'tests/minimal/fixtures/owner.ts'),
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--no-session', '--no-approve',
    '--mode', 'rpc', '--provider', 'p2o-inert', '--model', 'current-agent', '--thinking', 'off'],
  { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', sequence = 0;
  const records: any[] = [], dialogs: string[] = [];
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  const closed = new Promise<void>(resolve => child.once('close', () => { for (const waiter of pending.values()) waiter.reject(new Error(`Pi exited: ${stderr}`)); pending.clear(); resolve(); }));
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', text => {
    buffer += text;
    for (;;) {
      const index = buffer.indexOf('\n'); if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
      let record: any; try { record = JSON.parse(line); } catch { records.push({ protocolError: line }); continue; }
      records.push(record);
      if (record.type === 'response') { pending.get(record.id)?.resolve(record); pending.delete(record.id); }
      if (record.type === 'extension_ui_request' && record.method === 'confirm') {
        dialogs.push(record.title);
        child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: record.id, confirmed: record.title === 'Start authorized assessment?' })}\n`);
      }
    }
  });
  const request = async (type: string, fields = {}): Promise<any> => {
    const id = `native-${++sequence}`; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`RPC timeout ${type}: ${stderr}`)), 30_000); })]);
    } finally { clearTimeout(timer); pending.delete(id); }
  };
  const text = (message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
  const transcript = async (predicate: (messages: any[]) => boolean) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const messages = (await request('get_messages')).data?.messages ?? [];
      if (predicate(messages)) return messages;
      await delay(100);
    }
    throw new Error(`transcript did not progress: ${JSON.stringify({ records: records.slice(-12), stderr })}`);
  };
  try {
    if (real) {
      // Real Docker mode reuses the production fixture, which mounts a real sandbox and no fake sandbox journal.
      const dockerSandbox = new (await import('../../src/sandbox.js')).Sandbox({ kind: 'directory', path: join(root, 'repo') }, undefined, undefined, { runId: 'native-test' });
      await dockerSandbox.start();
      const executed = await dockerSandbox.exec(`id -u; cat /target/code.txt`);
      expect(executed.stdout).toContain('65532');
      expect(executed.stdout).toContain('authorized inert source');
      await dockerSandbox.stop();
      await dockerSandbox.assertNoRunContainers();
    }
    expect((await request('get_state')).success).toBe(true);
    expect((await request('prompt', { message: '/p2o --target ./repo' })).success).toBe(true);
    const messages = await transcript((list: any[]) => list.some((message: any) => text(message).includes('OWNER_FINAL_REPORT')));
    expect(dialogs).toEqual(['Start authorized assessment?']);
    // The owner briefed itself, then delegated to a real worker process.
    expect(messages.some((message: any) => message.role === 'user' && text(message).includes('P2O ASSESSMENT'))).toBe(true);
    const toolResults = messages.filter((message: any) => message.role === 'toolResult');
    expect(toolResults.map((message: any) => message.toolName)).toEqual(['p2o_delegate', 'p2o_workers', 'p2o_finish']);
    expect(text(toolResults[0])).toMatch(/Spawned p2o-general-[0-9a-f]{6}/);
    // The worker's brokered command really executed in the owner's sandbox, in the worker's own scratch directory.
    const journal = (await readFile(sandboxLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const executed = journal.filter(entry => entry.op === 'exec');
    expect(executed).toHaveLength(1);
    expect(executed[0].command).toContain('cat /target/code.txt');
    expect(executed[0].workdir).toMatch(/^\/work\/p2o-general-[0-9a-f]{6}$/);
    // The worker reported through the broker into the shared ledger, and the owner saw it.
    expect(text(toolResults[1])).toContain('WORKER_REPORT');
    expect(text(toolResults[1])).toContain('coverage: 1');
    expect(text(toolResults[1])).toMatch(/p2o-general-[0-9a-f]{6} \[idle\]|p2o-general-[0-9a-f]{6} \[done\]|reported/);
    expect(text(toolResults[2])).toContain('Container removal verified');
    expect(journal.some(entry => entry.op === 'stop')).toBe(true);
    expect(journal.some(entry => entry.op === 'sweep')).toBe(true);
    expect(records.filter(record => record.protocolError || record.type === 'extension_error')).toEqual([]);
  } finally {
    child.stdin.end();
    const exited = await Promise.race([closed.then(() => true), delay(5000).then(() => false)]);
    if (!exited) { child.kill('SIGTERM'); await closed; }
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
