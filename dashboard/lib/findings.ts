/**
 * planning_update.md P3 (§6.4): the findings screen's pure logic — filters, sort, paging, tiles, evidence joins and the
 * in-memory export. No React and no browser object lives here, so `dashboard/test/findings.test.ts` can pin the rules the
 * screen renders without a DOM.
 *
 * The screen is a view over `index.json` aggregates joined (only for the selected row) with the per-run file. Everything a
 * filter can count is taken from data the host wrote; a value the contract does not carry is shown as "not recorded", never
 * guessed.
 */
import type {
  DashboardCaseRow, DashboardFindingAggregate, DashboardFindingRow, DashboardIndexFile, DashboardOccurrence,
  DashboardRunFile, DashboardRunSummary,
} from './model';
import { queryValue, SEVERITY_ORDER } from './format';

export const FINDINGS_PAGE_SIZE = 25;
export const FINDINGS_TEXT_MAX = 120;

export const SEVERITY_FILTERS = [...SEVERITY_ORDER] as readonly string[];
export const REVIEW_FILTERS = ['pending', 'accepted', 'disputed', 'withdrawn'] as const;
export const VERDICT_FILTERS = ['open', 'confirmed', 'ruled_out', 'inconclusive'] as const;
export const CURRENTNESS_FILTERS = ['current', 'stale', 'unknown', 'withdrawn'] as const;
export const SOURCE_FILTERS = ['store', 'report'] as const;
export const FINDINGS_SORTS = ['severity', 'time', 'run'] as const;
export type FindingsSort = typeof FINDINGS_SORTS[number];

export interface FindingsFilters {
  severity: string;
  review: string;
  verdict: string;
  currentness: string;
  source: string;
  run: string;
  target: string;
  text: string;
}

export const DEFAULT_FINDINGS_FILTERS: FindingsFilters = {
  severity: '', review: '', verdict: '', currentness: '', source: '', run: '', target: '', text: '',
};

export interface FindingsQuery {
  filters: FindingsFilters;
  sort: FindingsSort;
  page: number;
  id: string | null;
}

const oneOf = (value: string | null, allowed: readonly string[]): string =>
  value !== null && allowed.includes(value) ? value : '';

const bounded = (value: string | null, max: number): string => {
  if (value === null) return '';
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
};

/** Read the whole findings route state from a search string; unknown or out-of-range values fall back to the defaults. */
export function parseFindingsQuery(search: string): FindingsQuery {
  const pageRaw = queryValue(search, 'page');
  const page = pageRaw !== null && /^[0-9]{1,7}$/.test(pageRaw) ? Math.min(100000, Math.max(1, Number(pageRaw))) : 1;
  const sortRaw = queryValue(search, 'sort');
  const sort = (FINDINGS_SORTS as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as FindingsSort) : 'severity';
  return {
    filters: {
      severity: oneOf(queryValue(search, 'severity'), SEVERITY_FILTERS),
      review: oneOf(queryValue(search, 'review'), REVIEW_FILTERS),
      verdict: oneOf(queryValue(search, 'verdict'), VERDICT_FILTERS),
      currentness: oneOf(queryValue(search, 'currentness'), CURRENTNESS_FILTERS),
      source: oneOf(queryValue(search, 'source'), SOURCE_FILTERS),
      run: bounded(queryValue(search, 'run'), 200),
      target: bounded(queryValue(search, 'target'), 200),
      text: bounded(queryValue(search, 'q'), FINDINGS_TEXT_MAX),
    },
    sort,
    page,
    id: bounded(queryValue(search, 'id'), 200) || null,
  };
}

/** The inverse of `parseFindingsQuery`: defaults are omitted so the readable URL stays short and stable. */
export function buildFindingsSearch(query: FindingsQuery): string {
  const parts: string[] = [];
  const add = (name: string, value: string | null): void => { if (value !== null && value !== '') parts.push(`${name}=${encodeURIComponent(value)}`); };
  add('id', query.id);
  add('severity', query.filters.severity);
  add('review', query.filters.review);
  add('verdict', query.filters.verdict);
  add('currentness', query.filters.currentness);
  add('source', query.filters.source);
  add('run', query.filters.run);
  add('target', query.filters.target);
  add('q', query.filters.text);
  if (query.sort !== 'severity') add('sort', query.sort);
  if (query.page > 1) add('page', String(query.page));
  return parts.length ? `?${parts.join('&')}` : '';
}

export const filtersActive = (filters: FindingsFilters): boolean =>
  Object.entries(filters).some(([, value]) => value !== '');

const targetOf = (runs: readonly DashboardRunSummary[]): Map<string, string | null> =>
  new Map(runs.map(run => [run.runId, run.target]));

function matchesOccurrence(occurrences: readonly DashboardOccurrence[], predicate: (occurrence: DashboardOccurrence) => boolean): boolean {
  return occurrences.some(predicate);
}

