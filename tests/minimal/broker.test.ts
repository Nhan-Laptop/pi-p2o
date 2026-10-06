import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker, BrokerClient, normalizeReport, type WorkerRegistration } from '../../src/broker.js';
import { appendRecord, readRecords } from '../../src/records.js';

const REGISTRATION = (patch: Partial<WorkerRegistration> = {}): WorkerRegistration => ({
  workerId: 'p2o-recon-aaaaaa', name: 'p2o-recon-aaaaaa', paneId: 'w1T:p9', role: 'recon', depth: 1,
  parentWorkerId: null, token: 'c'.repeat(32), commandBudget: 3, used: 0, startedAt: Date.now(), stopped: false, ...patch,
});

async function fixture(patch: { budget?: number; total?: number; registration?: Partial<WorkerRegistration> } = {}) {
  const control = await mkdtemp(join(tmpdir(), 'p2o-broker-'));
  const records = join(control, 'records.jsonl');
  await writeFile(records, '', { mode: 0o600 });
  const calls: string[] = [];
  const registrations = new Map<string, WorkerRegistration>();
  const broker = new Broker(control, {
    exec: async (command, seconds, workdir) => { calls.push(`exec ${workdir} ${seconds} ${command}`); return { code: 0, stdout: `ran ${command}`, stderr: '', truncated: false }; },
    http: async (url, method) => { calls.push(`http ${method} ${url}`); return { code: 0, stdout: `fetched ${url}`, stderr: '', truncated: false }; },
    note: async record => { calls.push(`note ${record.kind}`); await appendRecord(records, record); },
    ledger: async limit => (await readRecords(records, limit)),
    delegate: async (input, parent) => { calls.push(`delegate ${parent.workerId} ${input.role}`); return { workerId: 'p2o-general-bbbbbb', name: 'p2o-general-bbbbbb', paneId: 'w1T:p10', role: input.role ?? 'general', depth: parent.depth + 1 }; },
    report: async (workerId, report) => { calls.push(`report ${workerId} ${report.confidence}`); },
    onProblem: problem => { calls.push(`problem ${problem}`); },
  }, { totalCommandBudget: patch.total ?? 100 });
  for (const registration of [REGISTRATION(patch.registration)]) { broker.register(registration); registrations.set(registration.workerId, registration); }
  const socket = await broker.start();
  return { control, records, calls, broker, registrations, socket, close: async () => { await broker.stop(); await rm(control, { recursive: true, force: true }); } };
}

describe('sandbox broker', () => {
  it('publishes an owner-private socket and runs exec/http/note/report/delegate for an authenticated worker', async () => {
    const f = await fixture();
    const client = new BrokerClient(f.socket, 'c'.repeat(32), { connectMs: 2000, requestMs: 5000 });
    try {
      const mode = await stat(f.socket);
      expect(mode.mode & 0o777).toBe(0o600);
      const status = await client.request('status');
      expect(status).toMatchObject({ workerId: 'p2o-recon-aaaaaa', used: 0, budget: 3, reported: false });
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

  it('rejects an unauthenticated or revoked worker and enforces per-worker and reserve budgets', async () => {
    const f = await fixture({ registration: { commandBudget: 2 } });
    try {
      const stranger = new BrokerClient(f.socket, 'd'.repeat(32), { connectMs: 2000, requestMs: 3000 });
      await expect(stranger.request('status')).rejects.toThrow(/rejected|unauthorized/i);
      stranger.close();
      const client = new BrokerClient(f.socket, 'c'.repeat(32), { connectMs: 2000, requestMs: 5000 });
      await client.request('exec', { command: 'one' });
      await client.request('exec', { command: 'two' });
      await expect(client.request('exec', { command: 'three' })).rejects.toThrow(/budget exhausted/);
      f.broker.revoke('p2o-recon-aaaaaa');
      await expect(client.request('exec', { command: 'four' })).rejects.toThrow(/stopped by the owner/);
      client.close();
    } finally { await f.close(); }
  });

  it('stops workers at the shared reserve and refuses oversized or unknown requests', async () => {
    const f = await fixture({ registration: { commandBudget: 50 }, total: 10 });
    const client = new BrokerClient(f.socket, 'c'.repeat(32), { connectMs: 2000, requestMs: 5000 });
    try {
      for (let index = 0; index < 9; index += 1) await client.request('exec', { command: `cmd-${index}` });
      await expect(client.request('exec', { command: 'over-reserve' })).rejects.toThrow(/reserve reached/);
      await expect(client.request('nonsense')).rejects.toThrow(/unsupported broker operation/);
      await expect(client.request('exec', { command: 'x'.repeat(9000) })).rejects.toThrow(/1\.\.8192/);
      await expect(client.request('exec', { command: 'id', timeout: 900 })).rejects.toThrow(/1\.\.60/);
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
    let started: () => void = () => {};
    const began = new Promise<void>(resolve => { started = resolve; });
    const broker = new Broker(control, {
      exec: (_command, _seconds, _workdir, signal) => new Promise((_resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      }),
      http: async () => { throw new Error('unused'); },
      note: async () => {},
      ledger: async () => [],
      delegate: async () => { throw new Error('unused'); },
      report: async () => {},
    }, { totalCommandBudget: 50 });
    broker.register(REGISTRATION());
    await broker.start();
    const client = new BrokerClient(broker.socket, 'c'.repeat(32), { connectMs: 2000, requestMs: 30_000 });
    try {
      const pending = client.request('exec', { command: 'sleep 60', timeout: 60 });
      await began;
      broker.revoke('p2o-recon-aaaaaa');
      await expect(pending).rejects.toThrow(/Cancelled|stopped by the owner/);
    } finally { client.close(); await broker.stop(); await rm(control, { recursive: true, force: true }); }
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
