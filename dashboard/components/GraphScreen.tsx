'use client';
/**
 * planning_update.md P2: the graph screen shell — run facts, filters, counters, legend, canvas and node detail. One run at a
 * time; the canvas is a bounded window (400 nodes) over a projection that can hold 4,000, and the counter says so.
 */
import { useMemo, useState } from 'react';
import type { DashboardLabels, DashboardRunFile, DashboardRunSummary } from '../lib/model';
import { GRAPH_MAX_NODES, layoutGraph } from '../lib/layout';
import { COLUMN_BANDS, kindGlyph, kindLabel, KIND_ORDER, RELATION_ORDER, RELATION_STYLES, relationLabel } from '../lib/vocabulary';
import { clamp, formatTime, graphHref, plural, retentionLabel, sourceLabel, RUN_CLOSED_LABEL, RUN_OPEN_LABEL, shortId } from '../lib/format';
import { GraphCanvas } from './GraphCanvas';
import { GraphDetail } from './GraphDetail';

export interface GraphScreenProps {
  file: DashboardRunFile;
  runs: DashboardRunSummary[];
  labels: DashboardLabels | null;
}

const toggleValue = (values: string[], value: string): string[] =>
  values.includes(value) ? values.filter(item => item !== value) : [...values, value];

export function GraphScreen({ file, runs, labels }: GraphScreenProps) {
  const [foldDigest, setFoldDigest] = useState(true);
  const [kinds, setKinds] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  const layout = useMemo(
    () => layoutGraph(file.graph, { foldDigest, kinds, states, focusNodeId: focusId }),
    [file.graph, foldDigest, kinds, states, focusId],
  );
  const selected = selectedId ? layout.nodes.find(node => node.id === selectedId) ?? null : null;
  const run = file.run;

  const rawKinds = useMemo(() => {
    const present = new Set(file.graph.nodes.map(node => node.kind));
    return KIND_ORDER.filter(kind => present.has(kind));
  }, [file.graph]);
  const rawStates = useMemo(() => [...new Set(file.graph.nodes.map(node => node.state))].sort((left, right) => left.localeCompare(right)), [file.graph]);
  const inherited = useMemo(() => {
    const sources = new Set(file.graph.nodes.filter(node => node.inherited).map(node => node.inherited!));
    return { nodes: file.graph.nodes.filter(node => node.inherited).length, runs: [...sources] };
  }, [file.graph]);

  const counters = [
    `showing ${layout.totals.drawn} of ${layout.totals.afterFilters} nodes`,
    layout.totals.filteredOut ? `${layout.totals.filteredOut} hidden by filters` : null,
    layout.totals.hiddenByBounds ? `${layout.totals.hiddenByBounds} outside the ${GRAPH_MAX_NODES}-node window${focusId ? ' (focus)' : ''}` : null,
    layout.totals.foldedDigests ? `${layout.totals.foldedDigests} digest rows folded` : null,
  ].filter(Boolean).join('; ');

  const graphNotes = [
    layout.unresolved ? `${layout.unresolved} unresolved edge end${layout.unresolved === 1 ? '' : 's'} (the derivation could not place them)` : null,
    layout.overflow ? `${layout.overflow} rows over the projection cap, not projected` : null,
    layout.chainOrderTruncated ? `${layout.chainOrderTruncated} chain order step${layout.chainOrderTruncated === 1 ? '' : 's'} not derived (group scan bound)` : null,
    layout.truncated ? 'row arrays were trimmed to fit the data-tree bound; counts still report what the derivation held' : null,
    inherited.nodes ? `${plural(inherited.nodes, 'inherited row')} from ${plural(inherited.runs.length, 'referenced run')} drawn dashed and labelled` : null,
  ].filter(Boolean) as string[];

  return (
    <div className="graph-workspace">
      <aside className="rail" aria-label="run facts and filters">
        <section className="rail-block">
          <h2>run</h2>
          <dl className="rail-facts">
            <div><dt>id</dt><dd className="mono">{run.runId}</dd></div>
            <div><dt>target</dt><dd>{run.target ?? 'not recorded'}{run.targetKind ? ` (${run.targetKind})` : ''}</dd></div>
            <div><dt>source</dt><dd>{sourceLabel(run.source)}; {retentionLabel(run.retention)}</dd></div>
            <div><dt>state</dt><dd>{run.live ? `${RUN_OPEN_LABEL} (last record ${formatTime(run.lastRecordAt)})` : `${RUN_CLOSED_LABEL} (${run.endReason ?? 'reason not recorded'})`}</dd></div>
            <div><dt>records</dt><dd>{run.records} committed; sequence {run.sequence ?? 'not recorded'}</dd></div>
            <div><dt>graph</dt><dd>version {run.graphVersion ?? 0}; {plural(run.counts.nodes, 'node')}; {plural(run.counts.findingsAccepted, 'accepted finding')}</dd></div>
            <div><dt>as of</dt><dd>{formatTime(run.lastRecordAt)}</dd></div>
          </dl>
        </section>

        {runs.length > 1 ? (
          <section className="rail-block">
            <h2>runs</h2>
            <ul className="run-switch">
              {runs.map(candidate => (
                <li key={candidate.runId}>
                  <a href={graphHref(candidate.runId)} className={candidate.runId === run.runId ? 'is-current' : undefined} aria-current={candidate.runId === run.runId ? 'page' : undefined}>
                    <span className="mono">{shortId(candidate.runId, 18)}</span>
                    <span className="run-target">{candidate.target ? clamp(candidate.target, 28) : 'no recorded target'}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="rail-block">
          <h2>kinds</h2>
          <div className="chips">
            {rawKinds.map(kind => (
              <button key={kind} type="button" className="chip" aria-pressed={kinds.includes(kind)} onClick={() => setKinds(current => toggleValue(current, kind))}>
                <span className="kind-mark">{kindGlyph(kind)}</span>{kindLabel(kind)}
              </button>
            ))}
          </div>
          <h2>states</h2>
          <div className="chips">
            {rawStates.map(state => (
              <button key={state} type="button" className="chip" aria-pressed={states.includes(state)} onClick={() => setStates(current => toggleValue(current, state))}>
                {state}
              </button>
            ))}
          </div>
          <label className="toggle">
            <input type="checkbox" checked={foldDigest} onChange={event => setFoldDigest(event.target.checked)} />
            fold digest rows
          </label>
          {kinds.length || states.length || focusId ? (
            <button type="button" className="button button-quiet" onClick={() => { setKinds([]); setStates([]); setFocusId(null); }}>clear filters</button>
          ) : null}
        </section>

        <section className="rail-block">
          <h2>window</h2>
          <p className="counter">{counters}</p>
          {focusId ? <p className="rail-note">focused on <span className="mono">{shortId(focusId, 28)}</span></p> : null}
        </section>

        <section className="rail-block">
          <h2>legend</h2>
          <p className="rail-note">columns, left to right: {COLUMN_BANDS.join(' → ')}</p>
          <ul className="legend">
            {RELATION_ORDER.map(rel => (
              <li key={rel}>
                <span className={`legend-line rel-${RELATION_STYLES[rel]!.tone}`} aria-hidden="true" />
                <span>{relationLabel(rel)}</span>
                <span className="legend-desc">{RELATION_STYLES[rel]!.description}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rail-block rail-notes">
          <h2>provenance</h2>
          <p>{file.graph.label}.</p>
          {labels ? <p>{labels.redaction}.</p> : null}
          {graphNotes.length ? <ul className="notes">{graphNotes.map(note => <li key={note}>{note}</li>)}</ul> : null}
        </section>
      </aside>

      <section className="canvas-panel" aria-label="graph canvas">
        <div className="canvas-head">
          <p className="canvas-count">{counters}</p>
          <p className="canvas-hint">wheel to zoom; drag to pan; click a card for its record pointer</p>
        </div>
        <div className="canvas-frame">
          <GraphCanvas layout={layout} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
      </section>

      <GraphDetail runFile={file} layout={layout} selected={selected} focusId={focusId} onSelect={setSelectedId} onFocus={setFocusId} />
    </div>
  );
}
