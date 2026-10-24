import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker, BrokerClient, normalizeReport, type WorkerRegistration } from '../../src/broker.js';
import { appendRecord, readRecords } from '../../src/records.js';

const REGISTRATION = (patch: Partial<WorkerRegistration> = {}): WorkerRegistration => ({
  workerId: 'p2o-recon-aaaaaa', name: 'p2o-recon-aaaaaa', paneId: 'w1T:p9', role: 'recon', depth: 1,
  parentWorkerId: null, token: 'c'.repeat(32), used: 0, startedAt: Date.now(), stopped: false, ...patch,
});

async function fixture(patch: { stdout?: string; registration?: Partial<WorkerRegistration>; reportFails?: boolean } = {}) {
  const control = await mkdtemp(join(tmpdir(), 'p2o-broker-'));
  const records = join(control, 'records.jsonl');
  await writeFile(records, '', { mode: 0o600 });
  const calls: string[] = [];
  const registrations = new Map<string, WorkerRegistration>();
  const broker = new Broker(control, {
    exec: async (command, seconds, workdir) => { calls.push(`exec ${workdir} ${seconds} ${command}`); return { code: 0, stdout: patch.stdout ?? `ran ${command}`, stderr: '', truncated: false }; },
    http: async request => { calls.push(`http ${request.method} ${request.url}${request.body ? ` body=${request.body}` : ''}${request.headers ? ` headers=${Object.keys(request.headers).join(',')}` : ''}`); return { code: 0, stdout: `fetched ${request.url}`, stderr: '', truncated: false }; },
    note: async record => { calls.push(`note ${record.kind}`); await appendRecord(records, record); },
    ledger: async limit => (await readRecords(records, limit)),
    delegate: async (input, parent) => { calls.push(`delegate ${parent.workerId} ${input.role}`); return { workerId: 'p2o-general-bbbbbb', name: 'p2o-general-bbbbbb', paneId: 'w1T:p10', role: input.role ?? 'general', depth: parent.depth + 1 }; },
    report: async (workerId, report) => { if (patch.reportFails) throw Error('inert report storage failure'); calls.push(`report ${workerId} ${report.confidence}`); },
    // P14.3: the host orchestrates a recipe, but every command it runs is admitted here, in the caller's own sandbox.
    environment: async (op, request, registration, control) => {
      calls.push(`env ${op} ${registration.workerId}`);
      if (op === 'create') return { id: 'env-11111111-1111-4111-8111-111111111111', name: String(request.name), fingerprint: 'a'.repeat(64), revision: 1, created: true };
      const steps: number[] = [];
      for (const command of ['prepare', 'launch', 'seed']) steps.push((await control.exec(command)).code);
      return { id: String(request.id), fingerprint: 'a'.repeat(64), revision: 1, steps };
    },
    onProblem: problem => { calls.push(`problem ${problem}`); },
  }, {});
  for (const registration of [REGISTRATION(patch.registration)]) { broker.register(registration); registrations.set(registration.workerId, registration); }
  const socket = await broker.start();
  return { control, records, calls, broker, registrations, socket, close: async () => { await broker.stop(); await rm(control, { recursive: true, force: true }); } };
}

