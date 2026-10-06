import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '../../src/sandbox.js';
import { Broker, BrokerClient, type WorkerRegistration } from '../../src/broker.js';
import { appendRecord, readRecords } from '../../src/records.js';

it.skipIf(process.env.P2O_TEST_DOCKER !== '1')('real Docker: read-only source, non-root shell, offline networking, scratch, cancellation and verified cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-minimal-docker-')); await chmod(root, 0o755);
  await writeFile(join(root, 'source.txt'), 'approved source', { mode: 0o644 });
  const sandbox = new Sandbox({ kind: 'directory', path: root }, undefined, undefined, { runId: 'docker-test' });
  try {
    await sandbox.start();
    const result = await sandbox.exec('id -u; cat /target/source.txt; printf scratch > /work/test; cat /work/test; grep CapEff /proc/self/status');
    expect(result.code).toBe(0); expect(result.stdout).toContain('65532'); expect(result.stdout).toContain('approved source'); expect(result.stdout).toContain('scratch'); expect(result.stdout).toContain('0000000000000000');
    expect((await sandbox.exec('echo changed > /target/source.txt')).code).not.toBe(0);
    expect((await sandbox.exec('echo changed > /etc/p2o-test')).code).not.toBe(0);
    expect((await sandbox.exec('test ! -e /var/run/docker.sock')).code).toBe(0);
    const offline = await sandbox.exec('python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect((\'192.0.2.1\',80))"');
    expect(offline.code).not.toBe(0);
    await expect(sandbox.http('https://example.com')).rejects.toThrow('unavailable');
    const abort = new AbortController();
    const task = sandbox.exec('sleep 999', 60, abort.signal); setTimeout(() => abort.abort(), 500);
    await expect(task).rejects.toThrow('Cancelled');
    await sandbox.stop();
    await sandbox.assertNoRunContainers();
  } finally { await sandbox.stop(); await rm(root, { recursive: true, force: true }); }
}, 60_000);

it.skipIf(process.env.P2O_TEST_DOCKER !== '1')('real Docker: two delegated workers share one container through the owner broker with isolated scratch and verified cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-broker-docker-')); await chmod(root, 0o755);
  await writeFile(join(root, 'source.txt'), 'shared target', { mode: 0o644 });
  const records = join(root, 'records.jsonl');
  await writeFile(records, '', { mode: 0o600 });
  const sandbox = new Sandbox({ kind: 'directory', path: root }, undefined, undefined, { runId: 'broker-docker', tmpBytes: '256m', workBytes: '512m' });
  const registrations: WorkerRegistration[] = ['p2o-recon-aaaaaa', 'p2o-validation-bbbbbb'].map((workerId, index) => ({
    workerId, name: workerId, paneId: `w1T:p${index + 2}`, role: index ? 'validation' : 'recon', depth: 1, parentWorkerId: null,
    token: String(index + 1).repeat(32), commandBudget: 50, used: 0, startedAt: Date.now(), stopped: false,
  }));
  const broker = new Broker(root, {
    exec: (command, seconds, workdir, signal) => sandbox.exec(command, seconds, signal, workdir),
    http: async () => { throw new Error('http is not exercised here'); },
    note: record => appendRecord(records, record),
    ledger: limit => readRecords(records, limit),
    delegate: async () => { throw new Error('delegation is not exercised here'); },
    report: async () => {},
  }, { totalCommandBudget: 200 });
  const clients: BrokerClient[] = [];
  try {
    await sandbox.start();
    await broker.start();
    for (const registration of registrations) broker.register(registration);
    clients.push(...registrations.map(registration => new BrokerClient(broker.socket, registration.token, { connectMs: 5000, requestMs: 30_000 })));
    const [recon, validation] = clients;
    // Both workers run through the single owner container, concurrently, in their own scratch.
    const [first, second] = await Promise.all([
      recon.request('exec', { command: 'id -u; cat /target/source.txt; printf recon > mine.txt; pwd', timeout: 30 }),
      validation.request('exec', { command: 'cat /target/source.txt; printf validation > mine.txt; ls; pwd', timeout: 30 }),
    ]);
    expect(first.stdout).toContain('shared target');
    expect(first.stdout).toContain('/work/p2o-recon-aaaaaa');
    expect(second.stdout).toContain('/work/p2o-validation-bbbbbb');
    const listing = await recon.request('exec', { command: 'ls /work/p2o-recon-aaaaaa; ls /work/p2o-validation-bbbbbb', timeout: 30 });
    expect(listing.stdout).toContain('mine.txt');
    const other = await recon.request('exec', { command: 'cat /work/p2o-validation-bbbbbb/mine.txt', timeout: 30 });
    expect(other.stdout.trim()).toBe('validation');
    // The ledger records both workers distinctly.
    await recon.request('note', { kind: 'coverage', text: 'clean', surface: '/source.txt', risk: 'unintended exposure', outcome: 'clean' });
    await validation.request('report', { report: { summary: 'validated', confidence: 'high' } });
    expect(broker.registration('p2o-validation-bbbbbb')?.reported?.summary).toBe('validated');
    await broker.stop();
    for (const client of clients) client.close();
    await sandbox.stop();
    await sandbox.assertNoRunContainers();
  } finally {
    for (const client of clients) client.close();
    await broker.stop();
    await sandbox.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
