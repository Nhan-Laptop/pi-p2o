import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Broker, BrokerClient, type WorkerRegistration } from '../../src/broker.js';
import { parseCommand } from '../../src/target.js';
import { containsSecretValue } from '../../src/identity.js';
import { HttpSessions } from '../../src/http-session.js';
import { plannerInstructions, workerInstructions, type PlannerPromptFacts } from '../../src/prompts.js';
import { fixture } from './helpers/report-fixture.js';

/**
 * A7.4 (planning_update.md P7.5): the operator-declared identity channel.
 *
 * The operator names one JSON file; the host validates it, seals a private copy, and never shows a value to a model. A
 * `${P2O_SECRET:<id>}` placeholder is substituted at the one dispatch seam only after the command policy allowed the
 * operation, the use is audited by id, and everything retained or returned is redacted by exact value. This suite pins the
 * behavioural claims the prompt and the report make, not just the pure functions (those live in identity.test.ts):
 * quoting, refusal before bytes, policy-before-substitution, the sealed copy, the store-wide leak scan, principal jars and
 * the report facts.
 *
 * Hermetic: no Docker and no model; the inert sandbox records what the seam actually dispatched.
 */
const DB = 'p@ss word "quoted"';
const TOKEN = 'tok-abcdef123456';
const secrets = () => [
  { id: 'db', kind: 'password', value: DB, label: 'fixture database' },
  { id: 'api', kind: 'token', value: TOKEN, scope: 'fixture-api' },
];
const writeIdentity = async (root: string, body: unknown, name = 'identity.json') => {
  const path = join(root, name);
  await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
};
const start = (h: any, path: string) => h.command(`--target ./source --identity ${path}`);
const controlRun = async (h: any): Promise<string> =>
  (await readdir(join(h.root, 'control'))).find((name: string) => name.startsWith('p2o-run-'))!;
const ledgerJson = (records: readonly any[]) => JSON.stringify(records);
const facts = (overrides: Partial<PlannerPromptFacts> = {}): PlannerPromptFacts => ({
  runId: 'run-identity', targetLabel: '/fixture', targetKind: 'directory', sourceSkipped: 0,
  delegation: { enabled: false, reason: 'fixture', maxWorkers: 0, maxDepth: 0 }, phase: 'active', loopMode: 'manual', executorMode: 'shared', ...overrides,
});
const ticket = (overrides: Record<string, unknown> = {}) => ({ workerId: 'p2o-general-abc123', role: 'general', depth: 1, parentWorkerId: null,
  target: { kind: 'directory', label: '/fixture' }, executorMode: 'shared', ...overrides } as never);

describe('--identity validation (A7.4)', () => {
  it('accepts one absolute path only, and never resolves a relative one against a model-chosen cwd', () => {
    expect(parseCommand('--target ./source --identity /tmp/identity.json')).toMatchObject({ action: 'start', options: { identityPath: '/tmp/identity.json' } });
    expect(() => parseCommand('--target ./source --identity relative.json')).toThrow(/absolute path/);
    expect(() => parseCommand('--target ./source --identity /tmp/a.json --identity /tmp/b.json')).toThrow(/only once/);
    expect(() => parseCommand('--target ./source --identity')).toThrow(/absolute path/);
  });

  it('fails the start before any run exists when the file is unreadable, malformed or has a duplicate id', async () => fixture(async h => {
    // The command boundary reports a failed start through the operator channel; it never leaves a half-open run behind.
    const attempt = async (path: string) => { await start(h, path); return String(h.ctx.notices.at(-1) ?? ''); };
    expect(await attempt(await writeIdentity(h.root, '{ not json'))).toContain('--identity: Identity file must contain valid JSON');
    expect(await readdir(join(h.root, '.p2o-state')).catch(() => [])).toEqual([]);
    const duplicate = await writeIdentity(h.root, { secrets: [{ id: 'db', kind: 'password', value: 'a' }, { id: 'db', kind: 'token', value: 'b' }] }, 'dupe.json');
    expect(await attempt(duplicate)).toContain('Duplicate secret id: db');
    const unknownField = await writeIdentity(h.root, { secrets: [{ id: 'db', kind: 'password', value: 'a', extra: true }] }, 'extra.json');
    expect(await attempt(unknownField)).toContain('unknown field: extra');
    expect(await attempt(join(h.root, 'missing.json'))).toContain('--identity:');
    // Nothing was started, so no control directory and no sandbox exists.
    expect(await readdir(join(h.root, 'control')).catch(() => [])).toEqual([]);
    expect(h.sandboxes).toEqual([]);
  }));

  it('seals a 0600 canonical copy in the control directory and records only the digest and count', async () => fixture(async h => {
    const path = await writeIdentity(h.root, { secrets: secrets() });
    await start(h, path);
    const directory = join(h.root, 'control', await controlRun(h), 'identity');
    const sealed = join(directory, 'identity.json');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(sealed)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(sealed, 'utf8')).secrets).toEqual(secrets());
    const store = await h.reader();
    try {
      const records = store.records();
      const record = records.find((row: any) => row.data?.identity);
      expect(record.data.identity.count).toBe(2);
      expect(record.data.identity.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.text).toContain('identity sealed');
      expect(ledgerJson(records)).not.toContain(DB);
      expect(ledgerJson(records)).not.toContain(TOKEN);
    } finally { store.close(); }
  }));
});