describe('sandbox broker', () => {
  it('bounds escaped wire output and preserves the connection for a blocked report', async () => {
    const f = await fixture({ stdout: '\u0000'.repeat(48 * 1024) });
    const client = new BrokerClient(f.socket, 'c'.repeat(32), { requestMs: 2000 });
    try {
      const result = await client.request('exec', { command: 'cat binary' });
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
      await client.request('report', { report: { summary: 'bounded result', blocked: 'output truncated', confidence: 'low' } });
      expect(f.broker.registration('p2o-recon-aaaaaa')?.reported?.blocked).toBe('output truncated');
    } finally { client.close(); await f.close(); }
  });

  it('counts commands without ever refusing them, so a long exploitation iteration is not cut off', async () => {
    // Owner decision 2026-10-24: p2o has no command allowance. 201 admitted commands is the regression that proves it.
    const f = await fixture({ registration: { purpose: 'exploitation', used: 0 } });
    try {
      const client = new BrokerClient(f.socket, REGISTRATION({ purpose: 'exploitation' }).token, { requestMs: 10_000 });
      try {
        for (let index = 0; index < 201; index += 1) await client.request('exec', { command: `step-${index}` });
        expect(f.broker.registration('p2o-recon-aaaaaa')?.used).toBe(201);
        // No refusal is recorded for an allowance, and a report needs no wrap-up: there is nothing to wrap up from.
        expect(f.calls.some(call => call.startsWith('budget '))).toBe(false);
        const reported = await client.request('report', { report: { summary: 'ran the whole iteration', confidence: 'medium', outcome: 'partial-budget' } });
        expect(reported.ok).toBe(true);
        expect(f.broker.registration('p2o-recon-aaaaaa')?.reported?.summary).toBe('ran the whole iteration');
      } finally { client.close(); }
    } finally { await f.close(); }
  });

  it('publishes an owner-private socket and runs exec/http/note/report/delegate for an authenticated worker', async () => {
    const f = await fixture();
    const client = new BrokerClient(f.socket, 'c'.repeat(32), { connectMs: 2000, requestMs: 5000 });
    try {
      const mode = await stat(f.socket);
      expect(mode.mode & 0o777).toBe(0o600);
      await expect(client.request('capabilities')).rejects.toThrow(/unknown|unsupported/i);
      const status = await client.request('status');
      expect(status).toMatchObject({ workerId: 'p2o-recon-aaaaaa', used: 0, reported: false });
      const executed = await client.request('exec', { command: 'id -u', timeout: 10 });
      expect(executed).toMatchObject({ ok: true, code: 0, stdout: 'ran id -u' });
      expect(f.calls).toContain('exec /work/p2o-recon-aaaaaa 10 id -u');
      expect(await client.request('http', { url: '/a', method: 'HEAD' })).toMatchObject({ ok: true, stdout: 'fetched /a' });
      expect(f.calls).toContain('http HEAD /a');
      await client.request('note', { kind: 'coverage', text: 'clean', surface: '/a', risk: 'xss', outcome: 'clean' });
      const records = await readRecords(f.records);
      expect(records.at(-1)).toMatchObject({ by: 'p2o-recon-aaaaaa', kind: 'coverage', surface: '/a', outcome: 'clean', depth: 1 });
      const delegated = await client.request('delegate', { focus: 'nested', task: 'do a thing', role: 'validation' });
      expect(delegated.worker).toMatchObject({ workerId: 'p2o-general-bbbbbb', depth: 2 });
      await client.request('report', { report: { summary: 'done', confidence: 'high', coverage: [{ surface: '/a', risk: 'xss', outcome: 'clean' }], findings: [], evidence: [], openItems: [] } });
      expect(f.broker.registration('p2o-recon-aaaaaa')?.reported?.summary).toBe('done');
      // Reporting ends this worker's authority: its token, even from a copied ticket, is refused afterwards.
      await expect(client.request('report', { report: { summary: 'again', confidence: 'low' } })).rejects.toThrow(/stopped by the owner/);
      expect(f.broker.registration('p2o-recon-aaaaaa')?.stopped).toBe(true);
    } finally { client.close(); await f.close(); }
  });

  it('carries full HTTP verbs, bodies, headers and network commands across the broker', async () => {
    const f = await fixture();
    const client = new BrokerClient(f.socket, 'c'.repeat(32), { requestMs: 5000 });
    try {
      const posted = await client.request('http', { url: '/login', method: 'post', body: 'user=a', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, followRedirects: false });
      expect(posted).toMatchObject({ ok: true, stdout: 'fetched /login' });
      expect(f.calls).toContain('http POST /login body=user=a headers=Content-Type');
      const scanned = await client.request('net', { command: 'nmap -sT 10.0.0.7', timeout: 120 });
      expect(scanned).toMatchObject({ ok: true, stdout: 'ran nmap -sT 10.0.0.7' });
      expect(f.calls).toContain('exec /work/p2o-recon-aaaaaa 120 nmap -sT 10.0.0.7');
      // Validation happens before any budget is spent.
      const used = (await client.request('status')).used;
      await expect(client.request('http', { url: '/a', method: 'bad method' })).rejects.toThrow(/HTTP token/);
      for(const data of [{method:123},{body:42},{followRedirects:'yes'},{maxRedirects:1.5},{session:'../x'}]) await expect(client.request('http',{url:'/a',...data})).rejects.toThrow();
      await expect(client.request('http', { url: '/a', headers: { 'X-Test': 'a\r\nb: 1' } })).rejects.toThrow(/Invalid value/);
      await expect(client.request('http', { url: '/a', headers: { 'Content-Length': '9' } })).rejects.toThrow(/cannot be overridden/);
      await expect(client.request('http', { url: '/a', body: 'x'.repeat(40_000) })).rejects.toThrow(/at most/);
      await expect(client.request('http', { url: '/a', body: 'x'.repeat(70_000) })).rejects.toThrow(/frame limit/);
      await expect(client.request('net', { command: 'id', timeout: -1 })).rejects.toThrow(/non-negative/);
      await expect(client.request('net', { command: 'id', timeout: 300 })).resolves.toMatchObject({ ok: true });
      expect((await client.request('status')).used).toBe(used + 1);
    } finally { client.close(); await f.close(); }
  });

  it('rejects an unauthenticated or revoked worker', async () => {
    const f = await fixture();
    try {
      const stranger = new BrokerClient(f.socket, 'd'.repeat(32), { connectMs: 2000, requestMs: 3000 });
      await expect(stranger.request('status')).rejects.toThrow(/rejected|unauthorized/i);
      stranger.close();
      const client = new BrokerClient(f.socket, 'c'.repeat(32), { connectMs: 2000, requestMs: 5000 });
      await client.request('exec', { command: 'one' });
      await client.request('exec', { command: 'two' });
      f.broker.revoke('p2o-recon-aaaaaa');
      await expect(client.request('exec', { command: 'four' })).rejects.toThrow(/stopped by the owner/);
      client.close();
    } finally { await f.close(); }
  });

  it('refuses oversized or unknown requests', async () => {
    const f = await fixture();
    const client = new BrokerClient(f.socket, 'c'.repeat(32), { connectMs: 2000, requestMs: 5000 });
    try {
      await expect(client.request('nonsense')).rejects.toThrow(/unsupported broker operation/);
      await expect(client.request('exec', { command: 'x'.repeat(9000) })).rejects.toThrow(/1\.\.8192/);
      await expect(client.request('exec', { command: 'id', timeout: 1.5 })).rejects.toThrow(/non-negative/);
      await expect(client.request('http', { url: '' })).rejects.toThrow(/url must be/);
      await expect(client.request('note', { kind: 'lifecycle', text: 'nope' })).rejects.toThrow(/kind must be/);
    } finally { client.close(); await f.close(); }
  });

  it('reads the shared ledger for a worker, bounded to the requested page', async () => {
    const f = await fixture();
    const client = new BrokerClient(f.socket, 'c'.repeat(32), { connectMs: 2000, requestMs: 5000 });
    try {
      await client.request('note', { kind: 'observation', text: 'worker note' });
      await appendRecord(f.records, { at: new Date().toISOString(), by: 'owner', kind: 'note', text: 'lead note' });
      const ledger = await client.request('ledger', { limit: 2 });
      expect(ledger.records.map((entry: any) => entry.text)).toEqual(['worker note', 'lead note']);
      const bounded = await client.request('ledger', { limit: 999 });
      expect(bounded.records.length).toBeLessThanOrEqual(100);
    } finally { client.close(); await f.close(); }
  });

  it('ends an in-flight command wait when the owner stops the worker', async () => {
    const control = await mkdtemp(join(tmpdir(), 'p2o-broker-abort-'));
    const records = join(control, 'records.jsonl');
    await writeFile(records, '', { mode: 0o600 });
    let started: () => void = () => {}, starts=0;
    const began = new Promise<void>(resolve => { started = resolve; });
    const broker = new Broker(control, {
      exec: (_command, _seconds, _workdir, signal) => new Promise((_resolve, reject) => {
        if (++starts===2) started();
        signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      }),
      http: async () => { throw new Error('unused'); },
      note: async () => {},
      ledger: async () => [],
      delegate: async () => { throw new Error('unused'); },
      report: async () => {},
    }, {});
    broker.register(REGISTRATION());
    await broker.start();
    const client = new BrokerClient(broker.socket, 'c'.repeat(32), { connectMs: 2000, requestMs: 30_000 });
    const copied = new BrokerClient(broker.socket, 'c'.repeat(32), { connectMs:2000,requestMs:30000 });
    try {
      const pending = client.request('exec', { command: 'sleep 60', timeout: 60 });
      const other = copied.request('exec',{command:'sleep 60',timeout:60});
      await began;
      broker.revoke('p2o-recon-aaaaaa');
      const results=await Promise.allSettled([pending,other]);expect(results.every(r=>r.status==='rejected')).toBe(true);
    } finally { client.close(); copied.close(); await broker.stop(); await rm(control, { recursive: true, force: true }); }
  });

  it('fails closed when the owner goes away', async () => {
    const f = await fixture();
    try {
      const client = new BrokerClient(f.socket, 'c'.repeat(32), { connectMs: 2000, requestMs: 5000 });
      await client.request('status');
      await f.broker.stop();
      await expect(client.request('status')).rejects.toThrow(/Do not retry/);
      client.close();
    } finally { await f.close(); }
  });

  it('never refuses a knowledge read or a coordination call, because there is no allowance to exhaust', async () => {
    const f=await fixture();const client=new BrokerClient(f.socket,'c'.repeat(32),{requestMs:2000});
    try {
      // 200 reads and 200 notes is ten times the retired read/coordination split; every one must be admitted.
      for(let i=0;i<200;i++)await client.request('note',{kind:'open',text:'bounded fixture gap '+i});
      for(let i=0;i<200;i++)await client.request('ledger',{limit:1});
      await client.request('report',{report:{summary:'Long knowledge loop finished',confidence:'low'}});
      expect(f.broker.registration('p2o-recon-aaaaaa')?.reported?.summary).toBe('Long knowledge loop finished');
    } finally {client.close();await f.close();}
  });
  it('blocks a known runtime mismatch and preserves correlated report-failure/oversize errors', async () => {
    const f=await fixture({registration:{requestedRuntime:{model:'fixture-provider/model',thinking:'xhigh'}},reportFails:true});
    const client=new BrokerClient(f.socket,'c'.repeat(32),{requestMs:1000});
    try {
      expect(await client.request('runtime',{model:'fixture-provider/model',thinking:'medium'})).toMatchObject({verified:false});
      await expect(client.request('exec',{command:'true'})).rejects.toThrow('profile mismatch');
      await expect(client.request('report',{report:{summary:'x'.repeat(70000)}})).rejects.toThrow('frame limit');
      await expect(client.request('report',{report:{summary:'Mismatch; no investigation',confidence:'low'}})).rejects.toThrow('inert report storage failure');
      expect((await client.request('status')).reported).toBe(false);expect(f.calls.some(c=>c.startsWith('exec'))).toBe(false);
    } finally {client.close();await f.close();}
  });

  it('normalizes untrusted worker reports instead of trusting their shape', () => {
    expect(normalizeReport(null)).toMatchObject({ summary: '(no summary supplied)', confidence: 'low', findings: [], coverage: [] });
    const report = normalizeReport({
      summary: 'x'.repeat(9000), confidence: 'certain', findings: ['a', 7, 'b'], evidence: ['e1'],
      coverage: [{ surface: '/a', risk: 'rce', outcome: 'confirmed' }, { surface: '/b', risk: 'xss', outcome: 'nonsense' }, { surface: '', risk: '', outcome: 'clean' }],
      openItems: ['gap'], blocked: 'no network',
    });
    expect(report.summary.length).toBe(4000);
    expect(report.confidence).toBe('low');
    expect(report.findings).toEqual(['a', 'b']);
    expect(report.coverage).toEqual([{ surface: '/a', risk: 'rce', outcome: 'confirmed' }]);
    expect(report.blocked).toBe('no network');
  });

  it('never leaves the socket file behind after stop', async () => {
    const f = await fixture();
    await f.broker.stop();
    await expect(stat(f.socket)).rejects.toThrow();
    await rm(f.control, { recursive: true, force: true });
    expect(await readFile('/dev/null', 'utf8').catch(() => '')).toBeDefined();
  });
});

