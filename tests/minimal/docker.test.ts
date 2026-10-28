import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '../../src/sandbox.js';
import { Broker, BrokerClient, type WorkerRegistration } from '../../src/broker.js';
import { appendRecord, readRecords } from '../../src/records.js';

/**
 * Runtime truth (A17.9, measured 2026-10-27): the pinned container is uid 0 on a writable rootfs with Docker's
 * default 14-capability set, `/target` is a read-only bind mount, and the Docker socket is never mounted.
 */
it.skipIf(process.env.P2O_TEST_DOCKER !== '1')('real Docker: read-only source, root shell with the Docker default capability set, network egress, scratch, cancellation and verified cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-minimal-docker-')); await chmod(root, 0o755);
  await writeFile(join(root, 'source.txt'), 'approved source', { mode: 0o644 });
  const sandbox = new Sandbox({ kind: 'directory', path: root }, undefined, undefined, { runId: 'docker-test' });
  try {
    await sandbox.start();
    const result = await sandbox.exec('id -u; cat /target/source.txt; printf scratch > /work/test; cat /work/test; grep CapEff /proc/self/status');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^0$/m);
    expect(result.stdout).toContain('approved source');
    expect(result.stdout).toContain('scratch');
    const capEff = BigInt(`0x${/CapEff:\s*([0-9a-f]+)/i.exec(result.stdout)![1]}`);
    expect([...capEff.toString(2)].filter(bit => bit === '1')).toHaveLength(14);
    expect(capEff & (1n << 13n)).not.toBe(0n); // NET_RAW is in the default set, so raw sockets work.
    expect(capEff & (1n << 21n)).toBe(0n); // CAP_SYS_ADMIN is not part of Docker's default set.
    expect((await sandbox.exec('echo changed > /target/source.txt')).code).not.toBe(0);
    // The root filesystem is writable (the container is removed below, so the marker never survives the test).
    expect((await sandbox.exec('echo changed > /etc/p2o-test')).code).toBe(0);
    expect((await sandbox.exec('test ! -e /var/run/docker.sock')).code).toBe(0);
    // Egress is real: a host-published service is reachable through the container alias, and an
    // unroutable documentation address still fails instead of being mistaken for success.
    const server = createServer((_request, response) => { response.writeHead(200); response.end('host service'); });
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const reached = await sandbox.exec(`curl -sS -m 5 http://host.docker.internal:${port}/`);
      expect(reached.code).toBe(0); expect(reached.stdout).toContain('host service');
      // Part XI: the fixed-curl HTTP transport is not origin-scoped, so the same host-published service is reachable.
      const http = await sandbox.http({ url: `http://host.docker.internal:${port}/`, method: 'GET', followRedirects: false, maxRedirects: 0 });
      expect(http.code).toBe(0); expect(http.stdout).toContain('host service');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    const unroutable = await sandbox.exec('python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect((\'192.0.2.1\',80))"');
    expect(unroutable.code).not.toBe(0);
    const abort = new AbortController();
    const task = sandbox.exec('sleep 999', 0, abort.signal); setTimeout(() => abort.abort(), 500);
    await expect(task).rejects.toThrow('Cancelled');
    await sandbox.stop();
    await sandbox.assertNoRunContainers();
  } finally { await sandbox.stop(); await rm(root, { recursive: true, force: true }); }
}, 60_000);

