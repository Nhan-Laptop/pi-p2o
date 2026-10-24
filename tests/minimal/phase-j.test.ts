import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertCveSource, cveQuery, cveUrl, leadFrontier, leadRecords, lookupCves, parseNvd, type LeadDraft } from '../../src/cve.js';
import { finishPreflight } from '../../src/finish-preflight.js';
import { indexRecords } from '../../src/records.js';
import { renderReport } from '../../src/report-export.js';
import { EvidenceStore, type Candidate } from '../../src/evidence.js';
import { sha256Hex } from '../../src/validate.js';
import { summarizeSituation, situationLine } from '../../src/situation.js';

/**
 * Phase J acceptance (P16.4). A CVE is a lead: host-fetched from an allowlisted source with provenance, written as a `lead`
 * record in `untriaged`, counted in the situation line and the preflight advisory, and printed in `## LEADS`. It can never
 * confirm a claim — citing one keeps the claim open until the effect is demonstrated.
 */
const nvd = { vulnerabilities: [
  { cve: { id: 'CVE-2024-1111', vulnStatus: 'Analyzed', descriptions: [{ lang: 'en', value: 'Joomla core allows an unauthenticated upload path.' }],
    metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.8, baseSeverity: 'CRITICAL' } }] },
    configurations: [{ nodes: [{ cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:joomla:joomla:2.5.0:*:*:*:*:*:*:*', versionStartIncluding: '2.5.0', versionEndExcluding: '2.5.28' }] }] }] } },
  { cve: { id: 'CVE-2024-2222', vulnStatus: 'Rejected', descriptions: [{ lang: 'en', value: 'withdrawn' }] } },
] };
const body = JSON.stringify(nvd);
const draft: LeadDraft = { product: 'joomla', version: '2.5.0', cve: 'CVE-2024-1111', severity: 'CRITICAL', affected: 'joomla:joomla 2.5.0..2.5.28',
  summary: 'fixture', source: { url: 'https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=joomla', retrievedAt: '2030-01-01T00:00:00.000Z', sha256: sha256Hex(body) } };

describe('the host fetches from an allowlist and the model names no destination (P16.4)', () => {
  it('builds the NVD query from product/version and refuses any other host', () => {
    const query = cveQuery({ product: 'joomla', version: '2.5.0' });
    const url = new URL(cveUrl(query));
    expect(url.hostname).toBe('services.nvd.nist.gov');
    expect(url.searchParams.get('keywordSearch')).toBe('joomla 2.5.0');
    expect(() => assertCveSource('https://evil.example/cves')).toThrow('not an allowlisted source');
    expect(() => assertCveSource('http://services.nvd.nist.gov/rest/json/cves/2.0')).toThrow('https only');
    expect(() => cveQuery({ product: 'x' })).toThrow('product name');
  });

  it('parses severity, affected range and drops rejected entries', () => {
    const hits = parseNvd(nvd);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ cve: 'CVE-2024-1111', severity: 'CRITICAL', score: 9.8 });
    expect(hits[0].affected).toContain('2.5.0..2.5.28');
  });

  it('records provenance from the fetched bytes and invents nothing from a failed fetch', async () => {
    const result = await lookupCves(cveQuery({ product: 'joomla', version: '2.5.0' }), async () => ({ status: 200, body, sha256: 'ignored' }), () => '2030-01-01T00:00:00.000Z');
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0].source).toEqual({ url: cveUrl(cveQuery({ product: 'joomla', version: '2.5.0' })), retrievedAt: '2030-01-01T00:00:00.000Z', sha256: sha256Hex(body) });
    await expect(lookupCves(cveQuery({ product: 'joomla' }), async () => ({ status: 503, body: 'down', sha256: 'x' }))).rejects.toThrow('answered 503');
  });

  it('writes a lead record that says it is not a finding, and the latest revision wins', () => {
    const records = leadRecords('run-j', 'owner', [draft]);
    expect(records[0]).toMatchObject({ kind: 'lead', text: expect.stringContaining('lead only, not a finding') });
    expect(records[0].data).toMatchObject({ product: 'joomla', version: '2.5.0', cve: 'CVE-2024-1111', state: 'untriaged', source: draft.source });
    const index = indexRecords([{ ...records[0], id: 'lead-1' }, { ...records[0], id: 'lead-2', supersedes: 'lead-1', data: { ...records[0].data, state: 'ruled_out', reason: 'Version is patched' } }], 'run-j');
    const frontier = leadFrontier(index);
    expect(frontier).toHaveLength(1);
    expect(frontier[0]).toMatchObject({ id: 'lead-2', state: 'ruled_out' });
  });
});