describe('environment recipes over the broker (P14.3)', () => {
  const SECOND = REGISTRATION({ workerId: 'p2o-discovery-bbbbbb', name: 'p2o-discovery-bbbbbb', role: 'discovery', token: 'd'.repeat(32) });
  it('runs the recipe as admitted target commands in each caller’s own sandbox, so two workers see one fingerprint', async () => {
    const f = await fixture();
    const first = new BrokerClient(f.socket, 'c'.repeat(32), { requestMs: 2000 });
    const second = new BrokerClient(f.socket, SECOND.token, { requestMs: 2000 });
    f.broker.register(SECOND);
    try {
      const created = await first.request('environment', { action: 'create', name: 'fixture-app', recipe: { setup: ['make'] } });
      expect(created.value).toMatchObject({ fingerprint: 'a'.repeat(64), created: true });
      let verified: any;
      try { verified = await second.request('environment', { action: 'verify', id: created.value.id }); } catch (error) { console.log('DBG-VERIFY-ERR', (error as Error).message, JSON.stringify(f.calls.slice(-6)), 'used', f.broker.registration(SECOND.workerId)?.used); throw error; }
      // The second worker reproduces in the same fingerprint, in its own scratch directory.
      expect(verified.value).toMatchObject({ fingerprint: created.value.fingerprint, revision: 1 });
      expect(f.calls.filter(call => call.startsWith('exec /work/p2o-discovery-bbbbbb 0'))).toHaveLength(3);
      expect(f.broker.registration(SECOND.workerId)?.used).toBe(3);
      // A second verify runs its own three commands; there is no allowance to be spent, so nothing refuses it.
      const again = await second.request('environment', { action: 'verify', id: created.value.id });
      expect(again.value).toMatchObject({ fingerprint: created.value.fingerprint });
      expect(f.calls.filter(call => call.startsWith('exec /work/p2o-discovery-bbbbbb 0'))).toHaveLength(6);
    } finally { first.close(); second.close(); await f.close(); }
  });
});
