import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evidenceVersionOf } from '../../src/traffic-snapshot.js';
import { AssessmentStore } from '../../src/state/store.js';
import { fixture, populate } from './helpers/report-fixture.js';
import { InertSandbox } from './helpers/fake-pi.js';

/**
 * W-Y acceptance through the real extension: a browser HAR captured as an ordinary retained artifact is auto-ingested into
 * host-frozen traffic snapshots, a case rating cites one snapshotRef per ordered reproduction step, the exported report prints
 * the host-computed evidence version and findings.json carries it, and an export whose cited snapshot no longer verifies is
 * refused instead of published.
 */
const HAR = JSON.stringify({ log: { version: '1.2', creator: { name: 'agent-browser', version: '0.0.0' }, entries: [
  { request: { method: 'GET', url: 'https://fixture.test/login', headers: [{ name: 'Authorization', value: 'Bearer SECRET-TOKEN-XYZ' }] },
    response: { status: 200, headers: [{ name: 'content-type', value: 'text/html' }], content: { mimeType: 'text/html', text: '<html>login</html>' } } },
  { request: { method: 'POST', url: 'https://fixture.test/session', headers: [{ name: 'cookie', value: 'sid=SECRET-SESSION-ABC' }],
      postData: { mimeType: 'application/x-www-form-urlencoded', text: 'user=alice&password=hunter2' } },
    response: { status: 302, headers: [{ name: 'location', value: '/admin' }], content: { mimeType: 'text/html', text: 'redirect' } } },
] } });

const originalExec = InertSandbox.prototype.exec;
afterEach(() => { InertSandbox.prototype.exec = originalExec; });

/** Make every executor print the HAR, so the owner's shell capture retains it as a normal stdout artifact. */
function serveHar(text: string) {
  InertSandbox.prototype.exec = async (_command: string, _seconds?: number, _signal?: AbortSignal, _workdir?: string, onRunning?: () => void, onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void) => {
    onRunning?.(); onOutput?.('stdout', Buffer.from(text));
    return { code: 0, stdout: text, stderr: '', truncated: false };
  };
}

const openReadOnly = (h: any) => AssessmentStore.open(join(h.root, '.p2o-state'), h.runIdSync, { readOnly: true });

/**
 * Inside one fixture run: capture the HAR as a shell artifact (auto-ingest freezes snapshots), then rate the accepted fixture
 * case against the frozen refs. Returns the exact ids and versions the report must reproduce.
 */
async function rateAgainstFrozenTraffic(h: any) {
  const built = await populate(h);
  serveHar(HAR);
  const capture = (await h.call('p2o_shell', { command: 'agent-browser network har /work/traffic.har && cat /work/traffic.har' })).details;
  const runId = await h.runId();
  const store = AssessmentStore.open(join(h.root, '.p2o-state'), runId, { readOnly: true });
  try {
    const note = store.records().find(record => record.kind === 'note' && (record.data?.trafficSnapshot as any)?.format === 'p2o-traffic/1');
    expect(note, 'the HAR import must record one owner traffic snapshot note').toBeTruthy();
    const snapshots = (note!.data!.trafficSnapshot as any).snapshots as Array<{ position: number; snapshotRef: string; sha256: string; url: string }>;
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map(row => row.position)).toEqual([1, 2]);
    expect(snapshots.every(row => /^artifact-[a-f0-9-]{36}$/.test(row.snapshotRef) && /^[a-f0-9]{64}$/.test(row.sha256))).toBe(true);
    // Secret material in the captured HAR is redacted before the snapshot artifact is stored.
    const frozen = snapshots.map(row => store.artifact(row.snapshotRef, 0, 48 * 1024).text).join('\n');
    expect(frozen).not.toContain('hunter2');
    expect(frozen).not.toContain('SECRET-TOKEN-XYZ');
    expect(frozen).not.toContain('SECRET-SESSION-ABC');
    expect(frozen).toContain('https://fixture.test/login');
    // The HAR is also ordinary extracted knowledge: observed route assets, never a claim.
    const routes = (await h.call('p2o_graph', { action: 'query', kind: 'route' })).details as any;
    expect(routes.rows.map((row: any) => row.key)).toEqual(expect.arrayContaining(['/login', '/session']));
    // One ordered, role-labelled snapshot citation per reproduction step; hashes and positions are host-derived.
    const rating = (await h.call('p2o_case_rate', { id: built.accepted.id, revision: built.accepted.revision, entry: {
      severity: 'high', basis: 'The frozen browser exchanges show the authenticated session boundary crossing', cwe: [], references: [],
      reproductionSteps: [{ ref: built.observation.evidenceId, role: 'baseline', note: 'Unauthenticated exchange from the frozen HAR', snapshotRef: snapshots[0].snapshotRef },
        { ref: capture.evidenceId, role: 'proof', note: 'Authenticated POST followed by the privileged redirect', snapshotRef: snapshots[1].snapshotRef }] } })).details;
    expect(rating.evidenceVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(rating.trafficRefs).toEqual([
      { role: 'baseline', position: 1, snapshotRef: snapshots[0].snapshotRef, sha256: snapshots[0].sha256 },
      { role: 'proof', position: 2, snapshotRef: snapshots[1].snapshotRef, sha256: snapshots[1].sha256 },
    ]);
    expect(rating.evidenceVersion).toBe(evidenceVersionOf(rating.trafficRefs));
    return { built, snapshots, rating };
  } finally { store.close(); }
}

describe('W-Y traffic evidence materiality', () => {
  it('freezes a captured HAR, cites ordered role-labelled snapshots and prints the evidence version in the report', async () => {
    await fixture(async h => {
      const rated = await rateAgainstFrozenTraffic(h);
      const directory = join(h.root, 'report-out');
      await h.command(`report export ${directory}`);
      expect(await readdir(directory)).toEqual(expect.arrayContaining(['REPORT.md', 'findings.json']));
      const report = await readFile(join(directory, 'REPORT.md'), 'utf8');
      expect(report).toContain('Traffic evidence: version');
      const findings = JSON.parse(await readFile(join(directory, 'findings.json'), 'utf8'));
      expect(findings.version).toBe(2);
      expect(findings.findings[0]).toMatchObject({ evidenceVersion: rated.rating.evidenceVersion, traffic: [
        { role: 'baseline', position: 1, snapshotRef: rated.snapshots[0].snapshotRef },
        { role: 'proof', position: 2, snapshotRef: rated.snapshots[1].snapshotRef }] });
    });
  });

  it('refuses to export a report whose cited frozen snapshot no longer verifies', async () => {
    await fixture(async h => {
      const rated = await rateAgainstFrozenTraffic(h);
      const snapshotRef = rated.snapshots[0].snapshotRef;
      const files = await readdir(h.root, { recursive: true }) as string[];
      const blob = files.find(name => name.endsWith(`${snapshotRef}.txt`));
      expect(blob, 'the frozen snapshot must be a retained artifact file').toBeTruthy();
      await writeFile(join(h.root, blob!), 'tampered');
      await h.command(`report export ${join(h.root, 'stale-report')}`);
      // The command channel reports a refusal through the UI notice; nothing is published.
      expect(h.ctx.notices.join('\n')).toContain('REPORT_STALE_EVIDENCE');
      await expect(readdir(join(h.root, 'stale-report'))).rejects.toThrow();
    });
  });
});
