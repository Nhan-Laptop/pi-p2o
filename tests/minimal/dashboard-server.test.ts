import { describe, expect, it, vi } from 'vitest';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  DASHBOARD_ARTIFACT_CHUNK_BYTES, DASHBOARD_CSP, serveDashboard, type DashboardServer,
} from '../../src/dashboard/server.js';
import { buildDashboard } from '../../src/dashboard/read-model.js';
import { writeDashboardSnapshot } from '../../src/dashboard/snapshot.js';
import { clientFixture, tempRoot } from './helpers/dashboard-client.js';
import { fixture, populate } from './helpers/report-fixture.js';
import { InertSandbox } from './helpers/fake-pi.js';

/**
 * planning_update.md P3 (§6.2–6.3): the two-mode server. Frozen mode serves exactly one snapshot directory; live mode builds
 * the same data tree from read-only stores and shares one cached build for `refreshMs`. Both bind loopback, answer GET/HEAD
 * only, keep static client bytes public, require the per-launch bearer token on every data/API route, refuse path escapes and
 * symlinks, and never write a request line, a token or a query value anywhere a log or a body could carry it.
 */
interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

const request = (base: string, path: string, options: { method?: string; token?: string } = {}): Promise<Reply> =>
  new Promise((resolveReply, rejectReply) => {
    const url = new URL(base);
    const headers: Record<string, string> = { connection: 'close' };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    const call = httpRequest({ host: url.hostname, port: url.port, path, method: options.method ?? 'GET', headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolveReply({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    call.on('error', rejectReply);
    call.end();
  });

const delay = (ms: number): Promise<void> => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const citedIdsOf = (runFile: { findings: Array<{ reproduction: Array<{ captures: Array<{ id: string }> }> }>; cases: Array<{ reproduction: Array<{ captures: Array<{ id: string }> }> }> }): string[] =>
  [...new Set([...runFile.findings, ...runFile.cases].flatMap(row => row.reproduction.flatMap(step => step.captures.map(capture => capture.id))))];

/** The inert sandbox echoes the command; a 20 KiB echo makes the cited capture larger than one served chunk. */
async function withLongCapture<T>(work: () => Promise<T>): Promise<T> {
  const original = InertSandbox.prototype.exec;
  InertSandbox.prototype.exec = async (_command: string, _seconds = 0, _signal?: AbortSignal, _workdir = '/work',
    onRunning?: () => void, onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void) => {
    const stdout = `${'A'.repeat(20_000)}\n`;
    onRunning?.();
    onOutput?.('stdout', Buffer.from(stdout));
    return { code: 0, stdout, stderr: '', truncated: false };
  };
  try { return await work(); } finally { InertSandbox.prototype.exec = original; }
}

describe('dashboard server: frozen mode', () => {
  it('serves the snapshot on loopback, keeps the token in the fragment, gates data, serves cited artifacts and refuses escapes', async () => {
    await fixture(async h => {
      let server: DashboardServer | null = null;
      try {
        const populated = await withLongCapture(() => populate(h));
        // A rate is what makes a case cite reproduction receipts; without it the run has cases but no retained evidence refs.
        await h.call('p2o_case_rate', { id: populated.accepted.id, revision: populated.accepted.revision,
          entry: { severity: 'medium', basis: 'Owner-rated from the bounded inert receipt cited by this fixture',
            reproductionEvidenceRefs: [populated.observation.evidenceId] } });
        // A second receipt captures an artifact no served case cites; /api/artifact must not open it.
        const uncited = await h.call('p2o_shell', { command: 'printf uncited-artifact' });
        const uncitedId = uncited.details.capture.artifacts[0].id;
        const runId = await h.runId();

        const build = await buildDashboard({ stateRoots: [{ path: join(h.root, '.p2o-state') }], artifacts: true });
        const runFile = build.runs[0]!;
        const cited = citedIdsOf(runFile);
        expect(cited.length).toBeGreaterThan(0);
        const citedId = cited[0]!;
        const ref = runFile.artifacts.find(item => item.artifactId === citedId)!;
        expect(ref.bytes).toBeGreaterThan(DASHBOARD_ARTIFACT_CHUNK_BYTES);

        const client = await clientFixture(h.root);
        const directory = join(h.root, 'snapshot');
        await writeDashboardSnapshot(directory, build, { clientRoot: client });
        // A snapshot can be handed to other people; an added symlink must never become a served file.
        await symlink('/etc/hostname', join(directory, 'escape.txt'));
        server = await serveDashboard({ mode: 'snapshot', directory, port: 0 });

        expect(server.mode).toBe('snapshot');
        expect(server.host).toBe('127.0.0.1');
        expect(server.port).toBeGreaterThan(0);
        expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(server.url).toBe(`http://127.0.0.1:${server.port}/#token=${server.token}`);
        expect(server.url).not.toContain('?');

        // Static client bytes stay public: the page must load before the client can read the token fragment.
        const home = await request(server.url, '/');
        expect(home.status).toBe(200);
        expect(home.body).toContain('overview fixture');
        const asset = await request(server.url, '/_next/static/chunks/main.js');
        expect(asset.status).toBe(200);
        expect(asset.headers['content-type']).toContain('text/javascript');
        expect(asset.headers['cache-control']).toContain('immutable');
        expect((await request(server.url, '/graph')).status).toBe(308);
        expect((await request(server.url, '/graph')).headers.location).toBe('/graph/');

        // Every data route requires the bearer token; a token in the query string is not accepted.
        const missing = await request(server.url, '/index.json');
        expect(missing.status).toBe(401);
        expect(missing.headers['www-authenticate']).toContain('Bearer');
        expect(missing.body).not.toContain(server.token);
        const wrong = await request(server.url, '/index.json', { token: 'not-the-token' });
        expect(wrong.status).toBe(401);
        expect(missing.headers['content-type']).toContain('text/plain');
        expect((await request(server.url, `/runs/${runId}.json`)).status).toBe(401);
        const queried = await request(server.url, `/index.json?token=${encodeURIComponent(server.token)}`);
        expect(queried.status).toBe(401);
        expect(queried.body).not.toContain(server.token);

        // A percent-encoded spelling of a data path is the same gated route, never a public static file.
        expect((await request(server.url, '/%69ndex.json')).status).toBe(401);
        expect((await request(server.url, '/%69ndex.json', { token: server.token })).status).toBe(200);

        const index = await request(server.url, '/index.json', { token: server.token });
        expect(index.status).toBe(200);
        expect(index.headers['content-type']).toContain('application/json');
        expect(JSON.parse(index.body)).toMatchObject({ format: 'p2o-dashboard', version: 1 });
        expect(index.body).not.toContain(server.token);
        expect(index.headers['content-security-policy']).toBe(DASHBOARD_CSP);
        expect(index.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        expect(index.headers['x-content-type-options']).toBe('nosniff');
        expect(index.headers['referrer-policy']).toBe('no-referrer');
        expect(index.headers['cross-origin-opener-policy']).toBe('same-origin');
        expect(index.headers['cache-control']).toBe('no-store');
        expect(index.headers['access-control-allow-origin']).toBeUndefined();

        const run = await request(server.url, `/runs/${runId}.json`, { token: server.token });
        expect(run.status).toBe(200);
        expect(JSON.parse(run.body)).toMatchObject({ format: 'p2o-dashboard-run', version: 1, runId });
        const caseId = runFile.cases[0]!.id;
        const caseFile = await request(server.url, `/runs/${runId}/cases/${caseId}.json`, { token: server.token });
        expect(caseFile.status).toBe(200);
        expect(JSON.parse(caseFile.body)).toMatchObject({ format: 'p2o-dashboard-case', version: 1, runId });
        expect(JSON.parse(caseFile.body).case.id).toBe(caseId);
        expect((await request(server.url, `/runs/${runId}/cases/case-unknown.json`, { token: server.token })).status).toBe(404);

        // HEAD carries GET's headers without a body; every other method is refused before authentication.
        const head = await request(server.url, '/index.json', { method: 'HEAD', token: server.token });
        expect(head.status).toBe(200);
        expect(head.body).toBe('');
        expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(index.body));
        const posted = await request(server.url, '/index.json', { method: 'POST', token: server.token });
        expect(posted.status).toBe(405);
        expect(posted.headers.allow).toBe('GET, HEAD');

        // Closed path map: dot segments, encoded separators, backslashes, control bytes and direct artifact copies are 404.
        for (const path of [
          '/%2e%2e/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/runs/%2e%2e.json', '/..\\..\\package.json', '/%00',
          '/artifacts/' + runId + '/' + citedId + '.txt', '/escape.txt', '/runs/../index.json', '/./index.json',
        ]) expect((await request(server.url, path, { token: server.token })).status, path).toBe(404);

        // The cited copy is served in bounded chunks with the ref's metadata; an uncited id never opens a body.
        const artifactPath = `/api/artifact?run=${runId}&id=${citedId}&offset=0`;
        expect((await request(server.url, artifactPath)).status).toBe(401);
        expect((await request(server.url, artifactPath, { token: 'not-the-token' })).status).toBe(401);
        const first = await request(server.url, artifactPath, { token: server.token });
        expect(first.status).toBe(200);
        const body = JSON.parse(first.body);
        expect(body).toMatchObject({ format: 'p2o-dashboard-artifact', version: 1, runId, artifactId: citedId, offset: 0,
          bytes: DASHBOARD_ARTIFACT_CHUNK_BYTES, totalBytes: ref.bytes, sha256: ref.sha256, truncated: ref.truncated });
        expect(body.nextOffset).toBe(DASHBOARD_ARTIFACT_CHUNK_BYTES);
        expect(Buffer.byteLength(body.text)).toBe(DASHBOARD_ARTIFACT_CHUNK_BYTES);
        expect(first.body).not.toContain(server.token);
        const second = await request(server.url, `/api/artifact?run=${runId}&id=${citedId}&offset=${body.nextOffset}`, { token: server.token });
        expect(second.status).toBe(200);
        const tail = JSON.parse(second.body);
        expect(tail.offset).toBe(DASHBOARD_ARTIFACT_CHUNK_BYTES);
        expect(tail.bytes).toBe(ref.bytes - DASHBOARD_ARTIFACT_CHUNK_BYTES);
        expect(tail.nextOffset).toBeUndefined();

        expect((await request(server.url, `/api/artifact?run=${runId}&id=${uncitedId}&offset=0`, { token: server.token })).status).toBe(404);
        expect((await request(server.url, `/api/artifact?run=${runId}&id=${citedId}&offset=${ref.bytes + 1}`, { token: server.token })).status).toBe(416);
        for (const query of [
          `run=${runId}&id=${citedId}&offset=abc`, `run=${runId}&id=${citedId}&offset=-1`,
          `run=${runId}&id=${citedId}&offset=0&length=0`, `run=${runId}&id=${citedId}&offset=0&length=99999`,
        ]) expect((await request(server.url, `/api/artifact?${query}`, { token: server.token })).status, query).toBe(400);
      } finally {
        if (server) await server.close();
      }
    });
  }, 120_000);

  it('never logs a request or the token', async () => {
    const root = await tempRoot();
    let server: DashboardServer | null = null;
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error')];
    try {
      const client = await clientFixture(root);
      const directory = join(root, 'snapshot');
      const build = await buildDashboard({ stateRoots: [{ path: join(root, 'missing'), optional: true }] });
      await writeDashboardSnapshot(directory, build, { clientRoot: client });
      server = await serveDashboard({ mode: 'snapshot', directory, port: 0 });
      await request(server.url, '/');
      await request(server.url, '/index.json');
      await request(server.url, '/index.json', { token: 'wrong-token' });
      await request(server.url, '/index.json', { token: server.token });
      await request(server.url, '/runs/unknown-run.json', { token: server.token });
      await request(server.url, '/api/artifact?run=run-a&id=artifact-a&offset=0', { token: server.token });
      expect(spies[0]).not.toHaveBeenCalled();
      expect(spies[1]).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
      if (server) await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('dashboard server: live mode', () => {
  it('builds from a real fixture store, serves case/artifact routes and refreshes its cached index after the interval', async () => {
    await fixture(async h => {
      const populated = await populate(h);
      await h.call('p2o_case_rate', { id: populated.accepted.id, revision: populated.accepted.revision,
        entry: { severity: 'medium', basis: 'Owner-rated from the bounded inert receipt cited by this fixture',
          reproductionEvidenceRefs: [populated.observation.evidenceId] } });
      const runId = await h.runId(), token = 'live-token-for-tests';
      const server = await serveDashboard({
        mode: 'live', stateRoots: [{ path: join(h.root, '.p2o-state') }],
        reportRoots: [{ path: join(h.root, '.p2o-reports'), optional: true }], port: 0, token, refreshMs: 50,
      });
      try {
        expect(server.mode).toBe('live');
        expect(server.url).toBe(`http://127.0.0.1:${server.port}/#token=${token}`);
        expect((await request(server.url, '/index.json')).status).toBe(401);

        const first = await request(server.url, '/index.json', { token });
        expect(first.status).toBe(200);
        const index = JSON.parse(first.body);
        expect(index).toMatchObject({ format: 'p2o-dashboard', version: 1 });
        expect(index.runs).toHaveLength(1);
        expect(index.runs[0]).toMatchObject({ runId, source: 'store', live: true });
        expect(index.runs[0].busy).toBeUndefined();
        const sequence = index.runs[0].sequence as number;
        expect(sequence).toBeGreaterThan(0);

        const runReply = await request(server.url, `/runs/${runId}.json`, { token });
        expect(runReply.status).toBe(200);
        const runFile = JSON.parse(runReply.body);
        expect(runFile).toMatchObject({ format: 'p2o-dashboard-run', version: 1, runId });

        const caseId = runFile.cases[0].id as string;
        const caseReply = await request(server.url, `/runs/${runId}/cases/${caseId}.json`, { token });
        expect(caseReply.status).toBe(200);
        expect(JSON.parse(caseReply.body)).toMatchObject({ format: 'p2o-dashboard-case', version: 1, runId });
        expect((await request(server.url, `/runs/${runId}/cases/case-unknown.json`, { token })).status).toBe(404);
        expect((await request(server.url, '/runs/unknown-run.json', { token })).status).toBe(404);

        const cited = citedIdsOf(runFile);
        expect(cited.length).toBeGreaterThan(0);
        const artifactReply = await request(server.url, `/api/artifact?run=${runId}&id=${cited[0]}&offset=0`, { token });
        expect(artifactReply.status).toBe(200);
        const artifact = JSON.parse(artifactReply.body);
        expect(artifact).toMatchObject({ format: 'p2o-dashboard-artifact', version: 1, runId, artifactId: cited[0], offset: 0 });
        expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(artifact.totalBytes).toBeGreaterThan(0);
        expect(Buffer.byteLength(artifact.text)).toBe(artifact.bytes);
        const uncitedId = 'artifact-00000000-0000-0000-0000-000000000000';
        expect((await request(server.url, `/api/artifact?run=${runId}&id=${uncitedId}&offset=0`, { token })).status).toBe(404);
        expect((await request(server.url, `/api/artifact?run=${runId}&id=${cited[0]}&offset=abc`, { token })).status).toBe(400);
        expect((await request(server.url, `/api/artifact?run=${runId}&id=${cited[0]}&offset=${artifact.totalBytes + 1}`, { token })).status).toBe(416);

        // Commit one more record through the fixture's own store; the poll interval is the only thing between the writes.
        await h.call('p2o_note', { kind: 'open', text: 'dashboard live refresh fixture record' });
        await delay(300);
        const second = await request(server.url, '/index.json', { token });
        expect(second.status).toBe(200);
        const refreshed = JSON.parse(second.body);
        expect(refreshed.runs[0].sequence).toBeGreaterThan(sequence);
        expect(refreshed.generatedAt).not.toBeNull();

        server.invalidate();
        const third = await request(server.url, '/index.json', { token });
        expect(third.status).toBe(200);
        expect(JSON.parse(third.body).runs[0].sequence).toBeGreaterThanOrEqual(refreshed.runs[0].sequence);

        // §6.3: a concurrent writer makes the store busy; the service states that in the row and still answers the view.
        const lock = new DatabaseSync(join(h.root, '.p2o-state', runId, 'assessment.sqlite'));
        lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
        try {
          server.invalidate();
          const busyReply = await request(server.url, '/index.json', { token });
          expect(busyReply.status).toBe(200);
          const busyIndex = JSON.parse(busyReply.body);
          expect(busyIndex.runs).toHaveLength(1);
          expect(busyIndex.runs[0]).toMatchObject({ runId, busy: true });
          expect(busyIndex.runs[0].warnings.join('\n')).toContain('store-busy');
          // A busy run still has a readable run file; it simply carries no case or finding rows.
          const busyRun = await request(server.url, `/runs/${runId}.json`, { token });
          expect(busyRun.status).toBe(200);
          expect(JSON.parse(busyRun.body).cases).toEqual([]);
          server.invalidate();
        } finally { lock.exec('ROLLBACK'); lock.close(); }
      } finally { await server.close(); }
    });
  }, 120_000);

  it('refuses a missing frozen directory, a port outside 0-65535 and a non-positive refresh interval', async () => {
    const root = await tempRoot();
    try {
      await expect(serveDashboard({ mode: 'snapshot', directory: join(root, 'nope') })).rejects.toThrow(/does not exist/);
      await mkdir(join(root, 'state'));
      await expect(serveDashboard({ mode: 'live', stateRoots: [{ path: join(root, 'state') }], reportRoots: [], refreshMs: 0 })).rejects.toThrow(/refreshMs/);
      await expect(serveDashboard({ mode: 'snapshot', directory: root, port: 70000 })).rejects.toThrow(/between 0 and 65535/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
