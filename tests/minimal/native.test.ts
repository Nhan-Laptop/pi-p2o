import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
// @ts-ignore - hermetic metadata helpers from the plain-JS benchmark harness
import { deriveRunId, hasAssessmentStarted } from '../../scripts/benchmark-skills.mjs';


/**
 * Real Pi, real delegation, real cross-process broker — inert model and inert sandbox only.
 * The owner spawns a genuine child `pi` (standing in for a Herdr pane), the child activates the worker
 * role from its ticket, runs a brokered command against the owner's sandbox, and reports back.
 */
it.each(['normal', 'quota'])('real Pi + inert sandbox, %s worker: terminal report and verified cleanup across processes', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-native-'));
  const repo = resolve(import.meta.dirname, '../..');
  await mkdir(join(root, 'repo'));
  await writeFile(join(root, 'repo', 'code.txt'), 'authorized inert source');
  const sandboxLog = join(root, 'sandbox.jsonl');
  const env = {
    PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'),
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    P2O_TEST_CONTROL_ROOT: join(root, 'control'), P2O_TEST_SANDBOX_LOG: sandboxLog,
    P2O_TEST_FAKE_HERDR: '1', P2O_TEST_CWD: root, P2O_TEST_PI_BINARY: join(repo, 'node_modules/.bin/pi'),
    P2O_TEST_WORKER_EXT: join(repo, 'tests/minimal/fixtures/worker.ts'),
    P2O_TEST_WORKER_FAULT: mode === 'quota' ? 'quota' : '',
    ...(process.env.P2O_TEST_INSTALLED_EXTENSION ? { P2O_TEST_INSTALLED_EXTENSION: process.env.P2O_TEST_INSTALLED_EXTENSION } : {}),
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
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const messages = (await request('get_messages')).data?.messages ?? [];
      if (predicate(messages)) return messages;
      await delay(100);
    }
    throw new Error(`transcript did not progress: ${JSON.stringify({ records: records.slice(-12), stderr })}`);
  };
  try {
    expect((await request('get_state')).success).toBe(true);
    expect((await request('prompt', { message: '/p2o --target ./repo --export' })).success).toBe(true);
    const messages = await transcript((list: any[]) => list.some((message: any) => text(message).includes('OWNER_FINAL_REPORT')));
    expect(dialogs).toEqual(['Start authorized assessment?']);
    // A brief kickoff, with policy only in one structured system section (no duplicated manual).
    const users = messages.filter((message: any) => message.role === 'user');
    expect(users).toHaveLength(1);
    expect(text(users[0])).toContain('Begin the confirmed assessment');
    expect(text(users[0]).length).toBeLessThan(200);
    expect(text(users[0])).not.toMatch(/p2o_|P2O ASSESSMENT|RECON → INVESTIGATION/);
    const scope = (messages.find((message: any) => message.role === 'system' && message.sections?.p2o_assessment)?.sections.p2o_assessment ?? '').replace(/^<p2o_assessment>\s*|\s*<\/p2o_assessment>$/g, '');
    expect(scope).toContain('RECON → INVESTIGATION');
    expect(scope).toContain('same-run Evidence IDs');
    expect(scope).not.toContain('CAPABILITIES');
    expect(scope).not.toMatch(/\bp2o_[a-z_]+\b|nextOffset|supersedes=|policyBasis=/);
    expect(hasAssessmentStarted(messages)).toBe(true);
    expect(deriveRunId({ messages })).toMatchObject({ runId: expect.stringMatching(/^run-/), source: 'policy-section' });
    const toolResults = messages.filter((message: any) => message.role === 'toolResult');
    expect(toolResults.map((message: any) => message.toolName)).toEqual(['p2o_delegate', 'p2o_workers', 'p2o_finish']);
    expect(text(toolResults[0])).toMatch(/Spawned p2o-general-[0-9a-f]{6}/);
    // The worker's brokered command really executed in the owner's sandbox, in the worker's own scratch directory.
    const journal = (await readFile(sandboxLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const executed = journal.filter(entry => entry.op === 'exec');
    if (mode === 'normal') {
      expect(executed).toHaveLength(1);
      expect(executed[0].command).toContain('cat /target/code.txt');
      expect(executed[0].workdir).toMatch(/^\/work\/p2o-general-[0-9a-f]{6}$/);
      expect(text(toolResults[1])).toContain('WORKER_REPORT');
      expect(text(toolResults[1])).toContain('coverage: 2');
    } else {
      expect(executed).toHaveLength(0);
      expect(text(toolResults[1])).toContain('429 GoUsageLimitError');
      expect(text(toolResults[1])).toContain('BLOCKED');
      expect(toolResults[1].details.workers[0]).toMatchObject({ reported: true, live: false });
    }
    expect(text(toolResults[1])).toMatch(/p2o-general-[0-9a-f]{6} \[idle\]|p2o-general-[0-9a-f]{6} \[done\]|reported/);
    expect(text(toolResults[2])).toContain('Container removal verified');
    expect(journal.some(entry => entry.op === 'stop')).toBe(true);
    expect(journal.some(entry => entry.op === 'sweep')).toBe(true);
    expect(records.filter(record => record.protocolError || record.type === 'extension_error')).toEqual([]);
    const exports = await readdir(join(root, '.p2o-reports'));
    expect(exports).toHaveLength(1);
    const exported = JSON.parse(await readFile(join(root, '.p2o-reports', exports[0]), 'utf8'));
    expect(exported.manifest).not.toHaveProperty('capabilities');
    if (mode === 'normal') {
      expect(exported.manifest.skillHashes['shared:handoffs']).toMatch(/^[a-f0-9]{64}$/);
      const notes = exported.records.filter((r: any) => r.kind === 'note');
      expect(notes.map((r: any) => r.text).join('\n')).toContain('Decision: correct the assumption');
      const evidence = exported.records.filter((r: any) => r.kind === 'evidence');
      expect(notes.every((r: any) => r.refs?.some((id: string) => evidence.some((e: any) => e.id === id)))).toBe(true);
      expect(exported.records.some((r: any) => r.kind === 'candidate' && r.data.closure === 'open_proof_gap')).toBe(true);
    }
    if (process.env.P2O_TEST_RECEIPT_DIR) {
      await mkdir(process.env.P2O_TEST_RECEIPT_DIR, { recursive: true });
      await writeFile(join(process.env.P2O_TEST_RECEIPT_DIR, `native-${mode}.json`), JSON.stringify({
        fixture: 'Real Pi with scripted inert provider, inert sandbox and process-based Herdr double; not model quality or Docker proof',
        installedExtension: process.env.P2O_TEST_INSTALLED_EXTENSION ?? null,
        checks: ['no capability tool/table', 'tool descriptions/schema available', 'one structured lead policy section without tool tutorials', 'short kickoff without duplicate policy', 'shared recon prompt', 'broker isolation', 'terminal report', 'cleanup', 'export without capability metadata'],
        leadPolicy: scope, kickoff: text(users[0]),
        export: exported,
      }, null, 2));
    }
  } finally {
    child.stdin.end();
    const exited = await Promise.race([closed.then(() => true), delay(5000).then(() => false)]);
    if (!exited) { child.kill('SIGTERM'); await closed; }
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
