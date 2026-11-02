import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDemonstrated } from '../../src/claims.js';
import { EvidenceStore, type Candidate } from '../../src/evidence.js';
import type { ReplayStamp } from '../../src/replay.js';

/**
 * W-Z: the blind-oracle doctrine has to be executable, not just written down. Two things are pinned here:
 *
 * 1. The probes are a *repeated* oracle. A timing difference is only a verdict when paired runs stay disjoint by the
 *    requested margin; one sample is explicitly inconclusive, so the skill cannot turn a single lucky response into an
 *    effect. The loopback fixture keeps this hermetic — the only traffic is 127.0.0.1 on an ephemeral port.
 * 2. The ladder admits the claim the doctrine tells the worker to record. A confirmed + tested + live_reproduction
 *    claim that cites its own baseline, probe and quiet-control receipts is a demonstrated claim with no extra host
 *    ceremony, while an unevidenced closure and a `ruled_out` without a control are still refused.
 */
const root = resolve(import.meta.dirname, '../..');
const markerProbe = join(root, 'skills/web-injection-to-exec/scripts/marker-probe.py');
const ssrfProbe = join(root, 'skills/ssrf-to-internal/scripts/ssrf-probe.py');
/** Run a probe without blocking the fixture's event loop: the loopback server lives in this process. */
function python(script: string, args: string[], timeout = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn('python3', [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

let server: Server, base = '';
const body = '<html><body>ok</body></html>';

beforeAll(async () => {
  // One deterministic difference: a destination the target fetches is "slow". Same status and body both ways, so only
  // the timing range can separate — exactly the blind case Gate O-2 / Gate B-2 describe.
  server = createServer((request, response) => {
    const delayed = /(?:slow|sleep)/.test(request.url ?? '');
    const reply = () => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(body); };
    if (delayed) setTimeout(reply, 350); else reply();
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback fixture did not bind');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); });

describe('the injection marker probe is a repeated oracle, not a single sample', () => {
  it('separates a repeated timing difference and records the control count without echoing the request', async () => {
    const result = await python(markerProbe, ['--target', `${base}/reflect?id={{payload}}`, '--payload', 'sleep', '--baseline', 'noop', '--runs', '5', '--min-delta-ms', '150']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('oracle: separated');
    expect(result.stdout).toContain('control_runs: 5');
    expect(result.stdout).toContain('run5 payload:');
    expect(result.stdout).toMatch(/timing_ms: baseline_median=.* payload_median=.*/);
    expect(result.stdout).toMatch(/oracle_reason: payload slower: min payload .* ms vs max baseline .* ms \(\+150 ms margin\)/);
    // The receipt is quotable without leaking the request or the payload value it carried.
    expect(result.stdout).not.toContain('/reflect');
    expect(result.stdout).not.toContain('sleep');
  }, 30_000);

  it('calls identical paired responses inconclusive instead of inventing a separation', async () => {
    const result = await python(markerProbe, ['--target', `${base}/same?id={{payload}}`, '--payload', 'probe', '--baseline', 'control', '--runs', '5']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('oracle: inconclusive');
    expect(result.stdout).toContain('oracle_reason: timing ranges overlap or the requested margin was not reached');
    expect(result.stdout).toContain('differs: no');
  }, 30_000);

  it('refuses one pair as an oracle even when that pair looks different', async () => {
    const result = await python(markerProbe, ['--target', `${base}/reflect?id={{payload}}`, '--payload', 'sleep', '--baseline', 'noop', '--runs', '1']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('oracle: inconclusive');
    expect(result.stdout).toContain('a single pair is not a repeated oracle; one timing sample is not proof');
  }, 30_000);
});

describe('the SSRF probe is a repeated in-band oracle', () => {
  it('separates a repeated fetch-timing difference and names the paired runs', async () => {
    const result = await python(ssrfProbe, ['--target', `${base}/fetch?url={{url}}`, '--baseline', `${base}/fast`, '--candidate', `${base}/slow`, '--runs', '3']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('oracle: separated');
    expect(result.stdout).toMatch(/run3 candidate: status=200 bytes=\d+ sha256_16=[a-f0-9]{16} elapsed_ms=\d+/);
    expect(result.stdout).toMatch(/candidate 1: timing_ms baseline_median=.* candidate_median=.*/);
    expect(result.stdout).toContain('candidate 1: oracle_reason=candidate slower');
    // Destinations are labelled without the query string the target would fetch.
    expect(result.stdout).toContain(`baseline: destination=${base}/fast`);
    expect(result.stdout).not.toContain('/fetch?url=');
  }, 30_000);

  it('refuses a single destination pair as an oracle', async () => {
    const result = await python(ssrfProbe, ['--target', `${base}/fetch?url={{url}}`, '--baseline', `${base}/fast`, '--candidate', `${base}/fast`]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('oracle: inconclusive');
    expect(result.stdout).toContain('a single destination pair is not a repeated oracle; one timing sample is not proof');
  }, 30_000);
});

const flatten = (text: string) => text.replace(/\s+/g, ' ');

describe('the skills tell the worker to record the separated oracle instead of walling blind', () => {
  it('injection Gate O-2 records a tested claim and its wall keeps blindness a wall when the oracle does not separate', async () => {
    const skill = await readFile(join(root, 'skills/web-injection-to-exec/SKILL.md'), 'utf8');
    expect(skill).toContain('**Gate O-2 — a repeated oracle counts.**');
    expect(skill).toMatch(/--runs 5/);
    expect(skill).toContain('oracle: separated');
    expect(flatten(skill)).toContain('record one claim as tested (closure confirmed, execution tested, proof live_reproduction)');
    expect(flatten(skill)).toContain('One sample is not proof');
    const wall = flatten(skill.slice(skill.indexOf('## The wall')));
    expect(wall).toContain('Blind with no reachable callback');
    expect(wall).toContain('Gate O-2');
    expect(wall).toMatch(/if it separates, record the tested claim/);
  });

  it('SSRF Gate B-2 records the separated fetch and only hands blindness to chaining when it does not', async () => {
    const skill = await readFile(join(root, 'skills/ssrf-to-internal/SKILL.md'), 'utf8');
    expect(skill).toContain('**Gate B-2 — repeated in-band oracle.**');
    expect(skill).toMatch(/--runs 5/);
    expect(skill).toContain('oracle: separated');
    expect(flatten(skill)).toContain('record one claim as tested (closure confirmed, execution tested, proof live_reproduction)');
    expect(flatten(skill)).toContain('One sample is not proof');
    const wall = flatten(skill.slice(skill.indexOf('## The wall')));
    expect(wall).toContain('No callback and no reflected body');
    expect(wall).toContain('Gate B-2');
    expect(wall).toMatch(/when it separates, record the tested claim/);
  });
});

describe('the evidence ladder admits the claim the repeated oracle tells the worker to record', () => {
  const replay: ReplayStamp = { captured: true, payloadRef: 'payload-00000000-0000-4000-8000-000000000000',
    sha256: 'a'.repeat(64), bytes: 120, kind: 'request', environmentFingerprint: 'b'.repeat(64) };
  const claim = (overrides: Partial<Candidate> = {}): Candidate => ({
    candidate: 'blind-timing-oracle', surface: '/blind', risk: 'injection',
    closure: 'confirmed', execution: 'tested', proof: 'live_reproduction',
    evidenceRefs: [], negativeControls: [], policyBasis: 'boundary_invariant',
    expectedPolicy: 'The endpoint must not delay on a marker it does not evaluate',
    limitations: 'Repeated in-band oracle: payload median +348 ms over baseline; quiet control shared the path and stayed at baseline latency',
    ...overrides,
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'p2o-blind-oracle-'));
    const path = join(directory, 'ledger.jsonl');
    await writeFile(path, '');
    const store = new EvidenceStore('run-blind-oracle', path, 'inert');
    const observation = (label: string, elapsed: number) =>
      store.receipt('worker-a', 'http', `GET /blind?id=${label}`, { code: 0, stdout: `status=200 body_sha256_16=0000000000000000 elapsed_ms=${elapsed}`, stderr: '', truncated: false },
        '2030-01-01T00:00:00.000Z', undefined, replay);
    return { store, cleanup: () => rm(directory, { recursive: true, force: true }), observation };
  }

  it('admits a confirmed, tested, live-reproduction claim with its baseline, probe and control receipts', async () => {
    const { store, cleanup, observation } = await fixture();
    try {
      const baseline = await observation('baseline', 4), probe = await observation('payload', 352), control = await observation('quiet-control', 3);
      const record = await store.candidate('worker-a', claim({ evidenceRefs: [baseline, probe], negativeControls: [control] }), 'task-blind-oracle-1');
      expect(record.data).toMatchObject({ closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', taskRef: 'task-blind-oracle-1' });
      expect(isDemonstrated(record.data ?? {})).toBe(true);
      expect(record.data?.admissionWarnings).toBeUndefined();
    } finally { await cleanup(); }
  }, 30_000);

  it('still refuses a confirmed closure with no evidence and a ruled_out with no control', async () => {
    const { store, cleanup, observation } = await fixture();
    try {
      const probe = await observation('payload', 352);
      await expect(store.candidate('worker-a', claim({ candidate: 'no-receipts', evidenceRefs: [] }))).rejects.toThrow('Closure needs evidence');
      await expect(store.candidate('worker-a', claim({ candidate: 'ruled-out-no-control', closure: 'ruled_out', evidenceRefs: [probe], control: undefined })))
        .rejects.toThrow('ruled_out needs the specific control and its location');
    } finally { await cleanup(); }
  }, 30_000);

  it('warns, rather than refuses, when a demonstrated negative-class claim cites no control', async () => {
    // Host behaviour observed today: a negative observation without a discriminating control is an admission warning.
    // The doctrine still tells the worker to name the control; the ladder records the omission instead of blocking.
    const { store, cleanup, observation } = await fixture();
    try {
      const baseline = await observation('baseline', 4), probe = await observation('payload', 5);
      const record = await store.candidate('worker-a', claim({ candidate: 'no-throttle-oracle', surface: '/login', evidenceRefs: [baseline, probe] }));
      expect(isDemonstrated(record.data ?? {})).toBe(true);
      expect(record.data?.admissionWarnings).toContain('negative claim without a discriminating control: name the positive control that proves the request reached the claimed mechanism, not a short-circuit before it');
    } finally { await cleanup(); }
  }, 30_000);
});
