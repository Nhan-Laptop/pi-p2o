import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * A1/D1: the real extension under a real Pi host must activate only the planner loadout. The fixture provider asserts the
 * declared tool set on every request and asks for a host tool the planner never holds; the sandbox factory is inert, so this
 * claim needs no Docker and runs in the default suite. The separate real-container claim is opt-in in artifacts-docker.test.ts.
 */
it('real Pi + real extension: the planner loadout is enforced, host tools are refused and no target operation runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-planner-loadout-'));
  const repo = resolve(import.meta.dirname, '../..');
  await mkdir(join(root, 'repo'));
  await writeFile(join(root, 'repo', 'code.txt'), 'authorized docker source');
  const controlRoot = join(root, 'control');
  const child = spawn(join(repo, 'node_modules/.bin/pi'), ['--no-extensions', '-e', join(repo, 'tests/minimal/fixtures/owner-docker.ts'),
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--no-session', '--no-approve',
    '--mode', 'rpc', '--provider', 'p2o-docker-inert', '--model', 'docker-agent', '--thinking', 'off'],
  { cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', P2O_TEST_CONTROL_ROOT: controlRoot, HERDR_ENV: '0', ...(process.env.P2O_TEST_INSTALLED_EXTENSION ? { P2O_TEST_INSTALLED_EXTENSION: process.env.P2O_TEST_INSTALLED_EXTENSION } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const id = `loadout-${++sequence}`; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`RPC timeout ${type}: ${stderr}`)), 120_000); })]);
    } finally { clearTimeout(timer); pending.delete(id); }
  };
  const text = (message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
  try {
    await request('get_state');
    await request('prompt', { message: '/p2o --target ./repo' });
    let messages: any[] = [];
    for (let attempt = 0; attempt < 300; attempt += 1) {
      messages = (await request('get_messages')).data?.messages ?? [];
      if (messages.some((message: any) => text(message).includes('PLANNER_LOADOUT_FINAL_REPORT'))) break;
      await delay(200);
    }
    expect(messages.some((message: any) => text(message).includes('PLANNER_LOADOUT_FINAL_REPORT')), JSON.stringify({ stderr, tail: messages.slice(-4).map(text) })).toBe(true);
    const results = messages.filter((message: any) => message.role === 'toolResult');
    // The fixture provider asserts on every request that Pi declares exactly the planner set, so reaching this point
    // already proves the loadout; the refused host call proves a model-issued host tool executed nothing.
    const bash = results.find((message: any) => message.toolName === 'bash');
    expect(text(bash)).toMatch(/Tool bash not found|permits only/);
    expect(text(bash)).not.toContain('HOST_BYPASS');
    // Only the two turns the fixture emits: no target, lab or session tool ever existed in this session.
    expect(results.map((message: any) => message.toolName)).toEqual(['bash', 'p2o_finish']);
    const finish = results.find((message: any) => message.toolName === 'p2o_finish');
    expect(text(finish)).toContain('Container removal verified');
    expect(text(finish)).toContain('STATE:');
    expect(dialogs).toEqual(['Start authorized assessment?']);
    // The runner prompt names no tool the planner does not hold.
    const scope = (messages.find((message: any) => message.role === 'system' && message.sections?.p2o_assessment)?.sections.p2o_assessment ?? '').replace(/^<p2o_assessment>\s*|\s*<\/p2o_assessment>$/g, '');
    expect(scope).not.toMatch(/\bp2o_[a-z_]+\b/);
  } finally {
    child.stdin.end();
    const exited = await Promise.race([closed.then(() => true), delay(10_000).then(() => false)]);
    if (!exited) { child.kill('SIGTERM'); await closed; }
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
