import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerP2O, testSeamFor } from '../../extensions/p2o/index.js';
import { readLedger } from '../../src/records.js';
import { sha256Hex } from '../../src/validate.js';
import { createContext, createFakePi, createSimpleHerdr, sandboxFactory, EXTENSION_PATH, InertSandbox, type FakePi } from './helpers/fake-pi.js';

/**
 * R2 acceptance through the real two-role stack. The planner cannot execute target work, so the capture is produced by a worker
 * over the broker exactly as in a live run, and the host-side extractor turns it into rows. The model sees tool results only:
 * these assertions read `p2o_graph`/`p2o_research` replies and the owner ledger, never an internal function of the writer.
 */
const boundedFetch = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../src/research-fetch.js', () => ({ fetchBounded: boundedFetch.fn }));

const nmapXml = `<nmaprun><host><status state="up"/><address addr="10.0.0.5" addrtype="ipv4"/>
<ports><port protocol="tcp" portid="22"><state state="open"/><service name="ssh" product="OpenSSH" version="8.9p1"/></port></ports></host></nmaprun>`;
const lockfile = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21' }, 'node_modules/@scope/pkg': { version: '2.0.0' } } });
const nvdBody = JSON.stringify({ vulnerabilities: [{ cve: { id: 'CVE-2024-9999', vulnStatus: 'Analyzed', descriptions: [{ lang: 'en', value: 'lodash fixture' }],
  metrics: { cvssMetricV31: [{ cvssData: { baseScore: 7.5, baseSeverity: 'HIGH' } }] },
  configurations: [{ nodes: [{ cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:lodash:lodash:4.17.21:*:*:*:*:*:*:*', versionStartIncluding: '4.17.0', versionEndIncluding: '4.17.21' }] }] }] } }] });
const kevBody = JSON.stringify({ vulnerabilities: [{ cveID: 'CVE-2024-9999', vendorProject: 'lodash', product: 'lodash', dateAdded: '2030-01-01' }] });
const epssBody = JSON.stringify({ data: [{ cve: 'CVE-2024-9999', epss: '0.44100', percentile: '0.91000' }] });

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'p2o-ingest-e2e-'));
  await mkdir(join(root, 'repo'), { recursive: true });
  const owner: FakePi = createFakePi(), worker: FakePi = createFakePi();
  const sandboxes: InertSandbox[] = [];
  const herdr = createSimpleHerdr();
  const ownerContext = createContext({ cwd: root }), workerContext = createContext({ cwd: root });
  registerP2O(owner.pi, { createSandbox: sandboxFactory(sandboxes), herdr: herdr.client, controlRoot: join(root, 'control'), extensionPath: EXTENSION_PATH });
  registerP2O(worker.pi, { extensionPath: EXTENSION_PATH });
  await owner.commands.get('p2o').handler('--target ./repo', ownerContext.ctx);
  if (owner.messages.length === 0) throw new Error(`start failed: ${ownerContext.notices.join(' | ') || 'no notice'}`);
  const runDir = async () => join(join(root, 'control'), (await readdir(join(root, 'control'))).find(name => name.startsWith('p2o-run-'))!);
  // S1/B10: the hidden delegate/task-start verbs are gone; the harness runs their code through the registration seam.
  const seam = (name: string, params: any) => name === 'p2o_delegate' ? testSeamFor(owner.pi).spawn(params) : name === 'p2o_task_start' ? testSeamFor(owner.pi).startTask(params) : undefined;
  const call = (name: string, params: Record<string, unknown> = {}, which: 'owner' | 'worker' = 'owner') =>
    seam(name, params) ?? (which === 'owner' ? owner : worker).tools.get(name)!.execute('call', params, undefined, undefined, (which === 'owner' ? ownerContext : workerContext).ctx);
  const records = async () => (await readLedger(join(await runDir(), 'records.sqlite'))).records;
  /**
   * The inert sandbox returns a fixed banner; each scenario replaces exec on the class so every executor instance (the shared
   * sandbox and any per-assignment one) reports the capture the parser should see.
   */
  const capture = (stdout: string) => {
    InertSandbox.prototype.exec = async (_command: string, _seconds?: number, _signal?: AbortSignal, _workdir?: string, onRunning?: () => void, onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void) => {
      onRunning?.(); onOutput?.('stdout', Buffer.from(stdout));
      return { code: 0, stdout, stderr: '', truncated: false };
    };
  };
  return {
    root, owner, worker, sandboxes, ownerContext, workerContext, runDir, records, capture, call,
    async delegate() {
      const result = await call('p2o_delegate', { focus: 'recon', task: 'Inspect the target surface', context: 'nothing known yet' });
      const workerId = result.details.workerId as string;
      worker.flags['p2o-worker'] = join(await runDir(), `ticket-${workerId}.json`);
      for (const handler of worker.events.get('session_start') ?? []) await handler({}, workerContext.ctx);
      return workerId;
    },
    shell: async (command: string) => await call('p2o_shell', { command }, 'worker'),
  };
}

/** One run with one activated worker; each test owns its directories. */
const scenario = async (cleanup: Array<() => Promise<void>>) => {
  const h = await harness();
  cleanup.push(() => rm(h.root, { recursive: true, force: true }));
  await h.delegate();
  return h;
};

describe('capture → graph rows without model authoring (R2.3)', () => {
  const cleanup: Array<() => Promise<void>> = [];
  const originalExec = InertSandbox.prototype.exec;
  afterEach(async () => { boundedFetch.fn.mockReset(); InertSandbox.prototype.exec = originalExec; for (const stop of cleanup.splice(0)) await stop(); });

  it('auto-ingests a recognized worker capture as unverified extractor rows and notes what it did', async () => {
    const h = await scenario(cleanup);
    h.capture(nmapXml);
    const shell = (await h.shell('cat /work/scan.xml')).details as any;
    const artifactId = shell.capture.artifacts[0].id as string;
    expect(artifactId).toMatch(/^artifact-/);
    const page = (await h.call('p2o_graph', { action: 'query', kind: 'host' })).details as any;
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ kind: 'host', key: '10.0.0.5', revision: 1 });
    const services = (await h.call('p2o_graph', { action: 'query', kind: 'service' })).details as any;
    expect(services.rows[0].key).toBe('10.0.0.5:22/tcp');
    const exported = (await h.call('p2o_graph', { action: 'export', limit: 5 })).details as any;
    // The artifact anchor relates the row to the retained bytes it came from; the rows themselves stay unverified knowledge.
    expect(exported.json.anchors.some((anchor: any) => anchor.kind === 'artifact' && anchor.artifactId === artifactId)).toBe(true);
    expect(exported.json.assertions.every((assertion: any) => assertion.unverified === true)).toBe(true);
    const notes = (await h.records()).filter(record => record.kind === 'lifecycle' && record.text.includes('auto-ingest'));
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toMatch(/auto-ingest artifact-.* \(nmap\): 2 asset\(s\), 2 fact\(s\), 0 hypothesis\(es\)/);
    expect(notes[0].data).toMatchObject({ event: 'artifact.ingest', extractor: 'nmap', operation: 'shell', auto: true });
  }, 60_000);

  it('treats a re-ingest as an observation, not a duplicate revision, and lets the planner retry manually', async () => {
    const h = await scenario(cleanup);
    h.capture(nmapXml);
    const first = (await h.shell('cat /work/scan.xml')).details as any;
    await h.shell('cat /work/scan.xml');
    const page = (await h.call('p2o_graph', { action: 'query', kind: 'host' })).details as any;
    expect(page.rows[0]).toMatchObject({ revision: 1, key: '10.0.0.5' });
    const retry = (await h.call('p2o_graph_plan', { action: 'ingest', id: first.capture.artifacts[0].id })).details as any;
    expect(retry).toMatchObject({ action: 'ingest', ingested: true, extractor: 'nmap', counts: { assets: 2, facts: 2 } });
    const again = (await h.call('p2o_graph', { action: 'query', kind: 'host' })).details as any;
    expect(again.rows[0].revision).toBe(1);
    expect(again.counts.assets).toBe(1);
  }, 60_000);

  it('states a refusal instead of inventing rows when nothing is recognized or nothing is retained', async () => {
    const h = await scenario(cleanup);
    h.capture('plain log line one\nplain log line two\n');
    const shell = (await h.shell('cat /work/notes.log')).details as any;
    const untouched = (await h.call('p2o_graph_plan', { action: 'ingest', id: shell.capture.artifacts[0].id })).details as any;
    expect(untouched).toMatchObject({ action: 'ingest', ingested: false });
    expect(untouched.note).toMatch(/No extractor recognized this artifact/);
    await expect(h.call('p2o_graph_plan', { action: 'ingest', id: 'artifact-00000000-0000-0000-0000-000000000000' })).rejects.toThrow(/Unknown artifact|artifact/i);
    await expect(h.call('p2o_graph_plan', { action: 'ingest', id: 'not-an-artifact' })).rejects.toThrow(/retained artifact ID/);
    const empty = (await h.call('p2o_graph', { action: 'query' })).details as any;
    expect(empty.counts.assets).toBe(0);
  }, 60_000);

  it('builds the component inventory from a captured lockfile and reports the unqueried backlog in the summary', async () => {
    const h = await scenario(cleanup);
    h.capture(lockfile);
    await h.shell('cat /work/package-lock.json');
    const components = (await h.call('p2o_graph', { action: 'query', kind: 'package' })).details as any;
    expect(components.rows).toHaveLength(2);
    expect(components.rows.find((row: any) => row.key === 'npm:lodash@4.17.21')).toMatchObject({ attributes: { name: 'lodash', version: '4.17.21', ecosystem: 'npm' } });
    const summary = (await h.call('p2o_graph', { action: 'summary' })).details as any;
    expect(summary.counts).toMatchObject({ components: 2, componentsUnqueried: 2 });
    expect(summary.text).toMatch(/2 component\(s\), 2 without a CVE query/);
    expect(summary.rows.componentsUnqueried).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'lodash', version: '4.17.21', ecosystem: 'npm' })]));
  }, 60_000);

  it('derives the CVE query from a componentRef and joins KEV/EPSS context without changing severity', async () => {
    const h = await scenario(cleanup);
    h.capture(lockfile);
    await h.shell('cat /work/package-lock.json');
    const lodash = ((await h.call('p2o_graph', { action: 'query', kind: 'package' })).details as any).rows.find((row: any) => row.key === 'npm:lodash@4.17.21');
    boundedFetch.fn.mockImplementation(async (url: string) => {
      const body = url.includes('services.nvd.nist.gov') ? nvdBody : url.includes('cisa.gov') ? kevBody : epssBody;
      return { status: 200, body, sha256: sha256Hex(body), bytes: Buffer.byteLength(body), contentType: 'application/json', finalUrl: url, truncated: false };
    });
    const result = (await h.call('p2o_research', { action: 'cve', componentRef: lodash.entityId })).details as any;
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]).toMatchObject({ product: 'lodash', version: '4.17.21', cve: 'CVE-2024-9999', severity: 'HIGH', versionMatch: 'in-range',
      exploitability: { kev: true, epss: 0.441, percentile: 0.91 } });
    expect(result.query).toMatchObject({ product: 'lodash', version: '4.17.21' });
    expect(result.assets).toEqual([expect.objectContaining({ id: lodash.entityId })]);
    expect(result.enrichmentWarnings).toBeUndefined();
    // The summary backlog shrinks because the lead cites the component asset; ordering by KEV is context, not severity.
    const summary = (await h.call('p2o_graph', { action: 'summary' })).details as any;
    expect(summary.counts.componentsUnqueried).toBe(1);
    const ledger = await h.records();
    const lead = ledger.find(record => record.kind === 'lead')!;
    expect(lead.data).toMatchObject({ cve: 'CVE-2024-9999', severity: 'HIGH', versionMatch: 'in-range', exploitability: { kev: true, epss: 0.441 },
      assetRefs: [expect.objectContaining({ id: lodash.entityId })] });
    const research = ledger.filter(record => record.kind === 'research').at(-1)!;
    expect(research.data).toMatchObject({ action: 'cve', enrichment: { kev: { status: 'ok' }, epss: { status: 'ok' } } });
  }, 60_000);

  it('keeps componentRef on the worker research path instead of dropping it before the host', async () => {
    // S1/A7 (planning_update.md F-06): the schema and the description both promise that a package asset can supply the CVE
    // query, but the worker payload omitted componentRef, so the host refused a legal identity. The worker call travels the
    // same broker request the live worker uses.
    const h = await scenario(cleanup);
    h.capture(lockfile);
    await h.shell('cat /work/package-lock.json');
    const lodash = ((await h.call('p2o_graph', { action: 'query', kind: 'package' })).details as any).rows.find((row: any) => row.key === 'npm:lodash@4.17.21');
    boundedFetch.fn.mockImplementation(async (url: string) => {
      const body = url.includes('services.nvd.nist.gov') ? nvdBody : url.includes('cisa.gov') ? kevBody : epssBody;
      return { status: 200, body, sha256: sha256Hex(body), bytes: Buffer.byteLength(body), contentType: 'application/json', finalUrl: url, truncated: false };
    });
    const result = (await h.call('p2o_research', { action: 'cve', componentRef: lodash.entityId }, 'worker')).details as any;
    expect(result.query).toMatchObject({ product: 'lodash', version: '4.17.21' });
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]).toMatchObject({ cve: 'CVE-2024-9999', versionMatch: 'in-range' });
    expect(result.assets).toEqual([expect.objectContaining({ id: lodash.entityId })]);
  }, 60_000);

  it('keeps the exploitability context unknown when the public feeds cannot be read', async () => {
    const h = await scenario(cleanup);
    h.capture(lockfile);
    await h.shell('cat /work/package-lock.json');
    const lodash = ((await h.call('p2o_graph', { action: 'query', kind: 'package' })).details as any).rows.find((row: any) => row.key === 'npm:lodash@4.17.21');
    boundedFetch.fn.mockImplementation(async (url: string) => {
      if (url.includes('services.nvd.nist.gov')) return { status: 200, body: nvdBody, sha256: sha256Hex(nvdBody), bytes: Buffer.byteLength(nvdBody), contentType: 'application/json', finalUrl: url, truncated: false };
      throw new Error('network unreachable');
    });
    const result = (await h.call('p2o_research', { action: 'cve', componentRef: lodash.entityId })).details as any;
    // Offline is an open question, not "not exploited": the lead keeps its severity, and both feeds say unknown.
    expect(result.leads[0]).toMatchObject({ severity: 'HIGH', exploitability: { kev: 'unknown', epss: 'unknown' } });
    expect(result.enrichmentWarnings.join(' ')).toMatch(/KEV feed unavailable.*unknown, not "not exploited"/);
    const lead = (await h.records()).find(record => record.kind === 'lead')!;
    expect(lead.data?.exploitability).toMatchObject({ kev: 'unknown', epss: 'unknown' });
  }, 60_000);
});
