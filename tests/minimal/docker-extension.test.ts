import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);

/**
 * The real extension against real Docker: the lead's host tools must be blocked, its sandbox command must
 * run non-root inside the pinned image, and `p2o_finish` must leave no container of this run behind.
 */
it.skipIf(process.env.P2O_TEST_DOCKER !== '1')('real Docker + real extension: host tools blocked, sandbox evidence recorded, containers verified gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-docker-owner-'));
  const repo = resolve(import.meta.dirname, '../..');
  await mkdir(join(root, 'repo'));
  await writeFile(join(root, 'repo', 'code.txt'), 'authorized docker source');
  const controlRoot = join(root, 'control');
  const containers = async (): Promise<string[]> => {
    const { stdout } = await run('docker', ['ps', '-a', '--filter', 'label=pi-p2o=minimal', '--format', '{{.Names}}']).catch(() => ({ stdout: '' }));
    return stdout.split('\n').map(name => name.trim()).filter(Boolean).sort();
  };
  const before = await containers();
  const child = spawn(join(repo, 'node_modules/.bin/pi'), ['--no-extensions', '-e', join(repo, 'tests/minimal/fixtures/owner-docker.ts'),
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--no-session', '--no-approve',
    '--mode', 'rpc', '--provider', 'p2o-docker-inert', '--model', 'docker-agent', '--thinking', 'off'],
  { cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', P2O_TEST_CONTROL_ROOT: controlRoot, HERDR_ENV: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const id = `docker-${++sequence}`; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`RPC timeout ${type}: ${stderr}`)), 180_000); })]);
    } finally { clearTimeout(timer); pending.delete(id); }
  };
  const text = (message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
  try {
    await request('get_state');
    await request('prompt', { message: '/p2o --target ./repo --solo' });
    let messages: any[] = [];
    for (let attempt = 0; attempt < 300; attempt += 1) {
      messages = (await request('get_messages')).data?.messages ?? [];
      if (messages.some((message: any) => text(message).includes('DOCKER_OWNER_FINAL_REPORT'))) break;
      await delay(200);
    }
    expect(messages.some((message: any) => text(message).includes('DOCKER_OWNER_FINAL_REPORT')), JSON.stringify({ stderr, tail: messages.slice(-4).map(text) })).toBe(true);
    const results = messages.filter((message: any) => message.role === 'toolResult');
    // The model tried host bash first: the gate blocked it and no host command ran.
    // The fixture provider asserts on every request that the declared tool set is sandbox-only (it throws
    // otherwise), so reaching this point already proves host tools were withdrawn. The refused bash call adds
    // that even a model-issued host call executed nothing.
    const bash = results.find((message: any) => message.toolName === 'bash');
    expect(text(bash)).toMatch(/Tool bash not found|permits only/);
    expect(text(bash)).not.toContain('HOST_BYPASS');
    // The sandbox command carries real container evidence: nobody-user, the mounted source, dropped capabilities.
    const shell = results.find((message: any) => message.toolName === 'p2o_shell');
    expect(text(shell)).toContain('65532');
    expect(text(shell)).toContain('authorized docker source');
    expect(text(shell)).toMatch(/CapEff:\s*0000000000000000/);
    expect(text(shell)).toContain('NO_DOCKER_SOCKET');
    const finish = results.find((message: any) => message.toolName === 'p2o_finish');
    expect(text(finish)).toContain('Container removal verified');
    expect(dialogs).toEqual(['Start authorized assessment?']);
    // Containers created by this run are gone; anything this test found beforehand is untouched.
    const after = await containers();
    expect(after.filter(name => !before.includes(name))).toEqual([]);
  } finally {
    child.stdin.end();
    const exited = await Promise.race([closed.then(() => true), delay(10_000).then(() => false)]);
    if (!exited) { child.kill('SIGTERM'); await closed; }
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
