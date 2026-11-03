'use client';
/**
 * planning_update.md P5a: the static `/report/` route. Static export, so the run is chosen by the `run` query value (defaulting
 * to the first run that actually carries a report) and every link is a plain full-page anchor; the page fetches `index.json`
 * then one `runs/<runId>.json`. It never reads a clock: the metadata strip shows the committed sequence and record time only.
 */
import { useMemo } from 'react';
import type { DashboardIndexFile, DashboardRunFile } from '../../lib/model';
import { DashboardFooter, DatasetHeader, ProvenanceStrip } from '../../components/DatasetHeader';
import { EmptyState, ErrorPanel, LoadingLine } from '../../components/States';
import { WarningsList } from '../../components/WarningsList';
import { ReportScreen } from '../../components/ReportScreen';
import { useJson, useQueryValue } from '../../lib/use-json';

export default function ReportPage() {
  const requested = useQueryValue('run');
  const index = useJson<DashboardIndexFile>('/index.json');
  const runs = index.data?.runs ?? [];
  // Prefer a run whose file really carries a report body; fall back to the first run so the empty state can explain itself.
  const preferred = runs.find(run => run.hasReport) ?? runs[0];
  const runId = requested ?? preferred?.runId ?? null;
  const runFile = useJson<DashboardRunFile>(runId ? `/runs/${encodeURIComponent(runId)}.json` : null);
  const warnings = useMemo(
    () => (index.data?.warnings ?? []).filter(warning => !warning.runId || warning.runId === runId),
    [index.data, runId],
  );
  const defaultLabel = requested ? '' : preferred?.hasReport ? ' (first run with a report)' : ' (first run in the snapshot)';

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
      {runFile.data ? <ReportScreen key={runFile.data.runId} file={runFile.data} runs={runs} warnings={warnings} /> : null}
      {runId !== null && runFile.status === 'loading' ? (
        <LoadingLine>reading <span className="mono">{`/runs/${runId}.json`}</span>…{defaultLabel}</LoadingLine>
      ) : null}
      <WarningsList warnings={index.data?.warnings ?? []} />
      <DashboardFooter index={index.data} />
    </main>
  );
}
