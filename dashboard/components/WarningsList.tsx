'use client';
/** planning_update.md P2: bounded read-model warnings. A short page is labelled, never presented as a complete one. */
import type { DashboardWarning } from '../lib/model';

export function WarningsList({ warnings, title }: { warnings: DashboardWarning[]; title?: string }) {
  if (!warnings.length) return null;
  return (
    <section className="warnings" aria-label={title ?? 'warnings'}>
      <h2>{title ?? `warnings (${warnings.length})`}</h2>
      <ul>
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${warning.runId ?? 'root'}-${index}`}>
            <code className="warning-code">{warning.code}</code>
            <span className="warning-detail">{warning.detail}</span>
            {warning.runId ? <span className="warning-meta">run {warning.runId}</span> : null}
            {warning.file ? <span className="warning-meta">{warning.file}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