it.skipIf(process.env.P2O_TEST_DOCKER !== '1')('real Docker: full HTTP against the approved origin, including a body, a redirect hop and a session cookie', async () => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://host.docker.internal').pathname;
    if (path === '/start') { response.writeHead(302, { Location: '/next' }); response.end(); return; }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (path === '/login') response.writeHead(200, { 'Set-Cookie': 'sid=abc123; Path=/' });
      else response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(`ok ${request.method} ${path} cookie=${request.headers.cookie ?? 'none'} body=${body}`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://host.docker.internal:${port}`;
  const sandbox = new Sandbox({ kind: 'url', url: `${origin}/`, origin }, undefined, undefined, { runId: 'docker-http-test' });
  try {
    await sandbox.start();
    const login = await sandbox.http({ url: '/login', method: 'POST', body: 'u=a&p=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, followRedirects: true, maxRedirects: 3 });
    expect(login.code).toBe(0);
    expect(login.stdout).toContain('ok POST /login');
    expect(login.stdout).toContain('body=u=a&p=b');
    const followed = await sandbox.http({ url: '/start', method: 'GET', followRedirects: true, maxRedirects: 3 });
    expect(followed.hops).toHaveLength(2);
    expect(followed.stdout).toContain('ok GET /next');
    const reused = await sandbox.http({ url: '/after', method: 'GET', followRedirects: false, maxRedirects: 0 });
    expect(reused.stdout).toContain('cookie=sid=abc123');
    // Part XI: loopback is container-local, so the host's server is not there; the request is attempted, not refused.
    const loopback = await sandbox.http({ url: `http://127.0.0.1:${port}/`, method: 'GET', followRedirects: false, maxRedirects: 0 });
    expect(loopback.code).not.toBe(0);
    expect(loopback.hops?.[0]).toContain('loopback');
    await sandbox.stop();
    await sandbox.assertNoRunContainers();
  } finally { await sandbox.stop(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 90_000);

it.skipIf(process.env.P2O_TEST_DOCKER !== '1')('real Docker: unlimited shell passes the old 30/60s clocks, HTTP passes 20s, and explicit timeout remains opt-in', async () => {
  const server=createServer((request,response)=>{
    if(request.url==='/slow'){
      const timer=setTimeout(()=>{response.writeHead(200);response.end('delayed local response');},22000);
      response.once('close',()=>clearTimeout(timer));
    }else{response.writeHead(200);response.end('ready');}
  });
  await new Promise<void>(resolve=>server.listen(0,'0.0.0.0',resolve));
  const origin=`http://host.docker.internal:${(server.address() as {port:number}).port}`;
  const sandbox=new Sandbox({kind:'url',url:origin+'/',origin},undefined,undefined,{runId:'docker-unlimited-test'});
  try{
    await sandbox.start();
    const before=Date.now();
    const long=await sandbox.exec('sleep 65; printf long-local-command');
    expect(Date.now()-before).toBeGreaterThanOrEqual(64000);expect(long.code).toBe(0);expect(long.stdout).toContain('long-local-command');
    const slow=await sandbox.http({url:'/slow',method:'GET',followRedirects:false,maxRedirects:0});
    expect(slow.code).toBe(0);expect(slow.stdout).toContain('delayed local response');
    const opted=await sandbox.http({url:'/slow',method:'GET',followRedirects:false,maxRedirects:0,timeout:1});
    expect(opted.code).toBe(28);expect(opted.redirectStopped).toContain('no automatic retry');
    expect((await sandbox.exec('printf still-active')).stdout).toContain('still-active');
    await sandbox.stop();await sandbox.assertNoRunContainers();
  }finally{await sandbox.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},130000);

it.skipIf(process.env.P2O_TEST_DOCKER !== '1')('real Docker: two delegated workers share one container through the owner broker with isolated scratch and verified cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-broker-docker-')); await chmod(root, 0o755);
  await writeFile(join(root, 'source.txt'), 'shared target', { mode: 0o644 });
  const records = join(root, 'records.jsonl');
  await writeFile(records, '', { mode: 0o600 });
  const sandbox = new Sandbox({ kind: 'directory', path: root }, undefined, undefined, { runId: 'broker-docker', tmpBytes: '256m', workBytes: '512m' });
  const registrations: WorkerRegistration[] = ['p2o-recon-aaaaaa', 'p2o-validation-bbbbbb'].map((workerId, index) => ({
    workerId, name: workerId, paneId: `w1T:p${index + 2}`, role: index ? 'validation' : 'recon', depth: 1, parentWorkerId: null,
    token: String(index + 1).repeat(32), used: 0, startedAt: Date.now(), stopped: false,
  }));
  const broker = new Broker(root, {
    exec: (command, seconds, workdir, signal) => sandbox.exec(command, seconds, signal, workdir),
    http: async () => { throw new Error('http is not exercised here'); },
    note: record => appendRecord(records, record),
    ledger: limit => readRecords(records, limit),
    delegate: async () => { throw new Error('delegation is not exercised here'); },
    report: async () => {},
  }, {});
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
