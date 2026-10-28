import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { parseRoundBrief, parseWakePrompt } from '../../src/planner-bridge.js';
import { ROUND_BRIEF_MAX_BYTES } from '../../src/round-brief.js';

/**
 * P18.1/D45 real-Pi gate: with `p2o.roundSessions` on (the default), an engine wake must replace the Planner session and put
 * the round opening into the replacement, and the planner must take a real turn there. The fake-host tests cover the guards;
 * this one is the gate for keeping the default on, because only a real host proves `sendUserMessage('/p2o-round …',
 * {expandPromptTemplates:true})` reaches a command context that owns `newSession`.
 *
 * Model-inert: scripted provider, child Pi workers, inert sandbox. No network, no target traffic, no paid request.
 */
it('real Pi opens an automatic round in a replacement session and takes a planner turn there (P18.1/D45)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-round-native-')), repo = resolve(import.meta.dirname, '../..'), control = join(root, 'control');
  await mkdir(join(root, 'source')); await writeFile(join(root, 'source', 'code.txt'), 'authorized fixture');
  const log = join(root, 'provider.jsonl'), settings = join(root, 'settings.json');
  // The round-sessions arm deliberately keeps the packaged setting: nothing here disables the switch under test. Worker role
  // models still point at the inert provider, because the A2 first intent is recon.
  await writeFile(settings, JSON.stringify({ p2o: { roles: Object.fromEntries(['recon', 'discovery', 'validation', 'reporting', 'exploit', 'general'].map(role => [role, { model: 'p2o-inert/current-agent' }])) } }));
  const child = spawn(join(repo, 'node_modules/.bin/pi'), ['--no-extensions', '-e', join(repo, 'tests/minimal/fixtures/owner.ts'), '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline', '--no-session', '--no-approve', '--mode', 'rpc', '--provider', 'p2o-inert', '--model', 'current-agent', '--thinking', 'off'], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', P2O_TEST_SETTINGS: settings, P2O_TEST_EVENT_LOOP: '1', P2O_TEST_WAKE_BOUNDARY: '0', P2O_TEST_ROUND_SESSION: '1', P2O_TEST_PROVIDER_LOG: log, P2O_TEST_FAKE_HERDR: '1', P2O_TEST_CWD: root, P2O_TEST_PI_BINARY: join(repo, 'node_modules/.bin/pi'), P2O_TEST_WORKER_EXT: join(repo, 'tests/minimal/fixtures/worker.ts'), P2O_TEST_CONTROL_ROOT: control },
  });
  let buffer = '', stderr = '', seq = 0; const records: any[] = []; const pending = new Map<string, (r: any) => void>();
  const closed = new Promise<void>(r => child.once('close', () => r()));
  child.stderr.setEncoding('utf8'); child.stderr.on('data', s => { stderr += s; }); child.stdout.setEncoding('utf8'); child.stdout.on('data', s => {
    buffer += s; for (;;) { const i = buffer.indexOf('\n'); if (i < 0) break; const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line.trim()) continue;
      const r = JSON.parse(line); records.push(r); if (r.type === 'response') { pending.get(r.id)?.(r); pending.delete(r.id); }
      if (r.type === 'extension_ui_request' && r.method === 'confirm') child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: r.id, confirmed: true }) + '\n');
    }
  });
  const request = async (type: string, fields: any = {}) => { const id = `round-${++seq}`; let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([new Promise<any>(r => { pending.set(id, r); child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n'); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`RPC timeout: ${stderr}`)), 60000); })]); }
    finally { clearTimeout(timer); pending.delete(id); }
  };
  const text = (m: any) => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') : JSON.stringify(m.content ?? ''));
  const messages = async () => (await request('get_messages')).data?.messages ?? [];
  const until = async (p: () => Promise<boolean>) => { for (let i = 0; i < 2000; i += 1) { if (await p()) return; await delay(30); } throw Error(`No progress: ${stderr} ${JSON.stringify({ errors: records.filter(r => r.type === 'extension_error'), notifies: records.filter(r => r.type === 'extension_ui_request' && r.method === 'notify').map((r: any) => String(r.message).slice(0, 1200)) })}`); };
  try {
    expect((await request('get_state')).success).toBe(true);
    const kickoff = (await request('get_state')).data;
    expect((await request('prompt', { message: '/p2o --target ./source' })).success).toBe(true);
    // Round one is the wake the committed worker report produces: the kickoff command turn is a human turn, not a round.
    await until(async () => (await messages()).some((m: any) => m.role === 'user' && text(m).includes('--- p2o round ---')));
    await until(async () => (await messages()).some((m: any) => m.role === 'assistant' && text(m).includes('ROUND_SESSION_OPENED')));
    const state = (await request('get_state')).data;
    const wake = parseWakePrompt(text((await messages()).find((m: any) => m.role === 'user' && text(m).includes('--- p2o round ---'))));
    expect(wake).toBeDefined();
    // A fresh session, not a prompt in the old one: Pi's session identity changed.
    expect(state.sessionId).toBeTruthy(); expect(kickoff.sessionId).toBeTruthy(); expect(state.sessionId).not.toBe(kickoff.sessionId);
    const session = await messages();
    // The opening is the one user message of a fresh session: wake marker first (so the existing wake parsers keep working), then
    // the round marker and the briefing the caller supplied.
    const opening = session.filter((m: any) => m.role === 'user');
    expect(opening).toHaveLength(1);
    expect(text(opening[0]).startsWith('[p2o semantic wake] ')).toBe(true);
    expect(text(opening[0])).toContain('--- p2o round ---');
    // P18.2/D46: the opening carries the deterministic briefing, not a placeholder sentence, and it is the only user turn the
    // replacement starts with.
    const brief = parseRoundBrief(text(opening[0]))!;
    expect(brief.brief.startsWith('P2O round brief: round 1')).toBe(true);
    expect(brief.brief).toContain('## Campaign frame');
    expect(brief.brief).toContain('## Completion and demand');
    expect(Buffer.byteLength(brief.brief)).toBeLessThanOrEqual(ROUND_BRIEF_MAX_BYTES);
    // A real planner turn ran in the replacement: the scripted provider called a planner tool and got its result.
    const actions = session.filter((m: any) => m.role === 'toolResult').map((m: any) => m.toolName);
    expect(actions).toContain('p2o_loop');
    expect(records.filter(r => r.type === 'extension_error')).toEqual([]);
    // The reloaded extension instance adopted the live campaign: a read-only status command in the replacement session reads
    // the same Engine (round count included) and spends no paid request.
    const accepted = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    const messagesBefore = (await messages()).length;
    expect((await request('prompt', { message: '/p2o status' })).success).toBe(true);
    await until(async () => records.some(r => r.type === 'extension_ui_request' && r.method === 'notify'
      && String(r.message).includes(`P2O ${wake!.runId} · active`) && /\brounds \d+\b/.test(String(r.message)) && String(r.message).includes('last wake')));
    expect((await messages()).length).toBe(messagesBefore);
    expect((await readFile(log, 'utf8')).split('\n').filter(Boolean)).toHaveLength(accepted);
  } finally {
    await request('prompt', { message: '/p2o stop' }).catch(() => {});
    child.stdin.end();
    if (!await Promise.race([closed.then(() => true), delay(3000).then(() => false)])) { child.kill('SIGTERM'); await closed; }
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