/** AND of every active filter; the aggregate row is kept when any of its occurrences satisfies an occurrence-level filter. */
export function filterAggregates(
  aggregates: readonly DashboardFindingAggregate[],
  filters: FindingsFilters,
  runs: readonly DashboardRunSummary[],
): DashboardFindingAggregate[] {
  const targets = targetOf(runs);
  const text = filters.text.trim().toLowerCase();
  return aggregates.filter(aggregate => {
    if (filters.severity && aggregate.severity !== filters.severity) return false;
    if (filters.review && !matchesOccurrence(aggregate.occurrences, item => item.reviewStatus === filters.review)) return false;
    if (filters.verdict && !matchesOccurrence(aggregate.occurrences, item => item.verdict === filters.verdict)) return false;
    if (filters.currentness && !matchesOccurrence(aggregate.occurrences, item => item.currentness === filters.currentness)) return false;
    if (filters.source && !matchesOccurrence(aggregate.occurrences, item => item.source === filters.source)) return false;
    if (filters.run && !aggregate.runs.includes(filters.run)) return false;
    if (filters.target && !aggregate.runs.some(runId => (targets.get(runId) ?? null) === filters.target)) return false;
    if (text && !aggregate.title.toLowerCase().includes(text)) return false;
    return true;
  });
}

export const severityRank = (value: string | null): number => {
  const index = value === null ? -1 : SEVERITY_ORDER.indexOf(value as typeof SEVERITY_ORDER[number]);
  return index < 0 ? SEVERITY_ORDER.length : index;
};

const compareSeverityThenTitle = (left: DashboardFindingAggregate, right: DashboardFindingAggregate): number =>
  severityRank(left.severity) - severityRank(right.severity)
  || left.title.localeCompare(right.title)
  || left.id.localeCompare(right.id);

/** `time` is last seen, newest first, with `not recorded` last; `run` is the first run id, ascending. */
export function sortAggregates(aggregates: readonly DashboardFindingAggregate[], sort: FindingsSort): DashboardFindingAggregate[] {
  const rows = [...aggregates];
  if (sort === 'time') {
    rows.sort((left, right) => {
      if (left.lastSeen !== right.lastSeen) {
        if (left.lastSeen === null) return 1;
        if (right.lastSeen === null) return -1;
        return right.lastSeen.localeCompare(left.lastSeen);
      }
      return compareSeverityThenTitle(left, right);
    });
  } else if (sort === 'run') {
    rows.sort((left, right) => (left.runs[0] ?? '').localeCompare(right.runs[0] ?? '')
      || left.runs.length - right.runs.length || compareSeverityThenTitle(left, right));
  } else {
    rows.sort(compareSeverityThenTitle);
  }
  return rows;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  showingFrom: number;
  showingTo: number;
}

/** Explicit totals for the "showing X of Y" line; an out-of-range page is clamped rather than rendered empty. */
export function paginate<T>(items: readonly T[], page: number, pageSize = FINDINGS_PAGE_SIZE): Page<T> {
  const size = Math.max(1, Math.trunc(pageSize));
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pageCount, Math.max(1, Number.isSafeInteger(page) ? page : 1));
  const start = (current - 1) * size;
  const shown = items.slice(start, start + size);
  return {
    items: shown, page: current, pageCount, pageSize: size, total,
    showingFrom: total === 0 ? 0 : start + 1,
    showingTo: total === 0 ? 0 : start + shown.length,
  };
}

export function selectAggregate(aggregates: readonly DashboardFindingAggregate[], id: string | null): DashboardFindingAggregate | null {
  return id === null ? null : aggregates.find(aggregate => aggregate.id === id) ?? null;
}

export function distinctValues(values: readonly (string | null)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) if (value !== null) seen.add(value);
  return [...seen].sort((left, right) => left.localeCompare(right));
}

export interface FindingsTiles {
  runs: number;
  total: number;
  accepted: number;
  pending: number;
  stale: number;
  conflicts: number;
  listed: number;
  omitted: number;
  bySeverity: Record<string, number>;
}

/**
 * Tiles use only facts the index carries. `accepted`/`pending` are counts over the listed aggregates (a finding is
 * accepted-current when at least one occurrence is); the total and severity buckets come from the host's pre-cap totals,
 * so an omitted row is stated rather than silently changing the meaning of the number.
 */
export function findingsTiles(index: DashboardIndexFile): FindingsTiles {
  const accepted = index.findings.filter(aggregate => aggregate.accepted > 0).length;
  return {
    runs: index.totals.runs,
    total: index.totals.findings,
    accepted,
    pending: index.findings.length - accepted,
    stale: index.findings.filter(aggregate => aggregate.occurrences.some(item => item.currentness === 'stale')).length,
    conflicts: index.findings.filter(aggregate => aggregate.conflicts.length > 0).length,
    listed: index.findings.length,
    omitted: index.omitted.findings,
    bySeverity: index.totals.bySeverity,
  };
}

