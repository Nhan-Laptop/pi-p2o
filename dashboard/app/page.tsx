'use client';
/**
 * planning_update.md P2: the overview page. It lists runs and countable facts from `index.json`; the findings screen with
 * report-level evidence is P3, so this page shows counts and says where the detail lives.
 */
import type { DashboardIndexFile } from '../lib/model';
import { DashboardFooter, DatasetHeader, ProvenanceStrip } from '../components/DatasetHeader';
import { EmptyState, ErrorPanel, LoadingLine } from '../components/States';
import { WarningsList } from '../components/WarningsList';
import { useJson } from '../lib/use-json';
import { clamp, formatTime, graphHref, plural, retentionLabel, RUN_CLOSED_LABEL, RUN_OPEN_LABEL, SEVERITY_ORDER, severityLabel, sourceLabel } from '../lib/format';

export default function OverviewPage() {
  const index = useJson<DashboardIndexFile>('/index.json');
  const data = index.data;
  return (
    <main className="app">
      <DatasetHeader index={data} view="overview" onRefresh={index.reload} />
      <ProvenanceStrip index={data} />
      {index.status === 'error' ? <ErrorPanel label="index.json" message={index.error} onRetry={index.reload} /> : null}
      {index.status === 'loading' && !data ? <LoadingLine>reading /index.json…</LoadingLine> : null}
      {data ? <Overview index={data} /> : null}
      {data ? <WarningsList warnings={data.warnings} /> : null}
      <DashboardFooter index={data} />
    </main>
  );
}

function Overview({ index }: { index: DashboardIndexFile }) {
  return (
    <>
      <section className="totals" aria-label="dataset totals">
        <div className="total"><span className="total-value">{index.totals.runs}</span><span className="total-label">runs read</span></div>
        <div className="total"><span className="total-value">{index.totals.findings}</span><span className="total-label">findings across runs</span></div>
        <div className="total"><span className="total-value">{index.totals.accepted}</span><span className="total-label">accepted-current</span></div>
        <div className="total"><span className="total-value">{index.generatedAt ? formatTime(index.generatedAt).slice(0, 10) : '—'}</span><span className="total-label">latest record day</span></div>
      </section>

      <section className="severity" aria-label="findings by severity">
        <h2>findings by severity</h2>
        <ul className="severity-ledger">
          {SEVERITY_ORDER.map(severity => (
            <li key={severity} className={`severity-row sev-${severity.replace(/\s+/g, '-')}`}>
              <span className="severity-name">{severityLabel(severity)}</span>
              <span className="severity-count">{index.totals.bySeverity[severity] ?? 0}</span>
            </li>
          ))}
        </ul>
        <p className="ledger-note">“not rated” is a state, not a severity. Findings are accepted-current only, exactly as the report projects them; every case is listed per run in the graph view.</p>
      </section>

      <section className="runs" aria-label="runs">
        <h2>runs</h2>
        {index.runs.length === 0 ? (
          <EmptyState title="no committed run in this snapshot">
            <p>Point the snapshot at a state root that holds an assessment, or at an exported report bundle:</p>
            <pre className="command">node dist/src/dashboard/main.js snapshot --state-root /abs/.p2o-state --out /abs/new-directory</pre>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="run-table">
              <thead>
                <tr>
                  <th scope="col">run</th>
                  <th scope="col">target</th>
                  <th scope="col">source</th>
                  <th scope="col" className="num">records</th>
                  <th scope="col" className="num">cases</th>
                  <th scope="col" className="num">accepted</th>
                  <th scope="col">last record</th>
                  <th scope="col">state</th>
                </tr>
              </thead>
              <tbody>
                {index.runs.map(run => (
                  <tr key={run.runId}>
                    <td className="mono"><a href={graphHref(run.runId)}>{run.runId}</a></td>
                    <td>{run.target ? clamp(run.target, 48) : <span className="dim">not recorded</span>}</td>
                    <td>{sourceLabel(run.source)}<span className="dim">; {retentionLabel(run.retention)}</span></td>
                    <td className="num">{run.records}</td>
                    <td className="num">{run.counts.cases}</td>
                    <td className="num">{run.counts.findingsAccepted}</td>
                    <td className="mono">{formatTime(run.lastRecordAt)}</td>
                    <td>{run.live ? RUN_OPEN_LABEL : RUN_CLOSED_LABEL}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {index.runs.length ? <p className="ledger-note">Open a row&apos;s run id to see its graph. {plural(index.runs.filter(run => run.live).length, 'run')} still open at the read sequence.</p> : null}
      </section>
    </>
  );
}
