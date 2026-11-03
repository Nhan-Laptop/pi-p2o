'use client';
/**
 * planning_update.md P5a/P5b: the static `/report/` route. Static export, so the run is chosen by the `run` query value and the
 * view by `view`; every link is a plain full-page anchor that keeps the run and the operator's refresh rate. The structured facts
 * view is the default when the run file carries them (store runs), and the exact-text view of REPORT.md is always one click away
 * and remains the authority. The page never reads a clock: the metadata and facts show committed sequences and record times only.
 */
import { useMemo } from 'react';
import type { DashboardIndexFile, DashboardRunFile } from '../../lib/model';
import { DashboardFooter, DatasetHeader, ProvenanceStrip } from '../../components/DatasetHeader';
import { EmptyState, ErrorPanel, LoadingLine } from '../../components/States';
import { WarningsList } from '../../components/WarningsList';
import { ReportScreen } from '../../components/ReportScreen';
import { ReportFactsScreen } from '../../components/ReportFactsScreen';
import { reportView, reportViewHref } from '../../lib/report';
import { withAuthHash } from '../../lib/auth';
import { useJson, useQueryValue } from '../../lib/use-json';

export default function ReportPage() {
  const requested = useQueryValue('run');
  const requestedView = useQueryValue('view');
  const refreshParam = useQueryValue('refresh');
  const index = useJson<DashboardIndexFile>('/index.json');
  const runs = index.data?.runs ?? [];
  // A run with structured facts first (the default view needs them), then one with a report body, then the first run at all.
  const preferred = runs.find(run => run.hasFacts) ?? runs.find(run => run.hasReport) ?? runs[0];
  const runId = requested ?? preferred?.runId ?? null;
  const runFile = useJson<DashboardRunFile>(runId ? `/runs/${encodeURIComponent(runId)}.json` : null);
  const warnings = useMemo(
    () => (index.data?.warnings ?? []).filter(warning => !warning.runId || warning.runId === runId),
    [index.data, runId],
  );
  const facts = runFile.data?.reportFacts ?? null;
  const view = reportView(requestedView, facts !== null);
  const structuredMissing = requestedView === 'structured' && runFile.data !== null && facts === null;
  const defaultLabel = requested ? '' : preferred?.hasFacts ? ' (first run with structured facts)' : preferred?.hasReport ? ' (first run with a report)' : ' (first run in the snapshot)';

  return (
    <main className="app report-app">
      <DatasetHeader index={index.data} view="report" currentRunId={runId} onRefresh={index.reload} />
      <ProvenanceStrip index={index.data} />
      {index.status === 'error' ? <ErrorPanel label="index.json" message={index.error} unauthorized={index.unauthorized} onRetry={index.reload} /> : null}
      {index.status === 'ready' && runId === null ? (
        <EmptyState title="this snapshot holds no run">
          <p>Write a snapshot from a state root that holds a committed assessment, or from an exported report bundle, then open this page again.</p>
        </EmptyState>
      ) : null}
      {runFile.status === 'error' ? <ErrorPanel label={runId ? `run ${runId}` : 'run file'} message={runFile.error} unauthorized={runFile.unauthorized} onRetry={runFile.reload} /> : null}
      {runFile.data ? (
        <nav className="report-view-switch" aria-label="report view">
          {runFile.data.reportFacts ? (
            <a
              href={withAuthHash(reportViewHref(runFile.data.runId, 'structured', refreshParam))}
              className={view === 'structured' ? 'is-current' : undefined}
              aria-current={view === 'structured' ? 'page' : undefined}
            >
              structured
            </a>
          ) : null}
          <a
            href={withAuthHash(reportViewHref(runFile.data.runId, 'text', refreshParam))}
            className={view === 'text' ? 'is-current' : undefined}
            aria-current={view === 'text' ? 'page' : undefined}
          >
            exact text
          </a>
          <span className="dim">structured facts are derived from the committed rows; the exact-text document is the authority</span>
        </nav>
      ) : null}
      {structuredMissing ? (
        <EmptyState title="structured facts are not retained for this run">
          <p>
            Structured report facts are only kept for runs read from a store. A report bundle carries the document and its findings,
            not the P5b facts; a store run whose facts exceeded the payload bound carries only the <code>report-facts-too-large</code>{' '}
            warning. The exact-text view shows the report itself.
          </p>
          <p>
            <a href={withAuthHash(reportViewHref(runId ?? '', 'text', refreshParam))}>open the exact-text view</a>
          </p>
        </EmptyState>
      ) : null}
      {!structuredMissing && runFile.data && view === 'structured' && facts ? (
        <ReportFactsScreen key={runFile.data.runId} facts={facts} runs={runs} currentRunId={runFile.data.runId} />
      ) : null}
      {!structuredMissing && runFile.data && view === 'text' ? (
        <ReportScreen key={runFile.data.runId} file={runFile.data} runs={runs} warnings={warnings} />
      ) : null}
      {runId !== null && runFile.status === 'loading' ? (
        <LoadingLine>reading <span className="mono">{`/runs/${runId}.json`}</span>…{defaultLabel}</LoadingLine>
      ) : null}
      <WarningsList warnings={index.data?.warnings ?? []} />
      <DashboardFooter index={index.data} />
    </main>
  );
}