/** The run file's `findings[]` row for one index occurrence; `null` when the file is absent or the row was omitted. */
export function matchFindingRow(file: DashboardRunFile | undefined, occurrence: DashboardOccurrence): DashboardFindingRow | null {
  if (!file) return null;
  const byCase = file.findings.filter(row => row.caseId === occurrence.caseId && row.caseRevision === occurrence.caseRevision);
  if (occurrence.findingId !== null) {
    const byId = byCase.find(row => row.findingId === occurrence.findingId) ?? file.findings.find(row => row.findingId === occurrence.findingId);
    if (byId) return byId;
  }
  const byTitle = byCase.find(row => row.title === occurrence.title);
  return byTitle ?? byCase[0] ?? null;
}

/** The retained-store case row at exactly the occurrence revision; report-only runs have no case list. */
export function matchCaseRow(file: DashboardRunFile | undefined, occurrence: DashboardOccurrence): DashboardCaseRow | null {
  if (!file) return null;
  return file.cases.find(row => row.id === occurrence.caseId && row.revision === occurrence.caseRevision) ?? null;
}

export interface JoinedOccurrence {
  occurrence: DashboardOccurrence;
  fileLoaded: boolean;
  finding: DashboardFindingRow | null;
  caseRow: DashboardCaseRow | null;
}

export function joinOccurrenceEvidence(aggregate: DashboardFindingAggregate, files: ReadonlyMap<string, DashboardRunFile>): JoinedOccurrence[] {
  return aggregate.occurrences.map(occurrence => {
    const file = files.get(occurrence.runId);
    return { occurrence, fileLoaded: file !== undefined, finding: matchFindingRow(file, occurrence), caseRow: matchCaseRow(file, occurrence) };
  });
}

/** Full report evidence is shown once, from the first occurrence whose run file actually carries the row. */
export function evidenceOccurrence(joined: readonly JoinedOccurrence[]): JoinedOccurrence | null {
  return joined.find(item => item.finding !== null) ?? null;
}

const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const csvRow = (values: readonly unknown[]): string => values.map(csvCell).join(',');

export const FINDINGS_CSV_HEADER = [
  'id', 'identity', 'severity', 'title', 'runs', 'sources', 'accepted_occurrences', 'review_statuses', 'verdicts',
  'currentness', 'policy_key', 'root_cause_key', 'cwe', 'assets', 'first_seen', 'last_seen', 'conflicts', 'occurrences',
] as const;

/** One escaped row per aggregate; occurrence order is the index's deterministic order. */
export function findingsCsv(aggregates: readonly DashboardFindingAggregate[]): string {
  const lines = [csvRow(FINDINGS_CSV_HEADER)];
  for (const aggregate of aggregates) {
    const occurrences = aggregate.occurrences;
    lines.push(csvRow([
      aggregate.id,
      aggregate.identity,
      aggregate.severity,
      aggregate.title,
      aggregate.runs.join(' '),
      distinctValues(occurrences.map(item => item.source)).join(' '),
      aggregate.accepted,
      distinctValues(occurrences.map(item => item.reviewStatus)).join(' '),
      distinctValues(occurrences.map(item => item.verdict)).join(' '),
      distinctValues(occurrences.map(item => item.currentness)).join(' '),
      occurrences[0]?.policyKey ?? '',
      occurrences[0]?.rootCauseKey ?? '',
      distinctValues(occurrences.flatMap(item => item.cwe)).join(' '),
      distinctValues(occurrences.flatMap(item => item.assets)).join(' '),
      aggregate.firstSeen ?? '',
      aggregate.lastSeen ?? '',
      aggregate.conflicts.map(conflict => `${conflict.field}: ${conflict.values.map(value => `${value.runId}/${value.source}=${value.value ?? 'not recorded'}`).join(' | ')}`).join('; '),
      occurrences.map(item => `${item.runId}/${item.source}/${item.verdict}/${item.reviewStatus}/${item.currentness}`).join(' '),
    ]));
  }
  return `${lines.join('\n')}\n`;
}

export interface FindingsExportMeta {
  generatedAt: string | null;
  filters: FindingsFilters;
  sort: FindingsSort;
  total: number;
}

/** The aggregated view, in the same shape the screen holds; no server route is involved. */
export function findingsJson(aggregates: readonly DashboardFindingAggregate[], meta: FindingsExportMeta): string {
  return `${JSON.stringify({
    format: 'p2o-dashboard-findings', version: 1, generatedAt: meta.generatedAt,
    filters: meta.filters, sort: meta.sort, total: meta.total, rows: aggregates,
  }, null, 2)}\n`;
}

/** FNV-1a over the filter/sort signature; a short stable suffix so two exports do not overwrite each other. */
export function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const stamp = (value: string | null): string => {
  const digits = (value ?? '').replace(/[^0-9A-Za-z]/g, '');
  return digits.length ? digits.slice(0, 16) : 'undated';
};

export function findingsFilename(extension: 'csv' | 'json', generatedAt: string | null, filters: FindingsFilters, sort: FindingsSort): string {
  return `p2o-findings-${stamp(generatedAt)}-${stableHash(JSON.stringify({ filters, sort }))}.${extension}`;
}