describe('substitution at the one dispatch seam (A7.4)', () => {
  it('quotes a shell value as one word, audits the use by id and redacts the returned output', async () => fixture(async h => {
    const path = await writeIdentity(h.root, { secrets: secrets() });
    await start(h, path);
    const sandbox = h.sandboxes[0];
    const result = await h.call('p2o_shell', { command: 'printf %s ${P2O_SECRET:db}' });
    expect(result.details.exitCode).toBe(0);
    // The executor received one POSIX word, not a raw splice that the shell could split again.
    expect(sandbox.commands.at(-1).command).toBe(`printf %s '${DB}'`);
    // The inert executor echoes its command; the value came back only as a marker.
    expect(result.content[0].text).toContain('[REDACTED:db]');
    expect(result.content[0].text).not.toContain(DB);
    const artifact = result.details.capture.artifacts[0];
    const read = await h.call('p2o_artifact', { id: artifact.id });
    expect(read.content[0].text).not.toContain(DB);
    const store = await h.reader();
    try {
      const records = store.records();
      const use = records.find((row: any) => row.data?.secretUse);
      expect(use.data.secretUse).toMatchObject({ ids: ['db'], operation: 'shell' });
      expect(use.text).toContain('secrets used: db');
      expect(ledgerJson(records)).not.toContain(DB);
      // The receipt excerpt is redacted too; the artifact bytes in the store are scanned directly.
      const evidence = records.find((row: any) => row.kind === 'evidence' && row.data?.stdout?.includes('[REDACTED:db]'));
      expect(evidence).toBeTruthy();
      expect(store.artifact(artifact.id, 0, 8192).text).not.toContain(DB);
    } finally { store.close(); }
  }));

  it('refuses an unknown id or a spliced placeholder before any byte reaches a container', async () => fixture(async h => {
    const path = await writeIdentity(h.root, { secrets: secrets() });
    await start(h, path);
    const sandbox = h.sandboxes[0];
    await expect(h.call('p2o_shell', { command: 'printf ${P2O_SECRET:nope}' })).rejects.toThrow(/SECRET_SUBSTITUTION: Unknown secret id: nope/);
    // Not a standalone word: `x'`value`'` would change what the command means, so it is refused, not guessed.
    await expect(h.call('p2o_shell', { command: 'printf x${P2O_SECRET:db}' })).rejects.toThrow(/SECRET_SUBSTITUTION: Secret placeholder must be a standalone shell word/);
    expect(sandbox.commands).toEqual([]);
  }));

  it('lets the command policy decide first: a denied command is never expanded and leaves no use audit', async () => fixture(async h => {
    await writeFile(join(h.root, 'settings.json'), JSON.stringify({ p2o: { commandPolicy: { rules: [{ action: 'deny', match: 'example.test', reason: 'fixture denies this destination' }] } } }));
    const path = await writeIdentity(h.root, { secrets: secrets() });
    await start(h, path);
    await expect(h.call('p2o_shell', { command: 'curl http://example.test/ ${P2O_SECRET:db}' })).rejects.toThrow(/POLICY_DENY: operator\.deny\.0/);
    expect(h.sandboxes[0].commands).toEqual([]);
    const store = await h.reader();
    try {
      const records = store.records();
      expect(records.some((row: any) => row.data?.secretUse)).toBe(false);
      expect(records.some((row: any) => row.data?.policyDecision)).toBe(true);
    } finally { store.close(); }
  }));

  it('substitutes URL, header and body values for one request and records the principal', async () => fixture(async h => {
    const path = await writeIdentity(h.root, { secrets: secrets() });
    await start(h, path);
    const sandbox = h.sandboxes[0];
    const result = await h.call('p2o_http', { url: 'http://fixture.test/login?who=${P2O_SECRET:api}', method: 'POST', principal: 'alpha',
      headers: { Authorization: 'Bearer ${P2O_SECRET:api}', 'X-Db': '${P2O_SECRET:db}' }, body: 'pass=${P2O_SECRET:db}' });
    expect(result.details.exitCode).toBe(0);
    expect(sandbox.httpCalls).toHaveLength(1);
    expect(sandbox.httpCalls[0]).toMatchObject({
      url: `http://fixture.test/login?who=${TOKEN}`,
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Db': DB },
      body: `pass=${DB}`,
      principal: 'alpha',
    });
    await h.call('p2o_http', { url: 'http://fixture.test/second', principal: 'beta' });
    expect(sandbox.httpCalls[1].principal).toBe('beta');
    const store = await h.reader();
    try {
      const uses = store.records().filter((row: any) => row.data?.secretUse).map((row: any) => row.data.secretUse);
      expect(uses[0]).toMatchObject({ ids: ['api', 'db'], operation: 'http' });
      expect(ledgerJson(store.records())).not.toContain(TOKEN);
    } finally { store.close(); }
  }));

  it('refuses a substituted header a value would break, instead of sending injected bytes', async () => fixture(async h => {
    const path = await writeIdentity(h.root, { secrets: [{ id: 'evil', kind: 'header', value: 'ok\r\nX-Injected: 1' }] });
    await start(h, path);
    await expect(h.call('p2o_http', { url: 'http://fixture.test/x', headers: { 'X-Test': '${P2O_SECRET:evil}' } })).rejects.toThrow(/SECRET_SUBSTITUTION: Invalid value for header X-Test/);
    expect(h.sandboxes[0].httpCalls).toEqual([]);
  }));

  it('reports a per-principal cookie jar rather than letting principals share one jar', () => {
    const jars = new HttpSessions(() => 1_000_000), url = new URL('https://fixture.test/a');
    jars.store('alpha', 'default', url, [['set-cookie', 'sid=alpha-only; Path=/']]);
    expect(jars.header('alpha', 'default', url)).toBe('sid=alpha-only');
    expect(jars.header('beta', 'default', url)).toBeUndefined();
    expect(jars.header('alpha', 'other', url)).toBeUndefined();
    // A reset names one principal; another principal's jar is untouched.
    jars.reset('beta', 'default', url);
    expect(jars.header('alpha', 'default', url)).toBe('sid=alpha-only');
  });
});

