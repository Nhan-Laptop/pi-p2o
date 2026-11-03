'use client';
/**
 * planning_update.md P3 (§6.4): the static `/findings/` route. The page is only a shell: `index.json` carries the cross-run
 * aggregates, `?id=` selects one, and the screen joins the selected run file for the report-level evidence. Plain anchors keep
 * the static export free of a router and every internal link carries the launch token.
 */
import { useState } from 'react';
import type { DashboardIndexFile } from '../../lib/model';
import { DashboardFooter, DatasetHeader, ProvenanceStrip } from '../../components/DatasetHeader';
import { ErrorPanel, LoadingLine } from '../../components/States';
import { WarningsList } from '../../components/WarningsList';
import { FindingsScreen } from '../../components/FindingsScreen';
import { useJson } from '../../lib/use-json';

export default function FindingsPage() {
  const index = useJson<DashboardIndexFile>('/index.json');
  const [refreshTick, setRefreshTick] = useState(0);
  const data = index.data;
  const refresh = (): void => { index.reload(); setRefreshTick(value => value + 1); };
  return (
    <main className="app findings-app">
      <DatasetHeader index={data} view="findings" onRefresh={refresh} />
      <ProvenanceStrip index={data} />
      {index.status === 'error' ? <ErrorPanel label="index.json" message={index.error} unauthorized={index.unauthorized} onRetry={refresh} /> : null}
      {index.status === 'loading' && !data ? <LoadingLine>reading /index.json…</LoadingLine> : null}
      {data ? <FindingsScreen index={data} refreshTick={refreshTick} refreshSeconds={index.refreshSeconds} /> : null}
      {data ? <WarningsList warnings={data.warnings} /> : null}
      <DashboardFooter index={data} />
    </main>
  );
}