describe('a lead shapes a hypothesis but cannot confirm one (P16.4)', () => {
  it('refuses a confirmed claim that cites a lead, and accepts an inferred open one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'p2o-cve-'));
    try {
      const path = join(root, 'ledger.jsonl');await writeFile(path, '');
      const store = new EvidenceStore('run-j', path, 'inert');
      const base: Candidate = { candidate: 'joomla-upload', surface: '/administrator', risk: 'upload', closure: 'open_proof_gap', execution: 'not_tested',
        proof: 'static_trace', evidenceRefs: [], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Declared upload boundary', limitations: 'Version only; not executed', leadRefs: ['lead-1'] };
      await expect(store.candidate('owner', { ...base, closure: 'confirmed', execution: 'tested', proof: 'live_reproduction', policyBasis: 'explicit_contract' })).rejects.toThrow('LEAD_NOT_EVIDENCE');
      await expect(store.candidate('owner', { ...base, policyBasis: 'explicit_contract' })).rejects.toThrow('policyBasis "inferred"');
      const accepted = await store.candidate('owner', base);
      expect(accepted.data).toMatchObject({ closure: 'open_proof_gap', policyBasis: 'inferred' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('untriaged leads are visible, advisory and printed (P16.4)', () => {
  const lead = { ...leadRecords('run-j', 'owner', [draft])[0], id: 'lead-1' };
  const meta = { runId: 'run-j', target: 'inert', retention: 'durable-local', historical: false, asOfSequence: 1, storeSchema: 1, runtime: { hash: 'inert' }, complete: true, format: 2 as const };

  it('counts untriaged leads in the situation line and stops when triaged', () => {
    const untriaged = summarizeSituation({ tasks: [], cases: [], coverage: [], claims: [], leads: [{ state: 'untriaged', severity: 'CRITICAL' }] });
    expect(untriaged).toMatchObject({ leadsUntriaged: 1, leadsCritical: 1 });
    expect(situationLine(untriaged)).toContain('leads: 1 untriaged (1 critical)');
    const triaged = summarizeSituation({ tasks: [], cases: [], coverage: [], claims: [], leads: [{ state: 'ruled_out', severity: 'CRITICAL' }] });
    expect(situationLine(triaged)).not.toContain('leads:');
  });

  it('is an advisory, not an obligation, and clears once triaged', () => {
    const open = finishPreflight(indexRecords([lead], 'run-j'));
    expect(open.obligations.map(item => item.code)).not.toContain('LEAD_UNTRIAGED');
    expect(open.advisory.find(item => item.code === 'LEAD_UNTRIAGED')).toMatchObject({ level: 'advisory', ids: ['lead-1'] });
    const triaged = finishPreflight(indexRecords([lead, { ...lead, id: 'lead-2', supersedes: 'lead-1', data: { ...lead.data, state: 'ruled_out', reason: 'patched in 2.5.28' } }], 'run-j'));
    expect(triaged.advisory.map(item => item.code)).not.toContain('LEAD_UNTRIAGED');
  });

  it('renders ## LEADS with the source and its hash', () => {
    const report = renderReport(indexRecords([lead], 'run-j'), {}, meta).files.find(file => file.name === 'REPORT.md')!.body;
    expect(report).toContain('## LEADS');
    expect(report).toContain('CVE-2024-1111');
    expect(report).toContain('services.nvd.nist.gov');
    expect(report).toContain(draft.source.sha256);
    expect(report).toContain('untriaged');
  });
});
