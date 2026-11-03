'use client';
/**
 * planning_update.md P5a: one run's REPORT.md, shown as the exact retained text. The host kept the bytes and this screen is a
 * viewer: no markdown-to-HTML, no external link, no wall clock. Copy/download hand the text back unchanged; the contents list
 * scrolls to a heading's own line rather than replacing the token fragment with a `#anchor` href. An absent body is stated with
 * the run's own warnings, never rendered as an empty-looking report.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { DASHBOARD_LIMITS, type DashboardRunFile, type DashboardRunSummary, type DashboardWarning } from '../lib/model';
import { reportOutline, reportStats } from '../lib/report';
import { EmptyState } from './States';
import { withAuthHash } from '../lib/auth';
import { clamp, findingsHref, formatTime, graphHref, plural, reportHref, shortId } from '../lib/format';

export interface ReportScreenProps {
  file: DashboardRunFile;
  runs: DashboardRunSummary[];
  /** index-level warnings naming this run (or the root); they explain a missing or unreadable report body. */
  warnings: DashboardWarning[];
}

const headingId = (line: number): string => `report-heading-${line}`;

const download = (name: string, body: string): void => {
  if (typeof document === 'undefined') return;
  const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
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

export function ReportScreen({ file, runs, warnings }: ReportScreenProps) {
  const run = file.run;
  const report = file.report ?? null;
  const outline = useMemo(() => reportOutline(report?.text ?? ''), [report]);
  const stats = useMemo(() => reportStats(report?.text ?? ''), [report]);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // One <pre> keeps the bytes' own whitespace; only the heading lines become spans, so the contents list has real scroll targets.
  const body = useMemo<ReactNode[] | null>(() => {
    if (!report) return null;
    const lines = report.text.split('\n');
    const headingAt = new Map(outline.map(heading => [heading.line, heading] as const));
    return lines.map((line, index) => {
      const suffix = index === lines.length - 1 ? '' : '\n';
      const heading = headingAt.get(index + 1);
      return heading
        ? <span key={`line-${index}`} id={headingId(heading.line)} className="report-heading-line" title={`line ${heading.line}`}>{line}{suffix}</span>
        : `${line}${suffix}`;
    });
  }, [report, outline]);

  const copy = async (): Promise<void> => {
    if (!report) return;
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(report.text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const explanation = [
    ...warnings.map(warning => ({ code: warning.code, detail: warning.detail })),
    ...run.warnings.map(warning => ({ code: warning, detail: null })),
  ];

  return (
    <div className="report-workspace">
      <aside className="report-aside" aria-label="report navigation">
        {runs.length > 1 ? (
          <section className="rail-block">
            <h2>run</h2>
            <ul className="run-switch">
              {runs.map(candidate => (
                <li key={candidate.runId}>
                  <a
                    href={withAuthHash(reportHref(candidate.runId))}
                    className={candidate.runId === run.runId ? 'is-current' : undefined}
                    aria-current={candidate.runId === run.runId ? 'page' : undefined}
                  >
                    <span className="mono">{shortId(candidate.runId, 18)}</span>
                    <span className="run-target">{candidate.target ? clamp(candidate.target, 28) : candidate.hasReport ? 'no recorded target' : 'no report body'}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {report ? (
          <section className="rail-block">
            <h2>contents</h2>
            {outline.length ? (
              <>
                <ol className="report-toc-list">
                  {outline.map(heading => (
                    <li key={heading.line} style={{ paddingLeft: `${6 + (heading.level - 1) * 9}px` }}>
                      <button
                        type="button"
                        className="link-button"
                        title={`scroll to line ${heading.line}`}
                        onClick={() => {
                          if (typeof document !== 'undefined') document.getElementById(headingId(heading.line))?.scrollIntoView({ block: 'start' });
                        }}
                      >
                        {heading.title}
                      </button>
                    </li>
                  ))}
                </ol>
                {stats.headings > outline.length ? (
                  <p className="rail-note">showing the first {outline.length} of {plural(stats.headings, 'heading')}; the body below is complete.</p>
                ) : null}
              </>
            ) : (
              <p className="rail-note">This report carries no ATX heading outside its code blocks, so there is no contents list.</p>
            )}
          </section>
        ) : null}
      </aside>

      <div className="report-main">
        <section aria-label="report metadata">
          <dl className="rail-facts report-meta">
            <div><dt>run</dt><dd className="mono">{run.runId}</dd></div>
            <div><dt>target</dt><dd>{run.target ?? 'not recorded'}</dd></div>
            <div><dt>state</dt><dd>{run.live ? 'open at the read sequence' : `finished (${run.endReason ?? 'reason not recorded'})`}</dd></div>
            {report ? (
              <>
                <div><dt>origin</dt><dd>{report.origin === 'bundle'
                  ? 'bundle export (byte-identical)'
                  : 'rendered from committed records with default settings — may differ from a CLI export'}</dd></div>
                <div><dt>export equivalent</dt><dd>{report.exportEquivalent ? 'yes: the CLI export is byte-identical' : 'no: a CLI export may differ'}</dd></div>
                <div><dt>size</dt><dd>{report.bytes} bytes · {plural(stats.lines, 'line')}</dd></div>
                <div><dt>sha256</dt><dd className="mono" title={report.sha256}>{shortId(report.sha256, 14)}</dd></div>
                <div><dt>as of sequence</dt><dd>{report.asOfSequence ?? 'not recorded'}</dd></div>
                <div><dt>last record</dt><dd>{formatTime(run.lastRecordAt)}</dd></div>
              </>
            ) : (
              <>
                <div><dt>records</dt><dd>{run.records} committed; sequence {run.sequence ?? 'not recorded'}</dd></div>
                <div><dt>last record</dt><dd>{formatTime(run.lastRecordAt)}</dd></div>
              </>
            )}
          </dl>
          {report && report.origin === 'store' && !report.exportEquivalent ? (
            <p className="ledger-note">
              This body is the host&apos;s own rendering of committed records with default settings; a CLI export can differ in operator
              fields, pinned WSTG pages, runtime version and draft/final wording. The sha256 above is this body&apos;s, not the CLI export&apos;s.
            </p>
          ) : null}
        </section>

        {report ? (
          <>
            <div className="report-actions">
              <button type="button" className="button" onClick={() => void copy()}>copy REPORT.md</button>
              <button type="button" className="button" onClick={() => download(`${run.runId}-REPORT.md`, report.text)}>download .md</button>
              <span className="report-status" role="status" aria-live="polite">
                {copyState === 'copied' ? 'copied to clipboard' : copyState === 'failed' ? 'copy failed — select the text below and copy it' : null}
              </span>
            </div>
            <pre className="report-body">{body}</pre>
            <p className="ledger-note">
              Exact retained text, shown as a viewer, not a renderer: markdown is not converted and no link in it is followed. The
              download saves these bytes as <span className="mono">{run.runId}-REPORT.md</span>.
            </p>
          </>
        ) : (
          <EmptyState title="this run has no REPORT.md body">
            <p>
              The snapshot kept no bounded report for this run, so the tab shows nothing instead of guessing. A body is absent when the
              run produced none (<code>report-no-report</code>) or when it was larger than the{' '}
              <span className="mono">{(DASHBOARD_LIMITS.reportBytes / (1024 * 1024)).toFixed(0)} MiB</span> bound and was omitted as{' '}
              <code>report-too-large</code> rather than clipped; unreadable or mismatched report files are labelled{' '}
              <code>report-file-*</code>.
            </p>
            <p>
              The committed records are still readable in the run&apos;s <a href={withAuthHash(graphHref(run.runId))}>graph</a> and the{' '}
              <a href={withAuthHash(findingsHref())}>findings ledger</a>.
            </p>
            {explanation.length ? (
              <ul className="notes">
                {explanation.map((warning, index) => (
                  <li key={`${warning.code}-${index}`}>
                    <code className="warning-code">{warning.code}</code>
                    {warning.detail ? <span className="warning-detail"> {warning.detail}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ledger-note">The reading recorded no warning that explains the absence; absence is not a clean result.</p>
            )}
          </EmptyState>
        )}
      </div>
    </div>
  );
}
