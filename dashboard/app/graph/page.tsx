'use client';
/**
 * planning_update.md P2: the graph page. Static export, so the run is chosen by the `run` query value and every link is a
 * plain full-page anchor; the page fetches `index.json` then one `runs/<runId>.json`.
 */
import type { DashboardIndexFile, DashboardRunFile } from '../../lib/model';
import { DashboardFooter, DatasetHeader, ProvenanceStrip } from '../../components/DatasetHeader';
import { EmptyState, ErrorPanel, LoadingLine } from '../../components/States';
import { GraphScreen } from '../../components/GraphScreen';
import { useJson, useQueryValue } from '../../lib/use-json';

export default function GraphPage() {
  const requested = useQueryValue('run');
  const index = useJson<DashboardIndexFile>('/index.json');
  const runs = index.data?.runs ?? [];
  const runId = requested ?? runs[0]?.runId ?? null;
  const runFile = useJson<DashboardRunFile>(runId ? `/runs/${encodeURIComponent(runId)}.json` : null);

  return (
    <main className="app graph-app">
      <DatasetHeader index={index.data} view="graph" currentRunId={runId} onRefresh={index.reload} />
      <ProvenanceStrip index={index.data} />
      {index.status === 'error' ? <ErrorPanel label="index.json" message={index.error} onRetry={index.reload} /> : null}
      {index.status === 'ready' && runId === null ? (
        <EmptyState title="this snapshot holds no run">
          <p>Write a snapshot from a state root that holds a committed assessment, or from an exported report bundle, then open this page again.</p>
        </EmptyState>
      ) : null}
      {runFile.status === 'error' ? <ErrorPanel label={runId ? `run ${runId}` : 'run file'} message={runFile.error} onRetry={runFile.reload} /> : null}
      {runFile.data ? <GraphScreen key={runFile.data.runId} file={runFile.data} runs={runs} labels={index.data?.labels ?? null} /> : null}
      {runId !== null && runFile.status === 'loading' ? (
        <LoadingLine>reading <span className="mono">{`/runs/${runId}.json`}</span>…{requested ? '' : ' (first run in the snapshot)'}</LoadingLine>
      ) : null}
      <DashboardFooter index={index.data} />
    </main>
  );
}
