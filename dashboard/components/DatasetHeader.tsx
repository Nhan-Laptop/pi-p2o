'use client';
/**
 * planning_update.md P2/P3: the dataset header. The read time is the latest committed record time in the snapshot, never a wall
 * clock; the provenance strip repeats the projection, scope and redaction labels the data itself carries, so the page cannot
 * look more authoritative than the records behind it. P3 keeps the launch token across the plain full-page anchors in the
 * fragment.
 */
import type { DashboardIndexFile } from '../lib/model';
import { findingsHref, formatTime, plural, reportHref } from '../lib/format';
import { useAuthToken } from '../lib/use-json';
import { withAuthHash } from '../lib/auth';

export interface DatasetHeaderProps {
  index: DashboardIndexFile | null;
  view: 'overview' | 'graph' | 'findings' | 'report';
  currentRunId?: string | null;
  onRefresh?: () => void;
}

export function DatasetHeader({ index, view, currentRunId, onRefresh }: DatasetHeaderProps) {
  // Reading the token after mount keeps the prerendered markup token-free while the links pick it up immediately after.
  useAuthToken();
  const totals = index?.totals ?? null;
  const runsHref = withAuthHash('/');
  const findings = withAuthHash(findingsHref());
  const graph = currentRunId ? withAuthHash(`/graph/?run=${encodeURIComponent(currentRunId)}`) : null;
  const report = currentRunId ? withAuthHash(reportHref(currentRunId)) : null;
  return (
    <header className="app-header">
      <div className="masthead">
        <a className="masthead-mark" href={runsHref}>pi-p2o</a>
        <span className="masthead-sub">record dashboard</span>
      </div>
      <nav className="masthead-nav" aria-label="views">
        <a href={runsHref} className={view === 'overview' ? 'is-current' : undefined} aria-current={view === 'overview' ? 'page' : undefined}>runs</a>
        <a href={findings} className={view === 'findings' ? 'is-current' : undefined} aria-current={view === 'findings' ? 'page' : undefined}>findings</a>
        {graph ? (
          <a href={graph} className={view === 'graph' ? 'is-current' : undefined} aria-current={view === 'graph' ? 'page' : undefined}>graph</a>
        ) : null}
        {report ? (
          <a href={report} className={view === 'report' ? 'is-current' : undefined} aria-current={view === 'report' ? 'page' : undefined}>report</a>
        ) : null}
      </nav>
      <dl className="dataset-facts">
        <div><dt>read at</dt><dd>{index ? formatTime(index.generatedAt) : 'loading'}</dd></div>
        <div><dt>runs</dt><dd>{totals ? totals.runs : '—'}</dd></div>
        <div><dt>findings</dt><dd>{totals ? totals.findings : '—'}</dd></div>
        <div><dt>accepted</dt><dd>{totals ? totals.accepted : '—'}</dd></div>
      </dl>
      {onRefresh ? <button type="button" className="button button-quiet" onClick={onRefresh} aria-label="refresh the dataset now">reload</button> : null}
    </header>
  );
}

/** The behavioural labels travel with every page that renders records. */
export function ProvenanceStrip({ index }: { index: DashboardIndexFile | null }) {
  if (!index) return null;
  return (
    <div className="provenance" role="note" aria-label="provenance">
      <p><span className="provenance-key">projection</span>{index.labels.projection}</p>
      <p><span className="provenance-key">scope</span>{index.labels.scope}</p>
      <p><span className="provenance-key">handling</span>{index.labels.redaction}</p>
    </div>
  );
}

export function DashboardFooter({ index }: { index: DashboardIndexFile | null }) {
  if (!index) return null;
  return (
    <footer className="app-footer">
      <p>{index.labels.authority}.</p>
      <p>{index.labels.scope}.</p>
      <p className="footer-count">{plural(index.totals.runs, 'run')} read; nothing on this page was written back.</p>
    </footer>
  );
}
