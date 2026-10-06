// Real Pi RPC/session/model loop, MODEL-INERT and BACKEND-INERT. No external network or assessment worker.
import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

it('real Pi dispatches a visible native plan, waits for human approval, then reports in the same session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-native-session-'));
  const repo = resolve(import.meta.dirname, '../..');
  const child = spawn(join(repo, 'node_modules/.bin/pi'), ['--no-extensions', '-e', join(repo, 'tests/command/fixtures/native-session.ts'),
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--no-session', '--no-approve',
    '--mode', 'rpc', '--provider', 'native-fixture', '--model', 'inert-orchestrator', '--thinking', 'off'],
  { cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', sequence = 0;
  const records: any[] = [], dialogs: any[] = [];
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  const closed = new Promise<void>(resolve => child.once('close', () => { for (const waiter of pending.values()) waiter.reject(new Error(`Pi exited: ${stderr}`)); pending.clear(); resolve(); }));
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', text => {
    buffer += text;
    for (;;) {
      const index = buffer.indexOf('\n'); if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let record: any; try { record = JSON.parse(line); } catch { records.push({ protocolError: line }); continue; }
      records.push(record);
      if (record.type === 'response') { pending.get(record.id)?.resolve(record); pending.delete(record.id); }
      if (record.type === 'extension_ui_request' && record.method === 'confirm') {
        dialogs.push(record);
        const known = record.title === 'Use this Pi session as the foreground orchestrator?' || record.title.startsWith('Approve plan ');
        child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: record.id, ...(known ? { confirmed: true } : { cancelled: true }) })}\n`);
      }
    }
  });
  const request = async (type: string, fields = {}): Promise<any> => {
    const id = `native-${++sequence}`;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`RPC timeout ${type}: ${stderr}`)), 15_000); })]);
    } finally { clearTimeout(timer!); pending.delete(id); }
  };
  const until = async (predicate: (messages: any[]) => boolean): Promise<any[]> => {
    for (let i = 0; i < 100; i++) {
      const response = await request('get_messages'); const messages = response.data?.messages ?? [];
      if (predicate(messages)) return messages;
      if (records.some(r => r.type === 'extension_error')) throw new Error(JSON.stringify(records.filter(r => r.type === 'extension_error')));
      await delay(50);
    }
    const { writeFileSync } = await import('node:fs'); writeFileSync('/tmp/p2o-native-diag.json', JSON.stringify({ records, dialogs, stderr }, null, 2));
    throw new Error(`Native transcript did not progress; diagnostics in /tmp/p2o-native-diag.json`);
  };
  const text = (m: any) => typeof m.content === 'string' ? m.content : (m.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  try {
    expect((await request('get_state')).success).toBe(true);
    expect((await request('prompt', { message: '/p2o --target ./inert-target --foreground' })).success).toBe(true);
    const planned = await until(messages => messages.some(m => text(m).includes('NATIVE_FOREGROUND_PLAN')));
    expect(planned.some(m => m.customType === 'p2o_error')).toBe(false);
    expect(planned.filter(m => m.role === 'user' && text(m).includes('[p2o foreground orchestrator')).length).toBeGreaterThan(0);
    const sessionBefore = (await request('get_state')).data.sessionId;
    expect((await request('prompt', { message: '/p2o approve plan-1' })).success).toBe(true);
    const finished = await until(messages => messages.some(m => text(m).includes('NATIVE_FOREGROUND_FINAL')));
    expect(finished.filter(m => m.role === 'user' && text(m).includes('Do not call p2o_start again')).length).toBeGreaterThan(0);
    expect(finished.some(m => m.customType === 'p2o_error')).toBe(false);
    expect((await request('get_state')).data.sessionId).toBe(sessionBefore);
    expect(dialogs.map(d => d.title)).toEqual(['Use this Pi session as the foreground orchestrator?', 'Approve plan plan-1?']);
    expect(records.filter(r => r.protocolError || r.type === 'extension_error')).toEqual([]);
  } finally {
    child.stdin.end();
    const exited = await Promise.race([closed.then(() => true), delay(5000).then(() => false)]);
    if (!exited) { child.kill('SIGTERM'); await closed; }
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
