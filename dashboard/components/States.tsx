'use client';
/** planning_update.md P2: the three shell states a static page can be in while it fetches a snapshot file. */
import type { ReactNode } from 'react';

export function LoadingLine({ children }: { children: ReactNode }) {
  return <p className="loading" role="status">{children}</p>;
}

export function ErrorPanel({ label, message, onRetry, unauthorized }: { label: string; message: string | null; onRetry?: () => void; unauthorized?: boolean }) {
  return (
    <section className="panel panel-error" role="alert">
      <h2>{unauthorized ? `not authorized to read ${label}` : `could not read ${label}`}</h2>
      <p>{message ?? 'unknown error'}</p>
      {unauthorized
        ? <p className="panel-hint">The token is printed only in the URL the serve process wrote; this page keeps it in memory and never stores it. Reopen that URL, then reload this view.</p>
        : <p className="panel-hint">Snapshots are served from the directory the CLI wrote; check that the file exists and that the server is the one serving it.</p>}
      {onRetry ? <button type="button" className="button" onClick={onRetry}>try again</button> : null}
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel panel-empty">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
