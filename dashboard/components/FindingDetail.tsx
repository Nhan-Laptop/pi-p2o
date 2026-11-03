'use client';
/**
 * planning_update.md P3 (§6.4): one finding at the report's evidence detail. The aggregate comes from `index.json`; the full
 * block is joined from the selected run file, and every occurrence keeps its own provenance. A conflict is rendered as every
 * value with the run that said it — this panel never picks a winner.
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  DashboardArtifactRef, DashboardCaseRow, DashboardFindingAggregate, DashboardIndexFile, DashboardOccurrence, DashboardRunFile,
  FindingReproductionRow,
} from '../lib/model';
import {
  evidenceOccurrence, joinOccurrenceEvidence, type JoinedOccurrence,
} from '../lib/findings';
import { AUTH_REOPEN_MESSAGE } from '../lib/auth';
import { fetchJson, UnauthorizedError } from '../lib/use-json';
import { clamp, formatTime, plural, retentionLabel, severityLabel, sourceLabel } from '../lib/format';
import { ArtifactViewer } from './ArtifactViewer';

export interface FindingDetailProps {
  aggregate: DashboardFindingAggregate;
  index: DashboardIndexFile;
  refreshTick: number;
  backHref: string;
  onClose: () => void;
}

interface EvidenceState {
  status: 'loading' | 'ready';
  files: Map<string, DashboardRunFile>;
  errors: Map<string, string>;
  unauthorized: boolean;
}

const display = (value: unknown): string => {
  if (value === null || value === undefined) return 'not recorded';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'recorded (structured value)';
};

const yesNo = (value: boolean | null): string => value === null ? 'not recorded' : value ? 'yes' : 'no';

const unique = (values: readonly (string | null)[]): string => {
  const seen = new Set<string>();
  for (const value of values) if (value !== null && value !== '') seen.add(value);
  return seen.size ? [...seen].join(' · ') : 'not recorded';
};

function useEvidence(aggregate: DashboardFindingAggregate, refreshTick: number): EvidenceState & { retry: () => void } {
  const [state, setState] = useState<EvidenceState>({ status: 'loading', files: new Map(), errors: new Map(), unauthorized: false });
  const [nonce, setNonce] = useState(0);
  const runKey = aggregate.runs.join('|');
  // A poll that changes an occurrence (revision, barrier or committed time) refetches the run file; an identical poll does not.
  const revisionKey = aggregate.occurrences.map(item => `${item.runId}:${item.source}:${item.caseId}:${item.caseRevision}:${item.asOfSequence ?? ''}:${item.time ?? ''}`).join('|');
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', files: new Map(), errors: new Map(), unauthorized: false });
    const load = async (): Promise<void> => {
      const files = new Map<string, DashboardRunFile>();
      const errors = new Map<string, string>();
      let unauthorized = false;
      for (const runId of aggregate.runs) {
        try {
          files.set(runId, await fetchJson<DashboardRunFile>(`/runs/${encodeURIComponent(runId)}.json`));
        } catch (error) {
          if (error instanceof UnauthorizedError) {
            unauthorized = true;
            errors.set(runId, AUTH_REOPEN_MESSAGE);
            break;
          }
          errors.set(runId, error instanceof Error ? error.message : String(error));
        }
      }
      if (!cancelled) setState({ status: 'ready', files, errors, unauthorized });
    };
    void load();
    return () => { cancelled = true; };
    // `runKey` is the stable identity of the list; the same content from a poll must not refetch.
  }, [runKey, revisionKey, refreshTick, nonce]);
  return { ...state, retry: () => setNonce(value => value + 1) };
}

export function FindingDetail({ aggregate, index, refreshTick, backHref, onClose }: FindingDetailProps) {
  const evidence = useEvidence(aggregate, refreshTick);
  const joined = useMemo(() => joinOccurrenceEvidence(aggregate, evidence.files), [aggregate, evidence.files]);
  const source = evidenceOccurrence(joined);
  const finding = source?.finding ?? null;
  const runsById = useMemo(() => new Map(index.runs.map(run => [run.runId, run])), [index.runs]);
  const storeLayers = joined.filter(item => item.occurrence.source === 'store');
  const evidenceRun = source ? runsById.get(source.occurrence.runId) : undefined;

  return (
    <aside className="finding-detail" aria-label="finding detail">
      <header className="detail-head finding-detail-head">
        <span className={`finding-sev sev-${aggregate.severity.replace(/\s+/g, '-')}`}>{severityLabel(aggregate.severity)}</span>
        <h2>{aggregate.title}</h2>
        <button type="button" className="button button-quiet" onClick={onClose} aria-label="close finding detail">close</button>
      </header>
      <p className="detail-note">
        <a href={backHref}>back to the filtered table</a>{' · '}
        {aggregate.identity === 'fallback'
          ? 'identity fallback: these rows carry no host finding id, so they are grouped by target, policy, root cause and title.'
          : `host finding id ${aggregate.id}`}
      </p>

      <section className="finding-block" aria-label="aggregate facts">
        <h3>aggregate</h3>
        <dl className="detail-facts">
          <div><dt>id</dt><dd className="mono wrap">{aggregate.id}</dd></div>
          <div><dt>identity</dt><dd>{aggregate.identity === 'fallback' ? 'fallback (no host id)' : 'host finding id'}</dd></div>
          <div><dt>severity</dt><dd>{severityLabel(aggregate.severity)}</dd></div>
          <div><dt>runs</dt><dd className="mono wrap">{aggregate.runs.join(', ') || 'not recorded'}</dd></div>
          <div><dt>accepted</dt><dd>{plural(aggregate.accepted, 'accepted occurrence')} of {plural(aggregate.occurrences.length, 'occurrence')}</dd></div>
          <div><dt>first seen</dt><dd className="mono">{formatTime(aggregate.firstSeen)}</dd></div>
          <div><dt>last seen</dt><dd className="mono">{formatTime(aggregate.lastSeen)}</dd></div>
          <div><dt>policy</dt><dd className="mono wrap">{unique(aggregate.occurrences.map(item => item.policyKey))}</dd></div>
          <div><dt>root cause</dt><dd className="mono wrap">{unique(aggregate.occurrences.map(item => item.rootCauseKey))}</dd></div>
          <div><dt>CWE</dt><dd className="mono wrap">{unique(aggregate.occurrences.flatMap(item => item.cwe))}</dd></div>
          <div><dt>verdict</dt><dd>{unique(aggregate.occurrences.map(item => item.verdict))}</dd></div>
          <div><dt>review</dt><dd>{unique(aggregate.occurrences.map(item => item.reviewStatus))}</dd></div>
          <div><dt>currentness</dt><dd>{unique(aggregate.occurrences.map(item => item.currentness))}</dd></div>
          <div><dt>assets</dt><dd className="mono wrap">{unique(aggregate.occurrences.flatMap(item => item.assets))}</dd></div>
        </dl>
      </section>

      <section className="finding-block" aria-label="cross-run conflicts">
        <h3>cross-run conflicts <span className="detail-count">{aggregate.conflicts.length}</span></h3>
        {aggregate.conflicts.length === 0 ? (
          <p className="detail-note">No severity, title, policy or root-cause value differs across the occurrences of this identity.</p>
        ) : (
          <>
            <p className="detail-note">The same identity has divergent values. Every value is shown with the run and source that recorded it; the aggregate severity is the worst of them, not a chosen value.</p>
            <ul className="conflict-list">
              {aggregate.conflicts.map(conflict => (
                <li key={conflict.field}>
                  <h4 className="conflict-field">{conflict.field}</h4>
                  <ul>
                    {conflict.values.map(value => (
                      <li key={`${conflict.field}-${value.runId}-${value.source}`}>
                        <span className="mono">{value.runId}</span>
                        <span className="conflict-source">{sourceLabel(value.source)}</span>
                        <span className="conflict-value">{value.value ?? 'not recorded'}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="finding-block" aria-label="occurrence provenance">
        <h3>occurrences and provenance <span className="detail-count">{aggregate.occurrences.length}</span></h3>
        <div className="table-wrap">
          <table className="run-table occurrence-table">
            <thead>
              <tr>
                <th scope="col">run</th>
                <th scope="col">source</th>
                <th scope="col">retention</th>
                <th scope="col">as of</th>
                <th scope="col">complete</th>
                <th scope="col">case</th>
                <th scope="col">verdict / review</th>
                <th scope="col">currentness</th>
                <th scope="col">remediation</th>
                <th scope="col">retest</th>
                <th scope="col">time</th>
                <th scope="col">layer</th>
              </tr>
            </thead>
            <tbody>
              {aggregate.occurrences.map(occurrence => (
                <tr key={`${occurrence.runId}-${occurrence.source}-${occurrence.caseId}-${occurrence.caseRevision}`}>
                  <td className="mono">{occurrence.runId}</td>
                  <td>{sourceLabel(occurrence.source)}</td>
                  <td>{retentionLabel(occurrence.retention)}</td>
                  <td className="mono">{occurrence.asOfSequence ?? 'not recorded'}</td>
                  <td>{yesNo(occurrence.complete)}</td>
                  <td className="mono">{occurrence.caseId} r{occurrence.caseRevision}</td>
                  <td>{occurrence.verdict} / {occurrence.reviewStatus}</td>
                  <td>{occurrence.currentness}</td>
                  <td>{occurrence.remediationStatus}</td>
                  <td>{occurrence.retest ? `${occurrence.retest.verdict}${occurrence.retest.current ? ' (current)' : ''}` : 'none recorded'}</td>
                  <td className="mono">{formatTime(occurrence.time)}</td>
                  <td>{occurrence.source === 'report' ? 'accepted-current from report' : 'retained-store case'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="detail-note">A report-only run carries accepted-current findings only, so pending, disputed or stale cases cannot appear from it. A missing row is not a clean result.</p>
      </section>

      {storeLayers.length ? (
        <section className="finding-block" aria-label="retained-store review and remediation layers">
          <h3>retained-store case layers <span className="detail-count">{storeLayers.length}</span></h3>
          <ul className="case-layers">
            {storeLayers.map(item => (
              <li key={`${item.occurrence.runId}-${item.occurrence.caseId}-${item.occurrence.caseRevision}`}>
                <p className="case-layer-head"><span className="mono">{item.occurrence.runId}</span> · case <span className="mono">{item.occurrence.caseId} r{item.occurrence.caseRevision}</span></p>
                {item.caseRow ? <CaseLayer row={item.caseRow} /> : (
                  <p className="detail-note">{item.fileLoaded ? 'the run file does not carry this case row; it was dropped by the per-run data-tree bound.' : 'the run file could not be read, so its case layer is not shown.'}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {evidence.status === 'loading' ? <p className="loading" role="status">reading the run file{aggregate.runs.length === 1 ? '' : 's'} for full evidence…</p> : null}
      {evidence.errors.size ? (
        <section className="panel panel-error finding-evidence-error" role="alert">
          <h2>{evidence.unauthorized ? 'not authorized to read the finding evidence' : 'some run files could not be read'}</h2>
          <ul>{[...evidence.errors.entries()].map(([runId, message]) => <li key={runId}><span className="mono">{runId}</span> {message}</li>)}</ul>
          <button type="button" className="button" onClick={evidence.retry}>try again</button>
        </section>
      ) : null}

      {evidence.status === 'ready' && finding === null && evidence.errors.size === 0 ? (
        <section className="panel panel-empty finding-evidence-missing">
          <h2>full report evidence is not in this reading</h2>
          <p>The run file{aggregate.runs.length === 1 ? '' : 's'} did not carry a matching findings row for this aggregate. Occurrence provenance above still comes from <span className="mono">index.json</span>; this absence is not a clean result.</p>
          <p className="panel-hint">The per-run data tree drops detail in a fixed order when it exceeds its byte bound, and a report bundle may predate the finding. The row remains visible at the index level.</p>
        </section>
      ) : null}

      {finding && source ? (
        <FindingEvidence
          finding={finding}
          occurrence={source.occurrence}
          artifactRunId={source.occurrence.runId}
          artifacts={evidence.files.get(source.occurrence.runId)?.artifacts ?? []}
          runTarget={evidenceRun?.target ?? null}
        />
      ) : null}
    </aside>
  );
}

function CaseLayer({ row }: { row: DashboardCaseRow }) {
  return (
    <dl className="detail-facts case-layer-facts">
      <div><dt>verdict</dt><dd>{row.verdict}</dd></div>
      <div><dt>review</dt><dd>{row.reviewStatus}</dd></div>
      <div><dt>currentness</dt><dd>{row.currentness}{row.staleReasons.length ? ` (${row.staleReasons.slice(0, 4).join('; ')}${row.staleReasons.length > 4 ? ` (+${row.staleReasons.length - 4} more)` : ''})` : ''}</dd></div>
      <div><dt>accepted-current</dt><dd>{row.accepted ? 'yes' : 'no'}</dd></div>
      <div><dt>independent</dt><dd>{row.independentCurrent ? 'current' : 'not current'}{row.readyToRate ? '; ready to rate' : '; not ready to rate'}</dd></div>
      <div><dt>remediation</dt><dd>{row.remediation.status}: {row.remediation.reason}</dd></div>
      <div><dt>retest</dt><dd>{row.retest ? `${row.retest.verdict}${row.retest.current ? ' (current)' : ' (not current)'}` : 'none recorded'}</dd></div>
      {row.ratedRevision !== undefined ? <div><dt>rated revision</dt><dd>r{row.ratedRevision}{row.ratingCurrent === false ? ' (rating not current)' : ''}</dd></div> : null}
      {row.duplicateOf ? <div><dt>duplicate of</dt><dd className="mono">{row.duplicateOf}</dd></div> : null}
      <div><dt>record</dt><dd className="mono wrap">{row.recordId}</dd></div>
      <div><dt>time</dt><dd className="mono">{formatTime(row.time)}</dd></div>
    </dl>
  );
}

function FindingEvidence({ finding, occurrence, artifactRunId, artifacts, runTarget }: {
  finding: NonNullable<JoinedOccurrence['finding']>;
  occurrence: DashboardOccurrence;
  artifactRunId: string;
  artifacts: readonly DashboardArtifactRef[];
  runTarget: string | null;
}) {
  return (
    <>
      <p className="detail-note evidence-source">
        full report evidence from run <span className="mono">{occurrence.runId}</span> ({sourceLabel(occurrence.source)}), case <span className="mono">{finding.caseId} r{finding.caseRevision}</span>
        {runTarget ? <>; target {clamp(runTarget, 64)}</> : null}. Occurrence facts above are not replaced by this block.
      </p>

      <section className="finding-block" aria-label="rating">
        <h3>rating</h3>
        <dl className="detail-facts">
          <div><dt>severity</dt><dd>{severityLabel(finding.severity)}</dd></div>
          <div><dt>basis</dt><dd>{finding.severityBasis ?? 'not recorded'}</dd></div>
          <div><dt>likelihood</dt><dd>{finding.likelihood ?? 'not recorded'}</dd></div>
          <div><dt>impact</dt><dd>{finding.impact ?? 'not recorded'}</dd></div>
          <div><dt>limitations</dt><dd>{finding.ratingLimitations ?? 'not recorded'}</dd></div>
          <div><dt>provenance</dt><dd>{finding.ratingProvenance ?? 'not recorded'}</dd></div>
          <div><dt>flags</dt><dd className="mono wrap">{finding.ratingFlags.length ? finding.ratingFlags.join(', ') : 'none recorded'}</dd></div>
          <div><dt>evidence version</dt><dd className="mono wrap">{finding.evidenceVersion ?? 'not recorded'}</dd></div>
          <div><dt>independent validation</dt><dd>{finding.independentValidationCurrent ? 'current' : 'not current'}{finding.independenceReason ? `: ${finding.independenceReason}` : ''}</dd></div>
          <div><dt>waiver</dt><dd>{finding.independenceWaiver ?? 'none recorded'}</dd></div>
          <div><dt>verdict / review</dt><dd>{finding.verdict} / {finding.reviewStatus}; {finding.currentness}</dd></div>
          <div><dt>time</dt><dd className="mono">{formatTime(finding.time ?? occurrence.time)}</dd></div>
        </dl>
      </section>

      <section className="finding-block" aria-label="cvss and taxonomy">
        <h3>cvss, cwe, wstg and techniques</h3>
        <dl className="detail-facts">
          <div><dt>cvss</dt><dd className="mono wrap">{finding.cvss ? `${finding.cvss.vector} → ${finding.cvss.baseScore} (${finding.cvss.severity})` : 'not recorded'}</dd></div>
          <div><dt>cwe</dt><dd className="mono wrap">{finding.cwe.length ? finding.cwe.join(' ') : 'not recorded'}</dd></div>
          <div><dt>techniques</dt><dd className="mono wrap">{finding.techniques.length ? finding.techniques.join(' ') : 'not recorded'}</dd></div>
          <div><dt>assets</dt><dd className="mono wrap">{finding.assets.length ? finding.assets.join(' ') : 'not recorded'}</dd></div>
        </dl>
        <h4 className="evidence-label">wstg keys and pinned pages (text only)</h4>
        {finding.wstg.length === 0 ? <p className="detail-note">no WSTG key recorded.</p> : (
          <ul className="wstg-list">
            {finding.wstg.map(item => (
              <li key={item.key}>
                <span className="mono">{item.key}</span>
                <span className="wstg-page">{item.page ?? 'no page pinned for this run'}</span>
              </li>
            ))}
          </ul>
        )}
        <h4 className="evidence-label">traffic citations <span className="detail-count">{finding.traffic.length}</span></h4>
        {finding.traffic.length === 0 ? <p className="detail-note">no traffic citation recorded with the rating.</p> : (
          <ol className="traffic-list">
            {finding.traffic.map(item => (
              <li key={`${item.position}-${item.snapshotRef}`}><span className="mono">{item.role}</span> #{item.position} <span className="mono wrap">{item.snapshotRef}</span></li>
            ))}
          </ol>
        )}
      </section>

      <section className="finding-block" aria-label="reproduction">
        <h3>reproduction <span className="detail-count">{finding.reproduction.length}</span></h3>
        {finding.reproductionOmitted ? <p className="detail-note">{plural(finding.reproductionOmitted, 'reproduction row')} omitted by the data-tree bound; the count above is what this reading holds.</p> : null}
        {finding.reproduction.length === 0 ? <p className="detail-note">no reproduction receipt recorded with this finding.</p> : (
          <ol className="reproduction-list">
            {finding.reproduction.map(row => (
              <ReproductionRow key={row.evidenceId} row={row} runId={artifactRunId} artifacts={artifacts} />
            ))}
          </ol>
        )}
      </section>

      {finding.chain ? (
        <section className="finding-block" aria-label="demonstrated chain">
          <h3>demonstrated chain</h3>
          <p className="evidence-text">{finding.chain.objective}</p>
          <dl className="detail-facts">
            <div><dt>through step</dt><dd>{finding.chain.demonstratedThrough ?? 'not recorded'}</dd></div>
            <div><dt>impact</dt><dd className="mono wrap">{finding.chain.impact ? `${finding.chain.impact.vector} → ${finding.chain.impact.score} (${finding.chain.impact.severity}); ${finding.chain.impact.effect}` : 'not recorded'}</dd></div>
          </dl>
          <ol className="chain-list">
            {finding.chain.steps.map(step => (
              <li key={`${step.order}-${step.claimRef ?? 'step'}`}>
                <p className="chain-step"><span className="detail-count">{step.order}</span> {step.step}</p>
                <dl className="detail-facts">
                  <div><dt>claim</dt><dd className="mono wrap">{step.claimRef ?? 'not recorded'}</dd></div>
                  <div><dt>effect</dt><dd>{step.effect ?? 'not recorded'}</dd></div>
                  <div><dt>gained</dt><dd className="mono wrap">{step.gained.length ? step.gained.join('; ') : 'none recorded'}</dd></div>
                  <div><dt>needs</dt><dd className="mono wrap">{step.needs.length ? step.needs.join('; ') : 'none recorded'}</dd></div>
                </dl>
                {step.reach ? <pre className="detail-body evidence-pre">{JSON.stringify(step.reach, null, 2)}</pre> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="finding-block" aria-label="remediation and retest">
        <h3>remediation and retest</h3>
        <dl className="detail-facts">
          <div><dt>remediation</dt><dd>{finding.remediation.status}: {finding.remediation.reason}</dd></div>
          <div><dt>steps</dt><dd>{finding.remediation.steps ?? 'not recorded'}</dd></div>
          <div><dt>retest</dt><dd>{finding.retest ? `${finding.retest.verdict}; case r${finding.retest.caseRevision}; ${finding.retest.current ? 'current' : 'not current'}; ${finding.retest.reason}` : 'no retest recorded'}</dd></div>
          {finding.retest ? <div><dt>retest refs</dt><dd className="mono wrap">{finding.retest.evidenceRefs.length ? finding.retest.evidenceRefs.join(' ') : 'none recorded'}</dd></div> : null}
          {finding.retest ? <div><dt>provenance</dt><dd>{finding.retest.provenance ?? 'not recorded'}{finding.retest.retesters.length ? `; retesters ${finding.retest.retesters.join(', ')}` : ''}</dd></div> : null}
        </dl>
      </section>

      <section className="finding-block" aria-label="contradictions and references">
        <h3>contradictions, claims and references</h3>
        <h4 className="evidence-label">contradictions <span className="detail-count">{finding.contradictions.length}</span></h4>
        {finding.contradictions.length === 0 ? <p className="detail-note">no contradiction recorded.</p> : (
          <ul className="ref-list">
            {finding.contradictions.map(item => <li key={item.evidenceRef}><span className="mono">{item.evidenceRef}</span> {item.status}</li>)}
          </ul>
        )}
        <h4 className="evidence-label">claims</h4>
        <RefList values={finding.claims} empty="no claim reference recorded." />
        <h4 className="evidence-label">independent evidence</h4>
        <RefList values={finding.independentEvidence} empty="no independent evidence reference recorded." />
        <h4 className="evidence-label">references (text only)</h4>
        <RefList values={finding.references} empty="no reference recorded." />
        <h4 className="evidence-label">limitations</h4>
        <p className="evidence-text">{finding.limitations ?? 'not recorded'}</p>
      </section>
    </>
  );
}

function RefList({ values, empty }: { values: readonly string[]; empty: string }) {
  if (values.length === 0) return <p className="detail-note">{empty}</p>;
  return <ul className="ref-list">{values.map(value => <li key={value} className="mono wrap">{value}</li>)}</ul>;
}

function ReproductionRow({ row, runId, artifacts }: { row: FindingReproductionRow; runId: string; artifacts: readonly DashboardArtifactRef[] }) {
  return (
    <li className="reproduction">
      <header className="reproduction-head">
        <span className="mono">{row.evidenceId}</span>
        {row.role ? <span className="reproduction-role">{row.role}</span> : null}
        <span className="reproduction-available">{row.available ? 'available' : 'not available'}</span>
      </header>
      {row.note ? <p className="detail-note">{row.note}</p> : null}
      <dl className="detail-facts">
        <div><dt>operation</dt><dd className="mono wrap">{row.operation ?? 'not recorded'}</dd></div>
        <div><dt>by</dt><dd>{row.by ?? 'not recorded'}</dd></div>
        <div><dt>exit code</dt><dd className="mono">{display(row.exitCode)}</dd></div>
        <div><dt>truncated</dt><dd>{row.truncated ? 'yes; the displayed text is bounded' : 'no'}</dd></div>
      </dl>
      <div className="reproduction-io">
        <div>
          <h5>input</h5>
          <pre className="detail-body evidence-pre">{row.input ?? '(not recorded)'}</pre>
        </div>
        <div>
          <h5>output</h5>
          <pre className="detail-body evidence-pre">{row.output ?? '(not recorded)'}</pre>
        </div>
      </div>
      {row.captures.length ? (
        <div className="captures">
          <h5>captures</h5>
          {row.captures.map(capture => (
            <ArtifactViewer key={capture.id} runId={runId} capture={capture} artifact={artifacts.find(item => item.artifactId === capture.id)} />
          ))}
        </div>
      ) : <p className="detail-note">no retained artifact capture cited for this receipt.</p>}
    </li>
  );
}