describe('identity surfaces (A7.4)', () => {
  it('says no identity exists when the operator sealed none', async () => fixture(async h => {
    await h.command('--target ./source');
    const empty = await h.call('p2o_secret', { action: 'list' });
    expect(empty.details.secrets).toEqual([]);
    expect(empty.content[0].text).toContain('sealed no identity');
  }));

  it('lists ids and kinds only, from the owner identity', async () => fixture(async h => {
    const path = await writeIdentity(h.root, { secrets: secrets() });
    await start(h, path);
    const listed = await h.call('p2o_secret', { action: 'list' });
    expect(listed.details.secrets).toEqual([
      { id: 'api', kind: 'token', scope: 'fixture-api' },
      { id: 'db', kind: 'password', label: 'fixture database' },
    ]);
    expect(listed.content[0].text).not.toContain(DB);
    expect(listed.content[0].text).not.toContain(TOKEN);
  }));

  it('tells the worker and the planner that an identity exists without ever carrying a value', () => {
    const worker = workerInstructions(ticket({ secrets: 2 }));
    expect(worker).toContain('IDENTITY CHANNEL');
    expect(worker).toContain('p2o_secret action=list');
    expect(worker).toContain('${P2O_SECRET:<id>}');
    expect(worker).not.toContain(DB);
    expect(workerInstructions(ticket())).not.toContain('IDENTITY CHANNEL');
    const planner = plannerInstructions(facts({ secrets: 2 }));
    expect(planner).toContain('IDENTITY CHANNEL');
    expect(planner).not.toContain(DB);
    expect(plannerInstructions(facts())).not.toContain('IDENTITY CHANNEL');
  });

  it('prints the sealed count, the audited uses and the exposure limitation in the deterministic report', async () => fixture(async h => {
    const path = await writeIdentity(h.root, { secrets: secrets() });
    await start(h, path);
    await h.call('p2o_shell', { command: 'printf %s ${P2O_SECRET:db}' });
    await h.call('p2o_http', { url: 'http://fixture.test/x', headers: { Authorization: 'Bearer ${P2O_SECRET:api}' } });
    await h.command(`report export ${join(h.root, 'out')}`);
    const directory = join(h.root, 'out');
    const files = await Promise.all((await readdir(directory)).map(async name => [name, await readFile(join(directory, name), 'utf8')] as const));
    const report = files.find(([name]) => name === 'REPORT.md')![1];
    // The renderer Markdown-escapes parentheses; undo that for a readable assertion of the recorded facts.
    const plain = report.replace(/\\([()])/g, '$1');
    expect(plain).toContain('- Secrets used by id: 2 use(s) by id: api (1), db (1)');
    expect(plain).toContain('The operator declared 2 secret(s)');
    expect(plain).toContain('can still print or forward the substituted value');
    for (const [, body] of files) {
      expect(body).not.toContain(DB);
      expect(body).not.toContain(TOKEN);
    }
  }));

  it('leaves no value anywhere in the store after stop, and removes the sealed copy with the control directory', async () => fixture(async h => {
    const path = await writeIdentity(h.root, { secrets: secrets() });
    await start(h, path);
    await h.call('p2o_shell', { command: 'printf %s ${P2O_SECRET:db} ${P2O_SECRET:api}' });
    const store = await h.reader();
    const runId = await h.runId();
    try {
      // The whole committed state, record by record, plus every retained artifact body.
      expect(ledgerJson(store.records())).not.toContain(DB);
      expect(ledgerJson(store.records())).not.toContain(TOKEN);
      expect(store.records().some((row: any) => row.data?.secretUse)).toBe(true);
      for (const artifact of store.artifacts()) expect(store.artifact(artifact.id, 0, 8192).text).not.toContain(DB);
      const same = containsSecretValue(ledgerJson(store.records()), { secrets: secrets() as never });
      expect(same).toBeUndefined();
    } finally { store.close(); }
    await h.command('stop');
    // The sealed copy is part of the control directory cleanup, not durable knowledge.
    expect(await readdir(join(h.root, 'control')).catch(() => [])).toEqual([]);
    expect(await readdir(join(h.root, '.p2o-state', runId)).catch(() => [])).not.toEqual([]);
  }));
});

