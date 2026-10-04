import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { startDashboard, type DashboardHandle } from '../../src/interface/dashboard.js';
import { viewerScript } from '../../src/interface/viewer.js';
import { FakeBackend } from './helpers.js';

async function dashboard(t: TestContext) {
  const backend = new FakeBackend();
  const handle = await startDashboard({ backend, runId: 'run-1', enabled: true, pollMs: 100 });
  t.after(() => handle.close());
  const token = new URLSearchParams(new URL(handle.accessUrl).hash.slice(1)).get('token')!;
  const headers = { Authorization: `Bearer ${token}` };
  return { backend, handle, token, headers };
}
function http(handle: DashboardHandle, path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(handle.url + path, { headers, method }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}

test('loopback bind, per-instance random token and static shell contain no run data or token', async t => {
  const a = await dashboard(t), b = await dashboard(t);
  assert.match(a.handle.url, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  assert.notEqual(a.token, b.token);
  assert.equal(a.token.length, 43);
  const shell = await http(a.handle, '/');
  assert.equal(shell.status, 200);
  assert.ok(!shell.body.includes(a.token) && !shell.body.includes('run-1') && !shell.body.includes('DO_NOT_EXPOSE'));
  assert.match(shell.body, /Process exit ≠ packet acceptance ≠ finding verification/);
  assert.match(String(shell.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.ok(!String(shell.headers['content-security-policy']).includes('unsafe-'));
  assert.equal(shell.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(shell.headers['referrer-policy'], 'no-referrer');
  assert.equal(shell.headers['x-content-type-options'], 'nosniff');
  assert.equal(shell.headers['access-control-allow-origin'], undefined);
});

test('all data routes require Authorization bearer token; no URL/cookie token fallback', async t => {
  const s = await dashboard(t);
  for (const route of ['/api/status', '/api/tasks', '/api/evidence', '/api/report', '/api/events', '/api/stream']) {
    assert.equal((await http(s.handle, route)).status, 401);
    assert.equal((await http(s.handle, route, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await http(s.handle, route + '?token=' + s.token, { Cookie: `token=${s.token}` })).status, 401);
  }
  assert.equal((await http(s.handle, '/api/status?token=' + s.token, s.headers)).status, 400);
  assert.equal((await http(s.handle, '/api/status', s.headers)).status, 200);
});

test('DNS rebinding/Host, foreign origin, proxy and cross-site requests are denied before private reads', async t => {
  const s = await dashboard(t);
  const before = s.backend.calls.length;
  const attacks: Record<string, string>[] = [
    { Host: 'evil.invalid' }, { Origin: 'https://evil.invalid' }, { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Forwarded: 'host=evil.invalid' }, { 'X-Forwarded-For': '127.0.0.1' },
  ];
  for (const headers of attacks) assert.equal((await http(s.handle, '/api/status', { ...s.headers, ...headers })).status, 403);
  assert.equal(s.backend.calls.length, before);
  assert.equal((await http(s.handle, '/api/status', { ...s.headers, Origin: s.handle.url, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
});

test('GET-only API has no mutation/action/path traversal/raw artifact routes', async t => {
  const s = await dashboard(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const response = await http(s.handle, '/api/status', s.headers, method);
    assert.equal(response.status, 405); assert.equal(response.headers.allow, 'GET');
  }
  for (const path of ['/api/start', '/api/stop', '/api/resume', '/private/auth.json', '/api/evidence/file']) {
    assert.equal((await http(s.handle, path, s.headers)).status, 404);
  }
  for (const query of ['limit=101', 'limit=0', 'offset=-1', 'offset=1e2', 'limit=1&limit=2', 'runId=other', 'token=bad']) {
    assert.equal((await http(s.handle, '/api/tasks?' + query, s.headers)).status, 400);
  }
  assert.equal((await http(s.handle, '/api/stream?afterSequence=NaN', s.headers)).status, 400);
  assert.equal((await http(s.handle, '/api/evidence?evidenceId=../../auth.json', s.headers)).status, 400);
  assert.equal((await http(s.handle, '/api/report?format=html', s.headers)).status, 400);
  assert.ok(!s.backend.calls.some(c => c === 'start' || c.startsWith('stop') || c === 'resume'));
});

test('status preserves separate process/packet/finding, gaps/failures and requested vs observed receipts', async t => {
  const s = await dashboard(t);
  const response = await http(s.handle, '/api/status', s.headers);
  const data = JSON.parse(response.body);
  assert.equal(data.mode, 'fixture');
  assert.equal(data.process.tasks[0].lifecycleState, 'exited');
  assert.equal(data.process.tasks[0].packetState, 'returned-for-evidence');
  assert.equal(data.packets[0].decision.status, 'returned-for-evidence');
  assert.equal(data.findings[0].state, 'unresolved');
  assert.equal(data.coverage[0].state, 'untested');
  assert.equal(data.failures[0].code, 'WORKER_FAILED');
  assert.equal(data.process.attempts[0].requestedRuntime.selection.provider, 'requested-provider');
  assert.equal(data.process.attempts[0].observedRuntime.selection.provider, 'observed-provider');
  assert.equal(data.process.attempts[0].observedRuntime.attestation, 'reported');
  assert.ok(!response.body.includes('DO_NOT_EXPOSE') && !response.body.includes('/private/'));
  s.backend.snapshotValue.attempts.push({ attemptId: 'no-receipt' });
  const unavailable = JSON.parse((await http(s.handle, '/api/status', s.headers)).body).process.attempts.at(-1);
  assert.equal(unavailable.observedRuntime.attestation, 'unavailable');
  for (const path of ['/api/evidence?limit=1', '/api/report?format=markdown', '/api/events']) {
    const result = await http(s.handle, path, s.headers);
    assert.equal(result.status, 200);
    assert.ok(!result.body.includes('DO_NOT_EXPOSE') && !result.body.includes('/private/'));
    assert.match(String(result.headers['content-type']), /application\/json/);
  }
});

test('SSE uses authenticated fetch-compatible bounded receipt frames and durable cursors; closure stops polling', async t => {
  const s = await dashboard(t);
  const abort = new AbortController();
  const stream = await fetch(s.handle.url + '/api/stream?afterSequence=0', { headers: s.headers, signal: abort.signal });
  assert.equal(stream.status, 200); assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
  const reader = stream.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /id: 1/); assert.match(first, /event: receipts/);
  assert.ok(!first.includes('DO_NOT_EXPOSE'));
  s.backend.eventValues.push({ sequence: 2, eventId: 'e-2', occurredAt: 'now', type: 'packet.returned' });
  const second = new TextDecoder().decode((await reader.read()).value);
  assert.match(second, /id: 2/); assert.match(second, /packet.returned/);
  abort.abort(); await reader.cancel().catch(() => {});
  await sleep(150);
  const calls = s.backend.calls.filter(c => c === 'events').length;
  await sleep(150);
  assert.equal(s.backend.calls.filter(c => c === 'events').length, calls);
  await s.handle.close(); await s.handle.close();
  await assert.rejects(http(s.handle, '/api/status', s.headers));
});

test('SSE clients are capped and cleanup closes active streams', async t => {
  const s = await dashboard(t), clients: AbortController[] = [];
  t.after(() => { for (const c of clients) c.abort(); });
  for (let i = 0; i < 8; i++) {
    const abort = new AbortController(); clients.push(abort);
    const stream = await fetch(s.handle.url + '/api/stream', { headers: s.headers, signal: abort.signal });
    assert.equal(stream.status, 200);
  }
  assert.equal((await http(s.handle, '/api/stream', s.headers)).status, 429);
  await s.handle.close();
  const calls = s.backend.calls.length; await sleep(150);
  assert.equal(s.backend.calls.length, calls);
});

test('failed event reads close SSE without leaking errors or claiming success', async t => {
  const s = await dashboard(t);
  s.backend.events = async () => { throw new Error('password=DO_NOT_EXPOSE'); };
  const stream = await fetch(s.handle.url + '/api/stream', { headers: s.headers });
  const text = await stream.text();
  assert.match(text, /EVENT_READ_FAILED/); assert.ok(!text.includes('DO_NOT_EXPOSE'));
});

test('large snapshots are bounded and marked truncated; dashboard start never falls back on missing runs', async t => {
  const s = await dashboard(t);
  s.backend.snapshotValue.findings = Array.from({ length: 200 }, (_, i) => ({ findingId: `f-${i}`, claim: 'X'.repeat(5000), state: 'unresolved' }));
  const response = await http(s.handle, '/api/status', s.headers);
  assert.ok(Buffer.byteLength(response.body) <= 48 * 1024);
  assert.equal(JSON.parse(response.body).truncated, true);
  await assert.rejects(startDashboard({ backend: s.backend, runId: 'absent', enabled: true }), /NOT_FOUND/);
  await assert.rejects(startDashboard({ backend: s.backend, runId: 'run-1', enabled: false } as never), /OPT_IN_REQUIRED/);
});

test('viewer renders untrusted status/report/events only as text and caps log count/bytes; pagehide cleans up', async () => {
  const nodes = new Map<string, { textContent: string }>();
  const listeners = new Map<string, () => void>();
  const fetches: Array<{ path: string; init: RequestInit }> = [];
  const backend = new FakeBackend();
  const sections = ['run', 'process', 'packets', 'findings', 'coverage', 'failures', 'evidence', 'report', 'events', 'connection'];
  for (const id of sections) {
    const node = { textContent: '' };
    Object.defineProperty(node, 'innerHTML', { set() { throw new Error('unsafe HTML sink used'); } });
    nodes.set(id, node);
  }
  const frames = Array.from({ length: 10 }, (_, p) => new TextEncoder().encode(`data: ${JSON.stringify({
    items: Array.from({ length: 50 }, (_, i) => ({ sequence: p * 50 + i + 1, type: 'log', occurredAt: 'now', display: { kind: 'log', text: '<img onerror=alert(1)> ' + 'x'.repeat(600) } })),
    nextSequence: p * 50 + 50, gap: p === 0,
  })}\n\n`));
  let cancelled = false, cleared = false, historyPath = '';
  const controllerSignals: AbortSignal[] = [];
  const fetchFixture = async (path: string, init: RequestInit) => {
    fetches.push({ path, init }); controllerSignals.push(init.signal!);
    if (path.startsWith('/api/stream')) return { ok: true, body: { getReader() { return { async read() {
      const value = frames.shift(); return value ? { value, done: false } : { done: true };
    }, async cancel() { cancelled = true; } }; } } };
    const s = backend.snapshotValue;
    const data = path === '/api/status' ? { mode: 'fixture', run: s.run, process: { tasks: s.tasks }, packets: s.packets, findings: s.findings, coverage: s.coverage, failures: s.failures }
      : path.startsWith('/api/evidence') ? { items: [{ summary: '<svg onload=alert(1)>' }] } : { content: '<script>alert(1)</script>' };
    return { ok: true, async json() { return data; } };
  };
  runInNewContext(viewerScript, {
    document: { getElementById(id: string) { return nodes.get(id); } },
    location: { hash: '#token=PRIVATE_TOKEN', pathname: '/' }, history: { replaceState(_a: unknown, _b: unknown, path: string) { historyPath = path; } },
    URLSearchParams, AbortController, TextDecoder, fetch: fetchFixture,
    setInterval() { return 1; }, clearInterval() { cleared = true; },
    addEventListener(name: string, listener: () => void) { listeners.set(name, listener); },
  });
  for (let i = 0; i < 10; i++) await nextTurn();
  assert.match(nodes.get('findings')!.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(nodes.get('report')!.textContent, /<script>/);
  assert.match(nodes.get('events')!.textContent, /<img onerror/);
  assert.ok(nodes.get('events')!.textContent.length <= 65536);
  assert.ok(nodes.get('events')!.textContent.split('\n').length <= 200);
  assert.ok(fetches.every(f => !f.path.includes('PRIVATE_TOKEN') && (f.init.headers as Record<string, string>).Authorization === 'Bearer PRIVATE_TOKEN'));
  assert.equal(historyPath, '/'); assert.equal(cancelled, true);
  listeners.get('pagehide')!(); assert.equal(cleared, true);
  assert.ok(controllerSignals.every(s => s.aborted));
  assert.ok(!viewerScript.includes('innerHTML') && !viewerScript.includes('EventSource') && !viewerScript.includes('eval('));
});
