import { beforeEach, describe, expect, it } from 'vitest';
import type {
  DashboardCaseRow, DashboardFindingAggregate, DashboardFindingRow, DashboardIndexFile, DashboardOccurrence,
  DashboardRunFile, DashboardRunSummary,
} from '../lib/model';
import {
  buildFindingsSearch, DEFAULT_FINDINGS_FILTERS, distinctValues, filterAggregates, findingsCsv, findingsFilename,
  findingsJson, findingsTiles, filtersActive, joinOccurrenceEvidence, evidenceOccurrence, matchCaseRow, matchFindingRow,
  paginate, parseFindingsQuery, selectAggregate, sortAggregates, stableHash,
} from '../lib/findings';
import { authHeaders, clearAuthToken, parseTokenHash, rememberAuthToken, withAuthHash } from '../lib/auth';
import { refreshSeconds } from '../lib/format';

const run = (runId: string, target: string | null = null, patch: Partial<DashboardRunSummary> = {}): DashboardRunSummary => ({
  runId, source: 'store', retention: 'durable-local', target, targetKind: target ? 'web-app' : null, mode: null,
  startedAt: null, lastRecordAt: null, sequence: 10, asOfSequence: null, schemaVersion: 8, graphVersion: 3,
  complete: true, endReason: null, outcome: null, live: true, records: 10,
  counts: { nodes: 1, edges: 0, anchors: 0, cases: 1, findingsAccepted: 1 }, warnings: [], ...patch,
});

const occurrence = (runId: string, patch: Partial<DashboardOccurrence> = {}): DashboardOccurrence => ({
  runId, source: 'store', retention: 'durable-local', asOfSequence: 10, complete: true,
  findingId: 'a'.repeat(32), identity: 'findingId', caseId: `case-${runId}`, caseRevision: 1,
  title: 'SQL injection in search', severity: 'high', verdict: 'confirmed', reviewStatus: 'accepted',
  currentness: 'current', accepted: true, policyKey: 'policy:sqli', rootCauseKey: 'root:input',
  remediationStatus: 'planned', retest: null, cvss: null, cwe: ['CWE-89'], wstg: ['wstg-inpv-05'],
  techniques: ['T1190'], assets: ['asset-1'], time: '2026-01-02T03:04:05Z', ...patch,
});

const aggregate = (id: string, occurrences: DashboardOccurrence[], patch: Partial<DashboardFindingAggregate> = {}): DashboardFindingAggregate => {
  const runs = [...new Set(occurrences.map(item => item.runId))].sort();
  return {
    id, identity: 'findingId', title: occurrences[0]?.title ?? 'untitled', severity: 'high',
    runs, occurrences, conflicts: [], accepted: occurrences.filter(item => item.accepted).length,
    firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z', ...patch,
  };
};