describe('worker secret listing (broker)', () => {
  it('answers a registered worker with ids and kinds only, and never a value', async () => {
    const control = await mkdtemp(join(tmpdir(), 'p2o-identity-broker-'));
    const registration: WorkerRegistration = {
      workerId: 'p2o-recon-aaaaaa', name: 'p2o-recon-aaaaaa', paneId: 'w1T:p8', role: 'recon', depth: 1,
      parentWorkerId: null, token: 'c'.repeat(32), used: 0, startedAt: Date.now(), stopped: false,
    };
    const broker = new Broker(control, {
      exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
      http: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
      note: async () => undefined,
      ledger: async () => [],
      delegate: async () => ({ workerId: 'p2o-general-bbbbbb', name: 'p2o-general-bbbbbb', paneId: 'w1T:p9', role: 'general', depth: 2 }),
      report: async () => undefined,
      secretList: async () => ({ secrets: [{ id: 'api', kind: 'token' }, { id: 'db', kind: 'password' }] }),
    }, {});
    broker.register(registration);
    const socket = await broker.start();
    const client = new BrokerClient(socket, 'c'.repeat(32), { requestMs: 2000 });
    try {
      const listed = await client.request<{ value: unknown }>('secret_list', {});
      expect(listed.value).toEqual({ secrets: [{ id: 'api', kind: 'token' }, { id: 'db', kind: 'password' }] });
      expect(JSON.stringify(listed)).not.toContain(DB);
      expect(JSON.stringify(listed)).not.toContain(TOKEN);
    } finally { client.close(); await broker.stop(); await rm(control, { recursive: true, force: true }); }
  });
});
