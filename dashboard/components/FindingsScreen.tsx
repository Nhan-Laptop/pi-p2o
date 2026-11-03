'use client';
/**
 * planning_update.md P3 (§6.4): the cross-run findings ledger. Filtering, sorting and paging happen in the browser over the
 * bounded `index.json` aggregate list; the selected row joins its run file for the full evidence. All navigation is a plain
 * anchor, and every link keeps the launch token in the URL fragment.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DashboardFindingAggregate, DashboardIndexFile } from '../lib/model';
import { EmptyState } from './States';
import { FindingDetail } from './FindingDetail';
import {
  buildFindingsSearch, DEFAULT_FINDINGS_FILTERS, distinctValues, filterAggregates, findingsCsv, findingsFilename,
  findingsJson, findingsTiles, filtersActive, paginate, parseFindingsQuery, selectAggregate, sortAggregates,
  CURRENTNESS_FILTERS, FINDINGS_PAGE_SIZE, FINDINGS_SORTS, REVIEW_FILTERS, SEVERITY_FILTERS, SOURCE_FILTERS,
  VERDICT_FILTERS, type FindingsFilters, type FindingsSort,
} from '../lib/findings';
import { withAuthHash } from '../lib/auth';
import { useAuthToken, useQueryValue } from '../lib/use-json';
import { clamp, formatTime, plural, SEVERITY_ORDER, severityLabel, shortId, sourceLabel } from '../lib/format';

export interface FindingsScreenProps {
  index: DashboardIndexFile;
  refreshTick: number;
  refreshSeconds: number;
}

const SEVERITY_CLASS: Readonly<Record<string, string>> = {
  critical: 'sev-critical', high: 'sev-high', medium: 'sev-medium', low: 'sev-low', informational: 'sev-informational', 'not rated': 'sev-not-rated',
};

const download = (name: string, mime: string, body: string): void => {
  if (typeof document === 'undefined') return;
  const blob = new Blob([body], { type: mime });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
};

const assetSummary = (aggregate: DashboardFindingAggregate): string => {
  const assets = distinctValues(aggregate.occurrences.flatMap(item => item.assets));
  if (!assets.length) return 'not recorded';
  const shown = assets.slice(0, 2).join(' ');
  return assets.length > 2 ? `${shown} +${assets.length - 2}` : shown;
};

const runsSummary = (aggregate: DashboardFindingAggregate): string =>
  aggregate.runs.length === 0 ? 'not recorded' : `${shortId(aggregate.runs[0]!, 18)}${aggregate.runs.length > 1 ? ` +${aggregate.runs.length - 1}` : ''}`;

const sourcesSummary = (aggregate: DashboardFindingAggregate): string =>
  distinctValues(aggregate.occurrences.map(item => item.source)).map(sourceLabel).join(' + ') || 'not recorded';

export function FindingsScreen({ index, refreshTick, refreshSeconds }: FindingsScreenProps) {
  // The token state is unused directly; reading it re-renders the links once the fragment has been captured.
  useAuthToken();
  const requestedId = useQueryValue('id');
  const [filters, setFilters] = useState<FindingsFilters>(DEFAULT_FINDINGS_FILTERS);
  const [sort, setSort] = useState<FindingsSort>('severity');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const parsed = parseFindingsQuery(window.location.search);
    setFilters(parsed.filters);
    setSort(parsed.sort);
    setPage(parsed.page);
  }, []);

  useEffect(() => { setSelectedId(requestedId); }, [requestedId]);

  const runs = index.runs;
  const filtered = useMemo(() => sortAggregates(filterAggregates(index.findings, filters, runs), sort), [index.findings, filters, runs, sort]);
  const paged = useMemo(() => paginate(filtered, page), [filtered, page]);
  const tiles = useMemo(() => findingsTiles(index), [index]);
  const selected = selectAggregate(index.findings, selectedId);
  const targets = useMemo(() => distinctValues(runs.map(run => run.target)), [runs]);
  const runOptions = useMemo(() => [...runs].sort((left, right) => left.runId.localeCompare(right.runId)), [runs]);

  const urlFor = (nextFilters: FindingsFilters, nextSort: FindingsSort, nextPage: number, nextId: string | null): string => {
    const search = buildFindingsSearch({ filters: nextFilters, sort: nextSort, page: nextPage, id: nextId });
    return withAuthHash(`/findings/${search}`);
  };
  const writeUrl = (nextFilters: FindingsFilters, nextSort: FindingsSort, nextPage: number, nextId: string | null): void => {
    if (typeof window === 'undefined') return;
    const search = buildFindingsSearch({ filters: nextFilters, sort: nextSort, page: nextPage, id: nextId });
    window.history.replaceState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
  };
  const changeFilter = (key: keyof FindingsFilters, value: string): void => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    setPage(1);
    setSelectedId(null);
    writeUrl(next, sort, 1, null);
  };
  const clearFilters = (): void => {
    setFilters(DEFAULT_FINDINGS_FILTERS);
    setPage(1);
    setSelectedId(null);
    writeUrl(DEFAULT_FINDINGS_FILTERS, sort, 1, null);
  };
  const changeSort = (value: FindingsSort): void => {
    setSort(value);
    setPage(1);
    writeUrl(filters, value, 1, selectedId);
  };
  const changePage = (value: number): void => {
    const next = Math.min(paged.pageCount, Math.max(1, value));
    setPage(next);
    writeUrl(filters, sort, next, selectedId);
  };
  const closeDetail = (): void => {
    setSelectedId(null);
    writeUrl(filters, sort, page, null);
  };
  const detailHref = (id: string): string => urlFor(filters, sort, page, id);
  const backHref = urlFor(filters, sort, page, null);
  const exportView = (kind: 'csv' | 'json'): void => {
    const name = findingsFilename(kind, index.generatedAt, filters, sort);
    if (kind === 'csv') download(name, 'text/csv;charset=utf-8', findingsCsv(filtered));
    else download(name, 'application/json;charset=utf-8', findingsJson(filtered, { generatedAt: index.generatedAt, filters, sort, total: filtered.length }));
  };

  return (
    <div className="findings-workspace">
      <section className="totals findings-tiles" aria-label="findings totals">
        <div className="total"><span className="total-value">{tiles.runs}</span><span className="total-label">runs involved</span></div>
        <div className="total"><span className="total-value">{tiles.total}</span><span className="total-label">findings in the snapshot</span></div>
        <div className="total" title="listed findings with at least one accepted-current occurrence"><span className="total-value">{tiles.accepted}</span><span className="total-label">accepted-current</span></div>
        <div className="total" title="listed findings with no accepted-current occurrence"><span className="total-value">{tiles.pending}</span><span className="total-label">pending review</span></div>
        <div className="total" title="listed findings with at least one stale occurrence"><span className="total-value">{tiles.stale}</span><span className="total-label">stale</span></div>
        <div className="total" title="listed findings whose severity, title, policy or root cause differs across runs"><span className="total-value">{tiles.conflicts}</span><span className="total-label">conflicts</span></div>
      </section>

      <div className="findings-scope">
        <p>
          scope: a retained-store run lists every case in its run file; a report-only run contributes accepted-current findings only.
          A missing row is not a clean result. Accepted-current, pending review, stale and conflict counts cover the {plural(tiles.listed, 'listed aggregate')};
          the total and severity buckets come from the host&apos;s pre-cap totals. The header&apos;s accepted count counts accepted occurrences; the tile counts findings.
          {tiles.omitted ? ` ${plural(tiles.omitted, 'aggregate row')} were omitted by the snapshot cap.` : ''}
        </p>
        <p className="findings-poll" role="status">
          read at <span className="mono">{formatTime(index.generatedAt)}</span>; {refreshSeconds > 0 ? `polling every ${plural(refreshSeconds, 'second')}; use reload to refresh now` : 'polling is disabled by ?refresh=0; use reload to refresh now'}.
        </p>
      </div>

      <section className="severity findings-severity" aria-label="findings by severity">
        <h2>findings by severity (worst occurrence)</h2>
        <ul className="severity-ledger">
          {SEVERITY_ORDER.map(severity => (
            <li key={severity} className={`severity-row ${SEVERITY_CLASS[severity] ?? ''}`}>
              <span className="severity-name">{severityLabel(severity)}</span>
              <span className="severity-count">{tiles.bySeverity[severity] ?? 0}</span>
            </li>
          ))}
        </ul>
        <p className="ledger-note">“not rated” is a state, not a severity. A finding with no rating is counted only here.</p>
      </section>

      {selectedId !== null && selected === null ? (
        <EmptyState title="that finding is not in this reading">
          <p>The aggregate id from the URL is not in <span className="mono">index.json</span> any more — the run may have been replaced since the link was made. This absence is not a clean result.</p>
          <p><a href={backHref}>back to the findings table</a></p>
        </EmptyState>
      ) : null}
      {selected ? <FindingDetail aggregate={selected} index={index} refreshTick={refreshTick} backHref={backHref} onClose={closeDetail} /> : null}

      <section className="findings-controls" aria-label="findings filters">
        <div className="filter-grid">
          <label className="filter-field">severity
            <select value={filters.severity} onChange={event => changeFilter('severity', event.target.value)} aria-label="filter by severity">
              <option value="">any severity</option>
              {SEVERITY_FILTERS.map(value => <option key={value} value={value}>{severityLabel(value)}</option>)}
            </select>
          </label>
          <label className="filter-field">review status
            <select value={filters.review} onChange={event => changeFilter('review', event.target.value)} aria-label="filter by review status">
              <option value="">any review status</option>
              {REVIEW_FILTERS.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="filter-field">verdict
            <select value={filters.verdict} onChange={event => changeFilter('verdict', event.target.value)} aria-label="filter by verdict">
              <option value="">any verdict</option>
              {VERDICT_FILTERS.map(value => <option key={value} value={value}>{value.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <label className="filter-field">currentness
            <select value={filters.currentness} onChange={event => changeFilter('currentness', event.target.value)} aria-label="filter by currentness">
              <option value="">any currentness</option>
              {CURRENTNESS_FILTERS.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="filter-field">source
            <select value={filters.source} onChange={event => changeFilter('source', event.target.value)} aria-label="filter by source">
              <option value="">any source</option>
              {SOURCE_FILTERS.map(value => <option key={value} value={value}>{sourceLabel(value)}</option>)}
            </select>
          </label>
          <label className="filter-field">run
            <select value={filters.run} onChange={event => changeFilter('run', event.target.value)} aria-label="filter by run">
              <option value="">any run</option>
              {runOptions.map(run => <option key={run.runId} value={run.runId}>{run.runId}{run.target ? ` — ${clamp(run.target, 36)}` : ''}</option>)}
            </select>
          </label>
          <label className="filter-field">target
            <select value={filters.target} onChange={event => changeFilter('target', event.target.value)} aria-label="filter by target">
              <option value="">any target</option>
              {targets.map(target => <option key={target} value={target}>{target}</option>)}
            </select>
          </label>
          <label className="filter-field filter-text">title contains
            <input type="search" value={filters.text} maxLength={120} placeholder="free text" onChange={event => changeFilter('text', event.target.value)} aria-label="filter by title text" />
          </label>
          <label className="filter-field">sort
            <select value={sort} onChange={event => changeSort(event.target.value as FindingsSort)} aria-label="sort findings">
              {FINDINGS_SORTS.map(value => <option key={value} value={value}>{value === 'severity' ? 'severity (worst first)' : value === 'time' ? 'time (newest first)' : 'run'}</option>)}
            </select>
          </label>
        </div>
        <div className="filter-actions">
          <button type="button" className="button button-quiet" onClick={clearFilters} disabled={!filtersActive(filters)}>clear filters</button>
          <button type="button" className="button" onClick={() => exportView('csv')} aria-label="download the filtered findings as CSV">CSV</button>
          <button type="button" className="button" onClick={() => exportView('json')} aria-label="download the filtered findings as JSON">JSON</button>
        </div>
      </section>

      <section className="findings-table-section" aria-label="findings table">
        <div className="findings-table-head">
          <h2>findings</h2>
          <p className="counter" aria-live="polite">
            showing {paged.showingFrom}–{paged.showingTo} of {paged.total} filtered findings
            {' '}({plural(index.findings.length, 'listed aggregate')}; {plural(index.totals.findings, 'finding')} in the snapshot)
          </p>
        </div>
        {index.findings.length === 0 ? (
          <EmptyState title="no finding in this snapshot">
            <p>The dashboard read no accepted finding from any run. A report bundle that carries no <span className="mono">findings.json</span> also lands here; the warnings below say why.</p>
          </EmptyState>
        ) : paged.total === 0 ? (
          <EmptyState title="no finding matches these filters">
            <p>This is a filtered empty view, not a clean result. The snapshot itself lists {plural(index.findings.length, 'aggregate')}; clear the filters to read them.</p>
            <button type="button" className="button" onClick={clearFilters}>clear filters</button>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="run-table finding-table">
              <caption className="finding-caption">Every column is a committed value; “not recorded” is printed instead of a guess.</caption>
              <thead>
                <tr>
                  <th scope="col">severity</th>
                  <th scope="col">title</th>
                  <th scope="col">policy / root cause / CWE</th>
                  <th scope="col">verdict / review</th>
                  <th scope="col">currentness</th>
                  <th scope="col">assets</th>
                  <th scope="col">runs</th>
                  <th scope="col">source</th>
                  <th scope="col">time</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(aggregate => (
                  <tr key={aggregate.id} className={selectedId === aggregate.id ? 'is-selected' : undefined}>
                    <td><span className={`severity-tag ${SEVERITY_CLASS[aggregate.severity] ?? ''}`}>{severityLabel(aggregate.severity)}</span></td>
                    <td className="finding-title-cell">
                      <a href={detailHref(aggregate.id)} className="finding-title" aria-label={`open finding ${aggregate.title}`}>{aggregate.title}</a>
                      <span className="finding-id mono">{aggregate.identity === 'fallback' ? 'fallback id' : shortId(aggregate.id, 12)}</span>
                      {aggregate.conflicts.length ? (
                        <span
                          className="conflict-flag"
                          title={aggregate.conflicts.map(conflict => `${conflict.field}: ${conflict.values.map(value => `${value.runId}=${value.value ?? 'not recorded'}`).join(', ')}`).join('; ')}
                        >
                          {plural(aggregate.conflicts.length, 'conflict')}
                        </span>
                      ) : null}
                    </td>
                    <td className="mono wrap finding-taxonomy">
                      {distinctValues(aggregate.occurrences.map(item => item.policyKey)).join(' · ') || 'not recorded'}
                      <span className="dim">; {distinctValues(aggregate.occurrences.map(item => item.rootCauseKey)).join(' · ') || 'no root cause'}; </span>
                      {distinctValues(aggregate.occurrences.flatMap(item => item.cwe)).join(' ') || 'no CWE'}
                    </td>
                    <td>{distinctValues(aggregate.occurrences.map(item => item.verdict)).join(' · ')}<span className="dim"> / </span>{distinctValues(aggregate.occurrences.map(item => item.reviewStatus)).join(' · ')}</td>
                    <td>{distinctValues(aggregate.occurrences.map(item => item.currentness)).join(' · ')}</td>
                    <td className="mono wrap">{assetSummary(aggregate)}</td>
                    <td className="mono wrap" title={aggregate.runs.join(', ')}>{runsSummary(aggregate)}</td>
                    <td>{sourcesSummary(aggregate)}</td>
                    <td className="mono">{formatTime(aggregate.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {paged.pageCount > 1 ? (
          <nav className="pagination" aria-label="findings pages">
            <button type="button" className="button button-quiet" onClick={() => changePage(paged.page - 1)} disabled={paged.page <= 1}>previous</button>
            <span className="counter">page {paged.page} of {paged.pageCount} · {plural(FINDINGS_PAGE_SIZE, 'row')} per page</span>
            <button type="button" className="button button-quiet" onClick={() => changePage(paged.page + 1)} disabled={paged.page >= paged.pageCount}>next</button>
          </nav>
        ) : null}
        <p className="ledger-note">
          A row is an aggregate over (run, source) occurrences. Select its title to join the run file and read the full evidence.
          Store rows show every case; report rows are accepted-current only. A missing row is not a clean result.
        </p>
      </section>
    </div>
  );
}