const findingRow = (patch: Partial<DashboardFindingRow> = {}): DashboardFindingRow => ({
  findingId: 'a'.repeat(32), identity: 'findingId', caseId: 'case-run-a', caseRevision: 1, title: 'SQL injection in search',
  severity: 'high', verdict: 'confirmed', reviewStatus: 'accepted', currentness: 'current', accepted: true,
  independentValidationCurrent: true, independenceReason: null, policyKey: 'policy:sqli', rootCauseKey: 'root:input',
  remediationStatus: 'planned', remediation: { status: 'planned', reason: 'patch queued', steps: 'validate then encode' },
  retest: null, cvss: { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', baseScore: 7.5, severity: 'high' },
  cwe: ['CWE-89'], wstg: [{ key: 'wstg-inpv-05', page: null }], techniques: ['T1190'], assets: ['asset-1'],
  severityBasis: 'observed response', likelihood: null, impact: null, ratingLimitations: null, ratingProvenance: 'observed',
  ratingFlags: [], evidenceVersion: null, traffic: [], claims: ['claim-1'], independentEvidence: [],
  references: ['wstg-inpv-05'], contradictions: [], limitations: null, independenceWaiver: null, chain: null,
  time: '2026-01-02T03:04:05Z', reproduction: [], ...patch,
});

const caseRow = (patch: Partial<DashboardCaseRow> = {}): DashboardCaseRow => ({
  id: 'case-run-a', revision: 1, title: 'SQL injection in search', verdict: 'confirmed', reviewStatus: 'accepted',
  currentness: 'current', accepted: true, canonicalCaseId: 'case-run-a', staleReasons: [], independentCurrent: true,
  readyToRate: true, severity: 'high', cvss: null, cwe: ['CWE-89'], policyKey: 'policy:sqli', rootCauseKey: 'root:input',
  claimRefs: ['claim-1'], assetRefs: [{ id: 'asset-1' }], taskRefs: [], remediation: { status: 'planned', reason: 'patch queued' },
  retest: null, recordId: 'record-1', time: '2026-01-02T03:04:05Z', reproduction: [], ...patch,
});

const emptyGraph = (runId: string) => ({
  label: 'derived projection', runId, asOfSequence: 10, graphVersion: 3, nodes: [], edges: [], anchors: [],
  counts: { nodes: 0, edges: 0, anchors: 0 }, unresolved: 0, overflow: 0, chainOrderTruncated: 0, truncated: false,
});

const runFile = (runId: string, findings: DashboardFindingRow[], cases: DashboardCaseRow[] = []): DashboardRunFile => ({
  format: 'p2o-dashboard-run', version: 1, runId, run: run(runId), graph: emptyGraph(runId), cases, findings, artifacts: [],
  omitted: { cases: 0, findings: 0, nodes: 0, edges: 0, anchors: 0, bodies: false, reproduction: false },
});

const indexFile = (findings: DashboardFindingAggregate[], totals: DashboardIndexFile['totals'], omitted = 0): DashboardIndexFile => ({
  format: 'p2o-dashboard', version: 1, generatedAt: '2026-01-02T00:00:00Z',
  labels: { projection: 'projection', authority: 'read-only', redaction: 'redacted best effort', scope: 'store lists every case' },
  runs: [run('run-a', 'target-a'), run('run-b', 'target-b')],
  findings, totals, limits: { runs: 200, directoryEntries: 2000, casesPerRun: 500, findings: 2000, dataBytesPerRun: 1000, snapshotBytes: 1000, artifactsPerRun: 64, artifactBytes: 1024 },
  omitted: { findings: omitted }, warnings: [],
});

describe('findings query parsing', () => {
  it('reads every filter, sort and page value and ignores unknown vocabulary', () => {
    const query = parseFindingsQuery('?id=abc&severity=high&review=disputed&verdict=ruled_out&currentness=stale&source=report&run=run-1&target=target-a&q=SQL%20injection&sort=time&page=3');
    expect(query.id).toBe('abc');
    expect(query.filters).toEqual({
      severity: 'high', review: 'disputed', verdict: 'ruled_out', currentness: 'stale', source: 'report',
      run: 'run-1', target: 'target-a', text: 'SQL injection',
    });
    expect(query.sort).toBe('time');
    expect(query.page).toBe(3);
    expect(parseFindingsQuery('?severity=bogus&sort=bogus&page=0').filters.severity).toBe('');
    expect(parseFindingsQuery('?severity=bogus&sort=bogus&page=0').sort).toBe('severity');
    expect(parseFindingsQuery('?severity=bogus&sort=bogus&page=0').page).toBe(1);
    expect(parseFindingsQuery('').filters).toEqual(DEFAULT_FINDINGS_FILTERS);
    expect(parseFindingsQuery('?id=   ').id).toBeNull();
    expect(parseFindingsQuery(`?q=${'x'.repeat(200)}`).filters.text).toHaveLength(120);
  });

  it('builds a stable search string and omits defaults', () => {
    expect(buildFindingsSearch({ filters: DEFAULT_FINDINGS_FILTERS, sort: 'severity', page: 1, id: null })).toBe('');
    const search = buildFindingsSearch({
      filters: { ...DEFAULT_FINDINGS_FILTERS, severity: 'high', text: 'a b' }, sort: 'run', page: 2, id: 'id/1',
    });
    expect(search).toBe('?id=id%2F1&severity=high&q=a%20b&sort=run&page=2');
    expect(parseFindingsQuery(search).filters.text).toBe('a b');
    expect(parseFindingsQuery(search).id).toBe('id/1');
  });

  it('clamps the refresh interval to 0–300 seconds with a five-second default', () => {
    expect(refreshSeconds('')).toBe(5);
    expect(refreshSeconds('?refresh=0')).toBe(0);
    expect(refreshSeconds('?refresh=12')).toBe(12);
    expect(refreshSeconds('?refresh=-4')).toBe(0);
    expect(refreshSeconds('?refresh=9999')).toBe(300);
    expect(refreshSeconds('?refresh=nope')).toBe(5);
    expect(refreshSeconds('?refresh=1.9')).toBe(1);
  });
});

describe('findings filters', () => {
  const runs = [run('run-a', 'target-a'), run('run-b', 'target-b')];
  const rows = [
    aggregate('a', [occurrence('run-a')], { title: 'SQL injection in search', severity: 'high' }),
    aggregate('b', [occurrence('run-b', { source: 'report', verdict: 'open', reviewStatus: 'pending', currentness: 'stale', title: 'Open redirect', severity: 'low', accepted: false })], { title: 'Open redirect', severity: 'low', accepted: 0 }),
    aggregate('c', [occurrence('run-a', { source: 'report' })], { title: 'SQL injection elsewhere', severity: 'high' }),
  ];
  const filter = (patch: Partial<typeof DEFAULT_FINDINGS_FILTERS>): string[] =>
    filterAggregates(rows, { ...DEFAULT_FINDINGS_FILTERS, ...patch }, runs).map(row => row.id);

  it('filters severity, title text and source over the aggregate', () => {
    expect(filter({ severity: 'high' })).toEqual(['a', 'c']);
    expect(filter({ text: 'INJECTION' })).toEqual(['a', 'c']);
    expect(filter({ source: 'report' })).toEqual(['b', 'c']);
    expect(filter({ severity: 'high', source: 'store' })).toEqual(['a']);
    expect(filtersActive(DEFAULT_FINDINGS_FILTERS)).toBe(false);
    expect(filtersActive({ ...DEFAULT_FINDINGS_FILTERS, severity: 'high' })).toBe(true);
  });

  it('filters occurrence-level values and joins the target through the run summaries', () => {
    expect(filter({ review: 'pending' })).toEqual(['b']);
    expect(filter({ verdict: 'open' })).toEqual(['b']);
    expect(filter({ currentness: 'stale' })).toEqual(['b']);
    expect(filter({ run: 'run-a' })).toEqual(['a', 'c']);
    expect(filter({ target: 'target-b' })).toEqual(['b']);
    expect(filter({ target: 'missing' })).toEqual([]);
  });
});

describe('findings sort and pagination', () => {
  const rows = [
    aggregate('low-new', [occurrence('run-b')], { severity: 'low', title: 'Low', lastSeen: '2026-03-01T00:00:00Z', runs: ['run-b'] }),
    aggregate('high-old', [occurrence('run-a')], { severity: 'high', title: 'High', lastSeen: '2026-01-01T00:00:00Z', runs: ['run-a'] }),
    aggregate('high-new', [occurrence('run-c')], { severity: 'high', title: 'High again', lastSeen: '2026-02-01T00:00:00Z', runs: ['run-c'] }),
    aggregate('unrated', [occurrence('run-d', { severity: null, title: 'Unrated' })], { severity: 'not rated', title: 'Unrated', lastSeen: null, runs: ['run-d'] }),
  ];
  const ids = (values: DashboardFindingAggregate[]): string[] => values.map(value => value.id);

  it('sorts severity worst-first with a stable title/id tie-break', () => {
    expect(ids(sortAggregates(rows, 'severity'))).toEqual(['high-old', 'high-new', 'low-new', 'unrated']);
  });

  it('sorts time newest-first with a missing time last and run by the first run id', () => {
    expect(ids(sortAggregates(rows, 'time'))).toEqual(['low-new', 'high-new', 'high-old', 'unrated']);
    expect(ids(sortAggregates(rows, 'run'))).toEqual(['high-old', 'low-new', 'high-new', 'unrated']);
  });

  it('reports explicit totals and clamps an out-of-range page', () => {
    const items = Array.from({ length: 60 }, (_, index) => index);
    expect(paginate(items, 2)).toMatchObject({ page: 2, pageCount: 3, total: 60, showingFrom: 26, showingTo: 50 });
    expect(paginate(items, 99)).toMatchObject({ page: 3, showingFrom: 51, showingTo: 60 });
    expect(paginate(items, -2)).toMatchObject({ page: 1, showingFrom: 1, showingTo: 25 });
    expect(paginate([], 4)).toMatchObject({ page: 1, pageCount: 1, total: 0, showingFrom: 0, showingTo: 0 });
  });

  it('selects an aggregate by id without inventing a row', () => {
    expect(selectAggregate(rows, 'high-old')?.title).toBe('High');
    expect(selectAggregate(rows, 'missing')).toBeNull();
    expect(selectAggregate(rows, null)).toBeNull();
  });

  it('distinct values are sorted and null-free', () => {
    expect(distinctValues(['b', null, 'a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('findings tiles', () => {
  it('counts runs, accepted/pending, stale and conflicts from index facts only', () => {
    const accepted = aggregate('a', [occurrence('run-a')], { accepted: 1 });
    const pending = aggregate('b', [occurrence('run-b', { accepted: false, reviewStatus: 'pending', currentness: 'stale' })], {
      accepted: 0,
      conflicts: [{ field: 'severity', values: [{ runId: 'run-a', source: 'store', value: 'high' }, { runId: 'run-b', source: 'report', value: 'low' }] }],
    });
    const index = indexFile([accepted, pending], {
      runs: 3, findings: 5, accepted: 4,
      bySeverity: { critical: 0, high: 2, medium: 0, low: 1, informational: 0, 'not rated': 2 },
    }, 3);
    expect(findingsTiles(index)).toMatchObject({
      runs: 3, total: 5, accepted: 1, pending: 1, stale: 1, conflicts: 1, listed: 2, omitted: 3,
    });
    expect(findingsTiles(index).bySeverity.high).toBe(2);
  });
});

describe('evidence joins', () => {
  const occA = occurrence('run-a', { caseId: 'case-a', caseRevision: 2 });
  const occB = occurrence('run-b', { findingId: null, identity: 'fallback', caseId: 'case-b', caseRevision: 1, title: 'Other title' });
  const aggregateA = aggregate('a', [occA, occB]);

  it('matches a finding row by case revision and falls back to the finding id', () => {
    const fileA = runFile('run-a', [findingRow({ caseId: 'case-a', caseRevision: 2 })]);
    expect(matchFindingRow(fileA, occA)?.caseRevision).toBe(2);
    expect(matchFindingRow(fileA, occA)).not.toBeNull();
    expect(matchFindingRow(undefined, occA)).toBeNull();
    const byId = runFile('run-a', [findingRow({ caseId: 'another-case', caseRevision: 9 }), findingRow({ caseId: 'other', caseRevision: 3 })]);
    expect(matchFindingRow(byId, occA)).not.toBeNull();
    const fileB = runFile('run-b', [findingRow({ findingId: null, identity: 'fallback', caseId: 'case-b', caseRevision: 1, title: 'Other title' })]);
    expect(matchFindingRow(fileB, occB)?.caseId).toBe('case-b');
  });

  it('matches only the exact case revision and keeps report-only occurrences without a case row', () => {
    const file = runFile('run-a', [], [caseRow({ id: 'case-a', revision: 2 })]);
    expect(matchCaseRow(file, occA)?.id).toBe('case-a');
    expect(matchCaseRow(file, occurrence('run-a', { caseId: 'case-a', caseRevision: 1 }))).toBeNull();
    expect(matchCaseRow(undefined, occA)).toBeNull();
    expect(matchCaseRow(runFile('run-b', [], []), occurrence('run-b', { source: 'report' }))).toBeNull();
  });

  it('joins each occurrence to its run file and picks the first occurrence that carries full evidence', () => {
    const fileB = runFile('run-b', [findingRow({ findingId: null, identity: 'fallback', caseId: 'case-b', caseRevision: 1, title: 'Other title' })]);
    const joined = joinOccurrenceEvidence(aggregateA, new Map([['run-b', fileB]]));
    expect(joined.map(item => item.fileLoaded)).toEqual([false, true]);
    expect(joined[0]!.finding).toBeNull();
    expect(evidenceOccurrence(joined)?.occurrence.runId).toBe('run-b');
    expect(evidenceOccurrence(joinOccurrenceEvidence(aggregateA, new Map()))).toBeNull();
  });
});

describe('findings export', () => {
  const quoted = aggregate('q', [occurrence('run-a', { title: 'A, "quoted"\nline', assets: ['asset-1', 'asset-2'] })], {
    title: 'A, "quoted"\nline',
    conflicts: [{ field: 'title', values: [{ runId: 'run-a', source: 'store', value: 'A, "quoted"\nline' }, { runId: 'run-b', source: 'report', value: null }] }],
  });

  it('writes a deterministic, escaped CSV with the full aggregate row', () => {
    const csv = findingsCsv([quoted]);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('id,identity,severity,title');
    expect(csv).toContain('"A, ""quoted""');
    expect(csv).toContain('run-a/store=A, ""quoted""');
    expect(findingsCsv([quoted])).toBe(csv);
    expect(findingsCsv([]).endsWith('\n')).toBe(true);
  });

  it('writes a parseable JSON view with stable filenames', () => {
    const meta = { generatedAt: '2026-01-02T03:04:05Z', filters: { ...DEFAULT_FINDINGS_FILTERS, severity: 'high' }, sort: 'severity' as const, total: 1 };
    const parsed = JSON.parse(findingsJson([quoted], meta)) as { format: string; total: number; rows: unknown[]; filters: { severity: string } };
    expect(parsed.format).toBe('p2o-dashboard-findings');
    expect(parsed.total).toBe(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.filters.severity).toBe('high');
    expect(findingsFilename('csv', meta.generatedAt, meta.filters, 'severity')).toBe(`p2o-findings-20260102T030405Z-${stableHash(JSON.stringify({ filters: meta.filters, sort: 'severity' }))}.csv`);
    expect(findingsFilename('json', null, DEFAULT_FINDINGS_FILTERS, 'severity')).toMatch(/^p2o-findings-undated-[a-f0-9]{8}\.json$/);
    expect(findingsFilename('csv', meta.generatedAt, meta.filters, 'severity')).not.toBe(findingsFilename('csv', meta.generatedAt, DEFAULT_FINDINGS_FILTERS, 'severity'));
  });
});

describe('launch token handling', () => {
  beforeEach(() => clearAuthToken());

  it('parses the token only from the URL fragment', () => {
    expect(parseTokenHash('#token=abc123')).toBe('abc123');
    expect(parseTokenHash('#view=1&token=x%2By')).toBe('x+y');
    expect(parseTokenHash('token=abc')).toBe('abc');
    expect(parseTokenHash('#other=1')).toBeNull();
    expect(parseTokenHash('#token=')).toBeNull();
    expect(parseTokenHash('#token=%20')).toBeNull();
    expect(parseTokenHash('#token=has+space')).toBeNull();
    expect(parseTokenHash(`#token=${'a'.repeat(513)}`)).toBeNull();
  });

  it('keeps the token in memory and appends it to fragment-bearing anchors only', () => {
    rememberAuthToken('secret');
    expect(withAuthHash('/findings/?id=1')).toBe('/findings/?id=1#token=secret');
    expect(withAuthHash('/findings/?id=1#section')).toBe('/findings/?id=1#section&token=secret');
    expect(withAuthHash('/findings/?id=1#token=other')).toBe('/findings/?id=1#token=other');
    expect(withAuthHash('relative/page')).toBe('relative/page');
    expect(authHeaders()).toEqual({ authorization: 'Bearer secret' });
    clearAuthToken();
    expect(withAuthHash('/findings/')).toBe('/findings/');
    expect(authHeaders()).toEqual({});
  });
});
